import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

/** Beijing time (UTC+8), regardless of the host machine's timezone. */
export const BEIJING_TZ = "Asia/Shanghai";

/**
 * Current Beijing date/time parts, computed from the real clock every call.
 * `weekday` is 1..7 (Monday..Sunday), matching the user-facing ISO order.
 */
export function beijingNow(from: Date = new Date()): {
	date: string;
	time: string;
	datetime: string;
	weekday: number;
	weekdayName: string;
} {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: BEIJING_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		weekday: "short",
		hour12: false,
	}).formatToParts(from);
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
	const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
	const names: Record<string, string> = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };
	const wd = get("weekday");
	return {
		date: `${get("year")}-${get("month")}-${get("day")}`,
		time: `${get("hour")}:${get("minute")}:${get("second")}`,
		datetime: `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`,
		weekday: map[wd] ?? 0,
		weekdayName: names[wd] ?? wd,
	};
}

/**
 * Always-on clock tool. Reports titled "每日任务统计" ran on 2026-09-19
 * while the real Beijing date was 2026-09-18 — the model has no way to know the
 * real date and guessed wrong. Any date-sensitive task (yesterday, today,
 * weekly reports) must read the real time from here, never from memory.
 */
export function createCurrentTimeTool(): AgentTool {
	return {
		name: "get_current_time",
		label: "获取当前时间",
		description:
			"获取当前的真实日期与时间（北京时间，UTC+8）。凡是任务里出现「今天/昨天/明天/本周/本月/每日/当前」等时间词，或报告需要写日期标题时，必须先调用本工具取真实时间，禁止凭记忆或训练知识猜测日期。返回日期(YYYY-MM-DD)、时间、星期。",
		parameters: Type.Object({}),
		async execute() {
			const t = beijingNow();
			const text = `当前北京时间：${t.date} ${t.time}（${t.weekdayName}）。涉及日期的任务请以本时间为准（如「昨天」= ${t.date} 的前一天）。`;
			return {
				content: [{ type: "text", text }],
				details: { date: t.date, time: t.time, weekday: t.weekday, weekdayName: t.weekdayName, timezone: BEIJING_TZ },
			};
		},
	};
}

/** Prefix for scheduled-task prompts, stamping the REAL fire time (Beijing). */
export function scheduledTimePrefix(from: Date = new Date()): string {
	const t = beijingNow(from);
	return `【系统注入的真实执行时间：${t.date}（${t.weekdayName}）${t.time}，北京时间。报告中的日期、「昨天/今天」等时间口径一律以此为准，不要自行猜测日期。】\n\n`;
}
