/**
 * Engine transient-retry tests (PR: Claude Code / zcode style graded retries —
 * user ruling 2026-10-08: ONE immediate retry let a multi-second gateway
 * outage surface as an execution error / work-item pause).
 *
 * Real EmployeeEngine + real promptWithRetry loop; the Agent SDK is stubbed
 * with a scripted double that mirrors the SDK shapes promptWithRetry relies
 * on: errorMessage per run (cleared at run start, set on failure), a failure
 * assistant message appended on error (handleRunFailure), message_end events
 * through subscribe() on success, and continue() resuming from the transcript.
 * The retry backoff sleep is injected (retrySleepFn) so all 10 retries run
 * instantly; the recorded delays pin the backoff schedule itself.
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
const dir = await mkdtemp(join(root, "node_modules/.engine-retry-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "engine-retry.mjs");
await build({
	stdin: {
		contents: `
			export { EmployeeEngine, TRANSIENT_RETRIES, transientRetryBackoffMs } from "./src/engine/engine.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { FileCredentialStore } from "./src/engine/credential-store.ts";
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
						const textOf = (m) => (m?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
						export class Agent {
							constructor(opts) {
								this.opts = opts;
								this.state = { ...opts.initialState, isStreaming: false, messages: [], errorMessage: undefined };
								this.runs = 0;
								this.#handlers = new Set();
								agents.push(this);
							}
							#handlers;
							subscribe(h) { this.#handlers.add(h); return () => this.#handlers.delete(h); }
							#emit(event) { for (const h of this.#handlers) h(event); }
							abort() {}
							// Mirrors runWithLifecycle: errorMessage cleared at run start,
							// provider failures become a failure assistant message + state
							// errorMessage (NOT a throw), success emits message_end events.
							async #execute(input) {
								this.runs += 1;
								this.state.errorMessage = undefined;
								this.state.isStreaming = true;
								try {
									const context = this.state.messages.length ? this.state.messages : [{ role: "user", content: [{ type: "text", text: input }], id: "u1" }];
									const response = await this.opts.streamFn(this.state.model, context, {});
									for await (const event of response ?? []) {
										if (event?.type === "error" && event.error?.errorMessage) this.state.errorMessage = event.error.errorMessage;
									}
									if (typeof response?.result === "function") {
										const final = await response.result();
										if (final?.role === "assistant" && !this.state.errorMessage) {
											this.state.messages.push(final);
											this.#emit({ type: "message_end", message: final });
										}
									}
								} catch (err) {
									this.state.errorMessage = err instanceof Error ? err.message : String(err);
								}
								if (this.state.errorMessage) {
									// handleRunFailure: failure assistant message lands in the transcript.
									this.state.messages.push({
										role: "assistant",
										content: [{ type: "text", text: "" }],
										stopReason: "error",
										errorMessage: this.state.errorMessage,
									});
								}
								this.state.isStreaming = false;
							}
							async prompt(input) {
								this.state.messages = [{ role: "user", content: [{ type: "text", text: input }], id: "u1" }];
								await this.#execute(input);
							}
							async continue() {
								// Real SDK throws on an empty/system-only transcript; the engine's
								// safeContinue strips the dangling failure tail first, so resume
								// runs against the remaining transcript.
								if (!this.state.messages.length) throw new Error("No messages to continue from");
								await this.#execute(undefined);
							}
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
const { EmployeeEngine, TRANSIENT_RETRIES, transientRetryBackoffMs, ConfigStore, HistoryStore, FileCredentialStore } = await import(pathToFileURL(bundle).href);

/** Real engine + injected retry-sleep capturing the backoff schedule. */
function makeEngine(t, { streamFn, retrySleepFn } = {}) {
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
	const knowledgeStub = { listMemoryIndex: () => [] };
	const stub = {};
	const delays = [];
	const engine = new EmployeeEngine(config, history, knowledgeStub, stub, stub, stub, stub, stub, stub, {
		builtinSkillsDir: dir,
		userSkillsDir: dir,
	}, {
		credentialStore: store,
		streamFn,
		retrySleepFn: retrySleepFn ?? (async (ms) => { delays.push(ms); }),
	});
	// turnIds (and thus markTurnAbort) only register when a telemetry store
	// exists — provide a no-op one so the abort test drives the real path.
	engine.setTelemetryStore({ recordTurn: () => {}, recordTool: () => {} });
	return { engine, config, delays };
}

const supplierConfig = (config) => config.update({
	model: {
		suppliers: [{ id: "s", name: "S", enabled: true, apiType: "openai-completions", baseUrl: "https://x.invalid", apiKey: "k", models: ["m"] }],
		defaultSupplierId: "s",
		defaultModelId: "m",
	},
});

// ── backoff schedule pins ──

test("TRANSIENT_RETRIES is 10 and the backoff increases 1s→2s→…→cap 60s (Claude Code style)", () => {
	assert.equal(TRANSIENT_RETRIES, 10);
	const schedule = Array.from({ length: TRANSIENT_RETRIES }, (_, i) => transientRetryBackoffMs(i + 1));
	assert.deepEqual(schedule, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
	for (let i = 1; i < schedule.length; i++) assert.ok(schedule[i] >= schedule[i - 1], "never shortens");
	const total = schedule.reduce((a, b) => a + b, 0);
	assert.ok(total < 6 * 60_000, `whole retry ladder stays under 6 min (got ${total}ms)`);
	assert.equal(transientRetryBackoffMs(0), 1000, "clamps low inputs");
	assert.equal(transientRetryBackoffMs(999), 60000, "clamps high inputs to the cap");
});

// ── behavioral: the blip is absorbed ──

test("a transient gateway blip is absorbed: retries twice with increasing waits, real reply delivered", async (t) => {
	let runs = 0;
	const { engine, config, delays } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		if (runs <= 2) throw new Error("Connection error.");
		return {
			async *[Symbol.asyncIterator]() { /* no events */ },
			result: async () => ({ role: "assistant", content: [{ type: "text", text: "对账完成" }], stopReason: "stop" }),
		};
	} });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-recover");
	const result = await engine.send(agent, "hi");
	assert.equal(result.reply, "对账完成", "the real reply surfaces, not the apology");
	assert.equal(result.deterministic, false, "not a stall");
	assert.equal(result.error, undefined);
	assert.equal(runs, 3, "initial + 2 retries");
	assert.deepEqual(delays, [1000, 2000], "backoff increases across retries");
});

// ── behavioral: persistent outage exhausts the ladder honestly ──

test("a persistent outage exhausts 10 retries (11 attempts) then surfaces the honest stall apology", async (t) => {
	const { engine, config, delays } = makeEngine(t, { streamFn: async () => { throw new Error("Connection error."); } });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-dead");
	const result = await engine.send(agent, "hi");
	assert.equal(result.deterministic, true, "chain runners key their pause on this flag");
	// A NAMED cause (Connection error.) surfaces it verbatim; the anonymous
	// stall apology (模型服务连续多次未返回内容) is only for content-less stalls.
	assert.match(result.reply, /没能完成你的请求/);
	assert.match(result.reply, /Connection error\./);
	assert.equal(agent.runs, 1 + TRANSIENT_RETRIES + 1, "no infinite retrying (last run is the final-summary ask, not a retry)");
	assert.equal(delays.length, TRANSIENT_RETRIES);
	assert.equal(delays[delays.length - 1], 60000, "ladder ends at the 60s cap");
});

// ── behavioral: a stop landing during the backoff fires no further requests ──

test("a /stop landing during the backoff ends the loop without another request (engine-side H1)", async (t) => {
	let sleeps = 0;
	const { engine, config } = makeEngine(t, {
		streamFn: async () => { throw new Error("Connection error."); },
		// Production /stop shape: manager calls engine.abortSession, NOT
		// markTurnAbort (review H1 — the old test drove the wrong entry point).
		retrySleepFn: async () => { sleeps += 1; engine.abortSession("conv-abort"); },
	});
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-abort");
	// Production agents carry sessionId (set by the session factory); the stub
	// must mirror it or send() falls back to "default" and the keys diverge.
	agent.sessionId = "conv-abort";
	const result = await engine.send(agent, "hi");
	assert.equal(agent.runs, 2, "only the final-summary run after the stop — no retried request");
	assert.equal(sleeps, 1, "loop exited at the post-sleep re-check");
	assert.equal(result.deterministic, true, "turn ends honestly instead of resuming");
});

test("the backoff window is visible to isIdle and interruptible by abortAllTurns (review M2)", async (t) => {
	let idleDuringWait;
	let sleeps = 0;
	const { engine, config } = makeEngine(t, {
		streamFn: async () => { throw new Error("Connection error."); },
		retrySleepFn: async () => {
			sleeps += 1;
			if (sleeps === 1) {
				idleDuringWait = engine.isIdle();
				// install_now shape: the updater only installs when isIdle clears;
				// abortAllTurns must reach the waiting turn anyway.
				assert.equal(engine.abortAllTurns("install_now"), 1, "the waiting turn is counted as aborted");
			}
		},
	});
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-m2");
	const result = await engine.send(agent, "hi");
	assert.equal(idleDuringWait, false, "isIdle must be false inside the backoff window");
	assert.equal(agent.runs, 2, "no retried request after install_now");
	assert.equal(sleeps, 1, "loop exited at the post-sleep re-check");
	assert.equal(result.deterministic, true);
});
