/**
 * Memory recall overhaul (2026-10-27): relevance-ranked recall replaces the
 * flat "newest 30 rows" index; plus write-time advisories and retrieval tiers.
 *
 * Runs the REAL store against an in-memory SQLite schema built by sqlite.ts, so
 * the assertions cover the actual SQL (scope filtering, ordering, telemetry
 * writes) rather than a mock.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.memory-recall-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "memory.mjs");
await build({
	stdin: {
		contents: `
			export { KnowledgeContentStore } from "./src/knowledge/store.ts";
			
			export { recallTokens } from "./src/knowledge/store.ts";
			export { titleSimilarity, findTitleConflict, looksShortLived, memoryPhrasingHint, CONFLICT_THRESHOLD } from "./src/knowledge/memory-write.ts";
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
const { KnowledgeContentStore, recallTokens, titleSimilarity, findTitleConflict, looksShortLived, memoryPhrasingHint, CONFLICT_THRESHOLD } =
	await import(pathToFileURL(bundle).href);

const PERSON = "person:dingtalk:staff-1";
const DAY = 24 * 60 * 60 * 1000;

/**
 * node:sqlite with the minimal schema the store touches — the same convention
 * as test-knowledge-store.mjs. (Never better-sqlite3: that build is compiled
 * for Electron's ABI and cannot load in the Node test runner.)
 */
function freshStore(t) {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE kb_entries (
			id TEXT PRIMARY KEY, title TEXT, tags TEXT, content TEXT,
			origin TEXT, confidence REAL, version INTEGER DEFAULT 1, lineage TEXT,
			archived INTEGER DEFAULT 0, review_status TEXT DEFAULT 'approved',
			memory_scope TEXT, memory_owner TEXT, memory_summary TEXT,
			hit_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE TABLE kb_chunks (
			id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT,
			title TEXT, tags TEXT, content TEXT NOT NULL,
			chunk_index INTEGER, embed_status TEXT DEFAULT 'pending',
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE INDEX idx_kb_chunks_source ON kb_chunks(source, source_id);
	`);
	// node:sqlite has no better-sqlite3-style .transaction(); the store calls it
	// for atomic writes. A pass-through shim is enough here — these tests assert
	// recall/ranking behavior, not transaction semantics.
	db.transaction = (fn) => (...args) => fn(...args);
	const store = new KnowledgeContentStore(db);
	t.after(() => db.close());
	return store;
}

const write = (store, title, content, { scope = "person", owner = PERSON, summary, ageDays = 0 } = {}) => {
	const r = store.saveMemoryFact({ title, content, scope, owner, summary });
	if (ageDays > 0) {
		// Backdate so decay is observable without waiting.
		db_backdate(store, r.id, Date.now() - ageDays * DAY);
	}
	return r;
};

/** Test-only backdate: touch updated_at directly (no production API for this). */
function db_backdate(store, id, ts) {
	const raw = store.db ?? store._db;
	if (!raw) throw new Error("test harness lost the db handle");
	raw.prepare("UPDATE kb_entries SET updated_at = ? WHERE id = ?").run(ts, id);
}

test("recall ranks by relevance to the current message, not by recency", (t) => {
	const store = freshStore(t);
	// Distinct ages so the recency fallback is deterministic.
	write(store, "报告交付方式", "对方偏好把正式报告用可复制文本框交付，不要只贴链接", { summary: "报告用可复制文本框", ageDays: 3 });
	write(store, "午饭口味", "对方不吃香菜", { summary: "不吃香菜", ageDays: 2 });
	write(store, "打印机位置", "三楼东侧打印室", { summary: "三楼东侧", ageDays: 1 });

	const ctx = { personOwner: PERSON };
	const withQuery = store.recallMemory({ ctx, query: "帮我把这次的分析整理成报告发我", limit: 2 });
	// Admission, not just ordering: only the report-related row is relevant here.
	assert.equal(withQuery.length, 1, `off-topic rows are not admitted, got ${withQuery.map((r) => r.title).join(" / ")}`);
	assert.equal(withQuery[0].title, "报告交付方式", `relevance must win, got ${withQuery.map((r) => r.title).join(" / ")}`);

	// No query → backwards compatible: most recent first.
	const noQuery = store.recallMemory({ ctx, query: "", limit: 3 });
	assert.equal(noQuery.length, 3);
	assert.equal(noQuery[0].title, "打印机位置", "without a query the index is recency-ordered");
});

test("a long-lived durable fact is not crowded out by newer trivia", (t) => {
	const store = freshStore(t);
	write(store, "报告交付规范", "正式报告一律用可复制文本框交付，并附一句结论", { summary: "报告用文本框交付", ageDays: 40 });
	for (let i = 0; i < 25; i += 1) write(store, `杂事${i}`, `琐碎事实 ${i}`, { summary: `杂事 ${i}` });

	const ctx = { personOwner: PERSON };
	// A message that actually overlaps the durable fact's vocabulary.
	const hits = store.recallMemory({ ctx, query: "这份报告交付的时候用文本框吗", limit: 5 });
	assert.ok(
		hits.some((h) => h.title === "报告交付规范"),
		`the 40-day-old durable fact must still surface by relevance, got ${hits.map((h) => h.title).join(" / ")}`,
	);
});

test("recall records hit_count/last_used_at only for injected rows (decay feed)", (t) => {
	const store = freshStore(t);
	const a = write(store, "甲", "关于报表的偏好", { summary: "报表" });
	const b = write(store, "乙", "关于排班的偏好", { summary: "排班" });

	store.recallMemory({ ctx: { personOwner: PERSON }, query: "这个报表的偏好是怎么样的", limit: 1 });
	const rows = store.db.prepare("SELECT id, hit_count, last_used_at FROM kb_entries WHERE id IN (?, ?)").all(a.id, b.id);
	const byId = new Map(rows.map((r) => [r.id, r]));
	assert.equal(byId.get(a.id).hit_count, 1, "the injected row is counted");
	assert.ok(byId.get(a.id).last_used_at > 0, "last_used_at moves");
	assert.equal(byId.get(b.id).hit_count, 0, "a row that was not injected is never counted as recalled");
});

test("stale rows lose their priors (decay) but are never deleted", (t) => {
	const store = freshStore(t);
	const stale = write(store, "很久以前", "一条 200 天前的旧事实", { summary: "旧", ageDays: 200 });
	const fresh = write(store, "刚刚", "一条刚写的事实", { summary: "新" });

	const ranked = store.recallMemory({ ctx: { personOwner: PERSON }, query: "", limit: 5, staleDays: 90 });
	assert.equal(ranked[0].title, "刚刚", "a decayed row must not outrank a fresh one on the default order");
	const staleRow = ranked.find((r) => r.id === stale.id);
	assert.ok(staleRow, "the stale row is still returned — decay only removes its prior, nothing is deleted");
	assert.ok(ranked.find((r) => r.id === fresh.id).recallScore > staleRow.recallScore, "fresh keeps a recency prior");
});

test("scope filtering still fails closed: another person's memory is never recalled", (t) => {
	const store = freshStore(t);
	write(store, "别人的私人事实", "staff-2 的私人事实记录", { owner: "person:dingtalk:staff-2", ageDays: 1 });
	write(store, "共享私人事实规则", "全配置共享的私人事实处理规则", { scope: null, owner: null, ageDays: 1 });

	const mine = store.recallMemory({ ctx: { personOwner: PERSON }, query: "私人事实怎么处理", limit: 10 });
	assert.ok(!mine.some((r) => r.title === "别人的私人事实"), "cross-owner memory must never be recalled");
	assert.ok(mine.some((r) => r.title === "共享私人事实规则"), "profile memory stays visible");
	// And with no verified actor at all:
	const anon = store.recallMemory({ ctx: {}, query: "私人事实怎么处理", limit: 10 });
	assert.deepEqual(anon.map((r) => r.title), ["共享私人事实规则"], "anonymous turns see profile memory only");
});

test("recallTokens: CJK bigrams + latin words, bounded", () => {
	const tokens = recallTokens("帮我出个 LiteLLM 日报 report-2026");
	assert.ok(tokens.includes("报告".slice(0, 2)) || tokens.some((x) => x.length === 2), "CJK bigrams present");
	assert.ok(tokens.includes("litellm"), "latin word lowercased");
	assert.ok(tokens.length <= 40, "token list is bounded");
});

test("write-time: near-duplicate title is flagged, exact title is the correction path", () => {
	const existing = [
		{ id: "1", title: "报告交付方式", summary: "用可复制文本框" },
		{ id: "2", title: "打印机位置", summary: "三楼东侧" },
	];
	const dup = findTitleConflict("报告交付的方式", existing);
	assert.equal(dup?.title, "报告交付方式", "a near-duplicate title is surfaced as a conflict");
	assert.equal(findTitleConflict("报告交付方式", existing), null, "the exact same title is the sanctioned overwrite, not a conflict");
	assert.equal(findTitleConflict("完全无关的新主题", existing), null, "unrelated titles do not collide");
	assert.ok(titleSimilarity("报告交付方式", "报告交付的方式") >= CONFLICT_THRESHOLD);
});

test("write-time: imperative phrasing is flagged, declarative facts are not", () => {
	assert.ok(memoryPhrasingHint("始终用可复制文本框交付报告"), "imperative opener is flagged");
	assert.ok(memoryPhrasingHint("你必须先查知识库"), "second-person directive is flagged");
	assert.ok(memoryPhrasingHint("Always reply in Chinese"), "english imperative is flagged");
	assert.equal(memoryPhrasingHint("对方偏好把报告用可复制文本框交付"), null, "a declarative fact passes");
	assert.equal(memoryPhrasingHint("这套环境的做法是先读 runlogs 再判断"), null, "a declarative convention passes");
});

test("write-time: short-lived facts are flagged, and ambiguity stays durable", () => {
	const now = Date.parse("2026-10-27T10:00:00");
	assert.ok(looksShortLived("明天早上九点下单", now), "「明天」is short-lived");
	assert.ok(looksShortLived("本周内要把对账跑完", now), "「本周内」is short-lived");
	const soon = new Date(now + 3 * DAY).toISOString().slice(0, 10);
	assert.ok(looksShortLived(`计划 ${soon} 上线`, now), "a date within 7 days is short-lived");
	assert.equal(looksShortLived("对方偏好周报在周一发", now), null, "a standing preference stays durable");
	assert.equal(looksShortLived("系统地址是 https://example.com", now), null, "a stable environment fact stays durable");
});

// ── Review fixes (2026-10-27 second pass) ─────────────────────────────

test("P1: an off-topic turn carries NO memory instead of filling the budget", (t) => {
	const store = freshStore(t);
	for (let i = 0; i < 15; i += 1) write(store, `午饭偏好${i}`, `午饭喜欢吃第 ${i} 家`, { summary: `午饭 ${i}` });

	const hits = store.recallMemory({ ctx: { personOwner: PERSON }, query: "Kubernetes deployment rollout", limit: 12 });
	assert.equal(hits.length, 0, `off-topic turns must admit nothing, got ${hits.length} rows`);
});

test("P1: relevance admits, priors only order — a fresh unrelated fact cannot outrank a relevant old one", (t) => {
	const store = freshStore(t);
	write(store, "部署流程", "上线前先跑 runlogs 检查，再执行部署脚本", { summary: "部署前查 runlogs", ageDays: 120 });
	write(store, "无关新事", "今天换了新的办公椅", { summary: "办公椅", ageDays: 0 });

	const hits = store.recallMemory({ ctx: { personOwner: PERSON }, query: "部署上线流程是什么", limit: 5 });
	assert.equal(hits.length, 1, `only the relevant row is admitted, got ${hits.map((h) => h.title).join(" / ")}`);
	assert.equal(hits[0].title, "部署流程");
});

test("P1b: profile memory cannot consume the per-turn scoped budget", (t) => {
	const store = freshStore(t);
	for (let i = 0; i < 12; i += 1) {
		write(store, `共享规范${i}`, `全公司规范条目 ${i} 关于部署`, { scope: null, owner: null, summary: `规范 ${i}` });
	}
	write(store, "个人部署偏好", "部署时我习惯先看 runlogs", { summary: "部署先看 runlogs" });

	const scoped = store.recallMemory({
		ctx: { personOwner: PERSON },
		query: "部署怎么做",
		limit: 12,
		scopeFilter: ["person", "conversation"],
	});
	assert.ok(
		scoped.some((r) => r.title === "个人部署偏好"),
		`scoped recall must surface person memory despite 12 matching profile rows, got ${scoped.map((r) => r.title).join(" / ")}`,
	);
	assert.ok(scoped.every((r) => r.memory_scope !== null && r.memory_scope !== "profile"), "profile rows never enter the scoped budget");
});

test("P2: a failing feedback write never costs the turn its memory", (t) => {
	const store = freshStore(t);
	write(store, "部署流程", "上线前先跑 runlogs", { summary: "查 runlogs" });
	store.markRecalled = () => { throw new Error("feedback write failed"); };
	const hits = store.recallMemory({ ctx: { personOwner: PERSON }, query: "部署流程", limit: 5 });
	assert.equal(hits.length, 1, "recall still returns rows when telemetry write throws");
});

test("P2: a read-only preview never inflates hit_count", (t) => {
	const store = freshStore(t);
	const row = write(store, "部署流程", "上线前先跑 runlogs", { summary: "查 runlogs" });
	store.recallMemory({ ctx: { personOwner: PERSON }, limit: 50, recordFeedback: false });
	const after = store.db.prepare("SELECT hit_count FROM kb_entries WHERE id = ?").get(row.id);
	assert.equal(after.hit_count, 0, "a conflict preview must not be recorded as a real recall");
});

test("P2: decay is observable across the stale threshold and usage feeds the prior", (t) => {
	const now = Date.now();
	const store = freshStore(t);
	const old = write(store, "旧事实", "很久以前记下的事", { summary: "旧", ageDays: 200 });
	const fresh = write(store, "新事实", "刚刚记下的事", { summary: "新", ageDays: 0 });
	store.db.prepare("UPDATE kb_entries SET hit_count = 20 WHERE id = ?").run(old.id);

	const ranked = store.recallMemory({ ctx: { personOwner: PERSON }, query: "", limit: 5, staleDays: 90, now });
	const oldRow = ranked.find((r) => r.id === old.id);
	const freshRow = ranked.find((r) => r.id === fresh.id);
	// Mutation guard: forcing `fresh = true` makes these equal (both keep priors).
	assert.equal(oldRow.recallScore, 0, "past the stale threshold the prior is gone entirely");
	assert.ok(freshRow.recallScore > 0, "a fresh row keeps its recency prior");
	// And a within-threshold row with usage beats one without.
	const used = write(store, "常用事实", "经常被想起的事", { summary: "常用", ageDays: 1 });
	store.db.prepare("UPDATE kb_entries SET hit_count = 9 WHERE id = ?").run(used.id);
	const plain = write(store, "少用事实", "很少被想起的事", { summary: "少用", ageDays: 1 });
	const again = store.recallMemory({ ctx: { personOwner: PERSON }, query: "", limit: 10, staleDays: 90, now });
	assert.ok(
		again.find((r) => r.id === used.id).recallScore > again.find((r) => r.id === plain.id).recallScore,
		"usage prior is real (mutating it to 0 must fail this)",
	);
});

test("P2: a normalized-equal-but-different raw title still raises a conflict", () => {
	const existing = [{ id: "1", title: "报告交付方式", summary: "文本框" }];
	// The store does NOT overwrite across raw titles, so this must be flagged.
	assert.equal(findTitleConflict("报告 交付方式", existing)?.title, "报告交付方式");
	// The exact raw title IS the sanctioned overwrite path.
	assert.equal(findTitleConflict("报告交付方式", existing), null);
});

// ── Review round 2 (2026-10-27) ───────────────────────────────────────

test("R2-P1: a common word in the title cannot admit an unrelated message", (t) => {
	const store = freshStore(t);
	// Reviewer's probe: 「分析仪采购」 + a sports query sharing only 「分析」.
	write(store, "分析仪采购", "采购需要审批", { summary: "分析仪采购需审批" });
	const hits = store.recallMemory({
		ctx: { personOwner: PERSON },
		query: "请帮我分析昨天比赛的比分以及球员表现并预测下场比赛的胜负走势",
		limit: 5,
	});
	assert.equal(hits.length, 0, `one shared word must not admit, got: ${hits.map((h) => `${h.title}(${h.relevance.toFixed(2)})`).join(", ")}`);
});

test("R2-P2: a query with no searchable tokens admits nothing (no dump-everything fallback)", (t) => {
	const store = freshStore(t);
	write(store, "午饭偏好", "午饭吃第 1 家", { summary: "午饭" });
	write(store, "报告交付方式", "用可复制文本框", { summary: "文本框" });
	for (const query of ["我能如何", "如何", "？", "可能", "不会"]) {
		const hits = store.recallMemory({ ctx: { personOwner: PERSON }, query, limit: 10 });
		assert.equal(hits.length, 0, `「${query}」 has no searchable tokens and must admit nothing, got ${hits.length}`);
	}
	// An EMPTY query still means "index mode" (recency), unchanged.
	const indexed = store.recallMemory({ ctx: { personOwner: PERSON }, query: "", limit: 10 });
	assert.equal(indexed.length, 2, "an empty query is still the recency index");
});

test("R2-P2: body-only relevance is admitted — content matches count", (t) => {
	const store = freshStore(t);
	// Title says "格式偏好" (no overlap); the body carries the题.
	write(store, "格式偏好", "报告用可复制文本框交付", { summary: "报告用文本框" });
	const hits = store.recallMemory({
		ctx: { personOwner: PERSON },
		query: "请梳理客户访谈纪要中的预算限制采购流程审批负责人交付节点然后输出报告",
		limit: 5,
	});
	assert.ok(hits.length > 0, "a memory whose BODY matches the request must be admitted");
});

test("R3: a pasted log does not swallow the question at the end", (t) => {
	const store = freshStore(t);
	write(store, "报告交付方式", "对方偏好把正式报告用可复制文本框交付", { summary: "报告用文本框" });
	// The real shape of a long input: a pasted log, then the actual question.
	const log = Array.from({ length: 60 }, (_, i) => `2026-10-27 chrono:${String(i).padStart(2, "0")} INFO worker ${i} heartbeat ok latency=${i}ms`).join("\n");
	const hits = store.recallMemory({ ctx: { personOwner: PERSON }, query: `${log}\n\n这个报告交付时应该用可复制文本框吗？`, limit: 5 });
	assert.ok(hits.some((h) => h.title === "报告交付方式"), `the trailing question must still recall, got ${hits.map((h) => h.title).join(",")}`);
});

test("R3: the trailing ask keeps its token share even behind a huge paste", () => {
	const log = "deploy ".repeat(400) + "worker heartbeat ok ";
	const tokens = recallTokens(`${log} 这个报告交付用什么文本框`);
	assert.ok(tokens.includes("报告"), "the ask's tokens survive a repetitive body");
	assert.ok(tokens.includes("交付"), "adjacent ask token survives");
	assert.ok(tokens.length <= 40, "budget still bounded");
});
