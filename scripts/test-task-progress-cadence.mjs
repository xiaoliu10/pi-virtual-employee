/**
 * v0.2.171: task-progress cadence split + work-window wiring.
 *
 * Field facts behind this suite:
 *  - the progress notifier was wired ONLY into the scheduled-task runner, so a
 *    work-item window (which runs for maxMinutes) stayed silent until it ended;
 *  - chat turns and task runs shared ONE knob (longTaskProgressMin), so an
 *    instance that tuned chat beats to 10 minutes could not give its long tasks
 *    a quieter 30-minute cadence.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.task-progress-cadence-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "cadence.mjs");
await build({
	stdin: {
		contents: `
			export { ConfigStore } from "./src/db/config-store.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { WorkService } from "./src/scheduler/work-service.ts";
			export { WorkItemStore } from "./src/db/work-item-store.ts";
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
const { ConfigStore, WorkService, WorkItemStore } = await import(pathToFileURL(bundle).href);

function makeDb() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	db.exec(`CREATE TABLE work_items (id TEXT PRIMARY KEY, title TEXT, goal TEXT, conditions TEXT, status TEXT, progress TEXT, lessons TEXT,
		origin_conversation TEXT, origin_note TEXT, question TEXT, answer TEXT, next_check_at INTEGER, next_check_reason TEXT, fixed_streak INTEGER DEFAULT 0,
		kicked_off INTEGER DEFAULT 0, fallback_streak INTEGER DEFAULT 0, last_remind_at INTEGER, remind_count INTEGER DEFAULT 0, cadence_ms INTEGER,
		created_by TEXT, created_channel TEXT, resident INTEGER DEFAULT 0, timeout_streak INTEGER DEFAULT 0, max_minutes INTEGER,
		created_at INTEGER, updated_at INTEGER);`);
	return db;
}

test("chat cadence and task cadence are independent config keys", () => {
	const db = makeDb();
	const config = new ConfigStore(db);
	config.update({ general: { longTaskProgressMin: 10 } });
	const cfg = config.all().general;
	assert.equal(cfg.longTaskProgressMin, 10, "chat cadence keeps its tuned value");
	assert.equal(cfg.taskProgressMin, 30, "task cadence falls back to the new default");
	config.update({ general: { taskProgressMin: 45 } });
	assert.equal(config.all().general.longTaskProgressMin, 10, "task cadence must not disturb chat cadence");
	assert.equal(config.all().general.taskProgressMin, 45);
	db.close();
});

test("a work window stops and drains its progress notifier before the completion push", async (t) => {
	const db = makeDb();
	const store = new WorkItemStore(db);
	const item = store.create({ title: "长窗口任务", goal: "g", conditions: "c", created_by: "admin1", originConversation: "dt:admin1" });
	store.confirm(item.id, "admin1");
	t.after(() => db.close());
	const pushed = [];
	const notifier = { starts: 0, stops: 0, drains: 0 };
	let session = { state: { isStreaming: false } };
	const ws = new WorkService({
		store,
		isAdmin: () => true,
		open: () => { session = { state: { isStreaming: true } }; return session; },
		send: async () => { session.state.isStreaming = false; return { reply: "窗口完成\n[[TASK_DONE]]" }; },
		release: async () => {},
		push: async (_cid, text) => { pushed.push(text); },
		budget: { maxTurns: 1, maxMinutes: 120 },
		progress: () => ({
			start() { notifier.starts += 1; },
			stop() { notifier.stops += 1; },
			async drain() { notifier.drains += 1; },
		}),
	});
	ws.start();
	t.after(async () => { await ws.stop(); });
	assert.equal(ws.fireItem(item.id), true, "queued item must be fireable");
	await ws.whenIdle();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(notifier.starts, 1, "one notifier per window");
	assert.equal(notifier.stops, 1, "notifier must be stopped when the window ends");
	assert.equal(notifier.drains, 1, "drained so a slow note cannot land after the completion push");
	console.log("PUSHED:", JSON.stringify(pushed));
	assert.ok(pushed.some((text) => text.includes("自主任务完成")), "the completion push still lands");
});

test("a window whose send throws still stops and drains the notifier", async (t) => {
	const db = makeDb();
	const store = new WorkItemStore(db);
	const boom = store.create({ title: "会炸的窗口", goal: "g", conditions: "c", created_by: "admin1" });
	store.confirm(boom.id, "admin1");
	t.after(() => db.close());
	const notifier = { starts: 0, stops: 0, drains: 0 };
	const ws = new WorkService({
		store,
		isAdmin: () => true,
		open: () => ({ state: { isStreaming: true } }),
		send: async () => { throw new Error("boom"); },
		release: async () => {},
		push: async () => {},
		budget: { maxTurns: 1, maxMinutes: 120 },
		progress: () => ({
			start() { notifier.starts += 1; },
			stop() { notifier.stops += 1; },
			async drain() { notifier.drains += 1; },
		}),
	});
	ws.start();
	t.after(async () => { await ws.stop(); });
	assert.equal(ws.fireItem(boom.id), true, "queued item must be fireable");
	await ws.whenIdle();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(notifier.stops, 1, "a throwing window must not leak a running notifier");
	assert.equal(notifier.drains, 1);
});
