/**
 * Pure, string-in/string-out helpers that standardize heartbeat progress text
 * into a fixed four-field Chinese report (「已完成 / 剩余 / 正在 / 卡点」).
 *
 * The heartbeat's side-channel LLM pass is instructed to answer in that
 * four-field shape, but models drift (field 2026-10-09): they echo the
 * harness compaction template verbatim ("## Goal … ## Constraints & …"),
 * drop fields, pad unknown fields with an invented 「无」, or hand back a
 * structureless narration blob. Every heartbeat consumer normalizes through
 * here so that:
 *  - the four fields are parsed from either the inline layout
 *    (「已完成：…；剩余：…」) or Chinese markdown headings (「## 已完成\n…」);
 *  - each field is clamped INDEPENDENTLY, so a long 已完成 can never push the
 *    卡点 out of the report (the old global 180-char slice truncated wherever
 *    the budget happened to land and could amputate the whole 卡点 item);
 *  - missing information reads 「暂未确认」 (卡点 reads 「暂无」 — a running
 *    task with no blocker is normal, not something unresolved) — never an
 *    made-up number (only an execution record that clearly shows no obstacle
 *    earns a 「无」, and this layer never upgrades absence into one);
 *  - the English compaction template is rejected, while Chinese markdown
 *    headings and ordinary English words ("Goal" mid-sentence) pass.
 *
 * No AgentMessage, no I/O — directly unit-testable (scripts/test-progress.mjs).
 */

/** The four canonical fields, in display order. `null` marks a label that was
 * NOT found in the source text — distinct from `""` (label present, content
 * empty), which standardization fills with 「暂未确认」. */
export interface ProgressFields {
	done: string | null;
	remaining: string | null;
	doing: string | null;
	blocked: string | null;
}

/** Per-field content cap. Four labels + separators + clamped content keep the
 * whole report bounded WITHOUT a global cut that could amputate the 卡点. */
const MAX_FIELD_CHARS = 50;

/** 卡点 gets its OWN, larger budget (review L): it is the single most
 * actionable field for the user — "what is stuck and what do I do about it" —
 * so it is allowed 80 chars where the others get 50. Independent by design: a
 * long 已完成 can never eat into it. */
const MAX_BLOCKED_CHARS = 80;

/** Per-field caps, keyed by field. */
const FIELD_MAX: Record<keyof ProgressFields, number> = {
	done: MAX_FIELD_CHARS,
	remaining: MAX_FIELD_CHARS,
	doing: MAX_FIELD_CHARS,
	blocked: MAX_BLOCKED_CHARS,
};

/** Cap for the deterministic fallback's task-name head (already sanitized by
 * the caller — heartbeatGoalOf / substantialAnchorOf output). */
const MAX_TASK_CHARS = 40;

const UNKNOWN = "暂未确认";
/** 卡点没有内容时的占位——它和「不确定」语义不同：一条进行中的任务没有
 * 障碍是常态，写「暂未确认」会让人以为出了什么我们没搞清楚的事（field
 * request 2026-10-10）。其余三个字段缺依据仍是「暂未确认」。 */
const NO_BLOCKER = "暂无";
const DOING_FALLBACK = "任务执行中，正在核实最新进展";

const FIELD_LABELS = ["已完成", "剩余", "正在", "卡点"] as const;
type FieldLabel = (typeof FIELD_LABELS)[number];

const FIELD_KEY: Record<FieldLabel, keyof ProgressFields> = {
	已完成: "done",
	剩余: "remaining",
	正在: "doing",
	卡点: "blocked",
};

/**
 * Signature of the harness compaction-summary template ("## Goal …\n##
 * Constraints & Preferences …"). After an app restart a compaction summary is
 * rehydrated from history as a PLAIN assistant message, so the heartbeat model
 * sees it and may echo the English template verbatim as its "progress report"
 * (field 2026-10-09 screenshot). Both headings together are unambiguous — no
 * real progress report carries them. `\b` holds at ASCII↔CJK boundaries, so
 * 「## Goal跟踪处理」 (no space) matches too.
 *
 * Deliberately TIGHT: a compliant Chinese report using 「## 已完成」 headings,
 * or carrying the English word "Goal" mid-sentence, must NOT be rejected — an
 * earlier broad /\bGoal\b|^##/ guard discarded exactly the structured reports
 * users asked for and fell back to the structureless brief they complained
 * about.
 */
export function isCompactionTemplateReport(text: string): boolean {
	return /^##\s*Goal\b/m.test(text) && /##\s*Constraints/i.test(text);
}

/**
 * A single ENGLISH template heading LINE ("## Goal …", "## Constraints …",
 * "## Preferences …", "## Next Steps …") anywhere in the text. Weaker than the
 * double-heading signature above — one heading alone does not make the whole
 * text the template — but a four-field report has no legitimate reason to
 * carry one: it means template fragments leaked INTO a field's content
 * (review L: "已完成：x\n## Goal 旧标题" would otherwise be shown to the user
 * verbatim). Chinese headings (## 已完成) and mid-sentence English words are
 * NOT matched — the heading must start a line.
 *
 * Used to REJECT a contaminated candidate wholesale (standardize /
 * extractProgressFromTexts) and to disarm a contaminated field value in the
 * deterministic fallback (the field degrades to 暂未确认, the fragment never
 * reaches the user).
 */
export function containsTemplateHeadingLine(text: string): boolean {
	return /^##\s*(?:Goal|Constraints|Preferences|Next\s*Steps)\b/im.test(text);
}

/**
 * Rewrite Chinese markdown headings of the four known labels ("## 已完成\n…")
 * into inline labels ("已完成：…") so a single extraction pass handles both
 * layouts. Only exact label headings are rewritten; arbitrary "##" headings
 * and English ones ("## Goal") pass through untouched — the template is
 * rejected separately, and everything else is just text.
 *
 * No `\b` after the label: \b is ASCII-word-based and never holds between a
 * CJK char and the following newline, so 「## 已完成\n」 would NOT match with
 * it. The lookahead keeps a longer heading like 「## 已完成情况汇报」 from
 * being split at 已完成.
 */
function normalizeHeadings(text: string): string {
	return text.replace(/^##\s*(已完成|剩余|正在|卡点)(?=[\s:：]|$)[:：]?[ \t]*\n?/gm, "$1：");
}

/**
 * Content of one field: the label, a colon, then everything up to the next
 * known label (an optional ；/; before it belongs to the separator, not the
 * content) or the end of the text. Returns `null` when the label is absent —
 * distinct from `""` (label present, content empty). Whitespace inside the
 * content is collapsed, so a markdown body under a heading reads as one line.
 */
function extractField(text: string, label: FieldLabel): string | null {
	const others = FIELD_LABELS.filter((l) => l !== label).join("|");
	const re = new RegExp(`${label}[:：]\\s*([\\s\\S]*?)(?=\\s*[；;]?\\s*(?:${others})[:：]|$)`);
	const m = re.exec(text);
	return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

/**
 * Parse the four fields out of raw progress text. Returns `null` when NONE of
 * the four labels is present — a structureless narration blob
 * ("检查表格当前行状态") is never force-fit into four slots; callers decide
 * what null means (the LLM path falls back, the deterministic path writes
 * 「暂未确认」). Individual fields are `null` when their own label is missing,
 * `""` when the label is there but its content is empty.
 */
export function parseProgressFields(raw: string): ProgressFields | null {
	if (!raw || !raw.trim()) return null;
	const text = normalizeHeadings(raw);
	const fields: Record<keyof ProgressFields, string | null> = { done: null, remaining: null, doing: null, blocked: null };
	let found = 0;
	for (const label of FIELD_LABELS) {
		const value = extractField(text, label);
		fields[FIELD_KEY[label]] = value;
		if (value !== null) found += 1;
	}
	return found > 0 ? fields : null;
}

/**
 * Clamp one field's content to `max` chars, cutting at the last clause
 * boundary (；;。，,) inside the budget when that keeps at least half of it —
 * the ellipsis then lands cleanly instead of mid-word. Per-field by design:
 * the old global slice truncated wherever the budget happened to land and
 * could drop the whole 卡点 item.
 */
export function clampField(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	if (t.length <= max) return t;
	const head = t.slice(0, max);
	let cutAt = -1;
	for (const ch of ["；", ";", "。", "，", ","]) cutAt = Math.max(cutAt, head.lastIndexOf(ch));
	const cut = cutAt >= max / 2 ? head.slice(0, cutAt) : head;
	return `${cut.replace(/[，,；;。.\s]+$/, "")}…`;
}

/**
 * Normalize a model-produced progress report into the canonical one-line
 * four-field form. Returns `null` — "not a usable four-field report, fall
 * back" — when the text is the compaction template, carries none of the four
 * labels, or is MISSING any label: a partial report must not be shown with
 * its gaps papered over (the deterministic fallback fills honestly instead).
 * A label present with empty content becomes 「暂未确认」; a field the model
 * explicitly wrote as 「无」 stays 「无」 (per the instruction only a record
 * that clearly shows no blocker earns it — this layer never upgrades absence
 * into 「无」 on its own). An absent 卡点 reads 「暂无」.
 */
export function standardizeProgressReport(raw: string): string | null {
	if (!raw || isCompactionTemplateReport(raw) || containsTemplateHeadingLine(raw)) return null;
	const fields = parseProgressFields(raw);
	if (!fields) return null;
	if (fields.done === null || fields.remaining === null || fields.doing === null || fields.blocked === null) return null;
	const fill = (value: string, max: number): string => {
		const t = value.trim();
		return t ? clampField(t, max) : UNKNOWN;
	};
	const blocked = fields.blocked.trim() ? clampField(fields.blocked.trim(), FIELD_MAX.blocked) : NO_BLOCKER;
	return `已完成：${fill(fields.done, FIELD_MAX.done)}；剩余：${fill(fields.remaining, FIELD_MAX.remaining)}；正在：${fill(fields.doing, FIELD_MAX.doing)}；卡点：${blocked}`;
}

/**
 * Newest-first scan of pre-extracted assistant visible texts for the most
 * recent message that actually carries progress fields. Template echoes and
 * structureless blobs do not qualify. The caller supplies plain texts so this
 * stays string-in/string-out; individual fields may be `null`.
 */
export function extractProgressFromTexts(texts: string[]): ProgressFields | null {
	for (let i = texts.length - 1; i >= 0; i--) {
		const text = texts[i];
		if (!text || !text.trim()) continue;
		if (isCompactionTemplateReport(text) || containsTemplateHeadingLine(text)) continue;
		const fields = parseProgressFields(text);
		if (!fields) continue;
		// ≥2 DISTINCT labels qualify (review M1): Chinese narration casually
		// carries one 「已完成：/卡点：」 phrase — a single label is ordinary
		// prose, not a structured progress report, and treating it as evidence
		// let an old task's numbers be reused for the new one.
		const labels = [fields.done, fields.remaining, fields.doing, fields.blocked].filter((v) => v !== null).length;
		if (labels >= 2) return fields;
	}
	return null;
}

/**
 * The deterministic heartbeat fallback body: four canonical fields filled
 * from what the transcript actually evidences. Anything unevidenced reads
 * 「暂未确认」 (卡点 reads 「暂无」) — never an inferred 「无」 or invented
 * numbers. The active step
 * gets an honest generic line when the transcript has nothing specific.
 * `taskName` is optional and must be pre-sanitized by the caller (it quotes
 * the curated compaction summary or the latest substantial request — never a
 * raw template heading); `taskLabel` says WHAT the head is — 「任务」 for the
 * curated compaction record, 「当前请求」 for a quoted user request (field
 * 2026-09-24: a quoted request must never be labeled as the task name).
 */
export function formatDeterministicBrief(fields: ProgressFields | null, taskName?: string, taskLabel = "任务"): string {
	// A field value carrying a template-heading fragment ("## Goal 旧标题") is
	// contamination, not evidence — degrade it to 暂未确认 rather than show the
	// fragment to the user (review L). Values reaching here are already
	// whitespace-collapsed, so the check is deliberately NOT line-anchored.
	const contaminated = (value: string): boolean => /##\s*(?:Goal|Constraints|Preferences|Next\s*Steps)\b/i.test(value);
	const unevidenced = (value: string | null | undefined, max: number): string => {
		const t = (value ?? "").trim();
		return t && !contaminated(t) ? clampField(t, max) : UNKNOWN;
	};
	const doingRaw = (fields?.doing ?? "").trim();
	const doing = doingRaw && !contaminated(doingRaw) ? clampField(doingRaw, FIELD_MAX.doing) : DOING_FALLBACK;
	// 卡点 unevidenced reads 「暂无」 — an in-flight task with no known blocker
	// is normal, whereas 暂未确认 would imply something we failed to find out.
	const blockedRaw = (fields?.blocked ?? "").trim();
	const blocked = blockedRaw && !contaminated(blockedRaw) ? clampField(blockedRaw, FIELD_MAX.blocked) : NO_BLOCKER;
	const body = `已完成：${unevidenced(fields?.done, FIELD_MAX.done)}；剩余：${unevidenced(fields?.remaining, FIELD_MAX.remaining)}；正在：${doing}；卡点：${blocked}`;
	const safeTask = (taskName ?? "").trim();
	const head = safeTask && !contaminated(safeTask) ? `${taskLabel}：${clampField(safeTask, MAX_TASK_CHARS)}。` : "";
	return `⏳ 任务仍在进行中（已耗时较长）。${head}${body}。完成后会立即回复结果，请稍候。`;
}
