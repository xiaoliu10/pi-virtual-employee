/**
 * SchedulerService unit tests. Run with `npm run test:scheduler-service`.
 *
 * The wedge regression (field 2026-09-22, ~4h scheduler freeze): a task run
 * that never settles used to hold the tick-level `ticking` lock forever, so
 * every later tick early-returned and ALL scheduled tasks stopped firing while
 * the app otherwise looked healthy. The fix bounds one run by a hard timeout —
 * a wedged run may waste only itself.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.schedsvc-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "schedsvc.mjs");
await build({
	stdin: { contents: 'export { SchedulerService, shouldPushScheduledResult, annotateLatePush } from "./src/scheduler/scheduler-service.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { SchedulerService, shouldPushScheduledResult } = await import(pathToFileURL(bundle).href);

function memoryStore() {
	const tasks = [];
	return {
		tasks,
		create(input) {
			const row = { id: input.id ?? `t${tasks.length + 1}`, enabled: 1, last_run_at: null, last_status: null, ...input };
			tasks.push(row);
			return row;
		},
		list: () => tasks,
		get: (id) => tasks.find((x) => x.id === id),
		setChainState() {},
		stageAnswer() {},
		listDue: (now) => tasks.filter((t) => t.enabled && t.next_run_at != null && t.next_run_at <= now),
		markRun(id, status, nextRunAt) {
			const t = tasks.find((x) => x.id === id);
			t.last_run_at = Date.now();
			t.last_status = status;
			t.next_run_at = nextRunAt;
		},
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a run that never settles is force-failed at the timeout and does NOT wedge the scheduler", async (t) => {
	const store = memoryStore();
	store.create({ id: "wedged", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	store.create({ id: "healthy", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	const ran = [];
	// The wedged run must stay UNSETTLED past the 50ms timeout (that is the whole
	// regression: a run that never settles used to hold the tick lock forever).
	// It still has to settle EVENTUALLY — a permanently-pending promise keeps a
	// handle node:test waits on at loop drain, which fails the whole file with
	// cancelledByParent (field 2026-10-13: this suite went red 5/5 runs on a clean
	// tree, blocking the release gate, with zero assertion failures). Settle it
	// long after the timeout so the race still loses, then clean up explicitly.
	const wedgedTimer = setTimeout(() => settleWedged && settleWedged(), 10_000);
	let settleWedged;
	t.after(() => { clearTimeout(wedgedTimer); settleWedged?.(); });
	const svc = new SchedulerService(store, 50); // 50ms test timeout
	svc.setRunner({
		async runTask(task) {
			ran.push(task.id);
			if (task.id === "wedged") {
				return new Promise((resolve) => {
					settleWedged = () => resolve({ status: "late" });
				});
			}
			return { status: "ok" };
		},
	});

	await svc.tick();

	const wedged = store.tasks.find((t) => t.id === "wedged");
	const healthy = store.tasks.find((t) => t.id === "healthy");
	assert.match(wedged.last_status, /^error:run_timeout:/, "the wedged run is recorded as timed out");
	assert.equal(healthy.last_status, "ok", "the NEXT task still ran — the tick was not wedged");
	assert.deepEqual(ran, ["wedged", "healthy"]);
});

test("a slow-but-completing run inside the timeout is recorded normally", async () => {
	const store = memoryStore();
	store.create({ id: "slow", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	const svc = new SchedulerService(store, 5_000);
	svc.setRunner({ async runTask() { await sleep(30); return { status: "ok" }; } });

	await svc.tick();

	assert.equal(store.tasks[0].last_status, "ok");
});

test("a run that rejects still records the error (unchanged semantics)", async () => {
	const store = memoryStore();
	store.create({ id: "boom", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	const svc = new SchedulerService(store, 5_000);
	svc.setRunner({ async runTask() { throw new Error("engine exploded"); } });

	await svc.tick();

	assert.match(store.tasks[0].last_status, /^error:engine exploded/);
});

test("overdue tasks run once each and next_run_at advances past the timeout's wall clock", async () => {
	const store = memoryStore();
	// Two missed occurrences: the catch-up policy is one run, not two.
	store.create({ id: "a", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 120_000 });
	const svc = new SchedulerService(store, 5_000);
	svc.setRunner({ async runTask() { return { status: "ok" }; } });

	await svc.tick();

	const a = store.tasks[0];
	assert.equal(a.last_status, "ok");
	assert.ok(a.next_run_at > Date.now(), "next occurrence is recomputed from now, not the past");
	// A second tick immediately after must not re-run it.
	await svc.tick();
	assert.equal(a.last_run_at != null && store.tasks.filter((t) => t.id === "a").length, 1);
});

// Autonomous chains paused for a human must NOT be re-fired by the cron tick —
// the chain's conversation carries all its progress, and a fresh fire would
// fork it. The tick records the skip and moves the schedule on.
test("a pending autonomous chain is skipped by the tick, not re-fired", async () => {
	const store = memoryStore();
	store.create({
		id: "paused", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000,
		autonomous: 1, max_turns: 20, max_minutes: 120,
		chain_state: JSON.stringify({ convId: "sched:paused:1", turns: 6, startedAt: Date.now() - 600_000, pending: "human", question: "账号?" }),
	});
	let fired = 0;
	const svc = new SchedulerService(store, 5_000);
	svc.setRunner({ async runTask() { fired += 1; return { status: "ok" }; } });

	await svc.tick();

	assert.equal(fired, 0, "the runner must not be called for a pending chain");
	assert.match(store.tasks[0].last_status, /paused:等待人工回复/);
	assert.ok(store.tasks[0].next_run_at > Date.now(), "schedule moved on");
});

// fireNow is the resume path: it fires regardless of cron time and shares the
// inFlight guard with the tick.
test("fireNow fires a task immediately and is guarded against overlap", async () => {
	const store = memoryStore();
	store.create({ id: "now", prompt: "x", cron: "0 9 * * *", next_run_at: Date.now() + 999_999_999 });
	const ran = [];
	const svc = new SchedulerService(store, 5_000);
	svc.setRunner({ async runTask(task) { ran.push(task.id); await sleep(20); return { status: "ok" }; } });

	assert.equal(svc.fireNow("missing"), false);
	assert.equal(svc.fireNow("now"), true, "fires despite a far-future cron");
	assert.equal(svc.fireNow("now"), false, "inFlight guard blocks overlap while running");
	await sleep(60);
	assert.deepEqual(ran, ["now"]);
	assert.equal(svc.fireNow("now"), true, "guard releases after the run settles");
});

// ── silent runs (2026-10-09): maintenance tasks run without pushing ──

test("shouldPushScheduledResult: silent + success = no push; everything else pushes", () => {
	assert.equal(shouldPushScheduledResult({ conversation_id: "dt:g1", silent: 1 }, undefined, "done"), false, "silent success stays quiet");
	assert.equal(shouldPushScheduledResult({ conversation_id: "dt:g1", silent: 1 }, "Connection error.", "done"), true, "a silent task's ERROR still pushes");
	assert.equal(shouldPushScheduledResult({ conversation_id: "dt:g1", silent: 0 }, undefined, "done"), true, "normal success pushes");
	assert.equal(shouldPushScheduledResult({ conversation_id: null, silent: 1 }, undefined, "done"), false, "no target never pushes");
	assert.equal(shouldPushScheduledResult({ conversation_id: "dt:g1", silent: 0 }, undefined, ""), false, "an empty reply never pushes");
});

test("a timed-out LOSING run holds the re-entrancy guard until it settles (no overlapping next occurrence)", async (t) => {
	const store = memoryStore();
	store.create({ id: "loser", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	const ran = [];
	let resolveLoser;
	const loser = new Promise((resolve) => { resolveLoser = resolve; });
	t.after(() => resolveLoser?.({ status: "late" })); // never leave a pending handle
	const svc = new SchedulerService(store, 50);
	svc.setRunner({
		async runTask(task) {
			ran.push(task.id);
			// Only the FIRST occurrence is the long-running loser; later
			// occurrences (after the loser settles) complete normally.
			if (task.id === "loser" && ran.length === 1) return loser;
			return { status: "ok" };
		},
	});

	await svc.tick(); // ~50ms: raced away, recorded as run_timeout — but the run is STILL executing
	assert.match(store.tasks[0].last_status, /^error:run_timeout:/);

	// The losing run is still executing: the next occurrence must be SKIPPED,
	// not started on top of it (its late push would race the next run's).
	// Note: this pins the guard itself, not wall-clock timing — in production
	// the guard must survive the real 60s tick boundary until the run settles,
	// which is exactly the release-on-settle seam (not a timer) in tick().
	store.tasks[0].next_run_at = Date.now() - 1000;
	await svc.tick();
	assert.deepEqual(ran, ["loser"], "the guard is held past the timeout");

	// Losing run settles → guard released → the task fires again normally.
	resolveLoser({ status: "late" });
	await sleep(30);
	store.tasks[0].next_run_at = Date.now() - 1000;
	await svc.tick();
	assert.deepEqual(ran, ["loser", "loser"], "the next occurrence runs after the loser settles");
	assert.equal(store.tasks[0].last_status, "ok");
});

test("runCtx.isTimedOut flips true once the timeout raced the run away (late-push annotation hook)", async (t) => {
	const store = memoryStore();
	store.create({ id: "late", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	let captured;
	let resolveRun;
	t.after(() => resolveRun?.({ status: "late" }));
	const svc = new SchedulerService(store, 50);
	svc.setRunner({
		async runTask(task, ctx) {
			captured = ctx;
			return new Promise((resolve) => { resolveRun = resolve; });
		},
	});

	await svc.tick(); // timeout fires at ~50ms
	assert.ok(captured, "the runner received a run ctx");
	assert.match(captured.runId, /^late:/, "runId = taskId:fireTimestamp");
	assert.equal(captured.isTimedOut(), true, "losing-run flag is visible to the runner");
	resolveRun({ status: "late" });
	await sleep(20);
});

test("annotateLatePush: only a losing run's push carries the 迟到结果 notice", async () => {
	const { annotateLatePush } = await import(pathToFileURL(bundle).href);
	const body = "⏰ **定时任务完成：日报**\n\n内容";
	assert.equal(annotateLatePush(body, false), body, "a normal run's push is untouched");
	const annotated = annotateLatePush(body, true);
	assert.ok(annotated.startsWith("⏱ **迟到结果**"), "the notice leads the message");
	assert.ok(annotated.endsWith(body), "the original body follows verbatim");
});

test("shouldPushScheduledResult: autonomous outcome mapping — only 'done' is silenceable", () => {
	// main.ts passes attention = outcome !== "done" ? outcome : undefined.
	const gate = (outcome, silent) => shouldPushScheduledResult(
		{ conversation_id: "dt:g1", silent },
		outcome === "done" ? undefined : outcome,
		"text",
	);
	assert.equal(gate("done", 1), false, "silent: done stays quiet");
	assert.equal(gate("done", 0), true, "non-silent: done pushes");
	for (const outcome of ["human", "budget", "stalled", "error"]) {
		assert.equal(gate(outcome, 1), true, `silent: ${outcome} still pushes (needs attention)`);
	}
});
