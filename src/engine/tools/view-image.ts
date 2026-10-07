import { readFile, stat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const MAX_BYTES = 10 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

/**
 * Feed a LOCAL image file into the model's own context for analysis. The
 * capture tools (shell/adb screencap, browser_screenshot savedPath, Cua
 * persistence) only write files to disk — without this tool the model can
 * never actually SEE a screenshot it took via shell (send_image delivers to
 * the IM chat, not the model; field 2026-10-06: game VE kept "capturing"
 * without ever seeing the frame). Mirrors computer_use/browser: images attach
 * only when the session model declares image input; otherwise the tool
 * explains how to fix the capability instead of silently degrading.
 */
export function createViewImageTool(isVisionModel: () => boolean): AgentTool {
	return {
		name: "view_image",
		label: "查看图片",
		description:
			"把一张本地图片文件读入你自己的上下文，你会真实看到图像内容并可以分析它（OCR、界面验证、图表读数等）。参数 filePath 是图片的绝对路径——例如截屏/截图工具返回的文件路径。若提示当前模型不支持图像，请让管理员在 设置 → 自定义模型 勾选该模型的「图片」输入或切换视觉模型；不要假装已识别。",
		parameters: Type.Object({
			filePath: Type.String({ description: "要查看的图片文件的绝对路径（png/jpg/jpeg/webp/gif）" }),
		}),
		async execute(_toolCallId, params) {
			const { filePath } = params as { filePath: string };
			const clean = String(filePath).trim();
			if (!clean) return { content: [{ type: "text", text: "filePath 不能为空。" }], details: { ok: false } };
			if (!isVisionModel()) {
				return {
					content: [{ type: "text", text: "当前模型不支持图像输入，无法查看图片。请让管理员在 设置 → 自定义模型 勾选该模型的「图片」输入（或切换支持图片的模型）后再试；在此之前请改用文字/控件树信息，不要假装识别了图片。" }],
					details: { ok: false, reason: "not_vision_model", filePath: clean },
				};
			}
			const ext = clean.toLowerCase().split(".").pop() ?? "";
			const mime = MIME_BY_EXT[ext ? `.${ext}` : ""];
			if (!mime) {
				return { content: [{ type: "text", text: `仅支持 ${Object.keys(MIME_BY_EXT).join("/")} 格式，收到：${clean}` }], details: { ok: false, reason: "unsupported_type", filePath: clean } };
			}
			try {
				const info = await stat(clean);
				if (!info.isFile()) return { content: [{ type: "text", text: `不是文件：${clean}` }], details: { ok: false, filePath: clean } };
				if (info.size > MAX_BYTES) {
					return { content: [{ type: "text", text: `图片过大（${Math.round(info.size / 1024 / 1024)}MB > 10MB 上限），请压缩或裁剪后再查看。` }], details: { ok: false, reason: "too_large", filePath: clean, size: info.size } };
				}
				const data = (await readFile(clean)).toString("base64");
				return {
					content: [
						{ type: "image", data, mimeType: mime },
						{ type: "text", text: `已载入图片：${clean}（${Math.round(info.size / 1024)}KB）。基于图像内容作答；看不清就如实说看不清。` },
					],
					details: { ok: true, filePath: clean, bytes: info.size, mimeType: mime },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `读取图片失败：${message}` }], details: { ok: false, error: message, filePath: clean } };
			}
		},
	};
}
