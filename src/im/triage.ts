/**
 * Router triage — decides whether an IM message runs inline (foreground turn)
 * or is dispatched to a background work item (Worker).
 *
 * DESIGN (docs/design/router-worker.md, D1): triage is CONSERVATIVE. Sending a
 * simple question to the background is the worst possible experience
 * (「你好」→「已转后台执行」), so dispatch needs POSITIVE evidence on two axes:
 *
 *   1. the plan the side pass produced has ≥2 numbered steps, AND
 *   2. the message contains a long-running action verb (部署/抓取/批量/爬取/
 *      监控/导出/登录+X …).
 *
 * Anything else — including EVERY failure mode (no plan, LLM down, malformed
 * plan, single step, short question) — stays in the foreground exactly as
 * before. A triage failure must never turn a message into a black hole.
 *
 * This module is pure (no I/O, no config) so the thresholds are testable
 * without a model.
 */

/** Verbs that imply work measured in minutes, not seconds. */
const LONG_RUNNING_VERBS: readonly string[] = [
	"部署", "上线", "发布",
	"抓取", "爬取", "采集", "批量", "遍历", "循环处理",
	"监控", "持续观察", "持续盯", "轮询", "定时",
	"录入", "导入", "导出", "生成报告", "生成日报", "生成报表", "对账", "核对全部",
	"全量", "重跑", "回放", "迁移", "备份", "归档",
	"跑完", "跑一遍", "跑测试", "编译", "构建", "打包",
	"下载全部", "下载所有", "逐条", "逐个",
];
// Review probe 2026-11-04: 「老板天天盯着我们」「周末去爬山」 + a 2-step plan
// both mis-dispatched because the single characters 盯/爬 match casual chat.
// Only multi-character forms stay.

/** Verbs that are explicitly SHORT — presence forces the foreground even if a
 *  long verb also appears (「监控脚本在哪」is a question about a script). */
const QUESTION_MARKERS: readonly RegExp[] = [
	/^(请问|问下|问一下|帮我查一下|查一下|查查)/,
	/(在哪|是什么|什么意思|为什么|怎么回事|怎么样|吗|呢)[？?]?$/,
	/^\s*(你好|在吗|hi|hello)/i,
	// Leading interrogatives: 「为什么昨天的对账任务又失败了帮我重新对一遍」 has
	// no ending marker — the ending-anchored rules above let it mis-dispatch
	// (review probe 2026-11-04). A message that OPENS with a question word is a
	// question even when it later contains task verbs.
	/^(为什么|怎么|如何|啥|什么)[，,？?]/,
];

export interface TriageInput {
	/** The raw user message. */
	text: string;
	/** The plan text the side pass produced, or undefined when it produced none. */
	plan?: string;
	/** Whether the structural task detector fired (looksLikeTask). */
	looksLikeTask: boolean;
}

export interface TriageDecision {
	/** true → dispatch to a background work item. */
	dispatch: boolean;
	/** Machine-readable reason, always populated (for logs and tests). */
	reason: "disabled" | "not-task" | "no-plan" | "too-few-steps" | "no-long-verb" | "question" | "dispatch";
	/** Number of numbered steps found in the plan (0 when no plan). */
	steps: number;
}

/**
 * Count numbered plan steps. Accepts the shapes the planner actually emits
 * (`1. …`, `1) …`, `1、…`, `1．…`) and ignores numbering that appears mid-line
 * (「第 1 步」inside prose is not a step).
 */
export function countPlanSteps(plan: string | undefined): number {
	if (!plan) return 0;
	let max = 0;
	for (const line of plan.split(/\r?\n/)) {
		// Same separator set as parsePlan ([.、）)]), so the step count the
		// triage sees matches the plan the parser accepted (review P2-2: the
		// fullwidth ） was counted by parsePlan but not here → safe undercount).
		const m = /^\s*(\d{1,2})\s*[.)、）．]\s*\S/.exec(line);
		if (!m) continue;
		const n = Number(m[1]);
		// Require the sequence to start at 1 and stay monotonic-ish; a stray
		// "2." inside a sentence must not inflate the count.
		if (n === max + 1) max = n;
	}
	return max;
}

/** Does the message ask a question (which must never go to the background)? */
export function isQuestion(text: string): boolean {
	const t = (text ?? "").trim();
	if (!t) return true; // empty → nothing to dispatch
	if (t.length <= 12 && !/[，,。\n]/.test(t)) return true; // short utterance = chat
	return QUESTION_MARKERS.some((re) => re.test(t));
}

/** Any long-running verb present? */
export function hasLongRunningVerb(text: string): boolean {
	const t = text ?? "";
	return LONG_RUNNING_VERBS.some((v) => t.includes(v));
}

/**
 * The triage itself. `enabled` mirrors the `chatDispatch` flag (default on);
 * explicitly disabling it restores the old inline behaviour.
 */
export function triageMessage(input: TriageInput, enabled: boolean): TriageDecision {
	if (!enabled) return { dispatch: false, reason: "disabled", steps: 0 };
	const text = input.text ?? "";
	if (!input.looksLikeTask) return { dispatch: false, reason: "not-task", steps: 0 };
	if (!input.plan) return { dispatch: false, reason: "no-plan", steps: 0 };
	const steps = countPlanSteps(input.plan);
	if (steps < 2) return { dispatch: false, reason: "too-few-steps", steps };
	// A question mark / question shape wins over any verb: 「监控脚本还在跑吗」.
	if (isQuestion(text)) return { dispatch: false, reason: "question", steps };
	if (!hasLongRunningVerb(text)) return { dispatch: false, reason: "no-long-verb", steps };
	return { dispatch: true, reason: "dispatch", steps };
}

/**
 * The escape hatch advertised in the ACK (design D6 / risk table): the user can
 * always pull the work back into the foreground.
 */
export const FOREGROUND_ESCAPE_HINT = "如需改为前台执行，回复「前台执行」";

/**
 * Exact foreground-escape phrase match, with isAuthorizationPhrase's punctuation
 * tolerance. A bare 「前台执行」 pulls a chat-dispatched item back inline; any
 * longer sentence containing those words is ordinary text and must NOT hijack
 * a real request.
 */
export function isForegroundEscape(raw: string): boolean {
	const t = (raw ?? "").trim().replace(/^[!！。.?？、,，…\s]+/, "").replace(/[!！。.?？、,，…\s]+$/, "");
	return t === "前台执行";
}
