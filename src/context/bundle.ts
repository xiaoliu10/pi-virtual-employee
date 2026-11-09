/**
 * ContextBundle — what the model should see next turn, assembled from the ledger.
 *
 * The design's injection discipline (context-management.md, Inline & Spill):
 * inline the summary chain (the spill pointer form of old turns), a recent
 * verbatim window bounded by `keepRecentTokens`, and never more than
 * `budgetTokens` overall. Everything is measured with the CJK-aware estimator in
 * estimate.ts — the same accounting compactIfNeeded uses, so "over budget" means
 * the same thing in both places.
 *
 *  - It synthesizes usage-free assistant messages, so the transcript version's
 *    stale-usage floor (stripStaleUsage, field 2026-09-18/24) cannot occur here:
 *    a replayed row never carries the provider usage of the request that
 *    produced it.
 *
 * Pure read-side assembly: it never writes the ledger and never calls an LLM.
 * The summary rows it inlines were produced earlier by compactIfNeeded with the
 * caller-injected summarizer.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { estimateMessageTokens, estimateTextTokens } from "./estimate.js";
import { findCompactionCut } from "./compact.js";
import { isSummaryRecord, recordRole, recordText, type TurnRecord } from "./records.js";
import type { ContextStore } from "./store.js";

/** Next-turn context, in its final form before it enters the kernel. */
export interface ContextBundle {
	systemPrompt: string;
	/** Summary chain + recent verbatim window + tool digest lines. */
	messages: AgentMessage[];
	/** Person/group memory prefix, already relevance-trimmed by the caller. */
	memoryPrefix?: string;
	budget: { estimatedTokens: number; window: number };
}

export interface BuildBundleOptions {
	conversationId: string;
	systemPrompt: string;
	/** Verbatim tail budget, in estimated tokens (the cut shared with compactIfNeeded). */
	keepRecentTokens: number;
	/** Hard ceiling for prompt + memory + messages, e.g. `usableContextWindow(window, maxTokens)`. */
	budgetTokens: number;
	memoryPrefix?: string;
}

/**
 * Assemble the bundle for one conversation from its ledger partition.
 *
 * 1. Leading summary rows form the chain head — always inline, never trimmed.
 * 2. The verbatim window is cut by the SAME rule compaction uses
 *    (findCompactionCut), so a bundle after compaction and a bundle of a fresh
 *    ledger agree on where the recent window starts.
 * 3. If the result still exceeds `budgetTokens`, the oldest window rows are
 *    dropped WHOLE TURNS (chain head and newest turn survive — review P2-1,
 *    2026-11-09: row-by-row shedding could shed the newest turn's REQUEST and
 *    keep only its reply, a user-less bundle providers reject) — spending less
 *    context than the ceiling is always preferable to a rejected request.
 *    `budget.window` is the USABLE ceiling (already window − output reserve −
 *    non-ledger reserves as computed by the caller), not the raw model window.
 */
export function buildBundle(store: ContextStore, opts: BuildBundleOptions): ContextBundle {
	const records = store.listTurns(opts.conversationId);
	// Summary chain head (kept verbatim whatever the budget does).
	const head: TurnRecord[] = [];
	let at = 0;
	while (at < records.length && isSummaryRecord(records[at])) {
		head.push(records[at]);
		at++;
	}
	const body = records.slice(at);

	const cut = findCompactionCut(body, opts.keepRecentTokens);
	let start = cut;
	// The newest turn's request row: the shed loop may never drop past it.
	let lastUser = -1;
	for (let i = body.length - 1; i >= 0; i--) {
		if (recordRole(body[i]) === "user") { lastUser = i; break; }
	}
	let messages = recordsToMessages([...head, ...body.slice(start)]);
	let estimated = estimateBundleTokens(opts.systemPrompt, opts.memoryPrefix, messages);
	// Budget enforcement: drop WHOLE TURNS, never single rows — advancing by a
	// row could shed the newest turn's request and keep only its reply (a
	// user-less bundle gets provider-rejected; review P2-1 2026-11-09). Walk
	// `start` to the next user boundary, never past the newest request row, so
	// the window always opens on a request. The chain head never drops.
	// HONEST LIMIT: if even that minimal bundle exceeds the ceiling (an enormous
	// system prompt or memory prefix), the real estimate is reported instead of
	// pretending it fits — the caller decides what to do, we never lie.
	while (estimated > opts.budgetTokens && start < lastUser) {
		let next = start + 1;
		while (next < lastUser && recordRole(body[next]) !== "user") next += 1;
		start = next >= lastUser ? lastUser : next;
		messages = recordsToMessages([...head, ...body.slice(start)]);
		estimated = estimateBundleTokens(opts.systemPrompt, opts.memoryPrefix, messages);
	}
	return {
		systemPrompt: opts.systemPrompt,
		messages,
		memoryPrefix: opts.memoryPrefix,
		budget: { estimatedTokens: estimated, window: opts.budgetTokens },
	};
}

/** CJK-aware size of everything the bundle will inject. */
function estimateBundleTokens(systemPrompt: string, memoryPrefix: string | undefined, messages: AgentMessage[]): number {
	let tokens = estimateTextTokens(systemPrompt);
	if (memoryPrefix) tokens += estimateTextTokens(memoryPrefix);
	for (const m of messages) tokens += estimateMessageTokens(m);
	return tokens;
}

/**
 * Records → Agent transcript. Consecutive same-role rows merge (a request may be
 * followed by steering, a reply by tool digests) — providers reject consecutive
 * same-role messages, and engine's rehydrateMessages applies the same merge to
 * the very same end.
 *
 * Exported for the engine's WorkSession summarizer: compactIfNeeded's injected
 * `summarize` must feed the SAME representation assembly uses (one conversion,
 * never two) into pi's generateSummary.
 */
export function recordsToMessages(records: TurnRecord[]): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const record of records) {
		const text = recordText(record);
		if (!text.trim()) continue;
		const role = recordRole(record);
		const prev = out[out.length - 1];
		if (prev && prev.role === role) {
			if (role === "user") {
				(prev as { content: string }).content = `${prev.content as string}\n\n${text}`;
			} else {
				const content = (prev as AssistantMessage).content as TextContent[];
				content.push({ type: "text", text });
			}
			continue;
		}
		out.push(role === "user" ? { role: "user", content: text, timestamp: record.ts } : assistantMessage(text, record.ts));
	}
	return out;
}

/** A ledger reply replayed as a minimal assistant message. The api / provider /
 * model / usage fields are metadata only — request serialization is keyed off
 * the live model (same shape as engine/context.ts restoredAssistant). */
function assistantMessage(text: string, timestamp: number): AssistantMessage {
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

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
