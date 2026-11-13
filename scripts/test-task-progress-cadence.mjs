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
import { mkdtemp, rm, readFile } from "node:fs/promises";
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

async function makeDb() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	// Single source of truth: take the schema from sqlite.ts so a column added
	// there (e.g. priority, Router/Worker P2) can never silently diverge from
	// this fixture — the same convention test-work-service.mjs follows.
	// Base schema from sqlite.ts, then the same ALTER columns the real migrate
	// path adds (answer/created_channel/priority/resident are post-hoc columns).
	db.exec((await readFile(join(root, "src/db/sqlite.ts"), "utf8")).match(/CREATE TABLE IF NOT EXISTS work_items \([\s\S]*?\);/)[0]);
	for (const col of ["answer TEXT", "created_channel TEXT", "priority INTEGER NOT NULL DEFAULT 100", "resident INTEGER NOT NULL DEFAULT 0"]) {
		try { db.exec(`ALTER TABLE work_items ADD COLUMN ${col}`); } catch { /* already present */ }
	}
	return db;
}

test("chat cadence and task cadence are independent config keys", async () => {
	const db = await makeDb();
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

test("the scheduled-task heartbeat uses the TASK cadence, not the chat cadence", async () => {
	// Field 2026-11-07 (the box): an autonomous/scheduled task reported every
	// 10 minutes while taskProgressMin was 30 — the runner's in-turn heartbeat
	// read longTaskProgressMin (the CHAT knob). The two mean different things:
	//   longTaskProgressMin → what the USER watches: inline chat turns AND
		//                         chat-dispatched worker tasks (all worker rows are
	//                         born from a chat dispatch — field 2026-11-13: raising
	//                         taskProgressMin to 30 stretched their reporting too)
	//   taskProgressMin     → a scheduled/autonomous window that runs on its own
	// Wiring lives inline in main.ts's runner, so this pins the SOURCE: every
	// progress-interval site in the scheduled-task runner must read taskProgressMin.
	// and longTaskProgressMin may appear only in the IM manager (chat path).
	const mainSrc = await readFile(join(root, "electron/main.ts"), "utf8");
	const mgrSrc = await readFile(join(root, "src/im/manager.ts"), "utf8");

	// The scheduled runner's heartbeat block, identified by its own log marker.
	const heartbeatAt = mainSrc.indexOf("In-turn heartbeat while a turn is streaming");
	assert.ok(heartbeatAt > 0, "the scheduled-task heartbeat block must exist");
	const heartbeatBlock = mainSrc.slice(heartbeatAt, heartbeatAt + 2500);
	assert.match(heartbeatBlock, /general\.taskProgressMin/, "scheduled heartbeat must read taskProgressMin");
	assert.ok(
		!/general\.longTaskProgressMin/.test(heartbeatBlock),
		"scheduled heartbeat must NOT read longTaskProgressMin (chat cadence) — that is the 10-vs-30 confusion",
	);

	// The chat path keeps the chat knob, and main.ts's ONE legitimate consumer is
	// the chat-dispatched worker notifier (field 2026-11-13) — everything else in
	// main.ts (scheduled runner, work windows) stays on the task knob.
	assert.match(mgrSrc, /general\.longTaskProgressMin/, "the IM manager's chat heartbeat keeps longTaskProgressMin");

	// Exactly ONE chat-knob site in main.ts: the chat-dispatched worker notifier.
	const mainChatKnob = (mainSrc.match(/general\.longTaskProgressMin/g) ?? []).length;
	assert.equal(mainChatKnob, 1,
		`main.ts reads the chat cadence ONLY for the chat-dispatched worker notifier (found ${mainChatKnob})`);
	const workerNotifierAt = mainSrc.indexOf("ALWAYS born from a");
	assert.ok(workerNotifierAt > 0, "the chat-dispatched worker notifier comment must exist");
	const workerBlock = mainSrc.slice(workerNotifierAt - 200, workerNotifierAt + 700);
	assert.match(workerBlock, /general\.longTaskProgressMin/, "the worker notifier must be the site reading the chat cadence");
});

test("a work window stops and drains its progress notifier before the completion push", async (t) => {
	const db = await makeDb();
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
		push: async (_cid, text) => { pushed.push(text); return { ok: true }; },
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
	const db = await makeDb();
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
		push: async () => ({ ok: true }),
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
