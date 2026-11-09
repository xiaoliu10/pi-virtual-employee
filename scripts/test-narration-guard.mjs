/**
 * Legacy narration guard (field 2026-11-09): a task-shaped turn with ZERO tool
 * calls must not settle for process narration — 「我来尝试登录生产后台管理…
 * 先检查一下当前环境可用的工具」 then silence, nothing executed. The guard
 * forces exactly ONE continuation; if the model still takes no action, the
 * delivered reply carries the honest notice. Never a loop (flood-loop lesson).
 *
 * Real EmployeeEngine + real send() tail; the Agent SDK is a scripted double
 * mirroring the shapes send() relies on — notably the REAL continue()
 * contract: a completed assistant tail is not a resumable anchor ("Cannot
 * continue from message role: assistant"), which drives the guard down its
 * driveTurn re-prompt fallback (the same fallback promptWithRetry uses).
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
const dir = await mkdtemp(join(root, "node_modules/.narration-guard-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "narration-guard.mjs");
await build({
	stdin: {
		contents: `
			export { EmployeeEngine, TRANSIENT_RETRIES } from "./src/engine/engine.ts";
			export { looksLikeImperative, looksLikeTask, NARRATION_GUARD_NOTICE } from "./src/engine/task-planner.ts";
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
	plugins: [
		{
			name: "stub-agent-sdk",
			setup(b) {
				b.onResolve({ filter: /^@earendil-works\/pi-agent-core$/ }, () => ({ path: "agent", namespace: "stub" }));
				// Same namespace trick as test-engine-retry: the vendored compaction
				// module is stubbed so no real summarizer runs in these tests.
				b.onResolve({ filter: /pi-compaction\.(js|ts)$/ }, () => ({ path: "compaction", namespace: "stub" }));
				b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
					contents: `
						export const agents = [];
						export class Agent {
							constructor(opts) {
								this.opts = opts;
								this.sessionId = opts.sessionId;
								this.state = { ...opts.initialState, isStreaming: false, messages: [], errorMessage: undefined, tools: [] };
								this.runs = 0;
								this.#handlers = new Set();
								agents.push(this);
							}
							#handlers;
							subscribe(h) { this.#handlers.add(h); return () => this.#handlers.delete(h); }
							#emit(event) { for (const h of this.#handlers) h(event); }
							abort() {}
							steered = [];
							steer(m) { this.steered.push(m); }
							hasQueuedMessages() { return this.steered.length > 0; }
							clearSteeringQueue() { this.steered = []; }
							clearFollowUpQueue() {}
							clearAllQueues() { this.clearSteeringQueue(); }
							createLoopConfig() { return {}; }
							async #execute() {
								this.runs += 1;
								this.state.errorMessage = undefined;
								this.state.isStreaming = true;
								try {
									const response = await this.opts.streamFn(this.state.model, this.state.messages, {});
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
									this.state.messages.push({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: this.state.errorMessage });
								}
								this.state.isStreaming = false;
							}
							// Real SDK shape: prompt APPENDS the user message to the
							// existing transcript (a re-drive keeps the narration).
							async prompt(input) {
								this.state.messages.push({ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() });
								await this.#execute();
							}
							// Real SDK contract: continue() refuses a completed assistant
							// tail — the guard must fall back to re-driving the input.
							async continue() {
								const last = this.state.messages[this.state.messages.length - 1];
								if (!last) throw new Error("Cannot continue: no messages in context");
								if (last.role === "assistant") throw new Error("Cannot continue from message role: assistant");
								await this.#execute();
							}
						}
						export const DEFAULT_COMPACTION_SETTINGS = {};
						export const convertToLlm = (x) => x;
						export const estimateContextTokens = () => ({ tokens: 0 });
						export const estimateTokensSafe = () => 0;
						export const estimateTokens = () => 0;
						export const generateSummary = () => Promise.reject(new Error("stubbed generateSummary"));
						export const shouldCompact = () => false;
						export const createCompactionSummaryMessage = (x) => x;
					`,
				}));
			},
		},
	],
});
const { EmployeeEngine, TRANSIENT_RETRIES, looksLikeImperative, looksLikeTask, NARRATION_GUARD_NOTICE, ConfigStore, HistoryStore, FileCredentialStore } = await import(pathToFileURL(bundle).href);

/** Real engine + scripted provider (same harness shape as test-engine-retry). */
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
	const knowledgeStub = { listMemoryIndex: () => [], listScopedMemoryIndex: () => [] };
	const stub = {};
	const engine = new EmployeeEngine(config, history, knowledgeStub, stub, stub, stub, stub, stub, stub, {
		builtinSkillsDir: dir,
		userSkillsDir: dir,
	}, {
		credentialStore: store,
		streamFn,
		retrySleepFn: retrySleepFn ?? (async () => {}),
	});
	engine.setTelemetryStore({ recordTurn: () => {}, recordTool: () => {} });
	return { engine, config, history };
}

const supplierConfig = (config) => config.update({
	model: {
		suppliers: [{ id: "s", name: "S", enabled: true, apiType: "openai-completions", baseUrl: "https://x.invalid", apiKey: "k", models: ["m"] }],
		defaultSupplierId: "s",
		defaultModelId: "m",
	},
});

const textReply = (text) => ({
	async *[Symbol.asyncIterator]() { /* no events */ },
	result: async () => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }),
});

/** Task-shaped: 登录 (task verb) + 然后 (multi-step evidence). */
const TASK = "登录生产后台管理系统，然后检查环境并验证登录状态";
const NARRATION = "我来尝试登录生产后台管理。先检查一下当前环境可用的工具。";

test("the fixture message is task-shaped (the guard's looksLikeTask seam)", () => {
	assert.equal(looksLikeTask(TASK), true);
	assert.equal(looksLikeTask("hi"), false);
});

test("zero-tool task turn: guard continues exactly once and delivers the NEW reply", async (t) => {
	let runs = 0;
	let noteTool;
	const { engine, config, history } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		if (runs === 2) noteTool?.(); // the continuation actually executes a tool
		return textReply(runs === 1 ? NARRATION : "登录成功，环境检查完成。");
	} });
	noteTool = () => engine.recordToolTelemetry("conv-narrate-once", { name: "browser", durationMs: 5, ok: true });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-narrate-once");
	const result = await engine.send(agent, TASK);
	assert.equal(result.reply, "登录成功，环境检查完成。", "the continuation reply replaces the narration");
	assert.ok(!result.reply.includes(NARRATION_GUARD_NOTICE), "a continuation that used tools needs no notice");
	assert.equal(runs, 2, "exactly one forced continuation — never a loop");
	assert.equal(result.deterministic, false);
	// The SDK refuses assistant-tail continuation, so the guard re-drove the
	// instruction: the transcript carries the user turn twice, narration kept.
	assert.equal(agent.state.messages.filter((m) => m.role === "user").length, 2, "the fallback re-drive replayed the instruction");
	assert.equal(history.listMessages("conv-narrate-once").filter((m) => m.role === "assistant").at(-1)?.content, result.reply, "history persists the delivered reply");
});

test("still zero tools after the one continuation: honest notice appended, no second attempt", async (t) => {
	let runs = 0;
	const { engine, config } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		return textReply(runs === 1 ? NARRATION : "我需要先了解当前环境，然后再继续。");
	} });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-narrate-twice");
	const result = await engine.send(agent, TASK);
	assert.ok(result.reply.startsWith("我需要先了解当前环境"), "the continuation text is delivered");
	assert.ok(result.reply.endsWith(NARRATION_GUARD_NOTICE), "the no-action notice must be appended");
	assert.equal(runs, 2, "the guard runs exactly once even when the continuation narrates again");
});

test("a turn that already used tools never triggers the guard", async (t) => {
	let runs = 0;
	let noteTool;
	const { engine, config } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		noteTool?.(); // a real tool event of this turn (the counting path tools use)
		return textReply(NARRATION);
	} });
	noteTool = () => engine.recordToolTelemetry("conv-with-tools", { name: "browser", durationMs: 5, ok: true });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-with-tools");
	const result = await engine.send(agent, TASK);
	assert.equal(runs, 1, "tool evidence must not trigger a continuation");
	assert.equal(result.reply, NARRATION, "a tool-using turn's final text is delivered as-is");
	assert.ok(!result.reply.includes(NARRATION_GUARD_NOTICE));
});

test("a non-task message is never continued", async (t) => {
	let runs = 0;
	const { engine, config } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		return textReply("你好，有什么可以帮你？");
	} });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-chat");
	const result = await engine.send(agent, "hi");
	assert.equal(runs, 1);
	assert.equal(result.reply, "你好，有什么可以帮你？");
});

test("a user-stopped turn is never continued (the stop stays terminal)", async (t) => {
	let runs = 0;
	let markStop;
	const { engine, config } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		markStop?.(); // /stop landing mid-turn (markTurnAbort needs a live turnId)
		return textReply(NARRATION);
	} });
	markStop = () => engine.markTurnAbort("conv-stopped", "user");
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-stopped");
	const result = await engine.send(agent, TASK);
	assert.equal(runs, 1, "a deliberate stop must not be overridden by the guard");
	assert.ok(!result.reply.includes(NARRATION_GUARD_NOTICE));
});

test("a cap-hit turn is never continued (the cap summary is the outcome)", async (t) => {
	let runs = 0;
	const { engine, config } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		if (runs === 1) {
			// The finishTurn hook's flag, set mid-run exactly as the cap does.
			engine.getOrCreateSession("conv-capped").__toolStepCapHit = true;
			return textReply(NARRATION);
		}
		return textReply("已登录，剩余步骤未完成。");
	} });
	supplierConfig(config);
	config.update({ general: { maxToolSteps: 5 } });
	const agent = engine.getOrCreateSession("conv-capped");
	const result = await engine.send(agent, TASK);
	assert.equal(runs, 2, "only the cap's final-summary ask — no guard continuation");
	assert.match(result.reply, /工具调用已达上限/, "the cap notice is the delivered outcome");
	assert.ok(!result.reply.includes(NARRATION_GUARD_NOTICE));
});

test("a deterministic failure is never continued", async (t) => {
	let runs = 0;
	const { engine, config } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		throw new Error("Connection error.");
	} });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-dead");
	const result = await engine.send(agent, TASK);
	assert.equal(result.deterministic, true);
	assert.equal(runs, 1 + TRANSIENT_RETRIES + 1, "retry ladder + final-summary ask only — the guard adds nothing");
	assert.ok(!result.reply.includes(NARRATION_GUARD_NOTICE));
});

test("an ephemeral side pass is never continued", async (t) => {
	let runs = 0;
	const { engine, config } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		return textReply(NARRATION);
	} });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-ephemeral");
	const result = await engine.send(agent, TASK, { ephemeral: true });
	assert.equal(runs, 1, "eval/learn side passes are not user turns");
	assert.equal(result.reply, NARRATION);
});
// ── The looksLikeImperative seam (field 2026-11-09 literal message) ───────
// 「继续 登录生产后台管理」 (11 chars, no punctuation) carries a task verb but no
// multi-step evidence, so looksLikeTask is false — and before the imperative
// detector the turn answered with pure narration and silently ended. The guard
// must fire for it; question-shaped texts must stay Q&A.

const FIELD_MESSAGE = "继续 登录生产后台管理";

test("the field message is an imperative though not task-shaped", () => {
	assert.equal(looksLikeTask(FIELD_MESSAGE), false, "no multi-step evidence — the very seam");
	assert.equal(looksLikeImperative(FIELD_MESSAGE), true, "task verb + imperative lead");
	assert.equal(looksLikeImperative("登录密码是什么"), false, "question shape stays Q&A");
	assert.equal(looksLikeImperative("你好"), false);
});

test("review 94189d6f P2: mid-sentence question words are NOT imperatives", () => {
	// These start like an imperative (帮我/请 + task verb) but ASK for an
	// explanation — an unanchored question-word probe must reject them, or the
	// narration guard would nudge a legitimate Q&A answer (one wasted LLM call,
	// and on the durable side there is no isQuestion second gate).
	for (const q of [
		"帮我分析下为什么登录失败",
		"请解释一下为什么登录失败",
		"帮我看看怎么回事登录不上",
		"请告诉我登录入口在哪里",
		"登录密码是多少",
		"帮我查一下是什么意思",
	]) {
		assert.equal(looksLikeImperative(q), false, `mid-sentence question must not be an imperative: ${q}`);
	}
	// Positive control: genuine imperatives still fire.
	for (const t of ["继续 登录生产后台管理", "帮我登录后台", "请重启服务", "登录后台"]) {
		assert.equal(looksLikeImperative(t), true, `genuine imperative must fire: ${t}`);
	}
});

test("zero-tool short imperative turn: the guard fires for the literal field message", async (t) => {
	let runs = 0;
	let noteTool;
	const { engine, config } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		if (runs === 2) noteTool?.(); // the continuation actually executes a tool
		return textReply(runs === 1 ? NARRATION : "登录完成，后台管理已可用。");
	} });
	noteTool = () => engine.recordToolTelemetry("conv-field-imperative", { name: "browser", durationMs: 5, ok: true });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-field-imperative");
	const result = await engine.send(agent, FIELD_MESSAGE);
	assert.equal(result.reply, "登录完成，后台管理已可用。", "the continuation reply replaces the narration");
	assert.ok(!result.reply.includes(NARRATION_GUARD_NOTICE));
	assert.equal(runs, 2, "exactly one forced continuation");
});


test("review 94189d6f P3: the guard's continuation keeps the turn's RBAC identity (snapshot restore + cleanup)", async (t) => {
	let runs = 0;
	let actorDuringContinuation;
	let noteTool;
	const { engine, config } = makeEngine(t, { streamFn: async () => {
		runs += 1;
		if (runs === 2) {
			// The continuation runs AFTER the turn's finally deleted the turn-scoped
			// maps — the guard must have re-registered the actor snapshot by now,
			// or every tool in the continuation degrades to viewer RBAC.
			actorDuringContinuation = engine.turnActor.get("conv-rbac");
			noteTool?.();
		}
		return textReply(runs === 1 ? NARRATION : "登录完成。");
	} });
	noteTool = () => engine.recordToolTelemetry("conv-rbac", { name: "browser", durationMs: 5, ok: true });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-rbac");
	const result = await engine.send(agent, FIELD_MESSAGE, {
		actor: { senderId: "u1", senderName: "Jason", channel: "dingtalk", chatType: "single" },
	});
	assert.equal(result.reply, "登录完成。");
	assert.ok(actorDuringContinuation, "turnActor must be live during the continuation");
	assert.equal(actorDuringContinuation.senderId, "u1", "the continuation keeps the verified sender identity (RBAC does not degrade to viewer)");
	assert.equal(actorDuringContinuation.text, FIELD_MESSAGE, "the snapshot carries the turn's original text");
	// No per-conversation state survives the guard (idle processes stay clean).
	assert.equal(engine.turnActor.size, 0, "turnActor cleaned after the guard");
	assert.equal(engine.turnActorsSaved.size, 0, "snapshot map cleaned after the guard");
	assert.equal(engine.turnMemorySaved.size, 0, "memory snapshot cleaned after the guard");
});
