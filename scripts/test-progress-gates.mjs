/**
 * Task-progress notes: the three field failure shapes, as permanent probes.
 *
 * 1. A scheduled run past the scheduler's 60-min bookkeeping timeout used to be
 *    silenced for its ENTIRE overhang (suppress = isTimedOut) — the box showed
 *    a 72-minute run that finished "ok" with zero notes (field 2026-11-03).
 *    Now overdue runs keep narrating, annotated 「已超调度器时限仍在执行」.
 * 2. Work-window (chat task) notes must flow — no timeout gate on that path.
 * 3. A degraded (fallback) summarizer must cap its generic pushes and log its
 *    backoff — the 11-02 "token cap" failure shape.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.progress-gate-test");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: {
		contents: `
			export { createProgressNotifier } from "./src/scheduler/progress-notify.ts";
			export { createRunProgressNotifier, createWorkProgressNotifier } from "./src/scheduler/progress-wiring.ts";
		`,
		resolveDir: root, loader: "ts",
	},
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const m = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

/** Advance the notifier's interval clock and let the async tick settle. */
async function beat(t, n = 1) {
	for (let i = 0; i < n; i++) {
		t.mock.timers.tick(5 * 60_000);
		await new Promise((r) => setTimeout(r, 5));
		await new Promise((r) => setImmediate(r));
	}
}

test("an overdue scheduled run keeps narrating, annotated — never silent", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const pushed = [];
	const logs = [];
	let timedOut = false;
	const notifier = m.createRunProgressNotifier({
		task: { title: "LiteLLM 每日对账检查", conversation_id: "dt:group:x", silent: 0 },
		intervalMin: 5,
		summarize: async () => ({ text: "已完成：拉取 3 页账单；剩余：汇总；正在：核对；卡点：暂无", degraded: false }),
		push: async (_cid, text) => { pushed.push(text); },
		isRunAlive: () => true,
		isTimedOut: () => timedOut,
		log: (lvl, msg) => logs.push(`${lvl} ${msg}`),
	});
	notifier.start();
	await beat(t, 2);
	const before = pushed.length;
	timedOut = true; // scheduler recorded the timeout; the run keeps working
	await beat(t, 2);
	notifier.stop();

	assert.ok(before > 0, "inside the run timeout notes must flow");
	const after = pushed.slice(before);
	assert.ok(after.length >= 1, "the overhang MUST keep narrating (field 2026-11-03: 72-min run, zero notes)");
	assert.ok(after.every((n) => n.includes("已超过调度器时限")), "overdue notes must say so explicitly");
	assert.ok(after.every((n) => n.includes("仍在执行")), "overdue notes must clarify the run is alive");
});

test("a settled run stops narrating (runAlive is the only lifetime gate)", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const pushed = [];
	let alive = true;
	const notifier = m.createRunProgressNotifier({
		task: { title: "t", conversation_id: "dt:g", silent: 0 },
		intervalMin: 5,
		summarize: async () => ({ text: "已完成：x；剩余：y；正在：z；卡点：无", degraded: false }),
		push: async (_cid, text) => { pushed.push(text); },
		isRunAlive: () => alive,
		isTimedOut: () => true,
		log: () => {},
	});
	notifier.start();
	await beat(t, 1);
	const n = pushed.length;
	alive = false; // the run settled
	await beat(t, 2);
	notifier.stop();
	assert.equal(pushed.length, n, "no notes after the run settles");
});

test("work-window (chat task) notes flow — no timeout gate on that path", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const pushed = [];
	const notifier = m.createWorkProgressNotifier({
		item: { title: "群内长任务", origin_conversation: "dt:group:y" },
		session: {},
		conversationId: "dt:group:y",
		intervalMin: 5,
		summarize: async () => ({ text: "已完成：x；剩余：y；正在：z；卡点：无", degraded: false }),
		push: async (_cid, text) => { pushed.push(text); },
		log: () => {},
	});
	notifier.start();
	await beat(t, 2);
	notifier.stop();
	assert.ok(pushed.length > 0, "work-window notes must flow");
});

test("a degraded summarizer caps generic pushes at two and logs its backoff", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const logs = [];
	const pushed = [];
	const notifier = m.createProgressNotifier({
		title: "t", target: "dt:group:z", intervalMin: 5,
		summarize: async () => ({ text: "已完成：暂未确认；剩余：暂未确认；正在：暂未确认；卡点：暂未确认", degraded: true }),
		push: async (_cid, text) => { pushed.push(text); },
		isRunning: () => true,
		log: (lvl, msg) => logs.push(`${lvl} ${msg}`),
	});
	notifier.start();
	await beat(t, 4);
	notifier.stop();
	assert.ok(logs.some((l) => l.includes("backing off")), "degraded streak must log its backoff");
	assert.ok(pushed.length <= 2, "degraded pushes are capped at two generic lines");
});
