/**
 * Progress watchdog (runaway-loop detection) + hung-request stall signals.
 *
 * Design constraint from the field (2026-11-03): NO hard step cap — 30
 * identical calls can be a dead loop, 100 different calls a healthy task. The
 * only lawful judgement is PROGRESS: a tool call whose fingerprint (tool +
 * normalized params + result digest) repeats forever is a loop; anything new
 * resets the escalation instantly.
 *
 * The hung-request half closes the other hole the same incident exposed: an
 * in-flight request was unconditionally exempt from the stall watchdog, so one
 * dead request blocked a serial queue until its own (30 min) timeout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.progress-probe");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: {
		contents: `export { ProgressWatchdog, computeToolFingerprint, normalizeForFingerprint, PROGRESS_WATCHDOG_DEFAULTS } from "./src/engine/progress-watchdog.ts";
			export { computeStallIdleMs, HUNG_REQUEST_CAP_MS } from "./src/im/watchdog.ts";`,
		resolveDir: root, loader: "ts",
	},
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { ProgressWatchdog, computeToolFingerprint, normalizeForFingerprint, computeStallIdleMs } =
	await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

const MIN = 60_000;

// ---------- fingerprint normalization ----------

test("timestamps/UUIDs/dates are normalized away (a loop must not re-roll itself clean)", () => {
	const a = computeToolFingerprint("browser_click", { selector: "#login", at: 1793698751098, id: "5f0a1234-5678-4abc-9def-ef0123456789" }, { ok: true });
	const b = computeToolFingerprint("browser_click", { selector: "#login", at: 1793719999999, id: "aaaa2222-3333-4bbb-8ccc-ccccddddeeee" }, { ok: true });
	assert.equal(a, b, "same call with fresh timestamp/uuid must fingerprint identical");
});

test("different params → different fingerprint (100 different calls stay progress)", () => {
	const fps = Array.from({ length: 100 }, (_, i) =>
		computeToolFingerprint("read_file", { path: `/data/row-${i}.csv` }, { content: `row ${i}` }));
	assert.equal(new Set(fps).size, 100, "each distinct call is its own fingerprint");
});

test("same params but CHANGED result counts as new (legal re-read progressed)", () => {
	const before = computeToolFingerprint("browser_read", { selector: "#status" }, { text: "pending" });
	const after = computeToolFingerprint("browser_read", { selector: "#status" }, { text: "done" });
	assert.notEqual(before, after);
});

test("key ORDER does not change the fingerprint", () => {
	assert.equal(
		computeToolFingerprint("t", { a: 1, b: 2 }, {}),
		computeToolFingerprint("t", { b: 2, a: 1 }, {}),
	);
});

test("identical error message throws fingerprint the same as identical results", () => {
	// The error path in withTelemetry passes err.message (a string), matching
	// the result digest shape of a tool that RETURNS the error text.
	const a = computeToolFingerprint("shell", { command: "python x.py" }, "连接超时");
	const b = computeToolFingerprint("shell", { command: "python x.py" }, "连接超时");
	assert.equal(a, b);
});

// ---------- escalation state machine ----------

function makeWatchdog(now = { v: 1_000_000 }) {
	const wd = new ProgressWatchdog({ stallWindowMs: 5 * MIN, windowSize: 32, softStopAfterWindows: 2, now: () => now.v });
	return { wd, now };
}

test("100 distinct calls never escalate (the core constraint)", () => {
	const { wd } = makeWatchdog();
	for (let i = 0; i < 100; i++) {
		const v = wd.touch("c1", `fp-${i}`);
		assert.equal(v, "progress", `call ${i} must be progress, got ${v}`);
	}
	assert.equal(wd.level("c1"), 0);
});

test("same fingerprint repeats: idle inside the window, nudge at it, soft-stop at the second", () => {
	const { wd, now } = makeWatchdog();
	wd.touch("c1", "fp");
	now.v += 2 * MIN;
	assert.equal(wd.touch("c1", "fp"), "idle");
	now.v += 4 * MIN; // > 5min since window opened
	assert.equal(wd.touch("c1", "fp"), "nudge");
	assert.equal(wd.level("c1"), 1);
	now.v += 6 * MIN;
	assert.equal(wd.touch("c1", "fp"), "soft-stop");
	assert.equal(wd.level("c1"), 2);
});

test("one NEW fingerprint after a nudge resets everything (a moving task is trusted)", () => {
	const { wd, now } = makeWatchdog();
	wd.touch("c1", "fp-a");
	now.v += 6 * MIN;
	assert.equal(wd.touch("c1", "fp-a"), "nudge");
	assert.equal(wd.touch("c1", "fp-b"), "progress");
	assert.equal(wd.level("c1"), 0);
	// And the clock restarted: the old fingerprint is still within the new window.
	now.v += 2 * MIN;
	assert.equal(wd.touch("c1", "fp-a"), "idle");
});

test("soft-stop re-fires every further stalled window (the abort may need retries)", () => {
	const { wd, now } = makeWatchdog();
	wd.touch("c1", "fp");
	now.v += 6 * MIN; assert.equal(wd.touch("c1", "fp"), "nudge");
	now.v += 6 * MIN; assert.equal(wd.touch("c1", "fp"), "soft-stop");
	now.v += 6 * MIN; assert.equal(wd.touch("c1", "fp"), "soft-stop");
});

test("beginTurn clears the conversation's history", () => {
	const { wd, now } = makeWatchdog();
	wd.touch("c1", "fp-a");
	wd.beginTurn("c1");
	now.v += 30 * MIN;
	assert.equal(wd.touch("c1", "fp-a"), "progress", "fresh turn starts clean");
});

test("two alternating fingerprints still stall (rotation is not progress)", () => {
	const { wd, now } = makeWatchdog();
	now.v += 0; wd.touch("c1", "x"); wd.touch("c1", "y");
	now.v += 6 * MIN;
	assert.equal(wd.touch("c1", "x"), "nudge", "alternating repeats are still a loop");
});

test("a wheel of >windowSize distinct fingerprints defeats detection (documented limit)", () => {
	// windowSize 32: 33+ rotating fingerprints look like progress. This is the
	// accepted false-negative boundary of a bounded memory — cheap tokens each.
	const { wd } = makeWatchdog();
	for (let i = 0; i < 33; i++) assert.equal(wd.touch("c1", `fp-${i}`), "progress");
	// fp-0 was evicted → counts as new again.
	assert.equal(wd.touch("c1", "fp-0"), "progress");
});

// ---------- hung request (stall watchdog integration) ----------

const base = { lastActivityAt: 0 };

test("in-flight WITH a first event stays exempt however old (v3 semantics kept)", () => {
	const idle = computeStallIdleMs({ ...base, llmInFlight: 1, llmCallStartedAt: -30 * MIN, llmFirstByteAt: -29 * MIN }, 0);
	assert.equal(idle, 0);
});

test("in-flight WITHOUT a first event inside the cap is still exempt (slow TTFT is alive)", () => {
	const idle = computeStallIdleMs({ ...base, llmInFlight: 1, llmCallStartedAt: -9 * MIN }, 0);
	assert.equal(idle, 0);
});

test("in-flight with NO first event past the cap fires immediately (the field incident)", () => {
	// Request started 11 min ago, never a single event, activity stale even
	// longer — the 2026-11-03 shape that held a queue for its full 30 min timeout.
	const idle = computeStallIdleMs(
		{ lastActivityAt: -12 * MIN, llmInFlight: 1, llmCallStartedAt: -11 * MIN },
		0,
	);
	assert.equal(idle, Number.MAX_SAFE_INTEGER, "hung request must trip the watchdog now");
});

test("the cap is configurable (hungRequestCapMs)", () => {
	const idle = computeStallIdleMs({ ...base, llmInFlight: 1, llmCallStartedAt: -3 * MIN, hungRequestCapMs: 2 * MIN }, 0);
	assert.equal(idle, Number.MAX_SAFE_INTEGER);
});

test("no in-flight requests: unchanged behaviour", () => {
	assert.equal(computeStallIdleMs({ lastActivityAt: -5 * MIN, llmInFlight: 0 }, 0), 5 * MIN);
	assert.equal(computeStallIdleMs({ llmInFlight: 0 }, 0), Number.MAX_SAFE_INTEGER);
});


// ---------- background-process deferral (field 2026-11-06: b605b244) ----------

test("a running background process defers the soft-stop instead of aborting a legal wait", () => {
	let t = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 5 * MIN, softStopAfterWindows: 2, now: () => t });
	const opts = { hasRunningBackground: true };
	assert.equal(wd.touch("c", "fp", opts), "progress"); // first sight = new fingerprint
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp", opts), "nudge", "L1 still fires (observation is cheap)");
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp", opts), "deferred", "L2 must NOT soft-stop while a background process runs");
	assert.equal(wd.level("c"), 2, "level stays capped so the next window re-judges");
});

test("deferral is capped: after maxDeferrals the soft-stop still fires (zombie guard)", () => {
	let t = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 5 * MIN, softStopAfterWindows: 2, maxDeferrals: 3, now: () => t });
	const opts = { hasRunningBackground: true };
	wd.touch("c", "fp", opts);
	for (let i = 0; i < 3; i++) {
		t += 6 * MIN;
		assert.equal(wd.touch("c", "fp", opts), i === 0 ? "nudge" : "deferred");
	}
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp", opts), "deferred", "3rd deferral still allowed");
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp", opts), "soft-stop", "4th stalled window past the cap must soft-stop even with a running process");
});

test("new fingerprint after a deferral resets the deferral budget instantly", () => {
	let t = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 5 * MIN, softStopAfterWindows: 2, maxDeferrals: 1, now: () => t });
	const opts = { hasRunningBackground: true };
	wd.touch("c", "fp", opts);
	t += 6 * MIN; wd.touch("c", "fp", opts); // nudge
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp", opts), "deferred"); // budget spent (max 1)
	// Real progress arrives: the script finished and produced new output.
	assert.equal(wd.touch("c", "fp2", opts), "progress");
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp2", opts), "nudge", "fresh window after progress");
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp2", opts), "deferred", "deferral budget was reset by the new fingerprint");
});

test("without a running background process the original escalation is unchanged", () => {
	let t = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 5 * MIN, softStopAfterWindows: 2, now: () => t });
	wd.touch("c", "fp");
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp"), "nudge");
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp"), "soft-stop", "no background process -> no deferral");
});

test("opts omitted entirely behaves exactly like the legacy signature", () => {
	let t = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 5 * MIN, softStopAfterWindows: 2, now: () => t });
	wd.touch("c", "fp");
	t += 6 * MIN; wd.touch("c", "fp");
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp"), "soft-stop");
});


// ---------- review P3: three boundary pins ----------

test("hasRunningBackground: false (explicit) must NOT defer", () => {
	let t = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 5 * MIN, softStopAfterWindows: 2, now: () => t });
	wd.touch("c", "fp", { hasRunningBackground: false });
	t += 6 * MIN; wd.touch("c", "fp", { hasRunningBackground: false });
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp", { hasRunningBackground: false }), "soft-stop", "explicit false is not 'has background'");
});

test("a deferred window re-judges only after a FULL new window (windowStart reset)", () => {
	let t = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 5 * MIN, softStopAfterWindows: 2, maxDeferrals: 3, now: () => t });
	const opts = { hasRunningBackground: true };
	wd.touch("c", "fp", opts);
	t += 6 * MIN; wd.touch("c", "fp", opts); // nudge
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp", opts), "deferred");
	// Immediately after the deferral the SAME fingerprint must be idle, not a
	// second deferral — otherwise rapid polls burn the whole budget at once.
	t += 1000;
	assert.equal(wd.touch("c", "fp", opts), "idle", "within the fresh window: idle, no budget spent");
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp", opts), "deferred", "next full window re-judges");
});

test("configure({ maxDeferrals }) applies at runtime (0 disables, 5 extends)", () => {
	let t = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 5 * MIN, softStopAfterWindows: 2, now: () => t });
	const opts = { hasRunningBackground: true };
	wd.configure({ maxDeferrals: 0 });
	wd.touch("c", "fp", opts);
	t += 6 * MIN; wd.touch("c", "fp", opts);
	t += 6 * MIN;
	assert.equal(wd.touch("c", "fp", opts), "soft-stop", "maxDeferrals=0 disables deferral");

	// fresh conversation, runtime-raised budget
	wd.configure({ maxDeferrals: 5 });
	wd.touch("d", "fp", opts);
	let deferred = 0;
	for (let i = 0; i < 6; i++) {
		t += 6 * MIN;
		if (wd.touch("d", "fp", opts) === "deferred") deferred++;
	}
	assert.equal(deferred, 5, "exactly 5 deferrals after configure({maxDeferrals:5})");
});
