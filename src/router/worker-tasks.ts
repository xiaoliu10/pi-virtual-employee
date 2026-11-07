/**
 * WorkerTaskStore — the linear state machine for chat-dispatched workers.
 *
 * Router/Worker is INFRASTRUCTURE (user ruling 2026-11-07), not a task type.
 * This store is deliberately tiny: a worker's life is a straight line
 * (queued → running → done) with NO follow-up columns — no next_check, no
 * cadence, no streaks, no resident. Scheduling code paths simply do not exist
 * here; that is the whole point of the split from work_items.
 */
import type { DatabaseSync } from "node:sqlite";

export type WorkerStatus = "queued" | "running" | "done";

export interface WorkerTaskRow {
	id: string;
	instruction: string;
	source_conversation: string;
	created_by: string;
	status: WorkerStatus;
	result: string | null;
	error: string | null;
	max_minutes: number;
	conversation_id: string | null;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
}

export class WorkerTaskStore {
	private readonly db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
	}

	static migrate(db: DatabaseSync): void {
		db.exec(`CREATE TABLE IF NOT EXISTS worker_tasks (
			id TEXT PRIMARY KEY,
			instruction TEXT NOT NULL,
			source_conversation TEXT NOT NULL,
			created_by TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'queued',
			result TEXT,
			error TEXT,
			max_minutes INTEGER NOT NULL DEFAULT 30,
			conversation_id TEXT,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			finished_at INTEGER
		)`);
	}

	create(spec: { id: string; instruction: string; sourceConversation: string; createdBy: string; maxMinutes?: number; now: number }): WorkerTaskRow {
		this.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, max_minutes, created_at)
			VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
			.run(spec.id, spec.instruction, spec.sourceConversation, spec.createdBy, spec.maxMinutes ?? 30, spec.now);
		return this.get(spec.id)!;
	}

	get(id: string): WorkerTaskRow | undefined {
		return this.db.prepare("SELECT * FROM worker_tasks WHERE id = ?").get(id) as WorkerTaskRow | undefined;
	}

	/** FIFO claim; atomic so two ticks cannot double-run one worker. */
	claim(now: number): WorkerTaskRow | undefined {
		const row = this.db.prepare("SELECT id FROM worker_tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
		if (!row) return undefined;
		const r = this.db.prepare(`UPDATE worker_tasks SET status = 'running', started_at = ?, conversation_id = ?
			WHERE id = ? AND status = 'queued'`).run(now, `worker:${row.id}`, row.id);
		return r.changes ? this.get(row.id) : undefined;
	}

	/** The ONLY terminal transition: done. There is no scheduled/waiting state
	 * to fall back into — a finished worker is finished forever. */
	settle(id: string, result: { text?: string; error?: string }, now: number): WorkerTaskRow | undefined {
		const r = this.db.prepare(`UPDATE worker_tasks SET status = 'done', result = ?, error = ?, finished_at = ?
			WHERE id = ? AND status = 'running'`).run(result.text ?? null, result.error ?? null, now, id);
		return r.changes ? this.get(id) : undefined;
	}

	listRecent(limit = 20): WorkerTaskRow[] {
		return this.db.prepare("SELECT * FROM worker_tasks ORDER BY created_at DESC LIMIT ?").all(limit) as WorkerTaskRow[];
	}

	/** The most recent worker of this conversation — Router uses it to route a
	 * follow-up message into the SAME durable session. Status is deliberately
	 * NOT filtered: a DONE worker's session stays persisted (the transcript is
	 * the context), so a follow-up is conversation CONTINUATION, not a state
	 * transition. Follow-up turns are not recorded in this store — the store
	 * tracks the DISPATCH round only; the durable session holds the dialogue. */
	recentForConversation(sourceConversation: string): WorkerTaskRow | undefined {
		return this.db.prepare("SELECT * FROM worker_tasks WHERE source_conversation = ? ORDER BY created_at DESC LIMIT 1")
			.get(sourceConversation) as WorkerTaskRow | undefined;
	}
}
