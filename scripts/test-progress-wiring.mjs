/**
 * Regression: "30-minute task progress never arrives" (field 2026-10-29, after
 * the box reinstalled v0.2.172).
 *
 * The notifier itself was fine — v0.2.171 shipped the work-window wiring and
 * v0.2.172 did not touch it. Both call sites gated on `agent.state.isStreaming`,
 * and since the durable kernel became the default (v0.2.167) VE drives the
 * harness directly: `pi-durable` never sets that flag (only pi-agent-core's own
 * prompt()/stream() do). So `isRunning()` was permanently false, every tick
 * returned early, and NOTHING was logged — a shipped feature looked absent.
 *
 * Pinned properties:
 *  1. a notifier built by the wiring module pushes while the run/window is
 *     alive, even though the session never reports isStreaming;
 *  2. the work target falls back to a `dt:` 1:1 with the creator (a bare staffId
 *     is not a conversation id, so pushing to it silently failed);
 *  3. every gate that drops a beat leaves a log line naming the reason.
 */
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.progress-wiring-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const bundle = join(dir, "wiring.mjs");
await build({
	stdin: {
		contents: `export * from "./src/scheduler/progress-wiring.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { createWorkProgressNotifier, createRunProgressNotifier, resolveWorkProgressTarget } = await import(pathToFileURL(bundle).href);

const INTERVAL_MIN = 5;
const INTERVAL = INTERVAL_MIN * 60_000;

function enableFakeClock() {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
}

/** Advance in interval-sized steps so async tick bodies settle between beats. */
async function advance(ms) {
	let remaining = ms;
	while (remaining > 0) {
		mock.timers.tick(Math.min(INTERVAL, remaining));
		for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
		remaining -= INTERVAL;
	}
}

test("a work window pushes progress even though the durable session never reports isStreaming", async (t) => {
	enableFakeClock();
	t.after(() => mock.timers.reset());
	// The exact shape the durable kernel exposes: no isStreaming, ever.
	const durableSession = { state: { messages: [], model: undefined } };
	const pushed = [];
	const logs = [];
	const notifier = createWorkProgressNotifier({
		item: { title: "对账长任务", origin_conversation: "dt:group:g1", created_by: "admin1" },
		session: durableSession,
		conversationId: "work:abc",
		intervalMin: INTERVAL_MIN,
		summarize: async () => ({ text: "已完成登录，正在导出", degraded: false }),
		push: async (cid, text) => { pushed.push([cid, text]); },
		log: (level, msg) => logs.push(`${level} ${msg}`),
	});
	notifier.start();
	await advance(INTERVAL * 2);
	notifier.stop();
	assert.equal(pushed.length, 2, "two beats must be pushed while the window is alive");
	assert.equal(pushed[0][0], "dt:group:g1", "the note goes back to the source conversation");
	assert.match(pushed[0][1], /对账长任务/, "the note names the task so a shared group can attribute it");
	assert.ok(!logs.some((l) => l.includes("skipped")), "nothing was skipped on the happy path");
});

test("a work item with no source conversation falls back to a dt: 1:1 with its creator", async (t) => {
	// The v0.2.171 wiring read origin_conversation only: every item created from
	// the console resolved target=null and every note was dropped AFTER paying for
	// the side LLM pass.
	assert.equal(resolveWorkProgressTarget({ origin_conversation: null, created_by: "staff42" }), "dt:staff42", "a bare staffId becomes a 1:1 conversation id");
	assert.equal(resolveWorkProgressTarget({ origin_conversation: "dt:group:g9", created_by: "staff42" }), "dt:group:g9", "the source conversation wins");
	assert.equal(resolveWorkProgressTarget({ origin_conversation: "  ", created_by: "dt:staff42" }), "dt:staff42", "an already-prefixed id is not double-prefixed");
	assert.equal(resolveWorkProgressTarget({ origin_conversation: null, created_by: null }), null, "no target at all");

	enableFakeClock();
	t.after(() => mock.timers.reset());
	const pushed = [];
	const notifier = createWorkProgressNotifier({
		item: { title: "控制台建的任务", origin_conversation: null, created_by: "staff42" },
		session: {},
		conversationId: "work:xyz",
		intervalMin: INTERVAL_MIN,
		summarize: async () => ({ text: "进行中", degraded: false }),
		push: async (cid, text) => { pushed.push([cid, text]); },
	});
	notifier.start();
	await advance(INTERVAL);
	notifier.stop();
	assert.equal(pushed.length, 1, "the creator's 1:1 receives the note");
	assert.equal(pushed[0][0], "dt:staff42");
});

test("a scheduled run pushes while its own lifetime flag is set, independent of the kernel flag", async (t) => {
	enableFakeClock();
	t.after(() => mock.timers.reset());
	const pushed = [];
	const logs = [];
	let alive = true;
	const notifier = createRunProgressNotifier({
		task: { title: "每日对账", conversation_id: "dt:group:g1", silent: 0 },
		intervalMin: INTERVAL_MIN,
		summarize: async () => ({ text: "第 2 步：核对差异", degraded: false }),
		push: async (cid, text) => { pushed.push([cid, text]); },
		isRunAlive: () => alive,
		isTimedOut: () => false,
		log: (level, msg) => logs.push(`${level} ${msg}`),
	});
	notifier.start();
	await advance(INTERVAL * 2);
	assert.equal(pushed.length, 2, "beats flow while the run is alive");
	alive = false;
	await advance(INTERVAL * 2);
	assert.equal(pushed.length, 2, "a settled run must not keep broadcasting");
	notifier.stop();
});

test("silent tasks and dead runs log WHY a beat was dropped", async (t) => {
	enableFakeClock();
	t.after(() => mock.timers.reset());
	const silentLogs = [];
	const silentNotifier = createRunProgressNotifier({
		task: { title: "静默任务", conversation_id: "dt:group:g1", silent: 1 },
		intervalMin: INTERVAL_MIN,
		summarize: async () => { throw new Error("summarize must not run for a silent task"); },
		push: async () => {},
		isRunAlive: () => true,
		isTimedOut: () => false,
		log: (level, msg) => silentLogs.push(`${level} ${msg}`),
	});
	silentNotifier.start();
	await advance(INTERVAL);
	silentNotifier.stop();
	assert.ok(silentLogs.some((l) => l.includes("preflight gate")), "a silent task logs the gate that blocked it");

	// A notifier that never gets a timer (no target) must SAY so: that silence is
	// what made a shipped feature look absent.
	const noTargetLogs = [];
	const noTarget = createRunProgressNotifier({
		task: { title: "无目标任务", conversation_id: null, silent: 0 },
		intervalMin: INTERVAL_MIN,
		summarize: async () => ({ text: "x", degraded: false }),
		push: async () => {},
		isRunAlive: () => true,
		isTimedOut: () => false,
		log: (level, msg) => noTargetLogs.push(`${level} ${msg}`),
	});
	noTarget.start();
	await advance(INTERVAL);
	noTarget.stop();
	assert.ok(noTargetLogs.some((l) => l.includes("not started") && l.includes("no push target")), "a notifier with no target logs that it never started");

	const deadLogs = [];
	const deadNotifier = createRunProgressNotifier({
		task: { title: "已结束", conversation_id: "dt:group:g1", silent: 0 },
		intervalMin: INTERVAL_MIN,
		summarize: async () => ({ text: "x", degraded: false }),
		push: async () => {},
		isRunAlive: () => false,
		isTimedOut: () => false,
		log: (level, msg) => deadLogs.push(`${level} ${msg}`),
	});
	deadNotifier.start();
	await advance(INTERVAL);
	deadNotifier.stop();
	assert.ok(deadLogs.some((l) => l.includes("no longer alive")), "a settled run logs why it stayed quiet — the exact silence that hid this bug");
});
