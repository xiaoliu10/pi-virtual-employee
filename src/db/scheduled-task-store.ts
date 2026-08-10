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
			last_run_at: null,
			next_run_at: input.nextRunAt,
			last_status: null,
			created_at: now,
			updated_at: now,
		};
		this.db
			.prepare(
				`INSERT INTO scheduled_tasks
				 (id, title, prompt, cron, enabled, conversation_id, origin, last_run_at, next_run_at, last_status, created_at, updated_at)
				 VALUES (@id, @title, @prompt, @cron, @enabled, @conversation_id, @origin, @last_run_at, @next_run_at, @last_status, @created_at, @updated_at)`,
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
