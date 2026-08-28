import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";
import type { ConfigStore } from "../../db/config-store.js";
import { maskId, refuse, requireConfirmedAdmin, requireSingleChatActor, type ActorContext } from "./admin.js";

export interface CapabilityToolDeps {
	config: ConfigStore;
	resolveActor: (conversationId: string) => ActorContext;
	onConfigChanged: () => void;
	conversationId: string;
	/** Resolves the packaged playwright cli.js for browser-kernel installs. */
	playwrightCliPath: () => string;
}

/** Browser-kernel install state (one in-flight install per process). */
let kernelInstall:
	| { status: "running"; startedAt: number }
	| { status: "done"; finishedAt: number }
	| { status: "failed"; finishedAt: number; error: string }
	| { status: "installed"; finishedAt: number }
	| null = null;

/** Toggleable capabilities exposed to conversation-side admins. */
const TOGGLEABLE = ["browser", "documents", "filesystem", "reports", "downloads", "shell"] as const;
type ToggleKey = (typeof TOGGLEABLE)[number];

const CAPABILITY_LABELS: Record<ToggleKey, string> = {
	browser: "浏览器自动化（navigate/click/type/screenshot/read 等）",
	documents: "文档资源（list/provide/save 文档）",
	filesystem: "本地文件访问（受限目录列表与授权删除）",
	reports: "报告中心（生成报告并发布链接）",
	downloads: "浏览器下载工作区（下载文件列表/读取/分析）",
	shell: "受限命令执行（进程、系统与网络诊断白名单命令）",
};

const CONFIRM_HINT =
	"变更能力开关会影响员工可用的工具范围。请明确说出要开启或关闭哪项能力，并在当前消息中包含「确认」。";

/**
 * Conversation-side capability switches for headless deployments where nobody
 * can reach the desktop settings UI. Reuses the admin authorization gate
 * (platform-verified 1:1 chat + whitelist + explicit confirmation). The write
 * persists to config and marks sessions stale, so the new tool set takes
 * effect from the next message without a restart.
 */
export function createManageCapabilitiesTool(deps: CapabilityToolDeps): AgentTool {
	return {
		name: "manage_capabilities",
		label: "能力开关管理",
		description:
			"查看或变更本应用的能力开关（仅限 IM 单聊）。action=list 查看各项能力及其开关状态；" +
			"action=set 开启或关闭某项能力（传 capability 和 enabled）；设置 shell 时可同时传 allowedCommands 更新命令白名单；action=setup_browser 安装/检查浏览器内核（Chromium）。" +
			"可管理能力：browser（浏览器自动化）、documents（文档资源）、filesystem（本地文件访问）、" +
			"reports（报告中心）、downloads（浏览器下载工作区）、shell（受限命令执行）。" +
			"安全规则：list 需单聊；set 和 setup_browser 必须由管理员在当前消息中明确包含「确认」（或同义明确肯定语），群聊一律拒绝。" +
			"setup_browser 已装则直接报告已安装；未装则后台下载（约 150MB，需几分钟），用 status 查询进度。下载源由 browser.downloadHost 决定（留空 = 国内默认走 npmmirror 镜像；如需改用 manage_settings 设置 browser.downloadHost）。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("set"), Type.Literal("setup_browser"), Type.Literal("status")], {
				description: "list=查看能力开关；set=开关能力；setup_browser=安装浏览器内核；status=查询浏览器内核安装状态",
			}),
			capability: Type.Optional(
				Type.Union(
					[
						Type.Literal("browser"),
						Type.Literal("documents"),
						Type.Literal("filesystem"),
						Type.Literal("reports"),
						Type.Literal("downloads"),
						Type.Literal("shell"),
					],
					{ description: "仅 set 必填：要开关的能力名" },
				),
			),
			enabled: Type.Optional(Type.Boolean({ description: "仅 set 必填：true=开启，false=关闭" })),
			allowedCommands: Type.Optional(Type.Array(Type.String(), {
				description: "仅 capability=shell 时可选：完整替换可执行文件白名单，如 [\"tasklist\",\"taskkill\",\"powershell\"]；空数组=全部拒绝；*=任意命令（高风险）",
			})),
		}),
		async execute(_toolCallId, params) {
			const { action, capability, enabled, allowedCommands } = params as {
				action: "list" | "set" | "setup_browser" | "status";
				capability?: ToggleKey;
				enabled?: boolean;
				allowedCommands?: string[];
			};

			if (action === "list") {
				const gate = requireSingleChatActor(deps);
				if ("content" in gate) return gate;
				const cfg = deps.config.all();
				const kernelReady = chromiumKernelReady();
				const lines = TOGGLEABLE.map((key) => {
					const on = readCapability(cfg, key);
					return `- ${key}：${on ? "✅ 已开启" : "❌ 已关闭"}（${CAPABILITY_LABELS[key]}）`;
				});
				lines.push(`  shell 白名单：${cfg.capabilities.shell.allowedCommands.length ? cfg.capabilities.shell.allowedCommands.join("、") : "（空，全部拒绝）"}`);
				lines.push(`- 浏览器内核（Chromium）：${kernelReady ? "✅ 已就绪" : "❌ 未安装（可用 setup_browser 安装）"}`);
				return {
					content: [{ type: "text", text: `当前能力开关：\n${lines.join("\n")}\n如需变更，请说明要开关的能力并包含「确认」。` }],
					details: { action, capabilities: snapshot(deps.config), kernelReady },
				};
			}

			if (action === "status") {
				const gate = requireSingleChatActor(deps);
				if ("content" in gate) return gate;
				return {
					content: [{ type: "text", text: kernelStatusText() }],
					details: { action, kernelReady: chromiumKernelReady(), install: kernelInstall },
				};
			}

			if (action === "setup_browser") {
				const gate = requireConfirmedAdmin(deps, {
					needConfirmation: true,
					confirmationHint: "安装浏览器内核会从网络下载约 150MB 文件到本机缓存目录。请明确说明要安装，并在当前消息中包含「确认」。",
				});
				if ("content" in gate) return gate;
				if (chromiumKernelReady()) {
					kernelInstall = { status: "installed", finishedAt: Date.now() };
					return {
						content: [{ type: "text", text: "✅ 浏览器内核（Chromium）已安装就绪，无需重复安装；可直接使用浏览器工具。" }],
						details: { action, kernelReady: true },
					};
				}
				if (kernelInstall?.status === "running") {
					return {
						content: [{ type: "text", text: "⏳ 浏览器内核正在安装中（后台下载约 150MB）。稍后可用 action=status 查询进度。" }],
						details: { action, install: kernelInstall },
					};
				}
				console.log(`[capabilities] chromium kernel install started by ${maskId(gate.actor.senderId)}`);
				const downloadHost = (deps.config.all().browser.downloadHost ?? "").trim();
				startKernelInstall(deps.playwrightCliPath(), downloadHost);
				return {
					content: [{ type: "text", text: "✅ 已开始后台安装浏览器内核（Chromium，约 150MB，预计几分钟）。安装完成后即可使用浏览器工具；期间可用 action=status 查询进度。" }],
					details: { action, install: kernelInstall },
				};
			}

			// action === "set"
			const gate = requireConfirmedAdmin(deps, { needConfirmation: true, confirmationHint: CONFIRM_HINT });
			if ("content" in gate) return gate;
			if (!capability || !TOGGLEABLE.includes(capability)) {
				return refuse(`缺少或非法的 capability：可管理能力为 ${TOGGLEABLE.join("、")}。`);
			}
			if (typeof enabled !== "boolean") {
				return refuse("set 需要显式传入 enabled=true（开启）或 false（关闭）。");
			}
			if (allowedCommands !== undefined && capability !== "shell") {
				return refuse("allowedCommands 仅在 capability=shell 时可用。");
			}
			const normalizedAllowed = allowedCommands === undefined
				? undefined
				: [...new Set(allowedCommands.filter((c): c is string => typeof c === "string" && c.trim().length > 0).map((c) => c.trim().toLowerCase()))];
			console.log(`[capabilities] ${capability} → ${enabled} by ${maskId(gate.actor.senderId)}${normalizedAllowed ? ` allow=[${normalizedAllowed.join(",")}]` : ""}`);
			const updated = deps.config.update(
				capability === "shell"
					? { capabilities: { shell: { enabled, ...(normalizedAllowed ? { allowedCommands: normalizedAllowed } : {}) } } }
					: { [capability]: { enabled } },
			);
			deps.onConfigChanged();
			return {
				content: [{
					type: "text",
					text:
						`✅ 能力「${capability}」（${CAPABILITY_LABELS[capability]}）已${enabled ? "开启" : "关闭"}，从下一条消息起生效。` +
						(capability === "browser" && enabled
							? "若首次使用浏览器工具提示缺少内核，请管理员在部署机器上执行：npx playwright install chromium。"
							: "") +
						(capability === "shell" && enabled
							? `当前白名单：${updated.capabilities.shell.allowedCommands.length ? updated.capabilities.shell.allowedCommands.join("、") : "（空，全部拒绝）"}。可在设置页或 manage_capabilities allowedCommands 调整；powershell/node/npx 等解释器需显式加入。`
							: ""),
				}],
				details: { action, capability, enabled, capabilities: snapshotFrom(updated) },
			};
		},
	};
}

function readCapability(cfg: ReturnType<ConfigStore["all"]>, key: ToggleKey): boolean {
	return key === "shell" ? cfg.capabilities.shell.enabled : cfg[key].enabled;
}

/** True when the Chromium binary this playwright version expects is on disk. */
function chromiumKernelReady(): boolean {
	try {
		return existsSync(chromium.executablePath());
	} catch {
		return false;
	}
}

function kernelStatusText(): string {
	if (chromiumKernelReady()) {
		return `✅ 浏览器内核（Chromium）已就绪：${chromium.executablePath()}`;
	}
	if (kernelInstall?.status === "running") {
		const mins = Math.round((Date.now() - kernelInstall.startedAt) / 60_000);
		return `⏳ 安装进行中，已运行约 ${mins} 分钟（后台下载约 150MB）。完成后自动可用。`;
	}
	if (kernelInstall?.status === "failed") {
		return `❌ 上次安装失败：${kernelInstall.error}。可重试 setup_browser（需确认）。`;
	}
	return "❌ 浏览器内核未安装。管理员可在单聊中发送「安装浏览器内核，确认」触发 setup_browser 安装。";
}

/** Spawn the packaged playwright CLI to install the Chromium kernel, detached
 * from this tool call — downloads take minutes, so the reply returns immediately
 * and progress is queryable via action=status. */
function startKernelInstall(cliPath: string, downloadHost: string): void {
	kernelInstall = { status: "running", startedAt: Date.now() };
	// Playwright pulls Chromium from its own CDN by default, which is slow or
	// unreachable from CN servers. PLAYWRIGHT_DOWNLOAD_HOST redirects the
	// download to a mirror (npmmirror keeps a full sync). Empty = playwright's
	// default (official CDN). Auto-defaults to the CN mirror when the field is
	// unset so headless CN deployments just work; overridable via config.
	// Playwright composes `${host}/${downloadPath}` where downloadPath is like
	// "builds/chromium/1187/chromium-win64.zip", so the host must NOT include a
	// trailing /builds (that would double it). Empty = official CDN.
	const host = downloadHost || "https://registry.npmmirror.com/-/binary/playwright";
	console.log(`[capabilities] chromium download host: ${host}`);
	try {
		const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				PLAYWRIGHT_DOWNLOAD_HOST: host,
			},
		});
		let errText = "";
		let settled = false;
		const finish = (result: Extract<typeof kernelInstall, { status: "done" | "failed" }>): void => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			kernelInstall = result;
			if (result.status === "done") console.log("[capabilities] chromium kernel installed");
			else console.error("[capabilities] kernel install failed:", result.error);
		};
		// Hard stop: a wedged download must flip to failed instead of reporting
		// "running" forever (the stuck-at-973-minutes state).
		const watchdog = setTimeout(() => {
			finish({ status: "failed", finishedAt: Date.now(), error: "安装超过 30 分钟未完成，已终止并标记失败，可重试 setup_browser。" });
			try { child.kill(); } catch { /* already gone */ }
		}, 30 * 60_000);
		watchdog.unref();
		child.stderr?.on("data", (d: Buffer) => { errText += d.toString(); });
		child.once("error", (err) => {
			finish({ status: "failed", finishedAt: Date.now(), error: err.message });
		});
		child.once("exit", (code) => {
			if (code === 0 && chromiumKernelReady()) {
				finish({ status: "done", finishedAt: Date.now() });
			} else if (!settled) {
				finish({ status: "failed", finishedAt: Date.now(), error: `exit=${code ?? "unknown"} ${errText.slice(0, 300)}`.trim() });
			}
		});
	} catch (err) {
		kernelInstall = { status: "failed", finishedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
	}
}

function snapshot(config: ConfigStore): Record<string, boolean> {
	const cfg = config.all();
	const out: Record<string, boolean> = {};
	for (const key of TOGGLEABLE) out[key] = readCapability(cfg, key);
	return out;
}

function snapshotFrom(cfg: ReturnType<ConfigStore["all"]>): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const key of TOGGLEABLE) out[key] = readCapability(cfg, key);
	return out;
}
