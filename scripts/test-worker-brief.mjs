import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

// Runtime coverage for withWorkerTaskBrief (review 1796f433 #2: the original fix
// shipped with only a source grep — a filtering/ordering regression would have
// stayed green). Scenarios ported from the reviewer's executed probe, updated to
// the post-review behavior: `error` status renders 失败, no-others boundary
// wording, limit+1 slot fetch, budget spill keeps the boundary rule.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.worker-brief-"));
const bundle = join(dir, "brief.mjs");
await build({
	stdin: {
		contents: `
			export { EmployeeEngine } from "./src/engine/engine.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
	outfile: bundle,
});
const { EmployeeEngine, ConfigStore, HistoryStore } = await import(pathToFileURL(bundle).href);

after(() => {
	rm(dir, { recursive: true, force: true }).catch(() => {});
});

// Statuses as the REAL store writes them: queued/running/done/cancelled/error.
// worker-tasks.ts has NO 'failed' status (interrupts write 'error').
const NOW = Date.now();
const TASKS = [
	{ id: "taskC", instruction: "统计最近7天对账结果", status: "running", result: null, error: null, created_at: NOW - 60_000 },
	{ id: "taskB", instruction: "查询支付渠道下单日志", status: "error", result: null, error: "spay 登录态失效", created_at: NOW - 3600_000 },
	{ id: "taskA", instruction: "平阳数币今日交易金额监控", status: "done", result: "今日 823 元", error: null, created_at: NOW - 86_400_000 },
];
const DETAIL = {
	taskC: { id: "taskC", instruction: "统计最近7天对账结果", source_conversation: "dt:group:g1", created_by: "u1", status: "running", result: null, error: null, max_minutes: 30, created_at: NOW - 60_000, started_at: NOW, finished_at: null },
};

function mkEngine({ source, detail } = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER, origin TEXT, model_supplier_id TEXT, model_model_id TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER); CREATE TABLE conversation_members (conversation_id TEXT NOT NULL, staff_id TEXT NOT NULL, name TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, message_count INTEGER NOT NULL, PRIMARY KEY (conversation_id, staff_id));");
	const config = new ConfigStore(db);
	const history = new HistoryStore(db);
	history.recordMember("dt:group:g1", "u1", "张三");
	const knowledgeStub = { listMemoryIndex: () => [], listScopedMemoryIndex: () => [] };
	const stub = {};
	return new EmployeeEngine(config, history, knowledgeStub, stub, stub, stub, stub, stub, stub, {
		builtinSkillsDir: dir, userSkillsDir: dir,
	}, {
		workerTaskSource: { listRecentForConversation: (cid, limit) => (source ? source(cid) : TASKS).slice(0, limit) },
		workerTaskDetail: (id) => (detail ? detail(id) : DETAIL[id]),
	});
}

const MSG = "那日志到底查到没有";

test("happy path: own task + other tasks + boundary, own id excluded, message rides last", () => {
	const engine = mkEngine();
	const out = engine.withWorkerTaskBrief("worker:taskC", MSG);
	assert.match(out, /上下文速览/, "header present");
	assert.match(out, /【你手上的任务】worker:taskC「统计最近7天对账结果」.*（执行中）/, "own task named + status");
	assert.match(out, /【同一来源会话的其他任务（不是你负责的）】/, "others header");
	assert.match(out, /worker:taskB「查询支付渠道下单日志」→ spay 登录态失效/, "other task + outcome, newline collapsed");
	assert.match(out, /【边界】/, "boundary rule present");
	const othersSection = out.slice(out.indexOf("【同一来源会话的其他任务"), out.indexOf("【边界】"));
	assert.ok(!othersSection.includes("worker:taskC"), "own id excluded from others list");
	assert.ok(out.trimEnd().endsWith(MSG), "user message rides last");
	// Review #2: the store writes 'error' — the label map must translate it.
	assert.match(out, /（失败）/, "real 'error' status renders as 失败, not raw English");
	assert.doesNotMatch(out, /（error）/, "no raw English status leaks");
});

test("routing: worker: ids get the brief, never the IM roster", () => {
	const engine = mkEngine();
	const out = engine.withConversationContext("worker:taskC", MSG);
	assert.doesNotMatch(out, /本会话成员/, "worker id must not get the IM roster");
	assert.match(out, /【你手上的任务】/, "worker id gets the brief instead");
});

test("degrade-on-throw returns the message byte-identical", () => {
	const engine = mkEngine({ detail: () => { throw new Error("db gone"); } });
	const out = engine.withWorkerTaskBrief("worker:taskC", MSG);
	assert.equal(out, MSG, "a throwing source must not poison the turn");
});

test("unknown own id (row gone) → no brief at all", () => {
	const engine = mkEngine({ detail: () => undefined });
	const out = engine.withWorkerTaskBrief("worker:ghost", MSG);
	assert.equal(out, MSG);
});

test("no other tasks → boundary says so instead of pointing at an empty section (review #5)", () => {
	const engine = mkEngine({ source: () => [{ id: "taskC", instruction: "唯一任务", status: "running", result: null, error: null, created_at: NOW }] });
	const out = engine.withWorkerTaskBrief("worker:taskC", MSG);
	assert.match(out, /【你手上的任务】/);
	assert.doesNotMatch(out, /把上面其他任务的状态转述/, "no dangling reference to an absent section");
	assert.match(out, /本会话没有查到其他任务/, "the no-others wording is used instead");
});

test("limit+1 fetch: the own task (usually newest) must not eat an others slot (review #6)", () => {
	const many = [
		{ id: "taskC", instruction: "own — newest", status: "running", result: null, error: null, created_at: NOW },
		...Array.from({ length: 5 }, (_, i) => ({ id: `other${i}`, instruction: `任务${i}`, status: "done", result: null, error: null, created_at: NOW - i - 1 })),
	];
	const engine = mkEngine({ source: () => many });
	const out = engine.withWorkerTaskBrief("worker:taskC", MSG);
	for (let i = 0; i < 5; i++) assert.match(out, new RegExp(`worker:other${i}`), `other${i} must be listed`);
});

test("budget spill keeps the OWN-TASK line AND the boundary rule (review #4)", () => {
	const bigOthers = Array.from({ length: 6 }, (_, i) => ({
		id: `w${i}abcdefabcdefabcdefabcdef`,
		instruction: "长".repeat(40),
		status: "cancelled",
		result: "果".repeat(60),
		error: null,
		created_at: NOW - i,
	}));
	const engine = mkEngine({
		source: () => [{ id: "taskC", instruction: "长".repeat(50), status: "running", result: null, error: null, created_at: NOW }, ...bigOthers],
	});
	// The spill is unreachable at the shipped budget (probe: ~764 < 1200) — shrink
	// the budget to force the path and pin its semantics: the boundary rule is the
	// payload of this fix, so the spill must drop the OTHERS block, never it.
	const origBudget = EmployeeEngine.CONTEXT_PREFIX_BUDGET;
	EmployeeEngine.CONTEXT_PREFIX_BUDGET = 200;
	try {
		const out = engine.withWorkerTaskBrief("worker:taskC", MSG);
		const prefix = out.slice(0, out.length - MSG.length);
		assert.match(prefix, /【你手上的任务】/, "own task survives the spill");
		assert.match(prefix, /【边界】/, "the boundary rule MUST survive the spill");
		assert.doesNotMatch(prefix, /【同一来源会话的其他任务/, "others block is the spill victim");
		assert.ok(prefix.length <= 220, `the truncated prefix respects the budget (got ${prefix.length})`);
	} finally {
		EmployeeEngine.CONTEXT_PREFIX_BUDGET = origBudget;
	}
});

test("buildTurnInputFor composes brief + memory prefix; the durable path wires it (review #1)", async () => {
	const engine = mkEngine();
	const out = engine.buildTurnInputFor("worker:taskC", MSG, { actor: { senderId: "u1", channel: "dingtalk", chatType: "group" } });
	assert.match(out, /【你手上的任务】/, "the brief rides the composed input");
	assert.ok(out.trimEnd().endsWith(MSG), "message rides last");
	// The durable wiring: openDurableRuntime must pass the composer into the runtime.
	const src = readFileSync(join(root, "src/engine/engine.ts"), "utf8");
	assert.match(src, /turnInput: \(id, text, ctx\) => this\.buildTurnInputFor/, "openDurableRuntime wires the composer");
	const runtime = readFileSync(join(root, "src/engine/durable/runtime.ts"), "utf8");
	assert.match(runtime, /const effectiveText = this\.opts\.turnInput \? this\.opts\.turnInput\(id, text/, "durable submit composes the effective text");
	// Never-persisted invariant: the history append stays on the RAW text.
	const appendIdx = runtime.indexOf("this.opts.history.appendMessage(id, \"user\", text)");
	const effectiveIdx = runtime.indexOf("const effectiveText =");
	assert.ok(appendIdx >= 0 && effectiveIdx > appendIdx, "appendMessage(raw) precedes the composed text — prefixes never persist");
});

console.log("worker-brief runtime coverage: 8 tests");
