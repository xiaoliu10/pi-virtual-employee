/**
 * Kernel default + fallback contract.
 *
 * v0.2.167 flipped the default to "durable"; the 2026-11-09 user ruling
 * (docs/design/router-worker-core.md §0/§1/§11) flipped it BACK to "legacy"
 * (= bare pi-agent-core Agent, product name agent-core): durable's
 * per-submission redrive caused a recovery storm and its per-turn conversation
 * import dropped tool history between turns. A durable-host open failure must
 * still degrade to a WORKING legacy pipeline — not a bot that throws on every send.
 *
 * What this pins:
 *  - a fresh config (key never set) resolves engineKernel to "legacy";
 *  - the one-time reverse migration: a stored "durable" becomes "legacy" once,
 *    is persisted, and is idempotent across reads;
 *  - an explicit engineKernel write (including "durable") sticks on ANY install
 *    state — including installs the reset migration never ran on (legacy/
 *    pi-session opt-outs): update() stamps the reset marker itself;
 *  - an imported (replaceAll) "durable" deliberately resets to legacy on the
 *    next read — an import must not silently re-arm the retired kernel;
 *  - an explicit "pi-session" is never touched by either migration;
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

/** A persisted config blob, shaped like the ones all()/update() write back. */
function seedConfigBlob(db, general) {
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	const blob = JSON.stringify({ general, model: {}, im: {}, kb: {}, security: {}, capabilities: {}, computer: {} });
	db.prepare("INSERT INTO config (key, value) VALUES ('appconfig', ?)").run(blob);
	return new ConfigStore(db);
}

/** The persisted general section — migrations must be durable, not in-memory only. */
function storedGeneral(db) {
	return JSON.parse(db.prepare("SELECT value FROM config WHERE key = 'appconfig'").get().value).general;
}

test("default config resolves engineKernel to legacy (agent-core, 2026-11-09 ruling)", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	const config = new ConfigStore(db);
	assert.equal(config.all().general.engineKernel, "legacy");
	// A fresh install must STAY on legacy across reads: the retired v0.2.167
	// carry-forward would otherwise bump the materialized default to durable.
	assert.equal(config.all().general.engineKernel, "legacy");
	assert.equal(storedGeneral(db).engineKernel, "legacy");
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

test("reverse migration: a stored durable flips to legacy once and is persisted", (t) => {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	// Every install that ran 0.2.167–0.2.213 has "durable" materialized in its blob.
	const config = seedConfigBlob(db, { engineKernel: "durable" });
	assert.equal(config.all().general.engineKernel, "legacy");
	assert.equal(config.all().general.engineKernelReset202611, true);
	assert.equal(storedGeneral(db).engineKernel, "legacy", "the reset must be persisted, not just in-memory");
	assert.equal(storedGeneral(db).engineKernelReset202611, true);
});

test("reverse migration is idempotent across repeated reads", (t) => {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	const config = seedConfigBlob(db, { engineKernel: "durable" });
	const first = JSON.stringify(config.all().general);
	for (let i = 0; i < 3; i++) assert.equal(JSON.stringify(config.all().general), first, "re-reads must not re-migrate or churn the blob");
	assert.equal(config.all().general.engineKernel, "legacy");
});

test("reverse migration: a durable written AFTER the reset is the user's choice and sticks", (t) => {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	const config = seedConfigBlob(db, { engineKernel: "durable" });
	assert.equal(config.all().general.engineKernel, "legacy"); // migrated
	config.update({ general: { engineKernel: "durable" } }); // deliberate opt-in
	assert.equal(config.all().general.engineKernel, "durable", "an explicit durable must not be reset again");
	assert.equal(config.all().general.engineKernel, "durable");
	assert.equal(storedGeneral(db).engineKernel, "durable");
});

test("an explicit durable opt-in sticks on installs the reset migration never ran on", (t) => {
	// Review P1 (2026-11-09): installs whose stored kernel is NOT "durable" — a
	// 0.2.167-era deliberate "legacy" opt-out (legacy + carried) or an explicit
	// "pi-session" — never ran the reverse migration, so nothing had set the
	// reset marker. update() must stamp it, or the FIRST explicit "durable" is
	// eaten by the reset migration on the next all() read.
	const optedOut = new DatabaseSync(":memory:");
	const piSession = new DatabaseSync(":memory:");
	const fresh = new DatabaseSync(":memory:");
	t.after(() => { optedOut.close(); piSession.close(); fresh.close(); });

	const legacyOptOut = seedConfigBlob(optedOut, { engineKernel: "legacy", engineKernelCarried: true });
	assert.equal(legacyOptOut.all().general.engineKernel, "legacy");
	legacyOptOut.update({ general: { engineKernel: "durable" } });
	assert.equal(legacyOptOut.all().general.engineKernel, "durable", "explicit durable on a legacy+carried install must stick");
	assert.equal(legacyOptOut.all().general.engineKernel, "durable");
	assert.equal(storedGeneral(optedOut).engineKernelReset202611, true, "update() must stamp the reset marker");

	const pi = seedConfigBlob(piSession, { engineKernel: "pi-session", engineKernelCarried: true });
	assert.equal(pi.all().general.engineKernel, "pi-session");
	pi.update({ general: { engineKernel: "durable" } });
	assert.equal(pi.all().general.engineKernel, "durable", "explicit durable on a pi-session install must stick");
	assert.equal(pi.all().general.engineKernel, "durable");

	// Empty DB: update(durable) as the VERY FIRST operation must stick too.
	fresh.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	const first = new ConfigStore(fresh);
	first.update({ general: { engineKernel: "durable" } });
	assert.equal(first.all().general.engineKernel, "durable", "explicit durable as the first-ever write must stick");
	assert.equal(first.all().general.engineKernel, "durable");
});

test("an imported (replaceAll) durable resets to legacy on the next read — import semantics pin", (t) => {
	// Review P3: replaceAll does not stamp the migration markers, so an imported
	// engineKernel:"durable" — demoted to opt-in by the 2026-11-09 ruling — is
	// deliberately reset to "legacy" by the next all() read, exactly like the
	// stored pre-ruling default. An import must not silently re-arm the retired
	// kernel; re-enable durable explicitly through update() after import.
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	const config = seedConfigBlob(db, {});
	config.replaceAll({ general: { engineKernel: "durable" } });
	assert.equal(config.all().general.engineKernel, "legacy", "an imported durable must not re-arm the retired kernel");
});

test("reverse migration: an explicit legacy written after the reset sticks", (t) => {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	const config = seedConfigBlob(db, { engineKernel: "durable" });
	assert.equal(config.all().general.engineKernel, "legacy"); // migrated
	config.update({ general: { engineKernel: "legacy" } });
	assert.equal(config.all().general.engineKernel, "legacy", "the retired carry-forward must not resurrect durable");
});

test("neither migration touches an explicit pi-session", (t) => {
	const db = new DatabaseSync(":memory:");
	const optedIn = new DatabaseSync(":memory:");
	t.after(() => { db.close(); optedIn.close(); });
	const config = seedConfigBlob(db, { engineKernel: "pi-session", engineKernelCarried: true });
	assert.equal(config.all().general.engineKernel, "pi-session");
	assert.equal(config.all().general.engineKernel, "pi-session");
	assert.equal(storedGeneral(db).engineKernel, "pi-session");
	// …also when written through update() on an already-reset install.
	const reset = seedConfigBlob(optedIn, { engineKernel: "durable" });
	assert.equal(reset.all().general.engineKernel, "legacy");
	reset.update({ general: { engineKernel: "pi-session" } });
	assert.equal(reset.all().general.engineKernel, "pi-session");
	assert.equal(reset.all().general.engineKernel, "pi-session");
});

test("materialized old-default legacy stays legacy (carry-forward then reset)", (t) => {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	// ≤0.2.166 installs carry the OLD default with no marker: the retired bump
	// would flip it to durable in this very read, and the reset must land it back.
	const config = seedConfigBlob(db, { engineKernel: "legacy" });
	assert.equal(config.all().general.engineKernel, "legacy");
	assert.equal(config.all().general.engineKernelCarried, true);
	assert.equal(config.all().general.engineKernel, "legacy", "later reads must not resurrect durable");
	assert.equal(storedGeneral(db).engineKernel, "legacy");
});

test("an explicit legacy with the v0.2.167 carry marker is left alone", (t) => {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	const config = seedConfigBlob(db, { engineKernel: "legacy", engineKernelCarried: true });
	assert.equal(config.all().general.engineKernel, "legacy");
	assert.equal(config.all().general.engineKernelReset202611, undefined, "nothing to reset — no marker churn");
});
