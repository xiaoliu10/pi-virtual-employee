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

/**
 * Signals that a request is a DEEP task regardless of its verb or plan
 * (field 2026-11-06, Nova): 「去 sls 帮我查一下这比流水」 sat in the single chat's
 * serial queue behind another task for 40+ minutes. It matches none of the
 * "long-running" verbs, and the side pass produced no plan that day — so the
 * Router never dispatched it and two unrelated jobs serialized in one chat.
 *
 * A request that names an EXTERNAL SYSTEM and an investigation/collection
 * action is minutes of work by nature: browser automation, log queries,
 * 堡垒机/跳板机 hops. It must go to a Worker even without a plan.
 */
const EXTERNAL_SYSTEM_MARKERS: readonly RegExp[] = [
	/\bsls\b/i, /日志/, /堡垒机/, /跳板机/, /后台系统/, /管理端/, /控制台/,
	/数据库|\bdb\b/i, /\bapi\b/i, /接口/, /工单/,
];

const DEEP_TASK_VERBS: readonly string[] = [
	"查一下", "查查", "查询", "排查", "定位", "分析", "核对", "对一下",
	"取一下", "拉一下", "导一下", "跑一下", "看一下日志", "追一下",
];

/** True when the message names an external system AND an investigation action. */
export function isDeepTask(text: string): boolean {
	const t = text ?? "";
	if (!EXTERNAL_SYSTEM_MARKERS.some((re) => re.test(t))) return false;
	return DEEP_TASK_VERBS.some((v) => t.includes(v));
}

/** Pure conversation, never work: greetings, thanks, short acknowledgements. */
/**
 * Acknowledgement vocabulary. A message made ENTIRELY of these (plus
 * punctuation) is conversation, however long: 「好的，收到，谢谢啊」 must never
 * become a background task.
 */
const SMALL_TALK_WORDS: readonly string[] = [
	"你好", "您好", "在吗", "哈喽", "hello", "hi", "hey", "早上好", "晚上好", "下午好", "早安", "晚安",
	"谢谢", "多谢", "感谢", "辛苦了", "麻烦你了",
	"好的", "好滴", "好嘞", "收到", "明白", "了解", "知道了", "没问题", "可以", "行", "好",
	"嗯", "哦", "ok", "okay",
	// Sentence-final particles: 「好的，收到，谢谢啊」/「明白了，辛苦了」 leave one
	// of these behind after the words above are stripped.
	"啊", "了", "呢", "吧", "呀", "哈", "啦", "嘛", "的",
];

/** True for greetings/acknowledgements — the only chat that never routes. */
export function isSmallTalk(text: string): boolean {
	const t = (text ?? "").trim();
	if (!t || t.length > 40) return false;
	// Strip punctuation and every acknowledgement word, then require nothing
	// meaningful to remain. Word list instead of one regex so 「好的，收到，谢谢啊」
	// and 「好的收到」 behave identically.
	let rest = t.replace(/[\s，,。.!！?？~、;；\-—…·]+/g, "");
	for (const w of SMALL_TALK_WORDS) rest = rest.split(w).join("");
	return rest.length === 0;
}
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
	reason: "disabled" | "not-task" | "no-plan" | "too-few-steps" | "no-long-verb" | "question" | "dispatch" | "deep-task" | "task" | "chat";
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
	// A short utterance is chat ONLY when it carries no task verb: 「导出昨天的报表」
	// is 7 chars and clearly a task. The old blanket "≤12 chars = chat" rule made
	// the Router an executor for exactly the short instructions users type most.
	if (t.length <= 12 && !/[，,。\n]/.test(t) && !TASK_VERB_HINT.test(t)) return true;
	return QUESTION_MARKERS.some((re) => re.test(t));
}

/** Cheap task-verb hint used to keep short INSTRUCTIONS out of the "chat" bucket.
 * Deliberately broad: a false positive routes a short task (correct), while a
 * false negative would execute it in the Router (the architecture violation). */
const TASK_VERB_HINT = /登录|抓取|爬|下载|整理|汇总|生成|监控|巡检|对账|采集|导出|导入|推送|部署|排查|分析|批量|核对|配置|查询|查一下|跑到|跑一遍|执行|重跑|迁移|备份|归档|修复|改一下|写个|写一个|建一个|创建|删除|清理|安装|升级/;

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
	const steps = countPlanSteps(input.plan);
	// ARCHITECTURE (docs/design/router-worker.md §3, user ruling 2026-11-06):
	// the Router does not EXECUTE tasks — it routes them. Every task-shaped
	// message goes to a Worker; only explicit non-task shapes stay foreground.
	// The earlier "conservative" flip (dispatch only with a plan AND a long verb)
	// made the Router an executor: two unrelated jobs then serialized inside one
	// chat's queue and the user correctly observed "VE runs globally serial".
	//
	// What still stays in the foreground is decided by SHAPE, never by how much
	// work it looks like:
	//   · questions — 「日志在哪？」「sls 查询失败了吗？」 (asking must stay chat)
	//   · conversation openers / pleasantries
	//   · commands (/stop, /new …) — handled long before this function
	// Everything else that looks like a task is routed, plan or no plan: a
	// Worker window plans for itself from the raw instruction.
	if (isQuestion(text)) return { dispatch: false, reason: "question", steps };
	if (isSmallTalk(text)) return { dispatch: false, reason: "chat", steps };
	return { dispatch: true, reason: isDeepTask(text) ? "deep-task" : "task", steps };
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
