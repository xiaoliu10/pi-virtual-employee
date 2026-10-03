/**
 * Work-item window logic — pure functions, no I/O.
 *
 * A work item is mined from daily conversations, confirmed by an admin, then
 * worked by the employee across SELF-SCHEDULED windows: at the end of each
 * window the model declares via text markers whether the goal is done, it
 * needs a human, or when to check back next ("系统对账 08:00–09:30，我 09:40
 * 再查"). The scheduler only wakes an item at its declared time — frequency is
 * the model's judgement, never a fixed polling cadence (field direction
 * 2026-09-30: 不丢失任务、持续跟进、但不要高频轮询).
 *
 * Marker protocol (same style as scheduler/autonomous.ts):
 *   [[TASK_DONE]]                — goal fully met
 *   [[NEED_HUMAN]]: <question>   — blocked on a person / external resource
 *   [[NEXT_CHECK]]: <time> | <why> — self-scheduled follow-up
 * A missed/invalid marker or exhausted budget waits for explicit admin resume.
 * Follow-ups must be at least 15 minutes away; no fixed polling cadence.
 */
import { AUTONOMOUS_DONE_MARK, AUTONOMOUS_HUMAN_MARK } from "./autonomous.js";

export { AUTONOMOUS_DONE_MARK, AUTONOMOUS_HUMAN_MARK };
export const AUTONOMOUS_NEXT_CHECK_MARK = "[[NEXT_CHECK]]";

export type WorkItemStatus = "proposed" | "queued" | "working" | "waiting_human" | "scheduled" | "done" | "cancelled";

/** One working window's budget — deliberately small; items continue over time. */
export const DEFAULT_WINDOW_BUDGET = { maxTurns: 15, maxMinutes: 30 };
/** Minimum model-selected follow-up interval (reject, never silently clamp). */
export const MIN_NEXT_CHECK_MS = 15 * 60_000;

/**
 * True when two follow-up times are essentially "the same time tomorrow": a
 * 20–28h gap whose wall-clock slots differ by ≤45min. This is how a work item
 * degenerates into a de-facto cron (field 2026-10-02: 每天对账巡检 declared
 * 每天 16:30, indistinguishable from a scheduled task) — detectable WITHOUT
 * trusting the model to self-report.
 */
export function isSameDailySlot(prev: number, next: number): boolean {
	if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
	const gap = next - prev;
	if (gap < 20 * 3_600_000 || gap > 28 * 3_600_000) return false;
	const a = new Date(prev);
	const b = new Date(next);
	return Math.abs(a.getHours() * 60 + a.getMinutes() - (b.getHours() * 60 + b.getMinutes())) <= 45;
}

/** Streak counter for consecutive same-daily-slot follow-ups; anything else resets. */
export function nextRoutineStreak(prevAt: number | undefined, prevStreak: number, nextAt: number): number {
	return prevAt !== undefined && isSameDailySlot(prevAt, nextAt) ? prevStreak + 1 : 0;
}

export interface WorkWindowDecision {
	kind: "done" | "human" | "next_check" | "continue";
	question?: string;
	/** Parsed epoch ms for next_check decisions; undefined when unparseable. */
	nextCheckAt?: number;
	nextCheckReason?: string;
	text: string;
}

/** Strip markdown emphasis so "**[[NEED_HUMAN]]: …" still leads its line. */
function stripLineEmphasis(line: string): string {
	const stripped = line.replace(/^[\s>*_#`-]+/, "");
	const mark = ALL_MARKS.find((m) => stripped.startsWith(m));
	// Keep underscores INSIDE protocol names; only strip payload decoration.
	if (!mark) return stripped;
	const body = stripped.slice(mark.length)
		.replace(/\*\*|__|`/g, "")
		.replace(/^[*_]+/, "")
		.replace(/(^|[\s:：|])([*_])([^*_]+)\2(?=$|[\s|])/g, "$1$3")
		.replace(/[*_]+$/, "");
	return mark + body;
}

function markerLine(text: string, mark: string): { index: number; stripped: string } | undefined {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const stripped = stripLineEmphasis(lines[i]);
		if (stripped.startsWith(mark)) return { index: i, stripped };
	}
	return undefined;
}

function stripMarkerLines(text: string, marks: string[]): string {
	return text
		.split("\n")
		.filter((line) => !marks.some((m) => stripLineEmphasis(line).startsWith(m)))
		.join("\n")
		.trimEnd();
}

const ALL_MARKS = [AUTONOMOUS_DONE_MARK, AUTONOMOUS_HUMAN_MARK, AUTONOMOUS_NEXT_CHECK_MARK];

/**
 * Parse "HH:MM" (next occurrence), "<n>m"/"<n>h" relative, "明天HH:MM", or an
 * ISO-ish datetime. Explicit 明天 ALWAYS means tomorrow. Reject malformed,
 * impossible, past or <15-minute times (rather than silently scheduling them).
 */
export function parseNextCheck(raw: string, now = new Date()): number | undefined {
	const s = raw.trim();
	const valid = (at: number) => Number.isFinite(at) && at - now.getTime() >= MIN_NEXT_CHECK_MS ? at : undefined;
	const rel = /^(\d+)\s*(分钟|分|min|m|小时|h|时)$/i.exec(s);
	if (rel) {
		const unit = rel[2].toLowerCase();
		const minutes = Number(rel[1]) * (unit === "h" || unit === "小时" || unit === "时" ? 60 : 1);
		return valid(now.getTime() + minutes * 60_000);
	}
	const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(s);
	if (iso) {
		const [, y, m, d, h, min, sec] = iso;
		const days = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
		if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > days || Number(h) > 23 || Number(min) > 59 || Number(sec ?? 0) > 59) return undefined;
		return valid(Date.parse(s));
	}
	const time = /^(明天\s*)?(\d{1,2})(?:[:：](\d{2})|点(?:(\d{2})分?)?)$/.exec(s);
	if (!time) return undefined;
	const hour = Number(time[2]);
	const minute = Number(time[3] ?? time[4] ?? 0);
	if (hour > 23 || minute > 59) return undefined;
	const target = new Date(now);
	target.setHours(hour, minute, 0, 0);
	if (time[1] || target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
	return valid(target.getTime());
}

/** Classify a window's final reply (markers stripped from the pushed text). */
export function parseWindowReply(reply: string, now = new Date()): WorkWindowDecision {
	const done = markerLine(reply, AUTONOMOUS_DONE_MARK);
	const human = markerLine(reply, AUTONOMOUS_HUMAN_MARK);
	const next = markerLine(reply, AUTONOMOUS_NEXT_CHECK_MARK);
	// Precedence: a human question always stops the chain; done outranks a
	// self-scheduled check ("全部完成" beats "我本想明天再看一眼").
	if (human) {
		const raw = human.stripped.trim();
		const question = raw.startsWith(AUTONOMOUS_HUMAN_MARK)
			? raw.slice(AUTONOMOUS_HUMAN_MARK.length).replace(/^[:：\s]+/, "").trim()
			: "";
		return { kind: "human", question, text: stripMarkerLines(reply, ALL_MARKS) };
	}
	if (done) return { kind: "done", text: stripMarkerLines(reply, ALL_MARKS) };
	if (next) {
		const body = next.stripped.trim().slice(AUTONOMOUS_NEXT_CHECK_MARK.length).replace(/^[:：\s]+/, "");
		const [timePart, ...reasonParts] = body.split("|");
		const nextCheckAt = parseNextCheck(timePart ?? "", now);
		return {
			kind: "next_check",
			nextCheckAt,
			nextCheckReason: reasonParts.join("|").trim() || undefined,
			text: stripMarkerLines(reply, ALL_MARKS),
		};
	}
	return { kind: "continue", text: reply };
}

export interface WorkItemWindowContext {
	title: string;
	goal: string;
	conditions?: string | null;
	progress?: string | null;
	lessons?: string[] | null;
	turn: number;
	budget: { maxTurns: number; maxMinutes: number };
	/** The user's reply when resuming from waiting_human. */
	answer?: string;
	/** Previous self-declared follow-up, injected so the model judges rhythm
	 * with facts instead of re-declaring "明天同一时间" by default. */
	lastCheck?: { at: number; reason?: string | null; streak: number };
	/** True for a queued kickoff with no history/resume: the model must lay out
	 * a short follow-up plan before starting (field feedback 2026-10-02: the
	 * first window executed immediately without a plan). */
	firstWindow?: boolean;
}

// A true kickoff must plan before acting — and the plan must justify its own
// rhythm (field 2026-10-02: 自主任务的要素在于不定时，固定每天一次和定时任务没区别).
const FIRST_WINDOW_PLAN =
	"【首个窗口：先出跟进计划】给出简要计划再开始第一步：① 分几步完成目标；② 这件工作在一天里哪些时刻会有新信息可查（数据何时生成、批次何时跑完、何时出结果）——列出这些「观察点」及依据，并说明打算怎么覆盖它们（一天可以多次，例如 09:00 查昨日历史、12:30 查今日上午批次、15:00 查今日下午批次）；③ 有卡点的工作，计划里要写明「卡点找谁问、问什么」（不确定解决时间就通过 NEED_HUMAN 问清再定跟进）。计划写完即开始第一步，无需等待确认。";

/** System-side prefix for every window turn — goal, memory, budget, protocol. */
export function buildWorkWindowPrefix(ctx: WorkItemWindowContext): string {
	const memory: string[] = [];
	if (ctx.conditions?.trim()) memory.push(`【执行条件（务必遵守）】\n${ctx.conditions.trim()}`);
	if (ctx.progress?.trim()) memory.push(`【此前进展】\n${ctx.progress.trim()}`);
	if (ctx.lessons?.length) memory.push(`【踩坑记录（别再踩）】\n${ctx.lessons.map((l) => `- ${l}`).join("\n")}`);
	if (ctx.firstWindow && ctx.turn === 0) memory.push(FIRST_WINDOW_PLAN);
	const head = ctx.turn === 0 ? "【工作窗口开始】" : `【工作窗口继续 · 本窗第 ${ctx.turn + 1} 轮】`;
	const answerBlock = ctx.answer ? `\n用户对你上一轮问题的回复：${ctx.answer}\n` : "";
	const lastCheck = ctx.lastCheck
		? `\n【上次跟进】${new Date(ctx.lastCheck.at).toLocaleString("zh-CN", { hour12: false })}${ctx.lastCheck.reason ? `（${ctx.lastCheck.reason}）` : ""}\n`
		: "";
	// A repeated fixed daily slot means the item has degenerated into a cron.
	// Confront the model with the measured streak — do NOT rely on its judgement.
	const cadenceWarning = (ctx.lastCheck?.streak ?? 0) >= 2
		? `\n【节奏提示】你已连续 ${ctx.lastCheck!.streak} 次把这个观察点安排在相近的固定时间。如果这是因为该时刻确有新信息可查（如「09:00 前历史对账已生成」），写明依据后可以维持；但请确认你覆盖了今天所有的观察点（如 12:30/15:00），不要只查这一个。若这件工作每天只在这一处固定点查、且查了也不需要判断动作，可以考虑建议管理员转成定时任务，工作项留给需要判断力的跟进。\n`
		: "";
	const protocol = [
		`窗口规则：`,
		`- 本窗口最多 ${ctx.budget.maxTurns} 轮 / ${ctx.budget.maxMinutes} 分钟，请优先推进关键路径，并把重要发现写入进展/踩坑。超时、执行出错或到限仍无安全结束声明会暂停等管理员明确恢复，不自动重试。`,
		`- 目标全部完成 → 最后一行单独写 ${AUTONOMOUS_DONE_MARK}，上方给出成果总结。`,
		`- 需要人参与 / 需其他单位配合资源 / 权限不足 → 最后一行单独写 ${AUTONOMOUS_HUMAN_MARK}: 具体需要谁做什么。任务会暂停等人，不要空转。`,
		`- 本轮告一段落但目标未完成 → 最后一行单独写 ${AUTONOMOUS_NEXT_CHECK_MARK}: 下次跟进时间 | 原因。时间支持 30m/2h/14:30/明天09:40 等；至少距现在 15 分钟。下次时间完全由本次执行结果决定，不约定固定频率，一天可多次也可隔天：\n  · 有卡点（等第三方补数据、等对方处理、等资源）→ 不要盲目定时重试：如果不确定卡点何时解决，先写 ${AUTONOMOUS_HUMAN_MARK} 把问题抛出来问清楚（如「这个卡点大概什么时候能解决？」），按答复定下次时间；\n  · 时间常识：深夜/非工作时间对接方通常不会处理，把跟进推到对方可能处理的时间，不要空查；\n  · 按「观察点」安排：一天里哪些时刻会有新信息（数据生成、批次跑完、出结果）就在那些时刻查，一天可以多次（如 09:00 查昨日、12:30 查今日上午、15:00 查今日下午）；\n  · 发现异常可缩短间隔、提前再查；连续多轮全无异常且无新信息才拉长。时间必须写明依据，不要不加思考地默认「明天同一时间」。非法/过去/过近时间会暂停等管理员明确恢复。`,
		`- 工作过程中了解到执行条件（如「系统对账 08:00-09:30 自动跑，此时段勿手动对账」、依赖的单位/资源、账号权限边界）→ 立即用 manage_work 记录到条件里，后续窗口会带着这些条件工作。`,
		`- 踩过的坑（登录态、页面路径、接口 quirks）→ 用 manage_work 记录，别指望下次还记得。`,
		`- 无人值守：先检测登录状态再操作，登录过期直接 ${AUTONOMOUS_HUMAN_MARK} 说明，不要索要验证码。`,
	].join("\n");
	return `${head}\n【工作项】${ctx.title}\n【目标】${ctx.goal}\n${[...memory, protocol].join("\n\n")}\n${answerBlock}${lastCheck}${cadenceWarning}\n`;
}
