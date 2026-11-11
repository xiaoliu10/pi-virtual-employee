/**
 * Legacy settle-gate tests — the engine-layer equivalent of the pi-session
 * ve-settle-gate extension. The gate is a pure orchestrator over an injected
 * `drive` (one extra model turn), so the whole state machine is testable
 * without an Agent SDK.
 *
 * Integration pins (review 3ff3d67d): the gated reply is fed through the REAL
 * scheduler graders (work.ts parseWindowReply, autonomous.ts parseChainReply)
 * because legacy — unlike durable — grades completion by marker lines. A gate
 * that strips [[TASK_DONE]] turns a verified task into an endless
 * re-declare/re-verify window (P0-1), and a per-conversation streak releases
 * an independent later run after ONE failed round (P1-1).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.legacy-gate-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "legacy-gate.mjs");
await build({
	stdin: {
		contents: `
			export * from "./src/engine/legacy-settle-gate.ts";
			export { parseWindowReply } from "./src/scheduler/work.ts";
			export { parseChainReply } from "./src/scheduler/autonomous.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { LegacySettleGate, legacyGateEligible, releaseReply, VERIFY_GIVE_UP, parseWindowReply, parseChainReply } =
	await import(pathToFileURL(bundle).href);

// Marker protocol: verdict markers must start their own LINE (parseVerifyReply
// scans line-starts), exactly as the prompts instruct the model to write them.
const DONE = "已完成：spay 近 7 天对账异常全部处理完毕，明细见报告\n[[TASK_DONE]]";
const PASS = "已用工具复核：最近 7 天异常清单为空，处理记录 12 条\n[[VERIFY_PASS]]";
const FAIL = "目标未达成\n[[VERIFY_FAIL]]: 堡垒机掉登录，无法核实";
const REPAIR_OUT = "收到，正在修复登录态并重新核查";

/** Scripted drive: pops the next queued turn result; throws on an extra call
 * (so every test also pins the drive bound — no unbounded loops). */
function scriptedDrive(turns) {
	const calls = [];
	return {
		calls,
		drive: async (instruction) => {
			calls.push(instruction);
			const next = turns.shift();
			if (!next) throw new Error("unexpected extra drive call");
			return next;
		},
	};
}

const runGate = (gate, d, reply = DONE, conversationId = "work:item-1") =>
	gate.run({ conversationId, reply, enabled: true, drive: d.drive });

test("ordinary IM replies (no TASK_DONE marker) never enter the gate", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([]);
	const r = await runGate(gate, d, "这是普通聊天回复");
	assert.equal(r.reply, "这是普通聊天回复");
	assert.equal(r.verifyRounds, 0);
	assert.equal(r.releasedAtCap, false);
	assert.equal(d.calls.length, 0, "no extra model turn");
});

test("disabled gate is a pure pass-through", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([]);
	const r = await gate.run({ conversationId: "work:item-1", reply: DONE, enabled: false, drive: d.drive });
	assert.equal(r.reply, DONE);
	assert.equal(d.calls.length, 0);
});

test("PASS with tool evidence passes the ORIGINAL done claim through (marker intact)", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([{ text: PASS, hadToolCalls: true }]);
	const r = await runGate(gate, d);
	assert.equal(r.reply, DONE, "the deliverable is the original claim, not the verify text");
	assert.equal(r.verifyRounds, 0);
	assert.equal(r.releasedAtCap, false);
	assert.equal(d.calls.length, 1);
	assert.ok(d.calls[0].includes("收尾验证"), "the verify instruction is injected");
});

test("PASS without tool evidence is a failed round → repair → re-verify passes", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([
		{ text: PASS, hadToolCalls: false }, // claims pass, no evidence
		{ text: REPAIR_OUT, hadToolCalls: true },
		{ text: PASS, hadToolCalls: true },
	]);
	const r = await runGate(gate, d);
	assert.equal(r.reply, DONE);
	assert.equal(r.verifyRounds, 1);
	assert.equal(r.releasedAtCap, false);
	assert.equal(d.calls.length, 3, "verify + repair + re-verify, bounded");
	assert.ok(d.calls[1].includes("上一轮收尾验证未通过"), "repair instruction injected");
});

test("VERIFY_FAIL → repair → still failing releases at the cap, original marker kept", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([
		{ text: FAIL, hadToolCalls: false },
		{ text: REPAIR_OUT, hadToolCalls: false },
		{ text: FAIL, hadToolCalls: false },
	]);
	const r = await runGate(gate, d);
	assert.equal(r.releasedAtCap, true);
	assert.equal(r.verifyRounds, VERIFY_GIVE_UP);
	assert.equal(d.calls.length, 3, "bounded: 2 verify + 1 repair");
	assert.ok(r.reply.includes("⚠️ 收尾验证连续"), "explicit warning, never a clean success");
	assert.ok(r.reply.includes("堡垒机掉登录"), "the failure note survives");
	assert.ok(r.reply.includes("[[TASK_DONE]]"), "release stays TERMINAL on the marker pipeline");
});

test("a drive/stream failure fails open — the original reply is delivered", async () => {
	const r = await runGate(new LegacySettleGate(), {
		calls: [],
		drive: async () => { throw new Error("stream cut"); },
	});
	assert.equal(r.reply, DONE, "original reply survives a broken verify turn");
	assert.equal(r.releasedAtCap, false);
});

test("streak is per done-claim chain, NOT per conversation (P1-1)", async () => {
	const gate = new LegacySettleGate();
	// Run 1 consumes one failed round then passes.
	const d1 = scriptedDrive([
		{ text: FAIL, hadToolCalls: false },
		{ text: REPAIR_OUT, hadToolCalls: true },
		{ text: PASS, hadToolCalls: true },
	]);
	const r1 = await runGate(gate, d1, DONE, "work:same-item");
	assert.equal(r1.verifyRounds, 1);
	assert.equal(r1.releasedAtCap, false);
	// Run 2: an INDEPENDENT task in the SAME conversation, failing once. Under
	// the old per-conversation Map it inherited streak=1 and was released after
	// this single failure. It must get the full budget instead.
	const d2 = scriptedDrive([
		{ text: FAIL, hadToolCalls: false },
		{ text: REPAIR_OUT, hadToolCalls: true },
		{ text: PASS, hadToolCalls: true },
	]);
	const r2 = await runGate(gate, d2, DONE, "work:same-item");
	assert.equal(r2.releasedAtCap, false, "a later run must not inherit the previous run's streak");
	assert.equal(r2.verifyRounds, 1);
	assert.equal(r2.reply, DONE);
});

test("gated replies still grade TERMINAL for both legacy schedulers (P0-1)", async () => {
	const gate = new LegacySettleGate();
	// Baseline: the ungated done claim.
	assert.equal(parseWindowReply(DONE).kind, "done");
	assert.equal(parseChainReply(DONE).kind, "done");

	// PASS path: identical grading, full substance preserved.
	const dPass = scriptedDrive([{ text: PASS, hadToolCalls: true }]);
	const passed = await runGate(gate, dPass);
	assert.equal(parseWindowReply(passed.reply).kind, "done", "work window must close, not re-prompt");
	assert.equal(parseChainReply(passed.reply).kind, "done", "autonomous chain must close");
	assert.ok(parseWindowReply(passed.reply).text.includes("对账异常全部处理完毕"), "substance survives");

	// A terse marker-only verify reply must NOT become the deliverable (P2-2).
	const dTerse = scriptedDrive([{ text: "[[VERIFY_PASS]]", hadToolCalls: true }]);
	const terse = await runGate(new LegacySettleGate(), dTerse);
	assert.equal(terse.reply, DONE, "a thin verify text never replaces the real result");

	// RELEASE path: still terminal (no ping-pong), warning visible, no raw marker.
	const dRel = scriptedDrive([
		{ text: FAIL, hadToolCalls: false },
		{ text: REPAIR_OUT, hadToolCalls: false },
		{ text: FAIL, hadToolCalls: false },
	]);
	const released = await runGate(new LegacySettleGate(), dRel);
	const w = parseWindowReply(released.reply);
	const c = parseChainReply(released.reply);
	assert.equal(w.kind, "done", "release must terminate the window, not burn budget");
	assert.equal(c.kind, "done");
	assert.ok(w.text.includes("⚠️"), "the admin sees the warning");
	assert.ok(!w.text.includes("[[TASK_DONE]]") && !w.text.includes("[[VERIFY_PASS]]"), "marker lines are stripped from the pushed text");
	assert.equal(releaseReply(DONE, "堡垒机掉登录，无法核实"), released.reply, "releaseReply is the single source of the release shape");
});

test("a verdict marker NOT at line start is judged 'none' → repair, not pass (P3-3)", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([
		{ text: "复核完毕，数据一致[[VERIFY_PASS]]", hadToolCalls: true }, // glued marker
		{ text: REPAIR_OUT, hadToolCalls: true },
		{ text: PASS, hadToolCalls: true },
	]);
	const r = await runGate(gate, d);
	assert.equal(r.verifyRounds, 1, "the glued marker must not count as a pass");
	assert.equal(d.calls.length, 3);
	assert.equal(r.reply, DONE);
});

test("legacyGateEligible pins every turn-level skip (P1-2 / P2-1 / P3-1 / P3-2)", () => {
	const base = { kernel: "legacy" };
	assert.equal(legacyGateEligible(base), true, "a clean legacy turn is eligible");
	const skips = {
		"non-legacy kernel (pi-session)": { kernel: "pi-session" },
		"non-legacy kernel (durable)": { kernel: "durable" },
		"ephemeral side pass": { ...base, ephemeral: true },
		"hard error": { ...base, hardError: "boom" },
		"deterministic replay": { ...base, deterministic: true },
		"tool-step cap fired": { ...base, capHit: true },
		"context budget hit": { ...base, contextBudgetHit: true },
		"turn aborted (/stop)": { ...base, aborted: true },
		"narration suppressed": { ...base, narrationSuppressed: true },
		"narration noted": { ...base, narrationNoted: true },
		"undelivered steer": { ...base, undeliveredSteer: true },
	};
	for (const [name, g] of Object.entries(skips)) {
		assert.equal(legacyGateEligible(g), false, `must skip: ${name}`);
	}
	// Null/undefined hardError is not an error.
	assert.equal(legacyGateEligible({ ...base, hardError: null }), true);
});
