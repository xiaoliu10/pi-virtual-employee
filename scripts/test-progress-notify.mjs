/**
 * ProgressNotifier (2026-10-27): long single-shot scheduled runs stream for up
 * to the 60-minute hard timeout with zero feedback until the final report
 * lands. The broadcaster pushes side-LLM progress notes every
 * longTaskProgressMin; these tests pin its gates (silent/no-target/timed-out),
 * the stale-snapshot drop, degraded backoff, re-entry, and cleanup.
 */
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.progress-notify-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const bundle = join(dir, "pn.mjs");
await build({
	stdin: {
		contents: `export { createProgressNotifier, normalizeProgressIntervalMin } from "./src/scheduler/progress-notify.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { createProgressNotifier, normalizeProgressIntervalMin } = await import(pathToFileURL(bundle).href);

const INTERVAL = 5 * 60_000;

/** Harness with mocked timers: start() then advance, flushing microtasks so
 *  async summarize/push chains settle deterministically before assertions. */
function make(overrides = {}) {
	const calls = { summarize: 0, push: 0 };
	const opts = {
		title: "对账任务",
		target: "dt:group:g1",
		intervalMin: 5,
		summarize: async () => {
			calls.summarize += 1;
			return { text: "⏳ 任务仍在进行中。已完成：登录。剩余：导出。正在：查询。卡点：无", degraded: false };
		},
		push: async () => {
			calls.push += 1;
			return { ok: true };
		},
		isRunning: () => true,
		...overrides,
	};
	const notifier = createProgressNotifier(opts);
	return { notifier, calls, opts };
}

/**
 * Advance the mocked clock and let every pending async chain settle.
 *
 * Long advances are split into interval-sized steps with a flush between them:
 * tick(N*interval) fires N interval callbacks SYNCHRONOUSLY, and the async
 * tick() body cannot settle in between — the inFlight guard (correctly) drops
 * callbacks 2..N, which is not the production rhythm (real intervals are
 * minutes apart, the side pass settles in seconds).
 */
async function advance(ms) {
	let remaining = ms;
	while (remaining > 0) {
		const step = Math.min(INTERVAL, remaining);
		mock.timers.tick(step);
		for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
		remaining -= step;
	}
}

test("interval 0 (disabled) never summarizes and never pushes", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const { notifier, calls } = make({ intervalMin: 0 });
	notifier.start();
	await advance(INTERVAL * 10);
	assert.equal(calls.summarize, 0);
	assert.equal(calls.push, 0);
	notifier.stop();
	mock.timers.reset();
});

test("a settled run is not broadcast to (isRunning false)", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const { notifier, calls } = make({ isRunning: () => false });
	notifier.start();
	await advance(INTERVAL * 3);
	assert.equal(calls.summarize, 0, "no side LLM call for a settled run");
	assert.equal(calls.push, 0);
	notifier.stop();
	mock.timers.reset();
});

test("a normal tick summarizes once and pushes a ⏳-prefixed note", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let pushedText = "";
	const { notifier, calls } = make({ push: async (_cid, text) => { calls.push += 1; pushedText = text; return { ok: true }; } });
	notifier.start();
	await advance(INTERVAL);
	assert.equal(calls.summarize, 1);
	assert.equal(calls.push, 1);
	assert.ok(pushedText.startsWith("⏳"), `note must be ⏳-prefixed, got ${pushedText.slice(0, 20)}`);
	notifier.stop();
	mock.timers.reset();
});

test("a note already carrying ⏳ is not double-prefixed (v0.2.109 regression)", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let pushedText = "";
	const { notifier } = make({
		summarize: async () => ({ text: "⏳ 任务仍在进行中。已完成：a", degraded: false }),
		push: async (_cid, text) => { pushedText = text; return { ok: true }; },
	});
	notifier.start();
	await advance(INTERVAL);
	assert.equal(pushedText.split("⏳").length - 1, 1, `exactly one ⏳, got: ${pushedText.slice(0, 30)}`);
	notifier.stop();
	mock.timers.reset();
});

test("a tick while the previous side pass is still in flight is dropped (no overlap)", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let release;
	const { notifier, calls } = make({
		summarize: () => { calls.summarize += 1; return new Promise((r) => { release = () => r({ text: "⏳ x", degraded: false }); }); },
	});
	notifier.start();
	await advance(INTERVAL); // first tick: summarize starts, hangs
	assert.equal(calls.summarize, 1);
	await advance(INTERVAL); // second tick while in flight: must be a no-op
	release();
	await advance(0);
	assert.equal(calls.summarize, 1, "no second summarize while in flight");
	assert.equal(calls.push, 1);
	notifier.stop();
	mock.timers.reset();
});

test("a stale snapshot (run settled mid-summarize) is dropped, not pushed", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let release;
	let running = true;
	const { notifier, calls } = make({
		isRunning: () => running,
		summarize: () => { calls.summarize += 1; return new Promise((r) => { release = () => r({ text: "⏳ x", degraded: false }); }); },
	});
	notifier.start();
	await advance(INTERVAL);
	running = false; // the run settles WHILE the side pass is in flight
	release();
	await advance(0);
	assert.equal(calls.push, 0, "a stale note must never race the completion push");
	notifier.stop();
	mock.timers.reset();
});

test("degraded fallbacks back off after 2 in a row; a healthy note resets", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let degraded = true;
	const { notifier, calls } = make({
		summarize: async () => { calls.summarize += 1; return { text: "已完成：暂未确认", degraded }; },
	});
	notifier.start();
	await advance(INTERVAL); // degraded #1: still pushes
	assert.equal(calls.push, 1);
	await advance(INTERVAL); // degraded #2: pushes, arms backoff
	assert.equal(calls.push, 2);
	await advance(INTERVAL); // inside backoff: skipped
	assert.equal(calls.summarize, 2, "backoff suppresses the side LLM call too");
	await advance(INTERVAL * 2); // backoff window (2x interval) elapses → degraded #3
	assert.ok(calls.summarize >= 3);
	// Relay recovers: a healthy note resets the streak.
	degraded = false;
	await advance(INTERVAL * 4); // beyond any accumulated backoff
	const after = calls.summarize;
	await advance(INTERVAL);
	assert.ok(calls.summarize > after, "healthy relay resumes broadcasting");
	await advance(INTERVAL);
	assert.ok(calls.summarize > after, "and keeps going (streak reset)");
	notifier.stop();
	mock.timers.reset();
});

test("stop() silences every later tick", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const { notifier, calls } = make();
	notifier.start();
	await advance(INTERVAL);
	assert.equal(calls.push, 1);
	notifier.stop();
	await advance(INTERVAL * 5);
	assert.equal(calls.push, 1, "no pushes after stop");
	assert.equal(calls.summarize, 1, "no side LLM calls after stop");
});

test("mayPush=false (silent task) still summarizes but never pushes", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const { notifier, calls } = make({ mayPush: () => false });
	notifier.start();
	await advance(INTERVAL);
	assert.equal(calls.summarize, 1);
	assert.equal(calls.push, 0, "silent stays silent");
	notifier.stop();
	mock.timers.reset();
});

test("a null target makes start() a no-op", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const { notifier, calls } = make({ target: null });
	notifier.start();
	await advance(INTERVAL * 3);
	assert.equal(calls.summarize, 0, "no side LLM burn for an unpushable run");
	notifier.stop();
	mock.timers.reset();
});

test("suppress() (timed-out losing run) skips ticks entirely", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const { notifier, calls } = make({ suppress: () => true });
	notifier.start();
	await advance(INTERVAL * 2);
	assert.equal(calls.summarize, 0, "a recorded failure must not be contradicted by progress notes");
	assert.equal(calls.push, 0);
	notifier.stop();
	mock.timers.reset();
});

test("a failing push never kills the timer", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let n = 0;
	const { notifier, calls } = make({
		push: async () => { calls.push += 1; n += 1; if (n === 1) throw new Error("dingtalk down"); return { ok: true }; },
	});
	notifier.start();
	await advance(INTERVAL);
	await advance(INTERVAL);
	assert.equal(calls.push, 2, "the second tick pushes normally after a failed first");
	notifier.stop();
	mock.timers.reset();
});

test("pushes are capped per run (maxPushes)", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const { notifier, calls } = make({ maxPushes: 3 });
	notifier.start();
	await advance(INTERVAL * 6);
	assert.equal(calls.push, 3, `capped at 3, got ${calls.push}`);
	notifier.stop();
	mock.timers.reset();
});

test("a throwing summarize is swallowed (no unhandled rejection, timer alive)", async (t) => {
	// Reset first: a prior test that forgot reset() must not fail this one with
	// "MockTimers is already enabled" — the leak would otherwise cascade.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let n = 0;
	const { notifier, calls } = make({
		summarize: async () => {
			calls.summarize += 1;
			n += 1;
			if (n === 1) throw new Error("boom");
			return { text: "⏳ ok", degraded: false };
		},
	});
	notifier.start();
	await advance(INTERVAL); // throws inside tick
	await advance(INTERVAL); // timer must still be alive
	assert.equal(calls.summarize, 2);
	assert.equal(calls.push, 1);
	notifier.stop();
	mock.timers.reset();
});

test("normalizeProgressIntervalMin: 0 disables, sub-5 clamps up, negatives disable", () => {
	assert.equal(normalizeProgressIntervalMin(0), 0);
	assert.equal(normalizeProgressIntervalMin(-3), 0);
	assert.equal(normalizeProgressIntervalMin(undefined), 0);
	assert.equal(normalizeProgressIntervalMin(1), 5);
	assert.equal(normalizeProgressIntervalMin(4), 5);
	assert.equal(normalizeProgressIntervalMin(15), 15);
});

test("R: a note names its task (two tasks sharing a chat are distinguishable)", async (t) => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let pushedText = "";
	const { notifier } = make({
		push: async (_cid, text) => { pushedText = text; return { ok: true }; },
	});
	notifier.start();
	await advance(INTERVAL);
	assert.ok(pushedText.includes("**对账任务**"), `the note must carry the task title, got ${pushedText.slice(0, 40)}`);
	assert.equal(pushedText.split("⏳").length - 1, 1, "exactly one ⏳");
	notifier.stop();
	mock.timers.reset();
});

test("R: suppress flipping mid-summarize still blocks the push (review P2-2)", async (t) => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let release;
	let timedOut = false;
	const { notifier, calls } = make({
		suppress: () => timedOut,
		summarize: () => { calls.summarize += 1; return new Promise((r) => { release = () => r({ text: "⏳ late-run progress", degraded: false }); }); },
	});
	notifier.start();
	await advance(INTERVAL); // tick enters, summarize hangs
	assert.equal(calls.summarize, 1);
	timedOut = true; // the 60min deadline fires WHILE the side pass is in flight
	release();
	await advance(0);
	assert.equal(calls.push, 0, "a losing run must not broadcast after the scheduler recorded its failure");
	notifier.stop();
	mock.timers.reset();
});

test("R: preflight=false (silent task) never even calls summarize (review P3-1)", async (t) => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const { notifier, calls } = make({ preflight: () => false });
	notifier.start();
	await advance(INTERVAL * 3);
	assert.equal(calls.summarize, 0, "an unpunnable run must not burn a side LLM call per interval");
	assert.equal(calls.push, 0);
	notifier.stop();
	mock.timers.reset();
});

test("R: drain resolves only after the in-flight push settles (review P2-1)", async (t) => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let release;
	const { notifier } = make({
		push: () => new Promise((r) => { release = () => r({ ok: true }); }),
	});
	notifier.start();
	await advance(INTERVAL); // push starts, hangs on the wire
	let drained = false;
	const draining = notifier.drain(60_000).then(() => { drained = true; });
	await new Promise((r) => setImmediate(r));
	assert.equal(drained, false, "drain must wait while the push is on the wire");
	release();
	await draining;
	assert.equal(drained, true, "drain resolves once the push settles");
	notifier.stop();
	mock.timers.reset();
});

// Field 2026-11-06 (box Nova): an 85-minute work window produced ZERO progress
// notes and ZERO log lines. Three silence holes made "did the notifier even
// fire?" unanswerable: timer install, degraded-first-push, and successful push
// all ran without a trace. Every one of them must now log.
test("notifier lifecycle leaves log traces: start, degraded first push, successful push", async () => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	try {
		const logs = [];
		const h = make({
			log: (level, msg) => logs.push(`${level} ${msg}`),
			summarize: async () => ({ text: "⏳ 任务仍在进行中。已完成：登录。剩余：导出。正在：查询。卡点：无", degraded: true }),
		});
		h.notifier.start();
		assert.ok(logs.some((l) => l.startsWith("INFO progress notifier started: interval=5min target=dt:group:g1")),
			"timer install must be logged (with interval + target)");
		await advance(INTERVAL * 1.2);   // first tick: degraded push #1
		assert.equal(h.calls.push, 1);
		assert.ok(logs.some((l) => l === "INFO progress brief degraded (side LLM unavailable) — pushing the deterministic fallback"),
			"first degraded push must say WHY it degraded");
		assert.ok(logs.some((l) => l.startsWith("INFO progress pushed #1 to dt:group:g1")),
			"a delivered beat must leave exactly one trace line");
		h.notifier.stop();
	} finally {
		mock.timers.reset();
	}
});

test("guard branches still log (no-target / disabled interval)", async () => {
	const logs = [];
	const h = make({ target: null, log: (level, msg) => logs.push(`${level} ${msg}`) });
	h.notifier.start();
	assert.ok(logs.some((l) => l.includes("no push target")), "no-target guard keeps its log");
	const h2 = make({ intervalMin: 0, log: (level, msg) => logs.push(`${level} ${msg}`) });
	h2.notifier.start();
	assert.ok(logs.some((l) => l.includes("interval disabled")), "disabled-interval guard keeps its log");
});

test("no early first beat — the first note waits the FULL interval", async (t) => {
	// User ruling 2026-11-11: the 2-minute first beat (v0.2.217) was noise —
	// at T+2 a task has no evidenced progress (a 「暂未确认」 shell at best)
	// and field feedback is that notes this early read as too frequent. The
	// first note now waits the full configured interval; short tasks deliver
	// their final result with no interim note.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	try {
		const logs = [];
		const h = make({ log: (level, msg) => logs.push(`${level} ${msg}`) });
		h.notifier.start();
		assert.ok(!logs.some((l) => l.includes("first-beat")),
			"started log must NOT announce any early first beat");
		await advance(2 * 60_000);   // the old FIRST_BEAT_MS point: must stay SILENT
		assert.equal(h.calls.summarize, 0, "no beat at the old +2min mark");
		assert.equal(h.calls.push, 0);
		await advance(INTERVAL - 2 * 60_000); // reach the full interval
		assert.equal(h.calls.summarize, 1, "the first beat is the full interval in");
		assert.equal(h.calls.push, 1);
		await advance(INTERVAL);     // steady cadence unchanged
		assert.equal(h.calls.summarize, 2, "steady cadence is the configured interval");
		assert.equal(h.calls.push, 2);
		h.notifier.stop();
	} finally {
		mock.timers.reset();
	}
});

test("liveness gate still applies to the first full-interval tick", async (t) => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	try {
		const h = make({ isRunning: () => false });
		h.notifier.start();
		await advance(INTERVAL);
		assert.equal(h.calls.summarize, 0, "liveness gate still applies");
		assert.equal(h.calls.push, 0);
		h.notifier.stop();
	} finally {
		mock.timers.reset();
	}
});

test("degraded backoff window logs its skip (no silent beats)", async (t) => {
	// v0.2.173 rule: a gate that drops a beat must say so. The backoff return
	// was the last silent gate — the 60-min degraded window looked dead.
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	try {
		const logs = [];
		const h = make({
			log: (level, msg) => logs.push(`${level} ${msg}`),
			summarize: async () => ({ text: "⏳ 任务仍在进行中。已完成：登录。剩余：导出。正在：查询。卡点：无", degraded: true }),
		});
		h.notifier.start();
		await advance(INTERVAL * 1.2);   // beat #1: degraded push + streak=1
		assert.equal(h.calls.push, 1);
		// streak=2 enters backoff (2×interval). Next tick must log the skip.
		await advance(INTERVAL * 2);
		assert.ok(logs.some((l) => l.includes("progress tick skipped: degraded backoff window")),
			"backoff skips must leave a trace line");
		h.notifier.stop();
	} finally {
		mock.timers.reset();
	}
});
