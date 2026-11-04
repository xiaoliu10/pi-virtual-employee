import { strict as assert } from "node:assert";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.side-pass-budget-test");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: { contents: `export { sidePassMaxTokens } from "./src/engine/side-pass-budget.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { sidePassMaxTokens } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

// Regression harness for the 2026-11-04 field incident: planTaskBrief hard-coded
// 512 (the magic number the 2026-11-02 ruling abolished), qwen's default-thinking
// blew the cap and every task plan was skipped. The helper is the single source
// of the side-pass budget — these cases pin its contract.

// Relay model with a real max-output window (gateway qwen: max_input 172800,
// derived output 32000 → resolved maxTokens lands here per model resolution).
assert.equal(sidePassMaxTokens({ maxTokens: 172800 }), Math.ceil(172800 / 0.8));
assert.equal(sidePassMaxTokens({ maxTokens: 172800 }), 216000);

// 32k relay default when the model carries no usable max-output.
assert.equal(sidePassMaxTokens({ maxTokens: 32768 }), 40960);

// No maxTokens / zero / negative → 32k default, never a tiny cap.
assert.equal(sidePassMaxTokens({}), 40960);
assert.equal(sidePassMaxTokens({ maxTokens: 0 }), 40960);
assert.equal(sidePassMaxTokens({ maxTokens: null }), 40960);
assert.equal(sidePassMaxTokens({ maxTokens: -5 }), 40960);
assert.equal(sidePassMaxTokens(undefined), 40960);

// The abolished regression: the budget must never be the old 512 (nor anything
// under the thinking+answer floor). Every case above already exceeds it, but
// spell the invariant out so a future "optimization" trips this loudly.
for (const m of [{ maxTokens: 172800 }, { maxTokens: 32768 }, {}, undefined]) {
	const budget = sidePassMaxTokens(m);
	assert.ok(budget >= 40960, `budget ${budget} regressed below the 2026-11-02 floor`);
}

console.log("test-side-pass-budget: all assertions passed");
