/**
 * TurnRecord — the append-only unit of the conversation context ledger (CCL).
 *
 * One normalized entry per thing that happened in a conversation: the user's
 * request, the reply, a tool digest, a steering message, a delivery event, or a
 * system row (compaction summaries). The ledger is what makes context survive
 * the kernel: the engine only ever executes ONE turn, so everything that must be
 * visible in a LATER turn has to live here (design: router-worker-core.md §6).
 *
 * Hard rule (design §6.5): rows are partitioned by `conversationId` — a trigger
 * identity (`dt:<staff>` / `dt:group:<cid>`) or a work session (`work:<id>`).
 * Conversation A can never read conversation B's rows; cross-session sharing
 * happens only through explicit references (`refs`), never by reading another
 * partition.
 */

/** What a ledger row records. `system` carries engine-side rows — today only the
 * compaction summary that heads a compacted chain (see COMPACTION_SUMMARY_MARK). */
export type TurnKind = "request" | "reply" | "tool-digest" | "steer" | "delivery" | "system";

/** A tool call reduced to what a LATER window needs to re-judge the situation.
 * Deliberately lossy on purpose (Inline & Spill): the briefs are the inline part,
 * `artifacts` are the spill pointers the model can follow with a tool.
 *
 * `durationMs` is mandatory at collection time (WorkSession P1 wiring: a digest
 * must carry name + cost + outcome so a later window can tell a 2ms cache read
 * from a 40s page scrape); optional in the TYPE only so older rows and
 * hand-built test records render unchanged.
 */
export interface ToolDigest {
	name: string;
	argsBrief: string;
	resultBrief: string;
	durationMs?: number;
	artifacts?: string[];
}

export interface TurnRecord {
	/** Ledger partition: trigger identity or `work:<id>`. */
	conversationId: string;
	/** Position inside this conversation's ledger (caller-allocated order key;
	 * 1-based in normal appends. Compaction/prune may leave gaps or shift the
	 * head below 1 — ordering is all that matters, never contiguity). */
	seq: number;
	kind: TurnKind;
	/** The user's own words / the final reply / a delivery notice / the summary. */
	text: string;
	toolDigest?: ToolDigest;
	/** Related object ids (work:<id>, kb entries, persons) — Chain of Recall edges. */
	refs?: string[];
	ts: number;
}

/** Marks a `system` row as a compaction summary. The chain head is identified by
 * this prefix rather than a dedicated kind, so a TurnRecord stays the single row
 * shape and an old summary is re-summarizable like any other head (chained
 * summary, ported from engine/context.ts maybeCompact). */
export const COMPACTION_SUMMARY_MARK = "【上文摘要】";

/** True for a compaction-summary row (the chain head a new summary chains onto). */
export function isSummaryRecord(record: TurnRecord): boolean {
	return record.kind === "system" && record.text.startsWith(COMPACTION_SUMMARY_MARK);
}

/** Summary text of a summary row, mark stripped. */
export function summaryTextOf(record: TurnRecord): string {
	return record.text.slice(COMPACTION_SUMMARY_MARK.length).trim();
}

/**
 * Ledger role a row replays as. Requests and steering messages are the user
 * side; everything else (replies, tool digests, deliveries, summaries) is what
 * the employee produced. Bundle assembly uses this for turn boundaries and for
 * role alternation.
 */
export function recordRole(record: TurnRecord): "user" | "assistant" {
	return record.kind === "request" || record.kind === "steer" ? "user" : "assistant";
}

/**
 * Flattened text a row contributes — to a ContextBundle message, and to the
 * summarizer's input. Tool digests render as one line (the inline part) with
 * their artifacts as spill pointers; `refs` are inlined as ids so the model can
 * follow them (Chain of Recall) instead of re-deriving them.
 */
export function recordText(record: TurnRecord): string {
	const parts: string[] = [];
	if (record.toolDigest) {
		const d = record.toolDigest;
		const cost = typeof d.durationMs === "number" ? `（${d.durationMs}ms）` : "";
		parts.push(`[工具] ${d.name}${cost} 参数:${d.argsBrief} → 结果:${d.resultBrief}`);
		if (d.artifacts && d.artifacts.length > 0) parts.push(`产物:${d.artifacts.join("、")}`);
	}
	if (record.text) parts.push(record.text);
	if (record.refs && record.refs.length > 0) parts.push(`关联:${record.refs.join("、")}`);
	return parts.join("\n");
}

/** Ledger partition prefix of a WorkSession: one WorkItem's permanent
 * conversation (`work:<itemId>`). The colon delimits the prefix, so the durable
 * WorkerService's `worker:<id>` partitions never match. */
export const WORK_CONVERSATION_PREFIX = "work:";

/** True for a WorkSession partition (the ONLY partition the P1 wiring rewires). */
export function isWorkConversation(conversationId: string): boolean {
	return conversationId.startsWith(WORK_CONVERSATION_PREFIX);
}
