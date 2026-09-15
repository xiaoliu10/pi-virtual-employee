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
import { maskId, isSchedulerActor, requireConfirmedAdmin, type ActorContext } from "./admin.js";
import { resolveRole } from "../../security/permissions.js";

function fmtTime(ms: number | null): string {
	return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—";
}

/**
 * Where a task was created, relative to the conversation asking now.
 * Authorization deliberately has no origin restriction — a group-created task is
 * authorized from a 1:1 chat, that is the whole point. But creation is open to
 * anyone, and authorizing attaches the ADMIN's identity, so "created elsewhere"
 * (i.e. possibly someone else's wording) is worth showing before that happens.
 */
function createdIn(
	task: { conversation_id: string | null },
	currentConversationId: string,
): { label: string; mine: boolean } {
	const id = task.conversation_id;
	if (!id) return { label: "控制台/旧版本", mine: false };
	if (id === currentConversationId) return { label: "本会话", mine: true };
	if (id.startsWith("dt:group:")) return { label: `群聊 ${maskId(id)}`, mine: false };
	if (/^(dt|feishu|wecom|echo):/.test(id)) return { label: `IM 会话 ${maskId(id)}`, mine: false };
	return { label: `其它会话 ${maskId(id)}`, mine: false };
}

export function createSchedulerTools(
	scheduler: SchedulerService,
	conversationId: string,
	origin: string,
	config?: ConfigStore,
	resolveActor?: (conversationId: string) => ActorContext,
): AgentTool[] {
	/**
	 * How a task's unattended identity reads to an admin. The role is resolved
	 * LIVE, because that is exactly how the task will run: with its creator's
	 * *current* role. A demoted creator is therefore called out explicitly — that
	 * is the silent case where a task quietly loses its abilities.
	 */
	const identityLabel = (task: { created_by: string | null }): string => {
		if (!task.created_by) {
			return "未记录（控制台/旧版本创建）——无人值守只能用对话与知识库；如需授权，管理员可在单聊里用 authorize_scheduled_task 补上";
		}
		const role = config ? resolveRole(config, task.created_by) : "unknown";
		const tail = role === "viewer" ? "，⚠️ 创建人已被降为 viewer，该任务现在只能对话与知识库" : "";
		return `跟随创建人 ${maskId(task.created_by)}（当前 ${role}）${tail}`;
	};

	const create: AgentTool = {
		name: "create_scheduled_task",
		label: "创建定时任务",
		description:
			"创建一个定时任务：到点后系统会自动执行 prompt 并保存结果；如果任务是在钉钉群聊或单聊中创建，执行结果会主动推送回创建任务的原会话，无需用户手动查询。cron 为标准 5 字段（分 时 日 月 周，本地时间），如 \"0 9 * * *\"=每天9点、\"*/30 * * * *\"=每30分钟、\"0 9 * * 1\"=每周一9点。prompt 写清到点要做什么。" +
			"**任务默认跟随创建人的权限**：不论在单聊还是群聊里创建，系统都会记录创建人（平台验证的身份），到点执行时以创建人**当前**的角色判定——创建人能用什么工具，任务就能用什么（operator 可用浏览器/文件/白名单命令，admin 才有完整命令与系统设置）。创建人被降权或移出管理员后，任务立即跟着失去相应能力，不需要删任务重建。" +
			"因此：不要向对方索要任何 ID；也不要声称群聊里创建的任务需要另外授权——那是不对的。任务创建本身需要 operator 及以上角色（会受会话门槛约束）。",
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
			// Identity: the platform-verified sender of THIS request, whatever the chat
			// type. A task may never exceed its creator's role, so attaching their own
			// id is not an elevation — it is the definition of "任务跟随创建人权限".
			// A scheduler actor is excluded so a task cannot spawn further tasks
			// unattended (creation stays an interactive act).
			let createdBy: string | null = null;
			if (resolveActor) {
				const actor = resolveActor(conversationId);
				if (actor?.senderId && !isSchedulerActor(actor)) createdBy = actor.senderId;
			}
			const task = scheduler.create({
				title: p.title,
				prompt: p.prompt,
				cron: p.cron,
				conversationId,
				origin,
				createdBy,
			});
			const creatorRole = createdBy && config ? resolveRole(config, createdBy) : undefined;
			return {
				content: [
					{
						type: "text",
						text: conversationId.startsWith("dt:")
								? `已创建定时任务「${task.title}」。下次执行：${fmtTime(task.next_run_at)}。到点后我会自动执行，并把结果主动推送回当前${conversationId.startsWith("dt:group:") ? "群聊" : "单聊"}。`
								: `已创建定时任务「${task.title}」。下次执行：${fmtTime(task.next_run_at)}。到点后我会自动执行并把结果记入对话。`,
					},
					...(createdBy
						? [{
								type: "text" as const,
								text: (() => {
									const role = creatorRole ?? "viewer";
									const scope = role === "admin"
										? "完整命令、系统设置与其它管理工具"
										: role === "operator"
											? "浏览器、文件系统、文档、定时任务、白名单内的命令"
											: "仅对话与知识库";
									return `该任务**跟随创建人的权限**：以 ${maskId(createdBy)}（当前 ${role}）的身份无人值守执行，可用范围是${scope}。你的角色被调整后它会立即跟着变，无需重建。`;
								})(),
							}]
						: [{
								type: "text" as const,
								text: "⚠️ 本次创建没有平台验证的发送者身份（本机控制台/HTTP 调用）：任务到点只能对话与查知识库。如需受控能力，请管理员在单聊里用 authorize_scheduled_task 补授权。",
							}]),
				],
				details: { ok: true, id: task.id, nextRunAt: task.next_run_at, createdBy },
			};
		},
	};

	const list: AgentTool = {
		name: "list_scheduled_tasks",
		label: "查看定时任务",
		description:
			"列出当前所有定时任务及其启用状态、cron、上次与下次执行时间、创建来源，以及**无人值守执行身份**。" +
			"执行身份＝创建人当前的角色（任务跟随创建人权限）；显示「未记录」的只有控制台/旧版本创建的任务，那些才需要用 authorize_scheduled_task 补授权。创建人被降权时这里会警告。",
		parameters: Type.Object({}),
		async execute() {
			const rows = scheduler.list();
			if (rows.length === 0) {
				return { content: [{ type: "text", text: "当前没有任何定时任务。" }], details: { count: 0 } };
			}
			const pending = rows.filter((r) => !r.created_by).length;
			const lines = rows.map(
				(r, i) =>
					`${i + 1}. [${r.enabled ? "启用" : "停用"}] ${r.title}（id=${r.id}）\n   cron: ${r.cron}  下次: ${fmtTime(r.next_run_at)}  上次: ${fmtTime(r.last_run_at)}${r.last_status ? ` (${r.last_status})` : ""}\n   创建于: ${createdIn(r, conversationId).label}\n   执行身份: ${identityLabel(r)}`,
			);
			return {
				content: [{
					type: "text",
					text:
						`共 ${rows.length} 个定时任务：\n${lines.join("\n")}` +
						(pending
							? `\n其中 ${pending} 个**没有执行身份**（控制台/旧版本创建的遗留任务）：它们到点只能用对话与知识库。若确认内容没问题，可让管理员在单聊里说「给所有定时任务授权，确认」一次性补上（无需删除重建）。`
							: ""),
				}],
				details: { count: rows.length, unauthorized: pending },
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
			"给已有定时任务补记创建者身份（仅限管理员在 IM 单聊中使用，且当前消息须明确包含「确认」）。" +
			"**只用于修复没有执行身份的遗留任务**（控制台创建、旧版本创建的）。自本版本起，任务在单聊或群聊中创建都会自动记录创建人身份并跟随其权限，**不需要也不应该再单独授权**；如果别人说「群里的任务要授权」，先核对是不是遗留任务，不要把它当成常规流程。" +
			"授权动作必须在管理员单聊里做（被授权的任务不受来源限制，群任务也能在此修好），结果推送目标（原群/原单聊）不变，且**无需删除重建**——原 cron、prompt 与执行历史全部保留。" +
			"传 id 授权单个；传 all=true 一次授权**所有尚未授权的任务**（管理员自己建的任务批量补授权用这个，不必逐个来）。" +
			"授权后任务以你（当前管理员）的身份执行，每次开跑前实时重新校验：你被移出管理员名单，任务立即失去受控权限。",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "要授权的任务 id（来自 list_scheduled_tasks）；用 all=true 时省略" })),
			all: Type.Optional(Type.Boolean({ description: "true=授权当前所有未授权的任务" })),
		}),
		async execute(_id, params) {
			const { id, all } = params as { id?: string; all?: boolean };
			let taskId = (id ?? "").trim();
			if (!all && !taskId) {
				const pending = scheduler.list().filter((r) => !r.created_by);
				// Resolve-or-ask, same rule as people/group names: a single candidate is
				// unambiguous, so "给定时任务授权" with exactly one pending task just
				// works (the admin has already confirmed). Several candidates → ask.
				if (pending.length === 1) {
					taskId = pending[0].id;
				} else {
					return {
						content: [{
							type: "text",
							text: pending.length
								? `有 ${pending.length} 个任务没有执行身份，请说明要给哪一个授权（id），或传 all=true 一次授权全部：\n${pending.map((r) => `  · ${r.title}（id=${r.id}，创建于${createdIn(r, conversationId).label}）`).join("\n")}`
								: "没有需要授权的任务：所有定时任务都已带执行身份。",
						}],
						details: { ok: false, unauthorized: pending.length },
					};
				}
			}
			if (!config || !resolveActor) {
				return { content: [{ type: "text", text: "当前会话不支持授权操作（需要在 IM 单聊中进行）。" }], details: { ok: false } };
			}
			// Same gate as creating an admin-backed task: verified 1:1 admin chat
			// WITH explicit confirmation in the current message. One confirmation
			// covers the whole batch — the risk being accepted (these prompts will
			// run unattended with the admin's identity) is identical per task.
			const gate = requireConfirmedAdmin(
				{ config, resolveActor, conversationId },
				{
					needConfirmation: true,
					confirmationHint: all
						? "授权后所有未授权的定时任务都将无人值守以你的管理员身份执行。请确认，并在当前消息中包含「确认」。"
						: "授权后该定时任务将无人值守以你的管理员身份执行受控命令。请确认要授权的任务，并在当前消息中包含「确认」。",
				},
			);
			if ("content" in gate) return gate;
			const actorId = gate.actor.senderId;

			if (all) {
				const pending = scheduler.list().filter((r) => !r.created_by);
				const done: string[] = [];
				const elsewhere: string[] = [];
				for (const row of pending) {
					const updated = scheduler.setCreatedBy(row.id, actorId);
					if (!updated) continue;
					done.push(updated.title);
					if (!createdIn(updated, conversationId).mine) elsewhere.push(`${updated.title}（${createdIn(updated, conversationId).label}）`);
				}
				if (done.length === 0) {
					return { content: [{ type: "text", text: "没有需要授权的任务：所有定时任务都已带执行身份。" }], details: { ok: true, authorized: 0 } };
				}
				return {
					content: [{
						type: "text",
						text:
							`✅ 已授权全部 ${done.length} 个未授权的定时任务（以后以你的身份执行）：${done.join("、")}。` +
							`cron、prompt 与执行历史均未改动；从现在起它们到点可用命令/浏览器/文件等受控工具。` +
							(elsewhere.length
								? `\n\n⚠️ 其中 ${elsewhere.length} 个不是在当前会话创建的：${elsewhere.join("、")}。任何人在群里都能让机器人建任务，而授权等于把你的管理员身份交给该任务的 prompt —— 请确认这些任务的内容是你认可的；不认可的用 update_scheduled_task 改掉 prompt，或直接删掉。`
								: ""),
					}],
					details: { ok: true, authorized: done.length, titles: done, authorizedElsewhere: elsewhere.length },
				};
			}

			const updated = scheduler.setCreatedBy(taskId, actorId);
			if (!updated) {
				return { content: [{ type: "text", text: `未找到 id 为 ${taskId} 的定时任务，请先用 list_scheduled_tasks 确认。` }], details: { ok: false } };
			}
			return {
				content: [{
					type: "text",
					text: `✅ 已授权定时任务「${updated.title}」：无人值守执行将以你的管理员身份校验，下次执行 ${fmtTime(updated.next_run_at)} 起可正常调用受控工具。`,
				}],
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
