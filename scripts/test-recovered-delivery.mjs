/**
 * Regression: "durable never recovered anything" (operator report 2026-10-29).
 *
 * Two separate facts, one of which was a real defect:
 *  - NOT A DEFECT: a graceful upgrade/restart joins in-flight runs and closes
 *    cleanly, so nothing is pending to recover; the task layer resumes at its
 *    next due time. Durable only covers a real crash mid-turn.
 *  - DEFECT: a crash-recovered WINDOW run (work:<itemId>, sched:<taskId>:<runId>)
 *    pushed its answer only when `history.isReadOnly(conversationId)` was true.
 *    Window conversations are neither, so the recovered work finished and
 *    reported into a console conversation nobody opens — which reads as
 *    "recovery never happened".
 *
 * User ruling: the recovered result goes back to the task's source
 * conversation, annotated so a note arriving hours later is not mistaken for a
 * fresh hallucinated message.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.recovered-delivery-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const bundle = join(dir, "delivery.mjs");
await build({
	stdin: { contents: `export * from "./src/engine/durable/recovered-delivery.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { planRecoveredDelivery, formatRecoveredNote } = await import(pathToFileURL(bundle).href);

test("a crashed work window routes its recovered result back to the item's source", () => {
	assert.deepEqual(
		planRecoveredDelivery("work:dd4b3238-864c-4409-88af-d60809984d88"),
		{ kind: "task-source", task: "work", taskId: "dd4b3238-864c-4409-88af-d60809984d88" },
		"work:<itemId> must resolve through the work item, never push to the console conversation",
	);
});

test("a crashed scheduled run routes back to the task, not to the per-run conversation", () => {
	assert.deepEqual(
		planRecoveredDelivery("sched:task-9:1759000000000"),
		{ kind: "task-source", task: "scheduled", taskId: "task-9" },
		"the run id is dropped: the answer belongs to the task's source conversation",
	);
	// Run ids can carry colons; only the first segment is the task id.
	assert.deepEqual(
		planRecoveredDelivery("sched:task-9:run:with:colons"),
		{ kind: "task-source", task: "scheduled", taskId: "task-9" },
	);
});

test("IM conversations keep their original behaviour", () => {
	assert.deepEqual(planRecoveredDelivery("dt:group:g1"), { kind: "direct", conversationId: "dt:group:g1" });
	assert.deepEqual(planRecoveredDelivery("dt:staff42"), { kind: "direct", conversationId: "dt:staff42" });
});

test("malformed ids never fall back to the console conversation", () => {
	// The defect being fixed was exactly "falls through to a conversation nobody
	// watches" — so an unparseable window id must go quiet, not direct.
	assert.deepEqual(planRecoveredDelivery("work:"), { kind: "none" });
	assert.deepEqual(planRecoveredDelivery("sched:"), { kind: "none" });
	assert.deepEqual(planRecoveredDelivery(""), { kind: "none" });
	assert.deepEqual(planRecoveredDelivery("default"), { kind: "none" });
});

test("the recovered note is unmistakably a post-crash continuation", () => {
	const withTitle = formatRecoveredNote({ title: "对账任务", reply: "已完成全部核对。" });
	assert.match(withTitle, /对账任务/, "the note names the task");
	assert.match(withTitle, /崩溃后已自动恢复/, "and says it was recovered after a crash — a bare answer hours later reads as a hallucination");
	assert.match(withTitle, /已完成全部核对。/, "the answer itself is preserved");
	const noTitle = formatRecoveredNote({ title: null, reply: "完成" });
	assert.match(noTitle, /崩溃后已自动恢复/);
	const emptyReply = formatRecoveredNote({ title: "任务", reply: "   " });
	assert.doesNotMatch(emptyReply, /\n\n\s*$/, "an empty reply must not leave a dangling blank body");
});


test("a durably-recovered work item is NOT stamped 「请管理员核查」 by the startup takeover", async () => {
	// The startup order is: durable recovery (main.ts:996) → workService.start()
	// (main.ts:1269). The latter calls recoverWorking(), which blanket-updates
	// every 'working' row to waiting_human with 「应用曾在执行中退出；请管理员核查…」.
	// For a window durable just recovered, the WORK completed — only the
	// runner's outcome write died with the process. Without the skip list that
	// stamp turned a successful recovery into a manual-intervention request.
	const workDir = mkdtempSync(join(root, "node_modules/.recovered-working-test-"));
	process.on("exit", () => { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ } });
	const b = join(workDir, "store.mjs");
	await build({
		stdin: { contents: `export { WorkItemStore } from "./src/db/work-item-store.ts";`, resolveDir: root, loader: "ts" },
		outfile: b,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
	});
	const { WorkItemStore } = await import(pathToFileURL(b).href);
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE work_items (id TEXT PRIMARY KEY, title TEXT, goal TEXT, conditions TEXT, status TEXT, progress TEXT, lessons TEXT,
		origin_conversation TEXT, origin_note TEXT, question TEXT, answer TEXT, next_check_at INTEGER, next_check_reason TEXT,
		fixed_streak INTEGER DEFAULT 0, kicked_off INTEGER DEFAULT 0, fallback_streak INTEGER DEFAULT 0, last_remind_at INTEGER,
		remind_count INTEGER DEFAULT 0, cadence_ms INTEGER, created_by TEXT, created_channel TEXT, resident INTEGER DEFAULT 0,
		timeout_streak INTEGER DEFAULT 0, max_minutes INTEGER, created_at INTEGER, updated_at INTEGER);`);
	const store = new WorkItemStore(db);
	const recovered = store.create({ title: "崩溃时在跑的任务", goal: "g", conditions: "c", created_by: "a", originConversation: "dt:group:g1" });
	const orphaned = store.create({ title: "没人接手的窗口", goal: "g", conditions: "c", created_by: "a", originConversation: "dt:group:g1" });
	// Both were mid-window when the process died.
	for (const item of [recovered, orphaned]) db.prepare("UPDATE work_items SET status = 'working' WHERE id = ?").run(item.id);

	store.recoverWorking([recovered.id]);

	assert.equal(store.get(recovered.id).status, "working", "a durably-recovered item keeps its working state so the runner can close it normally");
	assert.equal(store.get(orphaned.id).status, "waiting_human", "an item with no recovery still asks the admin to check what happened");
	assert.match(store.get(orphaned.id).question ?? "", /应用曾在执行中退出/, "and says why");

	// The no-skip form must behave exactly as before for callers that pass nothing.
	const legacy = store.create({ title: "旧调用", goal: "g", conditions: "c", created_by: "a" });
	db.prepare("UPDATE work_items SET status = 'working' WHERE id = ?").run(legacy.id);
	store.recoverWorking();
	assert.equal(store.get(legacy.id).status, "waiting_human", "the default call still takes over every working row");
	db.close();
});
