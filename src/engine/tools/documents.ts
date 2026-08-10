/**
 * Document-resource tools. Registered only when documents.enabled is on.
 *
 * Three tools over the resource catalog:
 *  - list_documents: search by keyword and/or partner so the model can find
 *    "which doc for whom in what scenario" (returns metadata only, not content).
 *  - provide_document: hand a resource to the partner in the current chat —
 *    links come back as text (the agent relays the URL), files are sent through
 *    the channel's file sender when available (DingTalk real file send), else
 *    degraded to an archived-path notice.
 *  - save_document: persist a reusable resource the agent discovered (mainly an
 *    online link; a known file path is accepted too).
 *
 * File delivery is decoupled from any IM adapter via resolveFileSender, which the
 * engine resolves per-turn from the inbound context (undefined on channels that
 * can't send files, e.g. the console — provide_document then falls back).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { DocumentService, FileSenderResolver } from "../../documents/document-service.js";

/** Coerce a partners/tags argument (array or comma/、 string) into a clean string[]. */
function toStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
	if (typeof v === "string") return v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
	return [];
}

export function createDocumentTools(
	documents: DocumentService,
	conversationId: string,
	resolveFileSender?: FileSenderResolver,
): AgentTool[] {
	const list: AgentTool = {
		name: "list_documents",
		label: "文档资源检索",
		description:
			"检索文档资源库，找出要提供给对接方的文档（接口文档、规格说明、在线文档等）。可按关键词（匹配名称/描述/场景/标签）和/或对接方名称过滤。返回每条资源的 id、名称、类型(在线文档/文件)、适用对接方、场景。回答「把某文档发给某对接方」类需求前先调用此工具定位资源，再用 provide_document 投递。",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "关键词，如「对账接口」「退款规则」" })),
			partner: Type.Optional(Type.String({ description: "对接方/接收方名称过滤，如「支付宝」「微信」" })),
		}),
		async execute(_toolCallId, params) {
			const { query, partner } = params as { query?: string; partner?: string };
			const rows = documents.search(query ?? null, partner ?? null);
			if (rows.length === 0) {
				return {
					content: [{ type: "text", text: "未找到匹配的文档资源。可换关键词或对接方再试；若确实没有，请如实告知对方。" }],
					details: { matched: false },
				};
			}
			const lines = rows.map((r, i) => {
				const meta = [
					r.kind === "link" ? "在线文档" : "文件",
					r.partners.length ? `对接方:${r.partners.join("/")}` : null,
					r.scenario ? `场景:${r.scenario}` : null,
				]
					.filter(Boolean)
					.join(" | ");
				return `${i + 1}. [id=${r.id}] 「${r.name}」 ${meta}${r.description ? `\n   ${r.description}` : ""}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					matched: true,
					count: rows.length,
					resources: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
				},
			};
		},
	};

	const provide: AgentTool = {
		name: "provide_document",
		label: "投递文档",
		description:
			"把指定文档资源投递给当前会话的对接方。在线文档类：返回链接，请把链接写进你的回复一并发给对方。文件类：会尽量通过当前渠道直接发送文件；若渠道不支持或失败，会返回文件名与归档路径，请据实告知对方（如「文件已存档，稍后转给你」）。先用 list_documents 拿到 id。",
		parameters: Type.Object({
			id: Type.String({ description: "要投递的文档资源 id（来自 list_documents）" }),
		}),
		async execute(_toolCallId, params) {
			const { id } = params as { id: string };
			const result = await documents.provide(id, conversationId, resolveFileSender);
			return {
				content: [{ type: "text", text: result.text }],
				details: { ok: result.ok, delivered: result.delivered, id },
			};
		},
	};

	const save: AgentTool = {
		name: "save_document",
		label: "保存文档资源",
		description:
			"把一个可复用的文档资源存进资源库（通常是你在任务中发现的在线文档链接，填好名称、URL、适用对接方、场景）。文件类资源一般由管理员在设置界面上传，除非你已确知文件在本机的绝对路径。名称必填；链接类必须给 url。",
		parameters: Type.Object({
			name: Type.String({ description: "资源名称，如「支付宝对账接口文档 v2」" }),
			kind: Type.Union([Type.Literal("link"), Type.Literal("file")], {
				description: "link=在线文档(需填 url)；file=本地文件(需填 filePath)",
			}),
			url: Type.Optional(Type.String({ description: "在线文档 URL（kind=link 时必填）" })),
			filePath: Type.Optional(Type.String({ description: "本地文件绝对路径（kind=file 时）" })),
			partners: Type.Optional(Type.Array(Type.String(), { description: "适用对接方列表" })),
			description: Type.Optional(Type.String({ description: "这是什么文档 / 内容概要" })),
			scenario: Type.Optional(Type.String({ description: "什么场景下提供" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "标签" })),
		}),
		async execute(_toolCallId, params) {
			const p = params as {
				name?: string;
				kind?: "link" | "file";
				url?: string;
				filePath?: string;
				partners?: string[] | string;
				description?: string;
				scenario?: string;
				tags?: string[] | string;
			};
			const name = p.name?.trim();
			if (!name) {
				return { content: [{ type: "text", text: "保存失败：名称(name)必填。" }], details: { ok: false } };
			}
			const kind = p.kind === "link" ? "link" : "file";
			if (kind === "link" && !p.url?.trim()) {
				return { content: [{ type: "text", text: "保存失败：在线文档(link)必须提供 url。" }], details: { ok: false } };
			}
			if (kind === "file" && !p.filePath?.trim()) {
				return { content: [{ type: "text", text: "保存失败：文件(file)必须提供 filePath。" }], details: { ok: false } };
			}
			const r = documents.save({
				name,
				kind,
				url: p.url ?? null,
				filePath: p.filePath ?? null,
				partners: toStringArray(p.partners),
				description: p.description ?? null,
				scenario: p.scenario ?? null,
				tags: toStringArray(p.tags),
			});
			return {
				content: [
					{ type: "text", text: `已保存文档资源「${r.name}」（id=${r.id}，${kind === "link" ? "在线链接" : "文件"}）。` },
				],
				details: { ok: true, id: r.id },
			};
		},
	};

	return [list, provide, save];
}
