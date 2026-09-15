/**
 * `propose_improvement` — write down what should change, with evidence attached.
 *
 * The proposal loop's last mile: telemetry says what is failing (my_stats
 * focus=failures), the model interprets it, and this tool files the result where
 * a human can act on it. Two deliberate constraints:
 *
 *  - **Evidence is not free text.** The tool asks the model for the *statement*
 *    (problem / impact / proposal / verification) and, unless the caller passes
 *    one, attaches the real telemetry snapshot it reads itself — plus the source
 *    label of that snapshot. A proposal whose numbers cannot be traced back to a
 *    statistics call is exactly the fabrication the integrity rules forbid.
 *  - **A proposal is a request, never an action.** The tool writes a file under
 *    `<userData>/proposals/` and reports the path. It does not touch code, config,
 *    permissions, or anything outside that directory, and it does not publish
 *    anything: sharing it is a separate, deliberate act (save_report).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ProposalStore } from "../proposals.js";
import type { TelemetryStore } from "../../db/telemetry-store.js";
import { refuse } from "./admin.js";

export interface ProposalToolDeps {
	proposals: ProposalStore;
	telemetry: TelemetryStore;
	/** Where proposals live, shown to the reader so they can open the file. */
	proposalsDir: string;
}

const MAX_FIELD = 2_000;

/** Reject a field that is empty or absurdly long (a proposal must be readable). */
function field(value: string | undefined, label: string): string | { error: string } {
	const v = (value ?? "").trim();
	if (!v) return { error: `缺少 ${label}：提案必须写清这一项，空着等于没提。` };
	if (v.length > MAX_FIELD) return { error: `${label} 过长（${v.length} 字，上限 ${MAX_FIELD}）。请压缩到要点。` };
	return v;
}

export function createProposeImprovementTool(deps: ProposalToolDeps): AgentTool {
	return {
		name: "propose_improvement",
		label: "改进提案",
		description:
			"把「应该改什么」写成一份可审议的提案，存到本机 proposals 目录并返回路径；也可以列出/关闭已有提案。\n" +
			"action=list：列出提案（含状态、检测次数、路径）。\n" +
			"action=file：新建或追加一份提案，必填 problem（一句话问题）、impact（影响/代价）、proposal（拟怎么改）、verification（怎么算改好了）。" +
			"证据默认由本工具自己从运行统计里取并附在提案里（也可用 evidence 传你自己整理的、且必须来自 my_stats 的内容）——**绝不要编造数字**。\n" +
			"action=resolve：关闭一份提案（id 或问题原文 + reason），关闭后同类问题不再重复上报。\n" +
			"用法：先 my_stats focus=failures 拿到失败聚类与环比，挑「本窗口新增」或明显恶化的 1–3 项来提；同一个问题重复提交会**追加成第 N 次检测**而不是新建文件。\n" +
			"本工具只写提案文件，不改代码、不改配置、不改权限，也不对外发布——那是人审议后的事。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("file"), Type.Literal("resolve")], {
				description: "list=查看；file=新建/追加；resolve=关闭",
			}),
			problem: Type.Optional(Type.String({ description: "action=file 必填：一句话问题描述（它同时是提案的唯一标识）" })),
			impact: Type.Optional(Type.String({ description: "action=file 必填：这个问题造成什么损失/麻烦" })),
			proposal: Type.Optional(Type.String({ description: "action=file 必填：拟怎么改（写清改哪儿、改成什么）" })),
			verification: Type.Optional(Type.String({ description: "action=file 必填：怎么验证有效（尽量用可测的指标）" })),
			evidence: Type.Optional(Type.String({ description: "可选：证据文本；必须来自 my_stats 的真实输出，省略则由本工具自动附加当前统计快照" })),
			source: Type.Optional(Type.String({ description: "可选：证据来源标注，如 my_stats focus=failures hours=168 scope=all" })),
			id: Type.Optional(Type.String({ description: "action=resolve 必填：提案 id 或问题原文" })),
			reason: Type.Optional(Type.String({ description: "action=resolve 必填：关闭理由（采纳并修好了 / 暂不处理的原因）" })),
		}),
		async execute(_toolCallId, params) {
			const p = params as {
				action: "list" | "file" | "resolve";
				problem?: string;
				impact?: string;
				proposal?: string;
				verification?: string;
				evidence?: string;
				source?: string;
				id?: string;
				reason?: string;
			};

			if (p.action === "list") {
				const all = await deps.proposals.list();
				if (all.length === 0) {
					return {
						content: [{ type: "text", text: `还没有任何提案。目录：${deps.proposalsDir}\n做法：先 my_stats focus=failures 看失败聚类，再用 propose_improvement action=file 提交。` }],
						details: { count: 0, dir: deps.proposalsDir },
					};
				}
				const lines = all.map(
					(x) =>
						`  · [${x.status === "open" ? "待处理" : "已关闭"}] ${x.problem}\n    id=${x.id} 检测 ${x.detections} 次，最近 ${new Date(x.lastSeenAt).toISOString().slice(0, 16).replace("T", " ")}\n    ${x.path}`,
				);
				return {
					content: [{ type: "text", text: `共 ${all.length} 份提案：\n${lines.join("\n")}` }],
					details: { count: all.length, open: all.filter((x) => x.status === "open").length, dir: deps.proposalsDir },
				};
			}

			if (p.action === "resolve") {
				const reason = field(p.reason, "reason");
				if (typeof reason === "object") return refuse(reason.error);
				const id = (p.id ?? "").trim();
				if (!id) return refuse("缺少 id：请给出提案 id 或问题原文（可用 action=list 查看）。");
				const done = await deps.proposals.resolve(id, reason);
				if (!done) return refuse(`未找到提案「${id}」。请先用 action=list 确认 id。`);
				return {
					content: [{ type: "text", text: `✅ 已关闭提案「${done.problem}」。同类问题不会再重复上报；如果它再次出现，新的提案会明确标出「此前已解决又复现」。` }],
					details: { ok: true, id: done.id, status: done.status },
				};
			}

			const problem = field(p.problem, "problem");
			if (typeof problem === "object") return refuse(problem.error);
			const impact = field(p.impact, "impact");
			if (typeof impact === "object") return refuse(impact.error);
			const proposal = field(p.proposal, "proposal");
			if (typeof proposal === "object") return refuse(proposal.error);
			const verification = field(p.verification, "verification");
			if (typeof verification === "object") return refuse(verification.error);

			// Evidence: the caller's text must be traceable, so the default is to
			// attach a snapshot this tool reads itself.
			const source = (p.source ?? "").trim() || "my_stats（本工具自动附加的快照）";
			let evidence = (p.evidence ?? "").trim();
			if (!evidence) {
				const snap = deps.telemetry.summary({ hours: 168 });
				const clusters = deps.telemetry.failureClusters({ hours: 168, limit: 5 });
				const trend = deps.telemetry.trend({ hours: 168 });
				evidence =
					`近 168 小时：${snap.turns} 回合，状态 ${Object.entries(snap.byStatus).map(([k, v]) => `${k} ${v}`).join("、") || "（无）"}；` +
					`重试 ${snap.trouble.retried}、步数封顶 ${snap.trouble.stepCapHit}、中断 ${snap.trouble.aborted}、纠错 ${snap.trouble.correction}。\n` +
					`环比：失败 ${trend.previous.failed}→${trend.current.failed}，权限拒绝 ${trend.previous.refusals}→${trend.current.refusals}，纠错 ${trend.previous.corrections}→${trend.current.corrections}。\n` +
					`主要失败聚类：\n${clusters.map((c) => `  · [${c.kind}] ${c.label}：${c.count} 次（上窗口 ${c.prior}）`).join("\n") || "  （无）"}`;
			}

			try {
				const { record, created } = await deps.proposals.file({ problem, impact, proposal, verification, evidence, source });
				return {
					content: [{
						type: "text",
						text:
							(created
								? `✅ 已新建提案「${record.problem}」（id=${record.id}）`
								: `✅ 该问题已有提案，已追加为**第 ${record.detections} 次检测**（id=${record.id}）`) +
							`\n路径：${record.path}\n证据来源：${source}` +
							`\n这是一份待审议的提案：不改代码、不改配置、不改权限，也不会自动对外发布。请把它交给负责人（在单聊里附图/说明，或用 save_report 发布后再发链接）。`,
					}],
					details: { ok: true, created, id: record.id, detections: record.detections, path: record.path },
				};
			} catch (err) {
				const reopening = (err as { reopening?: boolean; record?: { id: string; problem: string } }).reopening;
				if (reopening) {
					const rec = (err as { record: { id: string; problem: string } }).record;
					return refuse(
						`${(err as Error).message}。若确认要重新开启，请先用 action=resolve 关闭它（理由写「修复失效，重新开启」），再提交新提案。`,
					);
				}
				throw err;
			}
		},
	};
}
