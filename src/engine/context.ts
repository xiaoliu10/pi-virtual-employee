/**
 * Conversation context management for employee sessions.
 *
 * Two jobs:
 *  - {@link rehydrateMessages} rebuilds an Agent transcript from persisted
 *    history so a conversation keeps its context across app restarts (the live
 *    transcript otherwise lives only in memory on the Agent).
 *  - {@link maybeCompact} keeps long-running conversations (IM chats run
 *    indefinitely) from outgrowing the model's context window: once usage
 *    passes pi's compaction threshold, older turns are summarized into a
 *    single compaction-summary message while a recent tail is kept verbatim.
 */
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createCompactionSummaryMessage,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	generateSummary,
	shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Models, RetryPolicy, TextContent, Usage } from "@earendil-works/pi-ai";
import type { MessageRow } from "../db/history-store.js";

/** Bound on persisted messages replayed into a fresh session. Older turns stay
 * visible in the UI; the transcript re-grows (and re-compacts) naturally. */
const REHYDRATE_MAX_MESSAGES = 40;

/** Fallback when a model reports no context window. 200k: modern mainstream
 * models are 128k–200k+, and the 0.2.68-era 128k guess mislabeled real-200k
 * relay models (litellm qwen), tripping the budget gate ~40k tokens too early
 * and then never compacting (field incident 2026-09-17). Relay/alias models
 * should now also set the per-model override in the settings UI. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/** Bounded retry for the compaction summarizer. It runs unattended (after-turn
 * and mid-turn overflow recovery), and without a policy a SINGLE transient
 * relay error failed the whole recovery chain — field 2026-09-23: automatic
 * compaction had succeeded repeatedly, then one failed call chopped a
 * long-running task. 2 retries, 1s/2s backoff; deterministic errors still fail
 * fast (retryAssistantCall classifies them as non-retryable). */
const COMPACTION_SUMMARY_RETRY: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1_000 };

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Convert persisted history rows into an Agent transcript.
 *
 * Keeps a bounded tail, starts on a user turn (provider APIs want clean turn
 * order) and merges consecutive same-role messages (they appear when a reply
 * errored out and no assistant row was stored).
 */
export function rehydrateMessages(rows: MessageRow[]): AgentMessage[] {
	if (rows.length === 0) return [];
	const tail = rows.slice(-REHYDRATE_MAX_MESSAGES);
	let start = 0;
	while (start < tail.length && tail[start].role !== "user") start++;
	const out: AgentMessage[] = [];
	for (const row of tail.slice(start)) {
		if (row.role === "user") {
			const prev = out[out.length - 1];
			if (prev && prev.role === "user") {
				prev.content = `${contentText(prev.content)}\n\n${row.content}`;
				continue;
			}
			out.push({ role: "user", content: row.content, timestamp: row.created_at });
			continue;
		}
		const prev = out[out.length - 1];
		const text: TextContent = { type: "text", text: row.content };
		if (prev && prev.role === "assistant") {
			prev.content.push(text);
			continue;
		}
		out.push(restoredAssistant(row.content, row.created_at));
	}
	return out;
}

/** A persisted assistant reply replayed as a minimal assistant message. The api /
 * provider / model / usage fields are metadata only — request serialization is
 * keyed off the live model, and transcripts already survive model switches. */
function restoredAssistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "history",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp,
	};
}

function contentText(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is TextContent => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}


/**
 * Token estimate that does NOT assume English.
 *
 * pi's `estimateTokens` divides characters by 4 — a decent heuristic for English
 * and badly wrong for Chinese, where a character costs about one token
 * (Qwen/GPT-class tokenizers). A Chinese deployment therefore UNDER-counts by
 * 3–5×, `shouldCompact` never fires, and the request only fails at the
 * provider's hard limit. Field report:
 *   `ContextWindowExceededError … maximum context length is 204800 tokens`
 *   on a qwen relay, after which the whole turn was lost — a conversation that
 *   the app believed was ~50k tokens was really over 200k.
 *
 * So: count CJK (and Hangul/Kana) at 1 token per character, everything else at
 * the English rate of 4 chars/token, and take the LARGER of that and pi's own
 * estimate — under-counting is what causes the outage; over-counting only makes
 * compaction run a little earlier, which is cheap.
 */
export function estimateTokensSafe(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const m of messages) tokens += estimateMessageTokens(m);
	return Math.max(tokens, estimateContextTokens(messages).tokens);
}

/**
 * The input-token ceiling the provider will actually accept for this model:
 * the raw context window MINUS the output reservation. Providers reject
 * `input + max_output > window` — field 2026-09-23: a litellm qwen relay
 * rejected a request with 73729 input tokens because 131072 output tokens
 * were ALSO requested (73729 + 131072 = 204801 > 204800), so the compaction
 * gates must measure against window − output, not the raw window.
 *
 * Floored at a quarter of the window so a bogus (over-large) maxTokens can
 * never shrink the usable budget to zero. Shared by maybeCompact and the
 * engine's mid-turn budget gate so both measure the same ceiling.
 */
export function usableContextWindow(contextWindow: number, maxTokens?: number): number {
	const reserve = typeof maxTokens === "number" && maxTokens > 0 ? Math.floor(maxTokens) : 0;
	return Math.max(contextWindow - reserve, Math.floor(contextWindow / 4));
}

/** Same rule as estimateTokensSafe, for a single message. */
export function estimateMessageTokens(message: AgentMessage): number {
	const text = messageText(message);
	let cjk = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		// CJK Unified Ideographs + extensions, CJK punctuation, Kana, Hangul.
		if (
			(code >= 0x3000 && code <= 0x30ff) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xac00 && code <= 0xd7af) ||
			(code >= 0x20000 && code <= 0x2ebef)
		) {
			cjk += 1;
		}
	}
	const other = text.length - cjk;
	return Math.max(cjk + Math.ceil(other / 4), estimateTokens(message));
}

/** Flatten any message shape to its text (tool args/results included). */
function messageText(message: AgentMessage): string {
	const parts: string[] = [];
	const push = (v: unknown) => {
		if (typeof v === "string") parts.push(v);
		else if (v !== null && v !== undefined) {
			try {
				parts.push(JSON.stringify(v));
			} catch {
				/* circular — ignore */
			}
		}
	};
	const any = message as unknown as { content?: unknown; summary?: unknown; output?: unknown; result?: unknown };
	if (typeof any.content === "string") push(any.content);
	else if (Array.isArray(any.content)) {
		for (const block of any.content as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown; content?: unknown }[]) {
			push(block.text ?? block.thinking ?? "");
			push(block.name ?? "");
			push(block.arguments ?? "");
			push(block.content ?? "");
		}
	}
	push(any.summary ?? "");
	push(any.output ?? "");
	push(any.result ?? "");
	return parts.join("");
}

/**
 * True for the provider's "input too long" rejection, however it is phrased by
 * the relay in front of the model (litellm, OpenAI-compatible gateways and the
 * vendors all word it differently).
 */
export function isContextOverflowError(text: string): boolean {
	return /contextwindowexceeded|context length|context_length_exceeded|maximum context|too many tokens|input tokens.*exceed|reduce the length of the input|prompt is too long/i.test(text);
}

/**
 * Last-resort shrink for when compaction cannot help (the summarizer call
 * failed, or nothing to split). Keeps a recent tail and replaces the dropped
 * head with an explicit note, so the model knows history was cut instead of
 * silently losing it. Returns how many messages were dropped, or null when
 * nothing could be dropped (already minimal) — the caller then gives up
 * honestly rather than looping.
 *
 * Field incident 2026-09-23: for a SINGLE-TURN transcript (one task statement +
 * a long execution trace) this used to give up in two ways: the drop target
 * (94k) exceeded the whole transcript (~60k) so the walk-back hit index 0, and
 * the forward scan for a user boundary ran off the end (single turn → none).
 * Recovery then reported "nothing left to drop" and the turn was chopped even
 * though a deterministic partial drop was trivially possible. Fixed: the goal
 * is capped at half the transcript, and when no user boundary exists the task
 * statement is kept verbatim at the seam (mirrors findForcedCompactionCut).
 */
export function truncateToFit(agent: Agent, targetTokens: number, now = new Date().toISOString()): number | null {
	const messages = agent.state.messages;
	if (messages.length <= 2) return null;
	const before = estimateTokensSafe(messages);
	// A target larger than the transcript itself can never be reached by the
	// walk-back — cap it at half of what is here so the cut always lands inside.
	const goal = Math.min(targetTokens, Math.max(4_000, Math.floor(before / 2)));
	let cut = messages.length;
	let kept = 0;
	while (cut > 0 && kept < goal) {
		cut--;
		kept += estimateMessageTokens(messages[cut]);
	}
	// Start the kept tail on a user turn so the provider sees a clean turn order.
	let taskAnchor = -1;
	const walkBack = cut;
	while (cut < messages.length && messages[cut].role !== "user") cut++;
	if (cut >= messages.length) {
		// No user boundary in the kept window — single-turn transcript. Keep the
		// task statement verbatim and drop from right after it instead of giving up.
		taskAnchor = messages.findIndex((m) => m.role === "user");
		if (taskAnchor < 0 || taskAnchor >= walkBack) return null;
		cut = walkBack;
		// The kept tail must not open on an orphaned toolResult (its toolCall would
		// be dropped — providers reject that sequence).
		while (cut < messages.length && messages[cut].role === "toolResult") cut++;
	}
	if (cut === 0 || cut >= messages.length) return null;
	const dropped = taskAnchor >= 0 ? cut - 1 : cut;
	if (dropped <= 0) return null;
	const keptMessages = taskAnchor >= 0 ? [messages[taskAnchor], ...messages.slice(cut)] : messages.slice(cut);
	agent.state.messages = [
		createCompactionSummaryMessage(
			`（上下文超出模型上限，本次请求已丢弃更早的 ${dropped} 条消息以继续；完整历史仍可在会话记录中查看。）`,
			before,
			now,
		),
		// A kept assistant's usage record describes the PRE-drop request; left in
		// place it floors estimateTokensSafe at the old size, so the budget gate's
		// re-check reads a successful drop as still-over-budget and kills a task
		// that was actually saved (field 2026-09-24: "dropped … (~158293 before)"
		// → "could not free room (~158293 …)" — same number both sides). The
		// summary path already strips (maybeCompact); the fallback must too.
		...keptMessages.map(stripStaleUsage),
	];
	console.log(`[engine] context overflow: dropped ${dropped} older messages (~${before} tokens before)`);
	return dropped;
}

/**
 * Summarize old turns when the transcript approaches the context window.
 *
 * Runs after a turn settles; keeps a tail of roughly `keepRecentTokens`,
 * chains onto any previous compaction summary, and replaces the head with a
 * fresh summary message (the harness `convertToLlm` renders it to the model).
 * `force=true` (the /compact command) skips the threshold check but keeps the
 * same tail guard — recent turns stay verbatim, only the old head is
 * summarized. Returns false when there was nothing to do (below threshold, or
 * the transcript is too short to split); failures leave the transcript
 * untouched.
 */
/**
 * Walk back until the kept tail is roughly `keepRecentTokens`, then advance to
 * the next user turn so the tail starts on a turn boundary. Returns 0 when there
 * is nothing summarizable (transcript shorter than the tail, no user boundary
 * before it).
 */
/**
 * Remove a trailing assistant message that must not be continued from. A
 * half-finished request (stream interrupted by a watchdog abort, transient
 * error, in-turn overflow) leaves the tail as either an empty assistant message
 * or an assistant message carrying toolCalls whose toolResults never arrived.
 * The SDK hard-throws "Cannot continue from message role: assistant" and
 * providers reject orphaned tool calls. A COMPLETED reply (non-empty text, no
 * pending tool calls) is preserved. Returns how many messages were removed.
 */
export function stripDanglingAssistant(messages: AgentMessage[]): number {
	let removed = 0;
	const last = messages[messages.length - 1];
	if (last && last.role === "assistant") {
		const text = messageText(last).trim();
		const content = (last as { content?: unknown }).content;
		const parts = Array.isArray(content) ? (content as { type?: string }[]) : [];
		const hasToolCalls = parts.some((p) => p.type === "toolCall");
		if (!text || hasToolCalls) {
			messages.pop();
			removed += 1;
		}
	}
	return removed;
}

/**
 * Drop a kept message's provider usage record. A usage record describes the
 * transcript AS THAT REQUEST SAW IT; kept verbatim past a compaction cut, the
 * newest one pins estimateContextTokens to the PRE-compaction size, so the
 * budget gate reads a successfully compacted transcript as still over budget
 * (field 2026-09-18: "compacted 434 turns → summary" yet "~188760 ≥ 188416" —
 * the turn died on a stale floor). Char-based estimation takes over until the
 * next real response writes a fresh record.
 */
export function stripStaleUsage(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant") return message;
	if (!(message as { usage?: unknown }).usage) return message;
	const { usage: _stale, ...rest } = message as AgentMessage & { usage?: unknown };
	return rest as AgentMessage;
}

export function findCompactionCut(messages: AgentMessage[], keepRecentTokens: number): number {
	let cut = messages.length;
	let kept = 0;
	while (cut > 0 && kept < keepRecentTokens) {
		cut--;
		kept += estimateMessageTokens(messages[cut]);
	}
	while (cut < messages.length && messages[cut].role !== "user") cut++;
	if (cut === messages.length && messages.length > 0) {
		// The keep-recent walk landed inside the FINAL turn — its own tool results
		// fill the 20k tail, so there is no user boundary left in the tail (field
		// deadlock 2026-09-17: a 112k conversation whose every turn tripped the
		// budget gate while compaction returned "nothing to do", forever). Rewind
		// to the last user message and keep just that turn verbatim instead of
		// giving up — summarizing the past always makes forward progress.
		const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
		cut = Math.max(lastUserIdx, 0);
	}
	return cut;
}

export interface ForcedCut {
	/** First kept message index (the task statement). */
	keepIndex: number;
	/** Tail starts here (first message of the kept recent window). */
	cut: number;
}

/**
 * Forced-compaction cut for SINGLE-TURN transcripts (one task statement followed
 * by a huge execution trace): the normal user-boundary rule has nothing to cut,
 * but these are exactly the sessions worth compacting. Keep the task statement
 * verbatim (summarizing away the goal would corrupt the session), summarize the
 * middle, keep the recent tail. Returns null when nothing can be freed at all.
 */
export function findForcedCompactionCut(messages: AgentMessage[], keepRecentTokens: number): ForcedCut | null {
	const keepIndex = messages.findIndex((m) => m.role === "user");
	if (keepIndex < 0) return null;
	let cut = messages.length;
	let kept = 0;
	while (cut > keepIndex + 1 && kept < keepRecentTokens) {
		cut--;
		kept += estimateMessageTokens(messages[cut]);
	}
	// The kept tail must not open on an orphaned toolResult (its toolCall would
	// be summarized away — providers reject that sequence).
	while (cut < messages.length && messages[cut].role === "toolResult") cut++;
	if (cut <= keepIndex + 1) return null;
	return { cut, keepIndex };
}

/**
 * The instruction finalSummary appends as a synthetic USER message (engine.ts).
 * It is scaffolding, not a user task — but it persists in the transcript, and a
 * later compaction can anchor on it as a "user boundary" and summarize away the
 * REAL task message. Anything extracting "the user's task" from a transcript
 * (heartbeat goal, progress slice) must skip it, or the internal prompt leaks
 * verbatim to the user (field 2026-09-24: the heartbeat quoted "现在请不要调用
 * 任何工具…" as the task name after a budget-gate summary plus compaction).
 */
export const FINAL_SUMMARY_PROMPT =
	"现在请不要调用任何工具，直接用一段简明的中文总结：你刚才为完成用户请求做了哪些尝试？最终是成功还是失败？如果没成功，具体卡在哪一步、需要用户怎么配合或提供什么？只输出这段总结。只依据本次对话中真实发生的事与工具真实返回的数据，不要补充任何你没实际取到的数字、结论或「大概是这样」的推测；没取到就直说没取到。";

const SYNTHETIC_USER_PREFIX = "现在请不要调用任何工具，直接用一段简明的中文总结：";

/** True for the finalSummary scaffolding message — never a real user task. */
export function isSyntheticUserMessage(message: AgentMessage): boolean {
	if (message.role !== "user") return false;
	const content = (message as { content?: unknown }).content;
	return typeof content === "string" && content.replace(/\s+/g, " ").trim().startsWith(SYNTHETIC_USER_PREFIX);
}

/** First real (non-synthetic) user message — the task anchor for progress reports. */
export function taskAnchorOf(messages: AgentMessage[]): AgentMessage | undefined {
	return messages.find((m) => m.role === "user" && !isSyntheticUserMessage(m));
}

/**
 * Context for the heartbeat progress summary (field request 2026-09-17: the
 * raw latest-narration snippet read like "检查表格当前行状态" — no sense of
 * where the task actually is). The side-channel LLM call gets the TASK
 * statement (first user message, so the goal is always in view) plus a recent
 * tail of roughly `keepRecentTokens`, deduped when the tail already covers it.
 * Pure slicing — never touches agent state.
 */
export function progressContextSlice(messages: AgentMessage[], keepRecentTokens = 24_000): AgentMessage[] {
	if (messages.length === 0) return [];
	let cut = messages.length;
	let kept = 0;
	while (cut > 0 && kept < keepRecentTokens) {
		cut--;
		kept += estimateMessageTokens(messages[cut]);
	}
	const tail = messages.slice(cut);
	const first = taskAnchorOf(messages);
	if (first && !tail.includes(first)) return [first, ...tail];
	return tail;
}

/** Why a compaction pass did not run — /compact must report the REAL reason,
 * not fold "summary generation failed" into "no need" (field bug 2026-09-18:
 * a forced /compact below the threshold always printed 无需压缩 even when the
 * summarizer itself had failed). */
export type CompactSkipReason = "below_threshold" | "nothing_to_cut" | "empty_head" | "summary_failed";

export interface CompactOutcome {
	compacted: boolean;
	skipReason?: CompactSkipReason;
}

export async function maybeCompact(agent: Agent, models: Models, force = false): Promise<CompactOutcome> {
	const settings = DEFAULT_COMPACTION_SETTINGS;
	const messages = agent.state.messages;
	const model = agent.state.model;
	const contextWindow = model.contextWindow || FALLBACK_CONTEXT_WINDOW;
	// CJK-aware: pi's own estimate divides characters by 4, which under-counts a
	// Chinese transcript badly enough that compaction never fires (see
	// estimateTokensSafe). Overshooting only compacts a bit sooner.
	if (!force && !shouldCompact(estimateTokensSafe(messages), usableContextWindow(contextWindow, model.maxTokens), settings)) {
		return { compacted: false, skipReason: "below_threshold" };
	}

	// Cut point: compaction never splits within a turn — see findCompactionCut.
	let cut = findCompactionCut(messages, settings.keepRecentTokens);
	// Forced passes (explicit /compact, overflow recovery) relax the rule for
	// single-turn transcripts: the user ORDERED a compaction, so make a genuine
	// best effort — keep the task statement, summarize the middle (2026-09-18).
	// Also force when the normal cut only captures a previous compactionSummary
	// (cut=1 → empty_head): the transcript grew back after a prior compaction and
	// the new content between summary and tail is exactly what needs summarizing
	// (field 2026-09-24: 158k context, cut=1, recovery reported "could not free
	// room" even though 140k of new tool results were summarizable).
	let keepIndex = -1;
	if (force && (cut === 0 || cut === messages.length || (cut <= 1 && messages[0]?.role === "compactionSummary"))) {
		const forced = findForcedCompactionCut(messages, settings.keepRecentTokens);
		if (forced) {
			cut = forced.cut;
			keepIndex = forced.keepIndex;
		}
	}
	if (cut === 0 || cut === messages.length) {
		if (force) console.log(`[engine] forced compaction skipped: nothing to cut (~${estimateTokensSafe(messages)} tokens, ${messages.length} messages)`);
		return { compacted: false, skipReason: "nothing_to_cut" };
	}

	let old = messages.slice(0, cut);
	let recent = messages.slice(cut);
	if (keepIndex >= 0) {
		old = messages.slice(0, cut).filter((_, i) => i !== keepIndex);
		recent = [messages[keepIndex], ...recent];
	}

	// Chain onto a prior summary instead of re-summarizing it.
	let previousSummary: string | undefined;
	const head = old[0];
	if (head && head.role === "compactionSummary") {
		previousSummary = head.summary;
		old = old.slice(1);
	}
	if (old.length === 0) {
		if (force) console.log(`[engine] forced compaction skipped: nothing new to summarize after previous summary (~${estimateTokensSafe(messages)} tokens)`);
		return { compacted: false, skipReason: "empty_head" };
	}

	const tokensBefore = estimateTokensSafe(messages);
	const result = await generateSummary(
		old,
		models,
		model,
		settings.reserveTokens,
		undefined,
		undefined,
		previousSummary,
		undefined,
		COMPACTION_SUMMARY_RETRY,
	);
	if (!result.ok) {
		console.warn("[engine] compaction summary failed:", result.error);
		return { compacted: false, skipReason: "summary_failed" };
	}
	agent.state.messages = [
		createCompactionSummaryMessage(result.value, tokensBefore, new Date().toISOString()),
		...recent.map(stripStaleUsage),
	];
	console.log(
		`[engine] compacted ${agent.sessionId ?? "?"}: ${old.length} turns → summary (~${tokensBefore} tokens before)`,
	);
	return { compacted: true };
}
