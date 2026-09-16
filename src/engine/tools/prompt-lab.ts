/**
 * `prompt_lab` — evaluate a candidate rule text before anyone has to live with it.
 *
 * The split of duties is the whole point: the MODEL proposes the text, the LAB
 * scores it, and the ADMIN decides whether it goes live. A candidate that breaks a
 * critical assertion is rejected by code, no matter how good its average looks —
 * otherwise "optimise the prompt" degenerates into trading the guardrails for
 * points.
 *
 * Actions:
 *   cases    — list / add / enable / disable evaluation cases (seeded with the
 *              red lines we have already been burned by).
 *   run      — score the CURRENT rules (baseline) or a candidate text; stores the
 *              result. Read-only with respect to config.
 *   apply    — write a winning candidate into prompt.rules, with history; requires
 *              an explicit 确认 in the admin's message, because this changes
 *              behaviour for every conversation immediately.
 *   history  — what changed, when, and why.
 *   rollback — undo the most recent apply.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ConfigStore } from "../../db/config-store.js";
import type { CaseKind, PromptLab, VariantScore } from "../../db/prompt-lab.js";
import { isAdmin } from "../../security/permissions.js";
import { refuse, requireConfirmedAdmin, requireSingleChatActor, type ActorContext } from "./admin.js";

export interface PromptLabDeps {
	config: ConfigStore;
	lab: PromptLab;
	resolveActor: (conversationId: string) => ActorContext;
	conversationId: string;
	onConfigChanged: () => void;
	/** Runs one isolated turn with a candidate rules text (engine-provided). */
	runTurn: (input: string, variantText: string) => Promise<string>;
	/** Assembles the system prompt as it would be with a candidate applied. */
	buildPrompt: (variantText: string) => string;
}

/** Human-readable score report. Kept pure so it can be asserted on in tests. */
export function formatScore(score: VariantScore, label: string): string {
	const head = `${label}：${score.passed}/${score.total} 通过（得分 ${(score.score * 100).toFixed(0)}%，基线 ${(score.baseline * 100).toFixed(0)}%）`;
	const failed = score.results.filter((r) => !r.passed);
	const lines = failed.length
		? `\n未通过的用例：\n${failed.map((r) => `  · ${r.critical ? "⚠️关键 " : ""}${r.name}：${r.detail}`).join("\n")}`
		: "\n所有用例通过。";
	const verdict = score.criticalFailures.length
		? `\n\n❌ 不采纳：${score.criticalFailures.length} 个**关键**用例失败（${score.criticalFailures.map((r) => r.name).join("、")}）。关键用例有一票否决权——不允许用总分换掉安全断言。`
		: score.recommended
			? "\n\n✅ 优于基线且无关键用例失败，可以 apply（需要管理员在消息里含「确认」）。"
			: `\n\n➖ 不采纳：得分未超过基线（${(score.score * 100).toFixed(0)}% ≤ ${(score.baseline * 100).toFixed(0)}%）。` +
				"提示词改动必须证明自己更好，而不是「看起来更顺」。";
	return head + lines + verdict;
}

const CASE_KINDS = ["prompt_includes", "prompt_excludes", "reply_matches", "reply_excludes"] as const;

export function createPromptLabTool(deps: PromptLabDeps): AgentTool {
	return {
		name: "prompt_lab",
		label: "提示词实验室",
		description:
			"评测并改进自己的**工作准则**（prompt.rules）：先给候选规则文本打分，只有比基线更好、且没有踩到关键用例的候选才允许生效。\n" +
			"action=cases：列出评测用例；sub=list/add/enable/disable。用例两种：`prompt_includes`/`prompt_excludes` 断言装配后的系统提示词里有没有某段文字（零模型调用，便宜）；`reply_matches`/`reply_excludes` 用 input 跑一个**隔离回合**再断言回复（要模型调用，测的是真行为）。评测跑在隔离会话里，不落库、不进统计、不影响任何真实会话。\n" +
			"action=run：text=<候选规则文本> 打分（省略 text 则只给**当前规则**打基线）；结果会存档。" +
			"注意成本：带候选时**基线也要跑一遍**（否则无从比较），所以 `reply_*` 类用例每个候选会消耗两次真实回合调用；纯 `prompt_*` 类用例零模型调用，可以放开用。\n" +
			"action=apply：把通过的候选写入 prompt.rules（管理员 + 当前消息含「确认」），并记入历史以便回滚。\n" +
			"action=history / rollback：查看变更历史 / 回滚最近一次变更。\n" +
			"用法：从 my_stats focus=failures 的失败聚类出发写候选（**候选文本由你写**），run 打分（**分数由实验室算，你自己不得评判或估算通过率**），通过且优于基线才 apply；失败就把用例的失败详情读一遍再改。\n" +
			"注意：prompt_includes/excludes 类用例测的是红线是否还在（安全、数据真实性、权限身份、定时任务语义等），**关键用例不允许被牺牲**。",
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("cases"), Type.Literal("run"), Type.Literal("apply"), Type.Literal("history"), Type.Literal("rollback")],
				{ description: "cases=评测用例；run=打分；apply=写回；history/rollback=历史与回滚" },
			),
			sub: Type.Optional(
				Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("enable"), Type.Literal("disable")], {
					description: "action=cases 时的子操作，默认 list",
				}),
			),
			name: Type.Optional(Type.String({ description: "action=cases sub=add：用例名（如「不得索要 ID」）" })),
			kind: Type.Optional(Type.Union(CASE_KINDS.map((k) => Type.Literal(k)) as never, { description: "用例类型" })),
			value: Type.Optional(Type.String({ description: "断言值：prompt_* 为要出现/不得出现的文字；reply_* 为正则" })),
			input: Type.Optional(Type.String({ description: "reply_* 用例必填：要跑的真实输入" })),
			critical: Type.Optional(Type.Boolean({ description: "是否关键用例（失败即一票否决），默认 false" })),
			notes: Type.Optional(Type.String({ description: "用例备注：为什么它重要" })),
			id: Type.Optional(Type.String({ description: "action=cases sub=enable/disable、以及 rollback 的目标 id（或用例名）" })),
			text: Type.Optional(Type.String({ description: "action=run/apply：候选规则文本（完整的 prompt.rules 正文）" })),
			rationale: Type.Optional(Type.String({ description: "action=run：这次候选想解决什么（会存档）" })),
			reason: Type.Optional(Type.String({ description: "action=apply：变更理由（会写入历史）" })),
			variantId: Type.Optional(Type.String({ description: "action=apply：要生效的候选 id" })),
		}),
		async execute(_toolCallId, params) {
			const p = params as {
				action: "cases" | "run" | "apply" | "history" | "rollback";
				sub?: "list" | "add" | "enable" | "disable";
				name?: string;
				kind?: CaseKind;
				value?: string;
				input?: string;
				critical?: boolean;
				notes?: string;
				id?: string;
				text?: string;
				rationale?: string;
				reason?: string;
				variantId?: string;
			};

			// Read-only actions: any admin (1:1), no confirmation.
			if (p.action === "cases" || p.action === "history") {
				const gate = requireSingleChatActor(deps);
				if ("content" in gate) return gate;
				if (!isAdmin(deps.config, gate.actor.senderId)) return refuse("你不是本系统的管理员，无权查看评测配置。");

				if (p.action === "history") {
					const rows = deps.lab.history(10);
					if (rows.length === 0) return { content: [{ type: "text", text: "还没有任何提示词变更记录。" }], details: { count: 0 } };
					const lines = rows.map(
						(r) =>
							`  · ${new Date(r.applied_at).toISOString().slice(0, 16).replace("T", " ")} id=${r.id}` +
							`　${r.score_before !== null && r.score_after !== null ? `得分 ${(r.score_before * 100).toFixed(0)}% → ${(r.score_after * 100).toFixed(0)}%　` : ""}` +
							`${r.rolled_back_at ? "（已回滚）" : ""}\n    理由：${r.reason ?? "（未记录）"}`,
					);
					return { content: [{ type: "text", text: `最近 ${rows.length} 次提示词变更：\n${lines.join("\n")}\n回滚最近一次：action=rollback id=<上面的 id>` }], details: { count: rows.length } };
				}

				const sub = p.sub ?? "list";
				if (sub === "list") {
					const cases = deps.lab.listCases(true);
					if (cases.length === 0) {
						return { content: [{ type: "text", text: "还没有评测用例。可用 sub=add 添加；建议至少补一条关键用例。" }], details: { count: 0 } };
					}
					const lines = cases.map(
						(c) =>
							`  · [${c.enabled ? "启用" : "停用"}]${c.critical ? " ⚠️关键" : ""} ${c.name}（${c.check_kind}）\n` +
							`    断言：${c.check_value}${c.input ? `\n    输入：${c.input}` : ""}${c.notes ? `\n    备注：${c.notes}` : ""}`,
					);
					return {
						content: [{ type: "text", text: `共 ${cases.length} 条用例（关键 ${cases.filter((c) => c.critical).length} 条）：\n${lines.join("\n")}` }],
						details: { count: cases.length, critical: cases.filter((c) => c.critical).length },
					};
				}
				if (sub === "enable" || sub === "disable") {
					const id = (p.id ?? "").trim();
					if (!id) return refuse("缺少 id：请给出用例 id 或名称（可用 action=cases 查看）。");
					const target = deps.lab.listCases(true).find((c) => c.id === id || c.name === id);
					if (!target) return refuse(`未找到用例「${id}」。`);
					// Turning OFF a critical case removes a veto — that is a guardrail
					// change, not case administration, so it needs the same explicit
					// 「确认」 as any other change to the safety net.
					if (sub === "disable" && target.critical === 1) {
						const gate = requireConfirmedAdmin(deps, {
							needConfirmation: true,
							confirmationHint: `「${target.name}」是关键用例（失败即一票否决）。停用它等于暂时放弃这条护栏。若确实要停用，请说明原因并在当前消息中包含「确认」。`,
						});
						if ("content" in gate) return gate;
					}
					deps.lab.setCaseEnabled(target.id, sub === "enable");
					return {
						content: [{
							type: "text",
							text:
								`✅ 已${sub === "enable" ? "启用" : "停用"}用例「${target.name}」` +
								(target.critical === 1 && sub === "disable"
									? "。⚠️ 它是一票否决用例：停用期间候选可以在踩掉这条护栏的情况下「通过」评测；请尽快重新启用，或把要改的口径直接写进候选并保持启用。"
									: "。"),
						}],
						details: { ok: true, id: target.id, critical: target.critical === 1 },
					};
				}
				// add
				const name = (p.name ?? "").trim();
				if (!name) return refuse("缺少 name：请给用例起个能看懂的名字。");
				if (!p.kind) return refuse(`缺少 kind：取值 ${CASE_KINDS.join(" / ")}。`);
				const value = (p.value ?? "").trim();
				if (!value) return refuse("缺少 value：请给出要断言的文字或正则。");
				try {
					const created = deps.lab.addCase({ name, kind: p.kind, value, turnInput: p.input, critical: p.critical, notes: p.notes });
					return {
						content: [{ type: "text", text: `✅ 已添加用例「${created.name}」（${created.check_kind}${created.critical ? "，关键" : ""}）。下一步用 action=run 跑一次基线看看当前规则是否已通过。` }],
						details: { ok: true, id: created.id },
					};
				} catch (err) {
					return refuse(err instanceof Error ? err.message : String(err));
				}
			}

			// run: scoring never writes config, so an admin 1:1 is enough.
			if (p.action === "run") {
				const gate = requireSingleChatActor(deps);
				if ("content" in gate) return gate;
				if (!isAdmin(deps.config, gate.actor.senderId)) return refuse("你不是本系统的管理员，无权运行评测。");

				const currentText = deps.config.all().prompt.rules ?? "";
				const baselineScore = await deps.lab.score(currentText, {
					runTurn: deps.runTurn,
					buildPrompt: deps.buildPrompt,
					currentRules: () => currentText,
				});
				if (!p.text?.trim()) {
					return {
						content: [{
							type: "text",
							text:
							formatScore(baselineScore, "当前规则的基线") +
							(deps.lab.disabledCriticalCases().length
								? `\n\n⚠️ 有 ${deps.lab.disabledCriticalCases().length} 条关键用例处于停用状态，基线分同样不覆盖它们。`
								: "") +
							"\n\n想改的话：把完整的候选规则文本用 text 传进来再 run 一次。",
						}],
						details: { ok: true, score: baselineScore.score, passed: baselineScore.passed, total: baselineScore.total, baseline: true },
					};
				}
				const candidate = await deps.lab.score(p.text, {
					runTurn: deps.runTurn,
					buildPrompt: deps.buildPrompt,
					currentRules: () => currentText,
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
				}, baselineScore.score);
				const disabledCritical = deps.lab.disabledCriticalCases();
				const variant = deps.lab.recordVariant({ text: p.text, rationale: p.rationale, score: candidate });
				return {
					content: [{
						type: "text",
						text:
							formatScore(candidate, "候选规则") +
							(disabledCritical.length
								? `\n\n⚠️ 注意：有 ${disabledCritical.length} 条关键用例处于**停用**状态（${disabledCritical.map((c) => c.name).join("、")}），这次评分没有覆盖它们——分数不代表护栏完好。`
								: "") +
							`\n\n候选已存档：id=${variant.id}（状态 ${variant.status}）` +
							(candidate.recommended ? `\n生效：action=apply variantId=${variant.id}，并在消息里带上「确认」。` : ""),
					}],
					details: {
						ok: true,
						variantId: variant.id,
						score: candidate.score,
						baseline: candidate.baseline,
						passed: candidate.passed,
						total: candidate.total,
						criticalFailures: candidate.criticalFailures.map((r) => r.name),
						recommended: candidate.recommended,
					},
				};
			}

			// apply / rollback change behaviour for everyone → 1:1 admin + 「确认」.
			const gate = requireConfirmedAdmin(deps, {
				needConfirmation: true,
				confirmationHint: "这会立刻改变所有会话的工作准则。请确认要在当前消息中包含「确认」。",
			});
			if ("content" in gate) return gate;

			if (p.action === "apply") {
				const variant = p.variantId ? deps.lab.getVariant(p.variantId) : undefined;
				if (p.variantId && !variant) return refuse(`未找到候选 ${p.variantId}。请先 action=run 打分。`);
				const text = (variant?.text ?? p.text ?? "").trim();
				if (!text) return refuse("缺少内容：apply 需要候选规则全文（text），或指定已打分的候选（variantId）。");
				const target = text;
				if (variant && variant.status === "rejected") {
					return refuse(`候选 ${variant.id} 已被判为不采纳（关键用例失败或未超过基线），不能 apply。请修正后重新 run。`);
				}
				const existing = deps.config.all().prompt.rules ?? "";
				const record = deps.lab.apply({
					variantId: variant?.id,
					text: target,
					reason: p.reason ?? "（未记录理由）",
					previousText: existing,
					newText: target,
					scoreBefore: variant ? variant.score ?? undefined : undefined,
					scoreAfter: variant ? variant.score ?? undefined : undefined,
					write: (t) => {
						deps.config.update({ prompt: { rules: t } });
						deps.onConfigChanged();
					},
				});
				return {
					content: [{
						type: "text",
						text:
							`✅ 已生效新的工作准则（历史记录 id=${record.id}）。下一条消息起所有会话都用它。` +
							`\n不满意可以回滚：action=rollback id=${record.id}（只能回滚最近一次）。` +
							`\n注意：安全红线、数据真实性、权限身份这几段是代码里常驻的，不在这份可编辑文本内，回滚也不影响它们。`,
					}],
					details: { ok: true, historyId: record.id, variantId: variant?.id ?? null },
				};
			}

			if (p.action === "rollback") {
				const id = (p.id ?? "").trim();
				if (!id) return refuse("缺少 id：请给出要回滚的历史记录 id（可用 action=history 查看）。");
				try {
					const done = deps.lab.rollback(id, (t) => {
						deps.config.update({ prompt: { rules: t } });
						deps.onConfigChanged();
					});
					if (!done) return refuse(`未找到历史记录 ${id}。`);
					return {
						content: [{ type: "text", text: `✅ 已回滚到变更前的准则（记录 id=${done.id}）。` }],
						details: { ok: true, historyId: done.id },
					};
				} catch (err) {
					return refuse(err instanceof Error ? err.message : String(err));
				}
			}

			return refuse(`未知 action「${p.action}」。`);
		},
	};
}
