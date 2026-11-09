/**
 * WorkSession ⇄ CCL glue (P1 wiring, router-worker-core.md §6.4 / §11) — the
 * pure helpers the engine calls on the `work:<id>` turn path. Kept free of the
 * Agent SDK so the contracts are pinnable in tests without stubbing the kernel:
 *
 *  - what ONE tool telemetry event becomes in the ledger (a tool-digest draft),
 *  - what a work turn's request row preserves after scaffold stripping,
 *  - the diff compactIfNeeded produces as replaceHead params,
 *  - the ledger-only budget ceiling the wiring measures against.
 */
import { stripSyntheticPromptPrefix } from "./context.js";
import { estimateTextTokens, usableContextWindow } from "../context/estimate.js";
import { isWorkConversation } from "../context/records.js";
import type { ToolDigest, TurnRecord } from "../context/records.js";

export { isWorkConversation };

/** The telemetry event withTelemetry emits, plus the bounded briefs the tool
 * wrapper now collects (definition.ts). `argsBrief`/`resultBrief` are OPTIONAL:
 * an emitter that cannot produce them still yields a valid degraded digest
 * (name + cost + outcome), which is the collection floor the design allows. */
export interface WorkToolEvent {
	name: string;
	durationMs: number;
	ok: boolean;
	refused?: boolean;
	refusedCapability?: string;
	error?: string;
	argsBrief?: string;
	resultBrief?: string;
}

/**
 * One tool call → one tool-digest TurnRecord draft (no seq — appendNext
 * allocates it). `durationMs` is ALWAYS carried (design: a digest must have
 * name + cost + outcome, "足以重判现场"); the briefs degrade honestly when the
 * event could not carry them: the refusal kind and the error text are the next
 * best facts, "成功" is the last resort. Upgraded briefs come from the tool
 * wrapper layer (withTelemetry) — never from re-piercing individual tools.
 */
/** The degrade path below embeds raw error text — mask value shapes
 * (Bearer/URL tokens/PEM) before it reaches the permanent ledger. */
const DIGEST_ERROR_VALUE_RE = /(api[_-]?key|token|password|passwd|pwd|secret|credential)[=:：]\s*\S+|([Bb]earer)\s+\S+/g;

export function toolDigestDraft(conversationId: string, ts: number, event: WorkToolEvent): Omit<TurnRecord, "seq"> {
	const digest: ToolDigest = {
		name: event.name,
		argsBrief: event.argsBrief ?? "",
		resultBrief: event.resultBrief
			?? (event.ok
				? "成功"
				: event.refused
					? `权限拒绝（${event.refusedCapability ?? "?"}）`
					: `失败：${(event.error ?? "无错误信息").replace(DIGEST_ERROR_VALUE_RE, "$2 ***").slice(0, 200)}`),
		durationMs: event.durationMs,
	};
	return { conversationId, kind: "tool-digest", text: "", toolDigest: digest, ts };
}

/**
 * The request row's text for a work turn. The window prompt is runner
 * scaffolding (【工作窗口…】prefix blocks) around a one-line instruction; the
 * prefix is RE-SENT by every later window anyway, so replaying it per turn
 * would bloat the bundle — what the row keeps is the task identity the
 * scaffold carries (the 【目标】/【自主任务】 line) plus nothing else. Empty
 * strip → "继续。" so the row never renders as a blank user turn.
 */
export function workRequestText(message: string): string {
	const stripped = stripSyntheticPromptPrefix(message).replace(/\s+/g, " ").trim();
	return stripped || "继续。";
}

/**
 * The params for ContextStore.replaceHead, derived exactly as promised from
 * compactIfNeeded's output: `removeSeqs` = original rows missing from the
 * rebuilt list; `insertRecords` = rebuilt rows that are NEW objects. Identity
 * (not deep-equality) is the contract: compactIfNeeded reuses the kept row
 * objects verbatim, so any non-identical row is something to write.
 */
export function replaceHeadDiff(before: TurnRecord[], rebuilt: TurnRecord[]): { removeSeqs: number[]; insertRecords: TurnRecord[] } {
	const kept = new Set(rebuilt);
	return {
		removeSeqs: before.filter((record) => !kept.has(record)).map((record) => record.seq),
		insertRecords: rebuilt.filter((record) => !before.includes(record)),
	};
}

/**
 * Non-ledger injections that ride the same request but no TurnRecord measures:
 * the work-window prefix (re-injected every turn), the live-turn memory block,
 * and the tool declarations. Subtracted from the usable window before the
 * ledger budget is computed (compactIfNeeded measures LEDGER ROWS ONLY — its
 * own comment says the caller owns this subtraction).
 */
export const WORK_LEDGER_RESERVE_TOKENS = 24_000;

/** The ledger-only ceiling for one work:<id> partition: usable window minus the
 * system prompt and the non-ledger reserves. Floored so a tiny window still
 * assembles a chain-head + newest-turn bundle instead of nothing. */
export function workLedgerBudgetTokens(systemPrompt: string, contextWindow: number, maxTokens?: number): number {
	const usable = usableContextWindow(contextWindow, maxTokens) - estimateTextTokens(systemPrompt) - WORK_LEDGER_RESERVE_TOKENS;
	return Math.max(8_000, usable);
}
