/**
 * Legacy settle-gate — the engine-layer equivalent of the pi-session
 * `ve-settle-gate` extension, for conversations driven by the bare
 * pi-agent-core Agent (kernel = "legacy", the default).
 *
 * Why this exists: when the kernel matrix collapses toward the single
 * agent-core kernel (router-worker-core.md §0), the AgentSession extension
 * runtime that hosts `createVeSettleGateExtension` is gone. The evidence-round
 * self-verification it provided for autonomous/work turns must survive on the
 * legacy path as plain engine orchestration — same decision core, same
 * markers, same anti-deadloop cap.
 *
 * Shape (mirrors the extension state machine):
 *   reply carries [[TASK_DONE]]
 *     → run ONE verify turn (real tool re-check, emit VERIFY_PASS/FAIL)
 *   VERIFY_PASS with tool evidence → settle with the verified reply
 *   VERIFY_FAIL / pass-without-evidence → repair turn, then re-done → verify
 *   streak ≥ VERIFY_GIVE_UP → release with an explicit ⚠️ report (anti-loop)
 *
 * Scope: ONLY replies that carry the [[TASK_DONE]] marker enter the gate.
 * Ordinary IM turns never write it (their prompt does not teach the marker
 * protocol), so the gate is a natural no-op for them — identical to the
 * extension's documented behaviour. Everything here is fail-open: a broken
 * verify turn must never wedge or swallow the original reply.
 */
import {
	judgeVerifyRound,
	parseVerifyReply,
	settleReleaseReport,
	settleRepairInstruction,
	VERIFY_GIVE_UP,
} from "./durable/ve-settle-gate.js";

export { VERIFY_GIVE_UP };

/** The injected verify instruction (identical wording to the other two kernels). */
const SETTLE_VERIFY_PROMPT =
	"【收尾验证（系统强制，非走过场）】你声明任务已完成。放行前请验证一次：逐条对照目标，用工具重新核实当前真实状态，把看到的关键结果原样摘录（凭记忆复述不算证据）；最后单独写 [[VERIFY_PASS]] 或 [[VERIFY_FAIL]]: 哪条未达成。";

export interface LegacyGateResult {
	/** The reply that should be delivered and persisted. */
	reply: string;
	/** Consecutive failed verification rounds consumed (0 = gate did not run / passed first try). */
	verifyRounds: number;
	/** True when the anti-deadloop cap released the turn with a ⚠️ report. */
	releasedAtCap: boolean;
}

/** Per-conversation streak state (in-memory; same lifetime semantics as the
 *  extension's closure map — a process restart starts the streak fresh, which
 *  is safe because each run is independently verified). */
export class LegacySettleGate {
	private readonly streaks = new Map<string, number>();

	/**
	 * Run the gate for one settled turn. Returns the original reply untouched
	 * when the gate does not apply (no TASK_DONE marker / opted out).
	 *
	 * `drive` runs one additional model turn with the agent and returns its
	 * visible text together with whether the turn made any tool calls (the
	 * evidence requirement). The engine injects it (agent.prompt + event
	 * subscription) so this module stays free of SDK/stream plumbing.
	 */
	async run(opts: {
		conversationId: string;
		reply: string;
		enabled: boolean;
		drive: (instruction: string) => Promise<{ text: string; hadToolCalls: boolean }>;
	}): Promise<LegacyGateResult> {
		const { conversationId, reply, enabled, drive } = opts;
		const applies = enabled && reply.includes("[[TASK_DONE]]");
		if (!applies) {
			return { reply, verifyRounds: 0, releasedAtCap: false };
		}

		let streak = this.streaks.get(conversationId) ?? 0;
		const current = reply;
		try {
			// settle #1: done claim → one evidence verify turn.
			const verify = await drive(SETTLE_VERIFY_PROMPT);
			const verdict = judgeVerifyRound(verify.text, verify.hadToolCalls, streak);

			if (verdict.action === "pass") {
				this.streaks.delete(conversationId);
				// Keep the model's verified reply: prefer the verify text when it
				// carries a real answer, otherwise the original done reply.
				return { reply: verify.text.trim() || current, verifyRounds: streak, releasedAtCap: false };
			}

			if (verdict.action === "release") {
				this.streaks.delete(conversationId);
				return { reply: settleReleaseReport(verdict.note), verifyRounds: VERIFY_GIVE_UP, releasedAtCap: true };
			}

			// repair: one fix turn, then judge once inline. Bound the streak so a
			// model that never re-issues a usable marker cannot loop here.
			streak += 1;
			this.streaks.set(conversationId, streak);
			const repair = await drive(settleRepairInstruction(verdict.note));
			const repaired = repair.text.trim() || current;

			const afterRepair = parseVerifyReply(repaired);
			if (afterRepair.kind !== "none") {
				const second = judgeVerifyRound(repaired, repair.hadToolCalls, streak);
				if (second.action === "pass") {
					this.streaks.delete(conversationId);
					return { reply: repaired, verifyRounds: streak, releasedAtCap: false };
				}
				if (second.action === "release") {
					this.streaks.delete(conversationId);
					return { reply: settleReleaseReport(second.note), verifyRounds: VERIFY_GIVE_UP, releasedAtCap: true };
				}
			}
			return { reply: repaired, verifyRounds: streak, releasedAtCap: false };
		} catch (err) {
			// Fail-open: never let a verify failure swallow the original delivery.
			console.warn(`[settle-gate] legacy verify failed for ${conversationId}:`, err instanceof Error ? err.message : err);
			this.streaks.delete(conversationId);
			return { reply: current, verifyRounds: streak, releasedAtCap: false };
		}
	}

	/** Test seam / shutdown cleanup. */
	reset(conversationId?: string): void {
		if (conversationId) this.streaks.delete(conversationId);
		else this.streaks.clear();
	}
}
