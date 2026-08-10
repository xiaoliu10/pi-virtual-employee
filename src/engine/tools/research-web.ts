import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { KnowledgeService } from "../../knowledge/knowledge-service.js";

/**
 * Build the auto-research tool. Lets the employee web-search when the knowledge
 * base misses, so it can answer from external sources and (via save_to_knowledge
 * with source="research") sediment the finding for future retrieval. Registered
 * only when kb.research.enabled is on.
 */
export function createResearchWebTool(knowledge: KnowledgeService): AgentTool {
	return {
		name: "research_web",
		label: "联网研究",
		description:
			"知识库未命中时，用搜索引擎查询资料以补充回答。返回若干结果的标题、摘要与来源链接。对其中可复用、可信的结论，应随后调用 save_to_knowledge（source=\"research\"，并带上 sourceUrl）沉淀为知识条目（标记为待核实）。不要把未经验证的网络信息当作官方规则直接断言。",
		parameters: Type.Object({
			query: Type.String({ description: "搜索查询词，尽量具体（如「产品X 保修期 多久」）" }),
		}),
		async execute(_toolCallId, params) {
			const { query } = params as { query: string };
			const hits = await knowledge.researchWeb(query);
			if (hits.length === 0) {
				return {
					content: [{ type: "text", text: `联网研究「${query}」未取得可用结果。请据实说明不确定，必要时转人工。` }],
					details: { query, matched: false },
				};
			}
			const lines = hits.map((h, i) => `${i + 1}. ${h.title}${h.url ? ` (${h.url})` : ""}\n   ${h.snippet}`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					query,
					matched: true,
					count: hits.length,
					hits: hits.map((h) => ({ title: h.title, url: h.url })),
				},
			};
		},
	};
}
