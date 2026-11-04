/**
 * Widget per-user conversation isolation.
 *
 * FIELD 2026-11-04 (user report): "每个 ai 助理接入进来要带用户信息吧，然后用不同的
 * 对话，共用会话的话可能会有信息泄露的风险". The isolation EXISTED (one
 * conversation per user), but the KEY function was lossy and merged users:
 *
 *   "zhang.san"        -> "zhangsan"      ┐ same conversation
 *   "zhangsan"         -> "zhangsan"      ┘
 *   "张三" / "李四" ... -> "anon"          ← EVERY non-ASCII user shared one bucket
 *
 * The "anon" collapse was the dangerous one: a business system using Chinese
 * names or phone numbers as the user id would put all its users into ONE
 * conversation, so each saw the others' history — and they shared one senderId,
 * hence one RBAC identity and one memory scope.
 *
 * The key must be INJECTIVE. These tests pin that.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.widget-user-isolation-test-"));
process.on("exit", () => { rm(dir, { recursive: true, force: true }).catch(() => {}); });

const bundle = join(dir, "k.mjs");
await build({
	stdin: { contents: 'export { widgetConversationKey, TicketStore } from "./src/widget/widget-ticket.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { widgetConversationKey } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

test("THE LEAK: distinct ids that the old sanitiser merged now differ", () => {
	// Every pair below produced an IDENTICAL key before the fix.
	const pairs = [
		["zhang.san", "zhangsan"],
		["user@example.com", "userexamplecom"],
		["user+1@example.com", "user1examplecom"],
		["a.b", "a b"],
		["a-b", "a_b"], // both safe, but still different ids
	];
	for (const [a, b] of pairs) {
		assert.notEqual(
			widgetConversationKey(a),
			widgetConversationKey(b),
			`"${a}" and "${b}" must NOT share a conversation`,
		);
	}
});

test("THE WORST CASE: Chinese names no longer collapse into one 'anon' bucket", () => {
	// Before the fix all of these returned "anon" — one shared conversation for
	// every user of a Chinese-language business system.
	const names = ["张三", "李四", "王五", "赵六的账号"];
	const keys = names.map(widgetConversationKey);
	assert.equal(new Set(keys).size, names.length, `all users must be distinct: ${JSON.stringify(keys)}`);
	for (const k of keys) assert.notEqual(k, "anon", "a named user must never land in the anonymous bucket");
});

test("keys are unique across a realistic user population", () => {
	// Phone numbers / emails / CJK / mixed — the shapes a business system really
	// uses as a user id.
	const users = [
		...Array.from({ length: 200 }, (_, i) => `1380000${String(i).padStart(4, "0")}`),
		...Array.from({ length: 200 }, (_, i) => `user${i}@example.com`),
		...Array.from({ length: 200 }, (_, i) => `员工${i}`),
		...Array.from({ length: 200 }, (_, i) => `emp.${i}`),
	];
	const keys = users.map(widgetConversationKey);
	assert.equal(new Set(keys).size, users.length, "no two users may ever share a key");
});

test("surrounding whitespace does not create a second conversation for one user", () => {
	// The same person typing the same id must not get a fresh (empty) chat.
	assert.equal(widgetConversationKey("u1"), widgetConversationKey("  u1  "));
});

test("an EMPTY id still lands in the anonymous bucket (nothing to isolate)", () => {
	for (const empty of ["", "   ", null, undefined]) {
		assert.equal(widgetConversationKey(empty), "anon");
	}
});

test("the key stays a single safe path/segment component", () => {
	// It is embedded in `widget:<key>` and travels into history/DB keys.
	for (const id of ["../../etc/passwd", "a/b", "a:b", "a\nb", "张三"]) {
		const k = widgetConversationKey(id);
		assert.doesNotMatch(k, /[^A-Za-z0-9_-]/, `key must be safe: ${JSON.stringify(k)}`);
		assert.ok(!k.includes(".."));
	}
});

test("the key keeps a readable prefix for debugging", () => {
	assert.match(widgetConversationKey("zhangsan"), /^zhangsan-/);
	assert.match(widgetConversationKey("张三"), /^u-/, "a pure-CJK id still gets a usable prefix");
});

test("the key is stable across calls (a restart must not orphan a conversation)", () => {
	const a = widgetConversationKey("user@example.com");
	const b = widgetConversationKey("user@example.com");
	assert.equal(a, b);
});

test("senderId derived from the key is unique too (RBAC + memory scope)", async () => {
	// widget-service builds `widget-user-${key}` as the actor identity; a key
	// collision would mean two people sharing an RBAC role and a memory scope.
	const { startWidgetServer } = await (async () => {
		const b2 = join(dir, "svc.mjs");
		await build({
			stdin: { contents: 'export { startWidgetServer } from "./src/widget/widget-service.ts";', resolveDir: root, loader: "ts" },
			outfile: b2, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
		});
		return import(pathToFileURL(b2).href + `?t=${Date.now()}`);
	})();
	assert.ok(startWidgetServer, "widget service loads");
	const a = `widget-user-${widgetConversationKey("zhang.san")}`;
	const b = `widget-user-${widgetConversationKey("zhangsan")}`;
	assert.notEqual(a, b);
});
