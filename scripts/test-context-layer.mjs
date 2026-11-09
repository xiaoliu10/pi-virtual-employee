/**
 * CCL context-layer tests (src/context/). Run with `npm run test:context-layer`.
 *
 * Pins the P1 properties the router-worker design (§6) makes load-bearing:
 *  - CJK-aware estimation: a Chinese character is roughly one token — the
 *    accounting that the durable kernel got wrong (compaction fired late).
 *  - The ledger is HARD-partitioned by conversation: one trigger's session can
 *    never read another's rows, whatever query shape is used.
 *  - Bundle assembly spends no more than its budget and always keeps the
 *    summary chain head and the newest turn.
 *  - Compaction chains onto the previous summary, and an empty/failed summary
 *    NEVER lands in the ledger (field incident: an empty summary used to be
 *    able to replace the whole transcript head).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.context-layer-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "context-layer.mjs");
await build({
	stdin: {
		contents: `
			export { ContextStore } from "./src/context/store.ts";
			export { buildBundle } from "./src/context/bundle.ts";
			export { compactIfNeeded, findCompactionCut, findForcedCompactionCut, truncateToFit, totalTokens, serializeTurns, TRUNCATE_NOTE_PREFIX } from "./src/context/compact.ts";
			export { estimateTokensSafe as cclEstimateTokensSafe, estimateMessageTokens as cclEstimateMessageTokens, estimateTextTokens, estimateTurnTokens, usableContextWindow as cclUsableContextWindow, FALLBACK_CONTEXT_WINDOW as CCL_FALLBACK_WINDOW } from "./src/context/estimate.ts";
			export { COMPACTION_SUMMARY_MARK, isSummaryRecord, summaryTextOf, recordRole, recordText } from "./src/context/records.ts";
			// The engine shim must be the SAME implementation, not a copy.
			export { estimateTokensSafe as engineEstimateTokensSafe, estimateMessageTokens as engineEstimateMessageTokens, usableContextWindow as engineUsableContextWindow, FALLBACK_CONTEXT_WINDOW as ENGINE_FALLBACK_WINDOW } from "./src/engine/context.ts";
			// pi's own estimator, for the "never below pi" property.
			export { estimateTokens as piEstimateTokens } from "./src/engine/pi-compaction.ts";
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
const {
	ContextStore,
	buildBundle,
	compactIfNeeded,
	findForcedCompactionCut,
	serializeTurns,
	truncateToFit,
	TRUNCATE_NOTE_PREFIX,
	COMPACTION_SUMMARY_MARK,
	isSummaryRecord,
	summaryTextOf,
	recordRole,
	recordText,
	cclEstimateTokensSafe,
	cclEstimateMessageTokens,
	cclUsableContextWindow,
	estimateTextTokens,
	estimateTurnTokens,
	CCL_FALLBACK_WINDOW,
	engineEstimateTokensSafe,
	engineEstimateMessageTokens,
	engineUsableContextWindow,
	ENGINE_FALLBACK_WINDOW,
	piEstimateTokens,
} = await import(pathToFileURL(bundle).href);

const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });

/** 100 pure CJK ideographs = 100 estimated tokens (1 token per character). */
const CN100 = "一二三四五六七八九十".repeat(10);

function store() {
	return new ContextStore(new DatabaseSync(":memory:"));
}

function rec(conversationId, seq, kind, text, extra = {}) {
	return { conversationId, seq, kind, text, ts: 1_700_000_000_000 + seq, ...extra };
}

// ============================================================================
// Estimation (收编后的唯一口径)
// ============================================================================

test("CJK estimation: a Chinese character is roughly one token, English keeps ~4 chars/token", () => {
	const cn = "查一下今天的天气然后整理成表格发给群里".repeat(50); // 950 ideographs
	assert.ok(estimateTextTokens(cn) >= cn.length * 0.95, `CJK must count ~1 token/char (got ${estimateTextTokens(cn)} for ${cn.length} chars)`);
	assert.ok(estimateTextTokens(cn) > piEstimateTokens(user(cn)) * 2, "CJK must be counted far above pi's chars÷4 heuristic");

	const en = "The quick brown fox jumps over the lazy dog. ".repeat(20); // 900 chars
	assert.ok(estimateTextTokens(en) >= en.length / 4.5, "English must not under-count");
	assert.ok(estimateTextTokens(en) <= en.length / 3, `English stays near 4 chars/token (got ${estimateTextTokens(en)} for ${en.length} chars)`);

	// The message-level estimator never goes below pi's own number.
	const msg = user(cn);
	assert.ok(cclEstimateMessageTokens(msg) >= piEstimateTokens(msg));
	// Ledger rows measure with the same accounting.
	assert.equal(estimateTurnTokens(rec("c", 1, "request", cn)), estimateTextTokens(cn));
});

test("the engine shim re-exports the CCL estimator (one accounting, not a copy)", () => {
	assert.equal(engineEstimateTokensSafe, cclEstimateTokensSafe);
	assert.equal(engineEstimateMessageTokens, cclEstimateMessageTokens);
	assert.equal(engineUsableContextWindow, cclUsableContextWindow);
	assert.equal(ENGINE_FALLBACK_WINDOW, CCL_FALLBACK_WINDOW);
	assert.equal(CCL_FALLBACK_WINDOW, 200_000);
});

// ============================================================================
// ContextStore: append / list / prune / partition isolation
// ============================================================================

test("store: ledger order, newest-tail limit, exclusive sinceSeq, lastSeq", () => {
	const s = store();
	for (let i = 1; i <= 5; i++) s.appendTurn(rec("c1", i, "request", `消息${i}`));
	assert.equal(s.lastSeq("c1"), 5);
	assert.deepEqual(s.listTurns("c1").map((r) => r.seq), [1, 2, 3, 4, 5]);
	// limit = newest N, still oldest→newest.
	assert.deepEqual(s.listTurns("c1", { limit: 2 }).map((r) => r.seq), [4, 5]);
	// sinceSeq is exclusive.
	assert.deepEqual(s.listTurns("c1", { sinceSeq: 3 }).map((r) => r.seq), [4, 5]);
	// composed: newest 3 after cursor 1 (seq > 1 → 2..5, newest 3).
	assert.deepEqual(s.listTurns("c1", { sinceSeq: 1, limit: 3 }).map((r) => r.seq), [3, 4, 5]);
	// an unknown partition is empty, never an error
	assert.deepEqual(s.listTurns("missing"), []);
	assert.equal(s.lastSeq("missing"), 0);
});

test("store: tool digests and refs round-trip through the ledger", () => {
	const s = store();
	s.appendTurn(rec("c1", 1, "tool-digest", "查到了表格", {
		toolDigest: { name: "browser.read", argsBrief: "url=…", resultBrief: "表格 12 行", artifacts: ["work:9"] },
		refs: ["work:9", "person:dt:u1"],
	}));
	const [row] = s.listTurns("c1");
	assert.deepEqual(row.toolDigest, { name: "browser.read", argsBrief: "url=…", resultBrief: "表格 12 行", artifacts: ["work:9"] });
	assert.deepEqual(row.refs, ["work:9", "person:dt:u1"]);
	// The digest renders inline with artifacts as spill pointers and refs as ids.
	const text = recordText(row);
	assert.ok(text.includes("[工具] browser.read"), "digest name must be inline");
	assert.ok(text.includes("work:9"), "artifact/ref ids must be inline (Chain of Recall)");
});

test("store: partitions are hard-isolated — one conversation never sees another's rows", () => {
	const s = store();
	// Interleaved appends into two trigger identities.
	s.appendTurn(rec("dt:group:A", 1, "request", `${CN100} 甲问`));
	s.appendTurn(rec("dt:staff:B", 1, "request", `${CN100} 乙问`));
	s.appendTurn(rec("dt:group:A", 2, "reply", `${CN100} 甲答`));
	s.appendTurn(rec("dt:staff:B", 2, "tool-digest", "", { toolDigest: { name: "t", argsBrief: "a", resultBrief: "r" } }));

	const a = s.listTurns("dt:group:A");
	const b = s.listTurns("dt:staff:B");
	assert.equal(a.length, 2);
	assert.equal(b.length, 2);
	// Every read shape returns only this partition's rows.
	for (const row of [...a, ...s.listTurns("dt:group:A", { limit: 1 }), ...s.listTurns("dt:group:A", { sinceSeq: 1 })]) {
		assert.equal(row.conversationId, "dt:group:A");
	}
	assert.deepEqual(a.map((r) => r.seq), [1, 2]);
	assert.equal(s.lastSeq("dt:staff:B"), 2);
	assert.ok(!JSON.stringify(a).includes("乙问"), "A must not contain B's text");
	assert.ok(!JSON.stringify(b).includes("甲问"), "B must not contain A's text");
	// Deleting one partition leaves the other untouched.
	s.deleteConversation("dt:staff:B");
	assert.deepEqual(s.listTurns("dt:staff:B"), []);
	assert.equal(s.listTurns("dt:group:A").length, 2);
});

test("store: pruneOlderThan drops only rows past the cutoff", () => {
	const s = store();
	s.appendTurn({ ...rec("c1", 1, "request", "旧"), ts: 1_000 });
	s.appendTurn({ ...rec("c1", 2, "request", "新"), ts: Date.now() });
	assert.equal(s.pruneOlderThan(2_000), 1);
	assert.deepEqual(s.listTurns("c1").map((r) => r.text), ["新"]);
});

// ============================================================================
// buildBundle: budget assembly
// ============================================================================

/** One request/reply pair; each row ~50 CJK tokens. */
function pairRows(conversationId, firstSeq, pairs) {
	const rows = [];
	let seq = firstSeq;
	for (let i = 0; i < pairs; i++) {
		rows.push(rec(conversationId, seq++, "request", CN100.slice(0, 50) + `问${i}`));
		rows.push(rec(conversationId, seq++, "reply", CN100.slice(0, 50) + `答${i}`));
	}
	return rows;
}

test("bundle: summary chain inline first, recent window cut by the shared rule", () => {
	const s = store();
	s.appendTurn(rec("c1", 1, "system", `${COMPACTION_SUMMARY_MARK}\n第一轮摘要：之前查过天气`));
	for (const row of pairRows("c1", 2, 6)) s.appendTurn(row); // seq 2..13, ~600 tokens

	const bundleOut = buildBundle(s, {
		conversationId: "c1",
		systemPrompt: "你是员工的助手。",
		keepRecentTokens: 250,
		budgetTokens: 100_000,
	});
	assert.equal(bundleOut.budget.window, 100_000);
	assert.ok(bundleOut.budget.estimatedTokens <= 100_000);
	// Summary chain head comes first, inline.
	assert.equal(bundleOut.messages[0].role, "assistant");
	assert.ok(bundleOut.messages[0].content[0].text.includes("第一轮摘要"), "the chain head must be inlined");
	// The window starts on a turn boundary and holds only recent rows.
	const texts = bundleOut.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("")));
	assert.ok(texts.some((t) => t.includes("问5")), "the newest turn must be in the window");
	assert.ok(!JSON.stringify(bundleOut.messages).includes("问0"), "old rows beyond the tail budget must stay out");
	// Roles alternate (providers reject consecutive same-role messages).
	for (let i = 1; i < bundleOut.messages.length; i++) {
		assert.notEqual(bundleOut.messages[i].role, bundleOut.messages[i - 1].role);
	}
});

test("bundle: over-budget assemblies shed oldest window rows, keep chain head + newest turn", () => {
	const s = store();
	s.appendTurn(rec("c1", 1, "system", `${COMPACTION_SUMMARY_MARK}\n第一轮摘要：之前查过天气`));
	for (let i = 1; i <= 8; i++) s.appendTurn(rec("c1", i + 1, "request", CN100 + `第${i}轮`)); // 8 × 100 tokens

	const out = buildBundle(s, {
		conversationId: "c1",
		systemPrompt: "你是员工的助手。",
		keepRecentTokens: 100_000,
		budgetTokens: 450, // way under the naive assembly
	});
	assert.ok(out.budget.estimatedTokens <= 450, `budget must be enforced (got ${out.budget.estimatedTokens})`);
	const flat = JSON.stringify(out.messages);
	assert.ok(flat.includes("第8轮"), "the newest turn must survive");
	assert.ok(!flat.includes("第1轮"), "oldest rows are shed first");
	assert.ok(out.messages[0].content[0].text.includes("第一轮摘要"), "the chain head never sheds");
});

// ============================================================================
// compactIfNeeded: threshold, chaining, empty-summary guard
// ============================================================================

test("compact: below threshold it does nothing; an empty ledger has nothing to cut", async () => {
	const s = store();
	for (const row of pairRows("c1", 1, 2)) s.appendTurn(row); // ~200 tokens
	const records = s.listTurns("c1");
	const below = await compactIfNeeded(records, { keepRecentTokens: 20_000, budgetTokens: 200_000, summarize: async () => "不该被调用" });
	assert.equal(below.compacted, false);
	assert.equal(below.skipReason, "below_threshold");
	assert.equal(below.records, records, "ledger untouched");

	const nothing = await compactIfNeeded(records, { keepRecentTokens: 20_000, budgetTokens: 1_000, summarize: async () => "不该被调用" });
	assert.equal(nothing.compacted, false);
	assert.equal(nothing.skipReason, "nothing_to_cut");
});

test("compact: summarizes the old head, keeps a verbatim tail, summary lands just before the first kept row", async () => {
	const s = store();
	for (const row of pairRows("c1", 1, 6)) s.appendTurn(row); // seq 1..12, ~600 tokens
	const records = s.listTurns("c1");
	const seen = [];
	const out = await compactIfNeeded(records, {
		keepRecentTokens: 250,
		budgetTokens: 500, // reserveTokens(16384) > budget → threshold trivially passed
		summarize: async (old, previousSummary) => {
			seen.push({ old, previousSummary });
			return "第一轮摘要：问过天气";
		},
	});
	assert.equal(out.compacted, true);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].previousSummary, undefined);
	assert.equal(seen[0].old.length, records.length - 4, "only the old head goes to the summarizer");
	assert.ok(seen[0].old[0].seq === 1, "summarized head starts at the ledger head");

	assert.equal(out.records.length, 5); // summary + tail
	const [head, ...tail] = out.records;
	assert.equal(isSummaryRecord(head), true);
	assert.equal(head.kind, "system");
	// Review P1-1 (2026-11-09): the summary must NEVER reuse a KEPT row's seq —
	// forced single-turn reuse made write-back throw UNIQUE. Position = first
	// kept row's seq minus one (8 = seq 9 minus 1; rows 1..8 are the deleted head).
	assert.equal(head.seq, 8, "the summary sits just before the first kept row");
	assert.equal(summaryTextOf(head), "第一轮摘要：问过天气");
	assert.deepEqual(tail.map((r) => r.seq), records.slice(-4).map((r) => r.seq), "the tail is verbatim");
});

test("compact: a second pass chains onto the previous summary instead of re-summarizing it", async () => {
	const s = store();
	for (const row of pairRows("c1", 1, 6)) s.appendTurn(row);
	const first = await compactIfNeeded(s.listTurns("c1"), {
		keepRecentTokens: 250,
		budgetTokens: 500,
		summarize: async () => "第一轮摘要：问过天气",
	});
	// The ledger grows back after the compaction.
	let seq = 13;
	for (const row of pairRows("c1", seq, 4)) s.appendTurn(row); // seq 13..20
	const rebuilt = [...first.records, ...s.listTurns("c1", { sinceSeq: 12 })];
	const seen = [];
	const second = await compactIfNeeded(rebuilt, {
		keepRecentTokens: 250,
		budgetTokens: 500,
		summarize: async (old, previousSummary) => {
			seen.push({ old, previousSummary });
			return "第二轮摘要：加上了后续追问";
		},
	});
	assert.equal(second.compacted, true);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].previousSummary, "第一轮摘要：问过天气", "the previous summary chains in");
	assert.ok(!seen[0].old.some(isSummaryRecord), "the old summary row is never fed to the summarizer twice");
	const [head] = second.records;
	// Review P1-1: position = first kept row (seq 17) minus one.
	assert.equal(head.seq, 16, "the new summary sits just before the first kept row");
	assert.equal(summaryTextOf(head), "第二轮摘要：加上了后续追问");
	assert.ok(second.records.slice(1).every((r) => r.seq >= 17), "the tail stays verbatim");
});

test("compact: an EMPTY or failed summary never lands in the ledger (现场事故守卫)", async () => {
	const s = store();
	for (const row of pairRows("c1", 1, 6)) s.appendTurn(row);
	const records = s.listTurns("c1");
	const opts = { keepRecentTokens: 250, budgetTokens: 500 };

	const empty = await compactIfNeeded(records, { ...opts, summarize: async () => "  " });
	assert.equal(empty.compacted, false);
	assert.equal(empty.skipReason, "summary_failed");
	assert.equal(empty.records, records, "ledger untouched — no summary row, not even an empty one");
	assert.ok(!empty.records.some(isSummaryRecord), "no empty summary row anywhere in the ledger");

	const thrown = await compactIfNeeded(records, {
		...opts,
		summarize: async () => {
			throw new Error("relay down");
		},
	});
	assert.equal(thrown.compacted, false);
	assert.equal(thrown.skipReason, "summary_failed");
	assert.equal(thrown.records, records);
});

test("compact: forced single-turn ledger keeps the task statement and summarizes the middle", async () => {
	const records = [rec("c1", 1, "request", CN100 + "任务"), ...Array.from({ length: 8 }, (_, i) => rec("c1", i + 2, "tool-digest", CN100, { toolDigest: { name: "t", argsBrief: "a", resultBrief: "r" } })), rec("c1", 10, "reply", CN100 + "完"), rec("c1", 11, "reply", CN100 + "毕")];
	const forced = findForcedCompactionCut(records, 250);
	assert.ok(forced, "single-turn ledger must have a forced cut");
	const out = await compactIfNeeded(records, {
		keepRecentTokens: 250,
		budgetTokens: 500,
		force: true,
		summarize: async () => "执行过程摘要",
	});
	assert.equal(out.compacted, true);
	const [head] = out.records;
	assert.equal(isSummaryRecord(head), true);
	// The task statement is kept verbatim right behind the summary.
	assert.equal(out.records[1].kind, "request");
	assert.ok(out.records[1].text.includes("任务"));
	// The tail replies stay verbatim.
	assert.deepEqual(out.records.slice(-2).map((r) => r.kind), ["reply", "reply"]);
});

test("truncateToFit: drops the old head behind an explicit note, gives up honestly when minimal", () => {
	const s = store();
	for (let i = 1; i <= 12; i++) s.appendTurn(rec("c1", i, "request", CN100 + `第${i}轮`)); // 12 × 100 tokens
	const records = s.listTurns("c1");
	const out = truncateToFit(records, 400);
	assert.ok(out, "a 12-row ledger must shrink");
	assert.equal(out.dropped, 8);
	assert.equal(out.records.length, 5); // note + 4 kept rows
	const [note] = out.records;
	assert.equal(note.kind, "system");
	assert.ok(note.text.startsWith(TRUNCATE_NOTE_PREFIX), "the cut must be explicit, never silent");
	assert.ok(!isSummaryRecord(note), "the discard note is not a summary");
	assert.deepEqual(out.records.slice(1).map((r) => r.seq), [9, 10, 11, 12], "the recent tail survives");
	assert.ok(!JSON.stringify(out.records).includes("第1轮"));

	assert.equal(truncateToFit(records.slice(0, 2), 400), null, "a minimal ledger cannot shrink");
});

test("serializeTurns: rows flatten with kinds and seqs for the summarizer prompt", () => {
	const rows = [rec("c1", 1, "request", "查天气"), rec("c1", 2, "tool-digest", "", { toolDigest: { name: "web.search", argsBrief: "q=天气", resultBrief: "晴" } })];
	const text = serializeTurns(rows);
	assert.ok(text.includes("request#1"), "kind and seq must label each row");
	assert.ok(text.includes("[工具] web.search"), "digest must be inline");
});

// ── Review 闭环（2026-11-09）：P1-1 重复 seq / P2-1 整轮丢弃 / P3-2 NaN limit ──

test("review P1-1: forced compaction on a single-turn ledger yields unique seqs", async () => {
	const s = store();
	// 单轮账本：request(seq1) + 一串 tool-digest + reply —— force 压缩走
	// findForcedCompactionCut，keepIndex=0 的任务陈述被保留。回归钉死：摘要行
	// 不得复用被保留行的 seq（曾产出 [summary(seq1), task(seq1), …]，回写抛 UNIQUE）。
	s.appendTurn(rec("c1", 1, "request", CN100 + "任务陈述"));
	for (let i = 2; i <= 6; i++) s.appendTurn(rec("c1", i, "tool-digest", CN100 + `步骤${i}`));
	s.appendTurn(rec("c1", 7, "reply", CN100 + "结论"));
	const outcome = await compactIfNeeded([...s.listTurns("c1")], {
		keepRecentTokens: 100,
		budgetTokens: 100_000,
		summarize: async () => "任务摘要：查天气并汇总",
		force: true,
		conversationId: "c1",
	});
	assert.equal(outcome.compacted, true);
	const seqs = outcome.records.map((r) => r.seq);
	assert.equal(new Set(seqs).size, seqs.length, `seqs must be unique, got ${JSON.stringify(seqs)}`);
	// 回写不炸：产出列表逐条落进新 store 不得触发 UNIQUE。
	const s2 = store();
	for (const r of outcome.records) s2.appendTurn(r);
	assert.equal(s2.listTurns("c1").length, outcome.records.length);
});

test("review P1-1: truncateToFit on a single-turn ledger yields unique seqs", () => {
	const s = store();
	s.appendTurn(rec("c1", 1, "request", CN100 + "任务陈述"));
	for (let i = 2; i <= 6; i++) s.appendTurn(rec("c1", i, "tool-digest", CN100 + `步骤${i}`));
	const records = s.listTurns("c1");
	const out = truncateToFit(records, 120);
	assert.ok(out, "must be able to drop");
	const seqs = out.records.map((r) => r.seq);
	assert.equal(new Set(seqs).size, seqs.length, `seqs must be unique, got ${JSON.stringify(seqs)}`);
	assert.ok(seqs.every((v, i) => i === 0 || seqs[i - 1] < v), "order must stay ascending");
});

test("review P1-1: chained compaction yields unique seqs (new summary over an old summary row)", async () => {
	const s = store();
	s.appendTurn(rec("c1", 1, "system", `${COMPACTION_SUMMARY_MARK}\n第一轮摘要`));
	for (const row of pairRows("c1", 2, 6)) s.appendTurn(row);
	const first = await compactIfNeeded([...s.listTurns("c1")], {
		keepRecentTokens: 100,
		budgetTokens: 500, // reserveTokens(16384) > budget → threshold trivially passed
		summarize: async (rows, prev) => `二轮摘要（prev=${prev ? "有" : "无"}）：${rows.length} 行`,
		conversationId: "c1",
	});
	assert.equal(first.compacted, true);
	const seqs = first.records.map((r) => r.seq);
	assert.equal(new Set(seqs).size, seqs.length, `seqs must be unique, got ${JSON.stringify(seqs)}`);
});

test("review P2-1: over-budget multi-row turns shed whole turns, newest request survives", () => {
	const s = store();
	// 每轮 = request + reply 两行（打破测试里"行=轮"的旧假设）
	for (let i = 1; i <= 5; i++) {
		s.appendTurn(rec("c1", (i - 1) * 2 + 1, "request", CN100 + `问${i}`));
		s.appendTurn(rec("c1", (i - 1) * 2 + 2, "reply", CN100 + `答${i}`));
	}
	const out = buildBundle(s, {
		conversationId: "c1",
		systemPrompt: "你是员工的助手。",
		keepRecentTokens: 100_000,
		budgetTokens: 350, // 逼到只剩最新一轮
	});
	const flat = JSON.stringify(out.messages);
	assert.ok(flat.includes("问5"), "the newest turn's REQUEST must survive");
	assert.ok(flat.includes("答5"), "the newest turn's reply should survive");
	assert.ok(!flat.includes("问4"), "older turns are shed whole");
	assert.equal(out.messages[0].role, "user", "the window must OPEN on a user row (no head here)");
});

test("review P3-2: listTurns with a NaN limit does not throw and reads the partition", () => {
	const s = store();
	s.appendTurn(rec("c1", 1, "request", `${CN100} 甲问`));
	const rows = s.listTurns("c1", { limit: NaN });
	assert.equal(rows.length, 1, "non-finite limit is treated as unlimited");
});
