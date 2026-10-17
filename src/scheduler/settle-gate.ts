/**
 * Settle-verification gate — the shared decision core for BOTH unattended
 * finish paths (work-service windows and scheduled autonomous chains).
 *
 * Extracted 2026-10-16 after independent review found the two handwritten
 * copies diverging (chain missed the "release immediately on the 2nd
 * consecutive FAIL" rule that work-service had). The state machine and the
 * user-facing copy live HERE; the hosts keep only their own send/persistence
 * shells. Same pattern as pi-quality-gates' src/core: pure logic, no I/O,
 * no host imports beyond the marker protocol.
 */

import { parseVerifyReply, VERIFY_GIVE_UP } from "./autonomous.js";

export { VERIFY_GIVE_UP };

/** What the host's verification-round send returned. */
export interface VerifyRoundOutcome {
	reply: string;
	/** Tool calls made during the verify round — zero means nothing was
	 * re-checked, which counts as a FAIL even with a [[VERIFY_PASS]]. */
	toolCalls: number;
}

export type SettleGateAction = "pass" | "repair" | "release";

export interface SettleGateVerdict {
	action: SettleGateAction;
	/** Failure note (what was unmet) — empty on pass. */
	note: string;
	/** The streak value the host must persist: next failing streak on repair,
	 * 0 on pass AND on release (release clears the meter — the item settles). */
	streak: number;
}

/**
 * Judge one verification round. Single source of truth for:
 * - evidence check (PASS without tool calls is a FAIL — nothing was re-checked),
 * - FAIL-wins note extraction (delegated to parseVerifyReply),
 * - the anti-deadloop cap: the streak+1-th consecutive failure AT the cap
 *   releases immediately with an explicit report instead of looping.
 */
export function judgeVerifyRound(outcome: VerifyRoundOutcome, prevStreak: number, giveUp: number = VERIFY_GIVE_UP): SettleGateVerdict {
	const verdict = parseVerifyReply(outcome.reply);
	if (verdict.kind === "pass" && outcome.toolCalls > 0) return { action: "pass", note: "", streak: 0 };
	const note = (verdict.kind === "fail"
		? (verdict.note || "未达成")
		: verdict.kind === "pass"
			? "验证未包含实际核查动作（没有用工具重新核实）"
			: "验证轮没有给出明确结论").slice(0, 300);
	const streak = prevStreak + 1;
	if (streak >= giveUp) return { action: "release", note, streak: 0 };
	return { action: "repair", note, streak };
}

/** Done-push prefix when the gate releases at the cap — never a clean ✅. */
export function settleReleaseReport(note: string, giveUp: number = VERIFY_GIVE_UP): string {
	return `⚠️ 收尾验证连续 ${giveUp} 轮未通过，已按防死循环策略放行：${note}`;
}

/** The next turn's message after a failed verification round. */
export function settleRepairInstruction(note: string): string {
	return `上一轮收尾验证未通过：${note}。请针对未达成项继续修复，完成后重新声明完成。`;
}
