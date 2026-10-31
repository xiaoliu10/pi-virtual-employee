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
import { randomUUID, timingSafeEqual } from "node:crypto";
import { gateOutboundText } from "../im/credential-egress.js";
import type { EmployeeRuntime } from "../engine/engine.js";
import { renderWidgetPage, renderWidgetLoader } from "./widget-assets.js";

export interface WidgetConfigSnapshot {
	title: string;
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
	/** Start of the forward-retry window when `port` is taken (defaults to `port`). */
	portBase?: number;
	/** How many forward ports to try before giving up (default 20). */
	portAttempts?: number;
	log?: (message: string) => void;
	/** Test/instrumentation hook: called once per bind attempt with the port. */
	onBindAttempt?: (port: number) => void;
}

const BEARER = /^Bearer\s+(.+)$/i;

function sendJson(res: ServerResponse, status: number, body: unknown, origin?: string): void {
	const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
	if (origin) headers["Access-Control-Allow-Origin"] = origin;
	res.writeHead(status, headers);
	res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 4_000;
/** Chat attempts per token+client per minute (review P1-4: a runaway loop must not own the model channel). */
const RATE_LIMIT_PER_MIN = 30;

function readJsonBody(req: IncomingMessage): Promise<{ message?: string; conversationId?: string; user?: string }> {
	return new Promise((resolve, reject) => {
		let raw = "";
		let bytes = 0;
		req.on("data", (chunk) => {
			bytes += chunk.length;
			// Review P1-4: a multi-GB body must be cut off, not buffered.
			if (bytes > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error("body-too-large"));
				return;
			}
			raw += chunk;
		});
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

/** Sliding-window rate limiter keyed per token+client address (in-memory, v1). */
const rateBuckets = new Map<string, number[]>();
function rateLimited(key: string, now = Date.now()): boolean {
	const windowStart = now - 60_000;
	const hits = (rateBuckets.get(key) ?? []).filter((ts) => ts > windowStart);
	hits.push(now);
	rateBuckets.set(key, hits);
	if (rateBuckets.size > 10_000) {
		for (const [k, v] of rateBuckets) if (v.every((ts) => ts <= windowStart)) rateBuckets.delete(k);
	}
	return hits.length > RATE_LIMIT_PER_MIN;
}

/** Constant-time token comparison (review P3-10). */
function tokenMatches(presented: string, expected: string): boolean {
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
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

/** One in-flight turn per conversation (review P1-4: legacy-kernel degradation
 *  has no per-conversation serialization, and double-prompting one Agent throws). */
const inFlight = new Map<string, Promise<unknown>>();

export async function startWidgetServer(deps: WidgetDeps): Promise<{ port: number; server: Server }> {
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
			return res.end(renderWidgetLoader());
		}
		if (req.method === "GET" && url === "/widget") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
			return res.end(renderWidgetPage());
		}

		if (!allowed) return sendJson(res, 403, { error: "该来源未在小组件的允许来源列表中" });

		// Everything below the asset line requires the bearer token.
		const auth = req.headers.authorization ?? "";
		const presented = BEARER.exec(auth)?.[1] ?? "";
		if (!cfg.token || !tokenMatches(presented, cfg.token)) {
			return sendJson(res, 401, { error: "小组件令牌缺失或不正确" });
		}
		const clientKey = `${presented.slice(0, 8)}:${req.socket.remoteAddress ?? "?"}`;
		if (req.method === "POST" && url === "/api/widget/chat" && rateLimited(clientKey)) {
			return sendJson(res, 429, { error: "请求过于频繁，请稍后再试" }, cfg.allowedOrigins.length ? origin : "*");
		}

		if (req.method === "GET" && url === "/api/widget/config") {
			return sendJson(res, 200, {
				title: cfg.title,
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
			if (message.length > MAX_MESSAGE_CHARS) {
				return sendJson(res, 400, { error: `消息过长（最多 ${MAX_MESSAGE_CHARS} 字）` }, cfg.allowedOrigins.length ? origin : "*");
			}

			// Per-end-user conversations: the business system passes its own user
			// key; the widget namespace keeps these out of IM/console surfaces.
			const userKey = (body.conversationId ?? body.user ?? randomUUID()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || randomUUID().slice(0, 8);
			const conversationId = `widget:${userKey}`;
			const corsOrigin = cfg.allowedOrigins.length ? origin : "*";

			if (deps.runtime.isReadOnlyConversation(conversationId)) {
				return sendJson(res, 403, { error: "该会话为只读", conversationId }, corsOrigin);
			}
			const pending = inFlight.get(conversationId);
			if (pending) {
				return sendJson(res, 429, { error: "该会话正在处理上一条消息，请稍候", conversationId }, corsOrigin);
			}
			let agent: ReturnType<EmployeeRuntime["getOrCreateSession"]>;
			try {
				agent = deps.runtime.getOrCreateSession(conversationId);
			} catch (err) {
				console.warn(`[widget] session create failed for ${conversationId}:`, err instanceof Error ? err.message : err);
				return sendJson(res, 500, { error: "处理失败，请稍后再试", conversationId }, corsOrigin);
			}
			const turn = (async () => {
				try {
					const actor = widgetActor(body.user, "widget-user-");
					const { reply, error } = await deps.runtime.send(agent, message, { actor });
					if (error) return sendJson(res, 502, { error, conversationId }, corsOrigin);
					// Same gate as an IM group push: the business system's users are NOT
					// the admin, so credential-bearing replies are withheld, not sent.
					const safe = gateOutboundText(reply ?? "", "restricted");
					return sendJson(res, 200, { conversationId, reply: safe }, corsOrigin);
				} catch (err) {
					// Internal errors may carry paths/kernel details — fixed text outward,
					// detail server-side only (review P2-7).
					console.warn(`[widget] chat failed for ${conversationId}:`, err instanceof Error ? err.message : err);
					return sendJson(res, 500, { error: "处理失败，请稍后再试", conversationId }, corsOrigin);
				} finally {
					inFlight.delete(conversationId);
				}
			})();
			inFlight.set(conversationId, turn);
			return turn;
		}

		return sendJson(res, 404, { error: "Not found" });
	});

	// Listen, retrying forward on a lost race (code review P2-1).
	//
	// Probing a port and then binding it are two separate steps, so another
	// profile can take the port in between; the earlier design probed once and
	// then failed outright with EADDRINUSE. A probe cannot close that window — only
	// the successful bind can. So we let the bind itself pick: try the requested
	// port, and on EADDRINUSE walk WIDGET_PORT_ATTEMPTS ports forward from the
	// base. The port that actually bound is what the caller persists.
	const host = (deps as { _bindHostOverride?: string })._bindHostOverride ?? (deps.expose === "lan" ? "0.0.0.0" : "127.0.0.1");
	const base = deps.portBase ?? deps.port;
	const attempts = deps.portAttempts ?? 20;
	let candidate = deps.port;
	let lastError: NodeJS.ErrnoException | undefined;
	let tried = 0;
	for (;;) {
		deps.onBindAttempt?.(candidate);
		const err = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
			const onError = (e: NodeJS.ErrnoException) => {
				server.removeListener("listening", onListening);
				resolve(e);
			};
			const onListening = () => {
				server.removeListener("error", onError);
				resolve(undefined);
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(candidate, host);
		});
		if (!err) {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : candidate;
			if (port !== deps.port) log(`[widget] port ${deps.port} was taken; bound ${port} instead`);
			log(`[widget] assistant widget on ${host}:${port} (expose=${deps.expose})`);
			return { port, server };
		}
		lastError = err;
		// Only a port collision is retryable: EACCES (privileged port) or a bad host
		// means every candidate fails the same way.
		if (err.code !== "EADDRINUSE" || tried >= attempts) break;
		const next = base + tried;
		tried += 1;
		if (next > 65_535 || next === candidate) continue;
		candidate = next;
	}
	const code = lastError?.code ?? "UNKNOWN";
	const hint =
		code === "EADDRINUSE" ? `端口 ${deps.port} 已被占用（可能是同机另一个 profile 的实例），且自动顺延的 ${tried} 个端口也都不可用`
		: code === "EACCES" ? `无权限绑定端口 ${deps.port}（1024 以下端口需要管理员权限）`
		: lastError?.message ?? "未知错误";
	throw Object.assign(new Error(hint), { code });
}
