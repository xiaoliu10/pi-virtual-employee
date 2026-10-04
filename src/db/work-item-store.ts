/** Persistent work notebook and guarded lifecycle transitions. */
import { randomUUID } from "node:crypto";
import type { DB } from "./sqlite.js";
import type { WorkItemStatus } from "../scheduler/work.js";

export interface WorkItemRow {
	id: string;
	title: string;
	goal: string;
	conditions: string | null;
	progress: string | null;
	/** JSON array of strings. */
	lessons: string | null;
	/** Only this source conversation receives outcome pushes. */
	origin_conversation: string | null;
	origin_note: string | null;
	status: WorkItemStatus;
	question: string | null;
	next_check_at: number | null;
	/** Why the model picked next_check_at — re-injected as context next window. */
	next_check_reason: string | null;
	/** Consecutive windows that picked the same daily slot (cron degeneration meter). */
	fixed_streak: number;
	/** Consecutive windows whose NEXT_CHECK was unusable (soft-fallback meter). */
	fallback_streak: number;
	/** waiting_human re-reminder bookkeeping (updated_at is the entry time). */
	last_remind_at: number | null;
	remind_count: number;
	/** Set by claim() on the first window; durable kickoff-vs-resume marker. */
	kicked_off: number;
	/** Verified confirming admin, not the conversation's proposer. */
	created_by: string | null;
	/** Retained until the first successful resumed send. */
	answer: string | null;
	created_at: number;
	updated_at: number;
}

export interface CreateWorkItemInput {
	title: string;
	goal: string;
	originConversation?: string | null;
	originNote?: string | null;
	status?: WorkItemStatus;
	createdBy?: string | null;
}

export class WorkItemStore {
	private readonly listeners = new Set<(id?: string) => void>();
	constructor(private readonly db: DB) {}

	/** Lifecycle notifications avoid polling for confirms/resumes/cancellations. */
	subscribe(listener: (id?: string) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	private changed(id?: string): void {
		for (const listener of this.listeners) listener(id);
	}

	create(input: CreateWorkItemInput): WorkItemRow {
		const now = Date.now();
		const row: WorkItemRow = {
			id: randomUUID(), title: input.title, goal: input.goal,
			conditions: null, progress: null, lessons: null,
			origin_conversation: input.originConversation ?? null,
			origin_note: input.originNote ?? null, status: input.status ?? "proposed",
			question: null, next_check_at: null, next_check_reason: null, fixed_streak: 0, fallback_streak: 0, last_remind_at: null, remind_count: 0, kicked_off: 0,
			created_by: input.createdBy ?? null,
			answer: null, created_at: now, updated_at: now,
		};
		this.db.prepare(`INSERT INTO work_items
			(id, title, goal, conditions, progress, lessons, origin_conversation, origin_note, status, question, next_check_at, next_check_reason, fixed_streak, fallback_streak, last_remind_at, remind_count, kicked_off, created_by, answer, created_at, updated_at)
			VALUES (@id, @title, @goal, @conditions, @progress, @lessons, @origin_conversation, @origin_note, @status, @question, @next_check_at, @next_check_reason, @fixed_streak, @fallback_streak, @last_remind_at, @remind_count, @kicked_off, @created_by, @answer, @created_at, @updated_at)`).run(row);
		this.changed(row.id);
		return row;
	}

	get(id: string): WorkItemRow | undefined {
		return this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as WorkItemRow | undefined;
	}
	list(): WorkItemRow[] {
		return this.db.prepare("SELECT * FROM work_items ORDER BY updated_at DESC").all() as WorkItemRow[];
	}
	/** FIFO by readiness: busy confirmations remain queued, not dropped. */
	listDue(now: number): WorkItemRow[] {
		return this.db.prepare(`SELECT * FROM work_items WHERE status = 'queued'
			OR (status = 'scheduled' AND next_check_at IS NOT NULL AND next_check_at <= ?)
			ORDER BY CASE WHEN status = 'queued' THEN updated_at ELSE next_check_at END ASC, created_at ASC, rowid ASC`).all(now) as WorkItemRow[];
	}
	nextWakeAt(): number | undefined {
		const row = this.db.prepare("SELECT MIN(next_check_at) AS at FROM work_items WHERE status = 'scheduled'").get() as { at: number | null };
		return row.at ?? undefined;
	}
	listByStatus(...statuses: WorkItemStatus[]): WorkItemRow[] {
		if (!statuses.length) return [];
		return this.db.prepare(`SELECT * FROM work_items WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY updated_at DESC`).all(...statuses) as WorkItemRow[];
	}

	/** Atomic claim prevents duplicate windows. Waiting/proposed are never runnable. */
	claim(id: string, now: number): WorkItemRow | undefined {
		// kicked_off marks the first window durably: resumed/crash-recovered runs
		// must never re-plan (they may have partial effects on record).
		const result = this.db.prepare(`UPDATE work_items SET status = 'working', question = NULL, next_check_at = NULL, kicked_off = 1, updated_at = ?
			WHERE id = ? AND (status = 'queued' OR (status = 'scheduled' AND next_check_at <= ?))`).run(now, id, now);
		return result.changes ? this.get(id) : undefined;
	}
	/** A crash may have applied external effects. Never blindly retry these items. */
	recoverWorking(): void {
		this.db.prepare(`UPDATE work_items SET status = 'waiting_human', question = ?, next_check_at = NULL, last_remind_at = NULL, remind_count = 0, updated_at = ? WHERE status = 'working'`)
			.run("应用曾在执行中退出；请管理员核查已发生的操作，再明确恢复。", Date.now());
		this.changed();
	}

	/** Runner outcomes only transition working; terminal and human states stay safe. */
	setStatus(id: string, status: WorkItemStatus, question: string | null, nextCheckAt: number | null, nextCheckReason?: string | null): WorkItemRow | undefined {
		if (!["waiting_human", "scheduled", "done", "cancelled"].includes(status)) return this.get(id);
		const guard = status === "cancelled" ? "status NOT IN ('done', 'cancelled')" : "status = 'working'";
		// Reason is always overwritten: stale reasons must not survive into states
		// where next_check_at was cleared (waiting_human/done/cancelled).
		// Reminder bookkeeping cleared on EVERY transition: re-entering
		// waiting_human is a fresh stall — a stale count/last_remind_at would
		// push an expired reminder instantly (interval > 24h reschedules) and
		// escalate the copy prematurely (same lesson as fallback_streak).
		this.db.prepare(`UPDATE work_items SET status = ?, question = ?, next_check_at = ?, next_check_reason = ?, last_remind_at = NULL, remind_count = 0, updated_at = ? WHERE id = ? AND ${guard}`)
			.run(status, question, nextCheckAt, nextCheckReason ?? null, Date.now(), id);
		this.changed(id);
		return this.get(id);
	}

	/** Cron-degeneration meter; only meaningful while the item stays scheduled. */
	setFixedStreak(id: string, streak: number): void {
		this.db.prepare("UPDATE work_items SET fixed_streak = ? WHERE id = ? AND status = 'scheduled'")
			.run(Math.max(0, Math.floor(streak)), id);
	}

	/** Soft-fallback meter: consecutive unusable NEXT_CHECK declarations.
	 * Deliberately unguarded by status: it is written mid-window (status
	 * 'working') from the window decision, unlike the notebook edits below. */
	setFallbackStreak(id: string, streak: number): WorkItemRow | undefined {
		this.db.prepare("UPDATE work_items SET fallback_streak = ?, updated_at = ? WHERE id = ?").run(streak, Date.now(), id);
		const row = this.get(id);
		this.changed(id);
		return row;
	}
	/** Notebook and admin-rewrite edits must not mutate terminal items, including late aborted tools. */
	/** Record a reminder attempt (attempt-based: push failures must not spin
	 * the tick). Guarded to waiting_human so a racing resume is not counted. */
	markReminded(id: string, at: number): WorkItemRow | undefined {
		// updated_at deliberately untouched: it stays the waiting_human ENTRY
		// time, the "已等待 X" reference for every future reminder.
		const result = this.db.prepare(`UPDATE work_items SET last_remind_at = ?, remind_count = remind_count + 1 WHERE id = ? AND status = 'waiting_human'`)
			.run(at, id);
		if (!result.changes) return undefined;
		const row = this.get(id);
		this.changed(id);
		return row;
	}
	setField(id: string, field: "title" | "goal" | "conditions" | "progress" | "set_conditions" | "set_progress", value: string): WorkItemRow | undefined {
		const column = field === "set_conditions" ? "conditions" : field === "set_progress" ? "progress" : field;
		if (column !== "title" && column !== "goal" && column !== "conditions" && column !== "progress") return undefined;
		this.db.prepare(`UPDATE work_items SET ${column} = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'cancelled')`).run(value.slice(0, 8000), Date.now(), id);
		return this.get(id);
	}

	/** Admin reschedule: only states that are not mid-window or ended. Keeps the
	 * previous reason when none is given, and RESETS fixed_streak and
	 * fallback_streak: an admin replacing the schedule breaks both meters, so
	 * they must count only the new consecutive cadence — otherwise a stale
	 * streak plus one follow-up at the admin's new time fires a false routine
	 * warning (Copilot review 2026-10-02) or an instant re-escalation right
	 * after the admin's update (the escalation message itself recommends this
	 * update path). */
	setSchedule(id: string, nextCheckAt: number, reason?: string): WorkItemRow | undefined {
		const result = this.db.prepare(`UPDATE work_items SET status = 'scheduled', question = NULL, next_check_at = ?,
			next_check_reason = COALESCE(?, next_check_reason), fixed_streak = 0, fallback_streak = 0, last_remind_at = NULL, remind_count = 0, updated_at = ? WHERE id = ? AND status IN ('queued', 'waiting_human', 'scheduled')`)
			.run(nextCheckAt, reason === undefined ? null : reason, Date.now(), id);
		if (!result.changes) return undefined;
		this.changed(id);
		return this.get(id);
	}

	/** Admin pause: any active state becomes an explicit waiting_human with a
	 * marker question. The service's subscribe watches this marker and aborts
	 * the in-flight window instead of waiting for the next turn checkpoint. */
	pause(id: string, reason?: string): WorkItemRow | undefined {
		const question = `管理员暂停：${reason || "管理员主动暂停"}`.slice(0, 500);
		const result = this.db.prepare(`UPDATE work_items SET status = 'waiting_human', question = ?, next_check_at = NULL, next_check_reason = NULL, last_remind_at = NULL, remind_count = 0, updated_at = ?
			WHERE id = ? AND status IN ('queued', 'scheduled', 'working')`)
			.run(question, Date.now(), id);
		if (!result.changes) return undefined;
		this.changed(id);
		return this.get(id);
	}
	addLesson(id: string, lesson: string): WorkItemRow | undefined {
		const item = this.get(id);
		if (!item) return undefined;
		let lessons: string[] = [];
		try {
			const parsed: unknown = item.lessons ? JSON.parse(item.lessons) : [];
			if (Array.isArray(parsed)) lessons = parsed.filter((l): l is string => typeof l === "string");
		} catch { /* damaged notebook: start a valid array */ }
		lessons.push(lesson.slice(0, 500));
		this.db.prepare("UPDATE work_items SET lessons = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'cancelled')").run(JSON.stringify(lessons.slice(-50)), Date.now(), id);
		return this.get(id);
	}

	stageAnswer(id: string, answer: string): void {
		this.db.prepare("UPDATE work_items SET answer = ?, updated_at = ? WHERE id = ? AND status = 'waiting_human'").run(answer.slice(0, 2000), Date.now(), id);
	}
	clearAnswer(id: string, expected?: string): void {
		this.db.prepare(`UPDATE work_items SET answer = NULL WHERE id = ? AND status = 'working'${expected === undefined ? "" : " AND answer = ?"}`)
			.run(...(expected === undefined ? [id] : [id, expected]));
	}

	confirm(id: string, createdBy: string): WorkItemRow | undefined {
		if (!createdBy.trim()) return undefined;
		const result = this.db.prepare(`UPDATE work_items SET created_by = ?, status = 'queued', question = NULL, next_check_at = NULL, updated_at = ? WHERE id = ? AND status = 'proposed'`)
			.run(createdBy, Date.now(), id);
		if (!result.changes) return undefined;
		this.changed(id);
		return this.get(id);
	}
	/** Single atomic transition: only explicit resume may queue waiting_human. */
	resume(id: string, answer?: string): WorkItemRow | undefined {
		const result = this.db.prepare(`UPDATE work_items SET status = 'queued', question = NULL, next_check_at = NULL, fallback_streak = 0,
			last_remind_at = NULL, remind_count = 0, answer = COALESCE(?, answer), updated_at = ? WHERE id = ? AND status = 'waiting_human'`)
			.run(answer === undefined ? null : answer.slice(0, 2000), Date.now(), id);
		if (!result.changes) return undefined;
		this.changed(id);
		return this.get(id);
	}
	cancel(id: string): WorkItemRow | undefined {
		return this.setStatus(id, "cancelled", null, null);
	}
}
