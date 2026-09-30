/**
 * Autonomous scheduled-task chaining — pure logic, no I/O.
 *
 * Field motivation (2026-09-30): a scheduled task fires ONE prompt → one
 * tool-loop turn, then stops. Long goals ("compile the month-end report and
 * verify each section") need many turns; today a human pushes the task along
 * one message at a time. Autonomous mode lets ONE fire keep working across
 * turns until the model declares the goal met, asks for a human, or the budget
 * runs out (then a "继续" reply resets the budget and resumes).
 *
 * The model signals via text markers on the FINAL line of its reply — zero
 * extra LLM cost per turn, deterministic parsing, and a missed marker is
 * bounded by the budget instead of looping forever. Markers use double square
 * brackets so ordinary prose can never collide with them.
 */

export const AUTONOMOUS_DONE_MARK = "[[TASK_DONE]]";
export const AUTONOMOUS_HUMAN_MARK = "[[NEED_HUMAN]]";

/** Persisted between fires (scheduled_tasks.chain_state JSON). */
export interface AutonomousChainState {
	/** The ONE conversation this chain works in (reused across its turns). */
	convId: string;
	/** Turns spent in the CURRENT budget window (reset on resume). */
	turns: number;
	/** Budget window start (ms epoch) — wall-clock budget measures from here. */
	startedAt: number;
	/** Why the chain last paused, waiting for a human. */
	pending?: "human" | "budget";
	/** The question asked, when pending === "human" (echoed on resume pushes). */
	question?: string;
	/** The user's reply, staged by resume and consumed on the next turn 0. */
	answer?: string;
}

export interface AutonomousBudget {
	maxTurns: number;
	maxMinutes: number;
}

export const DEFAULT_AUTONOMOUS_BUDGET: AutonomousBudget = { maxTurns: 20, maxMinutes: 120 };

/** Coerce untrusted config/store values into a sane budget (fallback defaults). */
export function normalizeBudget(maxTurns: unknown, maxMinutes: unknown): AutonomousBudget {
	const turns = Number(maxTurns);
	const minutes = Number(maxMinutes);
	return {
		maxTurns: Number.isFinite(turns) && turns >= 1 ? Math.min(Math.floor(turns), 200) : DEFAULT_AUTONOMOUS_BUDGET.maxTurns,
		maxMinutes: Number.isFinite(minutes) && minutes >= 1 ? Math.min(Math.floor(minutes), 24 * 60) : DEFAULT_AUTONOMOUS_BUDGET.maxMinutes,
	};
}

export function parseChainState(raw: string | null | undefined): AutonomousChainState | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as Partial<AutonomousChainState> | null;
		if (!v || typeof v.convId !== "string" || !v.convId) return null;
		return {
			convId: v.convId,
			turns: Number.isFinite(v.turns) ? Math.max(0, Math.floor(v.turns as number)) : 0,
			startedAt: Number.isFinite(v.startedAt) ? (v.startedAt as number) : Date.now(),
			pending: v.pending === "human" || v.pending === "budget" ? v.pending : undefined,
			question: typeof v.question === "string" ? v.question : undefined,
			answer: typeof v.answer === "string" ? v.answer : undefined,
		};
	} catch {
		return null;
	}
}

/** Strip markdown emphasis/bullet prefixes so "**[[NEED_HUMAN]]: …" still leads. */
function stripLineEmphasis(line: string): string {
	return line.replace(/^[\s>*_#-]+/, "");
}

/** Marker line detection — the marker must LEAD a line (tolerating markdown emphasis). */
function markerLineIndex(text: string, mark: string): number {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (stripLineEmphasis(lines[i]).startsWith(mark)) return i;
	}
	return -1;
}

/**
 * Classify a chain turn's final reply. `text` is the reply with any marker
 * lines stripped — safe to push to IM as-is.
 */
export function parseChainReply(reply: string): {
	kind: "done" | "human" | "continue";
	question?: string;
	text: string;
} {
	const doneIdx = markerLineIndex(reply, AUTONOMOUS_DONE_MARK);
	const humanIdx = markerLineIndex(reply, AUTONOMOUS_HUMAN_MARK);
	// A turn can't be both; NEED_HUMAN wins — asking a human always stops the chain.
	if (humanIdx >= 0 && (doneIdx < 0 || humanIdx > doneIdx)) {
		const raw = stripLineEmphasis(reply.split("\n")[humanIdx]).trim();
		const question = raw.startsWith(AUTONOMOUS_HUMAN_MARK)
			? raw.slice(AUTONOMOUS_HUMAN_MARK.length).replace(/^[:：\s]+/, "").trim()
			: "";
		return { kind: "human", question, text: stripMarkerLines(reply) };
	}
	if (doneIdx >= 0) return { kind: "done", text: stripMarkerLines(reply) };
	return { kind: "continue", text: reply };
}

function stripMarkerLines(text: string): string {
	return text
		.split("\n")
		.filter((line) => {
			const t = stripLineEmphasis(line);
			return !t.startsWith(AUTONOMOUS_DONE_MARK) && !t.startsWith(AUTONOMOUS_HUMAN_MARK);
		})
		.join("\n")
		.trimEnd();
}

/** Wall-clock budget for the current window. */
export function budgetExceeded(state: AutonomousChainState, budget: AutonomousBudget, now = Date.now()): boolean {
	return state.turns >= budget.maxTurns || now - state.startedAt >= budget.maxMinutes * 60_000;
}

/**
 * System-side prefix prepended to EVERY chain turn's user message (turn 0
 * carries the task prompt; later turns carry a continue instruction). Teaches
 * the marker protocol and the unattended stance — mirrors scheduledTimePrefix
 * but for goal-driven multi-turn work.
 */
export function buildAutonomousTurnPrefix(opts: {
	turn: number;
	budget: AutonomousBudget;
}): string {
	const head =
		opts.turn === 0
			? `【自主任务模式】这是一个多轮自主任务：你会连续工作多个回合直到达成目标，期间没有人逐条催你。`
			: `【自主任务模式 · 第 ${opts.turn + 1} 轮】目标尚未完成，请继续推进（不要重复已完成的工作，从上次停下的地方接着干）。`;
	const budgetLine = `预算：最多 ${opts.budget.maxTurns} 轮 / ${opts.budget.maxMinutes} 分钟，请高效推进，优先完成关键路径。`;
	const protocol = [
		`回合结束规则（必须遵守）：`,
		`- 目标已全部完成 → 回复最后一行单独写 ${AUTONOMOUS_DONE_MARK}，并在它上面给出成果总结。`,
		`- 卡住了必须问人（缺账号/权限/登录态失效等）→ 最后一行单独写 ${AUTONOMOUS_HUMAN_MARK}: 要问的问题。链条会暂停等人回复。`,
		`- 还没完成也不需要问人 → 正常输出进展即可，不要写任何标记，系统会让你继续。`,
		`- 无人值守：先检测登录状态再操作，登录过期直接 ${AUTONOMOUS_HUMAN_MARK} 说明，不要尝试索要验证码。`,
	].join("\n");
	return `${head}\n${budgetLine}\n${protocol}\n\n`;
}
