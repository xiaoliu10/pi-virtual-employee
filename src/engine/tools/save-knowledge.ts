import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { KnowledgeService } from "../../knowledge/knowledge-service.js";
import { deriveMemoryContext, ownerForScope, type MemoryScope } from "../../knowledge/memory-scope.js";
import { CONFLICT_HINT_TEMPLATE, findTitleConflict, looksShortLived, memoryPhrasingHint } from "../../knowledge/memory-write.js";
import { isLocalConversation, resolveRole, type Role } from "../../security/permissions.js";
import type { ConfigStore } from "../../db/config-store.js";
import type { InboundActor } from "../../im/types.js";

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

/**
 * Build the memory-capture tool. Memory entries are scoped KB entries tagged
 * "memory"; their index is injected into every relevant session (query-free
 * recall). Scope/owner are derived SERVER-SIDE from the verified turn actor —
 * the model can hint a wider scope but cannot name an owner or staffId, so a
 * message/web/file can never write to another person's or group's memory.
 *
 *  - person (default): one platform identity, across that person's chats.
 *  - conversation: one IM group; requires operator+. Only honored in a group.
 *  - profile: whole-profile shared; requires admin (or the local console).
 *
 * Same (scope,owner,title) overwrites in place — a correction replaces the
 * old fact. `onSaved` bumps the engine's prompt revision so live sessions pick
 * up the new index.
 */
export function createRememberTool(deps: {
	knowledge: KnowledgeService;
	/** Verified actor for the live turn (undefined in the local console). */
	resolveActor: () => (InboundActor & { text?: string }) | undefined;
	conversationId: string;
	config: ConfigStore;
	onSaved?: () => void;
}): AgentTool {
	return {
		name: "remember",
		label: "记住要点",
		description:
			"把长期事实写入记忆：对方的偏好、对做法的纠正、稳定环境情况（「我是…」「以后…」「记住…」「别再…」）。" +
			"记忆默认按本人隔离（这个人在任何会话都生效）；明确说「本群/这个群记住」时按当前群隔离；明确要求「所有人/全局记住」时写入全配置共享记忆（仅管理员）。" +
			"不要用于客观知识（规则/流程/地址 → save_to_knowledge）或操作步骤（→ save_to_skill）。同范围同标题重存会纠正覆盖旧记忆。" +
			"**正文写成陈述事实，不要写祈使句**（「对方偏好可复制文本框」✓，「始终用可复制文本框」✗——记忆会被后续会话当作命令执行，可能压过对方当时的真实诉求）。" +
			"**一周内就会过时的事不要写进记忆**（「今天/明天下单」这类），只记长期稳定的部分。",
		parameters: Type.Object({
			title: Type.String({ description: "记忆标题，简明点名主题（如「张工偏好：prompt 用可复制文本框交付」）" }),
			content: Type.String({ description: "记忆正文：一到三句话写清事实与适用语境；纠正时直接写新事实，不要包含已作废的旧说法" }),
			summary: Type.Optional(Type.String({
			description: "可选一行索引摘要（≤60字），用于每次会话自动携带；不填则只携带标题",
			})),
			scope: Type.Optional(Type.Union(
				[Type.Literal("person"), Type.Literal("conversation"), Type.Literal("profile")],
				{ description: "记忆范围：person=仅本人（默认）；conversation=当前群；profile=全配置共享（需管理员）" },
			)),
		}),
		async execute(_toolCallId, params) {
			const p = params as { title: string; content: string; summary?: string; scope?: "person" | "conversation" | "profile" };
			try {
				const actor = deps.resolveActor();
				const local = isLocalConversation(deps.conversationId);
				const ctx = deriveMemoryContext(actor, deps.conversationId);
				const role: Role = local ? "admin" : (actor?.channel === "widget"
					? (actor.verifiedRole && ["admin", "operator", "viewer"].includes(actor.verifiedRole) ? actor.verifiedRole : "viewer")
					: resolveRole(deps.config, actor?.senderId));
				const isAdmin = (): boolean => role === "admin";
				const isAtLeastOperator = (): boolean => role !== "viewer";

				// Resolve the effective scope.
				let scope: MemoryScope = "person";
				let downgradedFrom: MemoryScope | undefined;
				if (local) {
					scope = "profile"; // console is the trusted admin surface
				} else if (p.scope === "profile") {
					if (!isAdmin()) {
						// Fail safe by actually writing a person-scoped fact, not by
						// returning success language without persisting anything.
						downgradedFrom = "profile";
						scope = "person";
					} else {
						scope = "profile";
					}
				} else if (p.scope === "conversation") {
					if (!ctx.conversationOwner || actor?.chatType !== "group" || !isAtLeastOperator()) {
						downgradedFrom = "conversation";
						scope = "person";
					} else {
						scope = "conversation";
					}
				} // Default/explicit person stays owner-scoped; anonymous remote turns fail closed below.

				const owner = ownerForScope(scope, ctx);
				// A scope that needs an owner but has none must fail closed (never
				// silently widen another person's memory into profile).
				if (scope !== "profile" && !owner) {
					return {
						content: [{ type: "text", text: "当前缺少可验证的发送者身份，无法写入个人/群级记忆。" }],
						details: { ok: false, reason: "no-verified-actor" },
					};
				}

				const summary = p.summary?.trim().slice(0, 120) || p.title.trim().slice(0, 120);

				// Write-time advisories. All are non-blocking hints: the fact is still
				// persisted (a rejected memory is a lost fact), but the model is told
				// what will rot or collide so it can correct itself in the same turn.
				const advisories: string[] = [];
				// Conflict detection is an advisory, never a precondition: a read
				// failure must not block persisting a fact the user asked to remember.
				const siblings = (() => {
					try {
						// Read-only preview: a title comparison must not be recorded as a
						// real recall (it would inflate the usage prior).
						return deps.knowledge
							.peekMemoryTitles({ personOwner: ctx.personOwner, conversationOwner: ctx.conversationOwner }, 50)
							.map((m) => ({ id: m.id, title: m.title, summary: m.snippet }));
					} catch {
						return [];
					}
				})();
				const nearDup = findTitleConflict(p.title, siblings);
				if (nearDup) {
					advisories.push(
						CONFLICT_HINT_TEMPLATE.replace("{title}", nearDup.title).replace("{summary}", nearDup.summary || "无摘要"),
					);
				}
				const shortLived = looksShortLived(p.content);
				if (shortLived) advisories.push(shortLived);
				const phrasing = memoryPhrasingHint(p.content);
				if (phrasing) advisories.push(phrasing);

				const r = deps.knowledge.saveMemory({
					title: p.title,
					content: p.content,
					scope: scope === "profile" ? null : scope,
					owner,
					summary,
				});
				deps.onSaved?.();
				const scopeLabel = scope === "profile" ? "全配置共享" : scope === "conversation" ? "本群" : "你本人";
				const downgradeNote = downgradedFrom
					? downgradedFrom === "profile"
						? "（你没有全配置共享记忆权限，已按你本人记忆保存；如需全员生效请管理员确认。）"
						: "（当前会话不满足群级记忆条件，已按你本人记忆保存。）"
					: "";
				return {
					content: [{ type: "text", text:
						(r.merged ? `已更新${scopeLabel}记忆「${p.title}」（旧内容已纠正覆盖）。` : `已记住${scopeLabel}记忆「${p.title}」，之后相关会话自动携带。`) +
						downgradeNote +
						(advisories.length ? `\n\n${advisories.join("\n")}` : "") }],
					details: { ok: true, id: r.id, merged: r.merged, scope, owner, downgradedFrom },
				};
			} catch (err) {
				return { content: [{ type: "text", text: `记忆保存失败：${(err as Error).message}` }], details: { ok: false } };
			}
		},
	};
}
