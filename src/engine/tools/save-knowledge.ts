import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { KnowledgeService } from "../../knowledge/knowledge-service.js";

/**
 * Build the auto-learn tool that lets the employee persist reusable knowledge
 * mid-conversation. Same title de-dupes and merges (see KnowledgeService.saveLearned).
 * Does NOT terminate — the conversation continues after saving.
 */
export function createSaveToKnowledgeTool(knowledge: KnowledgeService): AgentTool {
	return {
		name: "save_to_knowledge",
		label: "沉淀知识",
		description:
			"把对话中产生的可复用知识（解决方案、政策澄清、FAQ、客户偏好、纠错经验等）整理成一条知识库条目保存。标题简明概括主题、内容写清适用条件与步骤，便于后续检索复用；同标题会自动合并。",
		parameters: Type.Object({
			title: Type.String({ description: "知识条目标题，简明概括主题（如「7天无理由退货流程」）" }),
			content: Type.String({
				description: "知识正文：适用条件、步骤、注意事项，完整且可脱离上下文独立理解",
			}),
			tags: Type.Optional(
				Type.String({ description: "可选标签，逗号分隔（如「退货,售后」）" }),
			),
			entryId: Type.Optional(
				Type.String({
					description: "要更新的已有条目 id（从 search_knowledge_base / manage_knowledge_base 的 list 结果获取）。提供时为更新而非新建。",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("replace"), Type.Literal("append")], {
					description: "更新已有条目时的语义：replace=覆盖旧内容（用于纠正/修订），append=追加（默认 replace）",
				}),
			),
			source: Type.Optional(
				Type.Union(
					[Type.Literal("learned"), Type.Literal("research")],
					{
						description: "知识来源：learned=对话中沉淀（默认）；research=联网研究所得（标记为待核实、低置信度，需带 sourceUrl）",
					},
				),
			),
			sourceUrl: Type.Optional(
				Type.String({ description: "来源链接（source=\"research\" 时必填，作为出处留存）" }),
			),
			gapQuery: Type.Optional(
				Type.String({ description: "若本条知识解答了某个知识缺口，传该缺口查询词，沉淀后自动消除该缺口" }),
			),
		}),
		async execute(_toolCallId, params) {
			const { title, content, tags, entryId, mode, source, sourceUrl, gapQuery } = params as {
				title: string;
				content: string;
				tags?: string;
				entryId?: string;
				mode?: "replace" | "append";
				source?: "learned" | "research";
				sourceUrl?: string;
				gapQuery?: string;
			};
			// Updating an existing entry by id → corrective revise (replace/append).
			if (entryId) {
				const result = knowledge.reviseEntry(entryId, { content, title, tags, mode: mode ?? "replace" });
				if (result.revised) {
					return {
						content: [
							{
								type: "text",
								text: mode === "append" ? `已向条目「${title}」追加内容。` : `已更新条目「${title}」的内容（覆盖旧版）。`,
							},
						],
						details: { saved: true, revised: true, id: entryId, mode: mode ?? "replace" },
					};
				}
				// Fall through to create if the id didn't match anything.
			}
			// Research-sourced finding: pending review, low confidence, with provenance.
			if (source === "research") {
				const result = knowledge.saveResearched({ title, content, tags, sourceUrl, gapQuery });
				return {
					content: [
						{
							type: "text",
							text: `已沉淀联网研究知识「${title}」（标记为待核实）。${gapQuery ? "已消除对应知识缺口。" : ""}`,
						},
					],
					details: { saved: true, source: "research", id: result.id },
				};
			}
			const result = knowledge.saveLearned({ title, content, tags });
			return {
				content: [
					{
						type: "text",
						text: result.merged ? `已合并到已有条目「${title}」。` : `已沉淀新知识条目「${title}」。`,
					},
				],
				details: { saved: true, title, merged: result.merged, id: result.id },
			};
		},
	};
}
