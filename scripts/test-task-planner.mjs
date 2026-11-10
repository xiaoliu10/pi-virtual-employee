/**
 * Plan-ahead (v0.2.186): task-shaped messages get a numbered plan pushed to the
 * chat BEFORE execution, and the plan is fed to the turn as context.
 *
 * The gates that matter (each is a field failure mode from the progress-note
 * history — a feature that silently does nothing is indistinguishable from one
 * that was never wired):
 *  - a short question is NEVER planned (no latency tax on chat);
 *  - a model verdict of NO_PLAN / unusable output pushes nothing;
 *  - a planning failure never blocks or breaks execution;
 *  - the plan text is bounded (a 10KB "plan" is not a plan).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.task-planner-test");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: {
		contents: `export { looksLikeTask, isProcessNarration, isDanglingNarration, parsePlan, formatPlanMessage, PLAN_PROMPT_HEADER, parseDurationMinutes, shouldPushPlanToChat, formatPlanForTurn, formatDuration, PLAN_CHAT_THRESHOLD_MIN } from "./src/engine/task-planner.ts";
			export { countPlanSteps } from "./src/im/triage.ts";`,
		resolveDir: root, loader: "ts",
	},
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const m = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);
const { parsePlan, formatPlanMessage, parseDurationMinutes, shouldPushPlanToChat, formatPlanForTurn, formatDuration, PLAN_CHAT_THRESHOLD_MIN } = m;

// ---------- looksLikeTask ----------

test("short questions are never planned (no latency tax on chat)", () => {
	assert.equal(m.looksLikeTask("你好"), false);
	assert.equal(m.looksLikeTask("现在几点了"), false);
	assert.equal(m.looksLikeTask("帮我看一下这个文件"), false);
	assert.equal(m.looksLikeTask("继续"), false);
	assert.equal(m.looksLikeTask("登录成功了吗？"), false);
});

test("short but genuinely multi-step tasks ARE planned (a length floor dropped them)", () => {
	// Field 2026-11-03: real instructions like these are 18-28 chars. A 30-char
	// floor silently dropped most real tasks from planning.
	assert.equal(m.looksLikeTask("部署一下测试环境，跑通之后把日志发我"), true);
	assert.equal(m.looksLikeTask("抓取这个页面的列表数据，然后批量下载附件，最后整理成表格"), true);
});

test("a bare single-step task verb is not planned", () => {
	// 「登录」 alone (or with a target but no sequencing) is a one-shot command;
	// planning it would add latency for zero information.
	assert.equal(m.looksLikeTask("登录"), false);
	assert.equal(m.looksLikeTask("生成"), false);
});

test("explicit multi-step tasks ARE planned", () => {
	assert.equal(m.looksLikeTask("帮我登录 spay 系统，然后抓取昨天的账单数据并导出到 Excel"), true);
	assert.equal(m.looksLikeTask("部署一下测试环境，跑通之后把日志发我"), true);
	assert.equal(m.looksLikeTask("抓取这个页面的列表数据，然后批量下载附件，最后整理成表格"), true);
});

test("task verbs without multi-step markers still qualify when long enough", () => {
	assert.equal(m.looksLikeTask("生成一份本周的 LiteLLM 用量汇总报告，包含每个模型的调用次数和费用明细，并发到群里"), true);
});

test("a very long message is a task by construction", () => {
	assert.equal(m.looksLikeTask("x".repeat(4_100)), true);
});

// ---------- parsePlan ----------

test("a valid numbered plan parses", () => {
	const plan = m.parsePlan("目标：登录 spay 并导出账单\n1. 打开登录页\n2. 输入账号密码\n3. 获取验证码并填入\n4. 进入账单页并导出");
	assert.ok(plan);
	// Structured since the 2026-11-04 ruling: the chat needs a short outline, the
	// turn needs the full steps — one string could not serve both.
	assert.equal(plan.goal, "登录 spay 并导出账单");
	assert.match(plan.steps, /目标：/);
	assert.match(plan.steps, /4\. 进入账单页并导出/);
});

test("NO_PLAN pushes nothing", () => {
	assert.equal(m.parsePlan("NO_PLAN"), null);
	assert.equal(m.parsePlan("NO_PLAN 这是一个简单问题"), null);
});

test("a plan without a 目标 line is rejected", () => {
	assert.equal(m.parsePlan("1. 打开页面\n2. 点击按钮"), null);
});

test("a single step is not a plan", () => {
	assert.equal(m.parsePlan("目标：跑一下脚本\n1. 执行"), null);
});

test("an unusable plan (empty/garbage) pushes nothing", () => {
	assert.equal(m.parsePlan(""), null);
	assert.equal(m.parsePlan(undefined), null);
	assert.equal(m.parsePlan("好的，我来帮你处理这个任务"), null);
});

test("an over-long plan is clamped, not pushed whole", () => {
	const plan = m.parsePlan(`目标：${"x".repeat(1_500)}\n1. a\n2. b`);
	assert.ok(plan && plan.steps.length <= 1_201);
});

// ---------- formatPlanMessage ----------

test("the chat message leads with the goal in one 📋 line", () => {
	// Superseded contract (user ruling 2026-11-04): the chat no longer receives a
	// title + 按此执行 boilerplate; it receives what the user actually asked for —
	//「这个人要干什么、大概怎么干、多久」.
	const plan = m.parsePlan("耗时：40分钟\n目标：导出昨日账单\n流程：登录 → 抓取 → 导出\n1. a\n2. b");
	const msg = m.formatPlanMessage(plan);
	assert.ok(msg.startsWith("📋 导出昨日账单"), `goal must lead: ${msg}`);
	assert.ok(msg.includes("登录 → 抓取 → 导出"));
	assert.ok(!msg.includes("按此执行"), "no machine boilerplate in chat");
});

test("an uncertain estimate stays invisible: no ⏱ line, no plan push (user ruling 2026-11-10)", () => {
	const plan = m.parsePlan("耗时：不确定\n目标：登录后台核对配置\n流程：登录 → 核对\n1. 登录\n2. 核对");
	assert.equal(plan.estimatedMinutes, 0, "「不确定」 parses to unknown (0), never a fabricated number");
	const msg = m.formatPlanMessage(plan);
	assert.ok(!msg.includes("⏱"), "no estimate line is shown when the model is not sure");
	assert.ok(!msg.includes("不确定"), "the raw word does not leak into the chat card either");
	assert.ok(msg.includes("登录后台核对配置"), "goal and flow still render");
	assert.equal(m.shouldPushPlanToChat(plan), false, "an unknown duration never proves 'long' — no push");
	// Review 1ce0eb90 P3-1: pin the dispatch-side half — an uncertain plan is
	// still a PLAN: steps survive parsing, so triage routes/executes it exactly
	// like a plan with a numeric eta (only the chat card is suppressed).
	assert.equal(m.countPlanSteps(plan.steps), 2, "uncertain plans stay dispatchable — the eta gate never blocks execution");
});

test("the prompt header demands rigor: a number only with a reliable basis, machine time only", () => {
	// User ruling 2026-11-10: 如果不确定就不要写，要严谨。The field card
	// 「⏱ 预计约 30 分钟」 for a 2-minute login task was an uncalibrated guess
	// that also tripped the ≥30min push gate — noise and misinformation from
	// the same root.
	assert.match(m.PLAN_PROMPT_HEADER, /可靠依据/, "a number requires a reliable basis");
	assert.match(m.PLAN_PROMPT_HEADER, /不确定/, "the honest escape is mandated");
	assert.match(m.PLAN_PROMPT_HEADER, /严禁编造/, "fabricating a number is forbidden");
	assert.match(m.PLAN_PROMPT_HEADER, /机器执行时间/, "machine time only");
	assert.match(m.PLAN_PROMPT_HEADER, /不计入/, "human-wait time is excluded");
});

test("the prompt header asks for the outline AND the hidden steps", () => {
	// The side pass must now yield 耗时 + 目标 + 流程 (the chat outline) plus the
	// numbered steps (the turn context) in one call.
	assert.match(m.PLAN_PROMPT_HEADER, /耗时[：:]/);
	assert.match(m.PLAN_PROMPT_HEADER, /目标[：:]/);
	assert.match(m.PLAN_PROMPT_HEADER, /流程[：:]/);
	assert.match(m.PLAN_PROMPT_HEADER, /NO_PLAN/);
});

// ─────────────────────────────────────────────────────────────────────────────
// User ruling 2026-11-04: a short task does not need a plan pushed into the
// chat, and the plan that IS pushed should read like a person's outline, not
// like a machine's numbered checklist.
//   · push only when the model estimates ≥ 30 minutes
//   · the chat message shows 目标 + 流程 + 预计耗时 — never the numbered steps
//   · the EXECUTING turn still receives the full numbered plan
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_LONG = `耗时：1小时
目标：把昨天的账单抓下来做成 Excel
流程：登录 spay → 抓取昨日账单 → 导出 Excel
1. 登录 spay 系统
2. 逐页抓取昨日账单
3. 合并并导出 Excel`;

const PLAN_SHORT = `耗时：5分钟
目标：查一下昨天的单量
流程：调接口 → 汇总
1. 调接口取昨日数据
2. 汇总成一行数字`;

test("duration parsing handles the shapes a model actually writes", () => {
	assert.equal(parseDurationMinutes("5分钟"), 5);
	assert.equal(parseDurationMinutes("20 分"), 20);
	assert.equal(parseDurationMinutes("1小时"), 60);
	assert.equal(parseDurationMinutes("1.5h"), 90);
	assert.equal(parseDurationMinutes("半小时"), 30);
	assert.equal(parseDurationMinutes("2 天"), 2880);
	assert.equal(parseDurationMinutes("大约 3 小时"), 180);
	// User ruling 2026-11-10: "如果不确定就不要写 要严谨" — the model writes
	// 「不确定」 when it has no reliable basis; that must parse to 0 (unknown),
	// never to a fabricated number.
	assert.equal(parseDurationMinutes("不确定"), 0);
	assert.equal(parseDurationMinutes("不确定（需要等验证码）"), 0);
	// Review 1ce0eb90 P2-1: hedged lines must NOT leak the embedded number —
	// "不确定，最多30分钟" parsing to 30 would re-arm the ≥30min push gate and
	// the misleading ⏱ card returns.
	assert.equal(parseDurationMinutes("不确定，最多30分钟"), 0);
	assert.equal(parseDurationMinutes("不确定（可能超过1小时）"), 0);
	assert.equal(parseDurationMinutes("不确定, 预计 2 天左右"), 0);
	// Unknown / empty must be 0 — callers treat 0 as "not proven long".
	for (const t of ["", "不确定", "一会儿", undefined]) assert.equal(parseDurationMinutes(t), 0, `should be 0: ${t}`);
});

test("a LONG task pushes a plan; a SHORT task pushes nothing", () => {
	const long = parsePlan(PLAN_LONG);
	const short = parsePlan(PLAN_SHORT);
	assert.ok(long && short);
	assert.equal(shouldPushPlanToChat(long), true, "1 hour is well past the 30-minute gate");
	assert.equal(shouldPushPlanToChat(short), false, "5 minutes must stay silent");
	// Unknown duration is NOT proven long → silent (fail safe toward less noise).
	assert.equal(shouldPushPlanToChat({ ...short, estimatedMinutes: 0 }), false);
	// Exactly at the threshold pushes.
	assert.equal(shouldPushPlanToChat({ ...short, estimatedMinutes: PLAN_CHAT_THRESHOLD_MIN }), true);
});

test("the chat message is a short human outline — no numbered steps", () => {
	const plan = parsePlan(PLAN_LONG);
	const msg = formatPlanMessage(plan);
	assert.match(msg, /把昨天的账单抓下来/, "the goal leads");
	assert.match(msg, /登录 spay → 抓取昨日账单 → 导出 Excel/, "the flow is shown as a chain");
	assert.match(msg, /预计约 1 小时/, "the ETA tells the user how long they are waiting");
	// The mechanical steps must NOT leak into the chat.
	assert.doesNotMatch(msg, /1\. 登录 spay 系统/, `numbered steps leaked into chat: ${msg}`);
	assert.doesNotMatch(msg, /2\. 逐页抓取/, `numbered steps leaked into chat: ${msg}`);
	// And it must be short — a plan longer than the request is noise.
	assert.ok(msg.split("\n").length <= 4, `chat plan must stay terse: ${JSON.stringify(msg)}`);
});

test("the EXECUTING turn still gets the full numbered plan", () => {
	const plan = parsePlan(PLAN_LONG);
	const ctx = formatPlanForTurn(plan);
	assert.match(ctx, /1\. 登录 spay 系统/);
	assert.match(ctx, /3\. 合并并导出 Excel/);
});

test("formatDuration reads naturally", () => {
	assert.equal(formatDuration(5), "5 分钟");
	assert.equal(formatDuration(30), "30 分钟");
	assert.equal(formatDuration(60), "1 小时");
	assert.equal(formatDuration(95), "1 小时 35 分");
});

// ---------- isProcessNarration (field 2026-11-10, Nova 13:00 stall) ----------

test("isProcessNarration catches the field stall shapes (intent + dangling lead-in, no result)", () => {
	for (const text of [
		"好的，我来查这笔流水的支付渠道下单日志。先确认一下当前环境和可用工具：",
		"我来尝试登录生产后台管理。先检查一下当前环境可用的工具。",
		"让我调用 SLS 查询技能来执行：",
		"你说得对，登录已经成功了，我不该再卡在这。马上开始查日志。\n\n让我调用 SLS 查询技能来执行：",
		"我需要先了解当前环境，然后再继续。",
	]) {
		assert.equal(m.isProcessNarration(text), true, `must be treated as narration: ${text.slice(0, 30)}`);
	}
});

test("isProcessNarration leaves substantive answers, blockers and chat untouched", () => {
	for (const text of [
		"我现在重启驱动，恢复 X11 连接后继续查日志。",
		"登录入口在设置页。",
		"查询完成。\n\n# 结果\n\n| 流水号 | 渠道 |\n|---|---|\n| 0422 | 工行 |",
		"驱动卡在 goto 命令上了。需要你确认终止当前驱动进程，请回复\"确认终止\"，我杀掉重启。",
		"你好，有什么可以帮你？",
		"登录成功，环境检查完成。",
		"共查到 3 笔异常订单，明细如下：1）a 2）b 3）c",
		// Regression 2026-11-10 false-positive probe: a short prerequisite sentence
		// that names a CONCRETE technical object is a real action commitment, not
		// generic throat-clearing — it must stay deliverable.
		"我先看一下当前环境里 spay_profile 的实际状态。",
		"让我检查 sls_monitor_full.py 的运行状态。",
		"我先看一下 C:\\\\Users\\\\hspcadmin\\\\Desktop\\\\Nova 目录。",
		"",
	]) {
		assert.equal(m.isProcessNarration(text), false, `must NOT be treated as narration: ${text.slice(0, 30)}`);
	}
});

test("isProcessNarration is bounded — long replies are never suppressed on this heuristic", () => {
	assert.equal(m.isProcessNarration("我来查一下。".repeat(20)), false);
});

test("isDanglingNarration: only structurally certain mid-sentence lead-ins may replace a delivery", () => {
	// Dangling: ends on a colon / execution lead-in with no outcome — can never BE a result.
	for (const text of [
		"好的，我来查这笔流水的支付渠道下单日志。先确认一下当前环境和可用工具：",
		"让我调用 SLS 查询技能来执行：",
		"好的，让我先确认一下当前环境和可用工具：",
	]) assert.equal(m.isDanglingNarration(text), true, `dangling: ${text.slice(0, 30)}`);
	// NOT dangling: complete sentences, or a colon that INTRODUCES real data.
	for (const text of [
		"我需要先了解当前环境，然后再继续。",
		"查到 3 笔异常，明细：1）a 2）b",
		"登录成功，环境检查完成。",
		"你好，有什么可以帮你？",
		// Review adaf0751 P2-A: a colon-ended CLARIFICATION lead-in is a question
		// the human must answer — suppressing it loses what the model wanted to ask.
		"我需要先确认几个问题：",
		"让我确认一下时间范围：",
		"我先确认一下你的需求：",
		"让我先问清楚：",
	]) assert.equal(m.isDanglingNarration(text), false, `not dangling: ${text.slice(0, 30)}`);
});
