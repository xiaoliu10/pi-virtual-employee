/**
 * Role-based permission service (RBAC over platform-verified identities).
 *
 * The trust anchor: the IM adapter reports the senderStaffId from the signed
 * platform payload for every inbound message. Role resolution and capability
 * checks happen HERE, server-side, on that verified id — message text, web
 * page content, and file contents can never influence who is asking, so
 * prompt injection cannot escalate permissions. The model only ever sees a
 * refusal note when a check fails.
 *
 * Model:
 *  - Role per PERSON: security.people[] entry > adminStaffIds (=admin) >
 *    security.defaultRole (viewer). Admins in adminStaffIds keep their
 *    existing meaning; people[] is the finer-grained extension.
 *  - Floors per CONVERSATION: security.conversations[].floors maps a
 *    capability to a MINIMUM role for that chat only (e.g. a production-data
 *    group requires operator for browser). Floors tighten; they can never
 *    grant beyond the person's own role.
 *  - Effective requirement: max(person role needed by capability default,
 *    conversation floor). Person role must meet it.
 */
import type { ConfigStore } from "../db/config-store.js";
import { inferConversationOrigin } from "../db/history-store.js";
import type { InboundActor } from "../im/types.js";

export type Role = "viewer" | "operator" | "admin";

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export const CAPABILITY_LABEL: Record<string, string> = {
	chat: "对话服务",
	knowledge: "知识库检索",
	learn: "知识/记忆沉淀",
	browser: "浏览器操作",
	computer: "桌面控制",
	shell: "命令执行",
	filesystem: "文件系统",
	documents: "文档处理",
	scheduler: "定时任务",
	reports: "产物中心",
	telemetry: "运行统计",
	knowledge_manage: "知识库管理",
	settings: "系统设置",
	admin: "管理员操作",
};

// #region immutable:rbac-defaults
/** Default minimum role per capability (floors may raise it per conversation). */
const CAPABILITY_MIN: Record<string, Role> = {
	chat: "viewer",
	knowledge: "viewer",
	learn: "viewer",
	reports: "operator",
	// Running statistics expose how the employee has been performing (tool failure
	// text, which chats failed). Operator-level: they may read files/browse anyway;
	// the全量 view across every conversation is admin-only inside the tool.
	telemetry: "operator",
	browser: "operator",
	computer: "operator",
	filesystem: "operator",
	documents: "operator",
	scheduler: "operator",
	shell: "operator",
	knowledge_manage: "admin",
	settings: "admin",
	admin: "admin",
};
// #endregion immutable:rbac-defaults

export interface PermissionRefusal {
	ok: false;
	reason: string;
}

export interface PermissionGrant {
	ok: true;
	role: Role;
}

function asRole(v: string | undefined): Role | undefined {
	return v === "viewer" || v === "operator" || v === "admin" ? v : undefined;
}

// #region immutable:rbac-gate
/** Resolve a person's role from the verified senderId (never from text). */
export function resolveRole(config: ConfigStore, senderId: string | undefined | null): Role {
	if (!senderId) return "viewer";
	const sec = config.all().security;
	const person = sec.people?.find((p) => p.staffId === senderId);
	if (person) {
		const role = asRole(person.role);
		if (role) return role;
	}
	if (sec.adminStaffIds.includes(senderId)) return "admin";
	return asRole(sec.defaultRole) ?? "viewer";
}

/**
 * True when the sender holds the admin role. Admins are declared either in the
 * legacy `adminStaffIds` list or as a `people[]` entry with role "admin" — both
 * mean the same thing to every guarded tool, so a role-assigned admin never
 * hits a "not in the whitelist" refusal.
 */
export function isAdmin(config: ConfigStore, senderId: string | undefined | null): boolean {
	return resolveRole(config, senderId) === "admin";
}

/**
 * True when the deployment has at least one admin configured. False = UNCLAIMED,
 * where the first explicit confirmer in a 1:1 chat becomes the first admin.
 */
export function hasAnyAdmin(config: ConfigStore): boolean {
	const sec = config.all().security;
	if (sec.adminStaffIds.length > 0) return true;
	return (sec.people ?? []).some((p) => asRole(p.role) === "admin");
}

/** Capability keys a conversation floor may set (validation set for the config tool). */
export const KNOWN_CAPABILITIES = Object.keys(CAPABILITY_LABEL);

/** Default minimum role for a capability (exposed for the access tool's legend). */
export function defaultMinRole(capability: string): Role {
	return CAPABILITY_MIN[capability] ?? "viewer";
}

/** Normalize user/config input to a Role, or undefined when unrecognized. */
export function parseRole(v: string | undefined | null): Role | undefined {
	return asRole(v?.trim().toLowerCase());
}

/** Floors configured for a conversation id (empty when unconfigured). */
export function conversationFloors(config: ConfigStore, conversationId: string): Record<string, string> {
	return config.all().security.conversations?.find((c) => c.id === conversationId)?.floors ?? {};
}

/**
 * True for conversations with no IM/scheduler identity at all: the desktop
 * console and localhost HTTP (bare uuids, per inferConversationOrigin). Only
 * these bypass role resolution as admin — every prefixed id (dt:/feishu:/…/
 * sched:) is treated as remote, so a turn that arrives without verified sender
 * metadata gets the default role instead of inheriting trust.
 */
// #region immutable:rbac-trust-boundary
export function isLocalConversation(conversationId: string): boolean {
	return inferConversationOrigin(conversationId) === "console";
}
// #endregion immutable:rbac-trust-boundary

/**
 * Check a capability for the CURRENT turn's actor in a conversation. Returns
 * a grant (with the resolved role) or a refusal carrying a user-facing reason.
 */
export function checkPermission(
	config: ConfigStore,
	actor: InboundActor | undefined,
	conversationId: string,
	capability: string,
): PermissionGrant | PermissionRefusal {
	// Local contexts (desktop console / localhost HTTP) have no IM actor — they
	// carry the same trust as the settings UI (the documented recovery path), so
	// they keep full access. Every IM channel and unattended scheduled run is
	// NON-local: without a verified actor they fall back to the default role and
	// guarded tools refuse them, so a missing actor can never grant admin.
	let senderId: string | undefined;
	if (actor) senderId = actor.senderId || undefined;
	else if (isLocalConversation(conversationId)) return { ok: true, role: "admin" };
	const role = resolveRole(config, senderId);
	const raw = conversationFloors(config, conversationId)[capability];
	const floor = asRole(raw);
	// A configured-but-unparseable floor fails CLOSED (treated as admin-only)
	// rather than silently falling back to the capability's default: a typo in a
	// security setting must not hand out access.
	if (raw !== undefined && floor === undefined) {
		return { ok: false, reason: `会话门槛配置有误（能力「${capability}」的门槛值「${raw}」不是有效角色），为安全起见按管理员级别限制。请管理员在单聊中修正 security.conversations。` };
	}
	const minRole = floor && ROLE_RANK[floor] > ROLE_RANK[CAPABILITY_MIN[capability] ?? "viewer"] ? floor : (CAPABILITY_MIN[capability] ?? "viewer");
	if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
		const label = CAPABILITY_LABEL[capability] ?? capability;
		const need = minRole === "admin" ? "管理员" : minRole === "operator" ? "操作员（operator）" : "viewer";
		return {
			ok: false,
			reason: `当前用户没有「${label}」权限（需要 ${need} 或更高，你当前是 ${role}）。如需开通请联系管理员调整 security.people 中的角色指派。`,
		};
	}
	return { ok: true, role };
}
// #endregion immutable:rbac-gate

/** Uniform refusal content block for tool results. */
export function permissionRefusal(refusal: PermissionRefusal): { content: { type: "text"; text: string }[]; details: { refused: true; reason: string } } {
	return {
		content: [{ type: "text", text: `⛔ 已拒绝：${refusal.reason}` }],
		details: { refused: true, reason: refusal.reason },
	};
}

/**
 * Effective access summary for one sender in one conversation — what a
 * `check_my_access` answer is built from. Purely descriptive: it reports what
 * checkPermission would decide, and is safe to show to the caller themselves
 * (it reveals their own role, not the directory).
 */
export function describeAccess(
	config: ConfigStore,
	actor: InboundActor | undefined,
	conversationId: string,
): { senderId?: string; senderName?: string; role: Role; local: boolean; allowed: string[]; denied: string[] } {
	const local = isLocalConversation(conversationId);
	const senderId = actor?.senderId || undefined;
	const role = local ? "admin" : resolveRole(config, senderId);
	const allowed: string[] = [];
	const denied: string[] = [];
	for (const [capability, label] of Object.entries(CAPABILITY_LABEL)) {
		const verdict = checkPermission(config, actor, conversationId, capability);
		if (verdict.ok) allowed.push(label);
		else denied.push(label);
	}
	return { senderId, senderName: actor?.senderName, role, local, allowed, denied };
}
