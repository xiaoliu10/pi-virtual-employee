/**
 * ContextStore — the CCL ledger (append-only, sqlite).
 *
 * Same shape as `HistoryStore`: one table on the app's existing sqlite handle,
 * `CREATE TABLE IF NOT EXISTS` in the constructor (so an existing profile picks
 * it up on first launch, no migration step), prepared statements per call.
 *
 * What it is NOT: a chat transcript. `messages` stays the UI-facing copy of
 * user/assistant text; this table is the turn-level ledger the context layer
 * assembles from — including tool digests, steering and delivery rows that never
 * belonged in the chat list.
 *
 * Partitioning is the load-bearing property (design §6.5): EVERY query filters
 * on `conversation_id`, so one trigger's session can never read another's rows.
 */
import type { DB } from "../db/sqlite.js";
import type { TurnRecord } from "./records.js";

/** Raw row shape (snake_case, as stored). */
export interface ContextEntryRow {
	id: number;
	conversation_id: string;
	seq: number;
	kind: string;
	text: string;
	tool_digest_json: string | null;
	refs_json: string | null;
	created_at: number;
}

export interface ListTurnsOptions {
	/** Keep only the newest N rows (still returned oldest→newest). */
	limit?: number;
	/** Only rows after this ledger position (exclusive) — incremental reads. */
	sinceSeq?: number;
}

export class ContextStore {
	constructor(private readonly db: DB) {
		// Runtime state, not user configuration. Safe for existing profiles too
		// (same migration style as HistoryStore's work_mining_cursors).
		db.exec(`CREATE TABLE IF NOT EXISTS context_entries (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL,
			seq             INTEGER NOT NULL,
			kind            TEXT NOT NULL,
			text            TEXT NOT NULL,
			tool_digest_json TEXT,
			refs_json       TEXT,
			created_at      INTEGER NOT NULL
		)`);
		// One row per ledger position per partition: a duplicate append is an
		// integrity error, never a silent rewrite — append-only means that.
		db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_context_entries_conv_seq ON context_entries(conversation_id, seq)");
		db.exec("CREATE INDEX IF NOT EXISTS idx_context_entries_created ON context_entries(created_at)");
	}

	/**
	 * Append one row verbatim and return it as stored.
	 *
	 * `seq` is the ledger position and belongs to the CALLER (this is an
	 * append-only event log, not a queue): allocate it with {@link lastSeq} + 1,
	 * or reuse an existing position when replacing a compacted head (see
	 * compact.ts). A colliding (conversation_id, seq) throws instead of
	 * overwriting history.
	 */
	appendTurn(record: TurnRecord): TurnRecord {
		this.db
			.prepare(
				"INSERT INTO context_entries (conversation_id, seq, kind, text, tool_digest_json, refs_json, created_at) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				record.conversationId,
				record.seq,
				record.kind,
				record.text,
				record.toolDigest ? JSON.stringify(record.toolDigest) : null,
				record.refs ? JSON.stringify(record.refs) : null,
				record.ts,
			);
		return record;
	}

	/** Latest ledger position in a partition (0 when it has no rows). */
	lastSeq(conversationId: string): number {
		const row = this.db
			.prepare("SELECT MAX(seq) AS s FROM context_entries WHERE conversation_id = ?")
			.get(conversationId) as { s: number | null };
		return row?.s ?? 0;
	}

	/**
	 * Rows of ONE partition, oldest→newest (the order the ledger was written).
	 * `limit` keeps the newest N; `sinceSeq` skips everything up to and including
	 * that position. Both compose (newest N after a cursor).
	 */
	listTurns(conversationId: string, opts: ListTurnsOptions = {}): TurnRecord[] {
		const since = opts.sinceSeq ?? 0;
		const limit = opts.limit !== undefined ? Math.max(0, Math.floor(opts.limit)) : undefined;
		const rows = (
			limit === undefined
				? this.db
						.prepare("SELECT * FROM context_entries WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC")
						.all(conversationId, since)
				: this.db
						.prepare(
							"SELECT * FROM (SELECT * FROM context_entries WHERE conversation_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
						)
						.all(conversationId, since, limit)
		) as ContextEntryRow[];
		return rows.map(toTurnRecord);
	}

	/** Drop rows older than `cutoffMs` (age-based retention). Returns how many. */
	pruneOlderThan(cutoffMs: number): number {
		return this.db.prepare("DELETE FROM context_entries WHERE created_at < ?").run(cutoffMs).changes;
	}

	/** Drop a whole partition (a conversation was deleted). */
	deleteConversation(id: string): void {
		this.db.prepare("DELETE FROM context_entries WHERE conversation_id = ?").run(id);
	}
}

/** Row → record. JSON columns are trusted (we wrote them); a malformed value
 * degrades to "absent" rather than throwing away the whole row. */
function toTurnRecord(row: ContextEntryRow): TurnRecord {
	return {
		conversationId: row.conversation_id,
		seq: row.seq,
		kind: row.kind as TurnRecord["kind"],
		text: row.text,
		toolDigest: parseJson(row.tool_digest_json),
		refs: parseJson(row.refs_json),
		ts: row.created_at,
	};
}

function parseJson<T>(raw: string | null): T | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}
