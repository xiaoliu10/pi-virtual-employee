/**
 * VE settle-gate inline extension — the evidence-round self-verification gate,
 * expressed as a pi AgentSession extension (re-delivered in plugin form after
 * the kernel migration, per the user's 2026-10-17 decision to close #84 and
 * port verify-gate to pi-quality-gates' extension architecture).
 *
 * Architecture: the gate's DECISION core (anti-deadloop streak + pass/repair/
 * release verdict + release-report copy) is shared with pi-quality-gates'
 * {@link SettleGateState} / {@link decideSettle}. The VERIFICATION MECHANISM
 * differs: pi-quality-gates runs deterministic shell commands (coding scene);
 * VE asks the model to re-check its goal with real tool reads and emit a
 * [[VERIFY_PASS]]/[[VERIFY_FAIL]] marker (autonomous tasks have no command).
 *
 * This is realized as a multi-boundary state machine on `agent_before_settle`:
 *   settle #1 (model wrote [[TASK_DONE]]):
 *     → inject buildSettleVerifyPrompt as a custom_message + continue:true
 *       (the session runs one more turn where the model verifies)
 *   settle #2 (model wrote [[VERIFY_PASS]] with tool evidence, or [[VERIFY_FAIL]]):
 *     → PASS: pass through (the task settles)
 *     → FAIL: decideSettle(streak+1) → repair: inject repair instruction +
 *       continue:true (the session runs a fix turn, then [[TASK_DONE]] again → #1)
 *     → streak ≥ VERIFY_GIVE_UP: release with an explicit ⚠️ report (anti-loop)
 *
 * The streak counter lives in this extension's closure (per session), matching
 * pi-quality-gates' SettleGateState semantics. When pi-quality-gates publishes
 * to npm, swap the vendored core below for `import { SettleGateState,
 * decideSettle } from "@earendil-works/pi-quality-gates"`.
 */

// ── Vendored decision core (mirrors pi-quality-gates src/core/settle.ts) ──
// MIT-licensed; converge to the published package once available.

/** Anti-deadloop cap: after this many consecutive FAILED verification rounds
 * the gate releases with an explicit report. The model is never told this
 * number — it would hand it an exit to aim for. */
export const VERIFY_GIVE_UP = 2;

export const AUTONOMOUS_VERIFY_PASS_MARK = "[[VERIFY_PASS]]";
export const AUTONOMOUS_VERIFY_FAIL_MARK = "[[VERIFY_FAIL]]";
export const AUTONOMOUS_DONE_MARK = "[[TASK_DONE]]";

interface SettleGateState {
	maxReworks: number;
	rounds: Map<string, number>;
	roundsFor(key: string): number;
	recordRework(key: string): number;
	reset(key: string): void;
}

function createSettleGateState(maxReworks = VERIFY_GIVE_UP): SettleGateState {
	const rounds = new Map<string, number>();
	return {
		maxReworks,
		rounds,
		roundsFor: (key) => rounds.get(key) ?? 0,
		recordRework: (key) => { const n = (rounds.get(key) ?? 0) + 1; rounds.set(key, n); return n; },
		reset: (key) => { rounds.delete(key); },
	};
}

type SettleAction = "pass" | "repair" | "release";
interface SettleVerdict { action: SettleAction; note: string; }

/** Judge a verification round: PASS needs tool evidence; FAIL wins; cap → release. */
function judgeVerifyRound(reply: string, hadEvidence: boolean, prevStreak: number, giveUp = VERIFY_GIVE_UP): SettleVerdict {
	const verdict = parseVerifyReply(reply);
	if (verdict.kind === "pass" && hadEvidence) return { action: "pass", note: "" };
	const note = (verdict.kind === "fail"
		? (verdict.note || "未达成")
		: verdict.kind === "pass"
			? "验证未包含实际核查动作（没有用工具重新核实）"
			: "验证轮没有给出明确结论").slice(0, 300);
	const streak = prevStreak + 1;
	if (streak >= giveUp) return { action: "release", note };
	return { action: "repair", note };
}

/** Done-push prefix when the gate releases at the cap — never a clean ✅. */
export function settleReleaseReport(note: string, giveUp = VERIFY_GIVE_UP): string {
	return `⚠️ 收尾验证连续 ${giveUp} 轮未通过，已按防死循环策略放行：${note}`;
}

/** The next turn's message after a failed verification round. */
export function settleRepairInstruction(note: string): string {
	return `上一轮收尾验证未通过：${note}。请针对未达成项继续修复，完成后重新声明完成。`;
}

// ── Marker parsing (mirrors VE autonomous.ts parseVerifyReply) ──

function stripLineEmphasis(line: string): string {
	return line.replace(/^[\s>*_#-]+/, "");
}

function markerLineIndex(text: string, marker: string): number {
	return text.split("\n").findIndex((line) => stripLineEmphasis(line).startsWith(marker));
}

/** Classify a verification round's reply. FAIL after PASS = FAIL (last-mark-wins);
 *  FAIL before PASS = pass (admitted failure then fixed). No marker = none. */
export function parseVerifyReply(reply: string): { kind: "pass" | "fail" | "none"; note?: string } {
	const failIdx = markerLineIndex(reply, AUTONOMOUS_VERIFY_FAIL_MARK);
	const passIdx = markerLineIndex(reply, AUTONOMOUS_VERIFY_PASS_MARK);
	if (failIdx >= 0 && (passIdx < 0 || failIdx > passIdx)) {
		const raw = stripLineEmphasis(reply.split("\n")[failIdx]).trim();
		const note = raw.startsWith(AUTONOMOUS_VERIFY_FAIL_MARK)
			? raw.slice(AUTONOMOUS_VERIFY_FAIL_MARK.length).replace(/^[:：\s]+/, "").trim()
			: "";
		return { kind: "fail", note };
	}
	if (passIdx >= 0) return { kind: "pass" };
	return { kind: "none" };
}

// ── Extension factory ──

/** Extract text from a message content block array (mirrors VE context.ts). */
function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("");
}

/** Did the assistant's turn make any tool calls? (evidence the verify round re-checked.) */
function turnHadToolCalls(message: { content?: unknown }): boolean {
	const content = message.content;
	if (!Array.isArray(content)) return false;
	return (content as Array<{ type?: string }>).some((p) => p.type === "toolCall");
}

/** The last assistant message in the context preview (or undefined). */
function lastAssistant(messages: ReadonlyArray<{ role: string; content?: unknown }>): { content?: unknown } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i];
	}
	return undefined;
}

export interface VeSettleGateOptions {
	/** Conversation key for the streak counter (default "default"). */
	conversationKey?: string;
	/** Disable the gate entirely. */
	disabled?: boolean;
}

/**
 * VE settle-gate as a pi inline extension factory. Load via session-host's
 * extensionFactories; the gate runs on every agent_before_settle boundary
 * (autonomous-task turns — ordinary IM turns declare [[TASK_DONE]] only when
 * the model genuinely believes the task is done, so the gate is naturally
 * no-op for non-task replies).
 */
export function createVeSettleGateExtension(options: VeSettleGateOptions = {}) {
	const key = options.conversationKey ?? "default";
	const disabled = options.disabled ?? false;
	return (pi: {
		on(event: string, handler: (event: unknown, ctx?: unknown) => unknown | Promise<unknown>): void;
	}): void => {
		if (disabled) return;
		const state = createSettleGateState();

		pi.on("agent_before_settle", async (rawEvent: unknown) => {
			try {
				const event = rawEvent as {
					context?: { contextMessages?: ReadonlyArray<{ role: string; content?: unknown }> };
				};
				const messages = event.context?.contextMessages;
				if (!messages?.length) return undefined;
				const last = lastAssistant(messages);
				if (!last) return undefined;
				const text = messageText(last);

				// settle #1: a done claim → inject the evidence-verify prompt + continue.
				if (text.includes(AUTONOMOUS_DONE_MARK)) {
					return {
						continue: true,
						entries: [{
							type: "custom_message",
							customType: "ve-settle-verify",
							content: "【收尾验证（系统强制，非走过场）】你声明任务已完成。放行前请验证一次：逐条对照目标，用工具重新核实当前真实状态，把看到的关键结果原样摘录（凭记忆复述不算证据）；最后单独写 [[VERIFY_PASS]] 或 [[VERIFY_FAIL]]: 哪条未达成。",
							display: true,
						}],
					};
				}

				// settle #2: a verify reply → judge + decide.
				if (text.includes(AUTONOMOUS_VERIFY_PASS_MARK) || text.includes(AUTONOMOUS_VERIFY_FAIL_MARK)) {
					const hadEvidence = turnHadToolCalls(last);
					const verdict = judgeVerifyRound(text, hadEvidence, state.roundsFor(key));
					if (verdict.action === "pass") {
						state.reset(key);
						return undefined; // settle — the task is verified done
					}
					if (verdict.action === "release") {
						// Anti-deadloop cap: release with the explicit report.
						const report = settleReleaseReport(verdict.note);
						state.reset(key);
						return {
							continue: false,
							entries: [{
								type: "custom_message",
								customType: "ve-settle-release",
								content: report,
								display: true,
							}],
						};
					}
					// repair: inject the failure note + continue (model fixes → [[TASK_DONE]] → #1).
					state.recordRework(key);
					return {
						continue: true,
						entries: [{
							type: "custom_message",
							customType: "ve-settle-repair",
							content: settleRepairInstruction(verdict.note),
							display: true,
						}],
					};
				}

				return undefined; // not a done claim nor a verify reply — ordinary turn, settle
			} catch {
				return undefined; // fail-open: a broken gate never wedges the host
			}
		});
	};
}
