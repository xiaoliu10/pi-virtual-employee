/**
 * Task planning ahead of execution (field request 2026-11-03, user ruling):
 * before VE starts working on a task-shaped message, produce a SHORT step plan
 * and push it to the originating chat — the user sees WHAT will happen before
 * anything runs. The plan is a side LLM pass; execution itself is unchanged
 * (the plan text is prepended to the turn as context so the agent honors what
 * was promised).
 *
 * Deliberately NOT a router/worker rewrite: one side pass + one push closes
 * the "black box until the final report" gap without touching the durable
 * session model, delivery paths, or RBAC.
 */

/** Heuristic: does this message look like a multi-step TASK (vs a question or
 *  a quick command)? Cheap, deterministic, tested.
 *
 * Length is deliberately NOT a gate (field 2026-11-03: real instructions like
 * 「部署一下测试环境，跑通之后把日志发我」 are 18 chars and ARE tasks — a 30-char
 * floor silently dropped most of them). What qualifies is STRUCTURE: a task
 * verb plus multi-step evidence (sequencing words, a numbered list, several
 * sentences). Doubt stays unplanned — a false plan on a question is noise. */
export const TASK_VERBS = [
		"登录", "抓取", "爬", "下载", "整理", "汇总", "生成", "监控", "巡检", "对账", "采集",
		"导出", "推送", "部署", "排查", "分析", "批量", "自动化", "跟踪", "核对", "注册", "配置",
		"打开", "访问", "上传", "同步", "重启",
		"write", "build", "deploy", "scrape", "crawl", "download", "generate", "monitor", "automate", "analyze",
	];

/**
 * Question-shaped endings — 「登录密码是什么」 is Q&A, never an imperative, even
 * though it carries a task verb.
 */
const QUESTION_SHAPE_RE = /(在哪|是什么|什么意思|为什么|怎么回事|怎么样|吗|呢)[？?？]?\s*$/;
/** Mid-sentence question words (review 94189d6f P2): 「帮我分析下为什么登录失败」
 * starts like an imperative but asks for an explanation anywhere in the text —
 * an unanchored probe rejects them wherever they appear. */
const QUESTION_WORD_RE = /(为什么|怎么回事|怎么|什么意思|什么区别|是什么意思|如何|为何|哪些|哪里|哪儿|何处|多少|几|什么|在哪)/;
const IMPERATIVE_LEAD_RE = /^(继续|接着|然后|帮我|帮忙|请|麻烦|开始|执行|先|去|再|尝试)/;
/**
 * Short imperative task commands the shape detectors miss: 「继续 登录生产后台
 * 管理」 (11 chars) carries a task verb but no multi-step evidence, so
 * looksLikeTask is false and the message used to fall to a FOREGROUND turn
 * whose pure-narration reply ("我来尝试登录…") got delivered as the final
 * answer while the task never ran (field 2026-11-09). Question-shaped texts
 * (「登录密码是什么」) stay Q&A.
 */
export function looksLikeImperative(text: string): boolean {
	const t = (text ?? "").trim();
	if (!t) return false;
	if (QUESTION_SHAPE_RE.test(t) || QUESTION_WORD_RE.test(t)) return false;
	if (!TASK_VERBS.some((v) => t.toLowerCase().includes(v))) return false;
	return IMPERATIVE_LEAD_RE.test(t) || TASK_VERBS.some((v) => t.startsWith(v));
}

export function looksLikeTask(message: string): boolean {
	const text = message.trim();
	if (!text) return false;
	if (text.length > 4_000) return true; // a 4KB brief is a task by construction
	// Task verbs (zh/en) — logging in, downloading, organizing, generating, monitoring, writing...
	const lower = text.toLowerCase();
	const hits = TASK_VERBS.filter((v) => lower.includes(v)).length;
	if (hits === 0) return false;
	// Multi-step evidence: numbered list, several sentences, or sequencing words.
	const multiStep = /\n|。|；|;|然后|接着|之后|再|并且|同时|以及|最后|第一步|第[一二三]|\d+[.、）)]|，.*(然后|接着|之后|并且|同时)/.test(text);
	// A bare task verb alone ("登录") is a single-step command: require either
	// multi-step evidence or a message long enough to carry detail (a path, a
	// condition, a target).
	return multiStep || text.length >= 40;
}

/**
 * Delivery-time notice appended when the narration guard's forced continuation
 * STILL produced zero tool calls (field 2026-11-09: 「我来尝试登录…先检查工具」
 * then silence — the user ruled process-narration replies unwanted). Shared by
 * both kernels so the wording has one spelling; it is a runtime notice, not
 * employee speech — the synthetic-fallback drop (durable import + startup
 * sweep) keeps it from being replayed into a transcript and imitated.
 */
export const NARRATION_GUARD_NOTICE = "⚠️ 已尝试继续执行但模型没有实际动作；如需前台亲自执行请回复『前台执行』。";

/** The plan prompt: short, numbered, verifiable steps; nothing else. */
export const PLAN_PROMPT_HEADER =
	"请判断下面这条消息是否是一个需要多步骤执行的任务。如果是，输出以下四部分；如果只是简单问答或单步操作，只输出 NO_PLAN。\n" +
	"第一行：耗时：<预计总耗时，写成 5分钟 / 20分钟 / 1小时 / 3小时 这类形式>\n" +
	"第二行：目标：<一句话说明要达成什么，人话，不要术语堆砌>\n" +
	"第三行：流程：<用一句话说明怎么做的，2-4 个动词短语用 → 连接即可>\n" +
	"然后 3-6 行编号步骤（每步一行，动词开头，可验证）—— 这是给执行器看的，会被自动隐藏。\n" +
	"不要输出任何其他解释。消息如下：";

/** A parsed plan: the model's estimate, the human summary, and the raw steps. */
export interface ParsedPlan {
	/** Estimated total duration in minutes (0 when the model gave nothing usable). */
	estimatedMinutes: number;
	/** One-line goal in plain language. */
	goal: string;
	/** Short flow rendered for a chat message, e.g. "登录 spay → 抓取账单 → 导出 Excel". */
	flow: string;
	/** The full mechanical plan (kept for the executing turn, NOT shown in chat). */
	steps: string;
}

/**
 * Parse a duration the model wrote in Chinese or English.
 *
 * Accepts 5分钟 / 20 分 / 1小时 / 1.5h / 2 天 / 半小时 and returns MINUTES.
 * Returns 0 when unparseable — callers treat 0 as "unknown", never as "long".
 */
export function parseDurationMinutes(raw: string | undefined): number {
	const t = (raw ?? "").trim();
	if (!t) return 0;
	if (/半\s*(个)?\s*小时/.test(t)) return 30;
	const m = /(\d+(?:\.\d+)?)\s*(分钟|分|小时|个小时|h|hr|hrs|hour|hours|天|day|days)/i.exec(t);
	if (!m) return 0;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return 0;
	const unit = m[2].toLowerCase();
	if (/天|day/.test(unit)) return Math.round(n * 1_440);
	if (/小时|个小时|^h$|hr|hour/.test(unit)) return Math.round(n * 60);
	return Math.round(n); // 分钟 / 分
}

/**
 * Default threshold for showing a plan in chat: 30 minutes.
 *
 * User ruling 2026-11-04: a task that finishes in a minute does not need a plan
 * pushed into the conversation — the plan is noise there. Planning still RUNS
 * (the executing turn gets the steps as context); only the chat message is
 * gated. Declared here so the chat and the engine agree on one number.
 */
export const PLAN_CHAT_THRESHOLD_MIN = 30;

/** Parse the side pass output. Returns null when the model said NO_PLAN (or
 *  produced something unusable) — the caller then skips planning silently. */
export function parsePlan(raw: string | undefined): ParsedPlan | null {
	if (!raw) return null;
	const text = raw.trim();
	if (!text || /^NO_PLAN\b/i.test(text)) return null;
	// Must contain a 目标 line and at least 2 numbered steps to count as a plan.
	if (!/目标[：:]/.test(text)) return null;
	const numbered = (text.match(/^\s*\d+[.、）)]/gm) ?? []).length;
	if (numbered < 2) return null;
	const lineOf = (label: RegExp): string => {
		const m = label.exec(text);
		if (!m) return "";
		return (text.slice(m.index + m[0].length).split(/\r?\n/, 1)[0] ?? "").trim();
	};
	const estimatedMinutes = parseDurationMinutes(lineOf(/耗时[：:]/));
	const goal = lineOf(/目标[：:]/);
	const flow = lineOf(/流程[：:]/);
	// Clamp length: a plan longer than the task brief itself is noise.
	const steps = text.length > 1_200 ? text.slice(0, 1_200) + "…" : text;
	return { estimatedMinutes, goal, flow, steps };
}

/** The mechanical plan handed to the executing turn (never shown verbatim). */
export function formatPlanForTurn(plan: ParsedPlan): string {
	return plan.steps;
}

/**
 * The user-facing chat message — SHORT and human (user ruling 2026-11-04:
 * 「发送到 im 的规划 我更希望知道 简单的流程就好了」).
 *
 * Drops the numbered steps entirely: what a person in a chat wants is "what are
 * you about to do, roughly how long". The steps still exist — they are handed to
 * the turn as context — they just don't get pasted into the conversation.
 */
export function formatPlanMessage(plan: ParsedPlan): string {
	const head = plan.goal || "开始处理";
	const flow = plan.flow?.trim();
	const eta = plan.estimatedMinutes > 0 ? `\n⏱ 预计约 ${formatDuration(plan.estimatedMinutes)}` : "";
	const body = flow ? `\n${flow}` : "";
	return `📋 ${head}${body}${eta}`;
}

/** 95 → "1 小时 35 分"（取整到能读的程度）。 */
export function formatDuration(minutes: number): string {
	if (minutes < 60) return `${Math.round(minutes)} 分钟`;
	const h = Math.floor(minutes / 60);
	const m = Math.round(minutes % 60);
	return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

/**
 * Should the plan be PUSHED to the chat? Only for long work (user ruling:
 * 小任务很快就处理完了就不需要回复). Unknown duration → do NOT push (a task the
 * model could not estimate is by definition not proven long).
 */
export function shouldPushPlanToChat(plan: ParsedPlan, thresholdMin = PLAN_CHAT_THRESHOLD_MIN): boolean {
	return plan.estimatedMinutes >= thresholdMin;
}
