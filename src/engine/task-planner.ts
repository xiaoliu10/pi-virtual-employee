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

/**
 * Process-narration detector (field 2026-11-10, Nova): an assistant turn that
 * only ANNOUNCES what it is about to do — 「好的，我来查这笔流水…先确认一下
 * 当前环境和可用工具：」 — and then stops with zero tool calls. The old guard
 * gated on the INPUT shape (looksLikeTask/looksLikeImperative + TASK_VERBS),
 * so an ordinary 「帮我查一下这笔流水…」 (39 chars, no listed verb) slipped past
 * every gate and the narration was pushed as the task's final result while
 * nothing executed. The reliable signal lives on the OUTPUT side: short text
 * that declares intent/prerequisites and ends on a dangling lead-in.
 *
 * Deliberately NARROW — a false negative only keeps the old behavior, while a
 * false positive would hide a possibly useful reply. Real answers carry
 * substance (results, data, blockers, questions) and fail at least one gate:
 * length, structure, or the absence of an intent phrase. Only invoked on turns
 * with zero tool evidence, which is itself a strong precondition.
 *
 * KNOWN MISSES (disclosed, review adaf0751 P2-E): 「让我看看现在有什么可用的
 * 工具。」「我准备开始处理这个问题。」「好的，我这就去查。」 return false —
 * sentence-ended intent without a prerequisite/dangling marker. After the
 * fail-open ruling these misses are SAFE (no continuation, narration delivered
 * as-is); widening the regex would re-open the false-positive surface that
 * swallows real replies, so they stay misses on purpose.
 */
const NARRATION_INTENT_RE = /(我来|让我|我这就|我现在|我先|我将|我需要先|我准备|马上|这就|接下来|先确认|先检查|先看一下|先看看|开始(?:查|处理|执行|登录|排查|分析|操作|查询))/;
const NARRATION_DANGLING_RE = /[：:]\s*$|(来执行|来处理|来完成|来查询|来排查|来分析|来登录|来操作|来查|来看看|开始执行|开始处理|开始查询|开始排查)[。.！!]?\s*$/;
const NARRATION_PREREQUISITE_RE = /(先|开始|准备).{0,12}(确认|检查|看一下|看看|了解|熟悉|环境|工具|状态)/;
/** A CONCRETE technical object means the short prerequisite sentence is a real
 *  action commitment, not generic throat-clearing: 「我先看一下 spay_profile 的
 *  实际状态」 names an actual target, while 「先确认一下当前环境和可用工具」 names
 *  nothing. Only consulted on the prerequisite branch — a dangling 「…：」 lead-in
 *  is narration even when it mentions a system (field 2026-11-10). */
const NARRATION_CONCRETE_TARGET_RE = /[a-z][a-z0-9]*_[a-z0-9_]+|[A-Z]{3,}[0-9]*|[\w-]+\.(?:py|js|mjs|cjs|ts|json|log|exe|cmd|bat|txt|csv|xlsx)\b|[A-Za-z]:[\\/]/;
/** Clarification intent: a colon-ended lead-in that asks the HUMAN something
 *  (「我需要先确认几个问题：」) is a real question, not execution throat-
 *  clearing — suppressing it would lose what the model wanted to ask. The
 *  field narration shapes name environments/tools, never 问题/需求. */
const NARRATION_CLARIFY_RE = /(问题|需求|疑问|问清楚|想问|时间范围|参数|细节|口径)/;
/** Substance markers: a reply that reports an outcome, data, or a concrete
 *  blocker is NOT pure narration even when short. */
const NARRATION_SUBSTANCE_RE = /(成功|完成|失败|报错|错误|异常|原因|结果如下|查到|找到|未匹配|没有找到|共\s*\d+|\d+\s*笔|\d+\s*条|请回复|确认终止|验证码)/;
const NARRATION_MAX_LEN = 80;

export function isProcessNarration(raw: string): boolean {
	const text = (raw ?? "").trim();
	if (!text || text.length > NARRATION_MAX_LEN) return false;
	// Structured multi-line content (tables, lists, headings) is a substance answer.
	if (/\n/.test(text) && /(^\s*[|*\-•]|^\s*\d+[.、)）]|#|\|.*\|)/m.test(text)) return false;
	if (!NARRATION_INTENT_RE.test(text)) return false;
	// A dangling lead-in (「…：」 / 「让我…来执行」) is the strongest field signal —
	// every captured field narration ends exactly this way.
	if (NARRATION_DANGLING_RE.test(text)) return true;
	// Short intent + prerequisite wording, with no delivered outcome AND no
	// concrete technical object (a named script/profile/system is real work).
	return NARRATION_PREREQUISITE_RE.test(text)
		&& !NARRATION_SUBSTANCE_RE.test(text)
		&& !NARRATION_CONCRETE_TARGET_RE.test(text);
}

/**
 * The STRUCTURALLY CERTAIN subset of process narration (user ruling
 * 2026-11-10: 「旁白是可有可无的，结果是更关键的——不能因为可有可无的东西去影响
 * 最终交付的质量」). A reply that ENDS on a dangling lead-in (「…：」 / 「让我…
 * 来执行」) is mid-sentence by construction: it announces work and stops before
 * any outcome exists, so it can never BE a result — suppressing it hides
 * nothing. Anything else (a complete sentence, a question, a blocker) stays
 * deliverable even when it smells like narration: the heuristic may trigger a
 * continuation, but only this narrow shape may ever replace a delivery.
 */
const NARRATION_DANGLING_MAX_LEN = 200;
export function isDanglingNarration(raw: string): boolean {
	const text = (raw ?? "").trim();
	if (!text || text.length > NARRATION_DANGLING_MAX_LEN) return false;
	if (!NARRATION_DANGLING_RE.test(text)) return false;
	// A real result quoted before the lead-in (「查到 3 笔：」) is substance — the
	// colon then INTRODUCES data, not dangles. Require the narration shape.
	if (NARRATION_SUBSTANCE_RE.test(text)) return false;
	// A clarification lead-in is a question the human must answer — losing it
	// costs the user a re-statement (review adaf0751 P2-A).
	if (NARRATION_CLARIFY_RE.test(text)) return false;
	return NARRATION_INTENT_RE.test(text) || NARRATION_PREREQUISITE_RE.test(text);
}

/** The plan prompt: short, numbered, verifiable steps; nothing else. */
export const PLAN_PROMPT_HEADER =
	"请判断下面这条消息是否是一个需要多步骤执行的任务。如果是，输出以下四部分；如果只是简单问答或单步操作，只输出 NO_PLAN。\n" +
	"第一行：耗时：<只有存在可靠依据（步骤数明确、涉及操作的耗时已知、消息给出明确规模）才写数字，如 5分钟 / 1小时；没有可靠依据必须写「不确定」，严禁编造数字凑行。只计机器执行时间；等待人工配合（验证码/确认/授权）的时长一律不计入，需要配合时在目标行注明>\n" +
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
	// User ruling 2026-11-10 (review 1ce0eb90 P2-1): 「不确定」 must WIN over any
	// co-occurring number — a hedged "不确定，最多30分钟" is NOT an estimate, and
	// parsing the embedded 30 would re-arm the exact misleading ⏱ card this
	// rigor pass exists to kill.
	if (t.includes("不确定")) return 0;
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
