/**
 * Report-link dedupe tests. Run with `npm run test:report-link`.
 *
 * Field incident 2026-09-21: a scheduled-task push carried TWO report links
 * with DIFFERENT reportIds — save_report published and 小派 embedded its URL,
 * then the scheduler published the same reply AGAIN and appended its own link.
 * The scheduler must defer to a reply that already cites a report link.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.report-link-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "report-link.mjs");
await build({
	stdin: {
		contents: `export { replyHasReportLink } from "./src/engine/tools/reports.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { replyHasReportLink } = await import(pathToFileURL(bundle).href);

test("a reply that cites the save_report line already has a link", () => {
	assert.ok(replyHasReportLink("已保存「日报」到产物中心。访问链接：https://x/reports/6c45ac07-1f05/8e7717a4.html\n\n请把这个链接发给用户。"));
	assert.ok(replyHasReportLink("详见：📎 查看报告：https://reports-bucket.oss-cn-hangzhou.aliyuncs.com/reports/6c45ac07-1f05-4e9d-bc71-b755c27268ca/8e7717a4-1d09-4761-9212-67d0ed946d8a.html"));
	assert.ok(replyHasReportLink("结果见 https://reports-bucket.oss-cn-hangzhou.aliyuncs.com/reports/bfab8ebe-05c7/479d9538.html 如上。"));
});

test("a plain reply without any report link does not trip the detector", () => {
	assert.equal(replyHasReportLink("对账已完成，仍有 126 行未导入。"), false);
	assert.equal(replyHasReportLink(""), false);
	assert.equal(replyHasReportLink("见 https://example.com/x.html 报告"), false);
	assert.equal(replyHasReportLink("访问 https://example.com/reports/ 查看"), false, "bare /reports/ with no id must not match");
});
