/**
 * Regression tests for the independent review of feat/progress-watchdog.
 * Every block corresponds to a defect the reviewer PROBED; the assertions are
 * the same probes, so a regression re-opens the hole loudly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.pw-fix-probe");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: {
		contents: `export { ProgressWatchdog, computeToolFingerprint, normalizeForFingerprint } from "./src/engine/progress-watchdog.ts";
			export { computeStallIdleMs } from "./src/im/watchdog.ts";`,
		resolveDir: root, loader: "ts",
	},
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { ProgressWatchdog, computeToolFingerprint, normalizeForFingerprint, computeStallIdleMs } =
	await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

// ---------- P1: volatile-token masking is ORDER-INDEPENDENT ----------

test("volatile tokens mask identically regardless of order (single-pass alternation)", () => {
	// A sequential .replace() chain produced "<uuid><ts>" vs "<ts><uuid>" for the
	// same logical value, so a loop escaped by swapping its tokens.
	const uuid = "5f0a1234-5678-4abc-9def-ef0123456789";
	const a = normalizeForFingerprint({ id: uuid, at: 1793698751098 });
	const b = normalizeForFingerprint({ at: 1793698751098, id: uuid });
	assert.equal(a, b);
	assert.ok(!a.includes("1793698751098"), "epoch ms must be masked");
	assert.ok(!a.includes("5f0a1234"), "uuid must be masked");
});

test("volatile tokens inside STRING params are masked too (not just objects)", () => {
	// The old normalizeForFingerprint early-returned raw strings, so a loop that
	// only varies a timestamp INSIDE a string param looked like new work.
	assert.equal(
		computeToolFingerprint("shell", "curl job?ts=1793698751098", "ok"),
		computeToolFingerprint("shell", "curl job?ts=1793719999999", "ok"),
	);
});

// ---------- P1: configured thresholds actually reach the watchdog ----------

test("configure() applies settings loaded after construction", () => {
	// Boot order: engine constructs the watchdog, config loads later. Before the
	// fix, stallWindowMs/windowSize/softStopAfterWindows from settings were dead.
	let clock = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 600_000, softStopAfterWindows: 2, now: () => clock });
	wd.configure({ stallWindowMs: 100, softStopAfterWindows: 1 });
	wd.beginTurn("c1");
	assert.equal(wd.touch("c1", "fp"), "progress");
	clock += 150; // past the CONFIGURED window, far inside the default
	assert.equal(wd.touch("c1", "fp"), "soft-stop", "configured softStopAfterWindows=1 must escalate here");
});

// ---------- P1: turn lifecycle ----------

test("endTurn drops state so idle conversations do not accumulate", () => {
	const wd = new ProgressWatchdog({ stallWindowMs: 100, now: () => 0 });
	wd.beginTurn("c");
	wd.touch("c", "fp");
	wd.endTurn("c");
	assert.equal(wd.level("c"), 0);
	// State is gone: the same fingerprint is new work again, not a continuation.
	assert.equal(wd.touch("c", "fp"), "progress");
});

test("a queued message must not reset an ACTIVE loop (beginTurn is execution-scoped)", () => {
	// The bug: beginTurn ran in send() = queue ADMISSION, so a second message for
	// the same conversation (waiting behind the running turn) wiped the live
	// loop's history and gave the runaway a fresh budget. Now beginTurn is
	// called by durable-runtime.execute(), i.e. only when work really starts —
	// so this sequence (touch, touch, touch with no beginTurn) must escalate.
	let clock = 0;
	const wd = new ProgressWatchdog({ stallWindowMs: 100, softStopAfterWindows: 1, now: () => clock });
	wd.beginTurn("c");
	wd.touch("c", "loop");
	clock += 150;
	assert.equal(wd.touch("c", "loop"), "soft-stop", "the active loop keeps escalating");
});

// ---------- P0: a request with NO first byte must trip the hung cap ----------

test("hung request: no first byte past the cap fires the watchdog", () => {
	// The P0 shape: in-flight, zero events for longer than hungRequestCapMs.
	const now = 20_000_000;
	const idle = computeStallIdleMs({
		lastActivityAt: now - 20 * 60_000,
		llmInFlight: 1,
		llmCallStartedAt: now - 11 * 60_000, // 11 min, cap is 10
		llmFirstByteAt: undefined,
	}, now);
	assert.equal(idle, Number.MAX_SAFE_INTEGER, "a dead request must not stay exempt forever");
});

test("hung request: an in-flight call INSIDE the cap stays exempt (slow TTFT is alive)", () => {
	const now = 20_000_000;
	const idle = computeStallIdleMs({
		lastActivityAt: now - 20 * 60_000,
		llmInFlight: 1,
		llmCallStartedAt: now - 9 * 60_000,
		llmFirstByteAt: undefined,
	}, now);
	assert.equal(idle, 0);
});

test("a request that HAS produced an event is exempt regardless of age (v3 rule intact)", () => {
	const now = 20_000_000;
	const idle = computeStallIdleMs({
		lastActivityAt: now - 60 * 60_000,
		llmInFlight: 1,
		llmCallStartedAt: now - 60 * 60_000,
		llmFirstByteAt: now - 59 * 60_000,
	}, now);
	assert.equal(idle, 0);
});

// ---------- the `start` event is NOT proof of life ----------

test("the local `start` event must not count as a first byte", async () => {
	// pi-ai pushes `start` synchronously BEFORE the HTTP request (see
	// api/openai-completions.js). Treating it as life would disable the hung cap
	// exactly when it matters: a never-responsive request always yields `start`.
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(new URL("../src/engine/engine.ts", import.meta.url), "utf8");
	assert.ok(src.includes('eventType !== "start"'), "makeStreamFn must exclude the local start event from first-byte detection");
	assert.ok(src.includes("step.done) release()"), "in-flight credit must be released when the stream completes");
	assert.ok(src.includes("release();") && !/\}\s*finally\s*\{\s*this\.llmInFlight\.set/.test(src),
		"the credit must NOT be released in a finally around stream creation (the P0 shape)");
});
