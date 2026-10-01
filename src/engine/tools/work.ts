/** Source-scoped work administration and scheduler-only working memory. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { WorkItemStore } from "../../db/work-item-store.js";
import type { ConfigStore } from "../../db/config-store.js";
import { isExplicitConfirmation, type ActorContext } from "./admin.js";
import { resolveRole } from "../../security/permissions.js";

function fmtTime(ms: number | null): string {
	return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—";
}

const STATUS_LABEL: Record<string, string> = {
	proposed: "待确认提案",
	queued: "已确认待开工",
	working: "执行中",
	waiting_human: "等待管理员确认继续",
	scheduled: "按计划跟进",
	done: "已完成",
	cancelled: "已取消",
};

// InboundActor.channel uses the adapter name, not the conversation prefix.
const IM_PREFIX: Readonly<Record<string, string>> = {
	dingtalk: "dt:",
	feishu: "feishu:",
	wecom: "wecom:",
	echo: "echo:",
};

type VerifiedActor = NonNullable<ActorContext>;

function verifiedIMActor(actor: ActorContext, conversationId: string): actor is VerifiedActor {
	if (!actor || typeof actor.senderId !== "string" || !actor.senderId.trim()) return false;
	if (actor.chatType !== "single" && actor.chatType !== "group") return false;
	if (typeof actor.channel !== "string" || !Object.hasOwn(IM_PREFIX, actor.channel)) return false;
	const prefix = IM_PREFIX[actor.channel];
	return !!prefix && conversationId.startsWith(prefix) && conversationId.length > prefix.length;
}

/** Defaults never grant unattended work authority; a named admin must still be admin live. */
function currentAdmin(config: ConfigStore, senderId: string): boolean {
	const security = config.all().security;
	const declared = security.adminStaffIds.includes(senderId) ||
		security.people?.some((person) => person.staffId === senderId && person.role === "admin");
	return !!declared && resolveRole(config, senderId) === "admin";
}

function failure(reason: string) {
	return {
		content: [{ type: "text" as const, text: `⛔ ${reason}` }],
		details: { ok: false, refused: true, reason },
	};
}

function lessonsOf(raw: string | null): string[] {
	try {
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

export function createWorkTools(deps: {
	workItems: WorkItemStore;
	/** False means the persisted queued item will be picked up by the runner later. */
	fireItem: (id: string) => boolean;
	/** Optional immediate executor abort. The runner must also honor persisted cancellation. */
	cancelItem?: (id: string) => void | Promise<void>;
	/** Mining delivers proposals to their source conversations, never creates confirmed work. */
	mine: (opts: { maxProposals?: number }) => Promise<{ proposals: { title: string; goal: string; evidence: string; conditions: string; originConversation: string | null; id: string }[]; scanned: number; error?: string }>;
	config: ConfigStore;
	resolveActor: (conversationId: string) => ActorContext;
	conversationId: string;
}): AgentTool[] {
	const { workItems, fireItem, mine, config, resolveActor, conversationId } = deps;

	// Unlike the shared settings/admin gate, work confirmation is valid in its
	// source group too. Identity comes only from verified inbound metadata.
	function adminGate(actor: ActorContext, needConfirmation: boolean) {
		if (!verifiedIMActor(actor, conversationId)) {
			return failure("工作项管理需要来源 IM 单聊或群聊中经过平台验证的发送者身份；定时任务和无身份会话不能确认或恢复工作。");
		}
		if (!currentAdmin(config, actor.senderId)) return failure("此操作需要当前管理员权限，创建人或默认角色不能代替管理员授权。");
		if (needConfirmation && (typeof actor.text !== "string" || !isExplicitConfirmation(actor.text))) {
			return failure("请管理员在任务来源会话的当前消息中明确确认（例如「确认创建」或「确认继续」）；资源或人工阻塞必须确认后才能继续。");
		}
		return { actor };
	}

	const manageWork: AgentTool = {
		name: "manage_work",
		label: "工作项笔记",
		description:
			"仅在当前自主任务的 work:<id> 工作窗口内记录信息；需要该任务创建管理员的有效调度身份且任务正在执行。" +
			"action=set_conditions：记录执行条件/时间窗/依赖；action=add_lesson：记录踩坑；action=set_progress：更新进展。" +
			"这些信息会跨窗口保留。资源或人工阻塞应等待来源会话的管理员确认继续，不要通过笔记自行恢复。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("set_conditions"), Type.Literal("add_lesson"), Type.Literal("set_progress")]),
			content: Type.String({ description: "要记录的内容，简明具体" }),
		}),
		async execute(_toolCallId, params) {
			const p = params as { action: "set_conditions" | "add_lesson" | "set_progress"; content: string };
			const itemId = conversationId.startsWith("work:") ? conversationId.slice(5) : "";
			if (!itemId) return failure("manage_work 只能在对应自主任务的工作会话（work:<id>）中使用。");
			const actor = resolveActor(conversationId);
			if (!actor || actor.channel !== "scheduler" || actor.chatType !== "single" ||
				typeof actor.senderId !== "string" || !actor.senderId.trim()) {
				return failure("工作笔记需要经过验证的任务调度身份。");
			}
			const item = workItems.get(itemId);
			if (!item || item.status !== "working" || !item.created_by || actor.senderId !== item.created_by ||
				!currentAdmin(config, item.created_by)) {
				return failure("只能记录当前正在执行的工作项，且调度身份必须匹配仍有管理员权限的创建人。");
			}
			if (!["set_conditions", "add_lesson", "set_progress"].includes(p.action)) return failure("未知的笔记操作。");
			const content = typeof p.content === "string" ? p.content.trim() : "";
			if (!content) return failure("内容不能为空。");
			const updated = p.action === "add_lesson"
				? workItems.addLesson(itemId, content)
				: workItems.setField(itemId, p.action, content);
			if (!updated) return failure("记录失败，工作项可能已停止。");
			const label = p.action === "set_conditions" ? "执行条件" : p.action === "add_lesson" ? "踩坑记录" : "进展";
			return {
				content: [{ type: "text", text: `已记录到工作项「${item.title}」的${label}（共 ${lessonsOf(updated.lessons).length} 条踩坑）。` }],
				details: { ok: true },
			};
		},
	};

	const manageItems: AgentTool = {
		name: "manage_work_items",
		label: "自主工作项",
		description:
			"管理从对话挖掘、由管理员确认的自主工作项。所有查询和变更均限任务来源会话（单聊或群聊），不得跨会话透露私有任务。" +
			"action=list：列出当前来源会话的工作项；action=get：查看完整目标、执行条件、进展、踩坑和待答问题；" +
			"action=mine：管理员扫描近期对话并把待确认提案推送到各自来源会话；" +
			"action=confirm：来源会话的管理员在当前消息明确「确认创建」后开工；" +
			"action=resume：来源会话的管理员明确「确认继续」后恢复等待人工/资源的任务，answer 持久化为下一轮输入；" +
			"action=cancel：来源会话的管理员取消未完成任务。id 可用 list 中的唯一短前缀，歧义时必须提供完整 id。",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"), Type.Literal("get"), Type.Literal("mine"),
				Type.Literal("confirm"), Type.Literal("resume"), Type.Literal("cancel"),
			]),
			id: Type.Optional(Type.String({ description: "工作项完整 id 或当前来源会话内唯一的短前缀（list 里取）" })),
			answer: Type.Optional(Type.String({ description: "resume 时对暂停问题的答复，先持久化再排队执行" })),
		}),
		async execute(_toolCallId, params) {
			const p = params as { action: "list" | "get" | "mine" | "confirm" | "resume" | "cancel"; id?: string; answer?: string };
			if (!["list", "get", "mine", "confirm", "resume", "cancel"].includes(p.action)) return failure("未知的工作项操作。");
			const actor = resolveActor(conversationId);
			if (!verifiedIMActor(actor, conversationId)) return failure("请在经过平台验证的任务来源 IM 单聊或群聊中管理工作项。");
			if (p.action !== "list" && p.action !== "get") {
				const gate = adminGate(actor, p.action === "confirm" || p.action === "resume");
				if ("content" in gate) return gate;
			}

			if (p.action === "mine") {
				const result = await mine({ maxProposals: 3 });
				if (result.error) return failure(`挖掘失败：${result.error}`);
				// Even an admin may be speaking in a group: don't echo other DMs'
				// proposal titles/evidence here. Mining itself pushes to each source.
				const local = result.proposals.filter((proposal) => proposal.originConversation === conversationId);
				const lines = local.map((proposal) => `- ${proposal.id} 「${proposal.title}」`);
				return {
					content: [{ type: "text", text: `扫描了 ${result.scanned} 个近期会话，提案已分别推送到各自来源会话等待管理员确认。当前会话 ${local.length} 个提案${lines.length ? `：\n${lines.join("\n")}` : "。"}\n管理员须在提案来源会话回复「确认创建」。` }],
					details: { ok: true, proposals: local.length },
				};
			}

			// Scope BEFORE prefix matching, limits, error messages and details.
			const scoped = workItems.list().filter((item) => item.origin_conversation === conversationId);
			if (p.action === "list") {
				const items = scoped.slice(0, 30);
				const lines = items.map((item) => {
					const next = item.status === "scheduled" && item.next_check_at ? `，下次跟进 ${fmtTime(item.next_check_at)}` : "";
					const wait = item.status === "waiting_human" && item.question ? `，待答：${item.question.slice(0, 60)}` : "";
					return `${item.id.slice(0, 8)} 「${item.title}」 [${STATUS_LABEL[item.status] ?? item.status}]${next}${wait}`;
				});
				return {
					content: [{ type: "text", text: lines.length ? `当前会话共 ${scoped.length} 个工作项${scoped.length > items.length ? "（显示前 30 个）" : ""}：\n${lines.join("\n")}\n用 action=get 查看完整目标和工作笔记；前缀歧义时使用完整 id。` : "当前来源会话还没有工作项。管理员可用 action=mine 挖掘待确认提案。" }],
					details: { ok: true, count: scoped.length, items: items.map((item) => ({ id: item.id, title: item.title, status: item.status })) },
				};
			}

			const id = typeof p.id === "string" ? p.id.trim() : "";
			if (!id) return failure("请提供工作项 id，先用 action=list 查看当前来源会话的工作项。");
			const exact = scoped.find((item) => item.id === id);
			const matches = exact ? [exact] : scoped.filter((item) => item.id.startsWith(id));
			if (matches.length > 1) return failure("id 前缀有歧义，请用 action=list 取得完整 id 后重试。");
			const item = matches[0];
			if (!item) return failure("当前来源会话未找到该工作项，请先用 action=list 确认 id。");

			if (p.action === "get") {
				const lessons = lessonsOf(item.lessons);
				return {
					content: [{ type: "text", text: `工作项：${item.title}\nid：${item.id}\n状态：${STATUS_LABEL[item.status] ?? item.status}\n目标：\n${item.goal}\n执行条件：\n${item.conditions ?? "（未记录）"}\n进展：\n${item.progress ?? "（未记录）"}\n踩坑：\n${lessons.length ? lessons.map((lesson) => `- ${lesson}`).join("\n") : "（未记录）"}\n待答问题：\n${item.question ?? "（无）"}\n下次跟进：${fmtTime(item.next_check_at)}` }],
					details: { ok: true, item: { id: item.id, title: item.title, status: item.status, goal: item.goal, conditions: item.conditions, progress: item.progress, lessons, question: item.question, next_check_at: item.next_check_at } },
				};
			}

			if (p.action === "confirm") {
				if (item.status !== "proposed") return failure("只有待确认提案可以确认创建。");
				const confirmed = workItems.confirm(item.id, actor.senderId);
				if (!confirmed || confirmed.status !== "queued" || confirmed.created_by !== actor.senderId) return failure("确认失败，工作项状态可能已改变。");
				const fired = fireItem(item.id);
				return {
					content: [{ type: "text", text: `✅ 已确认创建「${item.title}」${fired ? "，已开工" : "，已入队，稍后自动开工"}。进展会推送到本来源会话。` }],
					details: { ok: true, confirmed: true, fired, queued: !fired },
				};
			}

			if (p.action === "resume") {
				if (item.status !== "waiting_human") return failure("只有等待人工/资源确认的工作项可以恢复。");
				if (p.answer !== undefined && typeof p.answer !== "string") return failure("answer 必须是文本。");
				// Atomic waiting_human -> queued transition stages the answer before
				// fireItem. A busy runner must not lose the reply or leave it waiting.
				const resumed = workItems.resume(item.id, p.answer);
				if (!resumed || resumed.status !== "queued") return failure("恢复失败，工作项状态可能已改变。");
				const fired = fireItem(item.id);
				return {
					content: [{ type: "text", text: `已确认恢复「${item.title}」，答复已保存${fired ? "，已继续执行" : "，已入队，稍后自动继续"}。` }],
					details: { ok: true, resumed: true, fired, queued: !fired },
				};
			}

			if (item.status === "done" || item.status === "cancelled") return failure("已完成或已取消的工作项不能再次取消。");
			const cancelled = workItems.cancel(item.id);
			if (!cancelled || cancelled.status !== "cancelled") return failure("取消失败，工作项状态可能已改变。");
			let abortRequested = false;
			if (deps.cancelItem) {
				try {
					await deps.cancelItem(item.id);
					abortRequested = true;
				} catch {
					// Keep cancellation durable even if the immediate abort bridge fails.
				}
			}
			return {
				content: [{ type: "text", text: `已取消工作项「${item.title}」${abortRequested ? "，已通知执行器停止。" : "。取消状态已保存；未确认立即中止，执行器须在下一检查点停止。"}` }],
				details: { ok: true, cancelled: true, abortRequested },
			};
		},
	};

	return [manageWork, manageItems];
}
