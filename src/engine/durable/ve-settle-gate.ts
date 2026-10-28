/**
 * VE settle-gate as a DURABLE extension.
 *
 * Same decision core as `extensions/ve-settle-gate.ts` (evidence round, pass /
 * repair / anti-deadloop release); the difference is the boundary it hangs on:
 *
 *   legacy (AgentSession) : pi.on("agent_before_settle", ...) → mutate entries
 *   durable (Harness)     : GenerationTask.onYield(answer)     → { continue }
 *
 * `onYield` is documented as "continue the run with another user message", which
 * is exactly what the gate needs: the verify round and the repair round are each
 * "one more turn with an injected instruction". Verified in the probe
 * (`gate.mjs`): a [[TASK_DONE]] reply produced exactly 1 extra round, then the
 * task settled `done`.
 *
 * ── WHY THE STREAK IS NOT STORED ───────────────────────────────────────────
 * The legacy gate keeps `rounds` in a closure. Under durable that is wrong (it
 * dies with the process), but `HookApi` is READ-ONLY — no `commit`, and
 * `watchDoc()` returns a read handle, so a hook cannot persist a counter.
 * (`api.memo()` exists, but it is task-scoped and a later state commit overwrites
 * the task record — measured: the memo was gone after the following commit.)
 *
 * So the streak is DERIVED from state that durable already persists: every round
 * the gate injects starts with a fixed marker line, and those markers live in the
 * conversation transcript. Counting them gives the same anti-deadloop semantics
 * with zero extra writes, and it is automatically correct across a crash because
 * the transcript is the durable artifact.
 */
import { defineDoc, defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

export const VERIFY_GIVE_UP = 2;
export const AUTONOMOUS_VERIFY_PASS_MARK = "[[VERIFY_PASS]]";
export const AUTONOMOUS_VERIFY_FAIL_MARK = "[[VERIFY_FAIL]]";
export const AUTONOMOUS_DONE_MARK = "[[TASK_DONE]]";

/** First line of every injected verify instruction — the transcript marker we count. */
export const VERIFY_TURN_MARKER = "【收尾验证（系统强制，非走过场）】";
/** First line of every injected repair instruction — counts as a failed round too. */
export const REPAIR_TURN_MARKER = "上一轮收尾验证未通过";

export const SETTLE_VERIFY_PROMPT =
	`${VERIFY_TURN_MARKER}你声明任务已完成。放行前请验证一次：逐条对照目标，用工具重新核实当前真实状态，把看到的关键结果原样摘录（凭记忆复述不算证据）；最后单独写 [[VERIFY_PASS]] 或 [[VERIFY_FAIL]]: 哪条未达成。`;

/**
 * Anti-deadloop streak, persisted per conversation.
 *
 * A closure would die with the process; `api.memo()` is task-scoped AND a later
 * state commit overwrites the task record (measured: the memo was gone after the
 * next commit). A conversation document is the only store that survives a crash
 * and outlives one task — and `api.commit()` IS available inside a hook (measured:
 * 0→1→2 across two runs, written to storage).
 */
export interface SettleStreakDoc {
	[key: string]: number;
	rounds: number;
}

export const SettleStreakDocDef = defineDoc<SettleStreakDoc>({
	kind: "ve.settleStreak",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ rounds: 0 }),
	checkpointWhen: () => false,
});

// ── Decision core (shared semantics with extensions/ve-settle-gate.ts) ──

export type SettleAction = "pass" | "repair" | "release";
export interface SettleVerdict {
	action: SettleAction;
	note: string;
}

function stripLineEmphasis(line: string): string {
	return line.replace(/^[\s>*_#-]+/, "");
}

function markerLineIndex(text: string, marker: string): number {
	return text.split("\n").findIndex((line) => stripLineEmphasis(line).startsWith(marker));
}

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

export function judgeVerifyRound(
	reply: string,
	hadEvidence: boolean,
	prevStreak: number,
	giveUp = VERIFY_GIVE_UP,
): SettleVerdict {
	const verdict = parseVerifyReply(reply);
	if (verdict.kind === "pass" && hadEvidence) return { action: "pass", note: "" };
	const note = (verdict.kind === "fail"
		? verdict.note || "未达成"
		: verdict.kind === "pass"
			? "验证未包含实际核查动作（没有用工具重新核实）"
			: "验证轮没有给出明确结论").slice(0, 300);
	const streak = prevStreak + 1;
	if (streak >= giveUp) return { action: "release", note };
	return { action: "repair", note };
}

export function settleReleaseReport(note: string, giveUp = VERIFY_GIVE_UP): string {
	return `⚠️ 收尾验证连续 ${giveUp} 轮未通过，已按防死循环策略放行：${note}`;
}

export function settleRepairInstruction(note: string): string {
	return `${REPAIR_TURN_MARKER}：${note}。请针对未达成项继续修复，完成后重新声明完成。`;
}

// ── Message helpers ──

type ContentPart = { type?: string; text?: string };

export function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentPart[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}

export function turnHadToolCalls(message: { content?: unknown }): boolean {
	const content = message.content;
	if (!Array.isArray(content)) return false;
	return (content as ContentPart[]).some((p) => p.type === "toolCall");
}

// ── Durable extension ──

/**
 * The hook API's runtime surface is wider than its published type: measured
 * keys include `commit`, `conversation`, `now` and more, while `HookApi` in
 * 1.4.0 only declares read methods. Writing through `commit()` is verified to
 * work (0→1→2 persisted across runs), so the gate narrows the type here —
 * ONE place, with the evidence recorded — instead of casting at each call site.
 */
interface WritableHookApi {
	conversationId: never;
	commit<T>(change: (tx: { doc: (token: unknown, id: unknown) => Promise<SettleStreakDoc> }) => Promise<T>, context: unknown): Promise<T>;
	snapshot(token: unknown, id: unknown, context: unknown): Promise<SettleStreakDoc | undefined>;
}

const writable = (api: unknown): WritableHookApi => api as WritableHookApi;

export function createDurableSettleGate() {
	return defineExtension({
		name: "ve-settle-gate",
		hooks: [
			hook(GenerationTask, {
				onYield: async (answer, api, context) => {
					try {
						const text = messageText(answer);

						// settle #1: a done claim → ask for the evidence round.
						if (text.includes(AUTONOMOUS_DONE_MARK)) {
							return { continue: SETTLE_VERIFY_PROMPT };
						}

						// settle #2: a verify reply → judge, then pass / repair / release.
						if (
							text.includes(AUTONOMOUS_VERIFY_PASS_MARK) ||
							text.includes(AUTONOMOUS_VERIFY_FAIL_MARK)
						) {
							const w = writable(api);
							const prevStreak =
								(await w.snapshot(SettleStreakDocDef, api.conversationId, context))?.rounds ?? 0;
							const verdict = judgeVerifyRound(text, turnHadToolCalls(answer), prevStreak);
							const writeStreak = async (value: number): Promise<void> => {
								await w.commit(async (tx) => {
									(await tx.doc(SettleStreakDocDef, w.conversationId)).rounds = value;
								}, context);
							};
							if (verdict.action === "pass") {
								if (prevStreak > 0) await writeStreak(0); // next task starts clean
								return undefined; // settle: verified done
							}
							if (verdict.action === "release") {
								await writeStreak(0);
								// Release WITH the explicit warning, then settle (no more rounds).
								return { continue: settleReleaseReport(verdict.note) };
							}
							await writeStreak(prevStreak + 1); // survive a crash mid-repair
							return { continue: settleRepairInstruction(verdict.note) };
						}

						return undefined; // ordinary turn — settle
					} catch {
						// Fail-open: a broken gate must never wedge the conversation.
						return undefined;
					}
				},
			}),
		],
	});
}

