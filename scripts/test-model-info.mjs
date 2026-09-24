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
	stdin: { contents: 'export { parseModelInfoResponse, resolveEffectiveLimits } from "./src/engine/model-info.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { parseModelInfoResponse, resolveEffectiveLimits } = await import(pathToFileURL(bundle).href);

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

test("max_tokens alone is the CONTEXT ceiling, never the output cap (field 2026-09-23)", () => {
	// litellm custom entries report max_tokens = context (131072) with no
	// max_output_tokens. Reading that as output re-created the fictional
	// reservation and collapsed the budget to ~57K → constant
	// "compaction couldn't free enough space" while the gateway served 150K-input requests.
	const json = { data: [{ model_name: "qwen", model_info: { max_tokens: 131072 } }] };
	const info = parseModelInfoResponse(json, "qwen");
	assert.equal(info?.maxOutputTokens, undefined, "context must not masquerade as the output cap");
	assert.equal(info?.contextLength, 131072);
});

test("nested max_output_tokens wins over max_tokens for the output cap", () => {
	const json = { data: [{ model_name: "qwen", model_info: { max_tokens: 204800, max_output_tokens: 32768 } }] };
	const info = parseModelInfoResponse(json, "qwen");
	assert.equal(info?.maxOutputTokens, 32768);
	assert.equal(info?.contextLength, 204800);
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

test("a gateway that only reports max_input_tokens still yields usable info", () => {
	// Real litellm gateway (verified 2026-09-24): qwen reports ONLY
	// max_input_tokens=172800 — max_tokens/max_output_tokens/context_length all null.
	const json = { data: [{ model_name: "qwen", model_info: { max_input_tokens: 172800 } }] };
	const info = parseModelInfoResponse(json, "qwen");
	assert.equal(info?.maxInputTokens, 172800, "the one real signal must survive parsing");
	assert.equal(info?.maxOutputTokens, undefined);
	assert.equal(info?.contextLength, undefined);
});

test("resolveEffectiveLimits: user arithmetic 204800 − 172800 = 32000 output", () => {
	// User ruling 2026-09-24: with the total window pinned and the gateway
	// reporting only the input ceiling, output is DERIVED, not guessed.
	const base = { contextWindow: 131072, maxTokens: 32768 }; // inherited registry junk
	const r = resolveEffectiveLimits(base, { maxInputTokens: 172800 }, { hasCtxOverride: true, ctxOverride: 204800 });
	assert.equal(r.contextWindow, 204800, "the pinned window wins");
	assert.equal(r.maxTokens, 32000, "output = pinned window − gateway input ceiling");
});

test("resolveEffectiveLimits: no window pin → window adopts input ceiling + output fallback", () => {
	const r = resolveEffectiveLimits({ contextWindow: 131072, maxTokens: 32768 }, { maxInputTokens: 172800 }, { hasCtxOverride: false });
	assert.equal(r.contextWindow, 205568, "172800 input + 32768 output fallback");
	assert.equal(r.maxTokens, 32768);
});

test("resolveEffectiveLimits: gateway-reported output cap wins over derivation", () => {
	const r = resolveEffectiveLimits({ contextWindow: 204800, maxTokens: 32768 }, { maxInputTokens: 172800, maxOutputTokens: 16384 }, { hasCtxOverride: true, ctxOverride: 204800 });
	assert.equal(r.maxTokens, 16384);
});

test("resolveEffectiveLimits: no gateway info → base unchanged", () => {
	const base = { contextWindow: 131072, maxTokens: 32768 };
	const r = resolveEffectiveLimits(base, null, { hasCtxOverride: false });
	assert.deepEqual(r, base);
});
