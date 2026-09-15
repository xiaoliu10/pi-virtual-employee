/**
 * Self-inspection: the employee reading its own run telemetry.
 *
 * This is the piece that makes any self-improvement loop possible at all — without
 * it, "我最近表现如何 / 为什么老失败" can only be answered from the last few
 * messages in context or, worse, guessed. Reads `TelemetryStore` (turn_events /
 * tool_events) and reports real counts only.
 *
 * Scope is graded, mirroring the rest of the permission model:
 *  - `scope: "conversation"` (default) — the asking chat's own turns. Any operator.
 *  - `scope: "all"` — every conversation's turns, which includes failure text and
 *    traffic from other people's chats. admin only.
 * The capability gate (`telemetry`, operator) is applied by the RBAC wrapper at
 * registration; the admin-only rule for the full view is enforced here.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ConfigStore } from "../../db/config-store.js";
import { isAdmin } from "../../security/permissions.js";
import type { TelemetrySummary } from "../../db/telemetry-store.js";
import type { TelemetryStore } from "../../db/telemetry-store.js";
import { refuse, type ActorContext } from "./admin.js";

export interface StatsToolDeps {
	config: ConfigStore;
	resolveActor: (conversationId: string) => ActorContext;
	conversationId: string;
	telemetry: TelemetryStore;
}

const STATUS_LABEL: Record<string, string> = {
	ok: "正常",
	error: "报错",
	aborted: "被中断",
	empty_reply: "无正文（靠兜底总结收尾）",
	deterministic_failure: "彻底失败（兜底文案）",
};

/** Render one summary as the tool's answer. Pure so it can be tested directly. */
export function formatSummary(s: TelemetrySummary): string {
	const scope = s.scopedToConversation ? "本会话" : "全部会话";
	if (s.turns === 0) {
		return `近 ${s.hours} 小时（${scope}）没有任何回合记录：要么还没有人说话，要么运行记录刚被清理。这不是"表现正常"，是"没有数据"。`;
	}
	const statuses = Object.entries(s.byStatus)
		.map(([k, v]) => `${STATUS_LABEL[k] ?? k} ${v}`)
		.join("、");
	const trouble = [
		s.trouble.retried ? `网络/流式中断后重试 ${s.trouble.retried}` : null,
		s.trouble.stepCapHit ? `工具步数封顶 ${s.trouble.stepCapHit}` : null,
		s.trouble.emptyReply ? `无正文靠兜底总结 ${s.trouble.emptyReply}` : null,
		s.trouble.deterministicFailure ? `彻底失败 ${s.trouble.deterministicFailure}` : null,
		s.trouble.aborted ? `被中断（超时看门狗等）${s.trouble.aborted}` : null,
		s.trouble.correction ? `用户当场纠错 ${s.trouble.correction}` : null,
	].filter(Boolean) as string[];
	const lines = [
		`近 ${s.hours} 小时（${scope}）：${s.turns} 个回合，状态 ${statuses}；平均耗时 ${Math.round(s.avgDurationMs / 1000)} 秒，共 ${s.toolCalls} 次工具调用。`,
		trouble.length ? `需要关注的：${trouble.join("；")}。` : "没有出现重试、封顶、中断或纠错。",
	];
	if (s.failingTools.length) {
		lines.push(
			`失败最多的工具：\n${s.failingTools
				.map((t) => `  · ${t.name}：调用 ${t.calls} 次，失败 ${t.failed} 次${t.refused ? `（其中权限拒绝 ${t.refused} 次）` : ""}`)
				.join("\n")}`,
		);
	}
	if (s.recentErrors.length) {
		lines.push(`最近的错误样本：\n${s.recentErrors.map((e) => `  · ${e}`).join("\n")}`);
	}
	if (s.perDay.length > 1) {
		lines.push(`每日：${s.perDay.map((d) => `${d.day.slice(5)} ${d.turns} 回合${d.failed ? `（失败 ${d.failed}）` : ""}`).join("；")}`);
	}
	lines.push(
		"读法：工具反复失败先分清是「权限被拒」还是「参数/环境错误」——前者用 check_my_access 核对并如实转达所需权限，" +
			"后者说明具体报错；「用户当场纠错」次数高说明我给的答案/口径有偏差，应把正确口径沉淀进知识库或技能，而不是重复解释。" +
			"这些数字只来自真实运行记录，不要在本工具返回之外补充任何统计。",
	);
	return lines.join("\n\n");
}

export function createMyStatsTool(deps: StatsToolDeps): AgentTool {
	return {
		name: "my_stats",
		label: "运行统计",
		description:
			"查看自己（本员工）真实的运行统计：回合数、成功/失败分布、网络重试、工具步数封顶、空回复、被超时看门狗中断、用户当场纠错的次数，" +
			"以及失败最多的工具和最近的错误样本。用于回答「你最近表现怎么样」「为什么老是失败」「哪类任务老出问题」，或在自己要改进流程前先看数据。" +
			"scope=conversation（默认）只看当前会话；scope=all 看全部会话，仅管理员可用。工具被权限拒绝的次数也在统计里。" +
			"所有数字都来自本地运行记录，据实报告，不要估算或补充记录之外的数据。",
		parameters: Type.Object({
			hours: Type.Optional(Type.Number({ description: "统计最近多少小时，默认 24，最大 720（30 天）" })),
			scope: Type.Optional(
				Type.Union([Type.Literal("conversation"), Type.Literal("all")], {
					description: "conversation=仅当前会话（默认）；all=全部会话（仅管理员）",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const { hours, scope } = params as { hours?: number; scope?: "conversation" | "all" };
			const window = Math.min(720, Math.max(1, Math.round(hours ?? 24)));
			const wantAll = scope === "all";
			const actor = deps.resolveActor(deps.conversationId);
			if (wantAll && !isAdmin(deps.config, actor?.senderId)) {
				return refuse(
					"全部会话的运行统计仅管理员可查（它包含其它会话的失败细节）。你可以省略 scope 或传 conversation 查看本会话的统计。",
				);
			}
			const summary = deps.telemetry.summary({
				hours: window,
				...(wantAll ? {} : { conversationId: deps.conversationId }),
			});
			return {
				content: [{ type: "text", text: formatSummary(summary) }],
				details: {
					hours: window,
					scope: summary.scopedToConversation ? "conversation" : "all",
					turns: summary.turns,
					byStatus: summary.byStatus,
					trouble: summary.trouble,
					failingTools: summary.failingTools,
				},
			};
		},
	};
}
