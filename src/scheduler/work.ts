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
}

/** System-side prefix for every window turn — goal, memory, budget, protocol. */
export function buildWorkWindowPrefix(ctx: WorkItemWindowContext): string {
	const memory: string[] = [];
	if (ctx.conditions?.trim()) memory.push(`【执行条件（务必遵守）】\n${ctx.conditions.trim()}`);
	if (ctx.progress?.trim()) memory.push(`【此前进展】\n${ctx.progress.trim()}`);
	if (ctx.lessons?.length) memory.push(`【踩坑记录（别再踩）】\n${ctx.lessons.map((l) => `- ${l}`).join("\n")}`);
	const head = ctx.turn === 0 ? "【工作窗口开始】" : `【工作窗口继续 · 本窗第 ${ctx.turn + 1} 轮】`;
	const answerBlock = ctx.answer ? `\n用户对你上一轮问题的回复：${ctx.answer}\n` : "";
	const protocol = [
		`窗口规则：`,
		`- 本窗口最多 ${ctx.budget.maxTurns} 轮 / ${ctx.budget.maxMinutes} 分钟，请优先推进关键路径，并把重要发现写入进展/踩坑。超时、执行出错或到限仍无安全结束声明会暂停等管理员明确恢复，不自动重试。`,
		`- 目标全部完成 → 最后一行单独写 ${AUTONOMOUS_DONE_MARK}，上方给出成果总结。`,
		`- 需要人参与 / 需其他单位配合资源 / 权限不足 → 最后一行单独写 ${AUTONOMOUS_HUMAN_MARK}: 具体需要谁做什么。任务会暂停等人，不要空转。`,
		`- 本轮告一段落但目标未完成 → 最后一行单独写 ${AUTONOMOUS_NEXT_CHECK_MARK}: 下次跟进时间 | 原因。时间支持 30m/2h/14:30/明天09:40 等；至少距现在 15 分钟，禁止高频空跑。非法/过去/过近时间会暂停等管理员明确恢复。`,
		`- 工作过程中了解到执行条件（如「系统对账 08:00-09:30 自动跑，此时段勿手动对账」、依赖的单位/资源、账号权限边界）→ 立即用 manage_work 记录到条件里，后续窗口会带着这些条件工作。`,
		`- 踩过的坑（登录态、页面路径、接口 quirks）→ 用 manage_work 记录，别指望下次还记得。`,
		`- 无人值守：先检测登录状态再操作，登录过期直接 ${AUTONOMOUS_HUMAN_MARK} 说明，不要索要验证码。`,
	].join("\n");
	return `${head}\n【工作项】${ctx.title}\n【目标】${ctx.goal}\n${[...memory, protocol].join("\n\n")}\n${answerBlock}\n`;
}
