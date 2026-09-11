/**
 * Persistence for scheduled tasks (created in conversation or via settings,
 * run by SchedulerService at their cron time). Pure CRUD — cron → next_run
 * computation lives in the scheduler, which passes nextRunAt in.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./sqlite.js";

export interface ScheduledTaskRow {
	id: string;
	title: string;
	prompt: string;
	cron: string;
	enabled: number; // 0 | 1
	conversation_id: string | null;
	origin: string; // 'console' | 'im' | 'scheduled'
	/** Admin senderId captured at creation in a 1:1 chat; NULL for console-created. */
	created_by: string | null;
	last_run_at: number | null;
	next_run_at: number | null;
	last_status: string | null; // 'ok' | 'error:…'
	created_at: number;
	updated_at: number;
}

export interface CreateScheduledTaskInput {
	title: string;
	prompt: string;
	cron: string;
	enabled?: boolean;
	conversationId?: string | null;
	origin?: string;
	/** Admin senderId (verified 1:1 creator). Stored so unattended runs can re-attach it. */
	createdBy?: string | null;
	nextRunAt: number | null;
}

export class ScheduledTaskStore {
	constructor(private readonly db: DB) {}

	create(input: CreateScheduledTaskInput): ScheduledTaskRow {
		const now = Date.now();
		const row: ScheduledTaskRow = {
			id: randomUUID(),
			title: input.title,
			prompt: input.prompt,
			cron: input.cron,
			enabled: input.enabled === false ? 0 : 1,
			conversation_id: input.conversationId ?? null,
			origin: input.origin ?? "console",
			created_by: input.createdBy ?? null,
			last_run_at: null,
			next_run_at: input.nextRunAt,
			last_status: null,
			created_at: now,
			updated_at: now,
		};
		this.db
			.prepare(
				`INSERT INTO scheduled_tasks
				 (id, title, prompt, cron, enabled, conversation_id, origin, created_by, last_run_at, next_run_at, last_status, created_at, updated_at)
				 VALUES (@id, @title, @prompt, @cron, @enabled, @conversation_id, @origin, @created_by, @last_run_at, @next_run_at, @last_status, @created_at, @updated_at)`,
			)
			.run(row);
		return row;
	}

	list(): ScheduledTaskRow[] {
		return this.db
			.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC")
			.all() as ScheduledTaskRow[];
	}

	get(id: string): ScheduledTaskRow | undefined {
		return this.db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as
			| ScheduledTaskRow
			| undefined;
	}

	delete(id: string): void {
		this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
	}

	/** Enable/disable; recomputes next_run_at (caller passes the new value). */
	setEnabled(id: string, enabled: boolean, nextRunAt: number | null): void {
		this.db
			.prepare(
				"UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
			)
			.run(enabled ? 1 : 0, nextRunAt, Date.now(), id);
	}

	/**
	 * Patch an existing task's editable fields (title/prompt/cron/push target).
	 * Only provided fields change; nextRunAt is passed by the scheduler (recomputed
	 * when cron changes, kept otherwise). Returns the updated row, or undefined
	 * when the id doesn't exist.
	 */
	update(
		id: string,
		patch: { title?: string; prompt?: string; cron?: string; conversationId?: string | null },
		nextRunAt?: number | null,
	): ScheduledTaskRow | undefined {
		const task = this.get(id);
		if (!task) return undefined;
		const merged = {
			title: patch.title ?? task.title,
			prompt: patch.prompt ?? task.prompt,
			cron: patch.cron ?? task.cron,
			conversation_id: patch.conversationId !== undefined ? patch.conversationId : task.conversation_id,
		};
		this.db
			.prepare(
				"UPDATE scheduled_tasks SET title = @title, prompt = @prompt, cron = @cron, conversation_id = @conversation_id, next_run_at = @next_run_at, updated_at = @updated_at WHERE id = @id",
			)
			.run({
				id,
				...merged,
				next_run_at: nextRunAt === undefined ? task.next_run_at : nextRunAt,
				updated_at: Date.now(),
			});
		return this.get(id);
	}

	/**
	 * Attach (or replace) the creator identity on an existing task, so
	 * unattended runs can re-attach it for run_command. Used by the
	 * authorize_scheduled_task conversation action after a verified admin
	 * confirms — the alternative is delete + recreate, which loses history.
	 * Returns the updated row, or undefined when the id doesn't exist.
	 */
	setCreatedBy(id: string, senderId: string): ScheduledTaskRow | undefined {
		this.db
			.prepare("UPDATE scheduled_tasks SET created_by = ?, updated_at = ? WHERE id = ?")
			.run(senderId, Date.now(), id);
		return this.get(id);
	}

	/** Tasks whose next run is due now (or overdue), enabled only. */
	listDue(now: number): ScheduledTaskRow[] {
		return this.db
			.prepare(
				"SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
			)
			.all(now) as ScheduledTaskRow[];
	}

	/** Record a run and schedule the next iteration. */
	markRun(id: string, status: string, nextRunAt: number | null): void {
		this.db
			.prepare(
				"UPDATE scheduled_tasks SET last_run_at = ?, last_status = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
			)
			.run(Date.now(), status, nextRunAt, Date.now(), id);
	}
}
