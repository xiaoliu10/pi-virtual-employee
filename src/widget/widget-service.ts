/**
 * Embeddable AI-assistant widget service (v0.2.176).
 *
 * Business systems embed a floating chat panel (Aliyun-console style) or link
 * the full page; both talk to THIS employee over a small HTTP surface that is
 * separate from the localhost console transport:
 *
 *   GET  /widget.js          embeddable loader (bubble + panel, Shadow DOM)
 *   GET  /widget             full chat page (iframe / direct link)
 *   GET  /api/widget/config  live UI strings (Bearer token)
 *   POST /api/widget/chat    send a message, get the full reply (Bearer token)
 *
 * SECURITY MODEL (deliberate, v1):
 *  - The token is an ACCESS token, not an admin credential: widget
 *    conversations run as a viewer-role actor (chat + knowledge search;
 *    capability tools stay behind the normal role checks), so a leaked token
 *    costs at most anonymous chatter against the employee.
 *  - Replies pass the SAME credential-egress gate as IM group pushes, so a
 *    reply containing credentials is withheld exactly like it would be in a
 *    group chat.
 *  - Conversation ids are namespaced `widget:<key>` and NEVER alias IM or
 *    console conversations (isReadOnlyConversation keeps IM ones read-only;
 *    the namespace keeps widget ones out of every other surface's paths).
 *  - `expose: "lan"` binds 0.0.0.0 and refuses to start without a token;
 *    `allowedOrigins` (when non-empty) gates CORS and the embed referer.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { gateOutboundText } from "../im/credential-egress.js";
import type { EmployeeRuntime } from "../engine/engine.js";
import { renderWidgetPage, renderWidgetLoader } from "./widget-assets.js";

export interface WidgetConfigSnapshot {
	title: string;
	subtitle: string;
	suggestions: string[];
	disclaimer: string;
	token: string;
	allowedOrigins: string[];
}

export interface WidgetDeps {
	/** Live config reader — token/title/suggestions are read per request, so editing them takes effect without a restart. */
	config: () => WidgetConfigSnapshot;
	runtime: EmployeeRuntime;
	/** Where the widget server binds: "loopback" (default) or "lan" (0.0.0.0). */
	expose: "loopback" | "lan";
	port: number;
	log?: (message: string) => void;
}

const BEARER = /^Bearer\s+(.+)$/i;

function sendJson(res: ServerResponse, status: number, body: unknown, origin?: string): void {
	const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
	if (origin) headers["Access-Control-Allow-Origin"] = origin;
	res.writeHead(status, headers);
	res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<{ message?: string; conversationId?: string; user?: string }> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("error", reject);
		req.on("end", () => {
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw) as { message?: string; conversationId?: string; user?: string });
			} catch (err) {
				reject(err);
			}
		});
	});
}

/** Origin of a request per CORS semantics, or "" for same-origin/no-Origin. */
function requestOrigin(req: IncomingMessage): string {
	const header = req.headers.origin;
	if (typeof header === "string" && header.trim()) return header.trim();
	// Non-browser callers (curl, server-to-server) have no Origin; the referer
	// still names the embedding page when the loader is used cross-origin.
	const referer = req.headers.referer;
	if (typeof referer === "string" && referer.trim()) {
		try {
			return new URL(referer).origin;
		} catch {
			return "";
		}
	}
	return "";
}

/** True when `origin` matches one of the configured entries (exact, or subdomain of it). */
function originAllowed(origin: string, allowed: string[]): boolean {
	if (!origin) return true; // non-browser or same-origin: the Bearer token still gates everything
	if (allowed.length === 0) return true;
	try {
		const host = new URL(origin).hostname;
		return allowed.some((raw) => {
			const entry = raw.trim();
			if (!entry) return false;
			const allowedHost = entry.includes("://") ? new URL(entry).hostname : entry;
			return host === allowedHost || host.endsWith(`.${allowedHost}`);
		});
	} catch {
		return false;
	}
}

/**
 * The widget actor identity: viewer-role by construction (never in
 * adminStaffIds unless an admin literally adds that id), so the business
 * system's end users get conversation + knowledge search and nothing more.
 */
function widgetActor(user: string | undefined, staffPrefix: string): { senderId: string; channel: "widget"; chatType: "single" } {
	const clean = (user ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
	return { senderId: `${staffPrefix}${clean || "anon"}`, channel: "widget", chatType: "single" };
}

export function startWidgetServer(deps: WidgetDeps): Promise<{ port: number; server: Server }> {
	const log = deps.log ?? ((message: string) => console.log(message));
	const server = createServer(async (req, res) => {
		const url = (req.url ?? "").split("?")[0];
		const cfg = deps.config();
		const origin = requestOrigin(req);
		const allowed = originAllowed(origin, cfg.allowedOrigins);
		if (origin && allowed) {
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Vary", "Origin");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
			res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
		}
		if (req.method === "OPTIONS") {
			res.writeHead(allowed ? 204 : 403);
			return res.end();
		}

		// Static assets: the loader and page carry no secrets (the token is the
		// deployer's to embed), so they are served without auth.
		if (req.method === "GET" && url === "/widget.js") {
			res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
			return res.end(renderWidgetLoader({ origin: allowed ? origin : "" }));
		}
		if (req.method === "GET" && url === "/widget") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
			return res.end(renderWidgetPage());
		}

		if (!allowed) return sendJson(res, 403, { error: "该来源未在小组件的允许来源列表中" });

		// Everything below the asset line requires the bearer token.
		const auth = req.headers.authorization ?? "";
		const presented = BEARER.exec(auth)?.[1] ?? "";
		if (!cfg.token || presented !== cfg.token) {
			return sendJson(res, 401, { error: "小组件令牌缺失或不正确" });
		}

		if (req.method === "GET" && url === "/api/widget/config") {
			return sendJson(res, 200, {
				title: cfg.title,
				subtitle: cfg.subtitle,
				suggestions: cfg.suggestions,
				disclaimer: cfg.disclaimer,
			}, cfg.allowedOrigins.length ? origin : "*");
		}

		if (req.method === "POST" && url === "/api/widget/chat") {
			let body: { message?: string; conversationId?: string; user?: string };
			try {
				body = await readJsonBody(req);
			} catch {
				return sendJson(res, 400, { error: "Invalid JSON body" }, cfg.allowedOrigins.length ? origin : "*");
			}
			const message = body.message?.trim();
			if (!message) return sendJson(res, 400, { error: "Missing 'message' field" }, cfg.allowedOrigins.length ? origin : "*");

			// Per-end-user conversations: the business system passes its own user
			// key; the widget namespace keeps these out of IM/console surfaces.
			const userKey = (body.conversationId ?? body.user ?? randomUUID()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || randomUUID().slice(0, 8);
			const conversationId = `widget:${userKey}`;

			if (deps.runtime.isReadOnlyConversation(conversationId)) {
				return sendJson(res, 403, { error: "该会话为只读", conversationId });
			}
			let agent: ReturnType<EmployeeRuntime["getOrCreateSession"]>;
			try {
				agent = deps.runtime.getOrCreateSession(conversationId);
			} catch (err) {
				return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err), conversationId });
			}
			try {
				const actor = widgetActor(body.user, "widget-user-");
				const { reply, error } = await deps.runtime.send(agent, message, { actor });
				if (error) return sendJson(res, 502, { error, conversationId }, cfg.allowedOrigins.length ? origin : "*");
				// Same gate as an IM group push: the business system's users are NOT
				// the admin, so credential-bearing replies are withheld, not sent.
				const safe = gateOutboundText(reply ?? "", "restricted");
				return sendJson(res, 200, { conversationId, reply: safe }, cfg.allowedOrigins.length ? origin : "*");
			} catch (err) {
				return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err), conversationId }, cfg.allowedOrigins.length ? origin : "*");
			}
		}

		return sendJson(res, 404, { error: "Not found" });
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		const host = deps.expose === "lan" ? "0.0.0.0" : "127.0.0.1";
		server.listen(deps.port, host, () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : deps.port;
			log(`[widget] assistant widget on ${host}:${port} (expose=${deps.expose})`);
			resolve({ port, server });
		});
	});
}
