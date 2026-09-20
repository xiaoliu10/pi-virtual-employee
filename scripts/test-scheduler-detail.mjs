/**
 * get_scheduled_task tests. Run with `npm run test:scheduler-detail`.
 *
 * Field incident 2026-09-20: 小派 could UPDATE a task's prompt
 * (update_scheduled_task) but could not READ the current one —
 * list_scheduled_tasks returns metadata only, and the SQLite file is not
 * text-searchable at the prompt's offset. The employee asked the user to
 * copy the prompt out of the console UI: blind editing, unacceptable for a
 * tool that rewrites unattended instructions.
 *
 * Pinned properties: the detail tool returns the prompt VERBATIM between
 * markers; an unknown id points back at list_scheduled_tasks; the list tool
 * must NOT leak the prompt (that is what the detail tool is for).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.sched-detail-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "sched-detail.mjs");
await build({
	stdin: {
		contents: `export { createSchedulerTools } from "./src/engine/tools/scheduler.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { createSchedulerTools } = await import(pathToFileURL(bundle).href);

const PROMPT = "生成 LiteLLM 运营分析报告：\n1. 调用 API 取近 7 天数据\n2. 汇总 Top10 消费\n3. 存报告并推送";
const rows = {
	t1: {
		id: "t1",
		title: "LiteLLM 日报推送（每日 09:30）",
		prompt: PROMPT,
		cron: "30 9 * * *",
		enabled: 1,
		conversation_id: "dt:group:cidABC",
		origin: "im",
		created_by: "staff-9",
		last_run_at: 1_000,
		next_run_at: 2_000,
		last_status: "ok",
		created_at: 900,
		updated_at: 950,
	},
};
const schedulerStub = {
	get: (id) => rows[id],
	list: () => Object.values(rows),
	validateCron: () => {},
};
const tools = createSchedulerTools(schedulerStub, "dt:x", "im");
const byName = (n) => tools.find((t) => t.name === n);
const text = (result) => result.content[0].text;

test("get_scheduled_task returns the prompt verbatim between markers", async () => {
	const result = await byName("get_scheduled_task").execute("c1", { id: "t1" });
	const out = text(result);
	assert.match(out, /【prompt 原文开始】\n/, "opening marker present");
	assert.match(out, /\n【prompt 原文结束】/, "closing marker present");
	const quoted = out.split("【prompt 原文开始】\n")[1].split("\n【prompt 原文结束】")[0];
	assert.equal(quoted, PROMPT, "prompt must be byte-identical, not summarized");
	assert.match(out, /30 9 \* \* \*/, "cron shown alongside");
	assert.equal(result.details.task.prompt, PROMPT);
});

test("unknown id points back at list_scheduled_tasks", async () => {
	const result = await byName("get_scheduled_task").execute("c1", { id: "nope" });
	assert.match(text(result), /list_scheduled_tasks/);
	assert.equal(result.details.ok, false);
});

test("the list tool still hides the prompt (that is the detail tool's job)", async () => {
	const result = await byName("list_scheduled_tasks").execute("c1", {});
	assert.doesNotMatch(text(result), /LiteLLM 运营分析报告/, "prompt body must not leak into the list");
	assert.match(text(result), /get_scheduled_task/, "list must point at the detail tool");
});
