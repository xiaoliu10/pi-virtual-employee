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
import type { ConfigStore } from "../../db/config-store.js";
import { requireConfirmedAdmin, type ActorContext } from "./admin.js";

function fmtTime(ms: number | null): string {
	return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—";
}

export function createSchedulerTools(
	scheduler: SchedulerService,
	conversationId: string,
	origin: string,
	config?: ConfigStore,
	resolveActor?: (conversationId: string) => ActorContext,
): AgentTool[] {
	const create: AgentTool = {
		name: "create_scheduled_task",
		label: "创建定时任务",
		description:
			"创建一个定时任务：到点后系统会自动以你的身份执行 prompt（可用全部工具）并保存结果；如果任务是在钉钉群聊或单聊中创建，执行结果会主动推送回创建任务的原会话，无需用户手动查询。cron 为标准 5 字段（分 时 日 月 周，本地时间），如 \"0 9 * * *\"=每天9点、\"*/30 * * * *\"=每30分钟、\"0 9 * * 1\"=每周一9点。prompt 写清到点要做什么。" +
			"注意：定时任务无人值守执行，若其 prompt 需要执行命令（run_command）等管理员受控操作，则任务必须由管理员在 IM 单聊中明确「确认」创建——创建者身份会被记录并在每次执行时实时校验；由普通用户或群聊创建的任务，到点后无法使用这些管理员工具。来自普通用户的此类创建请求应先说明需管理员确认。",
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
			// A task that may run admin-gated tools (run_command) unattended needs
			// a creator identity to re-attach at fire time. Only capture it from a
			// verified 1:1 admin chat WITH explicit confirmation — anyone else can
			// still create the task, but it runs without admin-gated tools.
			let createdBy: string | null = null;
			if (config && resolveActor) {
				const gate = requireConfirmedAdmin(
					{ config, resolveActor, conversationId },
					{ needConfirmation: true, confirmationHint: "该定时任务将无人值守执行。请确认任务内容，并在当前消息中包含「确认」。" },
				);
				if ("actor" in gate) createdBy = gate.actor.senderId;
			}
			const task = scheduler.create({
				title: p.title,
				prompt: p.prompt,
				cron: p.cron,
				conversationId,
				origin,
				createdBy,
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
				details: { ok: true, id: task.id, nextRunAt: task.next_run_at, createdBy },
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

	const authorize: AgentTool = {
		name: "authorize_scheduled_task",
		label: "授权定时任务",
		description:
			"给已有定时任务补记管理员创建者身份（仅限管理员在 IM 单聊中使用，且当前消息须明确包含「确认」）。" +
			"适用于任务创建时未记录身份（旧版本创建/控制台创建），导致无人值守无法执行 run_command 的情况——授权后无需删除重建，保留原 cron、prompt 与执行历史。" +
			"授权后任务的无人值守执行将以你（当前管理员）的身份实时校验白名单；若你日后被移出管理员名单，任务随即失去受控命令权限。",
		parameters: Type.Object({
			id: Type.String({ description: "任务 id（来自 list_scheduled_tasks）" }),
		}),
		async execute(_id, params) {
			const taskId = (params as { id: string }).id;
			if (!config || !resolveActor) {
				return { content: [{ type: "text", text: "当前会话不支持授权操作（需要在 IM 单聊中进行）。" }], details: { ok: false } };
			}
			// Same gate as creating an admin-backed task: verified 1:1 admin chat
			// WITH explicit confirmation in the current message.
			const gate = requireConfirmedAdmin(
				{ config, resolveActor, conversationId },
				{
					needConfirmation: true,
					confirmationHint:
						"授权后该定时任务将无人值守以你的管理员身份执行受控命令。请确认要授权的任务，并在当前消息中包含「确认」。",
				},
			);
			if ("content" in gate) return gate;
			const updated = scheduler.setCreatedBy(taskId, gate.actor.senderId);
			if (!updated) {
				return { content: [{ type: "text", text: `未找到 id 为 ${taskId} 的定时任务，请先用 list_scheduled_tasks 确认。` }], details: { ok: false } };
			}
			return {
				content: [
					{
						type: "text",
						text: `✅ 已授权定时任务「${updated.title}」：无人值守执行将以你的管理员身份校验，下次执行 ${fmtTime(updated.next_run_at)} 起可正常调用 run_command。`,
					},
				],
				details: { ok: true, id: updated.id, title: updated.title },
			};
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

	const updateTask: AgentTool = {
		name: "update_scheduled_task",
		label: "修改定时任务",
		description:
			"修改已有定时任务的标题 / 执行指令 / cron / 推送目标，无需删除重建（执行历史保留）。" +
			"改推送目标最常用的方式是 bindCurrent=true：在正确的群聊/单聊里调用，把任务的结果推送改绑到当前会话——" +
			"例如任务当初建错了群，现在在正确的群里改绑即可。只传想改的字段。",
		parameters: Type.Object({
			id: Type.String({ description: "任务 id（来自 list_scheduled_tasks）" }),
			title: Type.Optional(Type.String({ description: "新的任务标题" })),
			prompt: Type.Optional(Type.String({ description: "新的到点执行指令" })),
			cron: Type.Optional(Type.String({ description: "新的 5 字段 cron（本地时间），如 0 9 * * *" })),
			bindCurrent: Type.Optional(Type.Boolean({ description: "true=把推送目标改绑为当前会话" })),
		}),
		async execute(_toolCallId, params) {
			const p = params as { id: string; title?: string; prompt?: string; cron?: string; bindCurrent?: boolean };
			const patch: { title?: string; prompt?: string; cron?: string; conversationId?: string | null } = {};
			if (p.title !== undefined) patch.title = p.title;
			if (p.prompt !== undefined) patch.prompt = p.prompt;
			if (p.cron !== undefined) patch.cron = p.cron;
			if (p.bindCurrent) patch.conversationId = conversationId;
			if (Object.keys(patch).length === 0) {
				return { content: [{ type: "text", text: "没有给出任何要修改的字段（title / prompt / cron / bindCurrent）。" }], details: { ok: false } };
			}
			const updated = scheduler.update(p.id, patch);
			if (!updated) {
				const badCron = patch.cron !== undefined && p.cron !== undefined && !updated;
				return {
					content: [{ type: "text", text: badCron ? `cron 表达式无效：${p.cron}` : `未找到 id 为 ${p.id} 的定时任务，请先用 list_scheduled_tasks 确认。` }],
					details: { ok: false },
				};
			}
			const changes = [
				patch.title !== undefined ? "标题" : null,
				patch.prompt !== undefined ? "执行指令" : null,
				patch.cron !== undefined ? `cron（下次执行 ${fmtTime(updated.next_run_at)}）` : null,
				patch.conversationId !== undefined ? `推送目标→${patch.conversationId?.startsWith("dt:group:") ? "当前群聊" : "当前单聊"}` : null,
			].filter(Boolean) as string[];
			return {
				content: [{ type: "text", text: `✅ 已更新定时任务「${updated.title}」：${changes.join("、")}。执行历史保留，下次执行：${fmtTime(updated.next_run_at)}。` }],
				details: { ok: true, id: updated.id, nextRunAt: updated.next_run_at },
			};
		},
	};

	return [create, list, remove, toggle, authorize, updateTask];
}
