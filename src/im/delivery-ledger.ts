/**
 * Delivery ledger — the outbox half of IM delivery reliability
 * (docs/design/delivery-reliability.md §3.2, stage S1).
 *
 * WHY a ledger at all: today every push call site decides on its own whether to
 * send, and NOTHING records "this occurrence was already delivered". So the same
 * run can push twice (a retried caller, a resumed chain, a restart between the
 * push and the bookkeeping) and no layer can tell. The ledger answers exactly one
 * question — "has THIS occurrence already gone out?" — keyed by occurrence
 * IDENTITY (task id + fire time, inbound message id), never by content: Hermes
 * explicitly refuses content hashing because identical daily reports are legal
 * pushes, not duplicates (design doc §2 decision ①).
 *
 * States (one row per occurrence, primary key = occurrence_id):
 *
 *   pending ──claim──▶ attempting ──success──▶ delivered   (terminal:永远跳过)
 *                          │
 *                          └──failure──▶ failed ──retry──▶ attempting ──▶ …
 *
 * Crash policy (deliberately at-most-once for restarts): a process that dies
 * while a row sits in `attempting`/`pending` may or may not have delivered. We
 * do NOT re-push on boot — losing a delivery is preferable to silently
 * duplicating one, and the row is only re-examined when the SAME occurrence is
 * triggered again by a later event. `delivered` is permanent: a duplicate is
 * suppressed forever, including across restarts (the skip check re-reads the DB).
 *
 * Backward compatibility: callers without an occurrence identity never touch the
 * ledger — pushToConversation keeps its exact old behaviour.
 */
import type { DB } from "../db/sqlite.js";

export type DeliveryStatus = "pending" | "attempting" | "delivered" | "failed";

export interface PushLedgerRow {
	occurrence_id: string;
	conversation_id: string;
	status: DeliveryStatus;
	attempts: number;
	/** Short label of what kind of push this was ('scheduled' | 'chat' | …). Audit-only. */
	kind: string | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

/**
 * Claim outcome. `skipped:true` means the occurrence is already delivered —
 * the caller must NOT push. `attempts` is the count including this claim.
 */
export interface LedgerClaim {
	skipped: boolean;
	/** true when this claim adopted a row a previous process left in
	 *  pending/attempting (crash evidence — the delivery MAY have landed). */
	recovered: boolean;
	attempts: number;
}

/** Optional context for a claim; all fields are audit-only. */
export interface ClaimOptions {
	/** Human-usable type label stored for diagnostics (e.g. "scheduled"). */
	kind?: string;
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS push_ledger (
		occurrence_id   TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL,
		status          TEXT NOT NULL,
		attempts        INTEGER NOT NULL DEFAULT 0,
		kind            TEXT,
		last_error      TEXT,
		created_at      INTEGER NOT NULL,
		updated_at      INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_push_ledger_conv ON push_ledger(conversation_id, updated_at);
	CREATE INDEX IF NOT EXISTS idx_push_ledger_status ON push_ledger(status, updated_at);
`;

/** Words that identify a single trigger of work. Occurrence ids are opaque to
 *  the ledger, but they show up in logs — keeping them readable ("sched:<taskId>
 *  @<fireInstant>") is worth more than a hash, since the identity requirement is
 *  "same occurrence ⇒ same string", which the caller guarantees either way. */
const MAX_ID_LEN = 300;

export class DeliveryLedger {
	private closed = false;

	constructor(
		private readonly db: DB,
		/** Injectable clock so tests can pin updated_at; defaults to Date.now. */
		private readonly now: () => number = Date.now,
	) {
		this.db.exec(SCHEMA);
	}

	/**
	 * Atomically claim one occurrence for delivery.
	 *
	 * - unknown occurrence → row created in `attempting`, allowed to push
	 * - `delivered`        → `skipped:true`, caller must not push (permanent)
	 * - `failed`           → re-claimed (attempts++), allowed to retry
	 * - `attempting`/`pending` → re-claimed (attempts++), allowed, flagged
	 *   `recovered` (crash left it behind; user may see a duplicate)
	 */
	claim(occurrenceId: string, conversationId: string, opts: ClaimOptions = {}): LedgerClaim {
		const id = normalizeId(occurrenceId);
		const now = this.now();
		return this.tx((): LedgerClaim => {
			const row = this.get(id);
			if (!row) {
				this.db
					.prepare(
						"INSERT INTO push_ledger (occurrence_id, conversation_id, status, attempts, kind, last_error, created_at, updated_at) VALUES (?, ?, 'attempting', 1, ?, NULL, ?, ?)",
					)
					.run(id, conversationId, opts.kind ?? null, now, now);
				return { skipped: false, recovered: false, attempts: 1 };
			}
			if (row.status === "delivered") {
				return { skipped: true, recovered: false, attempts: row.attempts };
			}
			const recovered = row.status === "attempting" || row.status === "pending";
			this.db
				.prepare("UPDATE push_ledger SET status = 'attempting', attempts = attempts + 1, conversation_id = ?, updated_at = ? WHERE occurrence_id = ?")
				.run(conversationId, now, id);
			return { skipped: false, recovered, attempts: row.attempts + 1 };
		});
	}

	/** Mark an occurrence as delivered (terminal). Best-effort by design — a
	 *  throwing ledger must never turn a successful push into a failure. */
	markDelivered(occurrenceId: string): void {
		this.update(occurrenceId, "delivered", null);
	}

	/** Mark an occurrence as failed; the same occurrence may retry later. */
	markFailed(occurrenceId: string, error?: string): void {
		this.update(occurrenceId, "failed", error ?? null);
	}

	/** Read one row (tests / diagnostics). */
	get(occurrenceId: string): PushLedgerRow | undefined {
		if (this.closed) return undefined;
		return this.db.prepare("SELECT * FROM push_ledger WHERE occurrence_id = ?").get(normalizeId(occurrenceId)) as
			| PushLedgerRow
			| undefined;
	}

	/** Count rows per status (health/telemetry convenience). */
	counts(): Record<DeliveryStatus, number> {
		const out: Record<DeliveryStatus, number> = { pending: 0, attempting: 0, delivered: 0, failed: 0 };
		if (this.closed) return out;
		const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM push_ledger GROUP BY status").all() as Array<{
			status: DeliveryStatus;
			n: number;
		}>;
		for (const r of rows) if (r.status in out) out[r.status] = Number(r.n);
		return out;
	}

	/**
	 * Age out old rows (0 = keep forever). Only terminals are pruned by default:
	 * dropping a `delivered` row would re-open the occurrence for a duplicate
	 * push, so retention must stay comfortably longer than any caller's retry
	 * horizon. Callers pass a cutoff well past it (default 30d in the app).
	 */
	prune(beforeTs: number): number {
		if (this.closed) return 0;
		return this.db
			.prepare("DELETE FROM push_ledger WHERE updated_at < ? AND status IN ('delivered', 'failed')")
			.run(beforeTs).changes;
	}

	/** Stop touching the DB after the profile's connection is closed. */
	close(): void {
		this.closed = true;
	}

	private update(occurrenceId: string, status: DeliveryStatus, error: string | null): void {
		if (this.closed) return;
		try {
			this.db
				.prepare("UPDATE push_ledger SET status = ?, last_error = ?, updated_at = ? WHERE occurrence_id = ?")
				.run(status, error ? error.slice(0, 300) : null, this.now(), normalizeId(occurrenceId));
		} catch (err) {
			// Bookkeeping must never fail a delivery that already happened.
			console.warn("[im:ledger] update failed:", (err as Error).message);
		}
	}

	private tx<T>(fn: () => T): T {
		// better-sqlite3 and node:sqlite both expose the same exec/prepare API but
		// only the former has a transaction() helper — one explicit BEGIN keeps the
		// module usable from both (tests run on node:sqlite).
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const out = fn();
			this.db.exec("COMMIT");
			return out;
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* already rolled back */
			}
			throw err;
		}
	}
}

/**
 * Normalize an occurrence id: trimmed, capped. Returns "" for empty input so the
 * manager can treat "no identity" as "do not touch the ledger".
 */
export function normalizeOccurrenceId(raw: string | null | undefined): string {
	return normalizeId(raw ?? "");
}

function normalizeId(raw: string): string {
	return raw.trim().slice(0, MAX_ID_LEN);
}

/**
 * Build the occurrence id for a scheduled-task fire. The identity is
 * (task id, fire instant) — exactly the scheduler's run id — so a re-fire of the
 * SAME occurrence (retry, crash-then-same-event) collapses to one row while the
 * NEXT fire at a later instant is a different occurrence and pushes normally
 * (design doc §2 decision ①: recurring runs are never deduped against each
 * other).
 */
export function scheduledOccurrenceId(taskId: string, fireInstant: number | string): string {
	return `sched:${taskId}@${fireInstant}`;
}

/**
 * Build the occurrence id for an inbound-chat reply. The platform message id is
 * the natural identity: the same inbound message handled twice (stream
 * redelivery after a restart) is one occurrence; a new message is a new one.
 */
export function chatOccurrenceId(channel: string, platformMessageId: string): string {
	return `chat:${channel}:${platformMessageId}`;
}
