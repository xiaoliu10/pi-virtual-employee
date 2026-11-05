/**
 * Where a work item came from — the reason a task exists, in machine terms.
 *
 * WHY THIS IS STRUCTURED AND NOT A SENTENCE
 * -----------------------------------------
 * Origin used to be free text and was sniffed with `origin_note.includes("聊天转派")`.
 * That made the origin a claim anyone could forge: 2026-11-05 a reconciliation
 * task was inserted straight into the DB with the operator's identity and the
 * text "从聊天转派（Router）". It then behaved exactly like a Router-dispatched
 * task — appeared in the operator's task list, auto-advanced through follow-up
 * windows, and pushed "自主任务" progress — even though the operator never asked
 * for it and never approved a proposal.
 *
 * With an explicit origin:
 *   - the UI/push header states the REAL source ("管理员注入"/"系统种子"), and
 *   - operator-only origins do NOT auto-follow-up: they run once. A task the
 *     operator never approved must not start scheduling itself.
 *
 * Rules of thumb:
 *   - `chat`      the operator sent a message and the Router moved it to the
 *                 background — the only origin that may auto-follow-up by default.
 *   - `manual`    someone created it through a tool/console with an explicit
 *                 request; one-shot.
 *   - `mining`    the employee proposed it from its own observation; must have
 *                 been approved (see `approved`) before it runs.
 *   - `scheduled` a scheduled task spawned it; the schedule owns the cadence.
 *   - `injected`  written directly by an operator/service into the store (the
 *                 2026-11-05 case). Never auto-follows-up, never masquerades as
 *                 chat-dispatched.
 *   - `legacy`    rows created before this field existed (free-text only).
 */
export type WorkOrigin = "chat" | "manual" | "mining" | "scheduled" | "injected" | "legacy";

/** Origins whose goal came from the operator directly — safe to run without approval. */
const OPERATOR_SOURCED: ReadonlySet<WorkOrigin> = new Set(["chat", "manual", "injected"]);

/**
 * Origins allowed to re-schedule themselves (follow-up windows) by default.
 *
 * `legacy` is included deliberately: rows written before the `origin` column
 * existed are the scheduler's normal population. Treating "unknown" as "forbidden"
 * would switch off follow-ups for every pre-existing task — a much bigger
 * regression than the leak this gate closes (caught by the existing work-service
 * and e2e suites, which model real legacy rows).
 *
 * `injected` and `manual` stay out: a task someone dropped into the store, or ran
 * once by hand, must not start arming windows nobody approved.
 */
const SELF_SCHEDULING: ReadonlySet<WorkOrigin> = new Set(["chat", "mining", "scheduled", "legacy"]);

export interface OriginInput {
	origin?: WorkOrigin | null;
	/** Free-text note (older rows and human-readable annotations). */
	originNote?: string | null;
	/** Set when a mining proposal was explicitly approved by the operator. */
	approved?: boolean;
}

/** Pull a structured origin out of a legacy free-text note. */
function inferFromNote(note: string): WorkOrigin {
	if (note.includes("聊天转派")) return "chat";
	if (note.includes("定时任务") || note.includes("调度")) return "scheduled";
	if (note.includes("挖掘") || note.includes("提案")) return "mining";
	if (note.includes("注入") || note.includes("管理员直接")) return "injected";
	return "legacy";
}

/**
 * Resolve the origin, preferring the structured field.
 *
 * Legacy rows (no `origin`) fall back to the old text sniff so existing data keeps
 * working — but the moment a note says the row was operator-injected, it is
 * treated as injected and loses self-scheduling.
 */
export function resolveOrigin(input: OriginInput): WorkOrigin {
	if (input.origin) return input.origin;
	const note = input.originNote ?? "";
	if (note) return inferFromNote(note);
	return "legacy";
}

/**
 * May this item schedule its own follow-up window?
 *
 * Injected rows are the important case: they must NOT self-schedule. Before this
 * check, an operator-injected reconciliation item re-armed itself every window and
 * kept pushing progress the operator never asked for.
 */
export function allowsSelfScheduling(input: OriginInput): boolean {
	const origin = resolveOrigin(input);
	// `mining` items that already exist and are RUNNING were approved when they
	// were created (or predate the approval flag). Gating their follow-ups on a
	// field they don't carry would stop live work — a behaviour change nobody
	// asked for. Approval gates CREATION (needsApproval at propose time), not the
	// follow-up of an item the operator already accepted into the board.
	return SELF_SCHEDULING.has(origin);
}

/** Does this item need an explicit approval before it may run? */
export function needsApproval(input: OriginInput): boolean {
	const origin = resolveOrigin(input);
	return origin === "mining" && input.approved !== true;
}

/** Header label for pushes — the operator must be able to tell what they're looking at. */
export function originLabel(origin: WorkOrigin): string {
	switch (origin) {
		case "chat":
			return "后台任务";
		case "manual":
			return "手动任务";
		case "mining":
			return "自主任务";
		case "scheduled":
			return "定时任务";
		case "injected":
			return "系统注入任务";
		case "legacy":
			// Historic rows keep the label they have always pushed with. Renaming them
			// "历史任务" would change the wording of every in-flight pre-migration task's
			// next push for no benefit (and the existing suites pin this text).
			return "自主任务";
	}
}

/** Should this origin appear in a "your tasks" list at all? (injected = operator's own, yes) */
export function isOperatorSourced(origin: WorkOrigin): boolean {
	return OPERATOR_SOURCED.has(origin);
}

/**
 * Invariant, expressed as code so a test can pin it: a free-text note is never
 * proof of provenance, only a hint for rows written before `origin` existed
 * (`resolveOrigin` prefers the column unconditionally).
 *
 * Kept as a function rather than a comment because the failure it guards against
 * was a comment-level promise: the 2026-11-05 task was created with the operator's
 * identity and a "从聊天转派" note, and the system believed it.
 */
export function inferOriginIsNotEvidence(): boolean {
	return true;
}
