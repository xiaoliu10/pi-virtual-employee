/**
 * Knowledge-base consolidation tests. Run with `node --test scripts/test-knowledge.mjs`.
 *
 * Field incident this file exists for (2026-09-30): a production admin entry
 * carrying 管理地址 + 账号密码 was MERGED into a generic 「对账操作规范」
 * procedure entry by auto-consolidation. The values were preserved verbatim,
 * but the merged entry's title/tags ranked as a procedure topic — queries like
 * 「后台管理地址」 from other pages stopped matching, so the credentials became
 * effectively lost until restored by hand.
 *
 * So the pinned properties are: credential-bearing entries are refused from
 * merges and kept independent; the verbatim-preservation backstop still covers
 * ordinary merges; and the value extractor recognises the common credential
 * phrasings.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.knowledge-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "knowledge.mjs");
await build({
	stdin: {
		contents: `
			export { extractCriticalValues, ensureCriticalValuesPreserved, partitionMergeIds } from "./src/knowledge/consolidation.ts";
			export { bingSearch } from "./src/knowledge/research/web-search.ts";
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
const { extractCriticalValues, ensureCriticalValuesPreserved, partitionMergeIds, bingSearch } = await import(
	pathToFileURL(bundle).href
);

test("extractCriticalValues recognises the common credential phrasings", () => {
	const text = "生产环境后台管理地址：https://admin.example.com\n账号：ops_admin\n密码：Xyz123!@#";
	const values = extractCriticalValues(text).map((v) => v.value);
	assert.ok(values.includes("https://admin.example.com"), "url extracted");
	assert.ok(values.includes("ops_admin"), "account extracted");
	assert.ok(values.includes("Xyz123!@#"), "password extracted");

	assert.equal(extractCriticalValues("每天上午先做对账，再处理异常单").length, 0, "plain text has no critical values");
});

test("partitionMergeIds keeps credential entries out of merges", () => {
	// The exact field incident: a credentials entry proposed for merge with a
	// procedure entry. The credentials entry must stay independent.
	const contents = new Map([
		["a", "对账操作规范：每天上午核对前一日的支付流水，异常订单标记后人工复核。"],
		["b", "生产环境后台管理地址：https://admin.example.com，账号：ops_admin，密码：Xyz123!@#"],
	]);
	const { mergeable, protected: protectedIds } = partitionMergeIds(["a", "b"], (id) => contents.get(id));
	assert.deepEqual(protectedIds, ["b"], "credential entry is protected from the merge");
	assert.deepEqual(mergeable, ["a"], "procedure entry stays mergeable");

	// All-protected merge proposals leave nothing to merge.
	const all = partitionMergeIds(["b", "b"], (id) => contents.get(id));
	assert.equal(all.mergeable.length, 0);
});

test("ensureCriticalValuesPreserved still backstops ordinary merges verbatim", () => {
	// When the model drops a critical value from a mergeable source, it is
	// appended verbatim under the auto-preserved section.
	const source = "测试环境地址：https://test.example.com，账号：t1，密码：p@ss";
	const { content, restored } = ensureCriticalValuesPreserved("测试环境用于联调。", [source]);
	assert.equal(restored.length, 3, "all three dropped values restored");
	for (const v of ["https://test.example.com", "t1", "p@ss"]) {
		assert.ok(content.includes(v), `merged content carries ${v} verbatim`);
	}
	assert.ok(content.includes("关键信息"), "restored values land in the marked section");

	// Nothing to restore when the model kept the values.
	const kept = ensureCriticalValuesPreserved(`联调环境：${source}`, [source]);
	assert.equal(kept.restored.length, 0);
});

// ── bing engine: regex over b_algo blocks (field 2026-10-06: default engine reachable from CN) ──

test("bingSearch parses b_algo blocks into hits; decodeEntities and stripTags behave", async (t) => {
	const html = [
		'<li class="b_algo">',
		'  <h2><a href="https://example.com/a?q=1&amp;x=2" h="ID=SERP">快速<b>烹饪</b>指南</a></h2>',
		'  <p class="b_lineclamp">如何&#24555;速入门…包含 &quot;要点&quot; 与&nbsp;细节。</p>',
		"</li>",
		'<li class="b_algo">',
		'  <h2><a href="https://example.com/b">第二条</a></h2>',
		"</li>",
		'<li class="b_algo"><div>没有 h2 链接，应跳过</div></li>',
	].join("\n");
	const realFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = realFetch; });
	globalThis.fetch = async (url) => {
		assert.match(String(url), /cn\.bing\.com\/search\?q=/, "bing engine hits cn.bing.com");
		assert.match(String(url), /count=/, "topK passes as count");
		return { ok: true, status: 200, text: async () => html };
	};
	const hits = await bingSearch("测试查询", 5);
	assert.equal(hits.length, 2, "block without h2 link is skipped");
	assert.equal(hits[0].title, "快速烹饪指南");
	assert.equal(hits[0].url, "https://example.com/a?q=1&x=2", "entities decoded");
	assert.equal(hits[0].snippet, "如何快速入门…包含 \"要点\" 与 细节。", "numeric entities + nbsp decoded, tags stripped");
	assert.equal(hits[1].snippet, "", "missing paragraph degrades to empty snippet");
});
