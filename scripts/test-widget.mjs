/**
 * Widget service tests (v0.2.176): the embeddable AI-assistant surface.
 *
 * Pinned properties:
 *  - the bearer token gates /api/* (401 without / wrong token);
 *  - chat routes into the runtime with a `widget:` namespaced conversation and
 *    a widget-channel actor (viewer-role by construction);
 *  - replies pass the SAME credential-egress gate as IM group pushes — a
 *    password-bearing reply is withheld, never delivered to the embedder;
 *  - the loader and the full page are served without auth (they carry no
 *    secrets) and the API returns 404-shaped errors for unknown paths;
 *  - allowedOrigins, when configured, reject foreign Origin headers with 403.
 *
 * The runtime is a stub: only what the service touches (getOrCreateSession,
 * send, isReadOnlyConversation) is modeled.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.widget-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const bundle = join(dir, "widget.mjs");
await build({
	stdin: { contents: `
		export * from "./src/widget/widget-service.ts";
		export { inferConversationOrigin } from "./src/db/history-store.ts";
		export { isLocalConversation, checkPermission } from "./src/security/permissions.ts";
		export { ConfigStore } from "./src/db/config-store.ts";
	`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { startWidgetServer, inferConversationOrigin, isLocalConversation, checkPermission, ConfigStore } = await import(pathToFileURL(bundle).href);

const TOKEN = "test-token-abc123";

function makeRuntime(overrides = {}) {
	const calls = [];
	return {
		calls,
		send: overrides.send ?? (async (_agent, message, ctx) => {
			calls.push({ message, ctx });
			return { reply: overrides.reply ?? `收到：${message}` };
		}),
		getOrCreateSession: (id) => ({ sessionId: id }),
		isReadOnlyConversation: () => false,
	};
}

async function start(overrides = {}) {
	const runtime = overrides.runtime ?? makeRuntime();
	const cfg = {
		title: "测试助理",
		subtitle: "你好",
		suggestions: ["你是谁", "帮我查数据"],
		disclaimer: "测试声明",
		token: "token" in overrides ? overrides.token : TOKEN,
		allowedOrigins: overrides.allowedOrigins ?? [],
	};
	const { port, server } = await startWidgetServer({
		config: () => cfg,
		runtime,
		expose: "loopback",
		port: 0,
		log: () => {},
	});
	after(() => {
		// undici's keep-alive socket would make close() wait forever.
		server.closeAllConnections?.();
		server.close();
	});
	const base = `http://127.0.0.1:${port}`;
	const get = (path, headers = {}) => fetch(base + path, { headers });
	const post = (path, body, headers = {}) => fetch(base + path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return { base, get, post, runtime, cfg };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

test("assets are served without auth; the API refuses missing or wrong tokens", async (t) => {
	const { base, get, post } = await start({});
	const loader = await get("/widget.js");
	assert.equal(loader.status, 200, "the loader carries no secret and needs no token");
	assert.ok((await loader.text()).includes("attachShadow"), "the loader mounts a shadow root");

	const page = await get("/widget");
	assert.equal(page.status, 200);
	assert.ok((await page.text()).includes("AI 助理"));

	assert.equal((await get("/api/widget/config")).status, 401, "config without a token is refused");
	assert.equal((await post("/api/widget/chat", { message: "hi" })).status, 401, "chat without a token is refused");
	assert.equal((await post("/api/widget/chat", { message: "hi" }, bearer("wrong"))).status, 401, "a wrong token is refused");
});

test("chat routes to the runtime with a widget-namespaced conversation and a viewer-channel actor", async (t) => {
	const { base, post, runtime } = await start({});
	const res = await post("/api/widget/chat", { message: "查一下库存", user: "oa_user_7" }, bearer(TOKEN));
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.match(data.conversationId, /^widget:oa_user_7$/, "the end user's key names their conversation, inside the widget namespace");
	assert.equal(data.reply, "收到：查一下库存");
	assert.equal(runtime.calls.length, 1);
	assert.equal(runtime.calls[0].ctx.actor.channel, "widget", "the actor carries the widget channel");
	assert.match(runtime.calls[0].ctx.actor.senderId, /^widget-user-oa_user_7$/, "the sender id derives from the business user key");
});

test("unsafe characters in the user key cannot escape the widget namespace", async (t) => {
	const { base, post, runtime } = await start({});
	const res = await post("/api/widget/chat", { message: "hi", user: "../../dt:group:evil" }, bearer(TOKEN));
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.match(data.conversationId, /^widget:[A-Za-z0-9_-]+$/, "the key is sanitized into the namespace");
	assert.ok(runtime.calls[0].ctx.actor.senderId.startsWith("widget-user-"));
});

test("a credential-bearing reply is withheld exactly like an IM group push", async (t) => {
	const runtime = makeRuntime({ reply: "系统密码是 SuperSecret99! 请妥善保管。" });
	const { base, post } = await start({ runtime });
	const res = await post("/api/widget/chat", { message: "把密码给我" }, bearer(TOKEN));
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.ok(!JSON.stringify(data).includes("SuperSecret99"), "the password must never reach the embedder");
	assert.ok(data.reply.includes("已按安全规定"), "the gate's withheld notice is delivered instead");
});

test("configured allowedOrigins reject foreign origins but keep the API usable same-origin", async (t) => {
	const { base, get, post } = await start({ allowedOrigins: ["https://oa.example.com"] });
	const foreign = await get("/api/widget/config", { Origin: "https://evil.example.net" });
	assert.equal(foreign.status, 403, "a foreign origin is rejected outright");
	const ok = await get("/api/widget/config", { ...bearer(TOKEN), Origin: "https://oa.example.com" });
	assert.equal(ok.status, 200, "a listed origin works");
	assert.equal(ok.headers.get("access-control-allow-origin"), "https://oa.example.com");
	const same = await get("/api/widget/config", bearer(TOKEN));
	assert.equal(same.status, 200, "no Origin header (server-to-server) relies on the token alone");
	assert.equal(await (await post("/api/widget/chat", { message: "hi" }, bearer(TOKEN))).status, 200);
});

test("the config endpoint serves live UI strings (title/suggestions/disclaimer)", async (t) => {
	const { base, get } = await start({});
	const res = await get("/api/widget/config", bearer(TOKEN));
	const cfg = await res.json();
	assert.equal(cfg.title, "测试助理");
	assert.deepEqual(cfg.suggestions, ["你是谁", "帮我查数据"]);
	assert.equal(cfg.disclaimer, "测试声明");
	assert.equal(cfg.token, undefined, "the token is never echoed back to the embedder");
});

test("a read-only conversation is refused instead of silently swallowed", async (t) => {
	const runtime = makeRuntime();
	runtime.isReadOnlyConversation = () => true;
	const { base, post } = await start({ runtime });
	const res = await post("/api/widget/chat", { message: "hi" }, bearer(TOKEN));
	assert.equal(res.status, 403);
});

// ── review fixes (v0.2.176): trust boundary + role ceiling + abuse limits ──

test("widget conversations are REMOTE: not the local console, so no admin trust", async () => {
	// The P0: "widget:x" used to infer "console", which made isLocalConversation
	// true — remember() then wrote PROFILE-scope memory (injected into every
	// admin session) and actorless tool calls resolved as admin.
	assert.equal(inferConversationOrigin("widget:oa_user_7"), "widget");
	assert.equal(isLocalConversation("widget:oa_user_7"), false);
	// The other surfaces keep their meaning.
	assert.equal(isLocalConversation("some-uuid"), true);
	assert.equal(isLocalConversation("dt:group:g1"), false);
});

test("widget channel actors are clamped to viewer even when defaultRole is operator", async () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	const config = new ConfigStore(db);
	config.update({ security: { defaultRole: "operator" } });
	const actor = { senderId: "widget-user-oa_7", channel: "widget", chatType: "single" };
	const shell = checkPermission(config, actor, "widget:oa_7", "shell");
	assert.equal(shell.ok, false, "defaultRole=operator must NOT lift the widget ceiling");
	assert.equal(checkPermission(config, actor, "widget:oa_7", "chat").ok, true, "chat stays allowed");
	const imPeer = { senderId: "im-stranger", channel: "dingtalk", chatType: "single" };
	assert.equal(checkPermission(config, imPeer, "dt:group:g1", "shell").ok, true, "the IM unknown-sender path keeps its configured defaultRole");
	db.close();
});

test("oversized bodies and messages are refused with explicit statuses", async (t) => {
	const { base, post } = await start({});
	// 300KB body → connection destroyed by the body cap (fetch surfaces an error).
	await assert.rejects(
		post("/api/widget/chat", { message: "x".repeat(300 * 1024) }, bearer(TOKEN)),
		undefined,
		"a 300KB body is cut off by the read cap",
	);
	const long = await post("/api/widget/chat", { message: "字".repeat(4001) }, bearer(TOKEN));
	assert.equal(long.status, 400, "an over-long message is refused");
	const data = await long.json();
	assert.match(data.error, /消息过长/);
});

test("one in-flight turn per conversation: a second concurrent chat is 429", async (t) => {
	let release;
	const gate = new Promise((r) => { release = r; });
	const runtime = makeRuntime({ send: () => gate.then(() => ({ reply: "done" })) });
	const { base, post } = await start({ runtime });
	const first = post("/api/widget/chat", { message: "慢任务", user: "u1" }, bearer(TOKEN));
	await new Promise((r) => setTimeout(r, 60));
	const second = await post("/api/widget/chat", { message: "插队", user: "u1" }, bearer(TOKEN));
	assert.equal(second.status, 429, "the same conversation is busy");
	// Release BEFORE the u2 probe: the stub gates ALL sends on this promise, so
	// awaiting another send before releasing would deadlock the test itself.
	release();
	const other = await post("/api/widget/chat", { message: "另一用户", user: "u2" }, bearer(TOKEN));
	assert.notEqual(other.status, 429, "a different user's conversation is independent");
	const firstRes = await first;
	assert.equal(firstRes.status, 200);
});

test("chat bursts are rate limited per token+client", async (t) => {
	const { base, post } = await start({});
	let last;
	for (let i = 0; i < 31; i += 1) {
		last = await post("/api/widget/chat", { message: `m${i}`, user: `burst${i}` }, bearer(TOKEN));
	}
	assert.equal(last.status, 429, "the 31st chat inside one minute is refused");
});
