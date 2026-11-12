/**
 * workerTaskTitle (2026-11-11): user-facing worker notices derived their title
 * from `instruction.slice(0, 60)` — a pasted article/code block produced
 * garbage like 「import ddddocr _ocr = ddddocr.DdddOcr(show_ad=False) def sol」
 * (field: box Nova, dt:manager5792 progress notes). These tests pin the
 * readable-title derivation: fence stripping, markdown markers, first-line
 * pick, whitespace collapse, sentence-boundary clamp, stub protection, and
 * the empty fallback.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.worker-title-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const bundle = join(dir, "wt.mjs");
await build({
	stdin: {
		contents: `export { workerTaskTitle } from "./src/router/worker-service.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { workerTaskTitle } = await import(pathToFileURL(bundle).href);

test("field case: unfenced code paste collapses to its first line", () => {
	const instruction = "import ddddocr\n\n_ocr = ddddocr.DdddOcr(show_ad=False)\n\ndef solve_captcha(png_bytes: bytes, min_conf: float = 0.5) -> dict:\n    ...";
	assert.equal(workerTaskTitle(instruction), "import ddddocr");
});

test("field case: long prose paste clamps at a sentence boundary", () => {
	const instruction = "有解决方案——根因是工具用错了类别：生成式图像模型（seedream 那类文生图/改图模型）没有感知能力，读文字全靠幻觉；通用 VLM 对小图确实弱。这类验证码的正确工具是专用 OCR。";
	const title = workerTaskTitle(instruction);
	assert.ok(title.length <= 40, `title too long: ${title.length}`);
	assert.ok(title.startsWith("有解决方案"), title);
	// never a mid-word hard cut when a boundary exists inside the window
	assert.ok(/[。！？；；，, ]$/.test(title) === false, `ends mid-clause: ${title}`);
});

test("short instruction passes through unchanged", () => {
	assert.equal(workerTaskTitle("查一下明天天气"), "查一下明天天气");
	assert.equal(workerTaskTitle("rerun the etl job"), "rerun the etl job");
});

test("fenced code blocks are stripped before picking the first line", () => {
	const instruction = "```python\nimport ddddocr\n_ocr = ddddocr.DdddOcr()\n```\n验证这个方案能不能识别验证码";
	assert.equal(workerTaskTitle(instruction), "验证这个方案能不能识别验证码");
});

test("markdown markers and list prefixes are stripped", () => {
	assert.equal(workerTaskTitle("## 任务：整理表格"), "任务：整理表格");
	assert.equal(workerTaskTitle("- 第一步：导出数据"), "第一步：导出数据");
	assert.equal(workerTaskTitle("**加粗标题**：继续执行"), "加粗标题：继续执行");
});

test("long single-line without boundaries falls back to a hard cut", () => {
	const instruction = "a".repeat(120);
	assert.equal(workerTaskTitle(instruction), "a".repeat(40));
});

test("punctuation too early in the window does not leave a stub", () => {
	// comma at char 3 (<40% of 40) must NOT produce a 3-char title
	const instruction = "短的。然后" + "很".repeat(60);
	const title = workerTaskTitle(instruction);
	assert.ok(title.length >= 16, `stub title: ${title}`);
});

test("whitespace-only instruction falls back to the placeholder", () => {
	assert.equal(workerTaskTitle("   \n\t  "), "未命名任务");
	assert.equal(workerTaskTitle(""), "未命名任务");
});

test("custom cap is honored", () => {
	const instruction = "有解决方案——根因是工具用错了类别：生成式图像模型没有感知能力";
	assert.equal(workerTaskTitle(instruction, 10).length <= 10, true);
});
