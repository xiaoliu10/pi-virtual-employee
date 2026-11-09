/**
 * Compaction for the CCL ledger — ported from `engine/context.ts`
 * (maybeCompact / findCompactionCut / findForcedCompactionCut / truncateToFit) so
 * the ledger and the live transcript share ONE compaction policy.
 *
 * Differences from the transcript version, and why:
 *  - It operates on TurnRecord lists, not `agent.state.messages`: after P1 the
 *    kernel executes one turn and the ledger owns everything across turns, so
 *    this is the only place a summary can be produced from.
 *  - The summarizer is INJECTED (`summarize`): CCL never calls an LLM itself, so
 *    the caller keeps its own model routing, retry policy and abort signal (the
 *    engine's SUMMARIZER_RETRY stays where it is).
 *  - It is a pure transform: it returns the rebuilt ledger and never touches the
 *    store. Persisting the compacted head (delete the summarized rows, write the
 *    summary row at the head position) belongs to the wiring that owns the
 *    ledger session — what is guaranteed HERE is that an empty or failed summary
 *    can never become that head.
 *
 * The field-incident comments are carried over verbatim where the failure mode
 * still applies; each one cost a real outage.
 */
import {
	DEFAULT_COMPACTION_SETTINGS,
	shouldCompact,
} from "../engine/pi-compaction.js";
import { estimateTurnTokens } from "./estimate.js";
import {
	COMPACTION_SUMMARY_MARK,
	isSummaryRecord,
	recordRole,
	recordText,
	type TurnRecord,
} from "./records.js";

/** Why a compaction pass did not run — /compact must report the REAL reason,
 * not fold "summary generation failed" into "no need" (field bug 2026-09-18:
 * a forced /compact below the threshold always printed 无需压缩 even when the
 * summarizer itself had failed). */
export type CompactSkipReason = "below_threshold" | "nothing_to_cut" | "empty_head" | "summary_failed";

export interface CompactOutcome {
	compacted: boolean;
	skipReason?: CompactSkipReason;
	/** The rebuilt ledger: summary head + verbatim recent tail. Untouched input
	 * when nothing ran. */
	records: TurnRecord[];
}

/** Summarizer injected by the caller. Receives the rows being summarized
 * (oldest first) plus the previous summary when chaining onto one. */
export type TurnSummarizer = (records: TurnRecord[], previousSummary?: string) => Promise<string>;

export interface CompactOptions {
	/** Verbatim tail budget, in estimated tokens (same accounting as buildBundle). */
	keepRecentTokens: number;
	/** Ceiling the ledger is measured against, e.g. `usableContextWindow(window, maxTokens)`. */
	budgetTokens: number;
	summarize: TurnSummarizer;
	/** Skip the threshold check (explicit /compact) but keep the tail guard. */
	force?: boolean;
	/** Partition of the produced summary row (defaults to the first row's). */
	conversationId?: string;
	/** Timestamp stamped on the summary row (defaults to now). */
	now?: number;
}

/**
 * Summarize the old head when the ledger approaches the context window.
 *
 * Keeps a tail of roughly `keepRecentTokens`, chains onto any previous summary
 * row, and replaces the head with a fresh summary row. `force=true` (the
 * /compact command) skips the threshold check but keeps the same tail guard —
 * recent rows stay verbatim, only the old head is summarized. Returns
 * `compacted: false` with the reason when there was nothing to do (below
 * threshold, ledger too short to split); failures leave the ledger untouched.
 *
 * MEASUREMENT SCOPE (review P2-2, 2026-11-09): the threshold measures LEDGER
 * ROWS ONLY. Non-ledger injections — the system prompt, the memory prefix,
 * tool declarations — are NOT counted here; the CALLER must subtract their
 * reserves from `budgetTokens` before passing it (buildBundle counts them, so
 * a caller using both must pass compact the ledger-only ceiling). Aligning the
 * two measurements on one number is P2 wiring work (replaceHead + one shared
 * measurement).
 */
export async function compactIfNeeded(records: TurnRecord[], opts: CompactOptions): Promise<CompactOutcome> {
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: opts.keepRecentTokens };
	const total = totalTokens(records);
	if (!opts.force && !shouldCompact(total, opts.budgetTokens, settings)) {
		return { compacted: false, skipReason: "below_threshold", records };
	}

	// Cut point: compaction never splits within a turn — see findCompactionCut.
	let cut = findCompactionCut(records, settings.keepRecentTokens);
	// Forced passes (explicit /compact, overflow recovery) relax the rule for
	// single-turn ledgers: the user ORDERED a compaction, so make a genuine
	// best effort — keep the task statement, summarize the middle (2026-09-18).
	// Also force when the normal cut only captures a previous summary row
	// (cut=1 → empty_head): the ledger grew back after a prior compaction and
	// the new rows between summary and tail are exactly what needs summarizing
	// (field 2026-09-24: 158k context, cut=1, recovery reported "could not free
	// room" even though 140k of new tool results were summarizable).
	let keepIndex = -1;
	if (opts.force && (cut === 0 || cut === records.length || (cut <= 1 && isSummaryRecord(records[0])))) {
		const forced = findForcedCompactionCut(records, settings.keepRecentTokens);
		if (forced) {
			cut = forced.cut;
			keepIndex = forced.keepIndex;
		}
	}
	if (cut === 0 || cut === records.length) {
		return { compacted: false, skipReason: "nothing_to_cut", records };
	}

	let old = records.slice(0, cut);
	let recent = records.slice(cut);
	if (keepIndex >= 0) {
		old = records.slice(0, cut).filter((_, i) => i !== keepIndex);
		recent = [records[keepIndex], ...recent];
	}

	// Chain onto a prior summary instead of re-summarizing it.
	let previousSummary: string | undefined;
	const head = old[0];
	if (head && isSummaryRecord(head)) {
		previousSummary = head.text.slice(COMPACTION_SUMMARY_MARK.length).trim();
		old = old.slice(1);
	}
	if (old.length === 0) {
		return { compacted: false, skipReason: "empty_head", records };
	}

	let summary: string;
	try {
		summary = await opts.summarize(old, previousSummary);
	} catch (err) {
		console.warn("[context] compaction summary failed:", err instanceof Error ? err.message : err);
		return { compacted: false, skipReason: "summary_failed", records };
	}
	// An aborted or empty summarization must never land as a "successful"
	// compaction: pi-ai's EventStream.result() RESOLVES an aborted turn as a
	// message with stopReason "aborted" and empty content, and upstream's
	// getSummarizationFailure only guards error/length — so an empty string
	// would otherwise replace the whole ledger head, and the summary path then
	// re-tries forever afterwards because the empty head keeps measuring
	// over-budget (0.99.1 guarded this). Leave the ledger intact and report the
	// honest skip reason.
	if (!summary.trim()) {
		console.warn("[context] compaction summary was empty (aborted or blank response) — ledger kept");
		return { compacted: false, skipReason: "summary_failed", records };
	}

	const summaryRecord: TurnRecord = {
		conversationId: opts.conversationId ?? records[0].conversationId,
		// Head position: ONE BELOW the first KEPT row. In the normal path the old
		// head is deleted on write-back, so any position below recent[0] is free;
		// in the FORCED path keepIndex=0 KEEPS records[0] alive, and reusing its
		// seq produced a duplicate — write-back threw UNIQUE (review P1-1,
		// 2026-11-09: forced/truncate both yielded [summary, task, …] with the
		// task's own seq). Seq gaps are fine: this is an append-only ledger,
		// ordering is all that matters.
		seq: recent[0].seq - 1,
		kind: "system",
		text: `${COMPACTION_SUMMARY_MARK}\n${summary.trim()}`,
		ts: opts.now ?? Date.now(),
	};
	console.log(
		`[context] compacted ${summaryRecord.conversationId}: ${old.length} turns → summary (~${total} tokens before)`,
	);
	return { compacted: true, records: [summaryRecord, ...recent] };
}

/** CJK-aware size of a whole ledger, for the threshold gate. */
export function totalTokens(records: TurnRecord[]): number {
	let tokens = 0;
	for (const record of records) tokens += estimateTurnTokens(record);
	return tokens;
}

/**
 * Walk back until the kept tail is roughly `keepRecentTokens`, then advance to
 * the next turn boundary (a user-side row) so the tail starts on a turn boundary.
 * Returns 0 when there is nothing summarizable (ledger shorter than the tail, no
 * boundary before it).
 */
export function findCompactionCut(records: TurnRecord[], keepRecentTokens: number): number {
	let cut = records.length;
	let kept = 0;
	while (cut > 0 && kept < keepRecentTokens) {
		cut--;
		kept += estimateTurnTokens(records[cut]);
	}
	while (cut < records.length && recordRole(records[cut]) !== "user") cut++;
	if (cut === records.length && records.length > 0) {
		// The keep-recent walk landed inside the FINAL turn — its own tool digests
		// fill the tail, so there is no user boundary left in the tail (field
		// deadlock 2026-09-17: a 112k conversation whose every turn tripped the
		// budget gate while compaction returned "nothing to do", forever). Rewind
		// to the last user row and keep just that turn verbatim instead of giving
		// up — summarizing the past always makes forward progress.
		const lastUserIdx = records.findLastIndex((r) => recordRole(r) === "user");
		cut = Math.max(lastUserIdx, 0);
	}
	return cut;
}

export interface ForcedCut {
	/** First kept record index (the task statement). */
	keepIndex: number;
	/** Tail starts here (first record of the kept recent window). */
	cut: number;
}

/**
 * Forced-compaction cut for SINGLE-TURN ledgers (one task statement followed by a
 * huge execution trace): the normal user-boundary rule has nothing to cut, but
 * these are exactly the sessions worth compacting. Keep the task statement
 * verbatim (summarizing away the goal would corrupt the session), summarize the
 * middle, keep the recent tail. Returns null when nothing can be freed at all.
 */
export function findForcedCompactionCut(records: TurnRecord[], keepRecentTokens: number): ForcedCut | null {
	const keepIndex = records.findIndex((r) => recordRole(r) === "user");
	if (keepIndex < 0) return null;
	let cut = records.length;
	let kept = 0;
	while (cut > keepIndex + 1 && kept < keepRecentTokens) {
		cut--;
		kept += estimateTurnTokens(records[cut]);
	}
	// The kept tail must not open on a tool digest whose request was summarized
		// away — the same orphan hazard as the transcript version's toolResult rule.
		// Ledger digests are self-sufficient though (no toolCall pairing), so cap
		// the skip at the LAST row: walking to the end would give up on exactly the
		// digest-heavy single-turn ledgers worth compacting (review P3-4/P1-1,
		// 2026-11-09).
		while (cut < records.length - 1 && records[cut].kind === "tool-digest") cut++;
	if (cut <= keepIndex + 1) return null;
	return { cut, keepIndex };
}

/** The discard note's prefix — a `system` row that records a cut, not a summary
 * (so it is never mistaken for one, exactly like TRUNCATE_NOTE_PREFIX upstream). */
export const TRUNCATE_NOTE_PREFIX = "（上下文超出模型上限";

/**
 * Last-resort shrink for when compaction cannot help (the summarizer call
 * failed, or nothing to split). Keeps a recent tail and replaces the dropped
 * head with an explicit note, so the model knows history was cut instead of
 * silently losing it. Returns the rebuilt ledger plus how many rows were
 * dropped, or null when nothing could be dropped (already minimal) — the caller
 * then gives up honestly rather than looping.
 *
 * Field incident 2026-09-23: for a SINGLE-TURN ledger (one task statement + a
 * long execution trace) this used to give up in two ways: the drop target
 * exceeded the whole ledger so the walk-back hit index 0, and the forward scan
 * for a user boundary ran off the end (single turn → none). Recovery then
 * reported "nothing left to drop" and the turn was chopped even though a
 * deterministic partial drop was trivially possible. Fixed: the goal is capped at
 * half the ledger, and when no user boundary exists the task statement is kept
 * verbatim at the seam (mirrors findForcedCompactionCut).
 */
export function truncateToFit(
	records: TurnRecord[],
	targetTokens: number,
	now = Date.now(),
): { records: TurnRecord[]; dropped: number } | null {
	// Preserve the ledger's summary chain head (the scaffolding every later window
	// starts from), not just any system row.
	const head: TurnRecord[] = [];
	let at = 0;
	while (at < records.length && isSummaryRecord(records[at])) {
		head.push(records[at]);
		at++;
	}
	const body = records.slice(at);
	if (body.length <= 2) return null;
	const before = totalTokens(records);
	// A target larger than the ledger itself can never be reached by the walk-back
	// — cap it at half of what is here so the cut always lands inside.
	const goal = Math.min(targetTokens, Math.max(4_000, Math.floor(before / 2)));
	let cut = body.length;
	let kept = 0;
	while (cut > 0 && kept < goal) {
		cut--;
		kept += estimateTurnTokens(body[cut]);
	}
	// Start the kept tail on a user turn so the transcript sees a clean turn order.
	let taskAnchor = -1;
	const walkBack = cut;
	while (cut < body.length && recordRole(body[cut]) !== "user") cut++;
	if (cut >= body.length) {
		// No user boundary in the kept window — single-turn ledger. Keep the task
		// statement verbatim and drop from right after it instead of giving up.
		taskAnchor = body.findIndex((r) => recordRole(r) === "user");
		if (taskAnchor < 0 || taskAnchor >= walkBack) return null;
		cut = walkBack;
		// The kept tail must not open on a tool digest whose summarizer prompt
		// would lose its request — but never past the last row: ledger digests are
		// self-sufficient, there is no orphan pairing for providers to reject
		// (review P3-4, 2026-11-09).
		while (cut < body.length - 1 && body[cut].kind === "tool-digest") cut++;
	}
	if (cut === 0 || cut >= body.length) return null;
	const dropped = taskAnchor >= 0 ? cut - 1 : cut;
	if (dropped <= 0) return null;
	const keptRecords = taskAnchor >= 0 ? [body[taskAnchor], ...body.slice(cut)] : body.slice(cut);
	const note: TurnRecord = {
		conversationId: records[0].conversationId,
		// Head position: ONE BELOW the first KEPT row (review P1-1 2026-11-09 —
		// reusing body[0].seq collided with the kept task statement when
		// taskAnchor === 0, i.e. single-turn ledgers; gaps are allowed).
		seq: keptRecords[0].seq - 1,
		kind: "system",
		text: `${TRUNCATE_NOTE_PREFIX}，本次请求已丢弃更早的 ${dropped} 条记录以继续；完整历史仍可在会话记录中查看。）`,
		ts: now,
	};
	console.log(`[context] context overflow: dropped ${dropped} older records (~${before} tokens before)`);
	return { records: [...head, note, ...keptRecords], dropped };
}

/** Serialize rows for a summarizer prompt: plain text, tool digests inlined.
 * Keeps the model from treating the input as a conversation to continue (same
 * rationale as pi's serializeConversation). */
export function serializeTurns(records: TurnRecord[]): string {
	return records.map((r) => `[${r.kind}#${r.seq}] ${recordText(r)}`).join("\n\n");
}
