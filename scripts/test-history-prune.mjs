/**
 * One-off conversation auto-prune tests (field 2026-10-13: the task list filled
 * with hundreds of sched:/work: sessions the user cannot act on).
 *
 * Real SQLite. Pins the safety property that makes auto-deletion acceptable:
 * ONLY machine-minted ids (sched:/work:/eval:) are eligible, and only when
 * untouched past the cutoff. IM and console conversations — the user's own data
 * — are never touched, no matter how old.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.prune-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "prune.mjs");
await build({
	stdin: { contents: 'export { HistoryStore } from "./src/db/history-store.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { HistoryStore } = await import(pathToFileURL(bundle).href);

const DAY = 86_400_000;

function store() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_supplier_id TEXT, model_model_id TEXT, origin TEXT NOT NULL DEFAULT 'console');");
	db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL);");
	db.exec("CREATE TABLE IF NOT EXISTS work_mining_cursors (conversation_id TEXT NOT NULL, last_message_id TEXT, last_scanned_at INTEGER NOT NULL, PRIMARY KEY (conversation_id));");
	db.exec("CREATE TABLE IF NOT EXISTS turn_events (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'console', started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0);");
	db.exec("CREATE TABLE IF NOT EXISTS tool_events (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, name TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0);");
	return new HistoryStore(db);
}

test("only stale machine conversations are pruned; user data survives at any age", (t) => {
	const s = store();
	const now = Date.now();
	const stale = now - 30 * DAY;
	const fresh = now - 1 * DAY;
	// Machine conversations, well past a 7-day cutoff.
	s.ensureConversation("sched:t1:1699999999999", "⏰ 巡检", "scheduled");
	s.ensureConversation("work:w1", "自主任务", "work");
	s.ensureConversation("eval:e1", "eval", "eval");
	// The USER's own data — same age or older.
	s.ensureConversation("dt:group:cidBUSINESS", "对账群", "im");
	s.ensureConversation("console-uuid-1", "控制台会话", "console");
	// A machine conversation still being worked on (fresh updated_at).
	s.ensureConversation("sched:t2:1699999999999", "⏰ 跑得中的任务", "scheduled");
	for (const id of ["sched:t1:1699999999999", "work:w1", "eval:e1", "dt:group:cidBUSINESS", "console-uuid-1"]) {
		s.touch(id); // sets updated_at = now
		s.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(stale, id);
	}
	s.touch("sched:t2:1699999999999"); // fresh — in flight

	const removed = s.pruneOneOffConversations(now - 7 * DAY);
	assert.equal(removed, 3, "exactly the three stale machine conversations");
	const left = s.listConversations().map((c) => c.id).sort();
	assert.deepEqual(left, ["console-uuid-1", "dt:group:cidBUSINESS", "sched:t2:1699999999999"].sort(),
		"IM + console + an in-flight machine run all survive");
	// Messages of a pruned conversation go with it (no orphan rows): re-create
	// the id with a message, age it past the cutoff, prune again.
	s.ensureConversation("work:w1", "自主任务", "work");
	s.appendMessage("work:w1", "user", "x");
	s.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now - 30 * DAY, "work:w1");
	assert.equal(s.pruneOneOffConversations(now - 7 * DAY), 1);
	assert.equal(s.listMessages("work:w1").length, 0, "cascade delete removes the messages");
	t.after(() => undefined);
});

test("a retention window of 0 days prunes nothing (disabled)", (t) => {
	const s = store();
	s.ensureConversation("sched:t1:1", "⏰ 老巡检", "scheduled");
	s.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(Date.now() - 365 * DAY, "sched:t1:1");
	// The main-process helper returns early on 0; the store itself still honours
	// an explicit cutoff, so assert the cutoff path is what gates it.
	assert.equal(s.pruneOneOffConversations(0), 0, "cutoff 0 = now, nothing is older than now");
	assert.equal(s.listConversations().length, 1);
});

test("pruneOldMessages removes aged message bodies + telemetry but keeps every conversation", () => {
	const s = store();
	const now = Date.now();
	for (const id of ["dt:group:cidIM", "sched:t1:1"]) s.ensureConversation(id, "t");
	s.appendMessage("dt:group:cidIM", "user", "旧消息");
	s.appendMessage("dt:group:cidIM", "user", "新消息");
	s.db.prepare("UPDATE messages SET created_at = ? WHERE content = '旧消息'").run(now - 60 * 86_400_000);
	s.db.prepare("INSERT INTO turn_events (id, conversation_id, started_at) VALUES ('te1', 'dt:group:cidIM', ?)").run(now - 60 * 86_400_000);
	s.db.prepare("INSERT INTO tool_events (id, conversation_id, name, started_at) VALUES ('to1', 'dt:group:cidIM', 'browser_read', ?)").run(now - 60 * 86_400_000);

	const removed = s.pruneOldMessages(now - 30 * 86_400_000);
	assert.equal(removed, 1, "only the aged message row");
	const left = s.listMessages("dt:group:cidIM").map((m) => m.content);
	assert.deepEqual(left, ["新消息"], "recent messages survive");
	assert.equal(s.getConversation("dt:group:cidIM")?.id, "dt:group:cidIM", "the conversation entry survives");
	assert.equal(s.db.prepare("SELECT COUNT(*) n FROM turn_events").get().n, 0, "aged turn telemetry goes");
	assert.equal(s.db.prepare("SELECT COUNT(*) n FROM tool_events").get().n, 0, "aged tool telemetry goes");
});

test("incremental page never loses a message written in the same millisecond", async () => {
	// A user turn and an instant reply land in the same tick. With a timestamp-only
	// cursor the second one is skipped forever (the cursor already moved past that
	// ms), which is exactly the "message never appears" symptom on long chats.
	const { HistoryStore } = await import(pathToFileURL(bundle).href);
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_supplier_id TEXT, model_model_id TEXT, origin TEXT NOT NULL DEFAULT 'console');
		CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL);`);
	const history = new HistoryStore(db);
	const conv = "console:same-ms";
	history.ensureConversation(conv, "t");

	// Two messages, forced into the same millisecond.
	const now = Date.now();
	db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run("m1", conv, "user", "问题", now);
	db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run("m2", conv, "assistant", "回答", now);

	const first = history.listMessagesSinceCursor(conv, undefined, 1);
	assert.equal(first.rows.length, 1, "page size respected");
	assert.equal(first.rows[0].id, "m1");
	// The composite cursor must still surface m2 — same ts, higher rowid.
	const second = history.listMessagesSinceCursor(conv, first.cursor, 10);
	assert.equal(second.rows.length, 1, "CRITICAL: the same-millisecond sibling must not be lost");
	assert.equal(second.rows[0].id, "m2");
	// Idempotent tail: nothing further.
	assert.equal(history.listMessagesSinceCursor(conv, second.cursor, 10).rows.length, 0);
	db.close();
});
