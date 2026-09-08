/**
 * Conversation-side admin & identity tools.
 *
 * Authorization model:
 *  - The IM adapter reports a verified `senderId` + `chatType` for each turn;
 *    this is platform metadata, never something the model or the user text can
 *    forge.
 *  - `security.adminStaffIds` is the admin whitelist. Empty = UNCLAIMED: the
 *    first sender who explicitly confirms an identity change in a 1:1 chat
 *    atomically becomes the first admin (bootstrapping a headless deployment).
 *  - Once non-empty, every admin/identity operation requires the sender to be
 *    whitelisted AND the chat to be 1:1. Group chats are always refused — a
 *    group has no reliable notion of "who is allowed".
 *  - Destructive steps (claim, identity change, admin add/remove) additionally
 *    require an explicit confirmation phrase in the user's CURRENT message
 *    ("确认" or a narrow equivalent), checked server-side — the model cannot grant
 *    itself the change by merely passing a confirmed=true parameter.
 *  - The admin whitelist itself is only editable via admin tools or the
 *    desktop settings UI (the desktop remains the recovery path); the last
 *    admin cannot be removed through chat, so the gate can't lock itself out.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ConfigStore } from "../../db/config-store.js";
import type { InboundActor } from "../../im/types.js";

/** The actor context a tool call executes under (undefined = non-IM channel). */
export type ActorContext = (InboundActor & { text: string }) | undefined;

/** Authorization failure result shared by guarded conversation tools. */
export type AdminRefusal = {
	content: { type: "text"; text: string }[];
	details: { refused: true; reason: string };
};

/** Refusal with a short reason the model relays verbatim. */
export function refuse(reason: string): AdminRefusal {
	return {
		content: [{ type: "text" as const, text: `⛔ 已拒绝：${reason}` }],
		details: { refused: true, reason },
	};
}

/**
 * Explicit confirmation phrase the user's CURRENT message must contain.
 * Deliberately narrow: bare "好"/"可以" are excluded because greetings like
 * "你好" and questions like "可以改吗" would falsely count as confirmation.
 */
const CONFIRM_RE = /(^|[^a-z])((请)?确认|confirm|yes|ok)([^a-z]|$)/i;

export function isExplicitConfirmation(userText: string): boolean {
	const text = userText.trim();
	// A confirmation word inside an explicit cancellation/negation must never
	// authorize a destructive or system-level operation (e.g. "别执行了").
	if (/(不要|别|取消|停止|终止|不确认|不执行|不运行|不用执行|拒绝|\b(?:no|cancel|stop|do not|don't)\b)/i.test(text)) return false;
	return CONFIRM_RE.test(text);
}

/**
 * True when the actor is the scheduler re-attaching a task creator's identity
 * for an unattended run (`sched:` conversation). The senderId was captured at
 * creation time in a verified 1:1 admin chat and is re-checked against the live
 * whitelist on every use, so revoking admin access disables the task's guarded
 * tools immediately. Command execution/supervision uses requireAdminForCommand;
 * configuration/admin mutations stay interactive-only.
 */
export function isSchedulerActor(actor: NonNullable<ActorContext>): boolean {
	return actor.channel === "scheduler";
}

/**
 * Platform-verified single-chat check shared by guarded tools. Group chats and
 * non-IM conversations have no reliable operation actor and are refused here.
 */
export function requireSingleChatActor(deps: Pick<AdminToolDeps, "resolveActor" | "conversationId">):
	| AdminRefusal
	| { actor: NonNullable<ActorContext> } {
	const actor = deps.resolveActor(deps.conversationId);
	if (!actor) {
		return refuse("当前会话不是 IM 单聊（无经过验证的发送者身份），管理操作只能在 IM 单聊中进行。");
	}
	if (actor.chatType !== "single") {
		return refuse("管理操作只允许在单聊中进行，群聊不开放（群内无法可靠鉴别操作者）。");
	}
	if (isSchedulerActor(actor)) {
		// Unattended scheduled runs may only execute/supervise commands (via
		// requireAdminForCommand, which checks the actor before calling here).
		// Every other admin tool stays interactive-only: a fixed task prompt
		// must never be able to rotate the admin list or rewrite config.
		return refuse("定时任务会话不能执行该管理操作（仅允许 run_command 受控命令及 manage_process 命令会话管理）。");
	}
	if (!actor.senderId) {
		return refuse("无法识别发送者身份（senderId 为空），拒绝执行。");
	}
	return { actor };
}

/**
 * Whitelisted-admin gate shared by guarded tools. Unlike `authorize`, an empty
 * whitelist NEVER claims the caller — update/restart tools are denied on an
 * unclaimed deployment until a first admin explicitly uses manage_admin claim.
 */
export function requireConfirmedAdmin(
	deps: Pick<AdminToolDeps, "config" | "resolveActor" | "conversationId">,
	opts: { needConfirmation: boolean; confirmationHint?: string },
): AdminRefusal | { actor: NonNullable<ActorContext> } {
	const gate = requireSingleChatActor(deps);
	if ("content" in gate) return gate;
	const { actor } = gate;
	const adminIds = deps.config.all().security.adminStaffIds;
	if (adminIds.length === 0) {
		return refuse("管理员尚未设置。请先在单聊中使用 manage_admin 的 claim 动作认领首位管理员。");
	}
	if (!adminIds.includes(actor.senderId)) {
		return refuse("你不是本系统的管理员，无权执行此操作。如需管理员权限，请联系现有管理员在单聊中添加。");
	}
	if (opts.needConfirmation && !isExplicitConfirmation(actor.text)) {
		return refuse(
			opts.confirmationHint ??
				"该操作会影响当前员工运行。请明确说明要执行的操作，并在当前消息中包含「确认」（或同义明确肯定语）。",
		);
	}
	return { actor };
}

/**
 * Command execution/supervision gate: identical to requireConfirmedAdmin, except a scheduler
 * actor (unattended scheduled-task run) passes WITHOUT the per-message
 * confirmation — the task prompt is fixed text, so requiring 「确认」 in it is
 * meaningless. The admin whitelist check above still applies live on every
 * fire, and the command whitelist still gates what can run. Read-only process
 * supervision may omit confirmation; starting/stopping commands requires it.
 * Every other admin
 * tool keeps using requireConfirmedAdmin, which rejects scheduler actors
 * through requireSingleChatActor's non-IM refusal.
 */
export function requireAdminForCommand(
	deps: Pick<AdminToolDeps, "config" | "resolveActor" | "conversationId">,
	opts: { needConfirmation: boolean } = { needConfirmation: true },
): AdminRefusal | { actor: NonNullable<ActorContext> } {
	const actor = deps.resolveActor(deps.conversationId);
	if (actor && isSchedulerActor(actor)) {
		const adminIds = deps.config.all().security.adminStaffIds;
		if (adminIds.length === 0) {
			return refuse("管理员尚未设置，定时任务无法以任何管理员身份执行受控命令。");
		}
		if (!adminIds.includes(actor.senderId)) {
			return refuse("创建该定时任务的管理员已被移出白名单，任务无法继续执行受控命令。");
		}
		return { actor };
	}
	// A scheduled-task conversation without a re-attached actor: the task was
	// created before creator-identity capture existed (or from the console UI).
	// Give an actionable message instead of the generic "not an IM 1:1 chat".
	if (!actor && deps.conversationId.startsWith("sched:")) {
		return refuse(
			"该定时任务创建时未记录管理员身份，无法无人值守执行受控命令。请管理员在 IM 单聊中使用 authorize_scheduled_task 给该任务授权（消息中明确「确认」），无需删除重建。",
		);
	}
	return requireConfirmedAdmin(deps, opts);
}

export interface AdminToolDeps {
	config: ConfigStore;
	resolveActor: (conversationId: string) => ActorContext;
	/** Called after a successful write so cached sessions rebuild on next turn. */
	onConfigChanged: () => void;
	conversationId: string;
}

/**
 * Authorize one admin operation. Returns either a refusal or the acting
 * context. Also decides the "first admin bootstrap": when the whitelist is
 * empty, an explicit confirmation in a 1:1 chat makes the sender the admin.
 */
function authorize(
	deps: AdminToolDeps,
	needConfirmation: boolean,
): AdminRefusal | { actor: NonNullable<ActorContext>; claimed: boolean } {
	const gate = requireSingleChatActor(deps);
	if ("content" in gate) return gate;
	const { actor } = gate;
	const adminIds = deps.config.all().security.adminStaffIds;
	if (adminIds.length === 0) {
		// Unclaimed deployment: the first explicit confirmer becomes first admin.
		if (needConfirmation && !isExplicitConfirmation(actor.text)) {
			return refuse(
				"管理员尚未设置。如需初始化，请在单聊中明确说明要修改的内容并包含「确认」字样（例如：把角色改为 XX，确认）。",
			);
		}
		console.log(`[admin] bootstrap: first admin claimed by ${actor.senderId} (${actor.channel})`);
		return { actor, claimed: true };
	}
	if (!adminIds.includes(actor.senderId)) {
		return refuse("你不是本系统的管理员，无权执行此操作。如需管理员权限，请联系现有管理员在单聊中添加。");
	}
	return { actor, claimed: false };
}

/** Mask an id for audit logs (keep first/last chars). */
export function maskId(id: string): string {
	if (id.length <= 4) return id[0] + "***";
	return `${id.slice(0, 2)}***${id.slice(-2)}`;
}

export function createManageAdminTool(deps: AdminToolDeps): AgentTool {
	return {
		name: "manage_admin",
		label: "管理员管理",
		description:
			"查询或变更本系统的管理员白名单（仅限 IM 单聊）。action=list 查看当前管理员；" +
			"action=add 添加管理员（传 staffId）；action=remove 移除管理员（传 staffId，不能移除最后一位）；" +
			"action=claim 在系统尚未设置任何管理员时认领成为首位管理员。" +
			"安全规则：增删管理员及认领都必须由对方在当前消息中明确说出「确认」（或同义明确肯定语），" +
			"否则返回待确认信息，你应先向对方复述变更内容征求确认；群聊请求一律拒绝。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("claim"), Type.Literal("add"), Type.Literal("remove")], {
				description: "list=查看；claim=首位管理员认领（仅在尚无管理员时）；add/remove=增删管理员（仅管理员）",
			}),
			staffId: Type.Optional(Type.String({
				description: "add/remove 时必填：目标用户的平台用户 ID（如钉钉 senderStaffId / staffId）",
			})),
		}),
		async execute(_toolCallId, params) {
			const { action, staffId } = params as { action: "list" | "claim" | "add" | "remove"; staffId?: string };
			const adminIds = deps.config.all().security.adminStaffIds;

			if (action === "list") {
				// List is admin-only info; the count is safe to reveal to anyone in a
				// 1:1 chat, but the ids themselves are only shown to admins.
				const actor = deps.resolveActor(deps.conversationId);
				const isSingle = actor?.chatType === "single" && !!actor.senderId;
				if (!isSingle) return refuse("管理员名单只能在 IM 单聊中查看。");
				if (adminIds.length === 0) {
					return {
						content: [{ type: "text", text: "当前尚未设置任何管理员（系统未认领）。第一位在单聊中明确确认身份修改的人将成为首位管理员。" }],
						details: { adminCount: 0 },
					};
				}
				if (!adminIds.includes(actor!.senderId)) {
					return {
						content: [{ type: "text", text: `当前已设置 ${adminIds.length} 位管理员。名单详情仅管理员可见。` }],
						details: { adminCount: adminIds.length },
					};
				}
				return {
					content: [{ type: "text", text: `当前管理员共 ${adminIds.length} 位：${adminIds.join("、")}。` }],
					details: { adminCount: adminIds.length },
				};
			}

			const gate = authorize(deps, true);
			if ("content" in gate) return gate;
			const { actor, claimed } = gate;

			if (action === "claim") {
				if (!claimed) {
					return refuse("系统已设置管理员，无需认领；如需成为管理员请联系现有管理员添加。");
				}
				const updated = deps.config.update({ security: { adminStaffIds: [actor.senderId] } });
				deps.onConfigChanged();
				console.log(`[admin] whitelist claimed by ${maskId(actor.senderId)} → [${updated.security.adminStaffIds.map(maskId).join(",")}]`);
				return {
					content: [{ type: "text", text: `✅ 认领成功，你已成为本系统首位管理员（共 ${updated.security.adminStaffIds.length} 位）。此后身份与管理员的修改仅限管理员在单聊中进行。` }],
					details: { action, adminCount: updated.security.adminStaffIds.length },
				};
			}

			if (action === "add") {
				const target = (staffId ?? "").trim();
				if (!target) return refuse("缺少 staffId：添加管理员需要对方的平台用户 ID。");
				const current = deps.config.all().security.adminStaffIds;
				if (current.includes(target)) {
					return { content: [{ type: "text", text: `「${target}」已是管理员，无需重复添加。` }], details: { action, unchanged: true } };
				}
				const updated = deps.config.update({ security: { adminStaffIds: [...current, target] } });
				deps.onConfigChanged();
				console.log(`[admin] add ${maskId(target)} by ${maskId(actor.senderId)} → count=${updated.security.adminStaffIds.length}`);
				return {
					content: [{ type: "text", text: `✅ 已将「${target}」添加为管理员，当前共 ${updated.security.adminStaffIds.length} 位。` }],
					details: { action, adminCount: updated.security.adminStaffIds.length },
				};
			}

			// remove
			const target = (staffId ?? "").trim();
			if (!target) return refuse("缺少 staffId：移除管理员需要对方的平台用户 ID。");
			const current = deps.config.all().security.adminStaffIds;
			if (!current.includes(target)) {
				return { content: [{ type: "text", text: `「${target}」不在管理员名单中。` }], details: { action, unchanged: true } };
			}
			if (current.length <= 1) {
				return refuse("不能移除最后一位管理员（否则将没有任何人能通过对话管理系统）。如需更换，请先添加新的管理员。");
			}
			const updated = deps.config.update({ security: { adminStaffIds: current.filter((id) => id !== target) } });
			deps.onConfigChanged();
			console.log(`[admin] remove ${maskId(target)} by ${maskId(actor.senderId)} → count=${updated.security.adminStaffIds.length}`);
			return {
				content: [{ type: "text", text: `✅ 已将「${target}」移出管理员名单，当前共 ${updated.security.adminStaffIds.length} 位。` }],
				details: { action, adminCount: updated.security.adminStaffIds.length },
			};
		},
	};
}

export function createUpdateIdentityTool(deps: AdminToolDeps): AgentTool {
	return {
		name: "update_identity",
		label: "修改员工身份",
		description:
			"修改本虚拟员工的身份信息（仅限 IM 单聊）。可修改字段：role（员工类型/角色）、duty（职责描述）、serviceHours（服务时间）。" +
			"至少传一个字段；只想查看当前值时不要调用本工具（当前值：role/duty/serviceHours 会随工具说明注入，直接告诉对方即可）。" +
			"安全规则：对方必须在当前消息中明确包含「确认」（或同义明确肯定语）才会执行；群聊一律拒绝；" +
			"系统未设置管理员时，首位明确确认修改的人将同时成为首位管理员。",
		parameters: Type.Object({
			role: Type.Optional(Type.String({ description: "新的员工类型/角色，如「虚拟运维工程师」" })),
			duty: Type.Optional(Type.String({ description: "新的职责描述" })),
			serviceHours: Type.Optional(Type.String({ description: "新的服务时间标签，如「7×24h」" })),
		}),
		async execute(_toolCallId, params) {
			const { role, duty, serviceHours } = params as { role?: string; duty?: string; serviceHours?: string };
			const patch: Record<string, string> = {};
			if (role !== undefined) patch.role = role.trim();
			if (duty !== undefined) patch.duty = duty.trim();
			if (serviceHours !== undefined) patch.serviceHours = serviceHours.trim();
			const fields = Object.keys(patch).filter((k) => patch[k]);
			if (fields.length === 0) {
				return refuse("没有提供任何有效的新字段值（至少需要 role / duty / serviceHours 之一，且不能为空）。");
			}

			const gate = authorize(deps, true);
			if ("content" in gate) return gate;
			const { actor, claimed } = gate;

			const before = deps.config.all().identity;
			const updated = deps.config.update({
				identity: {
					...(patch.role ? { role: patch.role } : {}),
					...(patch.duty ? { duty: patch.duty } : {}),
					...(patch.serviceHours ? { serviceHours: patch.serviceHours } : {}),
				},
			});
			deps.onConfigChanged();
			const changes = fields.map((f) => `${f}:「${before[f as keyof typeof before]}」→「${updated.identity[f as keyof typeof updated.identity]}」`).join("；");
			console.log(`[admin] identity updated by ${maskId(actor.senderId)}${claimed ? " (bootstrap)" : ""}: ${changes}`);
			return {
				content: [{
					type: "text",
					text:
						`✅ 身份信息已更新（${changes}）。` +
						(claimed ? "你已成为本系统首位管理员，此后此类修改仅限管理员在单聊中进行。" : "") +
						"新配置将在下一条消息起生效。",
				}],
				details: { fields, claimed, identity: updated.identity },
			};
		},
	};
}
