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
		contents: `export { looksLikeTask, parsePlan, formatPlanMessage, PLAN_PROMPT_HEADER } from "./src/engine/task-planner.ts";`,
		resolveDir: root, loader: "ts",
	},
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const m = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

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
	assert.match(plan, /目标：/);
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
	assert.ok(plan && plan.length <= 1_201);
});

// ---------- formatPlanMessage ----------

test("the chat message is one 📋 block with the honor-what-you-promised line", () => {
	const msg = m.formatPlanMessage("目标：x\n1. a\n2. b");
	assert.ok(msg.startsWith("📋 任务规划"));
	assert.ok(msg.includes("按此执行"));
});

test("the prompt header asks for steps only, no prose", () => {
	assert.match(m.PLAN_PROMPT_HEADER, /执行规划/);
	assert.match(m.PLAN_PROMPT_HEADER, /NO_PLAN/);
});
