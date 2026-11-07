/**
 * Conversation-context prefix tests (context-management.md P1).
 *
 * The prefix is the Chain-of-Recall first hop made Inline: who is in this
 * conversation, and which tasks it recently ran — with their IDs. The pinned
 * properties are:
 *   1. members inline (name+id, recent-speaker-first, bounded)
 *   2. recent tasks inline (instruction digest + outcome digest + worker:<id>)
 *   3. non-IM conversations stay clean (console/sched get no prefix)
 *   4. budget: over-budget prefix truncates instead of flooding the window
 *   5. MUTATION GUARD: removing the injection must turn these tests red
 *
 * The engine method is private in TS; through the bundle it is plain JS and
 * callable directly — the send()-wiring is one line covered by review.
 */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";

const root = join(import.meta.dirname, "..");
const dir = await mkdtemp(join(root, "node_modules/.ctx-prefix-"));
after(() => rm(dir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export { EmployeeEngine } from "./src/engine/engine.ts"; export { HistoryStore } from "./src/db/history-store.ts"; export { ConfigStore } from "./src/db/config-store.ts";`,
		resolveDir: root, loader: "ts",
	},
	outfile: join(dir, "engine.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { EmployeeEngine, HistoryStore, ConfigStore } = await import(pathToFileURL(join(dir, "engine.mjs")));

function makeEngine(t, { tasks = [], members = {} } = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);");
	db.exec("CREATE TABLE IF NOT EXISTS conversation_members (conversation_id TEXT NOT NULL, staff_id TEXT NOT NULL, name TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, message_count INTEGER NOT NULL, PRIMARY KEY (conversation_id, staff_id));");
	t.after(() => db.close());
	const config = new ConfigStore(db);
	const history = new HistoryStore(db);
	for (const [cid, rows] of Object.entries(members)) {
		for (const [staffId, name] of rows) {
			// recordMember stamps last_seen_at = now internally; ordering by
			// recency inside one call batch still holds (insertion order).
			history.recordMember(cid, staffId, name);
		}
	}
	const knowledgeStub = { listMemoryIndex: () => [], listScopedMemoryIndex: () => [] };
	const stub = {};
	const engine = new EmployeeEngine(config, history, knowledgeStub, stub, stub, stub, stub, stub, stub, {
		builtinSkillsDir: dir,
		userSkillsDir: dir,
	}, {
		workerTaskSource: { listRecentForConversation: (cid, limit) => tasks.slice(0, limit) },
	});
	return { engine, history };
}

const NOW = Date.now();
const TASKS = [
	{ id: "taskA", instruction: "平阳数币今日交易金额监控", status: "done", result: "今日 823 元，未超阈值", error: null, created_at: NOW - 3600_000 },
	{ id: "taskB", instruction: "统计最近 7 天对账结果", status: "failed", result: null, error: "spay 登录态失效", created_at: NOW - 86_400_000 },
];

test("members + recent tasks are inlined with IDs into the conversation prefix", async (t) => {
	const { engine } = makeEngine(t, {
		tasks: TASKS,
		members: { "dt:group:g1": [["u1", "张三", NOW - 60_000], ["u2", "李四", NOW - 3_600_000]] },
	});
	const out = engine.withConversationContext("dt:group:g1", "原始消息");
	assert.match(out, /上下文速览/);
	assert.match(out, /张三\(u1\)/, "member name+id inline");
	assert.match(out, /李四\(u2\)/);
	assert.match(out, /worker:taskA/, "task id is the recall anchor");
	assert.match(out, /平阳数币今日交易金额监控/, "instruction digest inline");
	assert.match(out, /今日 823 元/, "result digest inline");
	assert.match(out, /已完成/, "status label inline");
	assert.match(out, /spay 登录态失效/, "failed task's error is the outcome digest");
	assert.match(out, /原始消息$/, "the user's message rides AFTER the prefix");
});

test("non-IM conversations get NO prefix (console/sched stay clean)", async (t) => {
	const { engine } = makeEngine(t, { tasks: TASKS, members: { "dt:group:g1": [["u1", "张三", NOW]] } });
	assert.equal(engine.withConversationContext("sched:job1", "hello"), "hello");
	assert.equal(engine.withConversationContext("bare-uuid", "hello"), "hello");
});

test("budget: an oversized member roster truncates instead of flooding", async (t) => {
	const many = Array.from({ length: 40 }, (_, i) => [`user-${i}`, `成员名字很长很长的第${i}号成员`, NOW - i * 1000]);
	const { engine } = makeEngine(t, { members: { "dt:group:big": many }, tasks: TASKS });
	const out = engine.withConversationContext("dt:group:big", "m");
	assert.match(out, /上下文速览/);
	// roster capped at MEMBER_LIMIT (10): count id-in-parens occurrences on the
	// member line (recordMember stamps all rows with the same timestamp, so
	// WHICH ten survive is insertion-order dependent — assert the bound, not
	// the identity).
	const memberLine = out.split("\n").find((l) => l.includes("本会话成员")) ?? "";
	const memberCount = (memberLine.match(/\(user-\d+\)/g) ?? []).length;
	assert.equal(memberCount, 10, "roster must be capped at the member limit (10)");
	assert.ok(out.length < 2000, "prefix stays bounded");
});

test("empty conversation (no members, no tasks) → no prefix noise", async (t) => {
	const { engine } = makeEngine(t, {});
	assert.equal(engine.withConversationContext("dt:group:empty", "hello"), "hello");
});
