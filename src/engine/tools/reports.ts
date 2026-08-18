import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ReportService } from "../../reports/report-service.js";

/**
 * Build the in-conversation report tool. Lets the employee save an arbitrary
 * artifact (a poem, a summary, an analysis, a generated doc) to the report
 * center and get back a shareable link — without waiting for a scheduled task.
 *
 * The artifact is persisted locally (run + body) and published to the
 * configured target (Gitee/OSS); the tool returns the share URL so the
 * employee can hand it to the user. Does NOT terminate — the conversation
 * continues.
 */
export function createSaveReportTool(reportService: ReportService, conversationId: string): AgentTool {
	return {
		name: "save_report",
		label: "保存到产物中心",
		description:
			"把当前对话中生成的任意内容（一首诗、一段总结、一份分析、一个文档等）保存到「产物中心」，并返回一个可分享的访问链接（发布到配置的 Gitee 仓库或阿里云 OSS）。用于：用户要求『给我一个链接/文件地址』、『保存这份报告』、『生成并发布』等场景。内容用 Markdown 书写，标题简明。返回结果里会含 url 字段——把它告诉用户即可。",
		parameters: Type.Object({
			title: Type.String({ description: "产物标题，简明概括（如「八月运营小诗」）" }),
			content: Type.String({
				description: "产物正文，用 Markdown 书写，完整自包含（脱离对话也能看懂）",
			}),
			summary: Type.Optional(Type.String({ description: "可选一句话摘要，用于列表预览" })),
		}),
		async execute(_toolCallId, params) {
			const { title, content, summary } = params as { title: string; content: string; summary?: string };
			try {
				const { runId } = reportService.startRun({
					source: "tool",
					// Unique per save: upsertBySource collapses by (source, sourceRef),
					// so a shared conversationId would overwrite one artifact's title with
					// every save. The timestamp suffix keeps the conversation grouping
					// (same prefix) while letting each report stand as its own artifact.
					sourceRef: `${conversationId}:${Date.now()}`,
					title,
					trigger: "manual",
					summary: summary ?? null,
				});
				reportService.completeRun(runId, { status: "ok", content, summary: summary ?? null });
				const pub = await reportService.publish(runId, title, content);
				if (!pub?.url) {
					return {
						content: [{ type: "text", text: `已保存「${title}」到产物中心，但未生成访问链接（报告发布未启用或未配置成功）。用户可在应用「设置 → 产物中心」查看正文。` }],
						details: { ok: true, published: false, runId },
					};
				}
				return {
					content: [{ type: "text", text: `已保存「${title}」到产物中心。访问链接：${pub.url}\n\n请把这个链接发给用户。` }],
					details: { ok: true, published: true, runId, url: pub.url, path: pub.path },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `保存到产物中心失败：${(err as Error).message}` }],
					details: { ok: false, error: (err as Error).message },
				};
			}
		},
	};
}
