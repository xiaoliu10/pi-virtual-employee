/**
 * Autonomous scheduled-task chain tests. Run with `node --test scripts/test-autonomous.mjs`.
 *
 * Field motivation (2026-09-30): a scheduled task used to fire exactly one
 * turn; long goals needed a human pushing them along one message at a time.
 * Autonomous chaining lets one fire keep working until the model declares the
 * goal met (marker), asks for a human, or exhausts its budget. The pinned
 * properties here are the PURE logic: marker parsing (markers must lead a
 * line, stripped from pushed text, NEED_HUMAN wins over TASK_DONE), budget
 * clamping, and chain-state round-tripping.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.autonomous-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "autonomous.mjs");
await build({
	stdin: { contents: 'export * from "./src/scheduler/autonomous.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const {
	AUTONOMOUS_DONE_MARK,
	AUTONOMOUS_HUMAN_MARK,
	budgetExceeded,
	buildAutonomousTurnPrefix,
	buildLearnTurnAsk,
	normalizeBudget,
	parseChainReply,
	parseChainState,
	nextStallStep,
	STALL_QUIET_RETRIES,
	STALL_RETRY_BASE_MS,
} = await import(pathToFileURL(bundle).href);

test("parseChainReply detects the done marker and strips it from the pushed text", () => {
	const reply = "月末对账报表已生成，共核对 1,204 笔流水，发现 3 笔异常并已标记。\n[[TASK_DONE]]";
	const r = parseChainReply(reply);
	assert.equal(r.kind, "done");
	assert.equal(r.text, "月末对账报表已生成，共核对 1,204 笔流水，发现 3 笔异常并已标记。");
});

test("parseChainReply detects need_human with the question, even with bold markdown", () => {
	const r = parseChainReply("卡在登录页。\n**[[NEED_HUMAN]]: 后台登录已过期，请提供新的账号密码**");
	assert.equal(r.kind, "human");
	assert.match(r.question, /后台登录已过期/);
	assert.equal(r.text, "卡在登录页。");
});

test("need_human wins when both markers appear; a mid-prose mention does not trigger", () => {
	const both = parseChainReply("第一步完成。\n[[TASK_DONE]]\n等等，还缺账号。\n[[NEED_HUMAN]]: 请提供账号");
	assert.equal(both.kind, "human");

	const mid = parseChainReply("我们在文档里讨论过 [[TASK_DONE]] 这个约定的历史。");
	assert.equal(mid.kind, "continue", "a marker that does not lead a line is prose, not a signal");
	assert.ok(mid.text.includes("[[TASK_DONE]]"), "prose is untouched");
});

test("budgetExceeded fires on turns OR wall clock", () => {
	const now = Date.now();
	const state = { convId: "c", turns: 20, startedAt: now - 60_000 };
	assert.ok(budgetExceeded(state, { maxTurns: 20, maxMinutes: 120 }, now), "turn budget");
	const elapsed = { convId: "c", turns: 3, startedAt: now - 121 * 60_000 };
	assert.ok(budgetExceeded(elapsed, { maxTurns: 20, maxMinutes: 120 }, now), "wall-clock budget");
	const healthy = { convId: "c", turns: 5, startedAt: now - 30_000 };
	assert.ok(!budgetExceeded(healthy, { maxTurns: 20, maxMinutes: 120 }, now));
});

test("normalizeBudget clamps to sane bounds and falls back on garbage", () => {
	assert.deepEqual(normalizeBudget(undefined, undefined), { maxTurns: 20, maxMinutes: 120 });
	assert.deepEqual(normalizeBudget(-5, "abc"), { maxTurns: 20, maxMinutes: 120 });
	assert.deepEqual(normalizeBudget(9999, 99999), { maxTurns: 200, maxMinutes: 1440 }, "upper clamp");
	assert.deepEqual(normalizeBudget(7, 45), { maxTurns: 7, maxMinutes: 45 });
});

test("parseChainState round-trips and rejects corrupt payloads", () => {
	const state = { convId: "sched:t1:123", turns: 4, startedAt: 1700000000000, pending: "human", question: "账号?" };
	const parsed = parseChainState(JSON.stringify(state));
	assert.deepEqual(parsed, { ...state, answer: undefined, stallCount: 0 });
	assert.equal(parseChainState(null), null);
	assert.equal(parseChainState("{not json"), null);
	assert.equal(parseChainState(JSON.stringify({ turns: 3 })), null, "missing convId is not a chain");
});

test("parseChainReply extracts every [[REMEMBER: …]] line from any position and strips them", () => {
	const r = parseChainReply("试了三种方式后确认用 MuMuManager 截图可行\n[[REMEMBER: MuMu 截图用 MuMuManager api -v 0 screenshot <路径>；adb 端口 16384]]");
	assert.equal(r.kind, "continue");
	assert.deepEqual(r.remember, ["MuMu 截图用 MuMuManager api -v 0 screenshot <路径>；adb 端口 16384"]);
	assert.doesNotMatch(r.text, /REMEMBER/, "markers stripped from pushed text");
	// Multiple discoveries in one turn — all extracted (review M1: none dropped).
	const multi = parseChainReply("[[REMEMBER: 发现一]]\n中间过程\n[[REMEMBER: 发现二]]\n[[TASK_DONE]]");
	assert.equal(multi.kind, "done");
	assert.deepEqual(multi.remember, ["发现一", "发现二"], "all lines extracted, none silently dropped");
	assert.doesNotMatch(multi.text, /REMEMBER/);
	// NEED_HUMAN wins as kind; remember still extracted (review L3).
	const human = parseChainReply("[[REMEMBER: 端口是 16384]]\n卡住了\n[[NEED_HUMAN]]: 要验证码");
	assert.equal(human.kind, "human");
	assert.deepEqual(human.remember, ["端口是 16384"]);
	assert.deepEqual(parseChainReply("正常进展").remember, [], "no marker → empty list");
});

test("buildAutonomousTurnPrefix teaches the marker protocol on every turn", () => {
	const first = buildAutonomousTurnPrefix({ turn: 0, budget: { maxTurns: 20, maxMinutes: 120 } });
	const later = buildAutonomousTurnPrefix({ turn: 5, budget: { maxTurns: 20, maxMinutes: 120 } });
	for (const prefix of [first, later]) {
		assert.ok(prefix.includes(AUTONOMOUS_DONE_MARK));
		assert.ok(prefix.includes(AUTONOMOUS_HUMAN_MARK));
	}
	assert.ok(first.includes("自主任务模式"), "turn 0 introduces the mode");
	assert.match(later, /第 6 轮/, "later turns state the round number");
});

test("autonomous chain protocol: KB-first on stalls and login expiry (field 2026-10-04)", () => {
	const prefix = buildAutonomousTurnPrefix({ turn: 0, budget: { maxTurns: 30, maxMinutes: 90 } });
	assert.match(prefix, /先用 search_knowledge_base 查一遍/);
	assert.match(prefix, /已查知识库（关键词 X），未找到/);
	assert.match(prefix, /登录过期\/账号异常 → 先 search_knowledge_base/);
	assert.doesNotMatch(prefix, /登录过期直接/);
	assert.match(prefix, /验证码、口头确认可免查/);
	// KB off → no ghost tool references.
	const noKb = buildAutonomousTurnPrefix({ turn: 0, budget: { maxTurns: 30, maxMinutes: 90 }, kbEnabled: false });
	assert.doesNotMatch(noKb, /search_knowledge_base/);
	assert.match(noKb, /登录过期直接/);
});

test("autonomous chain protocol: KB write-back after a blocker is resolved (field 2026-10-05)", () => {
	const prefix = buildAutonomousTurnPrefix({ turn: 0, budget: { maxTurns: 30, maxMinutes: 90 } });
	assert.match(prefix, /卡点解决后若沉淀出了可复用的信息/);
	assert.match(prefix, /save_to_knowledge 存进知识库/);
	assert.match(prefix, /服务异常的规避办法/);
	// KB off → no ghost tool reference.
	const noKb = buildAutonomousTurnPrefix({ turn: 0, budget: { maxTurns: 30, maxMinutes: 90 }, kbEnabled: false });
	assert.doesNotMatch(noKb, /save_to_knowledge/);
	// learn off (kb on): search stays, the write-back bullet must NOT (ghost tool).
	const noLearn = buildAutonomousTurnPrefix({ turn: 0, budget: { maxTurns: 30, maxMinutes: 90 }, kbEnabled: true, kbLearn: false });
	assert.match(noLearn, /search_knowledge_base/);
	assert.doesNotMatch(noLearn, /save_to_knowledge/);
});

test("buildLearnTurnAsk: done asks for wins; stuck outcomes record the blocker (field 2026-10-06)", () => {
	const done = buildLearnTurnAsk("done", "月卡领取");
	assert.match(done, /已完成/);
	assert.match(done, /踩过的坑与解法/);
	assert.match(done, /save_to_knowledge/);
	for (const outcome of ["stalled", "human", "budget", "error"]) {
		const ask = buildLearnTurnAsk(outcome, "月卡领取");
		assert.match(ask, /卡点/);
		assert.match(ask, /已尝试过什么/);
		assert.match(ask, /避免重复无效尝试/);
		assert.match(ask, /save_to_knowledge/, `${outcome} must still require the KB write`);
		assert.doesNotMatch(ask, /已完成/);
	}
});

test("parseChainState round-trips the stalled pending kind (field 2026-10-05)", () => {
	const chain = { convId: "sched:t1:1", turns: 3, startedAt: 1, pending: "stalled", question: "模型服务连续未返回内容" };
	const raw = JSON.stringify(chain);
	const parsed = parseChainState(raw);
	assert.equal(parsed?.pending, "stalled", "stalled must survive the persist/parse round-trip");
	assert.equal(parsed?.question, "模型服务连续未返回内容");
	// Unknown pending kinds still drop (existing contract).
	assert.equal(parseChainState(JSON.stringify({ ...chain, pending: "weird" }))?.pending, undefined);
});

// ── stall escalation policy (field 2026-10-06: occasional stalls must not ping the human) ──

test("nextStallStep: quiet retries first (with backoff), then escalate; parse keeps stallCount", async () => {

	assert.equal(STALL_QUIET_RETRIES, 2);
	// First two stalls: silent retry with linear backoff.
	assert.deepEqual(nextStallStep(1), { action: "retry", backoffMs: STALL_RETRY_BASE_MS });
	assert.deepEqual(nextStallStep(2), { action: "retry", backoffMs: STALL_RETRY_BASE_MS * 2 });
	// Third consecutive stall: the task is genuinely interrupted.
	assert.deepEqual(nextStallStep(3), { action: "escalate" });
	assert.deepEqual(nextStallStep(9), { action: "escalate" });
	// stallCount round-trips through chain-state persistence.
	const state = parseChainState(JSON.stringify({ convId: "sched:1:1", turns: 3, stallCount: 2 }));
	assert.equal(state?.stallCount, 2, "stallCount persists across fires");
	assert.equal(parseChainState(JSON.stringify({ convId: "sched:1:1", turns: 1 }))?.stallCount, 0, "absent count defaults to 0");
});
