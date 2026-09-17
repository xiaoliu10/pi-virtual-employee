/**
 * manage_update status wording tests. Run with `node --test scripts/test-update.mjs`.
 *
 * Field incident this file exists for: a 0.2.66 box kept answering "已是最新版
 * 本，没有更高版本可下载" while 0.2.67/0.2.68 were already on the feed — status
 * was a cached conclusion from a check hours earlier, with no indicator of how
 * old that conclusion was, and the model presented it as a live fact.
 *
 * Pinned properties: the age of the last completed check is always visible
 * next to a "no update" verdict, a stale one carries an explicit warning to
 * re-check (action=check) instead of trusting the cache, and a fresh check does
 * not get spammed with the warning.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.update-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "update.mjs");
await build({
	stdin: {
		contents: `
			export { describeStatus, normalizeAutoUpdate } from "./src/engine/tools/update.ts";
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
const { describeStatus } = await import(pathToFileURL(bundle).href);

const base = (phase, extra = {}) => ({
	currentVersion: "0.2.66",
	phase,
	...extra,
});

test("a fresh 'no update' verdict carries the check time and no warning", () => {
	const now = Date.now();
	const text = describeStatus(base("none", { lastCheckAt: now - 5 * 60_000 }), "full");
	assert.match(text, /上次检查（5 分钟前）/);
	assert.doesNotMatch(text, /注意：/, "a freshly confirmed status must not be padded with the stale-warning");
});

test("an old 'no update' verdict is flagged instead of presented as current truth", () => {
	// The box in the field incident: checked ~9h earlier, two releases shipped since.
	const now = Date.now();
	const text = describeStatus(base("none", { lastCheckAt: now - 6 * 3_600_000 }), "full");
	assert.match(text, /上次检查（6 小时前）/);
	assert.match(text, /注意：/, "stale verdict must carry a warning");
	assert.match(text, /action=check 实时检查/, "the warning must point at the real check");
	assert.doesNotMatch(text, /已是最新版本/, "the old unconditional claim must be gone");
});

test("never-checked status cannot be used to claim anything about being latest", () => {
	const text = describeStatus(base("none"), "full");
	assert.match(text, /尚未完成过更新检查/);
	assert.match(text, /action=check/);
});

test("idle phase gets the same staleness treatment", () => {
	const text = describeStatus(base("idle"), "full");
	assert.match(text, /注意：/);
});

test("actionable phases are not padded with staleness noise", () => {
	for (const [phase, extra] of [
		["checking", {}],
		["available", { targetVersion: "0.2.69" }],
		["downloading", { targetVersion: "0.2.69", percent: 40 }],
		["ready", { targetVersion: "0.2.69" }],
		["error", { error: "network down" }],
	]) {
		const text = describeStatus(base(phase, extra), "full");
		assert.doesNotMatch(text, /注意：/, `${phase} output must not warn about staleness`);
	}
});

test("existing wording contracts keep their shape", () => {
	assert.match(describeStatus(base("available", { targetVersion: "0.2.69" }), "full"), /发现新版本 v0.2.69/);
	assert.match(describeStatus(base("ready", { targetVersion: "0.2.69" }), "download_only"), /回复「确认更新到最新版」/);
	assert.match(describeStatus(base("error", { error: "boom" }), "off"), /失败（boom）/);
});
