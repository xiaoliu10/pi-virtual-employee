/**
 * Conversation-side full-config management for headless deployments.
 *
 * Desktop settings UI is unreachable on an unattended server, so every config
 * block must be readable/writable from an admin's 1:1 chat. This tool exposes
 * dot-path access (e.g. "general.longTaskProgressMin",
 * "reports.gitee.owner", "kb.local.topK") over ConfigStore.
 *
 * Hard edges (deliberate):
 *  - `security.*` is NOT reachable here: the last-admin protection lives in
 *    manage_admin, and a raw array write could clear the whitelist and lock
 *    every admin out. Route those through manage_admin / update_identity.
 *  - Secret-looking values (apiKey/appSecret/writeToken/…) are SETTABLE but
 *    never echoed back in plaintext — get output and change summaries mask them,
 *    so keys don't end up in the IM message history.
 *  - Every write requires a whitelisted admin AND an explicit confirmation in
 *    the current message (same gate as all guarded tools).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ConfigStore } from "../../db/config-store.js";
import {
	isExplicitConfirmation,
	maskId,
	refuse,
	requireConfirmedAdmin,
	requireSingleChatActor,
	type ActorContext,
} from "./admin.js";

export interface SettingsToolDeps {
	config: ConfigStore;
	resolveActor: (conversationId: string) => ActorContext;
	/** Marks cached sessions stale so prompt-affecting changes apply next turn. */
	onConfigChanged?: () => void;
	conversationId: string;
}

/** Blocks that must go through their dedicated tools instead of raw writes. */
const BLOCKED_ROOTS = new Set(["security"]);

const SENSITIVE_RE = /(api_?key|secret|token|password)/i;
const MAX_VALUE_CHARS = 20_000;

/** Root-block catalog for the list action (also the discovery surface for the model). */
const ROOT_CATALOG: Record<string, string> = {
	model: "模型供应商与默认模型（suppliers/defaultSupplierId/defaultModelId；改动错误会导致员工失联）",
	identity: "员工身份（name/role/duty/serviceHours）",
	im: "IM 渠道（im.enabled/channels[].appId/appSecret 等）",
	general: "通用（autostart/language/requestTimeoutMin/longTaskProgressMin/maxToolSteps/autoUpdate）",
	browser: "浏览器自动化（enabled/headless/allowedDomains）",
	scheduler: "定时任务总开关（scheduler.enabled）",
	prompt: "提示词追加（prompt.extra/prompt.rules；rules 为空时用内置默认）",
	kb: "知识库（kb.enabled/kb.mode/kb.local.*/kb.embedding.* 等）",
	documents: "文档资源（documents.enabled/documents.dir）",
	filesystem: "本地文件访问（filesystem.enabled/filesystem.allowedDirs[]）",
	capabilities: "能力开关（capabilities.shell.enabled 与 shell 白名单）",
	reports: "报告中心与发布目标（reports.enabled/reports.target/gitee.*/oss.*）",
	skills: "已禁用技能列表（skills.disabled[]）",
};

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * Walk a dot-path into the merged config. Numeric segments index arrays
 * ("im.channels.0.enabled"). Returns undefined when any hop is missing.
 */
function getByPath(root: unknown, segments: string[]): { ok: true; value: unknown } | { ok: false } {
	let cur: unknown = root;
	for (const seg of segments) {
		if (cur == null) return { ok: false };
		if (Array.isArray(cur)) {
			const idx = Number(seg);
			if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { ok: false };
			cur = cur[idx];
			continue;
		}
		if (typeof cur !== "object") return { ok: false };
		cur = (cur as Record<string, unknown>)[seg];
	}
	return { ok: true, value: cur };
}

/**
 * Build a full-replacement patch for a dot-path that may include array
 * indexes ("im.channels.0.enabled"). deepMerge replaces arrays wholesale, so
 * an index write must clone the ORIGINAL array with just that slot patched and
 * target the patch at the array's parent key. Anything else would either drop
 * the numeric segment (overwriting the whole containing array) or merge an
 * object into an array position.
 */
function buildPatch(segments: string[], value: unknown, cfgRoot: Record<string, unknown>): { ok: true; patch: Record<string, unknown>; echoPath: string[] } | { ok: false; reason: string } {
	// Resolve intermediate hops against live config to validate index bounds.
	let srcCur: unknown = cfgRoot;
	for (let i = 0; i < segments.length - 1; i += 1) {
		const seg = segments[i];
		if (Array.isArray(srcCur)) {
			const idx = Number(seg);
			if (!Number.isInteger(idx) || idx < 0 || idx >= srcCur.length) {
				return { ok: false, reason: `数组下标越界：${segments.slice(0, i + 1).join(".")}（当前长度 ${srcCur.length}）` };
			}
			srcCur = srcCur[idx];
		} else if (srcCur != null && typeof srcCur === "object") {
			srcCur = (srcCur as Record<string, unknown>)[seg];
		} else {
			srcCur = undefined; // intermediate hop missing — deepMerge will create {}
		}
	}
	const lastSeg = segments[segments.length - 1];

	// Case A: writing INTO an array element ("…channels.0" or "…allowedDirs.2")
	if (Array.isArray(srcCur)) {
		const idx = Number(lastSeg);
		if (!Number.isInteger(idx) || idx < 0 || idx >= srcCur.length) {
			return { ok: false, reason: `数组下标越界：${segments.join(".")}（当前长度 ${srcCur.length}；追加请 set 整个数组）` };
		}
		const copy = [...srcCur];
		copy[idx] = value;
		const parentSegs = segments.slice(0, -1);
		return { ok: true, patch: nestValue(parentSegs, copy), echoPath: segments };
	}

	// Case B: ordinary object-key write.
	return { ok: true, patch: nestValue(segments, value), echoPath: segments };
}

/** Wrap `value` in nested single-key objects along `segs` ([] → value itself). */
function nestValue(segs: string[], value: unknown): Record<string, unknown> {
	let out: unknown = value;
	for (let i = segs.length - 1; i >= 0; i -= 1) out = { [segs[i]]: out };
	return out as Record<string, unknown>;
}

/** Mask secret-looking leaf values; structural values pass through shallowly. */
function present(value: unknown): string {
	if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…(${value.length} chars)` : value;
	if (value === undefined) return "(未设置)";
	if (value === null) return "null";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function createManageSettingsTool(deps: SettingsToolDeps): AgentTool {
	return {
		name: "manage_settings",
		label: "系统配置管理",
		description:
			"读取或修改本系统的任意配置项（仅限 IM 单聊；写入需管理员并在当前消息包含「确认」）。" +
			"action=list 列出全部可配置的根块；action=get 按 path 读单个值（如 general.longTaskProgressMin、kb.local.topK、browser.headless、filesystem.allowedDirs）；" +
			"action=set 按 path 写入 value（数值段访问数组元素，如 im.channels.0.enabled）。" +
			"path 根块：" + Object.keys(ROOT_CATALOG).join("、") + "。" +
			"安全边界：security 块不可通过本工具修改（用 manage_admin/update_identity）；apiKey/appSecret/Token 等可设置但回显自动打码。" +
			"注意修改 model 块（供应商/默认模型）有失联风险——配错将无法再通过对话恢复，请谨慎核对。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("set")], {
				description: "list=列出可配置块；get=读配置；set=写配置（需确认）",
			}),
			path: Type.Optional(Type.String({ description: "get/set 必填：点分路径，如 general.maxToolSteps、kb.local.topK、im.channels.0.enabled" })),
			value: Type.Optional(
				Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String()), Type.Object({}, { additionalProperties: true })], {
					description: "仅 set 必填：新值（标量、数组或对象；数组整体替换）",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const { action } = params as { action: "list" | "get" | "set"; path?: string; value?: unknown };

			if (action === "list") {
				const gate = requireSingleChatActor(deps);
				if ("content" in gate) return gate;
				const lines = Object.entries(ROOT_CATALOG).map(([root, desc]) => `- ${root}：${desc}`);
				lines.push("- security：管理员名单（请用 manage_admin / update_identity 管理，本工具不可触碰）");
				return {
					content: [{ type: "text", text: `可配置的配置块：\n${lines.join("\n")}\n\n用 get <path> 查看具体项，set <path> <value> 修改（需「确认」）。` }],
					details: { action },
				};
			}

			const rawPath = (params as { path?: string }).path?.trim() ?? "";
			if (!rawPath) return refuse("path 不能为空（如 general.longTaskProgressMin）。");
			if (rawPath.length > 200 || /\s/.test(rawPath)) return refuse("path 格式非法（点分小写段，不含空格）。");
			const segments = rawPath.split(".");
			if (BLOCKED_ROOTS.has(segments[0])) {
				return refuse(`「${segments[0]}」块受专用工具保护：管理员名单用 manage_admin，身份信息用 update_identity。`);
			}

			if (action === "get") {
				const gate = requireSingleChatActor(deps);
				if ("content" in gate) return gate;
				const cfg = deps.config.all() as unknown as Record<string, unknown>;
				const result = getByPath(cfg, segments);
				if (!result.ok) return refuse(`路径不存在：${rawPath}。可先用 action=list 查看可配置块，再逐级 get。`);
				const masked = SENSITIVE_RE.test(rawPath) && typeof result.value === "string"
					? `${result.value.slice(0, 2)}***${result.value.slice(-2)}`
					: present(result.value);
				return {
					content: [{ type: "text", text: `${rawPath} = ${masked}` }],
					details: { action, path: rawPath, sensitive: SENSITIVE_RE.test(rawPath) },
				};
			}

			// action === "set"
			const gate = requireConfirmedAdmin(deps, {
				needConfirmation: true,
				confirmationHint: "修改配置会影响员工行为，请明确说出要改的配置项和新值，并在当前消息中包含「确认」。",
			});
			if ("content" in gate) return gate;

			const value = (params as { value?: unknown }).value;
			if (value === undefined || value === null) {
				return refuse("set 需要提供 value（标量、数组或对象）。");
			}
			if (typeof value === "string") {
				if (SENSITIVE_RE.test(rawPath) && /^\s*(none|null|空)\s*$/i.test(value)) {
					return refuse("不能把密钥设置为占位符；确需清除请联系部署方在桌面设置页操作。");
				}
				if (value.length > MAX_VALUE_CHARS) return refuse(`value 过长（>${MAX_VALUE_CHARS} 字符）。`);
			}
			// Deep objects other than arrays get size-bounded too.
			if (typeof value === "object" && !Array.isArray(value) && JSON.stringify(value).length > MAX_VALUE_CHARS) {
				return refuse("value 对象过大。");
			}

			const cfgBefore = deps.config.all() as unknown as Record<string, unknown>;
			const before = getByPath(cfgBefore, segments);

			const planned = buildPatch(segments, value, cfgBefore);
			if (!planned.ok) return refuse(planned.reason);
			const oldSnapshot = before.ok ? present(before.value) : "(未设置)";
			deps.config.update(planned.patch as Parameters<ConfigStore["update"]>[0]);
			deps.onConfigChanged?.();

			const cfgAfter = deps.config.all() as unknown as Record<string, unknown>;
			const after = getByPath(cfgAfter, segments);
			const isSecret = SENSITIVE_RE.test(rawPath);
			const shownOld = isSecret ? `${oldSnapshot.slice(0, 2)}***${oldSnapshot.slice(-2)}` : oldSnapshot;
			const shownNew = after.ok
				? (isSecret && typeof after.value === "string" ? `${after.value.slice(0, 2)}***${after.value.slice(-2)}` : present(after.value))
				: present(undefined);

			console.log(`[settings] ${rawPath} changed by ${maskId(gate.actor.senderId)}${isSecret ? " (secret masked)" : ""}: ${shownOld} -> ${shownNew.slice(0, 200)}`);

			const riskyRoot = rawPath === "model" || rawPath.startsWith("model.");
			return {
				content: [{
					type: "text",
					text:
						`✅ 配置已更新：${rawPath}\n${shownOld} → ${shownNew}\n从下一条消息起生效。` +
						(riskyRoot ? "\n⚠️ 你修改了模型配置。若供应商地址/密钥/默认模型有误，员工将无法回复也无法自我修复——请立即发一条消息验证员工还能响应；如异常，请尽快改回原值。" : ""),
				}],
				details: {
					action,
					path: rawPath,
					oldValue: isSecret ? "***" : before.ok ? before.value : null,
					newValue: isSecret ? "***" : after.ok ? after.value : null,
				},
			};
		},
	};
}

export { isExplicitConfirmation };
