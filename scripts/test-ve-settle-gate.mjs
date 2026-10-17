/**
 * VE settle-gate extension tests — the evidence-round state machine expressed
 * as a pi agent_before_settle handler. Spans multiple settle boundaries (the
 * verify round + repair round each run their own turn → their own settle).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, "node_modules/.ve-settle-gate-test/ve-settle-gate.mjs");
await build({
	stdin: { contents: 'export * from "./src/engine/extensions/ve-settle-gate.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { createVeSettleGateExtension, VERIFY_GIVE_UP, AUTONOMOUS_DONE_MARK, AUTONOMOUS_VERIFY_PASS_MARK, AUTONOMOUS_VERIFY_FAIL_MARK, settleReleaseReport } = await import(pathToFileURL(bundle).href);

/** A minimal pi-like API that just records the last handler result per boundary. */
function makePi() {
	const handlers = { agent_before_settle: null };
	return {
		on(event, handler) { handlers[event] = handler; },
		async settle(contextMessages) {
			return await handlers.agent_before_settle({ context: { contextMessages } });
		},
	};
}

function assistant(text, withToolCall = false) {
	const content = [{ type: "text", text }];
	if (withToolCall) content.push({ type: "toolCall", id: "c1", name: "check", arguments: {} });
	return { role: "assistant", content };
}

test("done claim → inject verify prompt + continue (no settle)", async () => {
	const pi = makePi();
	createVeSettleGateExtension()(pi);
	const result = await pi.settle([assistant(`完成对账\n${AUTONOMOUS_DONE_MARK}`)]);
	assert.equal(result.continue, true);
	assert.equal(result.entries[0].customType, "ve-settle-verify");
	assert.match(result.entries[0].content, /收尾验证/);
});

test("VERIFY_PASS with tool evidence → settle (pass through)", async () => {
	const pi = makePi();
	createVeSettleGateExtension()(pi);
	const result = await pi.settle([assistant(`复核属实\n${AUTONOMOUS_VERIFY_PASS_MARK}`, true)]);
	assert.equal(result, undefined, "pass → no continuation, no entries");
});

test("VERIFY_PASS without tool evidence → repair (self-confirmation guard)", async () => {
	const pi = makePi();
	createVeSettleGateExtension()(pi);
	const result = await pi.settle([assistant(`都完成了\n${AUTONOMOUS_VERIFY_PASS_MARK}`, false)]);
	assert.equal(result.continue, true);
	assert.equal(result.entries[0].customType, "ve-settle-repair");
	assert.match(result.entries[0].content, /实际核查/);
});

test("VERIFY_FAIL → repair with the failure note", async () => {
	const pi = makePi();
	createVeSettleGateExtension()(pi);
	const result = await pi.settle([assistant(`${AUTONOMOUS_VERIFY_FAIL_MARK}: 金额未核对`, true)]);
	assert.equal(result.continue, true);
	assert.match(result.entries[0].content, /金额未核对/);
});

test(`two consecutive FAILs → release at cap ${VERIFY_GIVE_UP} with ⚠️ report`, async () => {
	const pi = makePi();
	createVeSettleGateExtension()(pi);
	// FAIL #1 → repair
	const r1 = await pi.settle([assistant(`${AUTONOMOUS_VERIFY_FAIL_MARK}: A 未达成`, true)]);
	assert.equal(r1.continue, true);
	// FAIL #2 → release (anti-deadloop cap)
	const r2 = await pi.settle([assistant(`${AUTONOMOUS_VERIFY_FAIL_MARK}: B 未达成`, true)]);
	assert.equal(r2.continue, false, "release does NOT continue");
	assert.equal(r2.entries[0].customType, "ve-settle-release");
	assert.match(r2.entries[0].content, /⚠️ 收尾验证连续 2 轮未通过，已按防死循环策略放行：B 未达成/);
});

test("pass after a fail resets the streak (no leak across turns)", async () => {
	const pi = makePi();
	createVeSettleGateExtension()(pi);
	await pi.settle([assistant(`${AUTONOMOUS_VERIFY_FAIL_MARK}: 第一次失败`, true)]); // streak 1
	const pass = await pi.settle([assistant(`${AUTONOMOUS_VERIFY_PASS_MARK}`, true)]); // pass → reset
	assert.equal(pass, undefined);
	// A later fail starts fresh at streak 1, not 2.
	const r = await pi.settle([assistant(`${AUTONOMOUS_VERIFY_FAIL_MARK}: 再失败`, true)]);
	assert.equal(r.continue, true, "streak reset by the pass — this is repair, not release");
});

test("ordinary turn (no done/verify marker) → settle (gate is no-op)", async () => {
	const pi = makePi();
	createVeSettleGateExtension()(pi);
	const result = await pi.settle([assistant("正在处理中")]);
	assert.equal(result, undefined);
});
