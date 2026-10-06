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
export const ROOT_CATALOG: Record<string, string> = {
	model: "模型供应商与默认模型（suppliers/defaultSupplierId/defaultModelId；每个 supplier 条目内还有 per-model 覆盖：modelImage/modelContextWindow/modelMaxTokens，按 modelId 键值写入，如 model.suppliers.0.modelMaxTokens = {\"模型ID\": 32768}（单次输出上限：输出与输入共享上下文窗口，网关报 ContextWindowExceeded 且要求的 output 很大时就把它调小；不配时先查网关 model-info 接口（litellm /model/info），查不到才回退默认 32768）；改动错误会导致员工失联）",
	identity: "员工身份（name/role/duty/serviceHours）",
	im: "IM 渠道（im.enabled/channels[].appId/appSecret 等）",
	general: "通用（autostart/language/requestTimeoutMin/longTaskProgressMin/maxToolSteps/autoUpdate）",
	browser: "浏览器自动化（enabled/headless/allowedDomains）",
	computer: "Cua 桌面控制（enabled/driverPath/allowedApps/allowForeground/allowScheduled/connectTimeoutSec/actionTimeoutSec/sessionTimeoutSec；单位秒，总时限 0=不限时；allowedApps 空数组=拒绝全部，*=全部应用）",
	scheduler: "定时任务总开关（scheduler.enabled）",
	prompt: "提示词追加（prompt.extra/prompt.rules；rules 为空时用内置默认）",
	kb: "知识库（kb.enabled/kb.mode/kb.local.*/kb.embedding.* 等）",
	documents: "文档资源（documents.enabled/documents.dir）",
	filesystem: "本地文件访问（filesystem.enabled/filesystem.allowedDirs[]）",
	capabilities: "命令执行（capabilities.shell.enabled/allowedCommands/timeoutSec/backgroundTimeoutSec/pollTimeoutSec；时限单位秒：同步默认 60，后台默认 0=不限时，单次轮询等待默认 30）；MCP 外部工具（capabilities.mcp.enabled 开关 + capabilities.mcp.servers 服务器列表：[{name, command, args, env, cwd} 或 {name, url, headers, timeoutSec}]，env/headers 支持 ${环境变量}，name 仅字母数字_-，工具暴露为 mcp__<服务器>__<工具>）；自主工作提案挖掘（capabilities.autonomousMining.enabled 默认 false；intervalHours 默认 4，范围 1-24 小时；只生成待确认提案，不自动开工；无需新 UI，可用本工具在管理员 IM 单聊确认修改）",
	reports: "报告中心与发布目标（reports.enabled/reports.target/gitee.*/oss.*）",
	skills: "技能（skills.disabled[] 禁用名单；skills.marketUrl 技能市场索引 URL，manage_skills 换源用）",
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
const DUMP_DEPTH_LIMIT = 6;

/** Deep-mask a config subtree for dump: sensitive leaves render as 前2***后2, long strings truncate. */
function maskNode(value: unknown, path: string, depth: number): unknown {
	if (depth > DUMP_DEPTH_LIMIT) return "…";
	if (Array.isArray(value)) return value.slice(0, 50).map((item, i) => maskNode(item, `${path}.${i}`, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			out[key] = maskNode(child, `${path}.${key}`, depth + 1);
		}
		return out;
	}
	if (typeof value === "string" && SENSITIVE_RE.test(path)) {
		return value.length > 4 ? `${value.slice(0, 2)}***${value.slice(-2)}` : "***";
	}
	if (typeof value === "string" && value.length > 400) return `${value.slice(0, 400)}…(${value.length} chars)`;
	return value === undefined ? "(未设置)" : value;
}

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
	// Prompt mirrors the gate: with security.adminFullAccess on, requireConfirmedAdmin
	// short-circuits (admin.ts), so the description must stop demanding「确认」—
	// otherwise the model keeps politely asking for a confirmation it no longer needs.
	const fullAccess = deps.config.all().security.adminFullAccess === true;
	const writeRule = fullAccess
		? "已开启管理员完全访问：写入仅需管理员身份，管理员明确指示即可直接执行，无需额外口令"
		: "写入需管理员并在当前消息包含「确认」";
	return {
		name: "manage_settings",
		label: "系统配置管理",
		description:
			`读取或修改本系统的任意配置项（仅限 IM 单聊；${writeRule}）。` +
			"action=list 列出全部可配置的根块；action=get 按 path 读单个值（如 general.longTaskProgressMin、kb.local.topK、browser.headless、filesystem.allowedDirs）；" +
			"action=dump 按 path 列出一个块的全部配置项及当前值（密钥自动打码；不传 path 默认 dump 全部根块的键名概览）；" +
			"action=set 按 path 写入 value（数值段访问数组元素，如 im.channels.0.enabled）。" +
			"run_command 同步命令超时用 capabilities.shell.timeoutSec（秒，默认 60，0=不限制）；后台命令时限用 capabilities.shell.backgroundTimeoutSec（默认 0=不限时）；单次轮询等待用 capabilities.shell.pollTimeoutSec（默认 30 秒，0=立即返回，等待结束不杀进程）；模型请求超时用 general.requestTimeoutMin（分钟）。" +
			(fullAccess
			? "自主提案后台挖掘：capabilities.autonomousMining.enabled（默认 false）与 capabilities.autonomousMining.intervalHours（默认 4，1-24 小时）；管理员单聊 set enabled=true 开启、false 关闭。"
			: "自主提案后台挖掘：capabilities.autonomousMining.enabled（默认 false）与 capabilities.autonomousMining.intervalHours（默认 4，1-24 小时）；管理员单聊确认 set enabled=true 开启、false 关闭。") +
			"manage_work_items action=mine 可随时按需扫描当前来源会话近 24 小时；提案需在来源会话「确认创建 <id/标题>」；任务等待人工时，管理员直接回复答复内容即可恢复（无需口令）。" +
			"path 根块：" + Object.keys(ROOT_CATALOG).join("、") + "。" +
			"安全边界：security 块不可通过本工具修改（用 manage_admin/update_identity）；apiKey/appSecret/Token 等可设置但回显自动打码。" +
			(fullAccess
				? "注意修改 model 块（供应商/默认模型）有失联风险——配错将无法再通过对话恢复；切换前先核对该模型确在目标供应商 models 列表，核对无误且管理员已明确指示即可直接执行。"
				: "注意修改 model 块（供应商/默认模型）有失联风险——配错将无法再通过对话恢复，请谨慎核对。"),
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("dump"), Type.Literal("set")], {
				description: fullAccess
					? "list=列出可配置块；get=读单个值；dump=按块列出全部配置项（敏感值自动打码）；set=写配置（完全访问开启，直接执行）"
					: "list=列出可配置块；get=读单个值；dump=按块列出全部配置项（敏感值自动打码）；set=写配置（需确认）",
			}),
			path: Type.Optional(Type.String({ description: "get/set 必填：点分路径，如 general.maxToolSteps、kb.local.topK、im.channels.0.enabled" })),
			value: Type.Optional(
				Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String()), Type.Object({}, { additionalProperties: true })], {
					description: "仅 set 必填：新值（标量、数组或对象；数组整体替换）",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const { action } = params as { action: "list" | "get" | "dump" | "set"; path?: string; value?: unknown };

			if (action === "list") {
				const gate = requireSingleChatActor(deps);
				if ("content" in gate) return gate;
				const lines = Object.entries(ROOT_CATALOG).map(([root, desc]) => `- ${root}：${desc}`);
				lines.push("- security：管理员名单（请用 manage_admin / update_identity 管理，本工具不可触碰）");
				return {
					content: [{ type: "text", text: `可配置的配置块：\n${lines.join("\n")}\n\n用 get <path> 查看具体项，set <path> <value> 修改${fullAccess ? "（完全访问开启，直接执行）" : "（需「确认」）"}。` }],
					details: { action },
				};
			}

			const rawPath = (params as { path?: string }).path?.trim() ?? "";
			// dump works without a path (whole-config key overview); every other action needs one.
			if (!rawPath && action !== "dump") return refuse("path 不能为空（如 general.longTaskProgressMin）。");
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

			if (action === "dump") {
				const gate = requireSingleChatActor(deps);
				if ("content" in gate) return gate;
				const cfg = deps.config.all() as unknown as Record<string, unknown>;
				// No path: a shallow key overview of every root block (values hidden —
				// that's what dump/get are for). With a path: masked deep dump.
				if (!rawPath) {
					const overview = Object.entries(cfg).map(([root, value]) => {
						const keys = value && typeof value === "object" ? Object.keys(value as Record<string, unknown>) : [];
						return `- ${root}（${keys.length} 项）${keys.length ? `：${keys.join("、")}` : ""}`;
					});
					return {
						content: [{ type: "text", text: `配置根块概览：\n${overview.join("\n")}\n用 dump <根块名> 查看具体值，get <path> 读单项。` }],
						details: { action, blocks: Object.keys(cfg).length },
					};
				}
				const result = getByPath(cfg, segments);
				if (!result.ok) return refuse(`路径不存在：${rawPath}。可先用 action=list 查看可配置块。`);
				const masked = maskNode(result.value, rawPath, 0);
				const text = typeof masked === "string" ? masked : JSON.stringify(masked, null, 1);
				return {
					content: [{ type: "text", text: `${rawPath} = ${text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text}` }],
					details: { action, path: rawPath },
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
