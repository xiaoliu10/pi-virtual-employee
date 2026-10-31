/**
 * Widget session tickets (v0.2.178).
 *
 * Requirement from the field: business-system users with high privileges must be
 * able to act as admin HERE, and the port must not be open to anyone. The role
 * therefore never travels in the chat body — the business backend exchanges
 * (user, role) for a short-lived ticket using a secret, and the ticket is BOUND
 * TO ITS SOURCE so a stolen ticket is useless elsewhere.
 *
 * What is pinned here:
 *   1. no secret / bad secret → the exchange refuses (port is not open);
 *   2. a real ticket carries the granted role into the actor;
 *   3. the role is capped at admin — owner is unreachable, whatever is claimed;
 *   4. a ticket minted for one address does NOT redeem from another (the point
 *      of source binding), and the same holds for Origin;
 *   5. expired tickets are refused with a distinguishable reason;
 *   6. without a ticket, chat is refused even with a valid bearer token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "widget-ticket-"));
const bundle = join(dir, "t.mjs");
await build({
	stdin: {
		contents: `
			export * from "./src/widget/widget-service.ts";
			export * from "./src/widget/widget-ticket.ts";
			export { checkPermission } from "./src/security/permissions.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { startWidgetServer, TicketStore, clampWidgetRole, checkPermission, ConfigStore } = await import(
	pathToFileURL(bundle).href
);
const { DatabaseSync } = await import("node:sqlite");

const TOKEN = "token-abc";
const SECRET = "secret-xyz";

/** Record every send so we can assert the actor that reached the runtime. */
function makeRuntime(sink = []) {
	return {
		isReadOnlyConversation: () => false,
		getOrCreateSession: (id) => ({ id }),
		send: async (_agent, message, options) => {
			sink.push({ message, actor: options?.actor });
			return { reply: `ok:${message}` };
		},
	};
}

async function start(overrides = {}) {
	const sink = [];
	const runtime = overrides.runtime ?? makeRuntime(sink);
	const tickets = overrides.tickets ?? new TicketStore();
	const server = await startWidgetServer({
		config: () => ({
			title: "AI 助理",
			suggestions: [],
			disclaimer: "d",
			token: TOKEN,
			allowedOrigins: [],
			secret: SECRET,
			maxRole: "admin",
			...overrides.cfg,
		}),
		runtime,
		expose: "loopback",
		port: 0,
		log: () => {},
		tickets,
		trustedProxies: overrides.trustedProxies ?? [],
	});
	// startWidgetServer resolves { port, server } — keep the http.Server for teardown.
	const httpServer = server.server;
	const base = `http://127.0.0.1:${server.port}`;
	const post = (path, body, headers = {}) =>
		fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
			body: JSON.stringify(body),
		});
	/** Mint a ticket like a business backend would (bearer + secret + declared origin). */
	const session = async (user = "u1", role = "viewer") => {
		const res = await post("/api/widget/session", { user, role, origin: "https://oa.example.com" }, { "x-ve-secret": SECRET });
		const data = await res.json();
		if (!data.ticket) throw new Error(`ticket exchange failed: ${res.status} ${JSON.stringify(data)}`);
		return data.ticket;
	};
	return { base, post, server: httpServer, sink, tickets, session };
}

test("ticket exchange refuses without a secret, and without a configured secret", async (t) => {
	const { post, server } = await start();
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	const noHeader = await post("/api/widget/session", { user: "u1", role: "admin" });
	assert.equal(noHeader.status, 401, "no X-VE-Secret header → refused");

	const wrong = await post("/api/widget/session", { user: "u1", role: "admin" }, { "x-ve-secret": "nope" });
	assert.equal(wrong.status, 401, "wrong secret → refused");

	const { post: post2, server: s2 } = await start({ cfg: { secret: "" } });
	t.after(() => { s2.closeAllConnections?.(); s2.close(); });
	const disabled = await post2("/api/widget/session", { user: "u1" }, { "x-ve-secret": SECRET });
	assert.equal(disabled.status, 503, "no secret configured → exchange disabled, not open");
});

test("a ticket carries the granted role into the runtime actor", async (t) => {
	const { post, server, sink } = await start();
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	const minted = await post("/api/widget/session", { user: "zhangsan", role: "admin" }, { "x-ve-secret": SECRET, origin: "https://oa.example.com" });
	assert.equal(minted.status, 200);
	const { ticket, role } = await minted.json();
	assert.equal(role, "admin", "the exchange reports what was actually granted");
	assert.ok(ticket, "a ticket is returned");

	const chat = await post("/api/widget/chat", { message: "hi" }, { "x-ve-ticket": ticket, origin: "https://oa.example.com" });
	assert.equal(chat.status, 200);
	assert.equal(sink.length, 1, "the message reached the runtime");
	assert.equal(sink[0].actor.verifiedRole, "admin", "the role travels via the verified ticket");
	assert.equal(sink[0].actor.senderId, "widget-user-zhangsan", "the identity comes from the ticket too");
});

test("the role is capped at admin; owner is unreachable whatever is claimed", async (t) => {
	const { post, server } = await start();
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	for (const claimed of ["owner", "superuser", "", undefined, "ADMIN "]) {
		const r = await post("/api/widget/session", { user: "u", role: claimed }, { "x-ve-secret": SECRET, origin: "https://oa.example.com" });
		assert.equal(r.status, 200, "the mint itself succeeds");
		const body = await r.json();
		assert.notEqual(body.role, "owner", `claimed "${claimed}" must never become owner`);
		assert.ok(["viewer", "operator", "admin"].includes(body.role), `granted a known role for "${claimed}"`);
	}

	// The cap is also enforced unit-level, including a configured lower ceiling.
	assert.equal(clampWidgetRole("admin"), "admin");
	assert.equal(clampWidgetRole("owner"), "viewer", "owner is not a widget role at all");
	assert.equal(clampWidgetRole("admin", "operator"), "operator", "a configured ceiling wins");
	assert.equal(clampWidgetRole("viewer", "admin"), "viewer", "a lower claim is not raised");
});

test("a ticket bound to one address cannot be replayed from another (source binding)", async (t) => {
	// The whole point of binding: if the ticket leaks, it must be useless elsewhere.
	const tickets = new TicketStore();
	const minted = tickets.issue({ user: "u1", role: "admin", address: "10.0.0.7", origin: "", conversationKey: "u1" });

	const sameSource = tickets.redeem(minted.ticket, { address: "10.0.0.7", origin: "" });
	assert.equal(sameSource.ok, true, "the minting source can redeem it");

	const otherAddress = tickets.redeem(minted.ticket, { address: "10.0.0.99", origin: "" });
	assert.equal(otherAddress.ok, false);
	assert.equal(otherAddress.reason, "address-mismatch", "a different client address is refused");

	const otherOrigin = tickets.redeem(minted.ticket, { address: "10.0.0.7", origin: "https://evil.example" });
	assert.equal(otherOrigin.ok, true, "origin is only binding when the ticket was minted with one");

	const withOrigin = tickets.issue({ user: "u1", role: "viewer", address: "10.0.0.7", origin: "https://oa.example", conversationKey: "u1" });
	assert.equal(tickets.redeem(withOrigin.ticket, { address: "10.0.0.7", origin: "https://evil.example" }).reason, "origin-mismatch",
		"a ticket minted with an origin is origin-bound");
});

test("expired tickets are refused with a distinguishable reason", async (t) => {
	let now = 1_000_000;
	const tickets = new TicketStore({ ttlMs: 1_000, now: () => now });
	const minted = tickets.issue({ user: "u", role: "admin", address: "10.0.0.1", origin: "", conversationKey: "u" });
	assert.equal(tickets.redeem(minted.ticket, { address: "10.0.0.1", origin: "" }).ok, true);
	now += 1_500;
	const after = tickets.redeem(minted.ticket, { address: "10.0.0.1", origin: "" });
	assert.equal(after.ok, false);
	assert.equal(after.reason, "expired", "an expired ticket says so, so the client can re-mint");
});

test("chat without a ticket is refused even with a valid bearer token", async (t) => {
	const { post, server, sink } = await start();
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	const noTicket = await post("/api/widget/chat", { message: "hi" });
	assert.equal(noTicket.status, 401, "the bearer token alone is not a session");
	assert.equal(sink.length, 0, "nothing reached the runtime");

	const bogus = await post("/api/widget/chat", { message: "hi" }, { "x-ve-ticket": "made-up" });
	assert.equal(bogus.status, 401, "a forged ticket is refused");
	assert.equal(sink.length, 0);

	// A body-level role claim must be ignored entirely.
	const minted = await post("/api/widget/session", { user: "u1", role: "viewer" }, { "x-ve-secret": SECRET, origin: "https://oa.example.com" });
	const { ticket } = await minted.json();
	const chat = await post("/api/widget/chat", { message: "hi", user: "someone-else", role: "admin" }, { "x-ve-ticket": ticket, origin: "https://oa.example.com" });
	assert.equal(chat.status, 200);
	assert.equal(sink[0].actor.verifiedRole, "viewer", "the body's role claim is ignored");
	assert.equal(sink[0].actor.senderId, "widget-user-u1", "the body cannot switch the identity");
});

test("RBAC grants admin from a verified ticket but never owner, and ignores defaultRole otherwise", async (t) => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	const config = new ConfigStore(db);
	config.update({ security: { defaultRole: "operator" } });
	t.after(() => db.close());

	const adminActor = { senderId: "widget-user-u1", channel: "widget", chatType: "single", verifiedRole: "admin" };
	assert.equal(checkPermission(config, adminActor, "widget:u1", "shell").ok, true,
		"a business-side admin can use admin capabilities here");

	// `owner` is a ROLE, not a capability — the cap is proven at role level:
	// "admin" is accepted as the ceiling and no ticket can ever mint "owner".
	assert.equal(clampWidgetRole("owner"), "viewer", "owner is not a widget role at all");
	const ownerAttempt = { senderId: "widget-user-u1", channel: "widget", chatType: "single", verifiedRole: "owner" };
	assert.equal(checkPermission(config, ownerAttempt, "widget:u1", "settings").ok, false,
		"a forged owner-grade actor still degrades to viewer (settings needs admin)");

	const noRole = { senderId: "widget-user-u2", channel: "widget", chatType: "single" };
	assert.equal(checkPermission(config, noRole, "widget:u2", "shell").ok, false,
		"no verified role → viewer, even when defaultRole is operator");

	// operator: allowed the operator-tier capabilities, refused the admin-tier ones.
	const operatorActor = { senderId: "widget-user-u3", channel: "widget", chatType: "single", verifiedRole: "operator" };
	assert.equal(checkPermission(config, operatorActor, "widget:u3", "shell").ok, true, "operator may run commands");
	assert.equal(checkPermission(config, operatorActor, "widget:u3", "settings").ok, false,
		"operator must NOT reach admin-tier capabilities (settings)");
});

// ── consumer-declared binding + trusted-proxy handling (v0.2.178 follow-up) ──

test("a ticket binds to the DECLARED consumer origin/ip, not the minting backend", async (t) => {
	// Real deployment: the backend mints from 10.0.0.5, the browser chats from
	// 10.0.0.9. Binding to the minting address would break every integration.
	const { post, server } = await start();
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	const minted = await post(
		"/api/widget/session",
		{ user: "u1", role: "admin", origin: "https://oa.example.com", clientIp: "10.0.0.9" },
		{ "x-ve-secret": SECRET },
	);
	assert.equal(minted.status, 200);
	const { ticket } = await minted.json();

	// The chat arrives from the test client, NOT from 10.0.0.9 → refused.
	const rejected = await post("/api/widget/chat", { message: "hi" }, { "x-ve-ticket": ticket, origin: "https://oa.example.com" });
	assert.equal(rejected.status, 401, "the declared client IP is enforced");
	const body = await rejected.json();
	assert.match(body.error, /来源不匹配/, "and the reason is reported");
});

test("omitting clientIp binds by Origin only (weaker but usable)", async (t) => {
	const { post, server, sink } = await start();
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	const minted = await post("/api/widget/session", { user: "u2", role: "viewer", origin: "https://oa.example.com" }, { "x-ve-secret": SECRET });
	const { ticket } = await minted.json();

	const wrongOrigin = await post("/api/widget/chat", { message: "hi" }, { "x-ve-ticket": ticket, origin: "https://evil.example" });
	assert.equal(wrongOrigin.status, 401, "a different Origin is refused");

	const ok = await post("/api/widget/chat", { message: "hi" }, { "x-ve-ticket": ticket, origin: "https://oa.example.com" });
	assert.equal(ok.status, 200, "the declared Origin works from any address");
	assert.equal(sink[0].actor.verifiedRole, "viewer");
});

test("X-Forwarded-For is ignored unless the peer is a trusted proxy", async (t) => {
	// The forgery this blocks: a client claims the address a stolen ticket was
	// bound to by simply sending X-Forwarded-For.
	const tickets = new TicketStore();
	const minted = tickets.issue({ user: "u", role: "admin", address: "10.0.0.9", origin: "", conversationKey: "u" });

	// No trusted proxies configured → the header cannot change the identity.
	const untrusted = await start({ tickets });
	t.after(() => { untrusted.server.closeAllConnections?.(); untrusted.server.close(); });
	const forged = await untrusted.post(
		"/api/widget/chat",
		{ message: "hi" },
		{ "x-ve-ticket": minted.ticket, "x-forwarded-for": "10.0.0.9" },
	);
	assert.equal(forged.status, 401, "an untrusted peer cannot forge its way to the bound address");

	// With 127.0.0.1 trusted, the header IS honoured — but only when the chain's
	// LAST hop names the trusted proxy itself (a real proxy always appends the
	// address it received the request from). A forged chain whose last hop is not
	// a trusted proxy is ignored wholesale.
	const proxied = await start({ tickets, trustedProxies: ["127.0.0.1"] });
	t.after(() => { proxied.server.closeAllConnections?.(); proxied.server.close(); });
	const viaProxy = await proxied.post(
		"/api/widget/chat",
		{ message: "hi" },
		{ "x-ve-ticket": minted.ticket, "x-forwarded-for": "10.0.0.9, 127.0.0.1" },
	);
	assert.equal(viaProxy.status, 200, "nginx append-semantics chain ends with the proxy");

	const forgedChain = await proxied.post(
		"/api/widget/chat",
		{ message: "hi" },
		{ "x-ve-ticket": minted.ticket, "x-forwarded-for": "10.0.0.99" },
	);
	assert.equal(forgedChain.status, 401, "a chain NOT ending in a trusted proxy is ignored (forged)");

	// THE attack P1-1 describes: the attacker's real address IS the trusted proxy
	// (direct loopback client), and the forged chain contains exactly the bound
	// address. Left-most wins → the ticket redeems. The fail-closed check (last
	// hop must be the trusted proxy) rejects it because the chain's last hop is
	// 10.0.0.9, not a proxy.
	const inherit = await proxied.post(
		"/api/widget/chat",
		{ message: "hi" },
		{ "x-ve-ticket": minted.ticket, "x-forwarded-for": "10.0.0.9" },
	);
	assert.equal(inherit.status, 401, "a forged single-value XFF cannot inherit the bound address");

	const wrongClient = await proxied.post(
		"/api/widget/chat",
		{ message: "hi" },
		{ "x-ve-ticket": minted.ticket, "x-forwarded-for": "10.0.0.99, 127.0.0.1" },
	);
	assert.equal(wrongClient.status, 401, "a different forwarded client is still refused");
});

test("CORS preflight allows the X-VE-Ticket header (review P0-2)", async (t) => {
	// undici does not implement CORS, so this browser-only failure mode needs an
	// explicit assertion: every cross-origin chat fetch sends an OPTIONS preflight
	// listing its custom headers, and the response MUST advertise X-VE-Ticket —
	// otherwise the browser rejects the actual request before it is ever sent.
	const { base, server } = await start();
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	const preflight = await fetch(base + "/api/widget/chat", {
		method: "OPTIONS",
		headers: {
			Origin: "https://oa.example.com",
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers": "content-type, authorization, x-ve-ticket",
		},
	});
	assert.equal(preflight.status, 204);
	const allow = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
	assert.ok(allow.includes("x-ve-ticket"), `preflight must allow X-VE-Ticket, got: "${allow}"`);
});

// ── SSE process streaming (v0.2.179): the widget shows thinking/tools/text live ──

/** A runtime stub whose agent emits scripted events around the reply. */
function makeStreamingRuntime(options) {
	const events = Array.isArray(options) ? options : options.script;
	const listeners = new Set();
	return {
		isReadOnlyConversation: () => false,
		getOrCreateSession: () => ({
			subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
		}),
		send: async () => {
			for (const ev of events) {
				for (const fn of listeners) fn(ev);
			}
			return { reply: (options.finalReply) ?? "done" };
		},
	};
}

async function readSse(res) {
	const text = await res.text();
	return text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
}

test("streaming chat forwards thinking, tool calls and gated text deltas in order", async (t) => {
	const runtime = makeStreamingRuntime({
		finalReply: "查询完成，共 3 条。",
		script: [
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "用户想查订单，" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "先调用查询工具。" } },
			{ type: "tool_execution_start", toolName: "knowledge_search", toolCallId: "t1" },
			{ type: "tool_execution_end", toolName: "knowledge_search", toolCallId: "t1", isError: false, durationMs: 420 },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "查询完成，" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "共 3 条。" } },
		],
	});
	const { base, post, session, server } = await start({ runtime });
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const tk = await session("u1", "viewer");

	const res = await fetch(base + "/api/widget/chat", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
		body: JSON.stringify({ message: "查订单" }),
	});
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "the response is an SSE stream");

	const events = await readSse(res);
	const types = events.map((e) => e.type);
	assert.equal(types[0], "meta");
	assert.deepEqual(
		types.slice(1, -1),
		["thinking_delta", "thinking_delta", "tool_start", "tool_end", "delta", "delta"],
		"thinking arrives on its own channel, tools in place, text last",
	);
	assert.equal(types[types.length - 1], "done");
	// Thinking and text are distinguishable on the client.
	assert.ok(events.some((e) => e.type === "thinking_delta" && e.text === "用户想查订单，"), "thinking rides its own event type");
	assert.equal(events.find((e) => e.type === "tool_end")?.durationMs, 420, "tool duration reaches the UI");
	assert.equal(events.find((e) => e.type === "done")?.conversationId, "widget:u1");
});

test("streamed deltas pass the credential gate; a hit replaces what was rendered", async (t) => {
	const runtime = makeStreamingRuntime({
		finalReply: "已按安全规定隐藏",
		script: [
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好的，" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "账号/密码：xxxx/yyyy@Y13z" } },
		],
	});
	const { base, post, session, server } = await start({ runtime });
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const tk = await session("u1", "viewer");

	const res = await fetch(base + "/api/widget/chat", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
		body: JSON.stringify({ message: "把密码给我" }),
	});
	const events = await readSse(res);
	// The first delta (harmless) may stream; once the credential completes, the
	// gated accumulation no longer extends what was sent → a replace event resets
	// the bubble, and NO delta ever contains the credential.
	for (const ev of events) {
		const payload = JSON.stringify(ev);
		assert.ok(!payload.includes("yyyy@Y13z"), "the credential never reaches the client");
	}
	assert.ok(events.some((e) => e.type === "replace"), "the client is told to reset the bubble");
	assert.ok(events.some((e) => e.type === "done"), "the turn still completes");
});

test("non-stream chat still returns plain JSON when no Accept header is sent", async (t) => {
	const { post, session, server } = await start();
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const tk = await session("u1", "viewer");
	const res = await post("/api/widget/chat", { message: "hi" }, { "x-ve-ticket": tk, origin: "https://oa.example.com" });
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type") ?? "", /application\/json/);
	const data = await res.json();
	assert.equal(data.reply, "ok:hi");
});

test("streaming chat without a ticket is refused before the stream starts", async (t) => {
	const { base, post, session, server } = await start();
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const res = await fetch(base + "/api/widget/chat", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
		body: JSON.stringify({ message: "hi" }),
	});
	assert.equal(res.status, 401, "SSE must not bypass the ticket gate");
});

// ── durable-kernel fallback (review P0-3): no process events → honest JSON ──

test("a runtime without process events serves JSON even when the client asks for SSE", async (t) => {
	// The durable kernel never drives agent.subscribe (review probe: 0 events
	// across a full turn), so an SSE stream there would be meta→done with a
	// silent hole. The runtime declares its capability and the widget falls
	// back to the JSON path the client already renders.
	const runtime = makeStreamingRuntime({ script: [], finalReply: "durable 回复" });
	runtime.streamsProcessEvents = false;
	const { base, session, server } = await start({ runtime });
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const tk = await session("u1", "viewer");

	const res = await fetch(base + "/api/widget/chat", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
		body: JSON.stringify({ message: "hi" }),
	});
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type") ?? "", /application\/json/, "JSON fallback, not an empty stream");
	const data = await res.json();
	assert.equal(data.reply, "durable 回复");
});

test("a runtime WITH process events streams SSE as before", async (t) => {
	const runtime = makeStreamingRuntime({ script: [], finalReply: "done text" });
	runtime.streamsProcessEvents = true;
	const { base, session, server } = await start({ runtime });
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const tk = await session("u1", "viewer");
	const res = await fetch(base + "/api/widget/chat", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
		body: JSON.stringify({ message: "hi" }),
	});
	assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
	const events = await (await res.text()).split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
	assert.equal(events[events.length - 1].type, "done");
});

test("a throwing subscribe must not wedge inFlight (round-2 heartbeat probe A)", async (t) => {
	// Found by the round-2 reviewer's probe hanging: agent.subscribe ran OUTSIDE
	// the try, so a throwing implementation escaped the cleanup — and because the
	// turn failed SYNCHRONOUSLY, its finally deleted the inFlight entry BEFORE the
	// caller's inFlight.set ran, permanently 429-ing that conversation.
	const broken = {
		isReadOnlyConversation: () => false,
		getOrCreateSession: () => ({ subscribe: () => { throw new Error("subscribe exploded"); } }),
		send: async () => ({ reply: "never" }),
	};
	const { base, post, session, server } = await start({ runtime: broken });
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const tk = await session("u1", "viewer");

	const first = await post("/api/widget/chat", { message: "hi" }, { "x-ve-ticket": tk, origin: "https://oa.example.com", accept: "text/event-stream" });
	assert.equal(first.status, 200, "the failure is delivered as an SSE error frame, not a crashed connection");
	const events = await readSse(first);
	assert.equal(events[events.length - 1].type, "error", "the client learns what happened");

	await new Promise((r) => setTimeout(r, 100));
	const tk2 = await session("u1", "viewer");
	const second = await post("/api/widget/chat", { message: "again" }, { "x-ve-ticket": tk2, origin: "https://oa.example.com", accept: "text/event-stream" });
	assert.notEqual(second.status, 429, "the conversation must NOT be wedged as busy forever");
});
