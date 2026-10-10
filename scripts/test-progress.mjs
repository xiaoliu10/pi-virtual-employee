/**
 * Unit tests for the heartbeat progress normalizer (src/engine/progress.ts).
 * Run with `node --test scripts/test-progress.mjs` (part of test:all).
 *
 * The pinned behaviors, mapped to the field incidents that forced them:
 *  - the English compaction template is rejected, but Chinese 「## 已完成」
 *    markdown headings and ordinary English words ("Goal") are NOT (the old
 *    broad guard discarded exactly the structured reports users asked for);
 *  - the four fields always survive per-field clamping — a long 已完成 can
 *    never amputate the 卡点 item the way the old global 180-char slice did;
 *  - unevidenced fields read 「暂未确认」, never an invented 「无」 or a
 *    made-up number, and a structureless blob is never force-fit into the
 *    four slots as if it were facts.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.progress-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "progress.mjs");
await build({
	stdin: {
		contents: `
			export { isCompactionTemplateReport, containsTemplateHeadingLine, parseProgressFields, standardizeProgressReport, clampField, extractProgressFromTexts, formatDeterministicBrief } from "./src/engine/progress.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { isCompactionTemplateReport, containsTemplateHeadingLine, parseProgressFields, standardizeProgressReport, clampField, extractProgressFromTexts, formatDeterministicBrief } = await import(pathToFileURL(bundle).href);

// ── template signature: tight, never over-broad ──

test("isCompactionTemplateReport: the double English heading is the template, nothing else is", () => {
	const template = "## Goal 跟踪处理 24 条工行数币掉单异常\n## Constraints & Preferences\n- 处理流程：获取对账文件 → 下载 → 检查";
	assert.equal(isCompactionTemplateReport(template), true);
	// No space after the heading word — \b holds at the ASCII↔CJK boundary.
	assert.equal(isCompactionTemplateReport("## Goal跟踪处理掉单\n## Constraints - x"), true);

	// A compliant Chinese report with markdown headings is NOT the template.
	assert.equal(isCompactionTemplateReport("## 已完成\n12 条对账完成\n## 剩余\n12 条待下载"), false, "Chinese ## headings are legal");
	// One heading alone is not the signature.
	assert.equal(isCompactionTemplateReport("## Goal 单独出现不算"), false);
	assert.equal(isCompactionTemplateReport("普通汇报，没有标题"), false);
	// The English word "Goal" mid-sentence is ordinary vocabulary.
	assert.equal(isCompactionTemplateReport("已完成：完成 Goal 分解；剩余：开发；正在：编码；卡点：无"), false);
	assert.equal(isCompactionTemplateReport(""), false);
});

// ── parsing: inline and Chinese-markdown layouts ──

test("parseProgressFields parses the inline four-field layout", () => {
	const fields = parseProgressFields("已完成：12 条重新对账；剩余：12 条待下载；正在：逐条下载对账文件；卡点：无");
	assert.deepEqual(fields, { done: "12 条重新对账", remaining: "12 条待下载", doing: "逐条下载对账文件", blocked: "无" });

	// English colons and a missing trailing field separator still parse.
	const loose = parseProgressFields("已完成: 下载文件 剩余: 上传 正在: 等待结果 卡点: 无");
	assert.equal(loose?.done, "下载文件");
	assert.equal(loose?.remaining, "上传");
});

test("parseProgressFields parses Chinese markdown headings (## 已完成\\n…)", () => {
	const fields = parseProgressFields("## 已完成\n12 条重新对账，差异已提交复核\n## 剩余\n12 条待下载检查\n## 正在\n逐条下载对账文件\n## 卡点\n财务接口超时");
	assert.deepEqual(fields, { done: "12 条重新对账，差异已提交复核", remaining: "12 条待下载检查", doing: "逐条下载对账文件", blocked: "财务接口超时" });

	// Headings WITH inline content and a mixed layout also normalize.
	const mixed = parseProgressFields("## 已完成：前三批对账\n剩余：12 条；正在：下载；卡点：无");
	assert.equal(mixed?.done, "前三批对账");
	assert.equal(mixed?.blocked, "无");
});

test("parseProgressFields: missing labels are null (not invented), a label with empty content is \"\"", () => {
	const partial = parseProgressFields("已完成：前三批对账完成；剩余：12 条待处理");
	assert.equal(partial?.done, "前三批对账完成");
	assert.equal(partial?.remaining, "12 条待处理");
	assert.equal(partial?.doing, null, "a missing label is null, never filled here");
	assert.equal(partial?.blocked, null);

	const emptyContent = parseProgressFields("已完成：；剩余：x；正在：y；卡点：z");
	assert.equal(emptyContent?.done, "", "label present, content empty");

	// A longer heading is not split at 已完成.
	const longer = parseProgressFields("## 已完成情况汇报\n共 12 条");
	assert.equal(longer, null, "「已完成情况」 is not the 已完成 label");

	// No label at all → null (a blob is never force-fit into four slots).
	assert.equal(parseProgressFields("检查表格当前行状态，正在继续处理"), null);
	assert.equal(parseProgressFields(""), null);
	assert.equal(parseProgressFields("   "), null);
});

// ── standardization: the one entry point the LLM path uses ──

test("standardizeProgressReport passes a compliant four-field report through verbatim", () => {
	const inline = "已完成：12 条重新对账；剩余：12 条待下载；正在：逐条下载对账文件；卡点：无";
	assert.equal(standardizeProgressReport(inline), inline);
});

test("standardizeProgressReport normalizes Chinese markdown four-field reports", () => {
	const out = standardizeProgressReport("## 已完成\n12 条对账完成；剩余：无；正在：汇总；卡点：无");
	assert.equal(out, "已完成：12 条对账完成；剩余：无；正在：汇总；卡点：无");
});

test("standardizeProgressReport: the compaction template, blobs, and MISSING labels all yield null", () => {
	assert.equal(standardizeProgressReport("## Goal 跟踪处理掉单\n## Constraints & Preferences\n- 处理流程：获取对账文件"), null, "template echo");
	assert.equal(standardizeProgressReport("正在逐条核对对账差异，继续推进中"), null, "structureless blob — never presented as facts");
	assert.equal(standardizeProgressReport("已完成：前三批对账完成；剩余：12 条待处理"), null, "a partial report must not be shown with gaps papered over");
	assert.equal(standardizeProgressReport(""), null);
});

test("standardizeProgressReport: empty-content fields read 暂未确认; an explicit 无 stays 无; unknown never becomes 无", () => {
	assert.equal(
		standardizeProgressReport("已完成：；剩余：；正在：；卡点："),
		"已完成：暂未确认；剩余：暂未确认；正在：暂未确认；卡点：暂无",
		"empty fields → 暂未确认, never 无; an EMPTY 卡点 reads 暂无 (field request 2026-10-10)",
	);
	assert.equal(
		standardizeProgressReport("已完成：12 条重新对账；剩余：12 条待下载；正在：逐条下载；卡点：暂未确认"),
		"已完成：12 条重新对账；剩余：12 条待下载；正在：逐条下载；卡点：暂未确认",
		"a model-said 暂未确认 passes through unchanged",
	);
	assert.equal(
		standardizeProgressReport("已完成：12 条重新对账；剩余：12 条待下载；正在：逐条下载；卡点：无"),
		"已完成：12 条重新对账；剩余：12 条待下载；正在：逐条下载；卡点：无",
		"an explicit 无 (model's call, instruction-gated) stays 无",
	);
});

test("standardizeProgressReport clamps each field INDEPENDENTLY: a long 已完成 never amputates the 卡点", () => {
	// 已完成 ~144 chars, 卡点 ~90 chars — the old global 180-char slice cut
	// mid-report and could drop the whole 卡点 item.
	const doneBody = "逐条下载对账文件并核对金额差异，完成前三批共一百二十条记录的重新对账，".repeat(4);
	const blockedBody = "第四批数据依赖的财务接口返回超时，导致剩余对账无法继续，需要等待运维恢复服务后重试，同时已经把差异清单发给负责人确认口径，等待回复后继续处理剩余部分，并请运维同步恢复进度与预计时间";
	assert.ok(doneBody.length > 120 && blockedBody.length > 80, "fixture fields must really exceed their per-field caps");
	const out = standardizeProgressReport(`已完成：${doneBody}；剩余：12 条待下载检查；正在：逐条下载最新对账文件；卡点：${blockedBody}`);
	assert.ok(out, "a four-field report normalizes");
	// The 卡点 item exists WITH content — not amputated by the long 已完成.
	assert.match(out, /卡点：第四批数据依赖的财务接口返回超时/);
	// Each field is clamped to its own budget, not a shared one.
	const fieldOf = (label) => new RegExp(`${label}：([\\s\\S]*?)(?=；[已完成剩余正在卡点]{2,3}：|$)`).exec(out)[1];
	assert.ok(fieldOf("已完成").length <= 51, `done clamped per-field (got ${fieldOf("已完成").length})`);
	assert.ok(fieldOf("卡点").length <= 81, `blocked clamped to its OWN 80-char cap (got ${fieldOf("卡点").length})`);
	assert.ok(fieldOf("已完成").endsWith("…") && fieldOf("卡点").endsWith("…"), "both overlong fields got a clean ellipsis");
});

test("卡点 has an INDEPENDENT 80-char cap: 70 chars pass unclamped while a 60-char 已完成 is cut at 50 (review L)", () => {
	const blocked70 = "财务接口超时未恢复，运维已介入排查，预计下午三点前恢复，期间剩余批次暂停处理避免脏数据".padEnd(70, "待");
	assert.equal(blocked70.length, 70, "fixture must exceed the shared 50 cap but fit the 卡点 80 cap");
	const done60 = "完成前三批对账并提交差异复核".repeat(5).slice(0, 60);
	assert.equal(done60.length, 60, "fixture must exceed the 50 cap");
	const out = standardizeProgressReport(`已完成：${done60}；剩余：x；正在：y；卡点：${blocked70}`);
	const fieldOf = (label) => new RegExp(`${label}：([\\s\\S]*?)(?=；[已完成剩余正在卡点]{2,3}：|$)`).exec(out)[1];
	assert.equal(fieldOf("卡点"), blocked70, "70 chars survive under the independent 80-char cap");
	assert.ok(fieldOf("已完成").length <= 51 && fieldOf("已完成").endsWith("…"), "60-char done is still clamped at 50");
});

test("standardizeProgressReport does not reject ordinary English words (Goal as vocabulary)", () => {
	const out = standardizeProgressReport("已完成：完成 Goal 分解并下载全部文件；剩余：数据入库；正在：核对入库条数；卡点：无");
	assert.equal(out, "已完成：完成 Goal 分解并下载全部文件；剩余：数据入库；正在：核对入库条数；卡点：无");
});

// ── clamping primitive ──

test("clampField keeps short text as-is and cuts long text at a clause boundary with an ellipsis", () => {
	assert.equal(clampField("短内容", 50), "短内容");
	assert.equal(clampField("  多  段 空白  ", 50), "多 段 空白", "whitespace collapses");
	const long = "第一分句，内容较多需要截断；第二分句也很长；第三分句在预算之外继续延伸下去直到远远超出限制为止";
	const clamped = clampField(long, 30);
	assert.ok(clamped.length <= 31, `clamped to budget (got ${clamped.length})`);
	assert.ok(clamped.endsWith("…"));
	assert.ok(!/[，,；;。]$/.test(clamped.slice(0, -1)), "no dangling punctuation right before the ellipsis");
});

// ── transcript scan (string-in/string-out) ──

test("extractProgressFromTexts takes the NEWEST qualifying text, skipping templates and blobs", () => {
	const older = "已完成：第一批 8 条；剩余：16 条；正在：下载第二批；卡点：无";
	const template = "## Goal 跟踪处理掉单\n## Constraints & Preferences\n- 处理流程";
	const blob = "正在继续处理中";
	const newest = "已完成：24 条全部对账；剩余：0 条；正在：生成汇总；卡点：无";
	assert.deepEqual(extractProgressFromTexts([older, template, blob, newest]), {
		done: "24 条全部对账",
		remaining: "0 条",
		doing: "生成汇总",
		blocked: "无",
	});
	// Only template + blob → null (an unknown summary is never classified as facts).
	assert.equal(extractProgressFromTexts([template, blob]), null);
	assert.equal(extractProgressFromTexts([]), null);
});

test("extractProgressFromTexts: a SINGLE label is prose, not evidence — ≥2 distinct labels required (review M1)", () => {
	// Casual narration carries one 「已完成：/卡点：」 phrase all the time —
	// treating it as a report let an old task's numbers fill the new task.
	assert.equal(extractProgressFromTexts(["已完成：对账文件下载，继续核对中"]), null, "one label alone is not a report");
	assert.equal(extractProgressFromTexts(["卡点：财务接口超时，等待运维恢复"]), null, "a lone 卡点 mention is not a report");
	assert.equal(extractProgressFromTexts(["已完成：第一批 8 条", "卡点：无"]), null, "two single-label turns still do not combine into a report");
	// Two DISTINCT labels in ONE message qualify.
	assert.deepEqual(extractProgressFromTexts(["已完成：第一批 8 条；剩余：16 条待处理"]), {
		done: "第一批 8 条",
		remaining: "16 条待处理",
		doing: null,
		blocked: null,
	});
	// The newest QUALIFYING text wins over a newer single-label narration.
	const full = "已完成：24 条全部对账；剩余：0 条；正在：生成汇总；卡点：无";
	assert.deepEqual(extractProgressFromTexts([full, "已完成：口头一提"])?.done, "24 条全部对账");
});

test("template-heading fragments inside a field never reach the user (review L)", () => {
	assert.ok(containsTemplateHeadingLine("已完成：x\n## Goal 旧标题"), "a heading line inside content is detected");
	assert.ok(!containsTemplateHeadingLine("已完成：完成 Goal 分解"), "a mid-sentence word is not a heading");
	assert.ok(!containsTemplateHeadingLine("## 已完成\n12 条"), "Chinese headings are not template fragments");

	// standardize: a report contaminated by an English template heading is
	// rejected wholesale → the caller falls back instead of showing the leak.
	assert.equal(
		standardizeProgressReport("已完成：下载完成\n## Goal 旧任务标题\n剩余：12 条；正在：下载；卡点：无"),
		null,
		"a template heading inside a field rejects the report",
	);
	// extractProgressFromTexts: the contaminated candidate is skipped; an older
	// clean report still qualifies.
	const clean = "已完成：第一批 8 条；剩余：16 条；正在：下载；卡点：无";
	assert.deepEqual(extractProgressFromTexts([clean, "已完成：下载完成\n## Goal 旧标题\n剩余：12 条"])?.done, "第一批 8 条");
	// formatDeterministicBrief: a contaminated value degrades to 暂未确认.
	const brief = formatDeterministicBrief({ done: "下载完成 ## Goal 旧标题", remaining: null, doing: null, blocked: null });
	assert.ok(!brief.includes("## Goal"), "the fragment is never shown");
	assert.ok(brief.includes("已完成：暂未确认"), "the contaminated field degrades to unknown");
	const headed = formatDeterministicBrief(null, "## Goal 旧标题");
	assert.ok(!headed.includes("## Goal") && !headed.includes("任务："), "a contaminated task name drops the head");
});

// ── the deterministic fallback body ──

test("formatDeterministicBrief: unevidenced fields read 暂未确认, never an invented 无", () => {
	const brief = formatDeterministicBrief(null);
	assert.ok(brief.includes("已完成：暂未确认"));
	assert.ok(brief.includes("剩余：暂未确认"));
	// 卡点 is the exception (field request 2026-10-10): a running task with no
	// known blocker is normal — 暂未确认 would imply something we failed to find.
	assert.ok(brief.includes("卡点：暂无"));
	assert.ok(!brief.includes("卡点：暂未确认"));
	assert.ok(brief.includes("正在：任务执行中，正在核实最新进展"), "the honest generic active-step line");
	assert.ok(!brief.includes("卡点：无"), "unknown must not be reported as 无");
	assert.ok(!brief.includes("## Goal"), "no template headings, ever");
});

test("formatDeterministicBrief: a template-CONTAMINATED 卡点 also reads 暂无 (never the fragment)", () => {
	// 污染值被丢弃后「没有已知障碍」是事实为真的弱声明；把片段留给用户才是
	// review L2 的钉子。
	const brief = formatDeterministicBrief({ done: "下载完成", remaining: "剩余", doing: "执行", blocked: "## Goal 旧标题" });
	assert.ok(brief.includes("卡点：暂无"), "a contaminated 卡点 degrades to 暂无");
	assert.ok(!brief.includes("## Goal"), "the fragment never reaches the user");
	assert.ok(!brief.includes("卡点：暂未确认"), "卡点 never falls back to 暂未确认 here");
});

test("formatDeterministicBrief: evidenced fields pass through; partial evidence fills only the gaps", () => {
	const full = formatDeterministicBrief({ done: "12 条重新对账", remaining: "12 条待下载", doing: "逐条下载", blocked: "无" }, "跟踪处理掉单异常");
	assert.ok(full.includes("任务：跟踪处理掉单异常。"), "the sanitized task name heads the brief");
	assert.ok(full.includes("已完成：12 条重新对账"));
	assert.ok(full.includes("剩余：12 条待下载"));
	assert.ok(full.includes("正在：逐条下载"));
	assert.ok(full.includes("卡点：无"), "an evidenced 无 survives");
	assert.ok(!full.includes("暂未确认"), "nothing left to fill");

	const partial = formatDeterministicBrief({ done: "第一批完成", remaining: null, doing: null, blocked: null });
	assert.ok(partial.includes("已完成：第一批完成"));
	assert.ok(partial.includes("剩余：暂未确认"));
	assert.ok(partial.includes("正在：任务执行中，正在核实最新进展"));
	assert.ok(partial.includes("卡点：暂无"), "unevidenced 卡点 reads 暂无");
	assert.ok(!partial.includes("任务："), "no task-name head when none was given");
});

test("formatDeterministicBrief: the head label distinguishes 任务 (curated summary) from 当前请求 (quoted request) — review L", () => {
	const fromSummary = formatDeterministicBrief(null, "跟踪处理掉单异常", "任务");
	assert.ok(fromSummary.includes("任务：跟踪处理掉单异常。"));
	const fromRequest = formatDeterministicBrief(null, "把上周掉单明细整理成表格", "当前请求");
	assert.ok(fromRequest.includes("当前请求：把上周掉单明细整理成表格。"), "a quoted request is labeled 当前请求, never 任务");
	assert.ok(!fromRequest.includes("任务：把上周"), "no mislabeling");
	// Default label stays 任务 for backwards compatibility.
	assert.ok(formatDeterministicBrief(null, "x任务").includes("任务：x任务。"));
});

test("formatDeterministicBrief clamps an overlong task name", () => {
	const longTask = "统计九月一日至二十七日全部渠道的对账异常并筛选重复支付掉单与金额不一致的记录形成周报同步给财务与运营两方负责人".repeat(2);
	const brief = formatDeterministicBrief(null, longTask);
	assert.ok(brief.includes("任务："), "the head is present");
	const head = /任务：([\s\S]*?)。已完成/.exec(brief)?.[1] ?? "";
	assert.ok(head.length <= 41, `task name clamped (got ${head.length})`);
});
