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

/** Fallback when a model reports no context window. */
const FALLBACK_CONTEXT_WINDOW = 128_000;

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
export async function maybeCompact(agent: Agent, models: Models, force = false): Promise<boolean> {
	const settings = DEFAULT_COMPACTION_SETTINGS;
	const messages = agent.state.messages;
	const model = agent.state.model;
	const contextWindow = model.contextWindow || FALLBACK_CONTEXT_WINDOW;
	if (!force && !shouldCompact(estimateContextTokens(messages).tokens, contextWindow, settings)) {
		return false;
	}

	// Cut point: walk back until the kept tail is roughly keepRecentTokens,
	// then advance to the next user turn so the tail starts on a turn boundary.
	let cut = messages.length;
	let kept = 0;
	while (cut > 0 && kept < settings.keepRecentTokens) {
		cut--;
		kept += estimateTokens(messages[cut]);
	}
	while (cut < messages.length && messages[cut].role !== "user") cut++;
	if (cut === 0 || cut === messages.length) return false;

	let old = messages.slice(0, cut);
	const recent = messages.slice(cut);

	// Chain onto a prior summary instead of re-summarizing it.
	let previousSummary: string | undefined;
	const head = old[0];
	if (head && head.role === "compactionSummary") {
		previousSummary = head.summary;
		old = old.slice(1);
	}
	if (old.length === 0) return false;

	const tokensBefore = estimateContextTokens(messages).tokens;
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
		return false;
	}
	agent.state.messages = [
		createCompactionSummaryMessage(result.value, tokensBefore, new Date().toISOString()),
		...recent,
	];
	console.log(
		`[engine] compacted ${agent.sessionId ?? "?"}: ${old.length} turns → summary (~${tokensBefore} tokens before)`,
	);
	return true;
}
