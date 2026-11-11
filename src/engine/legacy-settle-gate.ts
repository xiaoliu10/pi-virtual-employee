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
 * Shape (mirrors the extension state machine, but the whole chain runs inside
 * ONE call because the legacy engine has no settle boundary to span):
 *   reply carries [[TASK_DONE]]
 *     → drive a verify turn (real tool re-check, emit VERIFY_PASS/FAIL)
 *   VERIFY_PASS with tool evidence → PASS THROUGH the original done claim
 *   VERIFY_FAIL / pass-without-evidence → repair turn → re-verify
 *   streak ≥ VERIFY_GIVE_UP → release: original claim + explicit ⚠️ report
 *
 * Two integration rules that differ from the other kernels BY NECESSITY
 * (review 3ff3d67d, both probe-reproduced):
 *  1. The delivered reply must KEEP its [[TASK_DONE]] marker line. Legacy
 *     schedulers grade completion by marker lines (work.ts parseWindowReply,
 *     autonomous.ts parseChainReply); the durable path does no marker parsing
 *     ("settle IS completion"). Replacing the reply with the verify text would
 *     grade "continue" → the window re-prompts → the model re-declares → the
 *     gate fires again → ping-pong until the budget burns out.
 *  2. The streak is LOCAL to one done-claim chain. A per-conversation counter
 *     leaks across independent runs (durable/ve-settle-gate.ts documents this
 *     exact bug as a reproduced finding) — and `work:<id>` conversations are
 *     reused across windows and tasks.
 *
 * Scope: ONLY replies that carry the [[TASK_DONE]] marker enter the gate.
 * Ordinary IM turns never write it (their prompt does not teach the marker
 * protocol), so the gate is a natural no-op for them — identical to the
 * extension's documented behaviour. Everything here is fail-open: a broken
 * verify turn must never wedge or swallow the original reply.
 */
import {
	AUTONOMOUS_DONE_MARK,
	judgeVerifyRound,
	settleReleaseReport,
	settleRepairInstruction,
	VERIFY_GIVE_UP,
} from "./durable/ve-settle-gate.js";

export { VERIFY_GIVE_UP, AUTONOMOUS_DONE_MARK };

/** The injected verify instruction (identical wording to the other two kernels). */
const SETTLE_VERIFY_PROMPT =
	"【收尾验证（系统强制，非走过场）】你声明任务已完成。放行前请验证一次：逐条对照目标，用工具重新核实当前真实状态，把看到的关键结果原样摘录（凭记忆复述不算证据）；最后单独写 [[VERIFY_PASS]] 或 [[VERIFY_FAIL]]: 哪条未达成。";

export interface LegacyGateResult {
	/** The reply that should be delivered and persisted. ALWAYS carries the
	 * original [[TASK_DONE]] marker line so the scheduler grades it terminal. */
	reply: string;
	/** Failed verification rounds consumed (0 = gate did not run / passed first try). */
	verifyRounds: number;
	/** True when the anti-deadloop cap released the turn with a ⚠️ report. */
	releasedAtCap: boolean;
}

export interface GateEligibility {
	kernel: string;
	ephemeral?: boolean;
	hardError?: string | null;
	deterministic?: boolean;
	capHit?: boolean;
	contextBudgetHit?: boolean;
	aborted?: boolean;
	narrationSuppressed?: boolean;
	narrationNoted?: boolean;
	undeliveredSteer?: boolean;
}

/**
 * Turn-level skip conditions, in one testable place. The gate must never
 * replace or outrank a system decision the turn already carries:
 *  - aborted: `agent.prompt` builds a FRESH AbortController, so a verify turn
 *    would resurrect a /stop-ed turn and burn budget post-abort (P1-2).
 *  - capHit / contextBudgetHit: the safety cap already fired; opening another
 *    tool loop is exactly what `finalSummary` structurally forbids (P2-1).
 *  - narrationSuppressed / narrationNoted: the narration guard already ruled
 *    this reply non-deliverable / notice-bearing (P3-1).
 *  - undeliveredSteer: the reply carries a ⚠️ steer notice a replacement
 *    would silently drop (P3-2).
 * Mirrors the narration guard's condition set (engine.ts) plus the two notices
 * that are appended between it and the gate.
 */
export function legacyGateEligible(g: GateEligibility): boolean {
	return g.kernel === "legacy"
		&& !g.ephemeral
		&& !g.hardError
		&& !g.deterministic
		&& !g.capHit
		&& !g.contextBudgetHit
		&& !g.aborted
		&& !g.narrationSuppressed
		&& !g.narrationNoted
		&& !g.undeliveredSteer;
}

/**
 * Release text = the ORIGINAL done claim (marker intact → the window
 * terminates instead of re-prompting) + the explicit ⚠️ report. The report is
 * honest about verification failing; the marker is what makes it terminal on
 * the legacy marker-grading pipeline. `parseWindowReply`/`parseChainReply`
 * strip marker lines from the pushed text, so the admin sees only the body
 * plus the warning — never a raw `[[TASK_DONE]]`.
 */
export function releaseReply(original: string, note: string): string {
	return `${original.trim()}\n\n${settleReleaseReport(note)}`;
}

/**
 * Stateless orchestrator (the chain is bounded inside one `run` call, so there
 * is nothing to persist). Kept as a class so the engine holds one instance and
 * a future config kill-switch has an obvious home.
 */
export class LegacySettleGate {
	/**
	 * Run the gate for one settled turn. Returns the original reply untouched
	 * when the gate does not apply (no TASK_DONE marker / disabled).
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
		if (!enabled || !reply.includes(AUTONOMOUS_DONE_MARK)) {
			return { reply, verifyRounds: 0, releasedAtCap: false };
		}

		// LOCAL streak: one run() == one done-claim chain. See rule 2 in the
		// header — persisting this per conversation releases an independent
		// later run at the cap after a SINGLE failed round.
		let streak = 0;
		try {
			for (;;) {
				const verify = await drive(SETTLE_VERIFY_PROMPT);
				const verdict = judgeVerifyRound(verify.text, verify.hadToolCalls, streak);

				if (verdict.action === "pass") {
					// PASS THROUGH (extension parity: "pass through — the task
					// settles"). The verify text is evidence for the gate, never
					// the deliverable: it lacks [[TASK_DONE]] and would be graded
					// "continue" by the legacy schedulers (P0-1), and a terse
					// marker-only verify reply would replace a substantive result
					// (P2-2).
					return { reply, verifyRounds: streak, releasedAtCap: false };
				}

				if (verdict.action === "release") {
					return { reply: releaseReply(reply, verdict.note), verifyRounds: VERIFY_GIVE_UP, releasedAtCap: true };
				}

				// repair: the model fixes the flagged gap, then the loop
				// re-verifies. Bounded — judgeVerifyRound releases once the
				// streak reaches VERIFY_GIVE_UP, so at most `giveUp` verify
				// drives and `giveUp - 1` repair drives.
				streak += 1; // == the streak judgeVerifyRound just applied
				await drive(settleRepairInstruction(verdict.note));
			}
		} catch (err) {
			// Fail-open: never let a verify failure swallow the original delivery.
			console.warn(`[settle-gate] legacy verify failed for ${conversationId}:`, err instanceof Error ? err.message : err);
			return { reply, verifyRounds: streak, releasedAtCap: false };
		}
	}
}
