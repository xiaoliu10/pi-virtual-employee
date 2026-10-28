/**
 * Proactive-push chunking tests. Run with `npm run test:chunks`.
 *
 * Field incident 2026-09-20: scheduled-task report pushes were hard-cut at
 * 1200 characters ("…完整内容见报告链接") because DingTalk rejects one message
 * past ~4000 chars — the user lost the whole 场景分析 section of every daily
 * report. The fix: deliver the FULL text across at most 3 messages, split at
 * blank-line boundaries; only a text that even 3 messages cannot fit falls
 * back to a truncated head.
 *
 * Pinned properties: short text passes through as one part; long text splits
 * at "\n\n" boundaries with every part ≤ maxChars and nothing lost; oversized
 * text truncates at a clean boundary with an explicit note.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.chunks-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "chunks.mjs");
await build({
	stdin: {
		contents: `export { splitForPush } from "./src/im/chunks.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { splitForPush } = await import(pathToFileURL(bundle).href);

const section = (n, size) => `## 第 ${n} 节\n\n${"内容".repeat(size)}\n\n`;

test("short text passes through as a single part, untouched", () => {
	assert.deepEqual(splitForPush("短消息"), ["短消息"]);
	assert.deepEqual(splitForPush(""), []);
});

test("long report splits at paragraph boundaries with nothing lost", () => {
	const report = section(1, 600) + section(2, 600) + section(3, 600) + section(4, 600); // ~5000 chars
	const parts = splitForPush(report);
	assert.ok(parts.length > 1 && parts.length <= 3, `expected 2-3 parts, got ${parts.length}`);
	for (const p of parts) assert.ok(p.length <= 3800, `part over cap: ${p.length}`);
	for (const p of parts) assert.ok(!/(^|\n)#[^\n]*$/.test(p.trimEnd()), "no part may end on a heading stranded from its body");
	assert.equal(parts.join("\n\n").replace(/\s+/g, ""), report.replace(/\s+/g, ""), "content must survive the split");
	assert.ok(parts[0].includes("第 1 节"), "first part opens with the first section");
	assert.ok(parts.at(-1).includes("第 4 节"), "last part carries the tail");
});

test("split points prefer blank lines over mid-table cuts", () => {
	const table = ["| 排名 | 用户 | 费用 |", "|:--:|:--|---:|", ...Array.from({ length: 40 }, (_, i) => `| ${i + 1} | 用户${i} | ¥1${i} | `)].join("\n");
	const report = `# 日报\n\n${table}\n\n${"结论".repeat(2000)}`;
	const parts = splitForPush(report);
	assert.ok(parts.length >= 2);
	const lastLine = parts[0].trimEnd().split("\n").at(-1) ?? "";
	if (lastLine.startsWith("|")) {
		assert.ok(lastLine.trimEnd().endsWith("|"), `a table row must not be sliced mid-line, got: ${lastLine}`);
	}
});

test("text too big for maxParts truncates at a clean boundary with an explicit note", () => {
	const huge = "很长的段落。\n\n".repeat(2000); // ~20k chars > 3 × 3800
	const parts = splitForPush(huge);
	assert.equal(parts.length, 1);
	assert.ok(parts[0].length <= 3800 * 3 + 40, `truncated head must fit the budget: ${parts[0].length}`);
	assert.ok(parts[0].includes("已截断"), "the cut must be announced, never silent");
});

// ─── Table-preserving splits (field 2026-10-28: "表格格式不对") ───────────────
// A long report containing a table must never arrive as a headerless wall of
// pipes: tables are packed as whole blocks, and an oversized table is split by
// rows with the header repeated in every part.
const makeTable = (rows, cols = 5) =>
	[
		"| 日期 | 任务 | 状态 | 次数 | 耗时 |",
		"|---|---|---|---|---|",
		...Array.from({ length: rows }, (_, i) => `| 10-${String((i % 28) + 1).padStart(2, "0")} | 生产部署 | 成功 | ${1000 + i} | 12.3s |`),
	].join("\n");

const tableInfo = (part) => {
	const rows = part.split("\n").filter((l) => /^\s*\|/.test(l));
	const hasHeader = /^\s*\|.*\|\s*$/.test(rows[0] ?? "");
	const hasDelimiter = rows.some((l) => /^\s*\|\s*:?-{2,}/.test(l));
	return { count: rows.length, header: hasHeader && hasDelimiter };
};

test("a table larger than one message is split BY ROWS with the header repeated", () => {
	const report = `## 总览\n\n本周执行 120 次。\n\n## 分日明细\n\n${makeTable(120)}\n\n## 人工跟进\n\n- 3 条失败待查\n`;
	const parts = splitForPush(report);
	assert.ok(parts.length >= 2, `a 4.5k report must split, got ${parts.length}`);
	const tableParts = parts.filter((p) => tableInfo(p).count > 0);
	assert.ok(tableParts.length >= 2, "the table spans multiple parts");
	for (const part of tableParts) {
		const info = tableInfo(part);
		assert.ok(info.header, `every part holding table rows needs header+delimiter, got ${info.count} rows without one: ${part.slice(0, 60)}`);
	}
	// No row is lost or duplicated across parts.
	const total = tableParts.reduce((n, p) => n + tableInfo(p).count - 2, 0); // minus header+delimiter per part
	assert.equal(total, 120, `all 120 data rows preserved, got ${total}`);
	for (const part of parts) assert.ok(part.length <= 3800, `part within cap, got ${part.length}`);
});

test("a cut never lands inside a table (no half-tables)", () => {
	// Text before the table fills most of a message: the naive line-boundary cut
	// used to slice the first table rows off into the prose part.
	const prose = Array.from({ length: 60 }, (_, i) => `第 ${i} 行说明文字，用于填充长度。`).join("\n");
	const report = `${prose}\n\n${makeTable(10)}\n`;
	for (const part of splitForPush(report)) {
		const rows = part.split("\n").filter((l) => /^\s*\|/.test(l));
		if (rows.length === 0) continue;
		assert.ok(tableInfo(part).header, "a part with table rows must include the header, never a headerless fragment");
	}
});

test("a small table stays whole in one part", () => {
	const report = `## 明细\n\n${makeTable(3)}\n\n结束。\n`;
	const parts = splitForPush(report);
	assert.equal(parts.length, 1, "a short report is not split");
	assert.equal(tableInfo(parts[0]).count, 5, "header + delimiter + 3 rows");
});
