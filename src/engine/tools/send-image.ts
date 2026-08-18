import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

/** Resolves the current turn's inline-image sender for a conversation. */
export type ImageSenderResolver = (
	conversationId: string,
) => ((filePath: string) => Promise<{ ok: boolean; url?: string; error?: string }>) | undefined;

/**
 * Build the inline-image delivery tool. Sends a local image file into the
 * originating IM chat as a real image message (not a file attachment). The
 * adapter uploads the image to a public host and posts the link. Channels that
 * can't send images omit the sender → the tool degrades to a text notice.
 *
 * Typical source: a screenshot saved by browser_screenshot (which returns its
 * on-disk path) or any image file under the managed downloads dir.
 */
export function createSendImageTool(resolveImageSender: ImageSenderResolver | undefined, conversationId: string): AgentTool {
	return {
		name: "send_image",
		label: "发送图片",
		description:
			"把一张本地图片作为内联图片发送到当前对话（对方能直接看到图，而不是文件）。参数 filePath 是图片的绝对路径——例如 browser_screenshot 返回的 savedPath，或 list_downloads 里的图片文件。" +
			"仅当对方明确要求看图、或任务结果就是截图/图表时使用。若当前渠道不支持发图，会返回提示，此时把图片路径或说明写进文字回复即可。",
		parameters: Type.Object({
			filePath: Type.String({ description: "要发送的图片文件的绝对路径（png/jpg/jpeg 等）" }),
		}),
		async execute(_toolCallId, params) {
			const { filePath } = params as { filePath: string };
			const sender = resolveImageSender?.(conversationId);
			if (!sender) {
				return {
					content: [{ type: "text", text: "当前渠道不支持发送内联图片。请把图片路径或说明写进文字回复。" }],
					details: { ok: false, unsupported: true, filePath },
				};
			}
			const result = await sender(filePath);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `图片发送失败：${result.error || "未知错误"}。可把图片路径写进文字回复。` }],
					details: { ok: false, error: result.error, filePath },
				};
			}
			return {
				content: [{ type: "text", text: "图片已发送到对话。" }],
				details: { ok: true, filePath, url: result.url },
			};
		},
	};
}
