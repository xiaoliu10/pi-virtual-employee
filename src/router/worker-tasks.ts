/**
 * WorkerTaskStore — the linear state machine for chat-dispatched workers.
 *
 * Router/Worker is INFRASTRUCTURE (user ruling 2026-11-07), not a task type.
 * This store is deliberately tiny: a worker's life is a straight line
 * (queued → running → done) with NO follow-up columns — no next_check, no
 * cadence, no streaks, no resident. Scheduling code paths simply do not exist
 * here; that is the whole point of the split from work_items.
 */
import type { DB } from "../db/sqlite.js";

export type WorkerStatus = "queued" | "running" | "done" | "cancelled";

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
	private readonly db: DB;
	constructor(db: DB) {
		this.db = db;
	}

	static migrate(db: DB): void {
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
		return this.db.prepare("SELECT * FROM worker_tasks WHERE id = ?").get(id) as unknown as WorkerTaskRow | undefined;
	}

	/** FIFO claim; atomic so two ticks cannot double-run one worker. */
	claim(now: number): WorkerTaskRow | undefined {
		const row = this.db.prepare("SELECT id FROM worker_tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
		if (!row) return undefined;
		const r = this.db.prepare(`UPDATE worker_tasks SET status = 'running', started_at = ?, conversation_id = ?
			WHERE id = ? AND status = 'queued'`).run(now, `worker:${row.id}`, row.id);
		return r.changes ? this.get(row.id) : undefined;
	}

	/** The ONLY terminal transition from running: done. There is no
	 * scheduled/waiting state to fall back into — a finished worker is finished
	 * forever. */
	settle(id: string, result: { text?: string; error?: string }, now: number): WorkerTaskRow | undefined {
		const r = this.db.prepare(`UPDATE worker_tasks SET status = 'done', result = ?, error = ?, finished_at = ?
			WHERE id = ? AND status = 'running'`).run(result.text ?? null, result.error ?? null, now, id);
		return r.changes ? this.get(id) : undefined;
	}

	/** 「前台执行」escape (router-worker D6): the DISPATCHER (same conversation,
	 * same sender) may cancel a queued-or-running worker back into the
	 * foreground. Cancelled is a legitimate linear terminal — never a loop
	 * back into queued, and never a schedule. */
	cancelForEscape(sourceConversation: string, senderId: string, note: string, now: number): WorkerTaskRow | undefined {
		const row = this.db.prepare(`SELECT * FROM worker_tasks WHERE source_conversation = ? AND created_by = ?
			AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).get(sourceConversation, senderId) as unknown as WorkerTaskRow | undefined;
		if (!row) return undefined;
		const r = this.db.prepare(`UPDATE worker_tasks SET status = 'cancelled', error = ?, finished_at = ?
			WHERE id = ? AND status IN ('queued','running')`).run(note, now, row.id);
		return r.changes ? this.get(row.id) : undefined;
	}

	listRecent(limit = 20): WorkerTaskRow[] {
		return this.db.prepare("SELECT * FROM worker_tasks ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as WorkerTaskRow[];
	}

	/** The most recent worker of this conversation — Router uses it to route a
	 * follow-up message into the SAME durable session. Status is deliberately
	 * NOT filtered: a DONE worker's session stays persisted (the transcript is
	 * the context), so a follow-up is conversation CONTINUATION, not a state
	 * transition. Follow-up turns are not recorded in this store — the store
	 * tracks the DISPATCH round only; the durable session holds the dialogue. */
	/** Reverse lookup: which SOURCE conversation does this transcript act for?
	 * A worker session id (`worker:<taskId>` or the durable conversation id
	 * stored on the row) resolves to the chat the user is actually talking in. */
	sourceForConversation(conversationId: string): string | undefined {
		const row = this.db.prepare(
			"SELECT source_conversation FROM worker_tasks WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
		).get(conversationId) as unknown as { source_conversation: string } | undefined;
		return row?.source_conversation;
	}

	/** The conversation's most recent worker — follow-ups continue it (user
	 * ruling 2026-11-07: a follow-up is CONVERSATION, not a state transition;
	 * the session survives `done` precisely so the dialogue keeps its context). */
	/** The conversation's recent tasks, newest first (context-management.md P1:
	 * the Inline feed for "上次那个任务" style references). Bounded by the caller. */
	listRecentForConversation(sourceConversation: string, limit: number): WorkerTaskRow[] {
		return this.db.prepare(
			"SELECT * FROM worker_tasks WHERE source_conversation = ? ORDER BY created_at DESC LIMIT ?",
		).all(sourceConversation, limit) as unknown as WorkerTaskRow[];
	}

	recentForConversation(sourceConversation: string): WorkerTaskRow | undefined {
		return this.db.prepare("SELECT * FROM worker_tasks WHERE source_conversation = ? ORDER BY created_at DESC LIMIT 1")
			.get(sourceConversation) as unknown as WorkerTaskRow | undefined;
	}
}
