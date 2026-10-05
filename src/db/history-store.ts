/**
 * Conversation + message persistence (the "task" list shown in the sidebar).
 *
 * Each conversation is a task/section; messages are appended as the employee
 * runs. The live Agent transcript is kept in memory (on the Agent); this store
 * is the durable copy. Sessions are rebuilt from it on creation (see
 * `rehydrateMessages` in engine/context.ts), so conversation context survives
 * app restarts; long transcripts are summarized (compacted) in memory.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./sqlite.js";

export interface ConversationRow {
	id: string;
	title: string | null;
	created_at: number;
	updated_at: number;
	model_supplier_id: string | null;
	model_model_id: string | null;
	/** Origin: console, im, scheduled, work, or eval (never infer trust from a stored label). */
	origin: string;
}

export interface MessageRow {
	id: string;
	conversation_id: string;
	role: "user" | "assistant";
	content: string;
	created_at: number;
}

/** One observed participant of an IM conversation (the roster row). */
export interface MemberRow {
	staff_id: string;
	name: string | null;
	first_seen_at: number;
	last_seen_at: number;
	message_count: number;
}

export interface MiningMessageRow extends MessageRow {
	/** SQLite insertion order disambiguates messages sharing a millisecond. */
	mining_rowid: number;
}

export interface MiningCursor {
	createdAt: number;
	rowid: number;
}

export class HistoryStore {
	constructor(private readonly db: DB) {
		// Runtime state, not user configuration. Safe for existing profiles too.
		db.exec(`CREATE TABLE IF NOT EXISTS work_mining_cursors (
			conversation_id TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			message_rowid INTEGER NOT NULL
		)`);
	}

	listConversations(): ConversationRow[] {
		return this.db
			.prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
			.all() as ConversationRow[];
	}

	getConversation(id: string): ConversationRow | undefined {
		return this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
			| ConversationRow
			| undefined;
	}

	/**
	 * Create if absent; returns the row. `origin` records where the conversation
	 * came from and is fixed at creation (ON CONFLICT keeps the first writer's).
	 * When omitted it is inferred from the id: IM adapters prefix conversation
	 * ids with `<channel>:` (e.g. `dt:group:…`), console ids are bare uuids.
	 */
	ensureConversation(id: string, title: string | null, origin?: string): ConversationRow {
		const now = Date.now();
		const inferred = origin ?? inferConversationOrigin(id);
		this.db
			.prepare(
				"INSERT INTO conversations (id, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
					"ON CONFLICT(id) DO NOTHING",
			)
			.run(id, title, inferred, now, now);
		return this.getConversation(id)!;
	}

	/** Whether a conversation is read-only in the console (created by an IM channel). */
	isReadOnly(id: string): boolean {
		return this.getConversation(id)?.origin === "im";
	}

	setTitle(id: string, title: string): void {
		this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(
			title,
			Date.now(),
			id,
		);
	}

	/**
	 * Store the conversation's PLATFORM name (a DingTalk group's title). Kept
	 * separate from setTitle so it never touches updated_at: this is metadata
	 * arriving with every inbound message, not user activity, and bumping it
	 * would reshuffle the sidebar order on each message. The name is what lets an
	 * admin refer to a group the only way they can — by name.
	 */
	setConversationName(id: string, name: string): void {
		this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(name, id);
	}

	touch(id: string): void {
		this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(Date.now(), id);
	}

	deleteConversation(id: string): void {
		this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
		this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM work_mining_cursors WHERE conversation_id = ?").run(id);
	}

	listMessages(conversationId: string): MessageRow[] {
		return this.db
			.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
			.all(conversationId) as MessageRow[];
	}

	/** Recent tail for explicit lookbacks; automatic mining uses durable pages below. */
	listMessagesSince(conversationId: string, sinceTs: number, limit = 40): MessageRow[] {
		return this.db
			.prepare(
				"SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC",
			)
			.all(conversationId, sinceTs, limit) as MessageRow[];
	}

	getMiningCursor(conversationId: string): MiningCursor | undefined {
		return this.db.prepare(
			"SELECT created_at AS createdAt, message_rowid AS rowid FROM work_mining_cursors WHERE conversation_id = ?",
		).get(conversationId) as MiningCursor | undefined;
	}

	/** Oldest unprocessed page, NOT the tail: bounded scans must not skip backlog. */
	listMiningMessages(conversationId: string, cursor: MiningCursor, untilTs: number, limit = 25): MiningMessageRow[] {
		return this.db.prepare(`SELECT *, rowid AS mining_rowid FROM messages
			WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?))
			AND created_at <= ? ORDER BY created_at ASC, rowid ASC LIMIT ?`)
			.all(conversationId, cursor.createdAt, cursor.createdAt, cursor.rowid, untilTs, limit) as MiningMessageRow[];
	}

	/** Advance only after a successful source scan; failures remain retryable. */
	setMiningCursor(conversationId: string, cursor: MiningCursor): void {
		this.db.prepare(`INSERT INTO work_mining_cursors (conversation_id, created_at, message_rowid)
			VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET
			created_at = excluded.created_at, message_rowid = excluded.message_rowid
			WHERE excluded.created_at > work_mining_cursors.created_at OR
			(excluded.created_at = work_mining_cursors.created_at AND excluded.message_rowid > work_mining_cursors.message_rowid)`)
			.run(conversationId, cursor.createdAt, cursor.rowid);
	}

	/** Per-conversation model override (null → use global default). */
	getModelOverride(conversationId: string): { supplierId: string; modelId: string } | null {
		const row = this.db
			.prepare("SELECT model_supplier_id AS s, model_model_id AS m FROM conversations WHERE id = ?")
			.get(conversationId) as { s: string | null; m: string | null } | undefined;
		if (row && row.s && row.m) return { supplierId: row.s, modelId: row.m };
		return null;
	}

	setModelOverride(conversationId: string, supplierId: string, modelId: string): void {
		this.db
			.prepare(
				"UPDATE conversations SET model_supplier_id = ?, model_model_id = ?, updated_at = ? WHERE id = ?",
			)
			.run(supplierId, modelId, Date.now(), conversationId);
	}

	/** Drop the per-conversation model pin so the conversation follows the global default again. */
	clearModelOverride(conversationId: string): void {
		this.db
			.prepare("UPDATE conversations SET model_supplier_id = NULL, model_model_id = NULL WHERE id = ?")
			.run(conversationId);
	}

	appendMessage(
		conversationId: string,
		role: "user" | "assistant",
		content: string,
	): MessageRow {
		const now = Date.now();
		const id = randomUUID();
		this.db
			.prepare(
				"INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(id, conversationId, role, content, now);
		this.touch(conversationId);
		return { id, conversation_id: conversationId, role, content, created_at: now };
	}

	/**
	 * Record that a platform-verified sender appeared in a conversation. Called
	 * for EVERY inbound IM message — including ones we refuse to serve — because
	 * the roster is what lets an admin say "给这个群的人设权限" without knowing
	 * staffIds. Idempotent per (conversation, sender): repeats bump the counter and
	 * last-seen, and fill in a name the first time one is known.
	 */
	recordMember(conversationId: string, staffId: string, name?: string): void {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO conversation_members (conversation_id, staff_id, name, first_seen_at, last_seen_at, message_count)
				 VALUES (?, ?, ?, ?, ?, 1)
				 ON CONFLICT(conversation_id, staff_id) DO UPDATE SET
					last_seen_at = excluded.last_seen_at,
					message_count = message_count + 1,
					name = COALESCE(NULLIF(excluded.name, ''), name)`,
			)
			.run(conversationId, staffId, name?.trim() || null, now, now);
	}

	/** Observed participants of one conversation, most recently active first. */
	listMembers(conversationId: string): MemberRow[] {
		return this.db
			.prepare(
				"SELECT staff_id, name, first_seen_at, last_seen_at, message_count FROM conversation_members WHERE conversation_id = ? ORDER BY last_seen_at DESC",
			)
			.all(conversationId) as MemberRow[];
	}
}

/**
 * Infer a conversation's origin from its id. IM adapters prefix ids with their
 * channel (`dt:` / `feishu:` / `wecom:` / `echo:`); scheduled tasks use `sched:`,
 * autonomous work uses `work:`; everything else (bare uuids) is the console UI.
 */
export function inferConversationOrigin(id: string): string {
	if (/^(dt|feishu|wecom|echo):/.test(id)) return "im";
	if (id.startsWith("sched:")) return "scheduled";
	// Unattended work MUST NOT inherit the console's implicit admin trust.
	if (id.startsWith("work:")) return "work";
	// Prompt-lab evaluation runs: isolated, never persisted, excluded from telemetry
	// so the improvement loop does not measure its own experiments.
	if (id.startsWith("eval:")) return "eval";
	return "console";
}
