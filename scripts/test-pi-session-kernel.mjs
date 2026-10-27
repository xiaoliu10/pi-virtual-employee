/**
 * pi-session kernel end-to-end (migration doc §7/§11 Phase 2 acceptance):
 * the FULL EmployeeEngine facade driving turns through the pi AgentSession
 * shell — real pi-coding-agent, real pi-agent-core, real buildTools registry;
 * only the model transport is scripted (fake streamFn).
 *
 * What this pins:
 *  - kernel "pi-session": send() works end-to-end through the session shell,
 *    the host is created and tracked, VE tool closures (telemetry hooks)
 *    still fire THROUGH the session-wrapped registry, and pi's built-in
 *    coding tools do not leak into the agent's toolset;
 *  - default kernel "legacy": zero hosts — the gray switch is off by default;
 *  - dropSession disposes the host (no leaked session shells).
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
const dir = await mkdtemp(join(root, "node_modules/.pi-session-kernel-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "pi-session-kernel.mjs");
await build({
	stdin: {
		contents: `
			export { EmployeeEngine } from "./src/engine/engine.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { FileCredentialStore } from "./src/engine/credential-store.ts";
			export { initPiRuntime } from "./src/engine/imports.ts";
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
const { EmployeeEngine, ConfigStore, HistoryStore, FileCredentialStore, initPiRuntime } = await import(pathToFileURL(bundle).href);

function makeEngine(t, { streamFn, kernel } = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_supplier_id TEXT, model_model_id TEXT, origin TEXT NOT NULL DEFAULT 'console');");
	db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL);");
	db.exec("CREATE TABLE IF NOT EXISTS conversation_members (conversation_id TEXT NOT NULL, staff_id TEXT NOT NULL, name TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, message_count INTEGER NOT NULL, PRIMARY KEY (conversation_id, staff_id));");
	t.after(() => db.close());
	const config = new ConfigStore(db);
	const history = new HistoryStore(db);
	const authPath = join(dir, `auth-${Math.random().toString(36).slice(2, 8)}.json`);
	const store = new FileCredentialStore({ authPath });
	t.after(() => {
		try { rmSync(`${authPath}.lock`, { force: true }); } catch { /* best effort */ }
	});
	const toolEvents = [];
	const knowledgeStub = { listMemoryIndex: () => [], listScopedMemoryIndex: () => [] };
	const stub = {};
	const engine = new EmployeeEngine(config, history, knowledgeStub, stub, stub, stub, stub, stub, stub, {
		builtinSkillsDir: dir,
		userSkillsDir: dir,
	}, {
		credentialStore: store,
		streamFn,
		kernel,
	});
	engine.setTelemetryStore({
		recordTurn: () => {},
		recordTool: (event) => toolEvents.push({ name: event.name, ok: event.ok }),
	});
	return { engine, toolEvents, config };
}

const supplierConfig = (config) => config.update({
	model: {
		suppliers: [{ id: "s", name: "S", enabled: true, apiType: "openai-completions", baseUrl: "https://x.invalid", apiKey: "k", models: ["m"] }],
		defaultSupplierId: "s",
		defaultModelId: "m",
	},
});

/** Scripted model: run 1 calls get_current_time, run 2 answers. */
function scriptedStreamFn(toolName) {
	let run = 0;
	return async () => {
		run += 1;
		return {
			async *[Symbol.asyncIterator]() {},
			result: async () => run === 1
				? { role: "assistant", provider: "s", model: "m", content: [{ type: "text", text: "查时间" }, { type: "toolCall", id: "c1", name: toolName, arguments: {} }], stopReason: "toolUse", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }
				: { role: "assistant", provider: "s", model: "m", content: [{ type: "text", text: "完成：时间已核对" }], stopReason: "stop", usage: { input: 40, output: 5, cacheRead: 0, cacheWrite: 0 } },
		};
	};
}

test("legacy kernel (default): a send works with ZERO session hosts — gray switch off", async (t) => {
	await initPiRuntime();
	const { engine } = makeEngine(t, { streamFn: scriptedStreamFn("get_current_time") });
	supplierConfig(engine.config);
	const agent = engine.getOrCreateSession("conv-legacy");
	const result = await engine.send(agent, "现在几点");
	assert.equal(result.reply, "完成：时间已核对");
	const hosts = engine.hosts;
	assert.equal(hosts.size, 0, "legacy kernel creates no session shells");
});

test("pi-session kernel: send() flows through the session shell; VE tools + telemetry survive the wrap", async (t) => {
	await initPiRuntime();
	const { engine, toolEvents } = makeEngine(t, { streamFn: scriptedStreamFn("get_current_time"), kernel: "pi-session" });
	supplierConfig(engine.config);
	const agent = engine.getOrCreateSession("conv-pi");
	const result = await engine.send(agent, "现在几点");
	assert.equal(result.reply, "完成：时间已核对", "the reply rides through the session-driven turn");

	const hosts = engine.hosts;
	assert.equal(hosts.size, 1, "one session shell per conversation");

	// VE tool closures ran THROUGH the wrapped registry: telemetry sees the call
	// (SendResult.toolCalls belongs to the deferred verify-gate PR #84, not here).
	assert.ok(toolEvents.some((e) => e.name === "get_current_time" && e.ok), `tool telemetry must survive the session wrap (${toolEvents.map((e) => e.name).join(",")})`);

	// pi's built-in coding tools must not leak into the agent toolset.
	const names = agent.state.tools.map((x) => x.name);
	assert.ok(names.includes("get_current_time"), "VE tools present");
	assert.ok(!names.includes("read") && !names.includes("bash") && !names.includes("edit"), `pi built-ins must stay out, got ${names.join(",")}`);

	engine.dropSession("conv-pi");
	assert.equal(hosts.size, 0, "dropSession disposes the host shell");
});

test("pi-session kernel: the second turn reuses the host (no shell churn)", async (t) => {
	await initPiRuntime();
	const { engine } = makeEngine(t, { streamFn: scriptedStreamFn("get_current_time"), kernel: "pi-session" });
	supplierConfig(engine.config);
	const agent = engine.getOrCreateSession("conv-reuse");
	await engine.send(agent, "现在几点");
	await engine.send(agent, "再确认一次");
	const hosts = engine.hosts;
	assert.equal(hosts.size, 1, "one shell across turns");
});

test("rebuild (skill/memory revision bump) disposes the OLD host — no shell leak", async (t) => {
	await initPiRuntime();
	const { engine } = makeEngine(t, { streamFn: scriptedStreamFn("get_current_time"), kernel: "pi-session" });
	supplierConfig(engine.config);
	const agent = engine.getOrCreateSession("conv-rebuild");
	await engine.send(agent, "现在几点");
	const hosts = engine.hosts;
	const oldAgent = agent;
	// Bump the memory revision (sync) so getOrCreateSession rebuilds the idle session.
	engine.markMemoryChanged();
	const newAgent = engine.getOrCreateSession("conv-rebuild");
	assert.notEqual(newAgent, oldAgent, "a fresh agent was built");
	assert.equal(hosts.size, 0, "the OLD host was disposed on rebuild (new host is lazy — created in send)");
	// A turn on the rebuilt agent creates the NEW host; count must stay 1 (no leak of the old).
	await engine.send(newAgent, "再确认一次");
	assert.equal(hosts.size, 1, "exactly one host for the rebuilt agent (old one did not leak)");
});
