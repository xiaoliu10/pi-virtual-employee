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
import type { AssistantMessage, Models, TextContent, Usage } from "@earendil-works/pi-ai";
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
 * Last-resort shrink for when compaction cannot help (a single enormous tool
 * result, or a transcript too short to split). Keeps a recent tail starting on a
 * user turn and replaces the dropped head with an explicit note, so the model
 * knows history was cut instead of silently losing it.
 *
 * Returns how many messages were dropped, or null when nothing could be dropped
 * (already minimal) — the caller then gives up honestly rather than looping.
 */
export function truncateToFit(agent: Agent, targetTokens: number, now = new Date().toISOString()): number | null {
	const messages = agent.state.messages;
	if (messages.length <= 2) return null;
	let cut = messages.length;
	let kept = 0;
	while (cut > 0 && kept < targetTokens) {
		cut--;
		kept += estimateMessageTokens(messages[cut]);
	}
	// Start the kept tail on a user turn so the provider sees a clean turn order.
	while (cut < messages.length && messages[cut].role !== "user") cut++;
	if (cut === 0 || cut >= messages.length) return null;
	const dropped = cut;
	const before = estimateTokensSafe(messages);
	agent.state.messages = [
		createCompactionSummaryMessage(
			`（上下文超出模型上限，本次请求已丢弃更早的 ${dropped} 条消息以继续；完整历史仍可在会话记录中查看。）`,
			before,
			now,
		),
		...messages.slice(cut),
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
	const first = messages.find((m) => m.role === "user");
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
	if (!force && !shouldCompact(estimateTokensSafe(messages), contextWindow, settings)) {
		return { compacted: false, skipReason: "below_threshold" };
	}

	// Cut point: compaction never splits within a turn — see findCompactionCut.
	const cut = findCompactionCut(messages, settings.keepRecentTokens);
	if (cut === 0 || cut === messages.length) return { compacted: false, skipReason: "nothing_to_cut" };

	let old = messages.slice(0, cut);
	const recent = messages.slice(cut);

	// Chain onto a prior summary instead of re-summarizing it.
	let previousSummary: string | undefined;
	const head = old[0];
	if (head && head.role === "compactionSummary") {
		previousSummary = head.summary;
		old = old.slice(1);
	}
	if (old.length === 0) return { compacted: false, skipReason: "empty_head" };

	const tokensBefore = estimateTokensSafe(messages);
	const result = await generateSummary(
		old,
		models,
		model,
		settings.reserveTokens,
		undefined,
		undefined,
		previousSummary,
	);
	if (!result.ok) {
		console.warn("[engine] compaction summary failed:", result.error);
		return { compacted: false, skipReason: "summary_failed" };
	}
	agent.state.messages = [
		createCompactionSummaryMessage(result.value, tokensBefore, new Date().toISOString()),
		...recent,
	];
	console.log(
		`[engine] compacted ${agent.sessionId ?? "?"}: ${old.length} turns → summary (~${tokensBefore} tokens before)`,
	);
	return { compacted: true };
}
