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
import { defineDoc, defineExtension, GenerationTask, LiveDoc, type HookApi, type Tx, hook } from "@earendil-works/pi-durable";

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
/**
 * Anti-deadloop streak, keyed by GENERATION TASK id.
 *
 * Keying it per conversation was wrong (review finding, reproduced on a real
 * Harness): task A ends with `rounds: 1`, then an independent task B in the same
 * conversation replies `[[VERIFY_FAIL]]` once and is immediately released as
 * "2 consecutive failures". The counter belongs to the run that is being
 * verified, and `api.taskId` names exactly that.
 *
 * The document stays per conversation (so a crash keeps it), while the map
 * inside separates runs. A finished run's entry is cleared on pass/release so
 * the document does not grow without bound.
 */
export interface SettleStreakDoc {
	[key: string]: number | Record<string, number>;
	/** taskId → consecutive failed verification rounds for that run. */
	runs: Record<string, number>;
}

export const SettleStreakDocDef = defineDoc<SettleStreakDoc>({
	kind: "ve.settleStreak",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ runs: {} as Record<string, number> }),
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

/**
 * Tool-evidence tracking per conversation.
 *
 * WHY THIS EXISTS (review blocker): `onYield` receives only the FINAL assistant
 * message, but a model that verifies with tools emits the tool call in a
 * PREVIOUS assistant message and then answers `[[VERIFY_PASS]]` in a later one.
 * Judging evidence from the final message therefore marks a genuinely
 * tool-verified round as "no evidence" — reproduced on a real Harness
 * (`answer 内 toolCall = false` while `read` had actually run).
 *
 * `afterTools` fires once per tool round, so it is the only correct source for
 * "did this run call a tool". The flag is per conversation and cleared when a
 * run settles (see onYield's pass/release paths), because the next task in the
 * same conversation must not inherit it.
 */
type ConversationKey = string | number;
const toolEvidence = new Map<ConversationKey, { anyTool: boolean }>();

function evidenceFor(conversationId: ConversationKey): { anyTool: boolean } {
	let entry = toolEvidence.get(conversationId);
	if (!entry) {
		entry = { anyTool: false };
		toolEvidence.set(conversationId, entry);
	}
	return entry;
}

/** Reset a conversation's evidence tracker (called when a run settles). */
export function resetToolEvidence(conversationId: ConversationKey): void {
	toolEvidence.delete(conversationId);
}

/**
 * Run-identity across the gate's own injections.
 *
 * MEASURED, not assumed: `{ continue }` spawns a NEW generation with a NEW
 * `api.taskId` (probed: one submit → one onYield; each injected round → fresh
 * id). Keying the streak by taskId therefore resets it every verify round and
 * the anti-deadloop release can never trigger. The stable run identity is the
 * INJECTION CHAIN: after this gate returns `{ continue }`, the next onYield in
 * the same conversation belongs to the same logical run, whatever its taskId.
 *
 * Crash trade-off (deliberate, fail-open): the map dies with the process, so a
 * run resumed mid-verify after a crash starts a fresh streak — it errs toward
 * MORE verification rounds, never toward a wrongful release, and the per-run
 * cap still applies within the resumed chain. Stale persisted entries from
 * crashed runs are pruned when a new run starts (see onYield).
 */
const expectingContinuation = new Map<ConversationKey, string>();

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
interface WritableHookApi extends HookApi {
	commit<T>(change: (tx: Tx) => Promise<T>, context: import("@earendil-works/chord/context").Context): Promise<T>;
}

/**
 * Narrow an unknown hook api to the writable surface, VERIFYING at runtime.
 *
 * TypeScript assertions are erase-only: if a future durable release renames or
 * removes `commit`, a bare `as` would make every write a no-op and the gate would
 * silently settle without recording a streak (review finding). Reporting the
 * capability once per process turns that silent degradation into a diagnosable
 * line in the log while keeping the gate fail-open (a broken gate must never
 * wedge a conversation).
 */
let capabilityWarned = false;

function writable(api: unknown): WritableHookApi | undefined {
	const candidate = api as Partial<WritableHookApi> | undefined;
	if (typeof candidate?.commit !== "function" || typeof candidate?.snapshot !== "function") {
		if (!capabilityWarned) {
			capabilityWarned = true;
			console.warn("[durable-settle-gate] hook api lacks commit()/snapshot() — streak will NOT be persisted");
		}
		return undefined;
	}
	return api as WritableHookApi;
}

export function createDurableSettleGate() {
	return defineExtension({
		name: "ve-settle-gate",
		hooks: [
			hook(GenerationTask, {
				// Record that this run performed a real tool round. onYield cannot see
				// these calls — they live in earlier assistant messages.
				afterTools: (_assistant, results, api) => {
					if (results.length > 0) evidenceFor(api.conversationId).anyTool = true;
				},
				onYield: async (answer, api, context) => {
					try {
						const text = messageText(answer);

						// settle #1: a done claim → ask for the evidence round.
						if (text.includes(AUTONOMOUS_DONE_MARK)) {
							expectingContinuation.set(api.conversationId, expectingContinuation.get(api.conversationId) ?? String(api.taskId));
							// Evidence must be earned DURING the verify round: tools used while
							// DOING the work are not proof the result was re-checked (review:
							// work-phase tools otherwise let a memory-only VERIFY_PASS through).
							// Also drops any residue from a run that died abnormally.
							resetToolEvidence(api.conversationId);
							return { continue: SETTLE_VERIFY_PROMPT };
						}
						// A plain reply (no markers) settles the run normally.
						if (!text.includes(AUTONOMOUS_VERIFY_PASS_MARK) && !text.includes(AUTONOMOUS_VERIFY_FAIL_MARK)) {
							expectingContinuation.delete(api.conversationId);
							resetToolEvidence(api.conversationId);
							return undefined;
						}

						// settle #2: a verify reply → judge, then pass / repair / release.
						if (
							text.includes(AUTONOMOUS_VERIFY_PASS_MARK) ||
							text.includes(AUTONOMOUS_VERIFY_FAIL_MARK)
						) {
							const w = writable(api);
							// Identity: an onYield right after our own injection continues the
							// SAME run; anything else is a new run (fresh key, prune stale).
							const live = await api.snapshot(LiveDoc, api.conversationId, context);
							// Submission ids remain stable when onYield hands off to a new
							// generation and when the process restarts.
							const runKey = live?.run?.inputs.join(",") ?? String(api.taskId);
							const continuedRunKey = runKey;
							const streakDoc = w ? await w.snapshot(SettleStreakDocDef, api.conversationId, context) : undefined;
							const prevStreak = streakDoc?.runs?.[runKey] ?? 0;
							if (!continuedRunKey && w && streakDoc && Object.keys(streakDoc.runs ?? {}).some((k) => k !== runKey)) {
								// A fresh run must not trip over entries left by crashed ones.
								await w.commit(async (tx) => {
									const doc = await tx.doc(SettleStreakDocDef, w.conversationId);
									for (const k of Object.keys(doc.runs ?? {})) {
										if (k !== runKey) delete doc.runs[k];
									}
								}, context);
							}
							// Evidence = this run called a tool at any point (afterTools), not
							// "the final message contains a toolCall" (it never does).
							const hadEvidence = evidenceFor(api.conversationId).anyTool;
							const verdict = judgeVerifyRound(text, hadEvidence, prevStreak);
							const writeStreak = async (value: number): Promise<void> => {
								if (!w) return; // capability already warned once at the call site
								await w.commit(async (tx) => {
									const target = await tx.doc(SettleStreakDocDef, w.conversationId);
									if (!target.runs) target.runs = {};
									if (value === 0) delete target.runs[runKey];
									else target.runs[runKey] = value;
								}, context);
							};
							if (verdict.action === "pass") {
								if (prevStreak > 0) await writeStreak(0); // next task starts clean
								resetToolEvidence(api.conversationId); // next task must re-earn evidence
								expectingContinuation.delete(api.conversationId);
								return undefined; // settle: verified done
							}
							if (verdict.action === "release") {
								await writeStreak(0); // drop THIS run's entry only
								resetToolEvidence(api.conversationId);
								expectingContinuation.set(api.conversationId, runKey); // the warning round is still this run
								// Release WITH the explicit warning, then settle (no more rounds).
								return { continue: settleReleaseReport(verdict.note) };
							}
							await writeStreak(prevStreak + 1); // survive a crash mid-repair
							expectingContinuation.set(api.conversationId, runKey);
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

