#!/usr/bin/env node
/**
 * Tool-registry wiring regression (zombie-scan 2026-10-17).
 *
 * The prompt_lab failure mode: the tool module, its tests, the engine plumbing
 * (setPromptLab / runEvalTurn / buildPromptWithRules) and the options fields
 * were ALL in place since 0.2.66 — but the registration line inside
 * buildTools() never was, so the model never saw the tool. Tool-level tests
 * could not catch that; only a registry-level test can.
 *
 * Pins:
 *  - with promptLab + runEvalTurn + buildPromptWithRules provided → the
 *    registry CONTAINS prompt_lab (wired);
 *  - without them → it does NOT (conditional registration stays conditional).
 *
 * Run with `node --test scripts/test-tool-registry-wiring.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(new URL("..", import.meta.url).pathname);

async function loadBuildTools() {
	const dir = await mkdtemp(join(root, "node_modules/.wiring-"));
	const outfile = join(dir, "definition.mjs");
	await build({
		stdin: { contents: `export { buildTools } from "./src/engine/definition.ts";`, resolveDir: root, loader: "ts" },
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		logLevel: "error",
	});
	return (await import(pathToFileURL(outfile).href)).buildTools;
}

/** Minimal options: only the required fields plus the ones under test. */
function baseOptions(extra = {}) {
	return {
		config: { all: () => ({ security: { adminStaffIds: ["admin"], defaultRole: "viewer", people: [] } }) },
		resolveActor: () => ({ senderId: "admin", channel: "dingtalk", chatType: "single", text: "x" }),
		conversationId: "dt:admin",
		kbEnabled: false,
		learnEnabled: false,
		...extra,
	};
}

test("wiring: prompt_lab IS registered when promptLab + eval callbacks are provided", async () => {
	const buildTools = await loadBuildTools();
	const tools = buildTools(baseOptions({
		promptLab: { listCases: () => [], seedCases: () => 0 },
		runEvalTurn: async () => "ok",
		buildPromptWithRules: (rules) => rules,
	}));
	const names = tools.map((t) => t.name);
	assert.ok(names.includes("prompt_lab"), `prompt_lab missing from registry; got: ${names.join(", ")}`);
});

test("wiring: prompt_lab stays ABSENT when the lab deps are not provided", async () => {
	const buildTools = await loadBuildTools();
	const tools = buildTools(baseOptions({}));
	const names = tools.map((t) => t.name);
	assert.ok(!names.includes("prompt_lab"), "prompt_lab registered without deps — conditional registration broke");
});
