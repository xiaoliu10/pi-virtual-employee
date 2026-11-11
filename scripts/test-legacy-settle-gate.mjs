/**
 * Legacy settle-gate tests — the engine-layer equivalent of the pi-session
 * ve-settle-gate extension. The gate is a pure orchestrator over an injected
 * `drive` (one extra model turn), so the whole state machine is testable
 * without an Agent SDK: pass/repair/release/no-op/fail-open.
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
	stdin: { contents: `export * from "./src/engine/legacy-settle-gate.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { LegacySettleGate, VERIFY_GIVE_UP } = await import(pathToFileURL(bundle).href);

const DONE = "任务完成\n[[TASK_DONE]]";
const PASS = "已用工具复核，数据一致\n[[VERIFY_PASS]]";
const FAIL = "目标未达成：登录态失效\n[[VERIFY_FAIL]]: 堡垒机掉登录";

/** Scripted drive: pops the next queued turn result. */
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

test("ordinary IM replies (no TASK_DONE marker) never enter the gate", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([]);
	const r = await gate.run({ conversationId: "c1", reply: "这是普通聊天回复", enabled: true, drive: d.drive });
	assert.equal(r.reply, "这是普通聊天回复");
	assert.equal(r.verifyRounds, 0);
	assert.equal(r.releasedAtCap, false);
	assert.equal(d.calls.length, 0, "no extra model turn");
});

test("disabled gate is a pure pass-through", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([]);
	const r = await gate.run({ conversationId: "c1", reply: DONE, enabled: false, drive: d.drive });
	assert.equal(r.reply, DONE);
	assert.equal(d.calls.length, 0);
});

test("TASK_DONE → verify PASS with tool evidence settles with the verified reply", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([{ text: PASS, hadToolCalls: true }]);
	const r = await gate.run({ conversationId: "c1", reply: DONE, enabled: true, drive: d.drive });
	assert.ok(r.reply.includes("[[VERIFY_PASS]]"));
	assert.ok(r.reply.includes("已用工具复核"));
	assert.equal(r.verifyRounds, 0);
	assert.equal(r.releasedAtCap, false);
	assert.equal(d.calls.length, 1);
	assert.ok(d.calls[0].includes("收尾验证"), "the verify instruction is injected");
});

test("VERIFY_PASS without tool evidence counts as a failed round → repair, then inline pass", async () => {
	const gate = new LegacySettleGate();
	// verify turn: PASS marker but no tool calls → judge fails it → repair turn
	// returns a fresh PASS, this time WITH evidence → inline second judge passes.
	const d = scriptedDrive([
		{ text: PASS, hadToolCalls: false },
		{ text: PASS, hadToolCalls: true },
	]);
	const r = await gate.run({ conversationId: "c1", reply: DONE, enabled: true, drive: d.drive });
	assert.equal(r.reply, PASS);
	assert.equal(r.verifyRounds, 1);
	assert.equal(r.releasedAtCap, false);
	assert.equal(d.calls.length, 2);
	assert.ok(d.calls[1].includes("收尾验证未通过"), "repair instruction injected");
});

test("VERIFY_FAIL → repair → still failing releases at the cap with a ⚠️ report", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([
		{ text: FAIL, hadToolCalls: false },
		{ text: FAIL, hadToolCalls: false },
	]);
	const r = await gate.run({ conversationId: "c1", reply: DONE, enabled: true, drive: d.drive });
	assert.equal(r.releasedAtCap, true);
	assert.equal(r.verifyRounds, VERIFY_GIVE_UP);
	assert.ok(r.reply.startsWith("⚠️"), "cap release is an explicit warning, never a clean success");
	assert.ok(r.reply.includes("堡垒机掉登录"));
});

test("a drive/stream failure fails open — the original reply is delivered", async () => {
	const gate = new LegacySettleGate();
	const d = scriptedDrive([]);
	const r = await gate.run({
		conversationId: "c1",
		reply: DONE,
		enabled: true,
		drive: async () => { throw new Error("stream cut"); },
	});
	assert.equal(r.reply, DONE, "original reply survives a broken verify turn");
	assert.equal(r.releasedAtCap, false);
	assert.equal(d.calls.length, 0);
});

test("streak state is per-conversation and cleared after a pass", async () => {
	const gate = new LegacySettleGate();
	const d1 = scriptedDrive([{ text: PASS, hadToolCalls: true }]);
	await gate.run({ conversationId: "cA", reply: DONE, enabled: true, drive: d1.drive });
	const d2 = scriptedDrive([{ text: PASS, hadToolCalls: true }]);
	const r2 = await gate.run({ conversationId: "cB", reply: DONE, enabled: true, drive: d2.drive });
	assert.equal(r2.verifyRounds, 0, "a different conversation starts with a fresh streak");
	assert.ok(r2.reply.includes("[[VERIFY_PASS]]"));
});
