/**
 * Admin one-shot authorization tests. Run with `npm run test:authorization`.
 *
 * Field request 2026-09-17: a viewer in a work-integration group can do almost
 * nothing, but granting them operator/admin permanently would over-empower the
 * whole group. The answer is a one-shot voucher: a role-insufficient tool call
 * registers a pending request carrying the requester's original message; an
 * admin replies exactly 「确认授权」 in the same conversation; the request is
 * replayed once with the verified admin as the turn actor, and the voucher is
 * consumed. Non-admins saying the phrase accomplish nothing.
 *
 * Pinned properties: phrase matching is exact (punctuation-tolerant, never
 * substring), the pending request expires, one pending per conversation, and
 * the role-refusal carries the structured `kind` the flow keys off.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.authorization-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "authorization.mjs");
await build({
	stdin: {
		contents: `
			export { AuthorizationStore, isAuthorizationPhrase, AUTHORIZATION_PHRASE, AUTHORIZATION_TTL_MS } from "./src/engine/authorization.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { checkPermission } from "./src/security/permissions.ts";
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
const { AuthorizationStore, isAuthorizationPhrase, AUTHORIZATION_TTL_MS, ConfigStore, checkPermission } = await import(pathToFileURL(bundle).href);

const req = (over = {}) => ({
	conversationId: "dt:group:1",
	message: "请帮我配置接口权限",
	requesterId: "viewer01",
	capability: "browser",
	need: "浏览器",
	requestedAt: Date.now(),
	...over,
});

test("the phrase matches exactly, tolerating whitespace and sentence punctuation", () => {
	for (const text of ["确认授权", " 确认授权 ", "确认授权。", "确认授权！", "！确认授权", "确认授权…"]) {
		assert.equal(isAuthorizationPhrase(text), true, `must match: ${JSON.stringify(text)}`);
	}
});

test("unrelated messages never arm a grant", () => {
	for (const text of [
		"",
		"确认授权吗",
		"请管理员确认授权",
		"我确认授权你",
		"确认授权后帮我看下",
		"确认授",
		"授权",
		"同意", // similar intent, wrong phrase — only the exact phrase is the trigger
		"确认授权 确认授权",
	]) {
		assert.equal(isAuthorizationPhrase(text), false, `must NOT match: ${JSON.stringify(text)}`);
	}
});

test("one pending per conversation; confirm consumes the single shot", () => {
	const store = new AuthorizationStore();
	store.note(req());
	assert.equal(store.peek("dt:group:1")?.message, "请帮我配置接口权限");

	// A second request replaces the first — the admin always answers the latest.
	store.note(req({ message: "第二个请求", requestedAt: Date.now() }));
	assert.equal(store.peek("dt:group:1")?.message, "第二个请求");

	const granted = store.consume("dt:group:1");
	assert.equal(granted?.message, "第二个请求");
	assert.equal(store.consume("dt:group:1"), undefined, "consumed once — a second confirm finds nothing");
});

test("expired requests are unconfirmable", () => {
	const store = new AuthorizationStore();
	const stale = Date.now() - AUTHORIZATION_TTL_MS - 1_000;
	store.note(req({ requestedAt: stale }));
	assert.equal(store.peek("dt:group:1"), undefined, "peek drops the expired entry");
	assert.equal(store.consume("dt:group:1"), undefined);
});

test("pending is per-conversation — no cross-chat leakage", () => {
	const store = new AuthorizationStore();
	store.note(req({ conversationId: "dt:group:A" }));
	store.note(req({ conversationId: "dt:single:B", message: "另一个会话的请求" }));
	assert.equal(store.consume("dt:group:A")?.message, "请帮我配置接口权限");
	assert.equal(store.peek("dt:single:B")?.message, "另一个会话的请求");
});

// The refusal the flow keys off: role shortfall must be distinguishable from
// the other failure modes (a misconfigured floor must NOT open the voucher path).
test("role refusals carry kind=role; misconfigurations carry kind=misconfig; grants carry none", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	after(() => db.close());
	config.replaceAll({ security: { people: [{ staffId: "viewer01", role: "viewer" }, { staffId: "boss", role: "admin" }] } });

	const viewer = { senderId: "viewer01", chatType: "group", channel: "dingtalk" };
	const boss = { senderId: "boss", chatType: "group", channel: "dingtalk" };

	const denied = checkPermission(config, viewer, "dt:group:1", "filesystem");
	assert.equal(denied.ok, false);
	assert.equal(denied.kind, "role", "role shortfall must be marked — this is what arms the voucher");

	const misconfig = (() => {
		// conversations is a LIST of {id, floors} — a typo'd role value must fail closed.
		config.replaceAll({
			security: {
				people: [{ staffId: "viewer01", role: "viewer" }],
				conversations: [{ id: "dt:group:1", floors: { filesystem: "typo" } }],
			},
		});
		return checkPermission(config, viewer, "dt:group:1", "filesystem");
	})();
	assert.equal(misconfig.ok, false);
	assert.equal(misconfig.kind, "misconfig", "a broken floor must fail closed, not open the voucher path");

	config.replaceAll({ security: { people: [{ staffId: "boss", role: "admin" }] } });
	const granted = checkPermission(config, boss, "dt:group:1", "filesystem");
	assert.equal(granted.ok, true);
	assert.equal(granted.kind, undefined, "a grant carries no refusal kind");
});
