/**
 * Field regression 2026-11-04: the scheduled-progress push hard-cut the last
 * progress text with slice(-500) — mid-sentence, under a full title — which
 * every reader took for a delivery bug. The tailExcerpt contract: short text
 * passes through; long text keeps the TRAILING COMPLETE PARAGRAPHS and marks
 * the excerpt; the cut never lands mid-sentence.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.tail-excerpt-test");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: { contents: `export { tailExcerpt } from "./src/scheduler/work-service.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { tailExcerpt } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

test("short text passes through intact", () => {
	assert.equal(tailExcerpt("完整短文本", 500), "完整短文本");
});

test("long text: cut lands on a paragraph boundary, excerpt marked, head dropped", () => {
	const long = "第一段很长的进展描述。".repeat(60) + "\n\n第二段：重复支付退款失败 1 笔（流水 0262026110200003667，乐清市）：17:00 窗口查流水退款状态。\n\n第三段：下次跟进安排。";
	const out = tailExcerpt(long, 500);
	assert.ok(out.startsWith("……（以下为上次进展的节选）"), "excerpt marker present");
	const body = out.replace("……（以下为上次进展的节选）\n\n", "");
	assert.ok(!body.startsWith("第一段"), "head paragraph dropped");
	assert.ok(body.startsWith("第二段：") || body.startsWith("第三段："), "cut at paragraph boundary, never mid-sentence");
});

test("no blank line in the window falls back to a line boundary", () => {
	const out = tailExcerpt("A".repeat(600), 500);
	assert.ok(out.length <= 520 + 20, "bounded output");
});

test("degenerate: excerpt collapses to empty → keep the raw window, never an empty push", () => {
	const out = tailExcerpt("无分段长文本".repeat(120), 500);
	assert.ok(out.length > 0);
});
