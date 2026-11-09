/**
 * P1 WorkSession ⇄ CCL wiring tests (router-worker-core.md §6.4/§11).
 *
 * Real EmployeeEngine + real ContextStore + real HistoryStore on node:sqlite;
 * the Agent SDK is stubbed with a scripted double that (unlike the retry
 * suite's) APPENDS to the transcript and can execute a real engine-built tool,
 * so the whole chain is exercised end to end:
 *
 *   engine.send(work:<id>) → withTelemetry briefs → recordToolTelemetry buffer
 *   → appendNext request/digest/reply rows → ledger compaction → replaceHead
 *
 * Load-bearing pins:
 *  - a work turn's ledger rows (request stripped of scaffold, digests in call
 *    order, final reply) with consecutive allocated seqs;
 *  - work sessions assemble context from the LEDGER — the 40-line rehydrate
 *    cap no longer applies to work:<id> (IM keeps it, PR-4 untouched);
 *  - under kernel="durable", work sessions drive DIRECTLY (replacing the
 *    durable work path) while every other conversation still demands the
 *    durable runtime — the explicit engineKernel="durable" path stays usable;
 *  - the tool wrapper collects bounded, secret-masked briefs; the digest
 *    degrades honestly (name+cost+outcome) when briefs are absent.
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
const dir = await mkdtemp(join(root, "node_modules/.work-session-ccl-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "work-session-ccl.mjs");
await build({
	stdin: {
		contents: `
			export { EmployeeEngine } from "./src/engine/engine.ts";
			export { withTelemetry } from "./src/engine/definition.ts";
			export { toolDigestDraft, workRequestText, replaceHeadDiff, workLedgerBudgetTokens, isWorkConversation } from "./src/engine/work-ledger.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { FileCredentialStore } from "./src/engine/credential-store.ts";
			export { ContextStore } from "./src/context/store.ts";
			export { COMPACTION_SUMMARY_MARK, isSummaryRecord } from "./src/context/records.ts";
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
				// The compaction primitives live in the vendored module — stub with the
				// same namespace so the hook stays wired. DEFAULT_COMPACTION_SETTINGS /
				// shouldCompact keep their REAL values/logic: the ledger compaction
				// wiring under test depends on the actual threshold arithmetic.
				b.onResolve({ filter: /pi-compaction\.(js|ts)$/ }, () => ({ path: "compaction", namespace: "stub" }));
				b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
					contents: `
						export class Agent {
							constructor(opts) {
								this.opts = opts;
								this.sessionId = opts.sessionId;
								this.state = { ...opts.initialState, isStreaming: false, messages: [...(opts.initialState.messages ?? [])], errorMessage: undefined };
								this.runs = 0;
								this.toolToRun = undefined; // test sets a tool name to execute before replying
								this.toolArgs = {};
								this.#handlers = new Set();
							}
							#handlers;
							subscribe(h) { this.#handlers.add(h); return () => this.#handlers.delete(h); }
							#emit(event) { for (const h of this.#handlers) h(event); }
							abort() {}
							steer() {}
							hasQueuedMessages() { return false; }
							clearSteeringQueue() {}
							async prompt(input) {
								this.runs += 1;
								this.state.isStreaming = true;
								this.state.errorMessage = undefined;
								if (this.toolToRun) {
									const tool = (this.state.tools ?? []).find((t) => t.name === this.toolToRun);
									if (tool) { try { await tool.execute("tc-" + this.runs, this.toolArgs, undefined, undefined); } catch { /* refusal/throw path is the event's business */ } }
								}
								// APPEND (the retry suite replaces; the reseed contract under
								// test needs the bundle rows to survive into the request).
								this.state.messages.push({ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() });
								const response = await this.opts.streamFn(this.state.model, this.state.messages, {});
								for await (const event of response ?? []) {
									if (event?.type === "error" && event.error?.errorMessage) this.state.errorMessage = event.error.errorMessage;
								}
								if (typeof response?.result === "function") {
									const final = await response.result();
									if (final?.role === "assistant" && !this.state.errorMessage) {
										this.state.messages.push(final);
										this.#emit({ type: "message_end", message: final });
										await this.createLoopConfig().finishTurn?.({ toolResults: [], context: { messages: this.state.messages } });
									}
								}
								this.state.isStreaming = false;
							}
							async continue() { throw new Error("No messages to continue from"); }
							createLoopConfig() { return {}; }
						}
						export const DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
						export const shouldCompact = (contextTokens, contextWindow, settings) => settings.enabled && contextTokens > contextWindow - settings.reserveTokens;
						export const convertToLlm = (x) => x;
						export const estimateContextTokens = () => ({ tokens: 0 });
						export const estimateTokens = () => 0;
						export const estimateTokensSafe = () => 0;
						export const createCompactionSummaryMessage = (x) => x;
						export const generateSummary = (...args) => {
							if (!globalThis.__generateSummaryHook) return Promise.reject(new Error("stubbed generateSummary: no hook"));
							return Promise.resolve(globalThis.__generateSummaryHook(...args));
						};
					`,
				}));
			},
		},
	],
});
const { EmployeeEngine, withTelemetry, toolDigestDraft, workRequestText, replaceHeadDiff, workLedgerBudgetTokens, isWorkConversation, ConfigStore, HistoryStore, FileCredentialStore, ContextStore, COMPACTION_SUMMARY_MARK, isSummaryRecord } = await import(pathToFileURL(bundle).href);

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** streamFn stub: a settled response whose result() is the scripted reply. */
const scriptedReply = (text) => async () => ({
	result: async () => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", api: "openai-completions", provider: "s", model: "m", usage: ZERO_USAGE, timestamp: Date.now() }),
	[Symbol.asyncIterator]: async function* () {},
});

function makeEngine(t, { streamFn = scriptedReply("对账完成：今日 37 笔已全部核对无误。"), kernel } = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_supplier_id TEXT, model_model_id TEXT, origin TEXT NOT NULL DEFAULT 'console');");
	db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL);");
	t.after(() => db.close());
	const config = new ConfigStore(db);
	config.update({
		model: {
			suppliers: [{ id: "s", name: "S", enabled: true, apiType: "openai-completions", baseUrl: "https://x.invalid", apiKey: "k", models: ["m"] }],
			defaultSupplierId: "s",
			defaultModelId: "m",
		},
	});
	const history = new HistoryStore(db);
	const context = new ContextStore(db);
	const authPath = join(dir, `auth-${Math.random().toString(36).slice(2, 8)}.json`);
	const credentials = new FileCredentialStore({ authPath });
	const knowledgeStub = { listMemoryIndex: () => [], listScopedMemoryIndex: () => [] };
	const stub = {};
	const engine = new EmployeeEngine(config, history, knowledgeStub, stub, stub, stub, stub, stub, stub, {
		builtinSkillsDir: dir,
		userSkillsDir: dir,
	}, {
		credentialStore: credentials,
		streamFn,
		retrySleepFn: async () => {},
		...(kernel ? { kernel } : {}),
		contextStore: context,
	});
	const mkSibling = () => new EmployeeEngine(config, history, knowledgeStub, stub, stub, stub, stub, stub, stub, {
		builtinSkillsDir: dir,
		userSkillsDir: dir,
	}, { credentialStore: credentials, streamFn, retrySleepFn: async () => {}, contextStore: context });
	t.after(() => { try { rmSync(`${authPath}.lock`, { force: true }); } catch { /* best effort */ } });
	const transcriptText = (agent) => agent.state.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""))).join("\n");
	return { engine, mkSibling, config, history, context, transcriptText };
}

// ── pure glue (work-ledger.ts) ───────────────────────────────────────────────

test("isWorkConversation: work:<id> partitions match; worker:<id>/IM never (the colon delimits)", () => {
	assert.equal(isWorkConversation("work:abc"), true);
	assert.equal(isWorkConversation("worker:abc"), false, "the durable WorkerService's worker:<id> must not match");
	assert.equal(isWorkConversation("dt:group:g1"), false);
	assert.equal(isWorkConversation("sched:t1"), false);
});

test("toolDigestDraft: degraded digest keeps name+cost+outcome even without briefs", () => {
	const ok = toolDigestDraft("work:1", 1234, { name: "web.search", durationMs: 42, ok: true });
	assert.equal(ok.kind, "tool-digest");
	assert.deepEqual(ok.toolDigest, { name: "web.search", argsBrief: "", resultBrief: "成功", durationMs: 42 });
	const refused = toolDigestDraft("work:1", 1234, { name: "manage_settings", durationMs: 3, ok: false, refused: true, refusedCapability: "settings" });
	assert.match(refused.toolDigest.resultBrief, /权限拒绝（settings）/);
	const failed = toolDigestDraft("work:1", 1234, { name: "browser.open", durationMs: 4000, ok: false, error: "net::ERR_TIMED_OUT" });
	assert.equal(failed.toolDigest.durationMs, 4000);
	assert.match(failed.toolDigest.resultBrief, /失败：net::ERR_TIMED_OUT/);
});

test("workRequestText: keeps the task identity, drops the runner scaffold; never blank", () => {
	const message = "【工作窗口开始】\n【当前时间】…\n【自主任务】月末对账\n【目标】完成月末核对\n\n窗口规则：…\n\n请按目标与执行条件推进工作。";
	assert.equal(workRequestText(message), "完成月末核对");
	assert.equal(workRequestText("继续。"), "继续。");
});

test("replaceHeadDiff: identity diff — kept rows re-append verbatim, new rows land as inserts", () => {
	const kept = [{ conversationId: "c", seq: 5, kind: "request", text: "a", ts: 1 }];
	const rebuilt = [{ conversationId: "c", seq: 4, kind: "system", text: "摘要", ts: 2 }, kept[0]];
	const diff = replaceHeadDiff([kept[0], { conversationId: "c", seq: 1, kind: "request", text: "旧", ts: 0 }], rebuilt);
	assert.deepEqual(diff.removeSeqs, [1]);
	assert.deepEqual(diff.insertRecords, [rebuilt[0]]);
});

test("workLedgerBudgetTokens: usable window minus prompt minus reserves, floored", () => {
	// 200k window, 32k output → 168k usable; − prompt(≈1000 CJK tokens) − 24k reserve.
	const budget = workLedgerBudgetTokens("你".repeat(1000), 200_000, 32_768);
	assert.ok(budget > 140_000 && budget < 145_000, `got ${budget}`);
	assert.equal(workLedgerBudgetTokens("", 8_000, 4_000), 8_000, "tiny windows still assemble something");
});

// ── withTelemetry brief collection (bounded + masked) ────────────────────────

test("withTelemetry: briefs are bounded, secrets masked, errors carried on the failure event", async () => {
	const events = [];
	const tool = {
		name: "login_probe",
		async execute(_id, params) {
			// The TOOL still receives the RAW params — masking is digest-only.
			assert.ok(JSON.stringify(params).includes("hunter2"), "the tool receives raw params; masking is digest-only");
			return { content: [{ type: "text", text: "长".repeat(600) }, { type: "image", url: "x" }] };
		},
	};
	const wrapped = withTelemetry(tool, (e) => events.push(e));
	await wrapped.execute("t1", { url: "https://x.invalid", password: "hunter2", apiKey: "sk-secret", nested: { otp: "123456", plain: "abc" } }, undefined, undefined);
	assert.equal(events.length, 1);
	const e = events[0];
	assert.equal(e.ok, true);
	assert.ok(e.argsBrief.includes("***"), "sensitive leaf values are masked");
	assert.ok(!e.argsBrief.includes("hunter2") && !e.argsBrief.includes("sk-secret") && !e.argsBrief.includes("123456"));
	assert.ok(e.argsBrief.includes("abc"), "non-sensitive values survive");
	assert.ok(e.argsBrief.length <= 240 + 6, `argsBrief bounded (got ${e.argsBrief.length})`);
	assert.ok(e.resultBrief.length <= 240 + 6, "resultBrief bounded");
	assert.ok(e.resultBrief.includes("（截断）"), "truncation is explicit");
	assert.equal(typeof e.durationMs, "number");

	// A result with ONLY non-text blocks degrades to an honest marker, not silence.
	const onlyImage = withTelemetry({ name: "view_shot", async execute() { return { content: [{ type: "image", url: "x" }] }; } }, (ev) => events.push(ev));
	await onlyImage.execute("t3", {}, undefined, undefined);
	assert.match(events[1].resultBrief, /含 1 个非文本块/);

	const boom = withTelemetry({ name: "browser.open", async execute() { throw new Error("net::ERR_TIMED_OUT after 4000ms"); } }, (ev) => events.push(ev));
	await assert.rejects(() => boom.execute("t2", { q: "x" }, undefined, undefined));
	const fail = events[2];
	assert.equal(fail.ok, false);
	assert.equal(fail.resultBrief, "net::ERR_TIMED_OUT after 4000ms");
	assert.ok(fail.argsBrief.includes("q"));
});

// ── the full turn path through the real engine ───────────────────────────────

const WORK_PREFIX = "【工作窗口开始】\n【自主任务】月末对账\n【目标】完成月末核对\n\n窗口规则：略。\n\n请按目标与执行条件推进工作。";

test("a work turn commits request → tool-digest → reply to the ledger; the UI copy still lands in history", async (t) => {
	const { engine, context, history } = makeEngine(t);
	const agent = engine.getOrCreateSession("work:wt1");
	agent.toolToRun = "get_current_time";
	await engine.send(agent, WORK_PREFIX);
	const rows = context.listTurns("work:wt1");
	assert.deepEqual(rows.map((r) => r.kind), ["request", "tool-digest", "reply"], "call order is ledger order");
	assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3], "appendNext allocates consecutively");
	assert.equal(rows[0].text, "完成月末核对", "the request row keeps the task identity, not the scaffold");
	assert.ok(!rows[0].text.includes("【工作窗口开始】"));
	const digest = rows[1].toolDigest;
	assert.equal(digest.name, "get_current_time");
	assert.equal(typeof digest.durationMs, "number", "cost is mandatory");
	assert.ok(digest.resultBrief.includes("当前北京时间"), "the result brief carries the tool's real output (bounded)");
	assert.match(rows[2].text, /37 笔已全部核对/);
	// The UI-facing history copy is unchanged (user + assistant rows).
	assert.deepEqual(history.listMessages("work:wt1").map((m) => m.role), ["user", "assistant"]);
	// A second turn on the SAME agent: the ledger keeps growing, no dup buffering.
	agent.toolToRun = undefined;
	await engine.send(agent, "继续。");
	const again = context.listTurns("work:wt1");
	assert.deepEqual(again.map((r) => r.kind), ["request", "tool-digest", "reply", "request", "reply"]);
	assert.deepEqual(again.map((r) => r.seq), [1, 2, 3, 4, 5]);
});

test("work sessions assemble context from the LEDGER — the 40-line rehydrate cap no longer applies; IM keeps it (PR-4 untouched)", async (t) => {
	const { context, history, mkSibling, transcriptText } = makeEngine(t);
	const now = Date.now();
	// 60 history rows — the rehydrate cap would keep only the last 40.
	for (let i = 0; i < 60; i++) history.appendMessage("work:y", "user", `仅存在于 UI 账本的历史消息第${i}行`);
	// The LEDGER carries the marks (a request, a tool digest, a reply).
	context.appendNext("work:y", { conversationId: "work:y", kind: "request", text: "LEDGER-REQUEST-MARK 查询平台流水", ts: now });
	context.appendNext("work:y", { conversationId: "work:y", kind: "tool-digest", text: "", ts: now, toolDigest: { name: "get_current_time", argsBrief: "", resultBrief: "成功", durationMs: 3 } });
	context.appendNext("work:y", { conversationId: "work:y", kind: "reply", text: "LEDGER-REPLY-MARK 已核对 37 笔流水", ts: now });
	// A "restart": a fresh engine over the same stores.
	const fresh = mkSibling();
	const workAgent = fresh.getOrCreateSession("work:y");
	const flat = transcriptText(workAgent);
	assert.ok(flat.includes("LEDGER-REQUEST-MARK"), "the ledger request is the transcript's opening turn");
	assert.ok(flat.includes("[工具] get_current_time"), "the digest rides the bundle inline");
	assert.ok(flat.includes("LEDGER-REPLY-MARK"), "the ledger reply is in the window");
	assert.ok(!flat.includes("仅存在于 UI 账本的历史消息第59行"), "history does NOT feed a work transcript any more");
	assert.ok(!flat.includes("历史消息第0行"), "…and never did in this session");
	assert.equal(workAgent.state.messages[0].role, "user", "the window opens on a user turn");

	// IM conversation: the 40-line rehydrate cap is UNCHANGED.
	for (let i = 0; i < 60; i++) history.appendMessage("dt:c", "user", `IM聊天历史第${i}行`);
	const imAgent = fresh.getOrCreateSession("dt:c");
	assert.ok(imAgent.state.messages.length <= 40, `IM keeps the rehydrate cap (got ${imAgent.state.messages.length})`);
	assert.ok(transcriptText(imAgent).includes("IM聊天历史第59行"));
	// And an IM turn writes NO ledger rows (partition untouched by the wiring).
	await fresh.send(imAgent, "你好");
	assert.deepEqual(context.listTurns("dt:c"), []);
});

test("kernel=durable: work sessions drive DIRECTLY (ledger path) while other conversations still demand the durable runtime", async (t) => {
	const { engine, context } = makeEngine(t, { kernel: "durable" });
	const agent = engine.getOrCreateSession("work:wd");
	await engine.send(agent, "【工作窗口开始】【自主任务】巡检\n【目标】巡检完成\n开始。");
	const rows = context.listTurns("work:wd");
	assert.deepEqual(rows.map((r) => r.kind), ["request", "reply"], "no durable runtime, yet the work turn ran and committed");
	// The durable kernel still owns every other conversation — it refuses
	// without an opened runtime rather than silently degrading.
	const imAgent = engine.getOrCreateSession("dt:im1");
	await assert.rejects(() => engine.send(imAgent, "你好"), /Durable runtime is unavailable/);
});

test("an over-budget work ledger is summarized head+verbatim-tail and PERSISTED via replaceHead", async (t) => {
	let summaryCalls = 0;
	globalThis.__generateSummaryHook = (_messages, _model, _reserve, _apiKey, _signal, _custom, previousSummary) => {
		summaryCalls += 1;
		return previousSummary ? `${previousSummary}；已并入后续扫描` : "第一轮摘要：此前完成了 100 余轮流水扫描，未发现异常";
	};
	const { engine, context, transcriptText } = makeEngine(t);
	// The relay clone model reports a 1M window (usable ≈ 967k, ledger budget
	// ≈ 938k, compaction threshold ≈ 922k tokens) — the ledger must genuinely
	// cross it, so ~1.1M estimated tokens of CJK rows.
	const cn1000 = "一二三四五六七八九十".repeat(100);
	for (let i = 1; i <= 1100; i++) context.appendNext("work:big", { conversationId: "work:big", kind: "request", text: cn1000 + `第${i}轮扫描完成`, ts: Date.now() });
	const agent = engine.getOrCreateSession("work:big");
	await engine.send(agent, "【工作窗口开始】【自主任务】大任务巡检\n【目标】继续巡检\n请按目标推进。");
	assert.ok(summaryCalls >= 1, "the ledger summarizer ran");
	const rows = context.listTurns("work:big");
	assert.equal(rows[0].kind, "system", "the head is now the summary row");
	assert.ok(rows[0].text.startsWith(COMPACTION_SUMMARY_MARK));
	assert.ok(isSummaryRecord(rows[0]));
	assert.ok(rows.length < 1100, "the summarized head rows were deleted");
	assert.match(rows.at(-1).kind, /^reply$/, "the newest turn's reply survived verbatim");
	assert.equal(rows[1].kind, "request", "a verbatim recent tail follows the summary");
	// And the NEXT session assembles from the compacted ledger: summary inline first.
	globalThis.__generateSummaryHook = undefined;
	engine.dropSession("work:big");
	const flat = transcriptText(engine.getOrCreateSession("work:big"));
	assert.ok(flat.includes("第一轮摘要"), "the compacted chain head is inline in the rebuilt transcript");
	assert.ok(flat.includes("继续巡检"), "the newest request survives in the window");
});

test("ledger write failures never break delivery (best-effort commit)", async (t) => {
	const { engine, context, history } = makeEngine(t);
	const agent = engine.getOrCreateSession("work:bf");
	// Sabotage the store so appendNext throws at commit time (drop the digest
	// column); the reply must still be delivered and recorded in history.
	context.db.exec("DROP TABLE context_entries");
	context.db.exec("CREATE TABLE context_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, refs_json TEXT, created_at INTEGER NOT NULL)");
	const result = await engine.send(agent, WORK_PREFIX);
	assert.match(result.reply ?? "", /37 笔已全部核对/, "delivery is untouched by the ledger failure");
	assert.deepEqual(history.listMessages("work:bf").map((m) => m.role), ["user", "assistant"]);
});
