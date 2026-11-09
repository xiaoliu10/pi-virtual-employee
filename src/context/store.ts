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
 * Partitioning is the load-bearing property (design §6.5): EVERY QUERY filters
 * on `conversation_id`, so one trigger's session can never read another's rows.
 * The one deliberate exception is `pruneOlderThan` — retention deletes by age
 * across partitions by design (never a read path).
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

	/**
	 * Append one row and let the STORE allocate the ledger position atomically.
	 *
	 * `seq` allocation used to be the caller's `lastSeq() + 1` — a read-then-write
	 * race (review P2-4, 2026-11-09): two writers appending "at the end" could
	 * read the same max and the loser died on the UNIQUE index. Here allocation
	 * and write are ONE `INSERT … SELECT COALESCE(MAX(seq),0)+1` statement, which
	 * SQLite executes atomically; the UNIQUE (conversation_id, seq) index stays
	 * as the cross-writer integrity backstop. This is the entry point for the
	 * engine's turn commits (request / reply / tool digests); {@link appendTurn}
	 * remains for explicit-position writes (compaction write-back, tests).
	 */
	/** Review 9b41e5ba P3-2: one turn = request + digests + reply in ONE
	 * transaction (commitWorkTurn must never leave a half turn behind). Same
	 * atomic INSERT…SELECT seq allocation per row — inside the transaction each
	 * statement sees the previous row, so MAX(seq)+1 allocates consecutively. */
	appendNextMany(conversationId: string, records: Array<Omit<TurnRecord, "seq">>): void {
		if (records.length === 0) return;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const insert = this.db.prepare(
				"INSERT INTO context_entries (conversation_id, seq, kind, text, tool_digest_json, refs_json, created_at) " +
					"SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ? FROM context_entries WHERE conversation_id = ?",
			);
			for (const record of records) {
				insert.run(
					conversationId,
					record.kind,
					record.text,
					record.toolDigest ? JSON.stringify(record.toolDigest) : null,
					record.refs ? JSON.stringify(record.refs) : null,
					record.ts,
					conversationId,
				);
			}
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	appendNext(conversationId: string, record: Omit<TurnRecord, "seq">): TurnRecord {
		const result = this.db
			.prepare(
				"INSERT INTO context_entries (conversation_id, seq, kind, text, tool_digest_json, refs_json, created_at) " +
					"SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ? FROM context_entries WHERE conversation_id = ?",
			)
			.run(
				conversationId,
				record.kind,
				record.text,
				record.toolDigest ? JSON.stringify(record.toolDigest) : null,
				record.refs ? JSON.stringify(record.refs) : null,
				record.ts,
				conversationId,
			);
		const row = this.db
			.prepare("SELECT * FROM context_entries WHERE id = ?")
			.get(Number(result.lastInsertRowid)) as ContextEntryRow | undefined;
		if (!row) throw new Error("context_entries: appended row vanished (driver returned no rowid)");
		return toTurnRecord(row);
	}

	/**
	 * Compaction write-back (the review-confirmed ledger gap): ONE transaction
	 * that deletes the summarized head and inserts its replacement rows (the new
	 * summary / discard note, plus any kept row re-anchored at the seam). Never
	 * partial — a failed write-back leaves the ledger byte-identical, so a
	 * compaction can never lose the head without recording its replacement.
	 *
	 * The params are exactly the DIFF compactIfNeeded produces: `removeSeqs` =
	 * seqs present before but absent from the rebuilt list; `insertRecords` =
	 * rebuilt rows that are new objects (see replaceHeadDiff in
	 * engine/work-ledger.ts — kept rows are re-appended VERBATIM by identity, so
	 * the diff is object identity, never a deep compare).
	 */
	replaceHead(conversationId: string, removeSeqs: number[], insertRecords: TurnRecord[]): void {
		// Explicit transaction (not driver .transaction()): the app's test suites
		// run this store on both better-sqlite3 and node:sqlite, and only BEGIN/
		// COMMIT via exec works on both.
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (removeSeqs.length > 0) {
				const del = this.db.prepare("DELETE FROM context_entries WHERE conversation_id = ? AND seq = ?");
				for (const seq of removeSeqs) del.run(conversationId, seq);
			}
			const insert = this.db.prepare(
				"INSERT INTO context_entries (conversation_id, seq, kind, text, tool_digest_json, refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			for (const record of insertRecords) {
				// Review 9b41e5ba P3-3: the partition is the caller's argument — a
				// record carrying a different conversationId must never cross-write
				// into another partition (contract-level defense; compactIfNeeded
				// preserves identity today, but the store must not trust that).
				if (record.conversationId !== conversationId) {
					throw new Error(`replaceHead: record conversationId ${record.conversationId} does not match partition ${conversationId}`);
				}
				insert.run(
					conversationId,
					record.seq,
					record.kind,
					record.text,
					record.toolDigest ? JSON.stringify(record.toolDigest) : null,
					record.refs ? JSON.stringify(record.refs) : null,
					record.ts,
				);
			}
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
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
	 * that position (an EXPLICIT cursor — incremental reads). Without `sinceSeq`
	 * there is NO lower bound: head rows may sit at seq ≤ 0 (compaction places
	 * the summary one below the first kept row, review P1-1 2026-11-09), and a
	 * default `seq > 0` would silently hide them.
	 */
	listTurns(conversationId: string, opts: ListTurnsOptions = {}): TurnRecord[] {
		const since = opts.sinceSeq;
		// NaN limit would reach sqlite as NaN and throw "datatype mismatch" — treat
		// any non-finite limit as unlimited (review P3-2, 2026-11-09).
		const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit)
			? Math.max(0, Math.floor(opts.limit))
			: undefined;
		const where = since === undefined ? "conversation_id = ?" : "conversation_id = ? AND seq > ?";
		const args = since === undefined ? [conversationId] : [conversationId, since];
		const rows = (
			limit === undefined
				? this.db
						.prepare(`SELECT * FROM context_entries WHERE ${where} ORDER BY seq ASC`)
						.all(...args)
				: this.db
						.prepare(
							`SELECT * FROM (SELECT * FROM context_entries WHERE ${where} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`,
						)
						.all(...args, limit)
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
