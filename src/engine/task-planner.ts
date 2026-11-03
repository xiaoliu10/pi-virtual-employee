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
export function looksLikeTask(message: string): boolean {
	const text = message.trim();
	if (!text) return false;
	if (text.length > 4_000) return true; // a 4KB brief is a task by construction
	// Task verbs (zh/en) — logging in, downloading, organizing, generating, monitoring, writing...
	const taskVerbs = [
		"登录", "抓取", "爬", "下载", "整理", "汇总", "生成", "监控", "巡检", "对账", "采集",
		"导出", "推送", "部署", "排查", "分析", "批量", "自动化", "跟踪", "核对", "注册", "配置",
		"write", "build", "deploy", "scrape", "crawl", "download", "generate", "monitor", "automate", "analyze",
	];
	const lower = text.toLowerCase();
	const hits = taskVerbs.filter((v) => lower.includes(v)).length;
	if (hits === 0) return false;
	// Multi-step evidence: numbered list, several sentences, or sequencing words.
	const multiStep = /\n|。|；|;|然后|接着|之后|再|并且|同时|以及|最后|第一步|第[一二三]|\d+[.、）)]|，.*(然后|接着|之后|并且|同时)/.test(text);
	// A bare task verb alone ("登录") is a single-step command: require either
	// multi-step evidence or a message long enough to carry detail (a path, a
	// condition, a target).
	return multiStep || text.length >= 40;
}

/** The plan prompt: short, numbered, verifiable steps; nothing else. */
export const PLAN_PROMPT_HEADER =
	"请判断下面这条消息是否是一个需要多步骤执行的任务。如果是，输出一份执行规划；如果只是简单问答或单步操作，只输出 NO_PLAN。规划格式：第一行是「目标：」一句话概括，然后 3-6 行编号步骤（每步一行，动词开头，可验证）。不要输出任何其他解释。消息如下：";

/** Parse the side pass output. Returns null when the model said NO_PLAN (or
 *  produced something unusable) — the caller then skips planning silently. */
export function parsePlan(raw: string | undefined): string | null {
	if (!raw) return null;
	const text = raw.trim();
	if (!text || /^NO_PLAN\b/i.test(text)) return null;
	// Must contain a 目标 line and at least 2 numbered steps to count as a plan.
	if (!/目标[：:]/.test(text)) return null;
	const numbered = (text.match(/^\s*\d+[.、）)]/gm) ?? []).length;
	if (numbered < 2) return null;
	// Clamp length: a plan longer than the task brief itself is noise.
	return text.length > 1_200 ? text.slice(0, 1_200) + "…" : text;
}

/** The user-facing message. One 📋 block, no extra prose. */
export function formatPlanMessage(plan: string): string {
	return `📋 任务规划\n${plan}\n（按此执行，完成后汇报结果；有出入随时喊停）`;
}
