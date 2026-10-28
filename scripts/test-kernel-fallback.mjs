/**
 * Kernel default flip (v0.2.167): "durable" is now the DEFAULT engineKernel,
 * and a durable-host open failure must degrade to a WORKING legacy pipeline —
 * not a bot that throws on every send.
 *
 * What this pins:
 *  - a fresh config (key never set) resolves engineKernel to "durable";
 *  - kernel "durable" WITHOUT an opened durable runtime → send() throws
 *    (fail-loud, unchanged semantics for a degraded-but-undeclared engine);
 *  - after degradeToLegacyKernel() → send() runs the legacy pipeline and the
 *    reply is produced; degrading twice is a no-op (idempotent);
 *  - degrading a legacy engine is a no-op.
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
const dir = await mkdtemp(join(root, "node_modules/.kernel-fallback-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "kernel-fallback.mjs");
await build({
	stdin: {
		contents: `
			export { EmployeeEngine } from "./src/engine/engine.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { FileCredentialStore } from "./src/engine/credential-store.ts";
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
const { EmployeeEngine, ConfigStore, HistoryStore, FileCredentialStore } = await import(pathToFileURL(bundle).href);

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
	engine.setTelemetryStore({ recordTurn: () => {}, recordTool: () => {} });
	return engine;
}

const supplierConfig = (engine) => engine.config.update({
	model: {
		suppliers: [{ id: "s", name: "S", enabled: true, apiType: "openai-completions", baseUrl: "https://x.invalid", apiKey: "k", models: ["m"] }],
		defaultSupplierId: "s",
		defaultModelId: "m",
	},
});

const okStreamFn = async () => ({
	async *[Symbol.asyncIterator]() {},
	result: async () => ({
		role: "assistant", provider: "s", model: "m",
		content: [{ type: "text", text: "legacy 管线答复" }],
		stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
	}),
});

test("default config resolves engineKernel to durable (flip verified)", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	const config = new ConfigStore(db);
	assert.equal(config.all().general.engineKernel, "durable");
	db.close();
});

test("kernel durable without an opened runtime → send throws (fail-loud)", async (t) => {
	const engine = makeEngine(t, { streamFn: okStreamFn, kernel: "durable" });
	supplierConfig(engine);
	const agent = engine.getOrCreateSession("conv-durable");
	await assert.rejects(
		() => engine.send(agent, "hello"),
		/Durable runtime is unavailable; refusing to replay through legacy/,
	);
});

test("after degradeToLegacyKernel → send runs the legacy pipeline and replies", async (t) => {
	const engine = makeEngine(t, { streamFn: okStreamFn, kernel: "durable" });
	supplierConfig(engine);
	engine.degradeToLegacyKernel("test: durable host failed to open");
	const agent = engine.getOrCreateSession("conv-degraded");
	const result = await engine.send(agent, "hello");
	assert.equal(result.reply, "legacy 管线答复");
	// idempotent: degrading again must not throw or re-warn state
	engine.degradeToLegacyKernel("test: again");
	const again = await engine.send(agent, "hello again");
	assert.ok(again.reply.length > 0);
});

test("degrading a legacy engine is a no-op", async (t) => {
	const engine = makeEngine(t, { streamFn: okStreamFn, kernel: "legacy" });
	supplierConfig(engine);
	engine.degradeToLegacyKernel("test: should not change anything");
	const agent = engine.getOrCreateSession("conv-legacy");
	const result = await engine.send(agent, "hello");
	assert.equal(result.reply, "legacy 管线答复");
});

test("carry-forward: persisted old-default legacy bumps to durable once", (t) => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	t.after(() => db.close());
	// Every install that ever ran ≤0.2.166 has the OLD default materialized:
	const legacyBlob = JSON.stringify({ general: { engineKernel: "legacy" }, model: {}, im: {}, kb: {}, security: {}, capabilities: {}, computer: {} });
	db.prepare("INSERT INTO config (key, value) VALUES ('appconfig', ?)").run(legacyBlob);
	const config = new ConfigStore(db);
	assert.equal(config.all().general.engineKernel, "durable");
	assert.equal(config.all().general.engineKernelCarried, true);
	// and the migration is persisted, not just in-memory:
	const stored = JSON.parse(db.prepare("SELECT value FROM config WHERE key = 'appconfig'").get().value);
	assert.equal(stored.general.engineKernel, "durable");
	assert.equal(stored.general.engineKernelCarried, true);
});

test("carry-forward respects an explicit legacy (marker present)", (t) => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	t.after(() => db.close());
	const explicitBlob = JSON.stringify({ general: { engineKernel: "legacy", engineKernelCarried: true }, model: {}, im: {}, kb: {}, security: {}, capabilities: {}, computer: {} });
	db.prepare("INSERT INTO config (key, value) VALUES ('appconfig', ?)").run(explicitBlob);
	const config = new ConfigStore(db);
	assert.equal(config.all().general.engineKernel, "legacy");
});

test("carry-forward: an explicit update(engineKernel) after migration is respected", (t) => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	t.after(() => db.close());
	const legacyBlob = JSON.stringify({ general: { engineKernel: "legacy" }, model: {}, im: {}, kb: {}, security: {}, capabilities: {}, computer: {} });
	db.prepare("INSERT INTO config (key, value) VALUES ('appconfig', ?)").run(legacyBlob);
	const config = new ConfigStore(db);
	assert.equal(config.all().general.engineKernel, "durable"); // migrated
	config.update({ general: { engineKernel: "legacy" } }); // deliberate opt-out
	assert.equal(config.all().general.engineKernel, "legacy"); // sticks
});
