/**
 * Stall watchdog tests. Run with `npm run test:watchdog`.
 *
 * Field feedback 2026-09-17: the OLD watchdog aborted any turn older than 20
 * minutes — killing a healthy reconciliation task while the heartbeat was
 * literally reporting progress. The reworked watchdog measures SILENCE: the
 * timer only fires after `thresholdMs` with zero activity, so long-but-live
 * tasks are never killed and true wedges (hung socket / hung remote session)
 * still release the strict per-conversation queue.
 *
 * Pinned properties: activity keeps postponing the abort forever; crossing the
 * silence threshold aborts exactly once and disarms the timer; stop() disarms
 * without firing.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.watchdog-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "watchdog.mjs");
	await build({
		stdin: {
			contents: `export { startStallWatchdog, computeStallIdleMs } from "./src/im/watchdog.ts";`,
			resolveDir: root,
			loader: "ts",
		},
		outfile: bundle,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
	});
const { startStallWatchdog, computeStallIdleMs } = await import(pathToFileURL(bundle).href);

function harness(t) {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let now = 1_000_000;
	let lastActivity = now;
	const state = { aborts: 0 };
	const watchdog = startStallWatchdog({
		thresholdMs: 20 * 60_000,
		pollMs: 30_000,
		activityAgeMs: () => now - lastActivity,
		onStall: () => {
			state.aborts += 1;
		},
	});
	const advance = (ms, touchEvery = 0) => {
		const steps = Math.ceil(ms / 30_000);
		for (let i = 0; i < steps; i += 1) {
			now += 30_000;
			if (touchEvery > 0 && (i + 1) % touchEvery === 0) lastActivity = now;
			t.mock.timers.tick(30_000);
		}
	};
	return { watchdog, state, advance, touch: () => (lastActivity = now), setAge: (ms) => (lastActivity = now - ms) };
}

test("a live turn is never aborted, no matter how long it runs", (t) => {
	const h = harness(t);
	// 2 hours of continuous activity, touched every other poll (≈1 min).
	h.advance(120 * 60_000, 2);
	assert.equal(h.state.aborts, 0, "activity resets the silence clock — total time is irrelevant");
	h.watchdog.stop();
});

test("silence past the threshold aborts exactly once, then the timer disarms", (t) => {
	const h = harness(t);
	h.setAge(21 * 60_000); // silent longer than the threshold
	h.advance(31_000);
	assert.equal(h.state.aborts, 1, "crossing the silence threshold fires once");
	// Keep the (already aborted) turn silent for another hour — no repeat.
	h.advance(60 * 60_000);
	assert.equal(h.state.aborts, 1);
	assert.equal(h.watchdog.fired(), true);
	h.watchdog.stop();
});

test("silence just under the threshold does not abort", (t) => {
	const h = harness(t);
	h.setAge(19 * 60_000);
	h.advance(30_000); // one poll → age 19.5min, still under
	assert.equal(h.state.aborts, 0, "19:5x of silence is not yet a wedge");
	h.watchdog.stop();
});

test("stop() disarms without firing, even in deep silence", (t) => {
	const h = harness(t);
	h.setAge(60 * 60_000);
	h.watchdog.stop();
	h.advance(31_000);
	assert.equal(h.state.aborts, 0, "a stopped watchdog never fires");
});

// Field incident 2026-09-18: "有模型调用为什么还判断成卡死？" — v2 credited an
// in-flight LLM request only up to the request's OWN AGE (min(activityIdle,
// callAge)), so a healthy-but-silent long request (box raised
// requestTimeoutMin above the 20min watchdog threshold; slow relay, no stream
// deltas until the end) crossed the threshold mid-request and was killed.
// v3 semantics: in-flight = life, unconditionally — the request's own timeout
// is what bounds a dead call, never the watchdog.
test("computeStallIdleMs: an in-flight LLM request is life regardless of its age", () => {
	const now = 1_000_000_000;
	const activityAt = now - 40 * 60_000; // silent 40min by events
	assert.equal(computeStallIdleMs({ lastActivityAt: activityAt, llmInFlight: 1 }, now), 0,
		"in-flight request ⇒ alive, even when its age exceeds the threshold");
	assert.equal(computeStallIdleMs({ lastActivityAt: activityAt, llmInFlight: 3 }, now), 0,
		"several in-flight requests ⇒ alive");
	assert.equal(computeStallIdleMs({ lastActivityAt: activityAt, llmInFlight: 0 }, now), 40 * 60_000,
		"no in-flight request ⇒ silence is measured from real activity");
	assert.equal(computeStallIdleMs({ lastActivityAt: undefined, llmInFlight: 0 }, now), Number.MAX_SAFE_INTEGER,
		"never any activity ⇒ huge idle (fires on next poll)");
});
