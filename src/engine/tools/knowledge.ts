import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { KnowledgeService } from "../../knowledge/knowledge-service.js";

/** Build the knowledge-base tool bound to a KnowledgeService instance. */
export function createKnowledgeTool(knowledge: KnowledgeService): AgentTool {
	return {
		name: "search_knowledge_base",
		label: "知识库查询",
		description:
			"查询业务知识库，获取完成各类任务所需的依据：官方规则与政策、业务/操作流程与步骤、系统地址与入口、账号凭据、产品或业务规格、常见问题等。回答任何事实性或流程性问题（含'怎么做''地址是什么''账号密码''规定是什么'）前，必须先调用此工具核实，不要凭记忆编造。",
		parameters: Type.Object({
			query: Type.String({ description: "查询关键词或问题，例如：业务操作流程、XX系统登录地址、退款规则、产品参数" }),
		}),
		async execute(_toolCallId, params) {
			const { query } = params as { query: string };
			const hits = await knowledge.search(query);
			if (hits.length === 0) {
				// Record the miss so the auto-research loop / UI can surface recurring gaps.
				try {
					knowledge.recordGap(query);
				} catch {
					/* non-fatal */
				}
				return {
					content: [
						{
							type: "text",
							text: `知识库中未找到与「${query}」直接相关的条目。若已开启自动研究（auto-research），可调用 research_web 查询资料后再回答；若对方坚持或问题较复杂，请考虑 escalate_to_human。`,
						},
					],
					details: { query, matched: false },
				};
			}
			const lines = hits.map((hit, index) => {
				// 外接命中（chunkId 以 "ext:" 开头）只作扩展补充：snippet 由对方服务端
				// 返回、可能被截断，需明确标注，避免模型把它当成完整权威内容。
				const isExternal = hit.chunkId.startsWith("ext:");
				const sourceLabel = isExternal
					? `外接·${hit.source}`
					: hit.source.startsWith("doc:")
						? `文档《${hit.source.slice(4)}》`
						: hit.source === "manual"
							? "知识条目"
							: hit.source;
				const title = hit.title ? `「${hit.title}」` : "";
				const entryId = !isExternal && hit.source === "manual" && hit.sourceId ? ` id=${hit.sourceId}` : "";
				const externalNote = isExternal ? "（外接补充，可能被截断；关键信息以内置知识库为准）" : "";
				return `${index + 1}. [${sourceLabel}${title}${entryId}] ${hit.snippet}${externalNote}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					query,
					matched: true,
					count: hits.length,
					hits: hits.map((hit) => ({ chunkId: hit.chunkId, source: hit.source, score: hit.score })),
				},
			};
		},
	};
}
