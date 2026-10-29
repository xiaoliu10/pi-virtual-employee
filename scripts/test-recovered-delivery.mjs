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
