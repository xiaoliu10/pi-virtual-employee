import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ComputerService } from "../../computer/computer-service.js";
import { COMPUTER_ACTIONS, type ComputerAction } from "../../shared/computer.js";
import { requireAdminForCommand, requireConfirmedAdmin, type AdminToolDeps } from "./admin.js";

interface ComputerToolDeps extends AdminToolDeps {
	computer: ComputerService;
	isVisionModel: () => boolean;
	screenshotDir?: () => Promise<string | undefined>;
}

export function createComputerTools(deps: ComputerToolDeps): AgentTool<any>[] {
	const manage: AgentTool = {
		name: "manage_computer", label: "桌面控制管理",
		description: "管理 Cua Driver 桌面控制。status 查看驱动安装/连接/任务状态；install 后台安装固定版本的官方驱动并校验哈希（Windows/Linux，需管理员当前消息含确认）；connect 连接驱动；disconnect 停止当前桌面控制或安装；tools 查询当前平台可用的桌面动作及实际参数。仅管理员 IM 单聊。相关设置均支持对话修改：manage_capabilities set computer 开关桌面控制；manage_settings computer.* 设置 enabled、driverPath、allowedApps、allowForeground、allowScheduled、connectTimeoutSec、actionTimeoutSec、sessionTimeoutSec。不要只引导管理员去 GUI 设置页。",
		parameters: Type.Object({ action: Type.Union(["status", "install", "connect", "disconnect", "tools"].map(v => Type.Literal(v))),
			tool: Type.Optional(Type.Union(COMPUTER_ACTIONS.map(v => Type.Literal(v)), { description: "tools 时可选：只查询指定动作的参数，减少输出" })) }),
		async execute(_id, params) {
			const { action } = params as { action: string };
			const gate = requireConfirmedAdmin(deps, { needConfirmation: action === "install" });
			if ("content" in gate) return gate;
			try {
				if (action === "install") await deps.computer.startInstall();
				else if (action === "connect") await deps.computer.connect();
				else if (action === "disconnect") await deps.computer.disconnect();
				else if (action === "tools") return { content: [{ type: "text", text: JSON.stringify(await deps.computer.toolCatalog((params as { tool?: ComputerAction }).tool)) }], details: { action } };
				else if (action !== "status") throw new Error("未知管理动作。");
				const status = await deps.computer.status();
				return { content: [{ type: "text", text: JSON.stringify(status) }], details: status };
			} catch (error) { return failure(error); }
		},
	};
	const computer: AgentTool = {
		name: "computer_use", label: "桌面操作",
		description: "通过 Cua 操作管理员允许的桌面应用。先 list_apps 发现应用，list_windows 找 pid/window_id；对窗口 get_window_state 获取截图和控件，再 click/type_text/press_key/hotkey/scroll/drag 等，操作后必须再次 get_window_state 验证。arguments 使用 Cua 原生 snake_case 参数；不清楚时 manage_computer tools 查看当前平台 schema。控件点击优先 element_token，或 element_index + snapshot_id；坐标是窗口截图像素坐标。每次输入必须指定 pid、window_id。默认 delivery_mode=background；只有管理员开启 computer.allowForeground 后可显式用 foreground。不支持模型自行启用权限、执行 shell、读写全局剪贴板或任意驱动工具。仅管理员单聊；定时任务还需 computer.allowScheduled。",
		parameters: Type.Object({
			action: Type.Union(COMPUTER_ACTIONS.map(v => Type.Literal(v))),
			arguments: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Cua 工具参数。例如窗口状态 {pid:123,window_id:456}；点击再加 element_token；输入再加 text；按键再加 key。list_apps 可省略。" })),
		}),
		async execute(_id, params, signal) {
			const authorize = () => {
				const gate = requireAdminForCommand(deps, { needConfirmation: false });
				if ("content" in gate) throw new Error(gate.details.reason);
				if (gate.actor.channel === "scheduler" && !deps.config.all().computer.allowScheduled) throw new Error("管理员尚未允许定时任务操作桌面（computer.allowScheduled）。");
			};
			try {
				authorize();
				const { action, arguments: args = {} } = params as { action: ComputerAction; arguments?: Record<string, unknown> };
				if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments 必须是对象。");
				const result = await deps.computer.execute(action, args, deps.conversationId, signal, authorize);
				const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
				for (const block of result.content) {
					if (block.type === "text") content.push({ type: "text", text: block.text.slice(0, 30_000) });
					else if (block.type === "image" && ["image/png", "image/jpeg"].includes(block.mimeType)) {
						if (deps.isVisionModel()) content.push({ type: "image", data: block.data, mimeType: block.mimeType });
						else content.push({ type: "text", text: "当前模型不支持图像，请根据控件树操作；需要按截图坐标判断时应切换到支持图片的模型。" });
						try {
							const dir = await deps.screenshotDir?.();
							if (dir) {
								await mkdir(dir, { recursive: true });
								const path = join(dir, `desktop-${randomUUID()}.${block.mimeType === "image/png" ? "png" : "jpg"}`);
								await writeFile(path, Buffer.from(block.data, "base64"));
								content.push({ type: "text", text: `截图已保存：${path}（可用 send_image 发送）` });
							}
						} catch { /* screenshot persistence is optional */ }
					}
				}
				if (result.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent).slice(0, 40_000) });
				if (!content.length) content.push({ type: "text", text: "Cua 未返回可观察的结果，请检查窗口。" });
				return { content, details: { action, isError: result.isError === true } };
			} catch (error) { return failure(error); }
		},
	};
	return [manage, computer];
}

function failure(error: unknown) {
	return { content: [{ type: "text" as const, text: `桌面控制失败：${error instanceof Error ? error.message : String(error)}` }], details: { isError: true } };
}
