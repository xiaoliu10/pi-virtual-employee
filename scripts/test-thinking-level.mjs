import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();

// Bundle the REAL shared helper + the REAL config normalizer.
mkdirSync(join(root, "node_modules/.thinking-probe"), { recursive: true });
await build({
	entryPoints: [join(root, "src/db/config-store.ts")],
	bundle: true, format: "esm", platform: "node",
	outfile: join(root, "node_modules/.thinking-probe/config-store.mjs"),
	external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "electron"],
	logLevel: "silent",
});
await build({
	entryPoints: [join(root, "src/shared/thinking.ts")],
	bundle: true, format: "esm", platform: "node",
	outfile: join(root, "node_modules/.thinking-probe/thinking.mjs"),
	logLevel: "silent",
});
const thinking = await import(pathToFileURL(join(root, "node_modules/.thinking-probe/thinking.mjs")).href);
const { MODEL_THINKING_LEVELS, applyThinkingDeclaration } = thinking;
const { ConfigStore } = await import(pathToFileURL(join(root, "node_modules/.thinking-probe/config-store.mjs")).href);

const engineSrc = readFileSync(join(root, "src/engine/engine.ts"), "utf8");
const sidePassBody = (() => {
	const i = engineSrc.indexOf("async progressBriefDetailed");
	return engineSrc.slice(i, i + 9000);
})();

function makeStore(seed = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const store = new ConfigStore(db);
	if (Object.keys(seed).length) store.replaceAll(seed);
	return { store, db };
}

// ---------------------------------------------------------------------------
// BEHAVIORAL PROBE: drive the REAL pi-ai streamSimple the way the engine does,
// capturing the exact payload that would hit the gateway. Both review rounds
// proved that source-regex assertions certify wrong designs; only the payload
// is the contract.
// ---------------------------------------------------------------------------
const { createModels, clampThinkingLevel } = await import("@earendil-works/pi-ai");
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
const models = createModels();
for (const p of builtinProviders()) models.setProvider(p);

// A qwen thinkingFormat base (like litellm-fronted qwen) + a non-reasoning base
// (like the groq llama that VE's openai supplier search borrows).
let qwenBase, plainBase;
for (const p of models.getProviders()) {
	for (const m of p.getModels?.() ?? []) {
		if (m.api !== "openai-completions") continue;
		if (!qwenBase && m.reasoning && m.compat?.thinkingFormat === "qwen") qwenBase = m;
		if (!plainBase && !m.reasoning) plainBase = m;
	}
}
assert.ok(qwenBase, "registry must contain a qwen-format reasoning model");
assert.ok(plainBase, "registry must contain a non-reasoning model");

/** Mimic withIdentity's relay semantics, then capture the gateway payload. */
async function relayPayload(declared, base = plainBase) {
	const cap = applyThinkingDeclaration(base, declared, true);
	// VE builds the qwen relay model with compat.thinkingFormat="qwen" (the real
	// gateway speaks qwen), but the BORROWED base is a non-reasoning groq model —
	// so capability must come from the declaration, not the base.
	const model = {
		...base, id: "relay-x", compat: { ...(base.compat ?? {}), thinkingFormat: "qwen" },
		reasoning: cap.reasoning,
		...(cap.thinkingLevelMap ? { thinkingLevelMap: cap.thinkingLevelMap } : { thinkingLevelMap: undefined }),
	};
	let payload;
	try {
		const level = declared && declared !== "off" ? declared : undefined;
		await models.streamSimple(model, { systemPrompt: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
			{ apiKey: "sk-t", maxTokens: 64, ...(level ? { reasoning: level } : {}), onPayload: (p) => { payload = p; return p; } }).result();
	} catch { /* unreachable gateway is fine — payload is built before network */ }
	return payload;
}

test("level list covers the pi levels incl. xhigh/max", () => {
	assert.deepEqual([...MODEL_THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("PROBE relay: declared xhigh actually turns gateway thinking on", async () => {
	// Round-3 P1: capability decoupling made every declared level clamp to off on
	// a non-reasoning borrowed base — NOTHING reached the gateway. For the qwen
	// thinkingFormat the contract is enable_thinking:true (the boolean switch);
	// under the broken design this was undefined (param omitted entirely).
	const payload = await relayPayload("xhigh");
	assert.equal(payload?.enable_thinking, true);
});

test("PROBE relay (non-reasoning borrowed base): declared off emits enable_thinking:false", async () => {
	// Round-2 P1: capability=false dropped the disable param entirely. Even on a
	// non-reasoning borrowed base, the declaration turns capability ON so the
	// qwen-format disable switch is emitted.
	const payload = await relayPayload("off");
	assert.equal(payload?.enable_thinking, false);
});

test("PROBE relay: undeclared keeps the borrowed base behavior (no thinking params)", async () => {
	// Old installs must not suddenly start sending thinking params.
	const cap = applyThinkingDeclaration(plainBase, undefined, true);
	assert.equal(cap.reasoning, plainBase.reasoning);
	const payload = await relayPayload(undefined);
	assert.equal(payload?.enable_thinking, undefined);
	assert.equal(payload?.reasoning_effort, undefined);
});

test("PROBE: declaration never overwrites a null (unsupported) marker (relay and registry)", () => {
	// Round-2 P2: {xhigh:null} + declared xhigh must keep clamping DOWN, not
	// promote the model into claiming support. Applies on both supplier kinds —
	// a relay base may itself carry a registry-derived map.
	const base = { reasoning: true, thinkingLevelMap: { high: "high", xhigh: null, max: null } };
	for (const isRelay of [true, false]) {
		const cap = applyThinkingDeclaration(base, "max", isRelay);
		assert.equal(cap.thinkingLevelMap?.max, null, `null marker preserved (isRelay=${isRelay})`);
		assert.equal(clampThinkingLevel({ reasoning: true, thinkingLevelMap: cap.thinkingLevelMap }, "max"), "high",
			`max degrades to high (isRelay=${isRelay})`);
	}
});

test("PROBE registry: undeclared capability untouched", () => {
	const base = { reasoning: false, thinkingLevelMap: undefined };
	const cap = applyThinkingDeclaration(base, undefined, false);
	assert.equal(cap.reasoning, false);
	assert.equal(cap.thinkingLevelMap, undefined);
});

test("config: keeps declared levels, drops junk values and non-strings", () => {
	const { store } = makeStore({
		model: {
			suppliers: [{
				id: "s1", name: "gw", enabled: true, apiType: "openai",
				baseUrl: "http://gw/v1", apiKey: "sk", models: ["qwen", "bad", "num"],
				modelThinkingLevel: { qwen: "xhigh", bad: "turbo", num: 42 },
			}],
			defaultSupplierId: "s1", defaultModelId: "qwen",
		},
	});
	const map = store.all().model.suppliers[0].modelThinkingLevel ?? {};
	assert.equal(map.qwen, "xhigh");
	assert.ok(!("bad" in map), "unknown level string dropped");
	assert.ok(!("num" in map), "non-string dropped");
});

test("config: absent declaration stays absent (inherit semantics preserved)", () => {
	const { store } = makeStore({
		model: {
			suppliers: [{ id: "s1", name: "gw", enabled: true, apiType: "openai", baseUrl: "http://gw/v1", apiKey: "sk", models: ["m1"] }],
			defaultSupplierId: "s1", defaultModelId: "m1",
		},
	});
	assert.equal(store.all().model.suppliers[0].modelThinkingLevel, undefined);
});

test("wiring: durable bridge forwards the declared level incl. off", () => {
	// Durable is the DEFAULT kernel — the Agent's thinkingLevel never reaches the
	// harness request without this bridge (Copilot round 1).
	const i = engineSrc.indexOf("async openDurableRuntime");
	const bridge = engineSrc.slice(i, i + 1800);
	assert.match(bridge, /const declared = supplier\.modelThinkingLevel\?\.\[modelId\];/);
	// Review round 4 P1 (probed): a literal "off" is truthy — anthropic-messages
	// models FORCE thinking on (adaptive→effort high, non-adaptive→max_tokens:null),
	// qwen off:null maps clamp to minimal→enable_thinking:true. "off" must strip to
	// undefined, which yields each provider's real disable shape.
	assert.match(bridge, /declared !== undefined && declared !== "off"\s*\?\s*\(declared as ThinkingLevel\)\s*:\s*undefined/,
		"declared off strips to reasoning:undefined (never a literal off payload)");
});

test("wiring: main turn default stays off; every switch path syncs the level", () => {
	assert.match(engineSrc, /thinkingLevel: \(supplier\.modelThinkingLevel\?\.\[modelId\] \?\? "off"\) as ThinkingLevel,/);
	const syncs = engineSrc.match(/agent\.state\.thinkingLevel = \([^\n]+as ThinkingLevel;/g) ?? [];
	assert.ok(syncs.length >= 3, `default loop, pin, unpin all sync (found ${syncs.length})`);
});

test("wiring: side pass reads the agent level; reserve follows the model max output", () => {
	// User ruling 2026-11-02: don't self-limit the side pass. The reserve must
	// follow the model's own max-output resolution (override → model-info → 32k
	// default), expressed as ceil(maxOut/0.8) because pi-ai takes 0.8×reserve.
	const i = engineSrc.indexOf("async progressBriefDetailed");
	const body = engineSrc.slice(i, i + 9000);
	assert.ok(!body.includes("findSupplier(model.provider)"), "no supplier lookup by registry provider id");
	assert.match(body, /agent\.state\.thinkingLevel/);
	assert.match(body, /model\.maxTokens && model\.maxTokens > 0 \? model\.maxTokens : 32_768/,
		"reserve follows the model max output, defaulting to 32k");
	assert.match(body, /Math\.ceil\(maxOut \/ 0\.8\)/,
		"reserve compensates pi-ai's 0.8 factor so the cap lands on maxOut");
	assert.ok(!body.includes("4_096,"), "hard-coded 4096 reserve removed");
	assert.ok(!body.includes("0.8×512 tokens"), "old 409 reserve gone");
});
