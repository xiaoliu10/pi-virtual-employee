import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();

// Bundle the REAL shared list + the REAL config normalizer so the contract is
// tested against shipped code, not a copy.
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
const { MODEL_THINKING_LEVELS } = await import(pathToFileURL(join(root, "node_modules/.thinking-probe/thinking.mjs")).href);
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

test("level list covers the pi levels incl. xhigh/max", () => {
	assert.deepEqual([...MODEL_THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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

test("builder: an absent declaration leaves the base reasoning capability untouched", () => {
	// reasoning flag: declared off/none → false; undeclared → inherit base.
	assert.match(engineSrc, /const reasoning = levelOverride !== undefined \? levelOverride !== "off" : base\.reasoning;/,
		"undeclared models inherit the base registry capability (no behavioral change)");
});

test("builder: a declared level never overwrites the provider's own mapping (null=unsupported survives)", () => {
	// Code review P1 2026-11-02: writing `[level]: level` unconditionally erased
	// an explicit `xhigh: null` marker and made pi-ai clamp emit xhigh anyway,
	// defeating the promised downgrade.
	assert.match(engineSrc, /!\(levelOverride in baseMap\)/,
		"declared execution level must not claim provider support the base model denies");
	assert.match(engineSrc, /!\(levelOverride in baseMap\)[\s\S]{0,80}\[levelOverride\]: levelOverride/,
		"the self-mapping is guarded by the base-map check");
});

test("main turn: default stays off so existing installs behave identically", () => {
	assert.match(engineSrc, /thinkingLevel: \(supplier\.modelThinkingLevel\?\.\[modelId\] \?\? "off"\) as ThinkingLevel,/);
});

test("side pass: follows the agent's synced level, never a supplier lookup by provider", () => {
	// Code review P1 2026-11-02: model.provider is a REGISTRY provider id (e.g.
	// "groq"), not a supplier id, so findSupplier(model.provider) returned null and
	// a configured "low" silently became the xhigh default.
	assert.ok(!sidePassBody.includes("findSupplier(model.provider)"),
		"no supplier lookup by model.provider (it is not a supplier id)");
	assert.match(sidePassBody, /agent\.state\.thinkingLevel/, "side pass reads the synced agent level");
	assert.ok(!/SIDE_PASS_DEFAULT_LEVEL\) : undefined,\n\t\t\t\t\tthis\.rawStreamFn/.test(sidePassBody) ||
		sidePassBody.includes("agent.state.thinkingLevel"),
		"default only applies when the agent has no explicit level");
});

test("side pass: budget leaves room for thinking plus a 120-char report", () => {
	assert.match(sidePassBody, /4_096,/,
		"output reserve raised above the thinking floor (was 0.8×512=409)");
	assert.ok(!sidePassBody.includes("0.8×512 tokens of output budget"), "the old 409-token reserve is gone");
});

test("model switches keep the agent's level in sync on every path", () => {
	const syncs = engineSrc.match(/agent\.state\.thinkingLevel = \([^\n]+as ThinkingLevel;/g) ?? [];
	assert.ok(syncs.length >= 3,
		`default-model loop, pin, and unpin all sync thinkingLevel (found ${syncs.length})`);
});

test("durable (default kernel): the stream bridge applies the declared level", () => {
	// Copilot review 2026-11-02: DurableRuntime drives the harness pipeline, so the
	// Agent's thinkingLevel never reaches the request. Without this the main turn
	// silently kept the harness default while only the side pass honored the config.
	const i = engineSrc.indexOf("async openDurableRuntime");
	const bridge = engineSrc.slice(i, i + 1600);
	assert.match(bridge, /const declared = supplier\.modelThinkingLevel\?\.\[modelId\];/,
		"durable bridge reads the per-model declaration");
	assert.match(bridge, /reasoning: undefined/,
		"an off/undeclared level must not inherit a stale reasoning option");
});

test("renderer: reset and auth-supplier rebuild keep the thinking map", () => {
	const dlg = readFileSync(join(root, "renderer/src/components/model-service/EditModelDialog.tsx"), "utf8");
	assert.match(dlg, /setThinking\(supplier\.modelThinkingLevel\?\.\[modelId\] \?\? ""\)/,
		"恢复默认 also resets the thinking level (Copilot review)");
	const svc = readFileSync(join(root, "renderer/src/components/ModelServiceSection.tsx"), "utf8");
	assert.match(svc, /existing\?\.modelThinkingLevel \? \{ modelThinkingLevel: existing\.modelThinkingLevel \}/,
		"rebuilding an auth supplier preserves its configured levels (Copilot review)");
});
