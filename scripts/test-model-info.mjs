/**
 * Gateway model-info parsing tests. Run with `npm run test:model-info`.
 *
 * Resolution order for max output tokens (user ruling 2026-09-23):
 * per-model config override → gateway /model/info → static fallback.
 * These tests pin the PARSER: a wrong-shape or missing-model response must
 * yield null ("no information"), never a fabricated cap.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.modelinfo-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "model-info.mjs");
await build({
	stdin: { contents: 'export { parseModelInfoResponse } from "./src/engine/model-info.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { parseModelInfoResponse } = await import(pathToFileURL(bundle).href);

test("parses the litellm /model/info shape (nested model_info, max_output_tokens)", () => {
	const json = {
		data: [{
			model_name: "qwen",
			litellm_params: { model: "openai/qwen" },
			model_info: { max_tokens: 204800, max_output_tokens: 32768, max_input_tokens: 172032 },
		}],
	};
	const info = parseModelInfoResponse(json, "qwen");
	assert.equal(info?.maxOutputTokens, 32768);
	assert.equal(info?.maxInputTokens, 172032);
});

test("older shape without max_output_tokens falls back to max_tokens", () => {
	const json = { data: [{ model_name: "qwen", model_info: { max_tokens: 8192 } }] };
	assert.equal(parseModelInfoResponse(json, "qwen")?.maxOutputTokens, 8192);
});

test("fields at the top level (non-nested variant) are honored", () => {
	const json = { data: [{ model_name: "qwen", max_output_tokens: 4096 }] };
	assert.equal(parseModelInfoResponse(json, "qwen")?.maxOutputTokens, 4096);
});

test("a model not in the list is null, never a fabricated cap", () => {
	const json = { data: [{ model_name: "gpt-4o", model_info: { max_output_tokens: 16384 } }] };
	assert.equal(parseModelInfoResponse(json, "qwen"), null);
});

test("garbage shapes are null: no data array, wrong types, zero/negative values", () => {
	assert.equal(parseModelInfoResponse(null, "qwen"), null);
	assert.equal(parseModelInfoResponse({}, "qwen"), null);
	assert.equal(parseModelInfoResponse({ data: "oops" }, "qwen"), null);
	assert.equal(parseModelInfoResponse({ data: [{ model_name: "qwen" }] }, "qwen"), null, "entry with no numeric info");
	assert.equal(parseModelInfoResponse({ data: [{ model_name: "qwen", model_info: { max_output_tokens: -5 } }] }, "qwen"), null);
});
