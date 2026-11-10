/**
 * CJK-aware token estimation — the ONE estimation accounting in VE.
 *
 * Moved here from `src/engine/context.ts` as the P1 "收编" step of the
 * router-worker design (§6.3): the durable kernel used to compact with pi's
 * chars÷4 estimator, which under-counts Chinese by 3–5×, so compaction fired far
 * too late — the exact bug the legacy layer had already fixed in 0.2.67
 * reappeared in the new kernel because the accounting lived inside each engine
 * instead of inside the context layer. Keeping the estimator next to the ledger
 * it measures is what makes "one accounting" structural rather than a
 * convention; `src/engine/context.ts` now re-exports from here so every existing
 * import path (and every existing test) keeps working unchanged.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// pi 1.x moved the compaction primitives out of pi-agent-core into the
// coding-agent package; we vendor the needed subset (see pi-compaction.ts).
import { estimateContextTokens, estimateTokens } from "../engine/pi-compaction.js";
import { recordText, type TurnRecord } from "./records.js";

/** Fallback when a model reports no context window. 200k: modern mainstream
 * models are 128k–200k+, and the 0.2.68-era 128k guess mislabeled real-200k
 * relay models (litellm qwen), tripping the budget gate ~40k tokens too early
 * and then never compacting (field incident 2026-09-17). Relay/alias models
 * should now also set the per-model override in the settings UI. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

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
	const images = countImageParts(message);
	// pi's estimator already charges a FLAT 1_200 tokens per image part
	// (ESTIMATED_IMAGE_CHARS=4800, ÷4) for user/system/toolResult messages — but
	// a desktop screenshot really costs ~5–15k vision tokens at the provider
	// (field 2026-11-10: ~30 frames measured 204_817 real tokens, i.e. ~6.8k a
	// frame, while this flat rate saw the same transcript as ~3.8k). Subtract
	// pi's flat baseline and replace it with the empirical rate below, so the
	// same block is never counted twice and image-heavy transcripts compact
	// before they hit the provider's hard limit.
	const piWithoutImages = Math.max(0, estimateTokens(message) - images * PI_IMAGE_BASELINE_TOKENS);
	return Math.max(estimateTextTokens(messageText(message)), piWithoutImages)
		+ images * VISION_TOKENS_PER_IMAGE;
}

/** pi-agent-core's flat per-image guess (ESTIMATED_IMAGE_CHARS 4800 ÷ 4). */
export const PI_IMAGE_BASELINE_TOKENS = 1_200;

/**
 * Vision-token cost assumed per image content part (field 2026-11-10, Nova:
 * an X11 screen-automation worker wedged at the provider's 204800 limit while
 * our estimate called the same transcript ~3.8k tokens — pi's flat 1_200 per
 * frame under-counted desktop screenshots ~6×, so compaction never fired and
 * every retry re-sent the whole ~200k vision payload; "forced compaction
 * skipped: nothing to cut" was logged because the measured tail looked tiny).
 *
 * 6_000 is the field-derived mid-range for a 1920x1080 desktop frame
 * (~6.8k measured). Over-counting only makes compaction fire a little earlier
 * — the safe direction, exactly as with the CJK rate above. Under-counting is
 * what wedged the box. The overflow recovery path additionally strips old
 * image parts outright (keepLastMessages), so an estimate that is still low
 * can never wedge the session again.
 */
export const VISION_TOKENS_PER_IMAGE = 6_000;

/** Image content parts in one message — the payload text estimation ignores. */
export function countImageParts(message: AgentMessage): number {
	// SAFETY: AgentMessage's content union is not narrowed in pi's public types
	// (toolResult/assistant messages carry heterogeneous block arrays at
	// runtime); read it as unknown and validate every block shape below.
	const content = (message as unknown as { content?: unknown }).content;
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const block of content as { type?: unknown; data?: unknown; mimeType?: unknown }[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "image" || (typeof block.data === "string" && typeof block.mimeType === "string")) n += 1;
	}
	return n;
}

/**
 * Same rule as estimateTokensSafe, for one ledger row — what the CJK-aware
 * budgets in bundle.ts / compact.ts measure.
 *
 * No `Math.max(…, pi's estimate)` here: for plain text the character rates
 * already dominate pi's chars÷4 (a CJK character counts 1, an ASCII run
 * ceil(n/4)), so this is an over-approximation on its own — the direction that
 * is safe, because under-counting is what starves the budget gates.
 */
export function estimateTurnTokens(record: TurnRecord): number {
	return estimateTextTokens(recordText(record));
}

/**
 * The shared core: CJK (and Hangul/Kana) at 1 token per character, everything
 * else at ~4 chars/token.
 */
export function estimateTextTokens(text: string): number {
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
	return cjk + Math.ceil(other / 4);
}

/** Flatten any message shape to its text (tool args/results included). */
export function messageText(message: AgentMessage): string {
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
