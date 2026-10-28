/**
 * Phase 3: recovery policy for tools with external effects.
 *
 * THE PROBLEM this solves: durable can tell us "this tool was interrupted and may
 * have partially run", but it cannot know whether the effect landed — the commit
 * that would have recorded the result never happened. Two wrong answers are easy:
 *
 *   blind retry      → the payment/refund/message happens twice
 *   blind abandon    → the work is silently lost, and nobody notices
 *
 * So a mutating tool must declare HOW to find out. This module owns that
 * classification and the recovery rule; the tools themselves stay unaware.
 *
 * EVIDENCE OVER MARKS, ALWAYS: a durable lifecycle marker ("started, no result")
 * is not proof of failure. Every tool marked `verify` must point at a way to
 * re-read the business state (an order lookup, a message id, a file's own
 * content). Tools that cannot be verified get `manual`, which means: stop and ask
 * a human — the same stance VE already takes for work items
 * (`recoverWorking()` → waiting_human).
 */
/**
 * What to do when a crash interrupted this tool after its intent was committed.
 *
 * - `retry`   rerun automatically. ONLY for effects that are idempotent by
 *             construction (write a file to a fixed path, set a value).
 * - `verify`  ask the business system whether the effect landed, then decide.
 *             The tool must provide `verifyHint` naming what to query.
 * - `manual`  neither: stop and ask a human. The default for anything unknown.
 */
export type RecoveryPolicy = "retry" | "verify" | "manual";

export interface RecoveryRule {
	policy: RecoveryPolicy;
	/** For `verify`: what to re-read, in the words the model should use. */
	verifyHint?: string;
}

/**
 * Tools that may be re-run safely (idempotent by construction).
 *
 * Keep this list SHORT and justify each entry: an effect belongs here only when
 * running it twice leaves exactly the state one run would leave.
 */
const RETRY_SAFE = new Set<string>([
	// Writes a file to a path derived from its own arguments: the second run
	// overwrites with identical bytes.
	"save_document",
]);

/**
 * Tools that can be checked against business state before deciding.
 * Each names the query the model should perform on recovery.
 */
const VERIFIABLE: Record<string, string> = {
	save_report: "重新查询该会话是否已生成报告链接（save_report 的返回里带 /reports/<id>/ 路径）；已存在则直接复用链接，不要重复发布。",
	save_to_knowledge: "先 search_knowledge_base 查同标题/同内容条目是否已存在；已存在则跳过写入。",
	save_to_skill: "先 read_skill_asset 查该技能文件是否已包含本次内容；已包含则跳过。",
	remember: "先检索记忆里是否已有同义条目；已有则不要重复写入。",
	manage_work: "先 manage_work action=list/get 查该任务的当前状态；若目标状态已达成则不再重复变更。",
	manage_knowledge_base: "先检索目标条目当前状态；已达成则不再重复变更。",
	provide_document: "查询该会话是否已经收到该文件（对话记录里的文件消息）；已发送则不要重复发送。",
	send_image: "查询该会话是否已经收到该图片；已发送则不要重复发送。",
	// Scheduled-task tools: every one of them is a state transition that can be
	// re-read with the read-only `get_scheduled_task` / `list_scheduled_tasks`.
	create_scheduled_task: "先用 list_scheduled_tasks 查同名任务是否已存在；已存在则直接使用，不要重复创建。",
	update_scheduled_task: "先用 get_scheduled_task 查该任务的当前内容；已是目标内容则不再变更。",
	toggle_scheduled_task: "先用 get_scheduled_task 查该任务的 enabled 状态；已是目标状态则不再切换。",
	resume_scheduled_task: "先用 get_scheduled_task 查该任务状态；已恢复则不要重复恢复。",
	delete_scheduled_task: "先用 get_scheduled_task / list_scheduled_tasks 确认该任务是否仍存在；已删除则视为完成。",
	authorize_scheduled_task: "先用 get_scheduled_task 查该任务的授权状态；已授权则不要重复授权。",
	// Work items: state machine readable through manage_work action=get/list.
	manage_work_items: "先用 manage_work_items 查该条目的当前状态；已达成则不再重复变更。",
	// Files: the filesystem itself is the state.
	delete_files: "先用 list_directory 确认目标文件是否仍存在；已删除则视为完成。",
};

/**
 * Policy for one tool.
 *
 * Default is `manual`, deliberately: a tool nobody classified must not be
 * retried automatically, and must not silently vanish either — asking a human
 * is the only safe answer for an unknown effect.
 */
export function recoveryRuleFor(toolName: string): RecoveryRule {
	if (RETRY_SAFE.has(toolName)) return { policy: "retry" };
	const hint = VERIFIABLE[toolName];
	if (hint) return { policy: "verify", verifyHint: hint };
	return { policy: "manual" };
}

/**
 * Read-only tools are handled by the replay policy (see ve-tools.ts); a tool that
 * is `replay: "safe"` never reaches this classification. Anything that is unsafe
 * gets a recovery rule here.
 */
export function needsRecoveryRule(toolName: string): boolean {
	return recoveryRuleFor(toolName).policy !== "retry";
}

/**
 * The instruction handed to the model when a mutating tool was interrupted.
 *
 * Why a model-facing instruction rather than an automatic action: only the model
 * (with the conversation's context, and the tools to look) can perform the
 * verify step sensibly, and the human decision belongs with whoever owns the
 * business action. The text must make BOTH failure modes explicit — retrying
 * blindly and pretending it succeeded are equally wrong.
 */
export function interruptedToolNotice(toolName: string, rule: RecoveryRule): string {
	const header = `⚠️ 工具 \`${toolName}\` 在执行中被中断，结果未知（可能已经生效，也可能没有）。`;
	if (rule.policy === "verify") {
		return `${header}

不要直接重试。先核实当前真实状态：${rule.verifyHint ?? "重新查询该系统当前状态。"}

- 若已完成 → 不要重复执行，直接用查到的结果继续任务。
- 若确实未完成 → 再执行一次。
- 无法确认 → 停下来告诉用户「这一步状态不确定，需要人工核实」，不要猜测。`;
	}
	return `${header}

该操作无法自动核实是否已生效，因此不要重试。请停下来告诉用户：哪一步被中断、可能产生了什么影响、需要人工核实后再决定是否重做。`;
}
