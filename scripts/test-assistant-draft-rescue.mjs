/**
 * Trailing-draft rescue (field 2026-11-13, box work window): the model emitted
 * its full 巡检报告 alongside a manage_work set_progress call and closed the
 * turn with a short sign-off ("…报告已推群…[[NEXT_CHECK]]: …"). Only the LAST
 * assistant text is the reply — so the report was silently discarded while the
 * sign-off's unconfirmed "已推群" claim went out instead (the 17:27 window's
 * 2272-char report vs its 187-char final reply, measured on the box).
 *
 * The rescue: a step whose ONLY tool calls are bookkeeping (manage_work /
 * manage_work_items / save_to_knowledge / save_to_skill / remember) can never
 * justify superseding a substantial text; the last such pending draft is
 * prepended ahead of a shorter closing text. Steps followed by real execution
 * tools reset the pending draft (narration stays suppressed), and a
 * substantial FINAL text is delivered as-is — normal chat behavior unchanged.
 *
 * Real EmployeeEngine + real send() tail; the Agent SDK is a scripted double
 * (same harness shape as test-narration-guard), extended to emit EVERY
 * assistant message_end of a multi-step turn — the shape the rescue reads.
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
const dir = await mkdtemp(join(root, "node_modules/.draft-rescue-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "draft-rescue.mjs");
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
						export class Agent {
							constructor(opts) {
								this.opts = opts;
								this.sessionId = opts.sessionId;
								this.state = { ...opts.initialState, isStreaming: false, messages: [], errorMessage: undefined, tools: [] };
								this.#handlers = new Set();
							}
							#handlers;
							subscribe(h) { this.#handlers.add(h); return () => this.#handlers.delete(h); }
							#emit(event) { for (const h of this.#handlers) h(event); }
							abort() {}
							steer() {}
							hasQueuedMessages() { return false; }
							clearSteeringQueue() {}
							clearFollowUpQueue() {}
							clearAllQueues() {}
							createLoopConfig() { return {}; }
							async #execute() {
								this.state.errorMessage = undefined;
								this.state.isStreaming = true;
								try {
									const response = await this.opts.streamFn(this.state.model, this.state.messages, {});
									// Multi-step tool loop: EVERY yielded assistant message is
									// a message_end — the shape the trailing-draft rescue reads.
									for await (const event of response ?? []) {
										if (event?.type === "error" && event.error?.errorMessage) this.state.errorMessage = event.error.errorMessage;
										if (Array.isArray(event?.content)) {
											this.state.messages.push(event);
											this.#emit({ type: "message_end", message: event });
										}
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
							async prompt(input) {
								this.state.messages.push({ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() });
								await this.#execute();
							}
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
const { EmployeeEngine, ConfigStore, HistoryStore, FileCredentialStore } = await import(pathToFileURL(bundle).href);

/** Real engine + scripted provider (same harness shape as test-narration-guard). */
function makeEngine(t, { streamFn } = {}) {
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
		retrySleepFn: async () => {},
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

/** A tool-loop step: narration text + tool calls (stopReason toolCalls). */
const step = (text, toolNames = []) => ({
	role: "assistant",
	content: [
		...(text ? [{ type: "text", text }] : []),
		...toolNames.map((name, i) => ({ type: "toolCall", id: `t${i}`, name, arguments: {} })),
	],
	stopReason: toolNames.length ? "toolCalls" : "stop",
});
const finalText = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });

const REPORT = "📋 日终对账异常巡检报告（2026-11-07 ~ 2026-11-12）\n" +
	"共扫描 9297 行对账记录，发现异常 40 笔：✅ 已自动修复 1 笔；⚠️ 待观察 2 笔；❌ 需人工确认 37 笔。\n" +
	"明细（37 笔缺失文件，按日汇总）：\n- 11-07：8 笔，集中在渠道 A\n- 11-08：11 笔，集中在渠道 B\n- 11-12：6 笔，集中在渠道 C\n" +
	"完整报告（含逐笔明细与修复记录）：https://reports.example.com/db64eaa0.html";
const CLOSING = "本轮巡检已完成（上一窗口），报告已推群，无新增异常。[[NEXT_CHECK]]: 2026-11-14 09:35";

test("field shape: report emitted alongside manage_work, short closing supersedes it → rescue prepends the report", async (t) => {
	const { engine, config, history } = makeEngine(t, { streamFn: async () => ({
		async *[Symbol.asyncIterator]() {
			yield step("先扫描对账记录，然后逐项处理异常。", ["run_command"]);
			yield step(REPORT, ["manage_work"]);
		},
		result: async () => finalText(CLOSING),
	}) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("draft-rescue-basic");
	const result = await engine.send(agent, "推进巡检窗口");
	assert.ok(result.reply.startsWith(REPORT), "the report rides the delivered reply, not the 187-char sign-off alone");
	assert.ok(result.reply.includes("[[NEXT_CHECK]]: 2026-11-14 09:35"), "the closing marker stays at the tail where the window parser expects it");
	assert.ok(result.reply.length > REPORT.length, "the closing text survives after the report");
	// The merged reply is what history persists — the next window rehydrates the full deliverable.
	assert.equal(history.listMessages("draft-rescue-basic").filter((m) => m.role === "assistant").at(-1)?.content, result.reply);
});

test("narration ahead of run_command is NOT rescued — a real tool resets the pending draft", async (t) => {
	const longPlan = "这次巡检我计划分几个步骤来完成：首先检查登录状态是否有效，然后逐日扫描近七天的对账记录，" +
		"把异常逐笔列出来，对可以自动修复的先修复，剩下的生成明细报告，最后统一推送并安排下一次跟进时间。";
	const { engine, config } = makeEngine(t, { streamFn: async () => ({
		async *[Symbol.asyncIterator]() {
			yield step(longPlan, ["manage_work"]);
			yield step("开始扫描对账记录。", ["run_command"]);
		},
		result: async () => finalText("扫描完成，无新增异常。"),
	}) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("draft-rescue-reset");
	const result = await engine.send(agent, "推进巡检窗口");
	assert.equal(result.reply, "扫描完成，无新增异常。", "narration ahead of a real tool call stays suppressed");
});

test("substantial final text is the deliverable — nothing merged, no duplication", async (t) => {
	const finalReport = REPORT + "\n本轮全部处理完毕，无需人工跟进。";
	const { engine, config } = makeEngine(t, { streamFn: async () => ({
		async *[Symbol.asyncIterator]() {
			yield step("扫描对账记录中。", ["run_command"]);
			yield step(REPORT, ["manage_work"]);
		},
		result: async () => finalText(finalReport),
	}) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("draft-rescue-final-substantial");
	const result = await engine.send(agent, "推进巡检窗口");
	assert.equal(result.reply, finalReport, "a substantial final text is delivered as-is");
	assert.equal(result.reply.split(REPORT.slice(0, 30)).length - 1, 1, "no duplicated report body");
});

test("short bookkeeping-step text is narration — below the draft threshold, not rescued", async (t) => {
	const { engine, config } = makeEngine(t, { streamFn: async () => ({
		async *[Symbol.asyncIterator]() {
			yield step("先把进展记录一下。", ["manage_work"]);
		},
		result: async () => finalText("巡检完成。"),
	}) });
	supplierConfig(config);
	const agent = engine.getOrCreateSession("draft-rescue-short");
	const result = await engine.send(agent, "推进巡检窗口");
	assert.equal(result.reply, "巡检完成。", "short step narration never rides the reply");
});
