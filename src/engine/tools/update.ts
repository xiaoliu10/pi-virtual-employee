import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ConfigStore } from "../../db/config-store.js";
import {
	maskId,
	refuse,
	requireConfirmedAdmin,
	requireSingleChatActor,
	type ActorContext,
} from "./admin.js";

/** Platform-agnostic view of the Electron updater, injected by the main process. */
export interface UpdateOperations {
	isSupported(): { supported: boolean; reason?: string };
	getStatus(): UpdateToolStatus;
	checkNow(): Promise<UpdateToolStatus>;
	/** Fire-and-forget check → download → install after the current reply drains. */
	requestUpdateAndInstall(): UpdateRequestResult;
}

export interface UpdateToolStatus {
	currentVersion: string;
	phase: "idle" | "checking" | "available" | "none" | "downloading" | "ready" | "error";
	targetVersion?: string;
	percent?: number;
	error?: string;
	/** Epoch ms of the last COMPLETED update check (server-confirmed available
	 * or not-available). Undefined = never checked since this launch. "none" is
	 * only trustworthy relative to this: a 6h-scheduled check can be hours old
	 * while a release just shipped (field incident 2026-09-17). */
	lastCheckAt?: number;
}

export type UpdateRequestResult =
	| { started: true; mode: "checking" | "downloading" | "pending" | "installing"; status: UpdateToolStatus }
	| { started: false; reason: string; status: UpdateToolStatus };

export interface UpdateToolDeps {
	config: ConfigStore;
	resolveActor: (conversationId: string) => ActorContext;
	onConfigChanged: () => void;
	conversationId: string;
	updates: UpdateOperations;
}

/** Auto-update modes (tri-state; legacy booleans map true→full, false→off). */
export type AutoUpdateMode = "full" | "download_only" | "off";

/** Normalize the persisted config value (boolean or string) to a mode. */
export function normalizeAutoUpdate(v: boolean | "full" | "download_only" | "off"): AutoUpdateMode {
	return v === "download_only" ? "download_only" : v === true || v === "full" ? "full" : "off";
}

const MODE_TEXT: Record<AutoUpdateMode, string> = {
	full: "完全自动（发现新版本自动下载并在空闲时重启安装）",
	download_only: "仅下载（自动下载新版本但不自动安装，安装需管理员确认）",
	off: "已关闭（发现新版本仅提示，需管理员明确发起）",
};

/** Compact textual status used by both tool responses and the model's context. */
export function describeStatus(status: UpdateToolStatus, mode: AutoUpdateMode): string {
	const lines = [`当前版本：v${status.currentVersion}`];
	switch (status.phase) {
		case "idle":
			lines.push("更新状态：空闲，尚未开始本次检查");
			break;
		case "checking":
			lines.push("更新状态：正在检查新版本");
			break;
		case "available":
			lines.push(`更新状态：发现新版本 v${status.targetVersion ?? "未知"}，尚未下载`);
			break;
		case "none":
			// "已是最新" is a CONCLUSION FROM A POINT IN TIME, not a live fact —
			// always state its age so the model can't pass it off as current.
			lines.push("更新状态：上次检查（" + freshness(status.lastCheckAt) + "）未发现新版本");
			break;
		case "downloading":
			lines.push(`更新状态：正在下载 v${status.targetVersion ?? "未知"}${typeof status.percent === "number" ? `（${status.percent}%）` : ""}`);
			break;
		case "ready":
			lines.push(
				mode === "download_only"
					? `更新状态：新版本 v${status.targetVersion ?? "未知"} 已下载完成，本机为仅下载模式，回复「确认更新到最新版」即可安装`
					: `更新状态：新版本 v${status.targetVersion ?? "未知"} 已下载完成，等待空闲后安装`,
			);
			break;
		case "error":
			lines.push(`更新状态：失败（${status.error ?? "未知错误"}）`);
			break;
	}
	// Stale-conclusion guard: scheduled checks run every 6h, so "没有新版本" can
	// be hours old while a release just shipped (v0.2.66 boxes kept reporting
	// "已是最新" after 0.2.67/68 landed). Surface the age whenever the cached
	// conclusion would be used as if it were current.
	const STALE_CHECK_MS = 30 * 60_000;
	const stale = (status.phase === "none" || status.phase === "idle") && (!status.lastCheckAt || Date.now() - status.lastCheckAt > STALE_CHECK_MS);
	if (stale) {
		lines.push(
			status.lastCheckAt
				? `注意：这是 ${freshness(status.lastCheckAt)}的结论，之后可能已发布新版本；要确认是否最新，需用 action=check 实时检查，不要用 status 的缓存下结论`
				: "注意：本次启动以来尚未完成过更新检查，无法确定是否最新；要确认需用 action=check 实时检查，不要用 status 的缓存下结论",
		);
	}
	lines.push(`自动更新模式：${MODE_TEXT[mode]}`);
	return lines.join("；");
}

/** Human phrase for how long ago the last completed check was. */
function freshness(lastCheckAt?: number, now = Date.now()): string {
	if (!lastCheckAt) return "本次启动以来尚未完成过检查";
	const min = Math.max(1, Math.floor((now - lastCheckAt) / 60_000));
	if (min < 60) return `${min} 分钟前`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h} 小时前`;
	return `${Math.floor(h / 24)} 天前`;
}

/**
 * Conversation-side app update control. The tool never blocks waiting for a
 * download and never calls quitAndInstall directly: it only schedules the
 * update, returns the final chat reply, and the main process restarts after
 * every active conversation has drained. This keeps the "正在升级" message
 * deliverable instead of being lost when the process exits.
 */
export function createManageUpdateTool(deps: UpdateToolDeps): AgentTool {
	return {
		name: "manage_update",
		label: "应用更新管理",
		description:
			"管理本应用自身版本（仅限 IM 单聊）。action=status 查看当前版本/更新状态；action=check 立即检查新版本；" +
			"action=update 下载并安排空闲时重启安装最新版；action=set_auto 开启或关闭无人值守自动更新（传 enabled=true/false）。" +
			"安全规则：status 仅单聊可查看；check 需管理员单聊；update 和 set_auto 必须由管理员在当前消息中明确包含「确认」（或同义明确肯定语），群聊一律拒绝。" +
			"update 是异步操作：收到工具结果后先正常回复「已安排更新」，不要声称已经重启完成。",
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("status"), Type.Literal("check"), Type.Literal("update"), Type.Literal("set_auto")],
				{ description: "status=查看；check=检查；update=下载并空闲时安装；set_auto=开关无人值守自动更新" },
			),
			enabled: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("full"), Type.Literal("download_only"), Type.Literal("off")], {
				description: "仅 set_auto 必填：true/false 或 \"full\"（完全自动）/ \"download_only\"（仅下载不自动装）/ \"off\"",
			})),
		}),
		async execute(_toolCallId, params) {
			const { action, enabled } = params as {
				action: "status" | "check" | "update" | "set_auto";
				enabled?: boolean | "full" | "download_only" | "off";
			};

			if (action === "status") {
				const gate = requireSingleChatActor(deps);
				if ("content" in gate) return gate;
				const capability = deps.updates.isSupported();
				const status = deps.updates.getStatus();
				const unsupported = capability.supported ? "" : `更新能力：不可用（${capability.reason ?? "当前环境不支持"}）；`;
				return {
					content: [{ type: "text", text: unsupported + describeStatus(status, normalizeAutoUpdate(deps.config.all().general.autoUpdate)) }],
					details: { action, supported: capability.supported, status },
				};
			}

			const capability = deps.updates.isSupported();
			if (!capability.supported) {
				return refuse(capability.reason ?? "当前环境不支持自动更新。");
			}

			if (action === "check") {
				const gate = requireConfirmedAdmin(deps, { needConfirmation: false });
				if ("content" in gate) return gate;
				const before = deps.updates.getStatus();
				const after = await deps.updates.checkNow();
				const status = after.phase === before.phase ? { ...after, phase: "checking" as const } : after;
				return {
					content: [{ type: "text", text: `已提交检查。${describeStatus(status, normalizeAutoUpdate(deps.config.all().general.autoUpdate))}` }],
					details: { action, status },
				};
			}

			const gate = requireConfirmedAdmin(deps, {
				needConfirmation: true,
				confirmationHint:
					action === "update"
						? "更新会下载安装包并在系统空闲时重启应用。请明确说出要更新，并在当前消息中包含「确认」。"
						: "变更无人值守自动更新会影响后续版本是否自动安装。请明确说出要开启或关闭，并在当前消息中包含「确认」。",
			});
			if ("content" in gate) return gate;
			console.log(`[update] action=${action} authorized by ${maskId(gate.actor.senderId)}`);

			if (action === "set_auto") {
				if (typeof enabled !== "boolean" && enabled !== "full" && enabled !== "download_only" && enabled !== "off") {
					return refuse("set_auto 需要显式传入 enabled：true（完全自动）/ false（关闭）/ \"download_only\"（仅下载，安装需确认）。");
				}
				const value = enabled === true ? "full" : enabled === false ? "off" : enabled;
				const updated = deps.config.update({ general: { autoUpdate: value } });
				deps.onConfigChanged();
				const mode = normalizeAutoUpdate(updated.general.autoUpdate);
				return {
					content: [{
						type: "text",
						text: `✅ 自动更新模式已设为：${MODE_TEXT[mode]}。`,
					}],
					details: { action, autoUpdate: updated.general.autoUpdate },
				};
			}

			// action === "update": authorize first, then queue the whole async update.
			const result = deps.updates.requestUpdateAndInstall();
			if (!result.started) {
				return {
					content: [{ type: "text", text: `⛔ 无法安排更新：${result.reason}。${describeStatus(result.status, normalizeAutoUpdate(deps.config.all().general.autoUpdate))}` }],
					details: { action, started: false, status: result.status },
				};
			}
			const modeText = {
				checking: "已开始检查新版本，发现可用版本后会自动下载",
				downloading: "已有新版本，已自动开始下载",
				pending: "更新检查/下载正在进行中，已登记本次完成后安装",
				installing: "新版本已下载完成，已安排系统空闲时重启安装",
			}[result.mode];
			return {
				content: [{
					type: "text",
					text: `✅ 已安排更新：${modeText}。当前对话答复发送完成后，系统会等待所有任务空闲，再自动重启安装；安装完成后新版本立即生效。${describeStatus(result.status, normalizeAutoUpdate(deps.config.all().general.autoUpdate))}`,
				}],
				details: { action, started: true, mode: result.mode, status: result.status },
			};
		},
	};
}
