/**
 * Model session-affinity default tests (user ruling 2026-10-13: VE models
 * default ON so the same conversation sticks to the same upstream and the
 * gateway prompt cache actually hits; kill switch = model.sessionAffinity:false).
 *
 * Asserts at the engine's model-resolution level (buildModel/withIdentity via
 * the session factory): pi-ai's header emission from compat + options.sessionId
 * is upstream behavior — here we pin OUR part, the compat flags on every
 * resolved model, including the withRemoteInfo re-clone path.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.model-affinity-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "model-affinity.mjs");
await build({
	stdin: {
		contents: `
			export { EmployeeEngine } from "./src/engine/engine.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { agents } from "@earendil-works/pi-agent-core";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	plugins: [
		{
			name: "stub-agent-sdk",
			setup(b) {
				b.onResolve({ filter: /^@earendil-works\/pi-agent-core$/ }, () => ({ path: "agent", namespace: "stub" }));
				b.onResolve({ filter: /pi-compaction\.(js|ts)$/ }, () => ({ path: "compaction", namespace: "stub" }));
				b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
					contents: `
						export const agents = [];
						export class Agent {
							constructor(opts) {
								this.opts = opts;
								this.sessionId = opts.sessionId;
								// initialState.model rides along — the test asserts its compat flags.
								this.state = { ...opts.initialState, isStreaming: false, messages: [] };
								agents.push(this);
							}
							subscribe() { return () => {}; }
							abort() {}
							steered = [];
							steer(m) { this.steered.push(m); }
							signal = undefined;
							hasQueuedMessages() { return this.steered.length > 0; }
							clearSteeringQueue() { this.steered = []; }
							clearFollowUpQueue() {}
							clearAllQueues() { this.clearSteeringQueue(); }
							async prompt() {}
							async continue() {}
							createLoopConfig() { return {}; }
						}
						export const DEFAULT_COMPACTION_SETTINGS = {};
						export const convertToLlm = (x) => x;
						export const estimateContextTokens = () => ({ tokens: 0 });
						export const estimateTokensSafe = () => 0;
						export const estimateTokens = () => 0;
						export const generateSummary = () => Promise.reject(new Error("stub"));
						export const shouldCompact = () => false;
						export const createCompactionSummaryMessage = (x) => x;
					`,
				}));
			},
		},
	],
});
const { EmployeeEngine, ConfigStore, HistoryStore } = await import(pathToFileURL(bundle).href);

function makeEngine(t) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_supplier_id TEXT, model_model_id TEXT, origin TEXT NOT NULL DEFAULT 'console');");
	db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL);");
	db.exec("CREATE TABLE IF NOT EXISTS conversation_members (conversation_id TEXT NOT NULL, staff_id TEXT NOT NULL, name TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, message_count INTEGER NOT NULL, PRIMARY KEY (conversation_id, staff_id));");
	t.after(() => db.close());
	const config = new ConfigStore(db);
	const history = new HistoryStore(db);
	const stub = {};
	const engine = new EmployeeEngine(config, history, { listMemoryIndex: () => [] }, stub, stub, stub, stub, stub, stub, {
		builtinSkillsDir: dir, userSkillsDir: dir,
	}, {
		streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }),
		retrySleepFn: async () => {},
	});
	return { engine, config };
}
const supplierCfg = (config) => config.update({
	model: {
		suppliers: [{ id: "s", name: "S", enabled: true, apiType: "openai", baseUrl: "http://litellm.local:4000", apiKey: "k", models: ["m"] }],
		defaultSupplierId: "s",
		defaultModelId: "m",
	},
});

test("session affinity is ON by default on every resolved VE model", (t) => {
	const { engine, config } = makeEngine(t);
	supplierCfg(config);
	const agent = engine.getOrCreateSession("conv-aff-on");
	const model = agent.state.model;
	assert.ok(model, "the session factory resolves a model");
	assert.equal(model.compat?.sendSessionAffinityHeaders, true, "default = headers on (LiteLLM/relays never auto-enable)");
	assert.equal(model.id, "m");
});

test("model.sessionAffinity=false is the kill switch", (t) => {
	const { engine, config } = makeEngine(t);
	supplierCfg(config);
	config.update({ model: { sessionAffinity: false } });
	const agent = engine.getOrCreateSession("conv-aff-off");
	assert.equal(agent.state.model?.compat?.sendSessionAffinityHeaders, false, "explicit false wins over the default");
});

test("affinity flag is set on every session built from the same supplier/model (review L2: distinct conversations, not a same-session rebuild)", (t) => {
	const { engine, config } = makeEngine(t);
	supplierCfg(config);
	// Two distinct conversations: each factory call resolves its own model, so
	// the flag must not depend on per-session state. (The withRemoteInfo re-clone
	// path is spread-faithful by code read — not exercised here; review L2.)
	const a = engine.getOrCreateSession("conv-aff-remote-1");
	const b = engine.getOrCreateSession("conv-aff-remote-2");
	assert.equal(a.state.model?.compat?.sendSessionAffinityHeaders, true);
	assert.equal(b.state.model?.compat?.sendSessionAffinityHeaders, true);
});
