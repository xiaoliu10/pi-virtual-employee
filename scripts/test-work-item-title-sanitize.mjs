/**
 * sanitizeWorkItemTitle (2026-11-11): a work item's STORED title can carry the
 * compaction template's Goal section (the model passed "## Goal\n- 继续排查…"
 * as the create title), and the progress broadcaster echoed it verbatim as
 * 「⏳ **## Goal\n- …** 任务仍在进行中」. These tests pin the sanitizer on the
 * verbatim field sample plus the markdown/whitespace/clamp behaviors.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.title-sanitize-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const bundle = join(dir, "ts.mjs");
await build({
	stdin: {
		contents: `export { sanitizeWorkItemTitle } from "./src/engine/progress.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { sanitizeWorkItemTitle } = await import(pathToFileURL(bundle).href);

test("field case: template Goal section with newline collapses to its text", () => {
	const raw = "## Goal\n- 继续排查流水 0342026111100001174 的支付渠道下单日志，定位下单环节是否存在异常。";
	const out = sanitizeWorkItemTitle(raw);
	assert.ok(!out.includes("##"), `heading leaked: ${out}`);
	assert.ok(!out.includes("\n"), `newline leaked: ${JSON.stringify(out)}`);
	assert.ok(out.startsWith("继续排查流水"), out);
});

test("template heading followed by text on the same line is stripped", () => {
	assert.equal(sanitizeWorkItemTitle("## Goal跟踪处理订单"), "跟踪处理订单");
	assert.equal(sanitizeWorkItemTitle("## Goal: 每日对账"), "每日对账");
});

test("plain titles pass through unchanged", () => {
	assert.equal(sanitizeWorkItemTitle("每日对账巡检"), "每日对账巡检");
	assert.equal(sanitizeWorkItemTitle("Track payment log for order 1234"), "Track payment log for order 1234");
});

test("markdown markers and bullets are stripped", () => {
	assert.equal(sanitizeWorkItemTitle("- 排查日志"), "排查日志");
	assert.equal(sanitizeWorkItemTitle("## 对账任务"), "对账任务");
	assert.equal(sanitizeWorkItemTitle("**加粗**标题"), "加粗标题");
});

test("all whitespace collapses to single spaces (single-line display label)", () => {
	assert.equal(sanitizeWorkItemTitle("排查  流水\n下单日志\t异常"), "排查 流水 下单日志 异常");
});

test("long titles clamp at a clause boundary", () => {
	const out = sanitizeWorkItemTitle("继续排查流水支付渠道下单日志，定位下单环节是否存在异常并输出结论报告");
	assert.ok(out.length <= 40, `too long: ${out.length}`);
});

test("empty/contamination-only input degrades to the placeholder", () => {
	assert.equal(sanitizeWorkItemTitle(""), "未命名任务");
	assert.equal(sanitizeWorkItemTitle("   "), "未命名任务");
	assert.equal(sanitizeWorkItemTitle("## Goal"), "未命名任务");
});
