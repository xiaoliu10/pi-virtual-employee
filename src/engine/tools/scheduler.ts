/**
 * Scheduled-task tools. Registered when scheduler.enabled is on, so the
 * employee can create timed tasks in conversation (e.g. "每天早上9点查一下
 * 昨天的订单并汇报"). The scheduler (main process) fires each task at its cron
 * time, running the employee on the task prompt in a dedicated conversation.
 *
 * `cron` is a standard 5-field expression (minute hour day month weekday) in
 * local time, e.g. "0 9 * * *" = every day at 09:00, an every-30-minutes expr,
 * "0 9 * * 1" = every Monday 09:00.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { SchedulerService } from "../../scheduler/scheduler-service.js";

function fmtTime(ms: number | null): string {
	return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—";
}

export function createSchedulerTools(
	scheduler: SchedulerService,
	conversationId: string,
	origin: string,
): AgentTool[] {
	const create: AgentTool = {
		name: "create_scheduled_task",
		label: "创建定时任务",
		description:
			"创建一个定时任务：到点后系统会自动以你的身份执行 prompt（可用全部工具）并保存结果；如果任务是在钉钉群聊或单聊中创建，执行结果会主动推送回创建任务的原会话，无需用户手动查询。cron 为标准 5 字段（分 时 日 月 周，本地时间），如 \"0 9 * * *\"=每天9点、\"*/30 * * * *\"=每30分钟、\"0 9 * * 1\"=每周一9点。prompt 写清到点要做什么。",
		parameters: Type.Object({
			title: Type.String({ description: "任务简短标题，如「每日订单早报」" }),
			prompt: Type.String({ description: "到点要执行的指令，如「查询昨日所有订单状态并汇总异常」" }),
			cron: Type.String({ description: "5 字段 cron 表达式（本地时间），如 0 9 * * *" }),
		}),
		async execute(_id, params) {
			const p = params as { title: string; prompt: string; cron: string };
			try {
				scheduler.validateCron(p.cron);
			} catch (err) {
				return {
					content: [{ type: "text", text: `cron 表达式无效：${(err as Error).message}` }],
					details: { ok: false },
				};
			}
			const task = scheduler.create({
				title: p.title,
				prompt: p.prompt,
				cron: p.cron,
				conversationId,
				origin,
			});
			return {
				content: [
					{
						type: "text",
						text: conversationId.startsWith("dt:")
								? `已创建定时任务「${task.title}」。下次执行：${fmtTime(task.next_run_at)}。到点后我会自动执行，并把结果主动推送回当前${conversationId.startsWith("dt:group:") ? "群聊" : "单聊"}。`
								: `已创建定时任务「${task.title}」。下次执行：${fmtTime(task.next_run_at)}。到点后我会自动执行并把结果记入对话。`,
					},
				],
				details: { ok: true, id: task.id, nextRunAt: task.next_run_at },
			};
		},
	};

	const list: AgentTool = {
		name: "list_scheduled_tasks",
		label: "查看定时任务",
		description: "列出当前所有定时任务及其启用状态、cron、上次与下次执行时间。",
		parameters: Type.Object({}),
		async execute() {
			const rows = scheduler.list();
			if (rows.length === 0) {
				return { content: [{ type: "text", text: "当前没有任何定时任务。" }], details: { count: 0 } };
			}
			const lines = rows.map(
				(r, i) =>
					`${i + 1}. [${r.enabled ? "启用" : "停用"}] ${r.title}（id=${r.id}）\n   cron: ${r.cron}  下次: ${fmtTime(r.next_run_at)}  上次: ${fmtTime(r.last_run_at)}${r.last_status ? ` (${r.last_status})` : ""}`,
			);
			return {
				content: [{ type: "text", text: `共 ${rows.length} 个定时任务：\n${lines.join("\n")}` }],
				details: { count: rows.length },
			};
		},
	};

	const remove: AgentTool = {
		name: "delete_scheduled_task",
		label: "删除定时任务",
		description: "按 id 删除一个定时任务。删除前建议先用 list_scheduled_tasks 确认 id。",
		parameters: Type.Object({ id: Type.String({ description: "任务 id（来自 list）" }) }),
		async execute(_id, params) {
			scheduler.delete((params as { id: string }).id);
			return { content: [{ type: "text", text: "已删除该定时任务。" }], details: { ok: true } };
		},
	};

	const toggle: AgentTool = {
		name: "toggle_scheduled_task",
		label: "启停定时任务",
		description: "启用或停用一个定时任务（按 id）。",
		parameters: Type.Object({
			id: Type.String({ description: "任务 id（来自 list）" }),
			enabled: Type.Boolean({ description: "true=启用，false=停用" }),
		}),
		async execute(_id, params) {
			const p = params as { id: string; enabled: boolean };
			scheduler.setEnabled(p.id, p.enabled);
			return {
				content: [{ type: "text", text: `已${p.enabled ? "启用" : "停用"}该定时任务。` }],
				details: { ok: true, enabled: p.enabled },
			};
		},
	};

	return [create, list, remove, toggle];
}
