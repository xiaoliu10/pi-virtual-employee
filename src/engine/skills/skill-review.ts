/**
 * Auto-skill-distillation review turn — ported from NousResearch/hermes-agent
 * `agent/background_review.py` (`_SKILL_REVIEW_PROMPT` / `_LESSON_LAYER_BLOCK` /
 * `_DO_NOT_CAPTURE_BLOCK`) and adapted to VE's task flow.
 *
 * Problem it solves (field 2026-11-03): a scheduled task wrote a working script
 * (`spay_py_sum.py`) on one run; a later manual run rewrote it from scratch.
 * The procedure existed in the run's transcript, but skills — the only store a
 * future session actually reads — never got it. VE's `save_to_skill` was gated
 * to explicit user intent, so nothing was ever sedimented.
 *
 * Hermes runs this as a forked background review after every turn. VE runs it as
 * ONE ephemeral turn at the end of a task run (the `ephemeral` engine context
 * already exists for the autonomous auto-learn turn), so the review Q/A never
 * enters the run's transcript or the pushed report.
 *
 * Ported invariants (each is asserted by scripts/test-skill-review-prompt.mjs):
 *  - REUSE FIRST, never duplicate: patch a skill in play → extend an existing
 *    umbrella → add a support file → only then create a class-level umbrella.
 *  - Read-before-write: patching an existing skill requires viewing it first.
 *  - Scripts are a first-class asset: a reusable script is stored under the
 *    skill's `scripts/` and referenced by relative path (NOT inlined into
 *    SKILL.md) — the script is the thing that makes the next run fast.
 *  - Explicit DO-NOT-CAPTURE list: environment-dependent failures, negative
 *    tool claims, one-off narratives, and unresolved failure sequences.
 */

/** Where a distilled script is expected to live, relative to the skill root. */
export const SKILL_SCRIPTS_DIR = "scripts";

/**
 * What a skill IS, and how to write it well — Hermes' `_LESSON_LAYER_BLOCK`.
 * The failure modes it names (hoarding library, incident narration, one
 * references/ file per session) are the ones VE's library would hit first.
 */
const LESSON_LAYER_BLOCK = `What a skill IS: the instructions for doing a class of task the most efficient and correct way — the procedure, the tools and commands that work, the order, and the pitfalls that cost time. A future session should be able to follow it and produce the result on the first try.

- Procedure first: the steps in the order they are done, with the concrete commands, tool calls and decision points. Lessons and pitfalls attach to the step they affect.
- A pitfall is a generalizable rule + one clause of WHY (the mechanism), written as an instruction. Not a narrative of what happened in this run.
- No dates, run ids, error transcripts or quoted chat text as content — the rule must stand on its own.
- The same lesson learned twice is ONE rule. Before adding, look through the existing skill (and its support files) for the rule already stated; strengthen or clarify it rather than appending a second copy.
- Do not restate what the environment already teaches (tool parameter lists, capability descriptions, this prompt's own rules). A skill carries the WORKFLOW and the pitfalls.
- Always-on rules (standing preferences, gates that apply to every instance of this task) live in SKILL.md itself, whole. references/ is for depth needed only sometimes.`;

/**
 * What must NOT be captured as a skill — Hermes' `_DO_NOT_CAPTURE_BLOCK`,
 * plus VE-specific items. These become persistent self-imposed constraints
 * that bite later when the environment changes.
 */
const DO_NOT_CAPTURE_BLOCK = `Do NOT capture as a skill (these become persistent constraints that bite you later when the environment changes):
- Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, "command not found", unconfigured credentials, uninstalled packages. Those get fixed; they are not durable rules.
- Negative claims about tools ("browser tools do not work", "the relay is down"). These harden into refusals the agent cites against itself long after the real problem was fixed. Capture the FIX (config step, install command) instead.
- One-off task narratives. "Summarize today's market" is not a class of work that warrants a skill.
- Unresolved failures: if the run ended WITHOUT finding a working method, do NOT write those attempts up as a "reliable workflow". Either say 无新技能, or capture only an alternative you are independently confident works — never the dead ends.`;

/**
 * The reuse-first preference order — Hermes' core discipline. The ORDER is
 * load-bearing: a duplicate skill is worse than a missing one, because the
 * library becomes the thing you have to search through.
 */
const PREFERENCE_ORDER = `Preference order — pick the earliest action that fits:
1. UPDATE THE SKILL THAT WAS IN PLAY. If this run used or loaded a skill covering the same task, patch that one: re-read it first (read the existing SKILL.md), then update it in place. Hand-written and auto-distilled skills are equally yours to improve.
2. UPDATE AN EXISTING SKILL that covers the same class of task — list the available skills first and read the candidate before patching.
3. ADD A SUPPORT FILE under an existing skill instead of creating a near-duplicate:
   - \`${SKILL_SCRIPTS_DIR}/<name>.<ext>\` — a script the next run should RUN rather than re-type. This is the highest-value support file for VE: a task that already has its script saved only needs to invoke it.
   - \`references/<topic>.md\` — topical depth needed only sometimes (decision tables, quirks, condensed notes). Extend an existing topical file before creating a new one; never a per-run file.
4. CREATE A NEW SKILL only when nothing existing covers the class. Name it at the CLASS level (what kind of task), never after this run's specifics (no dates, ids, "fix-X", "debug-Y"). If the name only makes sense for today, fall back to 1–3.

Read-before-write: before updating an existing skill's SKILL.md, you MUST read that file first in this review; before overwriting an existing support file, read that exact file. Creating a brand-new skill, or adding a NEW support file, needs no prior read. If a write is refused for a missing read, read it once and retry once — do not loop.`;

/** Signals that make a run worth distilling. */
const SIGNALS = `Signals that warrant a skill update (any one is enough):
- A non-trivial technique, workaround, debugging path or tool-usage pattern emerged that a future run would benefit from.
- The run produced a working script or a reusable sequence of steps that is currently NOT saved anywhere a future session would look.
- A skill that was used turned out to be wrong, missing a step or outdated — patch it now.
- The requester corrected the approach, format or workflow — encode the correction in the skill that governs this task.`;

export interface SkillReviewOptions {
	/** Task title, for naming/grounding (never written into skill content verbatim). */
	taskTitle: string;
	/** Short description of how the run ended, so unresolved runs are handled right. */
	outcome: "ok" | "error";
	/** Names of skills already loaded/available this run (patch-first candidates). */
	availableSkills?: string[];
}

/**
 * Build the ONE prompt for the distillation turn. Mirrors Hermes'
 * `build_learn_prompt` shape: what to review, what to do, the authoring
 * standards, and an explicit "nothing to save" escape that must not be the
 * default.
 */
export function buildSkillReviewPrompt(opts: SkillReviewOptions): string {
	const outcomeNote = opts.outcome === "ok"
		? "本次任务已正常结束。"
		: "本次任务以失败/中断结束——按下面的规则，未走通的方法不得写成「可靠流程」。";
	const skills = (opts.availableSkills ?? []).filter((s) => s.trim());
	const skillList = skills.length > 0
		? `\n本次运行中可用的技能：${skills.map((s) => `「${s}」`).join("、")}。若其中某个覆盖同一类任务，优先更新它。\n`
		: "";

	return `[技能复盘] 回顾本次任务「${opts.taskTitle}」的执行过程，把值得复用的东西沉淀成技能。${outcomeNote}

要做什么：
1. 判断本次是否产生了「下次还会用到的做法」。判断标准：下次遇到同类任务时，有了它能不能少走弯路（不必重新摸索页面、不必重写脚本、不必重新踩同一个坑）。
2. 如果有，按下面的优先顺序更新技能库——优先更新已有的，不要制造重复技能：
${PREFERENCE_ORDER}
${skillList}
${SIGNALS}

${LESSON_LAYER_BLOCK}

脚本处理（重要，直接影响下次执行速度）：
- 本次运行中写出并验证可用的脚本，必须收进技能自己的 \`${SKILL_SCRIPTS_DIR}/\` 目录（而不是留在桌面或临时目录，也不要把脚本内容整段抄进 SKILL.md），并在 SKILL.md 里用相对路径引用它、写清调用方式与参数。
- 脚本放进技能目录后，下次执行同类任务时：读技能 → 直接跑 \`${SKILL_SCRIPTS_DIR}/\` 里的脚本 → 汇报结果，不用再从零写。
- 只有确实可复用、本次已验证能跑的脚本才收；一次性的探查/调试脚本不要收。

${DO_NOT_CAPTURE_BLOCK}

如果本次确实没有可复用的内容（纯查询、一次性操作、没有任何新做法），直接回复「无新技能」即可，不要为了沉淀而沉淀。`;
}

/** Marker a distillation turn replies with when nothing is worth saving. */
export const NO_NEW_SKILL_MARK = "无新技能";

/** True when the review turn declined to write anything. */
export function isNoNewSkillReply(text: string): boolean {
	return text.replace(/[*_\s]/g, "").includes(NO_NEW_SKILL_MARK);
}
