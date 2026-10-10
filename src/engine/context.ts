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
import type { AssistantMessage, RetryPolicy, TextContent, Usage } from "@earendil-works/pi-ai";
// pi 1.x moved the compaction primitives out of pi-agent-core into the
// coding-agent package; we vendor the needed subset (see pi-compaction.ts).
import {
	createCompactionSummaryMessage,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	generateSummary,
	shouldCompact,
} from "./pi-compaction.js";
// pi-agent-custom-messages.d.ts (ambient) re-registers the compactionSummary /
// branchSummary roles on AgentMessage via declaration merging.
import type { MessageRow } from "../db/history-store.js";
import { isCompactionTemplateReport } from "./progress.js";

/** Bound on persisted messages replayed into a fresh session. Older turns stay
 * visible in the UI; the transcript re-grows (and re-compacts) naturally. */
const REHYDRATE_MAX_MESSAGES = 40;

/** Fallback when a model reports no context window. 200k: modern mainstream
 * models are 128k–200k+, and the 0.2.68-era 128k guess mislabeled real-200k
 * relay models (litellm qwen), tripping the budget gate ~40k tokens too early
 * and then never compacting (field incident 2026-09-17). Relay/alias models
 * should now also set the per-model override in the settings UI. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/** Bounded retry for harness-side summarizer calls (compaction + heartbeat
 * progress brief). They run unattended, and without a policy a SINGLE transient
 * relay error failed the whole chain — field 2026-09-23: automatic compaction
 * had succeeded repeatedly, then one failed call chopped a long-running task.
 * 2 retries, 1s/2s backoff; deterministic errors still fail fast
 * (retryAssistantCall classifies them as non-retryable). */
export const SUMMARIZER_RETRY: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1_000 };

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
	// Preserve the transcript's ORIGINAL leading system message (the prompt
	// replay), not a getCurrentSystemMessage fold — the fold accumulates every
	// tool declaration into toolsAdded, and feeding that back makes the next
	// turn's tool-changes delta empty (declareToolChanges compares against the
	// tools the message already asserts), freezing skill/config tool updates.
	// Later section-update system messages are replay artifacts, not the prompt.
	const systemHead = agent.state.messages.find((m) => m.role === "system");
	const messages = agent.state.messages.filter((m) => m.role !== "system");
	if (messages.length <= 2) return null;
	const before = estimateTokensSafe(agent.state.messages);
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
		...(systemHead ? [systemHead] : []),
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
 * untouched. `signal` aborts the summarizer request itself (field
 * 2026-09-24: a hung compaction call had NO timeout and was INVISIBLE to the
 * stall watchdog — it bypasses makeStreamFn — so the turn's watchdog fired on
 * the silent tail and the completed reply was discarded); callers pass an
 * engine-owned signal so a black-holed relay request ends cleanly instead of
 * hanging the per-conversation queue.
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

/** The task anchor for progress reports: the LATEST real (non-synthetic) user
 * message — the request currently being executed. Field 2026-09-24: anchoring
 * on the FIRST user message made a long-lived IM conversation report a
 * days-old, long-completed task in the heartbeat while a new request ran.
 * During an in-flight turn the latest user message IS the current task. */
export function taskAnchorOf(messages: AgentMessage[]): AgentMessage | undefined {
	return messages.findLast((m) => m.role === "user" && !isSyntheticUserMessage(m));
}

/** Pure acknowledgments / steering-noise: quoting one back as the task reads
 * as nonsense (field 2026-09-30: "任务：确认。" when the admin replied 确认). */
const ACK_RE = /^(确认|确定|同意|收到|好的|好|行|可以|继续|ok|yes|对|嗯+)[!！。.，,、~～\s]*$/i;

// Scheduler-injected scaffolding glued onto stored user messages by the
// runners: tools/time.ts scheduledTimePrefix() prepends the fire-time block,
// and work windows (scheduler/work.ts buildWorkWindowPrefix) prepend a
// structured 【工作窗口开始】…【目标】… block. The heartbeat anchor must quote
// the REAL request, not scaffolding (field 2026-10-03: the deterministic
// fallback rendered 【系统注入的真实执行时间：…】 as the "current request").
const SCHEDULED_TIME_PREFIX_RE = /^【系统注入的真实执行时间：[^】]*】\s*/;
const WORK_WINDOW_HEAD_RE = /^【工作窗口(?:开始|继续[^】]*)】/;
// Autonomous chain scaffold (scheduler/autonomous.ts buildAutonomousTurnPrefix):
// turn 0 ends with the last protocol line; later turns end with their head.
// Keep these markers in sync with that builder.
const AUTONOMOUS_HEAD_RE = /^【自主任务模式】[\s\S]*?不要尝试索要验证码。\s*/;
const AUTONOMOUS_CONTINUE_RE = /^【自主任务模式 · [^】]*】/;

/** Strip runner-injected prompt scaffolding from a stored user message so
 * anchors quote the real request/task identity. Work-window turns carry task
 * identity inside the scaffold (【目标】/【自主任务】 lines) — that is what gets
 * returned; autonomous chain turns yield the task prompt after the protocol
 * block (later "继续。" turns then fall through the ack skip to the turn-0
 * message). May return "" when nothing identity-bearing remains. */
export function stripSyntheticPromptPrefix(raw: string): string {
	let text = raw.replace(SCHEDULED_TIME_PREFIX_RE, "").trim();
	if (AUTONOMOUS_HEAD_RE.test(text)) text = text.replace(AUTONOMOUS_HEAD_RE, "").trim();
	else if (AUTONOMOUS_CONTINUE_RE.test(text)) text = text.replace(AUTONOMOUS_CONTINUE_RE, "").trim();
	if (WORK_WINDOW_HEAD_RE.test(text)) {
		// [^\n] (not \s*\S) so an EMPTY goal line doesn't swallow the next
		// scaffold line — the 【自主任务】 fallback must stay reachable.
		const goal = /^【目标】[ \t]*([^\n]+?)[ \t]*$/m.exec(text)?.[1]?.trim();
		const item = /^【自主任务】[ \t]*([^\n]+?)[ \t]*$/m.exec(text)?.[1]?.trim();
		text = goal || item || "";
	}
	return text;
}

/** Latest real user message that actually carries task identity — pure acks
 * (确认/继续/好的…) and the synthetic finalSummary instruction are skipped.
 * Used by the heartbeat fallback so a substantial request is quoted instead of
 * an ack, without needing an LLM pass. */
/** Tail of the most recent ASSISTANT turn — real execution narration.
 * Used so a failed side-channel summary still tells the user what is actually
 * happening (field 2026-10-05: the fallback quoted only the task instruction,
 * not progress). Deliberately labeled "最近" by callers — never as the task
 * name (field 2026-09-23's leak was mislabeling narration as the task, not
 * showing it).
 *
 * A compaction summary rehydrated as a PLAIN assistant message is SKIPPED:
 * after an app restart the role-based filter misses it, and the raw tail
 * echoed "## Goal … ## Constraints …" verbatim as "recent progress" (field
 * 2026-10-09). The signature is judged on the RAW visible text (its headings
 * are line-anchored), the cut on the flattened text. Read-only: the live
 * transcript and the compaction protocol are untouched. */
export function lastAssistantTailOf(messages: AgentMessage[], maxChars = 80): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const visible = assistantVisibleText(message);
		const text = visible.replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (isCompactionTemplateText(visible)) continue;
		return text.length > maxChars ? "…" + text.slice(-maxChars) : text;
	}
	return "";
}

/** Visible text of the most recent assistant turns, chronological order,
 * skipping empty turns and rehydrated compaction-template echoes (same
 * signature/rationale as lastAssistantTailOf). Feeds the heartbeat fallback's
 * four-field extraction (progress.ts); bounded to the last `limit` qualifying
 * turns so a huge transcript cannot stall it. Pure: never mutates state. */
export function recentAssistantVisibleTexts(messages: AgentMessage[], limit = 8, stopAt?: AgentMessage): string[] {
	const out: string[] = [];
	for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
		const m = messages[i];
		// Evidence must come from the CURRENT task's execution: stop at the task
		// anchor so a previous task's "已完成：…卡点：无" report is never reused
		// for the new one (review M1 — cross-task progress reuse).
		if (stopAt && m === stopAt) break;
		if (m.role !== "assistant") continue;
		const visible = assistantVisibleText(m);
		const text = visible.replace(/\s+/g, " ").trim();
		if (!text || isCompactionTemplateText(visible)) continue;
		out.unshift(text);
	}
	return out;
}

export function substantialAnchorOf(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user" || isSyntheticUserMessage(message)) continue;
		const content = (message as { content?: unknown }).content;
		const raw = typeof content === "string"
			? content
			: Array.isArray(content)
				? (content as { type?: string; text?: string }[]).filter((part) => part?.type === "text").map((part) => part.text ?? "").join(" ")
				: "";
		const stripped = stripSyntheticPromptPrefix(raw);
		const text = stripped.replace(/\s+/g, "").trim();
		if (!text || text.length <= 2 || ACK_RE.test(text)) continue;
		return stripped.replace(/\s+/g, " ").trim();
	}
	return "";
}

const TRUNCATE_NOTE_PREFIX = "（上下文超出模型上限";

/**
 * Goal text for the heartbeat's content-free fallback. Deliberately NEVER
 * quotes user messages — field history is settled on that (2026-09-23: latest
 * narration leaked low-level mechanics; 2026-09-24: a mid-turn steering line
 * "如果图片不好识别可以换下一张…" got misquoted as the task name). But the
 * always-true empty line is ALSO unacceptable (2026-09-29: "这个过程汇报总结
 * 没有实质性的内容") — so the one remaining honest source is the chained
 * compaction summary: a curated task record, quoted only when every user
 * message has been compacted away. Two exclusions: the truncateToFit
 * discard-note records the cut, not the task; and the summary's structured
 * template ("## Goal …") is stripped rather than echoed (field 2026-09-25).
 */
export function heartbeatGoalOf(messages: AgentMessage[]): string {
	for (const m of messages) {
		if (m.role !== "compactionSummary") continue;
		const summary = String((m as { summary?: unknown }).summary ?? "").replace(/\s+/g, " ").trim();
		if (!summary || summary.startsWith(TRUNCATE_NOTE_PREFIX)) continue;
		const template = summary.match(/^##\s*Goal\b[:：]?\s*(.*?)(?:\s*##\s|$)/i);
		const goal = (template ? template[1] : summary).trim();
		if (goal) return goal;
	}
	return "";
}

/**
 * Signature of the harness compaction-summary template ("## Goal …\n## Constraints
 * & Preferences …"). After an app restart a compaction summary is rehydrated from
 * history as a PLAIN assistant message, so the role-based filter above misses it
 * and the heartbeat model echoes the English template verbatim as the "progress
 * report" (field 2026-10-09 screenshot: "## Goal 跟踪处理 … ## Constraints &
 * Preferences - 处理流程：…"). Both headings together are unambiguous — no real
 * assistant narration carries them. Note: \b holds at ASCII↔CJK boundaries, so
 * 「## Goal跟踪处理」 (no space) matches too — keep the \b.
 *
 * The canonical implementation is isCompactionTemplateReport in progress.ts
 * (review L: the signature existed in TWO modules and could drift apart —
 * progress.ts is the pure, dependency-free home; this alias keeps the
 * established context.ts API name for existing callers/tests).
 */
export const isCompactionTemplateText = isCompactionTemplateReport;

/** Visible text blocks only (no thinking/tool args) — template-signature checks
 * must judge what the USER would see (review L1). */
function assistantVisibleText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: string; text?: string }[])
		.filter((part) => part?.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

/**
 * Context for the heartbeat progress summary (field request 2026-09-17: the
 * raw latest-narration snippet read like "检查表格当前行状态" — no sense of
 * where the task actually is). The side-channel LLM call gets the CURRENT
 * request (the latest user message, see taskAnchorOf) plus a recent tail of
 * roughly `keepRecentTokens`, deduped when the tail already covers it.
 *
 * Historical summary messages (compaction / branch) are EXCLUDED: they carry
 * the harness's structured template ("## Goal …\n## Constraints & …"), and a
 * heartbeat model fed one echoed it verbatim as the "progress report" (field
 * 2026-09-25 screenshot). The anchor + execution tail carry everything needed.
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
	const tail = messages
		.slice(cut)
		.filter((m) => m.role !== "compactionSummary" && m.role !== "branchSummary")
		.filter((m) => m.role !== "assistant" || !isCompactionTemplateText(assistantVisibleText(m)));
	const anchor = taskAnchorOf(messages);
	if (anchor && !tail.some((m) => m === anchor)) return [anchor, ...tail];
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

export async function maybeCompact(
	agent: Agent,
	force = false,
	signal?: AbortSignal,
	streamFn?: import("./pi-compaction.js").StreamFn,
): Promise<CompactOutcome> {
	const settings = DEFAULT_COMPACTION_SETTINGS;
	// Same rationale as truncateToFit: keep the transcript's ORIGINAL system
	// message (never a getCurrentSystemMessage fold — it freezes tool updates).
	const systemHead = agent.state.messages.find((m) => m.role === "system");
	const messages = agent.state.messages.filter((m) => m.role !== "system");
	const model = agent.state.model;
	const contextWindow = model.contextWindow || FALLBACK_CONTEXT_WINDOW;
	// CJK-aware: pi's own estimate divides characters by 4, which under-counts a
	// Chinese transcript badly enough that compaction never fires (see
	// estimateTokensSafe). Overshooting only compacts a bit sooner.
	if (!force && !shouldCompact(estimateTokensSafe(agent.state.messages), usableContextWindow(contextWindow, model.maxTokens), settings)) {
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

	const tokensBefore = estimateTokensSafe(agent.state.messages);
	// pi 1.x: plain AbortSignal param (no chord Context), and the call now
	// THROWS instead of returning a Result. streamFn routes the summary through
	// the same LLM path as normal turns (custom suppliers/gateways included).
	try {
		const summary = await generateSummary(
			old,
			model,
			settings.reserveTokens,
			undefined,
			signal,
			undefined,
			previousSummary,
			undefined,
			streamFn,
			undefined,
			SUMMARIZER_RETRY,
			agent.sessionId,
		);
		// An aborted or empty summarization must never land as a "successful"
		// compaction: pi-ai's EventStream.result() RESOLVES an aborted turn as a
		// message with stopReason "aborted" and empty content, and upstream's
		// getSummarizationFailure only guards error/length — so an empty string
		// would otherwise replace the whole transcript (0.99.1 guarded this;
		// field class: the summary path re-tries forever afterwards because the
		// empty head keeps measuring over-budget). Leave the transcript intact
		// and report the honest skip reason.
		if (!summary.trim()) {
			console.warn("[engine] compaction summary was empty (aborted or blank response) — transcript kept");
			return { compacted: false, skipReason: "summary_failed" };
		}
		// previousSummary remains the first conversational message on re-compaction.
		agent.state.messages = [
			...(systemHead ? [systemHead] : []),
			createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString()),
			...recent.map(stripStaleUsage),
		];
	} catch (err) {
		console.warn("[engine] compaction summary failed:", err instanceof Error ? err.message : err);
		return { compacted: false, skipReason: "summary_failed" };
	}
	console.log(
		`[engine] compacted ${agent.sessionId ?? "?"}: ${old.length} turns → summary (~${tokensBefore} tokens before)`,
	);
	return { compacted: true };
}
