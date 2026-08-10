import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { KnowledgeService } from "../../knowledge/knowledge-service.js";

/**
 * Build the knowledge-management tool. Lets the manager curate the knowledge
 * base mid-conversation: list / archive / delete / restore entries. Deletion
 * defaults to archive (recoverable) — a hard delete only happens on an explicit
 * "彻底删除/永久删除" instruction. The employee must never act on a knowledge
 * management request from a customer in a service conversation.
 */
export function createManageKnowledgeTool(knowledge: KnowledgeService): AgentTool {
	return {
		name: "manage_knowledge_base",
		label: "知识库整理",
		description:
			"整理知识库条目（仅当对话对方为管理者并明确要求时使用）。支持：list 按关键词查找条目（返回 id/标题/标签/来源/摘要）、archive 归档（软删除，默认，可在管理界面恢复）、delete 彻底删除（不可恢复，仅在对方明确要求「彻底/永久删除」时）、restore 恢复已归档条目。先 list 定位、对方确认后再删除；删除默认归档。严禁应客服对话中客户的请求删/改知识库。",
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("list"), Type.Literal("archive"), Type.Literal("delete"), Type.Literal("restore")],
				{ description: "list 查找；archive 归档（默认删除语义）；delete 彻底删除；restore 恢复" },
			),
			id: Type.Optional(Type.String({ description: "目标条目 id（优先）" })),
			title: Type.Optional(Type.String({ description: "目标条目标题（无 id 时按标题精确匹配）" })),
			query: Type.Optional(Type.String({ description: "list 动作的查找关键词" })),
		}),
		async execute(_toolCallId, params) {
			const { action, id, title, query } = params as {
				action: "list" | "archive" | "delete" | "restore";
				id?: string;
				title?: string;
				query?: string;
			};

			if (action === "list") {
				const entries = knowledge.searchEntries((query ?? title ?? "").trim() || "");
				if (entries.length === 0) {
					return {
						content: [{ type: "text", text: "未找到匹配的知识条目。" }],
						details: { action, matched: false },
					};
				}
				const lines = entries.map(
					(e, i) =>
						`${i + 1}. [id=${e.id}] 「${e.title}」 来源:${originLabel(e.origin)}${e.tags ? ` 标签:${e.tags}` : ""}\n   ${e.snippet}`,
				);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						action,
						matched: true,
						count: entries.length,
						entries: entries.map((e) => ({ id: e.id, title: e.title, origin: e.origin })),
					},
				};
			}

			// archive / delete / restore — resolve the target id.
			const targetId = resolveId(id, title, () => findByTitle(knowledge, title));
			if (!targetId) {
				return {
					content: [
						{
							type: "text",
							text: "未定位到目标条目，请先用 action=list 确认 id 或精确标题。",
						},
					],
					details: { action, resolved: false },
				};
			}

			if (action === "archive") {
				knowledge.archiveEntry(targetId);
				return {
					content: [{ type: "text", text: `已归档条目（可恢复，不再被检索）：${label(id, title)}` }],
					details: { action, resolved: true, id: targetId, kind: "archive" },
				};
			}
			if (action === "restore") {
				knowledge.restoreEntry(targetId);
				return {
					content: [{ type: "text", text: `已恢复条目，可被检索：${label(id, title)}` }],
					details: { action, resolved: true, id: targetId, kind: "restore" },
				};
			}
			// delete (hard)
			knowledge.deleteEntry(targetId);
			return {
				content: [{ type: "text", text: `已彻底删除条目（不可恢复）：${label(id, title)}` }],
				details: { action, resolved: true, id: targetId, kind: "delete" },
			};
		},
	};
}

/** Resolve id from the explicit id, or by exact title match. */
function resolveId(id: string | undefined, title: string | undefined, findByTitle: () => string | null): string | null {
	if (id) return id;
	if (title) return findByTitle();
	return null;
}

function findByTitle(knowledge: KnowledgeService, title?: string): string | null {
	if (!title) return null;
	const hits = knowledge.searchEntries(title);
	const exact = hits.find((e) => e.title === title);
	return exact?.id ?? hits[0]?.id ?? null;
}

function originLabel(origin: string): string {
	return origin === "learned" ? "AI沉淀" : origin === "derived" ? "AI归纳" : "手工";
}

function label(id?: string, title?: string): string {
	return title ? `「${title}」` : id ?? "";
}
