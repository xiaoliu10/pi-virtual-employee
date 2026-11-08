import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Field 2026-11-08 (Nova): asked to query a payment-channel order log over an
// X11 remote desktop (19 digits typed key-by-key), the run hit the 20-step tool
// cap. The user received ONLY a task summary — no reason it stopped, no way to
// continue — because the reply was `capSummary || notice`: a successful summary
// short-circuited the explanation. The context-budget sibling branch already
// concatenates notice+summary; the cap branch must do the same.

const root = process.cwd();
const dir = mkdtempSync(join(root, "node_modules/.cap-hit-"));
const bundle = join(dir, "cap-hit.mjs");
await build({
	stdin: {
		contents: `export { formatCapHitReply } from "./src/engine/engine.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { formatCapHitReply } = await import(pathToFileURL(bundle).href);

console.log("== cap-hit reply keeps the cause when a summary exists ==");
const summary = "**本次任务总结：**\n已成功的步骤：1. 堡垒机登录…\n当前卡点：还差 16 位数字没打完";
const reply = formatCapHitReply(20, summary);
assert.match(reply, /⚠️ 本轮工具调用已达上限（20 步）/, "the cause must be present");
assert.match(reply, /任务尚未完成/, "and say the task is unfinished");
assert.match(reply, /回复「继续」/, "and give a concrete next step");
assert.match(reply, /maxToolSteps/, "and name the knob");
assert.ok(reply.includes(summary), "the summary itself is kept");
assert.ok(reply.indexOf("⚠️") < reply.indexOf("本次任务总结"), "cause comes BEFORE the summary");

console.log("== empty summary falls back to the plain cap notice ==");
for (const empty of [null, undefined, "", "   "]) {
	const r = formatCapHitReply(20, empty);
	assert.match(r, /本轮已达到工具调用上限（20 步）/);
	assert.doesNotMatch(r, /以下是本轮已完成的进展/, "no dangling 'here is the progress' with no progress");
}

console.log("== the step count is the configured value ==");
assert.match(formatCapHitReply(50, summary), /50 步/);

console.log("\nPASS: 3 cap-hit reply checks");
