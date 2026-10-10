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
			export { estimateTokensSafe } from "./src/engine/context.ts";
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
				// The compaction primitives moved into the vendored module — stub it
				// with the same namespace so the hook stays wired.
				b.onResolve({ filter: /pi-compaction\.(js|ts)$/ }, () => ({ path: "compaction", namespace: "stub" }));
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
						export const estimateContextTokens = () => ({ tokens: 0 });
						export const estimateTokensSafe = () => 0;
						export const estimateTokens = () => 0;
						// pi 1.x contract: generateSummary returns the summary string and
						// THROWS on failure (the 0.99 {ok, value} Result is gone). Hooks
						// may keep returning the old Result shape — translated here.
						export const generateSummary = (...args) => {
							if (!globalThis.__generateSummaryHook) return Promise.reject(new Error("stubbed generateSummary: no hook"));
							return Promise.resolve(globalThis.__generateSummaryHook(...args)).then((r) => {
								if (r && typeof r === "object" && "ok" in r) {
									if (!r.ok) throw new Error("stubbed summarizer failed");
									return r.value;
								}
								return r;
							});
						};
						export const shouldCompact = () => false;
						export const createCompactionSummaryMessage = (x) => x;
					`,
				}));
			},
		},
	],
});
const { EmployeeEngine, TRANSIENT_RETRIES, transientRetryBackoffMs, estimateTokensSafe, ConfigStore, HistoryStore, FileCredentialStore } = await import(pathToFileURL(bundle).href);

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

/**
 * Fill an agent's transcript with enough realistic CJK narration to clear the
 * 2_000-token progress-brief floor FOR REAL — estimateTokensSafe counts CJK
 * chars 1:1 and the stubbed estimateContextTokens faithfully returns
 * { tokens: 0 } (review M2: the old stub pinned 5_000, so every test silently
 * passed the gate regardless of transcript size, and the bare-number stub
 * before it made `.tokens` undefined → NaN → `NaN < 2_000` false). Tests that
 * need the side-channel LLM path must EARN it with transcript size; the
 * assertion uses the real engine/context helper and pins the value finite.
 */
function fillTranscriptPastProgressFloor(agent) {
	for (let i = 0; i < 40; i++) {
		agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: `第 ${i} 步：下载对账文件并逐条核对掉单记录与金额差异，差异清单已汇总同步给财务负责人确认口径并等待回复，继续推进剩余批次处理。` }],
		});
	}
	const tokens = estimateTokensSafe(agent.state.messages);
	assert.ok(Number.isFinite(tokens), `token estimate must be finite, got ${tokens}`);
	assert.ok(tokens >= 2_000, `fixture must REALLY clear the 2_000-token floor (got ${tokens})`);
	return tokens;
}

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

test("progress brief: a compaction-template echo falls back, a compliant four-field brief passes (review H1/L2)", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-progress");
	// progressBrief only calls the side channel once the transcript is worth it
	// (>= ~2000 tokens, counted for real — see fillTranscriptPastProgressFloor).
	fillTranscriptPastProgressFloor(agent);
	try {
		// H1: template echo must fall back to the deterministic brief — and must
		// NOT be discarded merely for using 「## 已完成」 or the word "Goal".
		globalThis.__generateSummaryHook = async () => ({ ok: true, value: "## Goal 跟踪处理掉单\n## Constraints & Preferences\n- 处理流程：获取对账文件" });
		const leaked = await engine.progressBrief(agent, "conv-progress");
		assert.ok(!leaked.includes("## Goal"), "template headings never reach the user");
		assert.ok(leaked.includes("任务仍在进行中"), "the deterministic brief is shown instead");

		globalThis.__generateSummaryHook = async () => ({ ok: true, value: "已完成：12 条重新对账；剩余：12 条待下载；正在：逐条下载对账文件；卡点：无" });
		const good = await engine.progressBrief(agent, "conv-progress");
		assert.equal(good, "⏳ 任务仍在进行中。已完成：12 条重新对账；剩余：12 条待下载；正在：逐条下载对账文件；卡点：无", "a compliant brief passes verbatim");

		// H1 negative: an English word or a Chinese markdown heading is NOT a leak.
		globalThis.__generateSummaryHook = async () => ({ ok: true, value: "## 已完成\n12 条对账完成；剩余：无；正在：汇总；卡点：无" });
		const cnHeading = await engine.progressBrief(agent, "conv-progress");
		assert.ok(!cnHeading.includes("（已耗时较长）"), "a Chinese ## heading must not trigger the fallback");

		// M2/D (hardened): the long fixture is now REALLY long — the old one fit
		// inside the budget and never exercised a cut. 已完成 alone exceeds one
		// field's cap and 卡点 exceeds its own (larger, independent 80-char cap):
		// per-field clamping must keep the 卡点 item (label + content) alive where
		// the old global 180-char slice could amputate it after a long 已完成.
		const doneBody = "逐条下载对账文件并核对金额差异，完成前三批共一百二十条记录的重新对账，".repeat(4);
		const blockedBody = "第四批数据依赖的财务接口返回超时，导致剩余对账无法继续，需要等待运维恢复服务后重试，同时已经把差异清单发给负责人确认口径，等待回复后继续处理剩余部分，并请运维同步恢复进度与预计时间";
		assert.ok(doneBody.length > 120 && blockedBody.length > 80, "fixture fields must really exceed their per-field caps");
		const long = `已完成：${doneBody}；剩余：12 条待下载检查的记录需要逐条处理；正在：逐条下载最新对账文件并核对金额差异；卡点：${blockedBody}`;
		globalThis.__generateSummaryHook = async () => ({ ok: true, value: long });
		const cut = await engine.progressBrief(agent, "conv-progress");
		assert.ok(cut.includes("卡点：第四批数据依赖的财务接口返回超时"), "the 卡点 item survives a long 已完成 (never globally amputated)");
		assert.ok(cut.includes("剩余：12 条待下载检查的记录"), "middle fields survive");
		// Per-field budget: prefix + labels/colons + clamped content (≤51 each,
		// 卡点 ≤81 under its independent cap) + 3 separators.
		assert.ok(cut.length <= "⏳ 任务仍在进行中。".length + 4 + 51 + 1 + 3 + 51 + 1 + 3 + 51 + 1 + 3 + 81, "bounded output (per-field caps, not a global slice)");
		assert.ok(!cut.endsWith("卡点："), "never ends on a dangling label");
	} finally {
		delete globalThis.__generateSummaryHook;
	}
});

// D (hardening): the model path FAILING entirely (the stub's generateSummary
// resolves { ok: false } with no hook installed) while a rehydrated compaction
// template sits as the LAST assistant turn. The old fallback tail
// (lastAssistantTailOf) echoed "## Goal … ## Constraints …" verbatim; the
// deterministic fallback must stay template-free, keep all four fields, and
// report unknown as 暂未确认 — never as an invented 无.
test("failed model + template-carrying last assistant: fallback keeps four fields, no template, unknown ≠ 无", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-fb-template");
	// The transcript must REALLY clear the 2_000-token floor so the side call is
	// genuinely attempted — and fails (no hook installed, the stub resolves
	// { ok: false }) — before the fallback runs.
	fillTranscriptPastProgressFloor(agent);
	agent.state.messages.push({
		role: "assistant",
		content: [{ type: "text", text: "## Goal 跟踪处理 24 条工行数币掉单异常\n## Constraints & Preferences\n- 处理流程：获取对账文件 → 下载 → 检查" }],
	});
	const brief = await engine.progressBrief(agent, "conv-fb-template");
	assert.ok(!brief.includes("## Goal") && !brief.includes("Constraints"), "no template headings reach the user");
	for (const label of ["已完成：", "剩余：", "正在：", "卡点："]) assert.ok(brief.includes(label), `field ${label} always present`);
	assert.ok(brief.includes("暂未确认"), "unevidenced fields read 暂未确认");
	assert.ok(!brief.includes("卡点：无"), "an unknown blocker is never reported as 无");
});

// A PARTIAL model report (labels missing) is not shown either — the
// deterministic fallback fills the gaps honestly instead of papering over them.
test("a partial model report (missing labels) falls back and fills 卡点 with 暂未确认, not 无", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-fb-partial");
	fillTranscriptPastProgressFloor(agent);
	try {
		globalThis.__generateSummaryHook = async () => ({ ok: true, value: "已完成：前三批共 120 条重新对账；剩余：12 条待处理" });
		const brief = await engine.progressBrief(agent, "conv-fb-partial");
		assert.ok(!brief.includes("前三批共 120 条"), "the partial report is not shown");
		assert.ok(brief.includes("卡点：暂未确认"), "the fallback fills 卡点 honestly");
		assert.ok(!brief.includes("卡点：无"));
	} finally {
		delete globalThis.__generateSummaryHook;
	}
});

// The instruction itself must forbid defaulting unknown fields to 无: absent
// information reads 暂未确认; only an execution record that clearly shows no
// obstacle may say 无. Also pinned: a model-said 暂未确认 passes through.
test("the progress instruction demands 暂未确认 over invented 无; a 暂未确认 brief passes through", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-instruction");
	fillTranscriptPastProgressFloor(agent);
	let instruction;
	try {
		globalThis.__generateSummaryHook = async (...args) => {
			instruction = args[5];
			return { ok: true, value: "已完成：12 条重新对账；剩余：12 条待下载；正在：逐条下载；卡点：暂未确认" };
		};
		const brief = await engine.progressBrief(agent, "conv-instruction");
		assert.ok(instruction, "the instruction reached the summarizer");
		assert.match(instruction, /暂未确认/);
		assert.match(instruction, /严禁在记录没有依据时推断成「无」/);
		assert.doesNotMatch(instruction, /没有对应信息就写/, "the old 「未知 or 无」 default is gone");
		assert.ok(brief.includes("卡点：暂未确认"), "a model-said 暂未确认 is kept verbatim");
	} finally {
		delete globalThis.__generateSummaryHook;
	}
});

// Ordinary English vocabulary must not trip the template guard (review H1).
test("a compliant brief carrying the English word 'Goal' is not rejected", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-goal-word");
	fillTranscriptPastProgressFloor(agent);
	try {
		globalThis.__generateSummaryHook = async () => ({ ok: true, value: "已完成：完成 Goal 分解并下载全部文件；剩余：数据入库；正在：核对入库条数；卡点：无" });
		const brief = await engine.progressBrief(agent, "conv-goal-word");
		assert.ok(brief.includes("Goal"), "ordinary English vocabulary passes");
		assert.ok(brief.includes("已完成：完成 Goal 分解并下载全部文件"));
	} finally {
		delete globalThis.__generateSummaryHook;
	}
});

test("progress brief below the 2k-token floor returns the deterministic fallback without a side call (review M2: the gate is now real)", async (t) => {
	let sideCalls = 0;
	const { engine, config } = makeEngine(t, {
		streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }),
		retrySleepFn: async () => {},
	});
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-small");
	agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "刚开始执行" }] });
	// No stubbed token count: the faithful stub returns { tokens: 0 }, so this
	// genuinely tiny transcript is below the floor on the REAL CJK-aware count.
	const tokens = estimateTokensSafe(agent.state.messages);
	assert.ok(Number.isFinite(tokens) && tokens < 2_000, `fixture must REALLY sit below the floor (got ${tokens})`);
	globalThis.__generateSummaryHook = async () => { sideCalls += 1; return { ok: true, value: "已完成：x；剩余：y；正在：z；卡点：无" }; };
	try {
		const brief = await engine.progressBrief(agent, "conv-small");
		assert.equal(sideCalls, 0, "no side-channel call below the floor");
		assert.ok(brief.includes("任务仍在进行中"), "deterministic fallback shown");
	} finally {
		delete globalThis.__generateSummaryHook;
	}
});

// ── review M1: the deterministic fallback must not reuse the PREVIOUS task's
// progress for the CURRENT one ──

test("cross-task: a NEW user request with no fresh report never inherits the old task's numbers/无 (review M1)", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-m1-newtask");
	// Old task, fully reported in the canonical four-field shape.
	agent.state.messages.push({ role: "user", content: [{ type: "text", text: "统计 9 月全部渠道的对账异常" }] });
	agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "已完成：24 条全部对账；剩余：0 条；正在：生成汇总；卡点：无" }] });
	// NEW task — the anchor. Everything before it is off-limits as evidence.
	agent.state.messages.push({ role: "user", content: [{ type: "text", text: "把上周的掉单明细整理成表格发我" }] });
	agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "已开始读取上周掉单明细，整理表格结构中。" }] });
	// No hook: the model path fails, so the deterministic fallback decides.
	const brief = await engine.progressBrief(agent, "conv-m1-newtask");
	assert.ok(!brief.includes("24 条"), "the old task's numbers are not reused for the new task");
	assert.ok(!brief.includes("卡点：无"), "the old task's 无 is not reused either");
	assert.ok(brief.includes("已完成：暂未确认"), "unevidenced fields of the NEW task read 暂未确认");
	assert.ok(brief.includes("当前请求：把上周的掉单明细整理成表格发我"), "the head is the CURRENT request, not the old task");
});

test("cross-task: an old compaction goal never heads a NEW task's brief (review M1)", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-m1-goal");
	// The OLD task's curated compaction record survived at the head.
	agent.state.messages.push({ role: "compactionSummary", summary: "## Goal 跟踪处理 24 条工行数币掉单异常\n## Constraints & Preferences\n- 处理流程：获取对账文件", timestamp: Date.now() });
	agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "已完成：24 条全部对账；剩余：0 条；正在：生成汇总；卡点：无" }] });
	// A NEW substantial request — the brief must be headed by IT, not the old goal.
	agent.state.messages.push({ role: "user", content: [{ type: "text", text: "核对本周新增渠道的流水一致性" }] });
	agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "正在拉取本周流水数据。" }] });
	const brief = await engine.progressBrief(agent, "conv-m1-goal");
	assert.ok(!brief.includes("掉单异常") && !brief.includes("工行数币"), "the old task's curated goal is not mixed into the new task's brief");
	assert.ok(brief.includes("当前请求：核对本周新增渠道的流水一致性"), "the current request heads the brief, labeled as a request");
	assert.ok(!brief.includes("24 条"), "no old-task numbers");
});

test("ack anchor: 「继续」 after an old report — evidence does not cross the anchor; unknown beats a cross-task misreport (review M1)", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-m1-ack");
	agent.state.messages.push({ role: "user", content: [{ type: "text", text: "统计 9 月全部渠道的对账异常" }] });
	agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "已完成：24 条全部对账；剩余：0 条；正在：生成汇总；卡点：无" }] });
	// A bare ack is still the anchor: what came before it is not evidence for
	// what comes after — conservatively unknown rather than possibly cross-task.
	agent.state.messages.push({ role: "user", content: [{ type: "text", text: "继续" }] });
	agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "继续处理剩余批次。" }] });
	const brief = await engine.progressBrief(agent, "conv-m1-ack");
	assert.ok(!brief.includes("24 条") && !brief.includes("卡点：无"), "the pre-ack report is not reused");
	assert.ok(brief.includes("暂未确认"), "unknown is reported honestly");
	// The ack itself is never quoted as the task (field 2026-09-30); the head is
	// the latest SUBSTANTIAL request, labeled as a request.
	assert.ok(brief.includes("当前请求：统计 9 月全部渠道的对账异常"), "acks are skipped for the head");
	assert.ok(!brief.includes("任务：继续"), "the ack is never the task name");
});

test("compaction-summary head is still used when every substantial request was compacted away (任务 label kept)", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("conv-m1-summary");
	agent.state.messages.push({ role: "compactionSummary", summary: "## Goal 跟踪处理 24 条工行数币掉单异常\n## Constraints & Preferences\n- 处理流程：获取对账文件", timestamp: Date.now() });
	// Only acks since the compaction — no substantial request survives, so the
	// curated record is the only honest task identity (heartbeatGoalOf design).
	agent.state.messages.push({ role: "user", content: [{ type: "text", text: "继续" }] });
	agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "继续处理中。" }] });
	const brief = await engine.progressBrief(agent, "conv-m1-summary");
	assert.ok(brief.includes("任务：跟踪处理 24 条工行数币掉单异常"), "the curated summary heads the brief, labeled 任务");
	assert.ok(!brief.includes("## Goal"), "the template heading itself is never echoed");
});
