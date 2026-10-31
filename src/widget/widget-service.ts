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
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { EmployeeRuntime } from "../engine/engine.js";
import { renderWidgetPage, renderWidgetLoader } from "./widget-assets.js";
import { TicketStore, secretMatches, widgetConversationKey, type WidgetRole } from "./widget-ticket.js";

export interface WidgetConfigSnapshot {
	title: string;
	suggestions: string[];
	disclaimer: string;
	token: string;
	allowedOrigins: string[];
	/**
	 * Secret the BUSINESS system's backend uses to exchange (user, role) for a
	 * session ticket. It must never reach a browser: with it, anyone could mint
	 * themselves an admin ticket.
	 */
	secret?: string;
	/** Highest role a ticket may carry (default admin; owner is never reachable). */
	maxRole?: WidgetRole;
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
	/** Session tickets; injectable so tests can control TTL/clock. */
	tickets?: TicketStore;
	/**
	 * Peer addresses allowed to speak for the real client via X-Forwarded-For
	 * (e.g. ["127.0.0.1"] behind a local nginx). Empty = never trust the header.
	 */
	trustedProxies?: string[];
}

/** Strip the IPv4-mapped IPv6 prefix so "::ffff:10.0.0.1" and "10.0.0.1" compare equal. */
function normalizeAddress(value: string | undefined): string {
	const raw = (value ?? "").trim().replace(/^::ffff:/, "");
	return raw || "?";
}

/**
 * Client address for ticket binding.
 *
 * Behind nginx every request arrives from 127.0.0.1, which would make address
 * binding meaningless (every user looks identical). X-Forwarded-For is
 * therefore honoured ONLY when the request comes from a configured trusted
 * proxy — otherwise a client could simply forge the header and claim to be the
 * address a stolen ticket was bound to.
 */
function clientAddress(req: IncomingMessage, trustedProxies: string[]): string {
	const peers = trustedProxies.map((p) => normalizeAddress(p));
	const peer = normalizeAddress(req.socket.remoteAddress);
	if (peers.length === 0 || !peers.includes(peer)) return peer;
	const forwarded = req.headers["x-forwarded-for"];
	const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	if (!value) return peer;
	// Walk from the RIGHT and skip trusted proxies; the first untrusted entry is
	// the real client. Taking the left-most value is forgeable: nginx's default
	// `proxy_add_x_forwarded_for` APPENDS to a client-supplied header, so an
	// attacker behind the proxy can prepend a victim's address and inherit a
	// ticket bound to it (code review P1-1).
	// The chain is only authentic if the LAST hop is one of our trusted proxies:
	// a real proxy always appends the address it received the request from, so the
	// right-most entry names the proxy itself. A client that forges the whole
	// header (no proxy involved) therefore fails this check and is treated as a
	// direct peer — the forged chain is ignored. This is the fail-closed form of
	// the standard "walk from the right" algorithm.
	const hops = value.split(",").map((h) => normalizeAddress(h));
	if (!peers.includes(hops[hops.length - 1])) return peer;
	for (let i = hops.length - 2; i >= 0; i -= 1) {
		if (!peers.includes(hops[i])) return hops[i];
	}
	// Every hop is a trusted proxy (unusual): fall back to the peer itself.
	return peer;
}

/** Is a request's Origin listed? Reuses the same boundary rules as CORS below. */
function declaredOrigin(req: IncomingMessage): string {
	return (req.headers.origin as string | undefined)?.trim() ?? "";
}

const BEARER = /^Bearer\s+(.+)$/i;
/** Business-backend secret header for the ticket exchange. */
const SECRET_HEADER = /^\s*(.+?)\s*$/;
/** Session ticket header for chat calls. */
const TICKET_HEADER = /^\s*(.+?)\s*$/;

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
/** One in-flight turn per conversation (review P1-4: legacy-kernel degradation
 *  has no per-conversation serialization, and double-prompting one Agent throws). */
const inFlight = new Map<string, Promise<unknown>>();

export async function startWidgetServer(deps: WidgetDeps): Promise<{ port: number; server: Server }> {
	const log = deps.log ?? ((message: string) => console.log(message));
	const tickets = deps.tickets ?? new TicketStore();
	const server = createServer(async (req, res) => {
		const url = (req.url ?? "").split("?")[0];
		const cfg = deps.config();
		const origin = requestOrigin(req);
		const allowed = originAllowed(origin, cfg.allowedOrigins);
		if (origin && allowed) {
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Vary", "Origin");
			// X-VE-Ticket is a custom header, so every chat request from an embedded
			// page is preceded by a CORS preflight. Omitting it here makes the BROWSER
			// reject the actual request — the flagship cross-origin embed would fail
			// on every message while server-side tests (which do not implement CORS)
			// stayed green (code review P0-2).
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-VE-Ticket");
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

		/**
		 * Exchange (user, role) for a short-lived ticket. Called by the BUSINESS
		 * system's BACKEND, never by a browser: it requires the secret, and the
		 * resulting ticket is bound to the caller's address + Origin, so it cannot
		 * be relayed to a different client.
		 */
		if (req.method === "POST" && url === "/api/widget/session") {
			if (!cfg.secret) {
				// A token without a secret means the deployment has not been through
				// the v0.2.178 settings step — refuse rather than fall back to "no auth".
				log("[widget] /session refused: no widget secret configured");
				return sendJson(res, 503, { error: "小组件未配置接入密钥，请在设置页生成后重试" });
			}
			let body: { user?: string; role?: string; origin?: string; clientIp?: string };
			try {
				body = await readJsonBody(req);
			} catch {
				return sendJson(res, 400, { error: "Invalid JSON body" });
			}
			const presentedSecret = SECRET_HEADER.exec(req.headers["x-ve-secret"] as string ?? "")?.[1] ?? "";
			if (!secretMatches(presentedSecret, cfg.secret)) {
				log(`[widget] /session rejected: bad secret from ${clientAddress(req, deps.trustedProxies ?? [])}`);
				return sendJson(res, 401, { error: "接入密钥不正确" });
			}
			const user = (body.user ?? "").trim();
			if (!user) return sendJson(res, 400, { error: "缺少 user（业务系统的用户标识）" });
			// The backend declares WHERE the ticket will be used: the browser's
			// Origin and (optionally) its IP. Binding to the minting backend's own
			// address would be wrong — the chat comes from the end user's browser.
			const consumerOrigin = (body.origin ?? "").trim() || origin;
			const consumerIp = (body.clientIp ?? "").trim();
			// A ticket with NEITHER a declared origin NOR a declared client IP would
			// redeem from anywhere, which defeats the point of a ticket (code review
			// P2-1). Refuse it and make the integration declare its consumer.
			if (!consumerOrigin && !consumerIp) {
				return sendJson(res, 400, {
					error: "换票必须声明 origin（业务系统页面地址）或 clientIp（使用者客户端地址）之一，否则票据无法绑定来源",
				});
			}
			const record = tickets.issue(
				{
					user,
					role: body.role,
					address: consumerIp ? normalizeAddress(consumerIp) : "*",
					origin: consumerOrigin,
					conversationKey: widgetConversationKey(user),
				},
				cfg.maxRole,
			);
			return sendJson(res, 200, {
				ticket: record.ticket,
				// Echo what was ACTUALLY granted, so the business system can tell the
				// difference between "asked for admin" and "got admin".
				role: record.record.role,
				expiresIn: Math.max(0, Math.round((record.record.expiresAt - Date.now()) / 1000)),
			});
		}

		if (req.method === "POST" && url === "/api/widget/chat") {
			const corsOriginForChat = cfg.allowedOrigins.length ? origin : "*";
			// The role comes from a TICKET, never from the request body: a body field
			// is one devtools keystroke away from being anything.
			const presentedTicket = TICKET_HEADER.exec(req.headers["x-ve-ticket"] as string ?? "")?.[1] ?? "";
			const redeemed = tickets.redeem(presentedTicket, { address: clientAddress(req, deps.trustedProxies ?? []), origin });
			if (!redeemed.ok) {
				// Log every rejection with its reason — a bare 401 is undebuggable when
				// a proxy rewrites the client address and the ticket stops redeeming.
				log(`[widget] /chat rejected (${redeemed.reason}) from ${clientAddress(req, deps.trustedProxies ?? [])}`);
				return sendJson(res, 401, {
					error:
						redeemed.reason === "expired" ? "会话票据已过期，请重新获取"
						: redeemed.reason === "address-mismatch" || redeemed.reason === "origin-mismatch" ? "会话票据与来源不匹配"
						: "缺少或无效的会话票据",
				}, corsOriginForChat);
			}
			const ticket = redeemed.record;

			let body: { message?: string; conversationId?: string };
			try {
				body = await readJsonBody(req);
			} catch {
				return sendJson(res, 400, { error: "Invalid JSON body" }, corsOriginForChat);
			}
			const message = body.message?.trim();
			if (!message) return sendJson(res, 400, { error: "Missing 'message' field" }, cfg.allowedOrigins.length ? origin : "*");
			if (message.length > MAX_MESSAGE_CHARS) {
				return sendJson(res, 400, { error: `消息过长（最多 ${MAX_MESSAGE_CHARS} 字）` }, cfg.allowedOrigins.length ? origin : "*");
			}

			// Per-end-user conversations: the key comes from the TICKET (minted by the
			// business backend), so a client cannot point its conversation at another
			// user's namespace by editing the request.
			const conversationId = `widget:${ticket.conversationKey}`;
			const corsOrigin = corsOriginForChat;

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
			// Streaming mode (v0.2.179): a chat turn can run for minutes with tool
			// calls in the middle — a bare request/response leaves the user staring
			// at a frozen bubble, which the field called out as unusable. With
			// Accept: text/event-stream we forward the same process events the
			// desktop console shows: thinking, tool calls, and streaming text.
			const wantsStream =
				(req.headers.accept ?? "").includes("text/event-stream") &&
				// The durable kernel (the DEFAULT) never drives agent.subscribe, so an
				// SSE stream would carry only meta→done — silently no process events
				// (review P0-3). Fall back to the JSON path there; the client renders
				// its "thinking…" placeholder either way.
				deps.runtime.streamsProcessEvents !== false;
			const actor = {
				senderId: `widget-user-${ticket.conversationKey}`,
				channel: "widget" as const,
				chatType: "single" as const,
				// The ONLY place this field is set: role came from a ticket the
				// business backend signed for and that is bound to this caller.
				verifiedRole: ticket.role,
			};

			if (wantsStream) {
				const turn = (async () => {
					res.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache, no-transform",
						Connection: "keep-alive",
						"X-Accel-Buffering": "no",
						...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
					});
					const sse = (payload: Record<string, unknown>): void => {
						if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
					};
					// Comment-only heartbeat keeps long silent tool executions (minutes)
					// alive through proxies with default read timeouts. Clients ignore
					// frames that do not start with "data:".
					const heartbeat = setInterval(() => {
						if (!res.writableEnded) res.write(": ping\n\n");
					}, 15_000);
					sse({ type: "meta", conversationId });

					/**
					 * Gate-streaming state. Every text/thinking increment must pass the
					 * same outbound credential gate as a complete reply — the widget's
					 * audience is the business system's users, not the local admin. We
					 * accumulate the full text and only ever send increments of the
					 * GATED version, so a credential that spans deltas is caught the
					 * moment it is complete; if the gate replaces the whole text, a
					 * `replace` event resets what the client has rendered.
					 */
					const makeGatedChannel = (eventType: "delta" | "thinking_delta") => {
						let full = "";
						let sent = "";
						return {
							push: (incoming: string): void => {
								full += incoming;
								const safe = gateOutboundText(full, "restricted");
								if (safe === sent) return;
								if (safe.startsWith(sent)) {
									sse({ type: eventType, text: safe.slice(sent.length) });
								} else {
									sse({ type: eventType === "delta" ? "replace" : "thinking_replace", text: safe });
								}
								sent = safe;
							},
							get sentText() {
								return sent;
							},
						};
					};
					const textChannel = makeGatedChannel("delta");
					const thinkingChannel = makeGatedChannel("thinking_delta");
					const pushText = (s: string) => textChannel.push(s);
					const pushThinking = (s: string) => thinkingChannel.push(s);

					const unsubscribe = agent.subscribe((event: AgentEvent) => {
						switch (event.type) {
							case "message_update": {
								// The delta event carries exactly the new bytes — no need to
								// diff the message snapshot.
								const a = event.assistantMessageEvent;
								if (a.type === "text_delta") pushText(a.delta);
								else if (a.type === "thinking_delta") pushThinking(a.delta);
								break;
							}
							case "tool_execution_start":
								sse({ type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId });
								break;
							case "tool_execution_end":
								sse({ type: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError === true, durationMs: event.durationMs });
								break;
							default:
								break;
						}
					});

					try {
						const { reply, error } = await deps.runtime.send(agent, message, { actor });
						if (error) {
							sse({ type: "error", message: error });
						} else {
							// The final reply may differ from the streamed accumulation
							// (settle-gate re-ask, compaction trims): gate it and make the
							// client converge on the authoritative text.
							const final = gateOutboundText(reply ?? "", "restricted");
							// Converge only when the authoritative text differs from what was
							// streamed (settle-gate re-ask etc.) — an identical final must not
							// make the bubble flash.
							if (final && final !== textChannel.sentText) {
								sse({ type: "replace", text: final });
							}
							sse({ type: "done", conversationId });
						}
					} catch (err) {
						console.warn(`[widget] chat failed for ${conversationId}:`, err instanceof Error ? err.message : err);
						sse({ type: "error", message: "处理失败，请稍后再试" });
					} finally {
						unsubscribe();
						clearInterval(heartbeat);
						if (!res.writableEnded) res.end();
						inFlight.delete(conversationId);
					}
				})();
				inFlight.set(conversationId, turn);
				return turn;
			}

			const turn = (async () => {
				try {
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
			// port 0 means "let the OS pick", so a differing result is expected, not a collision.
			if (deps.port !== 0 && port !== deps.port) log(`[widget] port ${deps.port} was taken; bound ${port} instead`);
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
