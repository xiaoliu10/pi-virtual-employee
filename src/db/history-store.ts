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
	/** Where the conversation was created: 'console' (the desktop UI) or 'im' (a messaging channel). */
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

export class HistoryStore {
	constructor(private readonly db: DB) {}

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
	}

	listMessages(conversationId: string): MessageRow[] {
		return this.db
			.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
			.all(conversationId) as MessageRow[];
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
 * channel (`dt:` / `feishu:` / `wecom:` / `echo:`); scheduled tasks use `sched:`;
 * everything else (bare uuids) is the console UI.
 */
export function inferConversationOrigin(id: string): string {
	if (/^(dt|feishu|wecom|echo):/.test(id)) return "im";
	if (id.startsWith("sched:")) return "scheduled";
	return "console";
}
