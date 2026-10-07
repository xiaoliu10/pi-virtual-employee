/**
 * Engine-side account login tests: authCatalog / authLogin / answer / cancel /
 * logout / authQuota, plus the supplier.authProvider model-resolution bypass —
 * the REAL EmployeeEngine constructor, REAL pi-ai Models and REAL
 * FileCredentialStore (temp auth.json), a scripted OAuth provider, and a
 * stubbed Agent SDK. No network: fetch is stubbed for the quota endpoint, and
 * the stream path is either intercepted at the engine's streamFn seam or
 * answered by the scripted provider's streamSimple.
 *
 * Mirror of scripts/test-work-e2e.mjs's bundle style: real engine with
 * @earendil-works/pi-agent-core stubbed out.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.engine-auth-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "engine-auth.mjs");
await build({
	stdin: {
		contents: `
			export { EmployeeEngine } from "./src/engine/engine.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { FileCredentialStore } from "./src/engine/credential-store.ts";
			export { AUTH_CATALOG_PROVIDER_IDS, AUTH_PROVIDER_LABELS } from "./src/shared/auth.ts";
			export { createModels } from "@earendil-works/pi-ai";
			export { builtinProviders } from "@earendil-works/pi-ai/providers/all";
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
				b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
					contents: `
						export const agents = [];
						export class Agent {
							constructor(opts) {
								this.opts = opts;
								this.state = { ...opts.initialState, isStreaming: false, messages: [], errorMessage: undefined };
								agents.push(this);
							}
							subscribe() { return () => {}; }
							abort() {}
							async prompt(input) {
								// Consume like the real agent-loop does (await the streamFn — it's
								// async — then for await over events drives the lazy stream init; a
								// bare result() call resolves early on the second invocation and
								// would skip the provider entirely).
								const response = await this.opts.streamFn(this.state.model, [{ role: "user", content: input, id: "u1" }], {});
								if (response && typeof response[Symbol.asyncIterator] === "function") {
									for await (const event of response) {
										// Mirror the real agent-loop: a provider failure inside a lazy
										// stream (pi-ai auth resolution) ends the stream as an error event
										// event carrying the assistant message — the SDK stores its
										// errorMessage on state instead of rejecting prompt().
										if (event?.type === "error" && event.error?.errorMessage) {
											this.state.errorMessage = event.error.errorMessage;
										}
									}
								}
								if (response && typeof response.result === "function") await response.result();
							}
							// applyToolStepCap binds this (private on the SDK Agent but present at
							// runtime) per-instance. The stub just needs it to exist.
							createLoopConfig() { return {}; }
						}
						export const DEFAULT_COMPACTION_SETTINGS = {};
						export const convertToLlm = (x) => x;
						export const estimateContextTokens = () => 0;
						export const estimateTokensSafe = () => 0;
						export const estimateTokens = () => 0;
						export const generateSummary = async () => ({ ok: false });
						export const shouldCompact = () => false;
						export const createCompactionSummaryMessage = (x) => x;
					`,
				}));
			},
		},
	],
});
const {
	EmployeeEngine, ConfigStore, HistoryStore, FileCredentialStore,
	AUTH_CATALOG_PROVIDER_IDS, AUTH_PROVIDER_LABELS,
	builtinProviders, agents,
} = await import(pathToFileURL(bundle).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Scripted fixtures ──

const FAKE_BASE = "https://fake.anthropic.example";
const fakeModel = (provider) => ({
	id: "fake-model",
	name: "Fake Model",
	api: "openai-completions",
	provider,
	baseUrl: FAKE_BASE,
	contextWindow: 128_000,
	maxTokens: 8_192,
	input: ["text"],
});

/** OAuth provider under a REAL catalog id ("anthropic"), replacing the builtin.
 * Deterministic: its apiKey resolve NEVER resolves (no ambient env dependence).
 * `calls` records every streamSimple handoff (model + resolved request options). */
function fakeOAuthProvider() {
	const calls = [];
	return {
		calls,
		id: "anthropic",
		name: "Fake Claude",
		baseUrl: FAKE_BASE,
		auth: {
			apiKey: { name: "Fake key", resolve: async () => undefined },
			oauth: {
				name: "Fake Claude (OAuth)",
				login: async (interaction) => {
					interaction.notify({ type: "auth_url", url: "https://auth.example/authorize?x=1", instructions: "在浏览器完成授权" });
					const account = await interaction.prompt({
						type: "select",
						message: "选择账号",
						options: [{ id: "acct-a", label: "A" }, { id: "acct-b", label: "B" }],
					});
					const code = await interaction.prompt({ type: "text", message: "输入授权码" });
					return { type: "oauth", access: `access-${account}-${code}`, refresh: "rt-1", expires: Date.now() + 3_600_000 };
				},
				refresh: async (credential) => ({ ...credential, access: credential.access.replace(/-r\d+$/, "") + "-refreshed", expires: Date.now() + 3_600_000 }),
				toAuth: async (credential) => ({ apiKey: credential.access, baseUrl: FAKE_BASE }),
			},
		},
		getModels: () => [fakeModel("anthropic")],
		// result() is called twice (rawStreamFn's cleanup hook + the caller); the
		// stream must record + resolve ONCE and stay memoized for later callers.
		// The return value must be a REAL stream shape: pi-ai's forwardStream
		// iterates it for events, THEN takes result() for the final message — a
		// bare {result} would surface "source is not async iterable".
		streamSimple: (model, context, options) => {
			const promise = (async () => {
				calls.push({ model, options });
				return { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" };
			})();
			return {
				async *[Symbol.asyncIterator]() { /* no intermediate events */ },
				result: () => promise,
			};
		},
	};
}

/** OAuth provider for zai-coding-cn on an ALLOWED quota host, with refresh
 * observable — used to prove authQuota refreshes expired tokens via the store. */
function fakeZaiCnOAuthProvider() {
	return {
		id: "zai-coding-cn",
		name: "Fake Zai CN",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		auth: {
			apiKey: { name: "Fake CN key", resolve: async () => undefined },
			oauth: {
				name: "Fake Zai CN (OAuth)",
				login: async () => ({ type: "oauth", access: "cn-access", refresh: "cn-refresh", expires: Date.now() + 3_600_000 }),
				refresh: async (credential) => ({ ...credential, access: credential.access + "-r2", expires: Date.now() + 3_600_000 }),
				toAuth: async (credential) => ({ apiKey: credential.access, baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" }),
			},
		},
		getModels: () => [{ ...fakeModel("zai-coding-cn"), baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" }],
		streamSimple: () => ({
			async *[Symbol.asyncIterator]() { /* no intermediate events */ },
			result: async () => ({ role: "assistant", content: [], stopReason: "stop" }),
		}),
	};
}

/** Anthropic-OAuth provider whose refresh always fails — pi-ai wraps the
 * thrown error into ModelsError("oauth", "OAuth refresh failed for anthropic").
 * Used to prove login-shaped failures surface Chinese re-login guidance in
 * the conversation reply (review H4). */
function expiringOAuthProvider() {
	const base = fakeOAuthProvider();
	return {
		...base,
		auth: { ...base.auth, oauth: { ...base.auth.oauth, refresh: async () => { throw new Error("boom from provider"); } } },
	};
}

/** zai provider whose toAuth returns provider headers WITHOUT Authorization
 * (a null entry) — proves the bearer-key fallback fires whenever the headers
 * carry no explicit Authorization, not merely when headers are absent (review L2). */
function fakeZaiHeaderOnlyProvider() {
	const base = fakeZaiCnOAuthProvider();
	return {
		...base,
		id: "zai",
		name: "Fake Zai (header-only)",
		baseUrl: "https://api.z.ai",
		auth: { ...base.auth, oauth: { ...base.auth.oauth, toAuth: async (credential) => ({ apiKey: credential.access, baseUrl: "https://api.z.ai", headers: { "X-Trace": "t1", Authorization: null } }) } },
	};
}

/** Bridge capturing pushed login-state snapshots, with polling wait. */
function captureBridge() {
	const events = [];
	return {
		events,
		onEvent(state) {
			events.push(state);
		},
		async waitFor(pred, timeoutMs = 3_000) {
			const end = Date.now() + timeoutMs;
			for (;;) {
				const found = events.find(pred);
				if (found) return found;
				if (Date.now() > end) {
					throw new Error(`waitFor timeout; last events: ${JSON.stringify(events.slice(-3))}`);
				}
				await sleep(10);
			}
		},
	};
}

/** Real engine, real Models, injected FileCredentialStore on a temp auth.json.
 * Heavy services are inert stubs (never called by the auth/complete surface).
 * `opts.streamFn` defaults to a capturing spy that INTERCEPTS before
 * models.streamSimple (no network); pass { streamFn: undefined } to run the
 * REAL models.streamSimple chain (safe when the provider is scripted). */
function makeEngine(t, { extraProviders = [], opts = {} } = {}) {
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
	// Stub services: inert everywhere except where engine.send() reaches into
	// them (e.g. promptPartsFor asks knowledge for the memory index). Providing
	// the few no-op hooks keeps the real send() path usable in this harness
	// without standing up KB/browser/scheduler services.
	const knowledgeStub = { listMemoryIndex: () => [] };
	const streamCalls = [];
	const stub = {};
	const engine = new EmployeeEngine(config, history, knowledgeStub, stub, stub, stub, stub, stub, stub, {
		builtinSkillsDir: dir,
		userSkillsDir: dir,
	}, {
		credentialStore: store,
		streamFn: (model, context, options) => {
			streamCalls.push({ model, context, options });
			return { result: async () => ({}) };
		},
		...opts,
	});
	for (const provider of extraProviders) engine.models.setProvider(provider);
	t.after(() => {
		try {
			rmSync(`${authPath}.lock`, { force: true });
		} catch { /* best effort */ }
	});
	return { engine, models: engine.models, store, config, history, streamCalls, authPath };
}

/** Stub fetch, capturing calls. `responder(url) -> Response-like`. */
function stubFetch(t, responder) {
	const real = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init) => {
		const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
		calls.push({ url, init: init ?? {} });
		return responder(url, init ?? {});
	};
	t.after(() => {
		globalThis.fetch = real;
	});
	return calls;
}

const jsonResponse = (status, payload) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => payload,
});

// ── authCatalog ──

test("authCatalog: contract order, labels, models; fake provider reported unconfigured", async (t) => {
	const { engine, authPath } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	const catalog = await engine.authCatalog();
	assert.deepEqual(catalog.providers.map((p) => p.provider), [...AUTH_CATALOG_PROVIDER_IDS]);
	assert.equal(catalog.authPath, authPath);
	const entry = catalog.providers.find((p) => p.provider === "anthropic");
	assert.equal(entry.name, AUTH_PROVIDER_LABELS.anthropic.name);
	assert.equal(entry.kind, "oauth");
	assert.equal(entry.configured, false);
	assert.equal(entry.authType, undefined);
	assert.deepEqual(entry.models, [{ id: "fake-model", name: "Fake Model" }]);
	// openai-chatgpt is deliberately ABSENT from the catalog: pi-ai registers no
	// model provider for the legacy ChatGPT backend (login would throw Unknown
	// provider) — field 2026-10-06: users could hit this dead-end entry.
	assert.ok(!catalog.providers.some((p) => p.provider === "openai-chatgpt"));
	// zai is a REAL builtin registry id with static models.
	const zai = catalog.providers.find((p) => p.provider === "zai");
	assert.ok(zai.models.length > 0, "builtin zai registry should list models");
	assert.equal(zai.kind, "api_key");
});

// ── OAuth login flow ──

test("oauth login: url + prompts answered through the bridge, credential lands in auth.json", async (t) => {
	const { engine, store } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	const bridge = captureBridge();
	const initial = engine.authLogin("anthropic", bridge);
	assert.equal(initial.status, "waiting");
	assert.equal(initial.provider, "anthropic");

	// Second concurrent login is refused.
	assert.throws(() => engine.authLogin("anthropic", captureBridge()), /已有登录流程正在进行/);

	// notify(auth_url) → state carries an https url.
	const withUrl = await bridge.waitFor((s) => s.url === "https://auth.example/authorize?x=1");
	assert.match(withUrl.message, /浏览器/);
	assert.equal(engine.authLoginStatus().status, "waiting");

	// select prompt → invalid option refused, valid accepted.
	const selectPrompt = await bridge.waitFor((s) => s.prompt?.type === "select");
	assert.ok(selectPrompt.prompt.id.length > 0);
	assert.throws(() => engine.authLoginAnswer(selectPrompt.prompt.id, "acct-zzz"), /选项无效/);
	assert.throws(() => engine.authLoginAnswer("no-such-prompt", "acct-a"), /登录问题已失效/);
	engine.authLoginAnswer(selectPrompt.prompt.id, "acct-a");

	// text prompt → answered; state clears the prompt.
	const textPrompt = await bridge.waitFor((s) => s.prompt?.type === "text");
	engine.authLoginAnswer(textPrompt.prompt.id, "c123");
	await bridge.waitFor((s) => s.status === "waiting" && s.prompt === undefined);

	const done = await bridge.waitFor((s) => s.status === "done");
	assert.match(done.message, /登录成功/);
	assert.equal(engine.authLoginStatus(), null);

	// The credential is in the FILE store (shared auth.json), and pi-ai resolves
	// request auth from it — the same chain streamSimple uses per request.
	const credential = await store.read("anthropic");
	assert.equal(credential.type, "oauth");
	assert.equal(credential.access, "access-acct-a-c123");
	const auth = await engine.models.getAuth("anthropic");
	assert.equal(auth.auth.apiKey, "access-acct-a-c123");
	assert.equal(auth.auth.baseUrl, FAKE_BASE);

	// Catalog now reports the account.
	const catalog = await engine.authCatalog();
	const entry = catalog.providers.find((p) => p.provider === "anthropic");
	assert.equal(entry.configured, true);
	assert.equal(entry.authType, "oauth");
});

test("successful login ensures an authProvider supplier so registry models enter the dropdown (field: 账号登录后选不到模型)", async (t) => {
	const { engine } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	const before = engine.config.all().model.suppliers.filter((supplier) => supplier.authProvider === "anthropic");
	assert.equal(before.length, 0, "precondition: no supplier for the provider yet");

	const bridge = captureBridge();
	engine.authLogin("anthropic", bridge);
	const selectPrompt = await bridge.waitFor((s) => s.prompt?.type === "select");
	engine.authLoginAnswer(selectPrompt.prompt.id, "acct-a");
	const textPrompt = await bridge.waitFor((s) => s.prompt?.type === "text");
	engine.authLoginAnswer(textPrompt.prompt.id, "c123");
	await bridge.waitFor((s) => s.status === "done");

	const suppliers = engine.config.all().model.suppliers.filter((supplier) => supplier.authProvider === "anthropic");
	assert.equal(suppliers.length, 1);
	assert.equal(suppliers[0].enabled, true);
	assert.equal(suppliers[0].id, "auth-anthropic");
	assert.deepEqual(suppliers[0].models, [], "registry stays the source of truth for auth suppliers");
	// The dropdown chain (availableModels) now surfaces the provider's registry model.
	const options = engine.availableModels().filter((option) => option.supplierId === "auth-anthropic");
	assert.ok(options.some((option) => option.modelId === "fake-model"));
});

test("relogin while the auth supplier is already enabled keeps exactly one entry", async (t) => {
	const { engine } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	const login = async () => {
		const bridge = captureBridge();
		engine.authLogin("anthropic", bridge);
		const selectPrompt = await bridge.waitFor((s) => s.prompt?.type === "select");
		engine.authLoginAnswer(selectPrompt.prompt.id, "acct-a");
		const textPrompt = await bridge.waitFor((s) => s.prompt?.type === "text");
		engine.authLoginAnswer(textPrompt.prompt.id, "c123");
		await bridge.waitFor((s) => s.status === "done");
	};
	await login();
	await login();
	const suppliers = engine.config.all().model.suppliers.filter((supplier) => supplier.authProvider === "anthropic");
	assert.equal(suppliers.length, 1);
	assert.equal(suppliers[0].enabled, true);
});

test("login supplier ensure is idempotent and re-enables a disabled supplier", async (t) => {
	const { engine } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	// Pre-seed a DISABLED supplier for the provider (as if the user disabled it earlier).
	engine.config.update({ model: { suppliers: [
		...engine.config.all().model.suppliers,
		{ id: "auth-anthropic", name: "Anthropic（Claude Pro/Max）", enabled: false, apiType: "openai", baseUrl: "", apiKey: "", models: [], authProvider: "anthropic" },
	] } });

	const bridge = captureBridge();
	engine.authLogin("anthropic", bridge);
	const selectPrompt = await bridge.waitFor((s) => s.prompt?.type === "select");
	engine.authLoginAnswer(selectPrompt.prompt.id, "acct-a");
	const textPrompt = await bridge.waitFor((s) => s.prompt?.type === "text");
	engine.authLoginAnswer(textPrompt.prompt.id, "c123");
	await bridge.waitFor((s) => s.status === "done");

	const suppliers = engine.config.all().model.suppliers.filter((supplier) => supplier.authProvider === "anthropic");
	assert.equal(suppliers.length, 1, "no duplicate");
	assert.equal(suppliers[0].enabled, true, "disabled supplier re-enabled on fresh login");
});

test("oauth login cancel: aborted flow reports cancelled and stores nothing", async (t) => {
	const { engine, store } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	const bridge = captureBridge();
	engine.authLogin("anthropic", bridge);
	await bridge.waitFor((s) => s.prompt?.type === "select");
	assert.equal(engine.authLoginCancel(), true);
	const cancelled = await bridge.waitFor((s) => s.status === "cancelled");
	assert.match(cancelled.message, /取消/);
	assert.equal(await store.read("anthropic"), undefined);
	assert.equal(engine.authLoginStatus(), null);
	// A new login can start after cancellation.
	const second = engine.authLogin("anthropic", captureBridge());
	assert.equal(second.status, "waiting");
	engine.authLoginCancel();
});

test("oversized answers are refused", async (t) => {
	const { engine } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	const bridge = captureBridge();
	engine.authLogin("anthropic", bridge);
	const prompt = await bridge.waitFor((s) => s.prompt?.type === "select");
	assert.throws(() => engine.authLoginAnswer(prompt.prompt.id, "x".repeat(16_385)), /输入无效/);
	engine.authLoginCancel();
});

// ── api_key login (Z.ai) ──

test("api_key login: secret prompt → trimmed key stored via the file store", async (t) => {
	const { engine, store } = makeEngine(t);
	const bridge = captureBridge();
	const initial = engine.authLogin("zai", bridge);
	assert.match(initial.message, /API Key/);
	const prompt = await bridge.waitFor((s) => s.prompt?.type === "secret");
	assert.match(prompt.prompt.message, /Z\.ai/);
	engine.authLoginAnswer(prompt.prompt.id, "  zk-123  ");
	await bridge.waitFor((s) => s.status === "done");
	const credential = await store.read("zai");
	assert.deepEqual(credential, { type: "api_key", key: "zk-123" });
	const catalog = await engine.authCatalog();
	assert.equal(catalog.providers.find((p) => p.provider === "zai").authType, "api_key");
});

test("api_key login: empty key fails the flow with an error event", async (t) => {
	const { engine, store } = makeEngine(t);
	const bridge = captureBridge();
	engine.authLogin("zai", bridge);
	const prompt = await bridge.waitFor((s) => s.prompt?.type === "secret");
	engine.authLoginAnswer(prompt.prompt.id, "   ");
	const failed = await bridge.waitFor((s) => s.status === "error");
	assert.match(failed.message, /API Key 不能为空/);
	assert.equal(await store.read("zai"), undefined);
});

test("logout removes the credential and the catalog reflects it", async (t) => {
	const { engine, store } = makeEngine(t);
	await store.modify("zai", async () => ({ type: "api_key", key: "zk" }));
	await engine.authLogout("zai");
	assert.equal(await store.read("zai"), undefined);
	const catalog = await engine.authCatalog();
	assert.equal(catalog.providers.find((p) => p.provider === "zai").configured, false);
	await assert.rejects(() => engine.authLogout("../etc/passwd"), /未知的账号提供商/);
});

test("unknown provider ids are rejected everywhere", async (t) => {
	const { engine } = makeEngine(t);
	assert.throws(() => engine.authLogin("not-a-provider", captureBridge()), /未知的账号提供商/);
	await assert.rejects(() => engine.authQuota("not-a-provider"), /未知的账号提供商/);
});

// ── supplier.authProvider resolution ──

function accountSupplier(overrides = {}) {
	return {
		id: "acct",
		name: "账号供应商",
		enabled: true,
		apiType: "anthropic",
		baseUrl: "",
		apiKey: "",
		models: ["fake-model"],
		authProvider: "anthropic",
		...overrides,
	};
}

test("supplier.authProvider runs the REAL models.streamSimple chain: stored credential applied, no per-call key", async (t) => {
	const fake = fakeOAuthProvider();
	const { engine, config, store } = makeEngine(t, { extraProviders: [fake], opts: { streamFn: undefined } });
	await store.modify("anthropic", async () => ({ type: "oauth", access: "access-live", refresh: "rt", expires: Date.now() + 3_600_000 }));
	config.update({ model: { suppliers: [accountSupplier()], defaultSupplierId: "acct", defaultModelId: "fake-model" } });
	await engine.complete("sys", "hi");
	assert.equal(fake.calls.length, 1);
	const { model, options } = fake.calls[0];
	assert.equal(model.provider, "anthropic");
	assert.equal(model.id, "fake-model");
	assert.equal(model.baseUrl, FAKE_BASE);
	// Auth came from the stored credential inside models.streamSimple — not
	// from a per-call key.
	assert.equal(options.apiKey, "access-live");
	const agent = agents.at(-1);
	assert.equal(agent.opts.getApiKey(), undefined);
});

test("supplier.authProvider with a model outside the registry fails with the login hint", async (t) => {
	const { engine, config } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	config.update({ model: { suppliers: [accountSupplier({ models: ["nope-model"] })], defaultSupplierId: "acct", defaultModelId: "nope-model" } });
	await assert.rejects(
		() => engine.complete("sys", "hi"),
		/请先在账号登录中完成 anthropic 登录或刷新模型列表/,
	);
});

test("relay supplier WITHOUT authProvider keeps the borrowed-provider path (regression)", async (t) => {
	const { engine, config, streamCalls } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	const relay = {
		id: "relay",
		name: "中转",
		enabled: true,
		apiType: "openai",
		baseUrl: "https://relay.example/v1",
		apiKey: "sk-relay",
		models: ["gpt-x"],
	};
	config.update({ model: { suppliers: [relay], defaultSupplierId: "relay", defaultModelId: "gpt-x" } });
	await engine.complete("sys", "hi");
	assert.equal(streamCalls.length, 1);
	assert.equal(streamCalls[0].model.provider, "groq"); // first openai-completions builtin in the search order
	assert.equal(streamCalls[0].model.baseUrl, "https://relay.example/v1");
	assert.equal(agents.at(-1).opts.getApiKey(), "sk-relay");
});

test("testModelConnection: authProvider supplier needs no pasted key", async (t) => {
	const { engine, config, store } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	config.update({ model: { suppliers: [accountSupplier()], defaultSupplierId: "acct", defaultModelId: "fake-model" } });
	// No stored credential → the honest answer is the login guidance (review
	// H4), not a fake 连接成功 — the lazy-stream auth failure now surfaces.
	await assert.rejects(
		() => engine.testModelConnection(accountSupplier(), "fake-model"),
		/账号尚未登录，请到 设置 → 账号登录 完成登录/,
	);
	await store.modify("anthropic", async () => ({ type: "oauth", access: "access-live", refresh: "rt", expires: Date.now() + 3_600_000 }));
	const reply = await engine.testModelConnection(accountSupplier(), "fake-model");
	assert.equal(reply, "连接成功");
	await assert.rejects(
		() => engine.testModelConnection({ ...accountSupplier({ authProvider: undefined }), apiKey: "" }, "fake-model"),
		/请填写 API Key/,
	);
});

test("engine options inject the credential store; default resolves PI_CODING_AGENT_DIR/auth.json", async (t) => {
	const injectedPath = join(dir, "injected-auth.json");
	const injected = new FileCredentialStore({ authPath: injectedPath });
	const mk = (opts) => {
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
		t.after(() => db.close());
		const stub = {};
		return new EmployeeEngine(new ConfigStore(db), new HistoryStore(db), stub, stub, stub, stub, stub, stub, stub, {
			builtinSkillsDir: dir,
			userSkillsDir: dir,
		}, opts);
	};
	const engine = mk({ credentialStore: injected });
	assert.equal((await engine.authCatalog()).authPath, injectedPath);
	// Default: PI_CODING_AGENT_DIR env wins.
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(dir, "agentdir");
	try {
		const engine2 = mk({});
		assert.equal((await engine2.authCatalog()).authPath, join(dir, "agentdir", "auth.json"));
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	}
});

// ── authQuota (Z.ai) ──

const QUOTA_PATH = "/api/coding/pays/subscription/query_user_codization_resource";

test("authQuota(zai): official endpoint, bearer key, percentage→remaining, reset_time s→ms", async (t) => {
	const { engine, store } = makeEngine(t);
	await store.modify("zai", async () => ({ type: "api_key", key: "zk-q" }));
	const calls = stubFetch(t, () => jsonResponse(200, {
		data: {
			usage_quota_limits: [
				{ name: "GLM Coding Plan", percentage: 30, reset_time: 1_800_000_000 },
				{ name: "Bonus Pack", percentage: 130, reset_time: 1_800_000_000 },
				{ name: "Weird", percentage: -20 },
				{ name: "NoPct" },
			],
		},
	}));
	const result = await engine.authQuota("zai");
	assert.equal(result.provider, "zai");
	assert.ok(Number.isFinite(result.fetchedAt));
	assert.deepEqual(result.limits, [
		{ label: "GLM Coding Plan", remainingPercent: 70, resetsAt: 1_800_000_000_000 },
		{ label: "Bonus Pack", remainingPercent: 0, resetsAt: 1_800_000_000_000 },
		{ label: "Weird", remainingPercent: 100 },
	]);
	const call = calls[0];
	assert.equal(call.url.origin, "https://api.z.ai");
	assert.equal(call.url.pathname, QUOTA_PATH);
	assert.equal(call.url.searchParams.get("enable_delay"), "false");
	assert.equal(call.init.headers.Authorization, "Bearer zk-q");
});

test("authQuota parses the usage_quota.limits fallback shape (zai-coding-cn origin)", async (t) => {
	const { engine, store } = makeEngine(t);
	await store.modify("zai-coding-cn", async () => ({ type: "api_key", key: "zk-cn" }));
	const calls = stubFetch(t, () => jsonResponse(200, {
		data: { usage_quota: { limits: [{ type: "plan", percentage: 55.5 }] } },
	}));
	const result = await engine.authQuota("zai-coding-cn");
	assert.deepEqual(result.limits, [{ label: "套餐", remainingPercent: 44.5 }]);
	assert.equal(calls[0].url.origin, "https://open.bigmodel.cn");
	assert.equal(calls[0].url.pathname, QUOTA_PATH);
});

test("authQuota errors: no credential, 401, non-ok, bad json, empty payload, disallowed host", async (t) => {
	const { engine, store } = makeEngine(t);
	// No credential at all.
	await assert.rejects(() => engine.authQuota("zai"), /尚未配置/);

	await store.modify("zai", async () => ({ type: "api_key", key: "zk-q" }));
	const restub = (responder) => {
		const real = globalThis.fetch;
		globalThis.fetch = async () => responder();
		t.after(() => {
			globalThis.fetch = real;
		});
	};
	restub(() => jsonResponse(401, {}));
	await assert.rejects(() => engine.authQuota("zai"), /登录已过期/);
	restub(() => jsonResponse(500, {}));
	await assert.rejects(() => engine.authQuota("zai"), /套餐接口返回 500/);
	restub(() => jsonResponse(200, { data: {} }));
	await assert.rejects(() => engine.authQuota("zai"), /没有可用额度字段/);
	restub(() => ({ ok: true, status: 200, json: async () => { throw new Error("nope"); } }));
	await assert.rejects(() => engine.authQuota("zai"), /格式无效/);

	// Disallowed host: the fake anthropic account resolves a non-Z.ai base.
	await store.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }));
	await assert.rejects(() => engine.authQuota("anthropic"), /仅支持智谱 \/ Z\.ai 官方套餐查询/);
});

test("authQuota refreshes an expired OAuth token through the store lock", async (t) => {
	const { engine, store } = makeEngine(t, { extraProviders: [fakeZaiCnOAuthProvider()] });
	await store.modify("zai-coding-cn", async () => ({
		type: "oauth",
		access: "cn-access",
		refresh: "cn-refresh",
		expires: Date.now() - 1_000, // expired → getAuth must refresh first
	}));
	const calls = stubFetch(t, () => jsonResponse(200, { data: { usage_quota_limits: [{ name: "CN Plan", percentage: 10 }] } }));
	const result = await engine.authQuota("zai-coding-cn");
	assert.deepEqual(result.limits, [{ label: "CN Plan", remainingPercent: 90 }]);
	assert.equal(calls[0].init.headers.Authorization, "Bearer cn-access-r2");
	// The refreshed credential was persisted, not just used once.
	assert.equal((await store.read("zai-coding-cn")).access, "cn-access-r2");
});

// ── review H3: authProvider supplier baseUrl injection (OAuth token exfiltration) ──

test("authProvider supplier ignores an injected baseUrl — registry endpoint kept, hostile fields dropped (review H3)", async (t) => {
	const fake = fakeOAuthProvider();
	const { engine, config, store } = makeEngine(t, { extraProviders: [fake], opts: { streamFn: undefined } });
	await store.modify("anthropic", async () => ({ type: "oauth", access: "access-live", refresh: "rt", expires: Date.now() + 3_600_000 }));
	// Attacker-injected baseUrl/apiKey: model:test passes the RENDERER draft
	// straight through (no normalize), and a hand-edited DB row / imported config
	// could carry one too. The OAuth access token rides streamSimple's auth —
	// it must land on the REGISTRY endpoint, never on the injected host.
	const hostile = accountSupplier({ baseUrl: "https://evil.example/v1", apiKey: "sk-attacker" });
	await engine.testModelConnection(hostile, "fake-model");
	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0].model.baseUrl, FAKE_BASE, "must keep the registry endpoint, not the injected host");
	assert.equal(fake.calls[0].model.provider, "anthropic");
	assert.equal(fake.calls[0].options.apiKey, "access-live", "account credential still resolves inside streamSimple");
	// Defense in depth: every normalize path (ConfigStore.update) drops
	// baseUrl/apiKey on authProvider suppliers outright.
	config.update({ model: { suppliers: [hostile], defaultSupplierId: "acct", defaultModelId: "fake-model" } });
	const stored = config.all().model.suppliers.find((s) => s.id === "acct");
	assert.equal(stored.baseUrl, "", "normalize must clear an authProvider supplier's injected baseUrl");
	assert.equal(stored.apiKey, "", "normalize must clear an authProvider supplier's injected apiKey");
	assert.equal(stored.authProvider, "anthropic");
});

// ── review H4: login-shaped failures surface Chinese self-service guidance ──

test("expired OAuth surfaces re-login guidance in the conversation reply; unconfigured provider tells the user to log in (review H4)", async (t) => {
	// (1) Expired access token → pi-ai refreshes → scripted refresh fails →
	//     ModelsError("oauth", "OAuth refresh failed for anthropic").
	const { engine, config, store } = makeEngine(t, { extraProviders: [expiringOAuthProvider()], opts: { streamFn: undefined } });
	await store.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() - 1_000 }));
	config.update({ model: { suppliers: [accountSupplier()], defaultSupplierId: "acct", defaultModelId: "fake-model" } });
	const agent = engine.getOrCreateSession("conv-guidance-1");
	const result = await engine.send(agent, "hi");
	assert.match(result.reply, /授权已过期，请到 设置 → 账号登录 重新登录/);
	assert.match(result.error ?? "", /授权已过期/);

	// (2) No stored credential at all → resolveProviderAuth returns undefined →
	//     ModelsError("auth", "Provider is not configured: anthropic").
	const fresh = makeEngine(t, { extraProviders: [expiringOAuthProvider()], opts: { streamFn: undefined } });
	fresh.config.update({ model: { suppliers: [accountSupplier()], defaultSupplierId: "acct", defaultModelId: "fake-model" } });
	const agent2 = fresh.engine.getOrCreateSession("conv-guidance-2");
	const result2 = await fresh.engine.send(agent2, "hi");
	assert.match(result2.reply, /账号尚未登录，请到 设置 → 账号登录 完成登录/);
	assert.match(result2.error ?? "", /账号尚未登录/);
});

// ── field 2026-10-05: model-service stall marks send results as deterministic ──

test("a model that returns no content marks the send deterministic with the service-stall apology (field 2026-10-05)", async (t) => {
	// The harness default streamFn yields NO events (relay cut / thinking-only
	// model) → engine gives up and emits the canned apology; chain runners key
	// their pause-and-wait on result.deterministic.
	const { engine, config } = makeEngine(t);
	config.update({ model: { suppliers: [{ id: "stall-s", name: "stall", enabled: true, apiType: "openai-completions", baseUrl: "https://x.invalid", apiKey: "k", models: ["fake-model"] }], defaultSupplierId: "stall-s", defaultModelId: "fake-model" } });
	const agent = engine.getOrCreateSession("conv-stall");
	const result = await engine.send(agent, "hi");
	assert.match(result.reply, /模型服务连续多次未返回内容/);
	assert.match(result.reply, /不是任务本身的问题/);
	assert.match(result.reply, /知识库/);
	assert.equal(result.deterministic, true, "chain runners pause on this flag");
	assert.equal(result.error, undefined, "a transport stall is not a hard provider error");
});

// ── review L2: quota Bearer-key fallback when headers lack Authorization ──

test("authQuota adds the Bearer key when provider headers exist but carry no Authorization (review L2)", async (t) => {
	const { engine, store } = makeEngine(t, { extraProviders: [fakeZaiHeaderOnlyProvider()] });
	await store.modify("zai", async () => ({ type: "oauth", access: "zk-header", refresh: "r", expires: Date.now() + 3_600_000 }));
	const calls = stubFetch(t, () => jsonResponse(200, { data: { usage_quota_limits: [{ name: "GLM Plan", percentage: 25 }] } }));
	await engine.authQuota("zai");
	const headers = calls[0].init.headers;
	assert.equal(headers["X-Trace"], "t1", "provider header preserved");
	assert.equal(headers.Authorization, "Bearer zk-header", "Bearer key fills the Authorization gap left by the null entry");
});

// ── conversation model pin: invisible override blocked switching (field 2026-10-05) ──

test("clearConversationModel drops the per-conversation pin so it follows the global default again", (t) => {
	const { engine, config, history } = makeEngine(t);
	// Plain API-key suppliers (no authProvider) so buildModel needs no stored credential.
	config.update({
		model: {
			suppliers: [
				accountSupplier({ authProvider: undefined, apiKey: "k" }),
				accountSupplier({ id: "b", name: "B", apiKey: "k2", authProvider: undefined, models: ["pin-model"] }),
			],
			defaultSupplierId: "acct",
			defaultModelId: "fake-model",
		},
	});
	// Pin the conversation to supplier b, then flip the global default back and forth —
	// the pin wins regardless.
	engine.setConversationModel("conv-pin", "b", "pin-model");
	assert.equal(history.getModelOverride("conv-pin")?.supplierId, "b", "pin persisted");
	assert.equal(engine.getOrCreateSession("conv-pin").state.model?.id, "pin-model", "pinned session uses the override");
	// Rebuild path: a non-cached session would first be created WITH the pin (read
	// from DB), then patched to the default — must not leave the pin alive.
	engine.dropSession("conv-pin");
	engine.clearConversationModel("conv-pin");
	assert.equal(history.getModelOverride("conv-pin"), null, "pin cleared in DB");
	assert.equal(
		engine.getOrCreateSession("conv-pin").state.model?.id,
		"fake-model",
		"live session re-resolved to the global default without a rebuild",
	);
});

// ── account-login suppliers: registry models must be selectable everywhere (field 2026-10-06) ──

test("availableModels surfaces registry models for auth suppliers; pin/default accept them", (t) => {
	const { engine, config, history } = makeEngine(t, { extraProviders: [fakeOAuthProvider()] });
	// Account-login supplier: config models array is EMPTY — models live in the registry.
	config.update({
		model: {
			suppliers: [accountSupplier({ id: "acct2", authProvider: "anthropic", models: [] })],
			defaultSupplierId: "acct2",
			defaultModelId: "fake-model",
		},
	});
	const listed = engine.availableModels().filter((o) => o.supplierId === "acct2");
	assert.ok(listed.some((o) => o.modelId === "fake-model"), "registry models listed for auth supplier");
	assert.ok(listed.some((o) => o.isDefault), "registry default marked");

	// Pin a conversation to the registry model — validation must accept it.
	engine.setConversationModel("conv-auth", "acct2", "fake-model");
	assert.equal(history.getModelOverride("conv-auth")?.modelId, "fake-model");
	assert.equal(engine.getOrCreateSession("conv-auth").state.model?.id, "fake-model");

	// Default resolution uses the same supplierHasModel path.
	assert.equal(engine.getOrCreateSession("conv-fresh").state.model?.id, "fake-model", "default resolves via registry");

	// setDefaultModel live-patches unpinned cached sessions without invalidate.
	const before = engine.activeSessionCount();
	engine.setDefaultModel("acct2", "fake-model");
	assert.equal(engine.getOrCreateSession("conv-fresh").state.model?.id, "fake-model");
	assert.ok(engine.activeSessionCount() >= before, "no sessions dropped by the lightweight default switch");
});
