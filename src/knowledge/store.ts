/**
 * Knowledge content store: manual FAQ entries + imported documents, persisted in
 * kb_entries / kb_docs / kb_chunks. CRUD only — retrieval lives in retrieval/.
 *
 * Manual entries and document chunks both land in kb_chunks so a single index
 * covers everything; manual entries are mirrored in kb_entries for the
 * management UI, documents are tracked in kb_docs.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DB } from "../db/sqlite.js";
import { chunkText } from "./chunker.js";
import { extractText } from "./file-parser.js";

export interface KnowledgeEntry {
	id: string;
	title: string;
	tags: string;
	content: string;
	/** How the entry was produced: "manual" | "learned" | "derived" | "research". */
	origin: string;
	/** Soft-delete flag (consolidation archives, never hard-deletes). */
	archived: number;
	created_at: number;
	updated_at: number;
	/** Monotonic version, bumped on every substantive content change. */
	version: number;
	/** JSON array of source entry ids this was derived/merged from (lineage). */
	lineage: string | null;
	/** 0..1 confidence: manual 1.0 / derived 0.7 / learned 0.6 / research 0.4. */
	confidence: number;
	/** Provenance URL for research-sourced knowledge. */
	source_url: string | null;
	/** "approved" | "pending" | "rejected" — pending (e.g. research) is down-ranked until vetted. */
	review_status: string;
	/** How many times this entry was returned by retrieval (feedback). */
	hit_count: number;
	last_used_at: number | null;
	/** Points to a newer entry id when this one was superseded by a corrective update. */
	superseded_by: string | null;
}

export interface KnowledgeDoc {
	id: string;
	name: string;
	chunks: number;
	created_at: number;
}

/** A recorded KB miss, feeding the auto-research loop. */
export interface KbGap {
	id: string;
	query: string;
	count: number;
	last_seen: number;
	created_at: number;
}

/** A knowledge entry plus a truncated content snippet (for management/list views). */
export interface EntryWithSnippet extends KnowledgeEntry {
	snippet: string;
}

/** Optional hooks, currently used to clean up the kb_vec vectors when chunks are deleted. */
export interface StoreHooks {
	/** Fired with the kb_chunks rowids that were just removed (vec store no-ops when unavailable). */
	onChunksDeleted?: (rowids: number[]) => void;
}

/** A chunk row in the shape retrieval reads it as. */
export interface ChunkRow {
	id: string;
	source: string;
	source_id: string;
	title: string | null;
	tags: string | null;
	content: string;
	chunk_index: number | null;
	metadata: string | null;
	embed_status: string | null;
	embedding_model: string | null;
}

/** A chunk awaiting embedding (selected with its implicit rowid). */
export interface PendingChunk {
	rowid: number;
	id: string;
	content: string;
	source: string;
}

export const MANUAL_SOURCE = "manual";

/** Stable source key for an imported document (keyed by display name). */
export function docSource(displayName: string): string {
	return "doc:" + displayName;
}

export class KnowledgeContentStore {
	private readonly ftsSupported: boolean;
	private readonly hooks: StoreHooks;

	constructor(private readonly db: DB, hooks: StoreHooks = {}) {
		this.hooks = hooks;
		this.ftsSupported = !!db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_chunks_fts'")
			.get();
	}

	ftsEnabled(): boolean {
		return this.ftsSupported;
	}

	listEntries(options: { includeArchived?: boolean } = {}): KnowledgeEntry[] {
		const where = options.includeArchived ? "" : " WHERE archived = 0";
		return this.db
			.prepare(`SELECT * FROM kb_entries${where} ORDER BY updated_at DESC`)
			.all() as KnowledgeEntry[];
	}

	/**
	 * Memory-layer entries: live entries carrying the "memory" tag (the
	 * always-injected user-specific memory index rides on the KB store — no
	 * separate schema). Newest first.
	 */
	listMemory(limit = 30): KnowledgeEntry[] {
		return this.db
			.prepare(
				`SELECT * FROM kb_entries
				 WHERE archived = 0 AND (',' || COALESCE(tags, '') || ',') LIKE '%,memory,%'
				 ORDER BY updated_at DESC LIMIT ?`,
			)
			.all(limit) as KnowledgeEntry[];
	}

	upsertEntry(input: { id?: string; title: string; tags: string; content: string }): KnowledgeEntry {
		const now = Date.now();
		const id = input.id ?? randomUUID();
		this.db
			.prepare(
				"INSERT INTO kb_entries (id, title, tags, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
					"ON CONFLICT(id) DO UPDATE SET title=excluded.title, tags=excluded.tags, content=excluded.content, updated_at=excluded.updated_at",
			)
			.run(id, input.title, input.tags, input.content, now, now);
		this.replaceEntryChunks(id, MANUAL_SOURCE, input.title, input.tags, input.content);
		return this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as KnowledgeEntry;
	}

	/**
	 * Auto-learn upsert: match by title among live entries. On hit, append the new
	 * content (skipping if already present) and union the tags, keeping a 'derived'
	 * origin as-is; otherwise create a new 'learned' entry. Re-chunks so retrieval
	 * (and vector indexing) sees the merged content.
	 */
	saveLearned(input: { title: string; content: string; tags?: string }): { id: string; merged: boolean } {
		const title = input.title.trim();
		const content = input.content.trim();
		if (!title || !content) throw new Error("title and content are required");
		const now = Date.now();
		const existing = this.db
			.prepare("SELECT * FROM kb_entries WHERE title = ? AND archived = 0")
			.get(title) as KnowledgeEntry | undefined;

		if (existing) {
			const mergedContent = existing.content.includes(content)
				? existing.content
				: `${existing.content}\n\n---\n${content}`;
			const mergedTags = unionTags(existing.tags, input.tags ?? "");
			const origin = existing.origin === "derived" ? "derived" : "learned";
			this.db
				.prepare(
					"UPDATE kb_entries SET content = ?, tags = ?, origin = ?, updated_at = ?, version = version + 1 WHERE id = ?",
				)
				.run(mergedContent, mergedTags, origin, now, existing.id);
			this.replaceEntryChunks(existing.id, MANUAL_SOURCE, existing.title, mergedTags, mergedContent);
			return { id: existing.id, merged: true };
		}

		const id = randomUUID();
		const tags = unionTags(input.tags ?? "");
		this.db
			.prepare(
				"INSERT INTO kb_entries (id, title, tags, content, origin, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, 'learned', 0.6, ?, ?)",
			)
			.run(id, title, tags, content, now, now);
		this.replaceEntryChunks(id, MANUAL_SOURCE, title, tags, content);
		return { id, merged: false };
	}

	/**
	 * Persist knowledge obtained via auto-research (web search). Marked
	 * origin='research', low confidence (0.4) and review_status='pending' so it is
	 * down-ranked in retrieval until vetted by a human or corroborated by a later
	 * consolidation pass. Provenance URL is preserved.
	 */
	saveResearched(input: {
		title: string;
		content: string;
		tags?: string;
		sourceUrl?: string;
	}): string {
		const title = input.title.trim();
		const content = input.content.trim();
		if (!title || !content) throw new Error("title and content are required");
		const now = Date.now();
		const id = randomUUID();
		const tags = unionTags(input.tags ?? "");
		this.db
			.prepare(
				"INSERT INTO kb_entries (id, title, tags, content, origin, confidence, review_status, source_url, created_at, updated_at) " +
					"VALUES (?, ?, ?, ?, 'research', 0.4, 'pending', ?, ?, ?)",
			)
			.run(id, title, tags, content, input.sourceUrl ?? null, now, now);
		this.replaceEntryChunks(id, MANUAL_SOURCE, title, tags, content);
		return id;
	}

	/**
	 * Revise an existing entry — the "correct overwrite" path. mode="replace"
	 * overwrites the content entirely (corrective update); mode="append" adds to
	 * it. Bumps version either way and re-chunks. Used by save_to_knowledge when
	 * the LLM corrects/refines an existing entry rather than appending a new one.
	 */
	reviseEntry(
		id: string,
		input: { content: string; title?: string; tags?: string; mode?: "replace" | "append" },
	): KnowledgeEntry | undefined {
		const entry = this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as
			| KnowledgeEntry
			| undefined;
		if (!entry) return undefined;
		const mode = input.mode ?? "replace";
		const nextContent =
			mode === "append"
				? entry.content.includes(input.content)
					? entry.content
					: `${entry.content}\n\n---\n${input.content}`
				: input.content;
		const title = input.title?.trim() || entry.title;
		const tags = input.tags !== undefined ? unionTags(input.tags) : entry.tags;
		this.db
			.prepare(
				"UPDATE kb_entries SET title = ?, tags = ?, content = ?, updated_at = ?, version = version + 1 WHERE id = ?",
			)
			.run(title, tags, nextContent, Date.now(), id);
		this.replaceEntryChunks(id, MANUAL_SOURCE, title, tags, nextContent);
		return this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as KnowledgeEntry;
	}

	deleteEntry(id: string): void {
		this.deleteChunks(MANUAL_SOURCE, id);
		this.db.prepare("DELETE FROM kb_entries WHERE id = ?").run(id);
	}

	listDocs(): KnowledgeDoc[] {
		return this.db.prepare("SELECT * FROM kb_docs ORDER BY created_at DESC").all() as KnowledgeDoc[];
	}

	/**
	 * Import a text/markdown/pdf file, chunk it, and index. Returns chunk count.
	 * Re-importing the same display name replaces (not stacks) — the old code
	 * generated a fresh docId and tried to delete by it, never matching the
	 * previous chunks.
	 */
	async importDocument(absPath: string, displayName: string): Promise<number> {
		const text = await extractText(absPath);
		const chunks = chunkText(text);
		if (chunks.length === 0) return 0;

		const docId = randomUUID();
		const now = Date.now();
		const source = docSource(displayName);
		const insertChunk = this.db.prepare(
			"INSERT INTO kb_chunks (id, source, source_id, title, tags, content, chunk_index, embed_status, created_at, updated_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
		);
		const txn = this.db.transaction((rows: { text: string; chunkIndex: number }[]) => {
			// Idempotent: drop any previous chunks/doc under the same display name.
			this.deleteChunks(source);
			this.db.prepare("DELETE FROM kb_docs WHERE name = ?").run(displayName);
			for (const row of rows) {
				insertChunk.run(
					randomUUID(),
					source,
					docId,
					displayName,
					"",
					row.text,
					row.chunkIndex,
					now,
					now,
				);
			}
			this.db
				.prepare(
					"INSERT INTO kb_docs (id, name, chunks, created_at) VALUES (?, ?, ?, ?) " +
						"ON CONFLICT(id) DO NOTHING",
				)
				.run(docId, displayName, rows.length, now);
		});
		txn(chunks);
		return chunks.length;
	}

	deleteDoc(id: string): void {
		const doc = this.db.prepare("SELECT name FROM kb_docs WHERE id = ?").get(id) as
			| { name: string }
			| undefined;
		if (doc) {
			this.deleteChunks(docSource(doc.name));
		}
		this.db.prepare("DELETE FROM kb_docs WHERE id = ?").run(id);
	}

	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM kb_chunks").get() as { n: number };
		return row.n;
	}

	// --- knowledge gaps (auto-research loop) ---
	/** Record (or bump) a query that missed the KB, feeding the auto-research loop. */
	recordGap(query: string): void {
		const q = query.trim();
		if (!q) return;
		const now = Date.now();
		const existing = this.db.prepare("SELECT id FROM kb_gaps WHERE query = ?").get(q) as
			| { id: string }
			| undefined;
		if (existing) {
			this.db
				.prepare("UPDATE kb_gaps SET count = count + 1, last_seen = ? WHERE id = ?")
				.run(now, existing.id);
		} else {
			this.db
				.prepare(
					"INSERT INTO kb_gaps (id, query, count, last_seen, created_at) VALUES (?, ?, 1, ?, ?)",
				)
				.run(randomUUID(), q, now, now);
		}
	}

	listGaps(limit = 20): KbGap[] {
		return this.db
			.prepare("SELECT * FROM kb_gaps ORDER BY count DESC, last_seen DESC LIMIT ?")
			.all(limit) as KbGap[];
	}

	countGaps(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM kb_gaps").get() as { n: number };
		return row.n;
	}

	/** Drop a gap once it has been answered / sedimented. */
	resolveGap(query: string): void {
		this.db.prepare("DELETE FROM kb_gaps WHERE query = ?").run(query.trim());
	}

	/**
	 * Fetch review/confidence/supersession metadata for a set of manual entry ids.
	 * Used by retrieval to filter rejected/archived/superseded entries and to weight
	 * results by confidence. Returns only rows that exist.
	 */
	fetchEntryMeta(ids: string[]): Map<string, {
		confidence: number;
		review_status: string;
		archived: number;
		superseded_by: string | null;
	}> {
		const map = new Map<string, { confidence: number; review_status: string; archived: number; superseded_by: string | null }>();
		if (ids.length === 0) return map;
		const placeholders = ids.map(() => "?").join(",");
		const rows = this.db
			.prepare(
				`SELECT id, confidence, review_status, archived, superseded_by FROM kb_entries WHERE id IN (${placeholders})`,
			)
			.all(...ids) as {
				id: string;
				confidence: number;
				review_status: string;
				archived: number;
				superseded_by: string | null;
			}[];
		for (const r of rows) {
			map.set(r.id, {
				confidence: r.confidence,
				review_status: r.review_status,
				archived: r.archived,
				superseded_by: r.superseded_by,
			});
		}
		return map;
	}

	/**
	 * Best-effort usage feedback: bump hit_count + refresh last_used_at for the
	 * manual entries returned by a retrieval. Called after a successful search so
	 * frequently-used knowledge is boosted over time. Wrapped in one transaction.
	 */
	bumpUsage(ids: string[]): void {
		if (ids.length === 0) return;
		const now = Date.now();
		const upd = this.db.prepare(
			"UPDATE kb_entries SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?",
		);
		const txn = this.db.transaction((arr: string[]) => {
			for (const id of arr) upd.run(now, id);
		});
		txn(ids);
	}

	// --- consolidation (auto-learn memory) ---
	listLearnedCandidates(batch: number): KnowledgeEntry[] {
		return this.db
			.prepare(
				"SELECT * FROM kb_entries WHERE origin = 'learned' AND archived = 0 ORDER BY updated_at DESC LIMIT ?",
			)
			.all(batch) as KnowledgeEntry[];
	}

	/**
	 * Consolidation candidates: learned AND derived entries (derived must re-enter
	 * the pool so consolidation is iterative — a merged rule can be merged again or
	 * corrected later). Research entries pending review are also included so the
	 * vetting pass can promote/archive them.
	 */
	listConsolidationCandidates(batch: number): KnowledgeEntry[] {
		return this.db
			.prepare(
				"SELECT * FROM kb_entries WHERE archived = 0 AND origin IN ('learned','derived','research') ORDER BY updated_at DESC LIMIT ?",
			)
			.all(batch) as KnowledgeEntry[];
	}

	countByOrigin(origin: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM kb_entries WHERE origin = ? AND archived = 0")
			.get(origin) as { n: number };
		return row.n;
	}

	countArchived(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM kb_entries WHERE archived = 1").get() as {
			n: number;
		};
		return row.n;
	}

	/** Count live entries by review status (e.g. pending research findings awaiting approval). */
	countByReview(status: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM kb_entries WHERE review_status = ? AND archived = 0")
			.get(status) as { n: number };
		return row.n;
	}

	/** Set an entry's review status (pending → approved / rejected). */
	setReviewStatus(id: string, status: string): void {
		this.db
			.prepare("UPDATE kb_entries SET review_status = ?, updated_at = ? WHERE id = ?")
			.run(status, Date.now(), id);
	}

	/** Soft-archive: drop chunks (so retrieval skips it) but keep the entry recoverable. */
	archiveEntry(id: string): void {
		this.deleteChunks(MANUAL_SOURCE, id);
		this.db.prepare("UPDATE kb_entries SET archived = 1 WHERE id = ?").run(id);
	}

	/** Restore an archived entry: un-archive and rebuild its chunks so retrieval sees it again. */
	restoreEntry(id: string): void {
		const entry = this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as
			| KnowledgeEntry
			| undefined;
		if (!entry) return;
		this.db
			.prepare("UPDATE kb_entries SET archived = 0, updated_at = ? WHERE id = ?")
			.run(Date.now(), id);
		this.replaceEntryChunks(id, MANUAL_SOURCE, entry.title, entry.tags, entry.content);
	}

	/**
	 * Find live entries by keyword (title / tags / content), returning a short
	 * content snippet. Used by the manage tool to locate a deletion target.
	 */
	searchEntries(query: string, limit = 10): EntryWithSnippet[] {
		const like = `%${(query ?? "").trim()}%`;
		const rows = this.db
			.prepare(
				`SELECT * FROM kb_entries
				 WHERE archived = 0 AND (title LIKE ? OR tags LIKE ? OR content LIKE ?)
				 ORDER BY updated_at DESC LIMIT ?`,
			)
			.all(like, like, like, limit) as KnowledgeEntry[];
		return rows.map((e) => ({ ...e, snippet: e.content.slice(0, 120) }));
	}

	/** Merge several entries into one new 'derived' entry, archiving the sources. */
	mergeEntries(ids: string[], merged: { title: string; content: string; tags?: string }): string {
		const now = Date.now();
		const id = randomUUID();
		const tags = merged.tags ?? "";
		const sources = ids.filter((x) => typeof x === "string");
		this.db
			.prepare(
				"INSERT INTO kb_entries (id, title, tags, content, origin, confidence, lineage, created_at, updated_at) VALUES (?, ?, ?, ?, 'derived', 0.7, ?, ?, ?)",
			)
			.run(id, merged.title, tags, merged.content, JSON.stringify(sources), now, now);
		this.replaceEntryChunks(id, MANUAL_SOURCE, merged.title, tags, merged.content);
		for (const sid of sources) this.archiveEntry(sid);
		return id;
	}

	/** Replace an entry's tags and re-chunk. */
	retagEntry(id: string, tags: string): void {
		const entry = this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as
			| KnowledgeEntry
			| undefined;
		if (!entry) return;
		this.db.prepare("UPDATE kb_entries SET tags = ?, updated_at = ? WHERE id = ?").run(tags, Date.now(), id);
		this.replaceEntryChunks(id, MANUAL_SOURCE, entry.title, tags, entry.content);
	}

	getConsolidatedAt(): number {
		const row = this.db.prepare("SELECT value FROM kb_state WHERE key = 'consolidated_at'").get() as
			| { value: string }
			| undefined;
		return row ? Number(row.value) || 0 : 0;
	}

	setConsolidatedAt(ts: number): void {
		this.db
			.prepare(
				"INSERT INTO kb_state (key, value) VALUES ('consolidated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(String(ts));
	}

	getResearchedAt(): number {
		const row = this.db.prepare("SELECT value FROM kb_state WHERE key = 'researched_at'").get() as
			| { value: string }
			| undefined;
		return row ? Number(row.value) || 0 : 0;
	}

	setResearchedAt(ts: number): void {
		this.db
			.prepare(
				"INSERT INTO kb_state (key, value) VALUES ('researched_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(String(ts));
	}

	// --- embedding lifecycle (used by the P1 vector indexer) ---
	/** Chunks awaiting embedding (for auto-index / reindex). */
	listPendingChunks(limit = -1): PendingChunk[] {
		return this.db
			.prepare("SELECT rowid, id, content, source FROM kb_chunks WHERE embed_status = 'pending' LIMIT ?")
			.all(limit) as PendingChunk[];
	}

	countByStatus(status: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE embed_status = ?")
			.get(status) as { n: number };
		return row.n;
	}

	/** Mark chunks successfully embedded under `model`. */
	markEmbedded(ids: string[], model: string): void {
		if (ids.length === 0) return;
		const upd = this.db.prepare(
			"UPDATE kb_chunks SET embed_status = 'indexed', embedding_model = ? WHERE id = ?",
		);
		const txn = this.db.transaction((rows: string[]) => {
			for (const id of rows) upd.run(model, id);
		});
		txn(ids);
	}

	/** Mark chunks that failed to embed (retried on the next reindex). */
	markEmbedFailed(ids: string[]): void {
		if (ids.length === 0) return;
		const upd = this.db.prepare("UPDATE kb_chunks SET embed_status = 'failed' WHERE id = ?");
		const txn = this.db.transaction((rows: string[]) => {
			for (const id of rows) upd.run(id);
		});
		txn(ids);
	}

	/** Reset every non-pending chunk back to pending (before a full reindex). */
	resetAllForReindex(): number {
		const row = this.db
			.prepare("UPDATE kb_chunks SET embed_status = 'pending' WHERE embed_status <> 'pending'")
			.run();
		return Number(row.changes ?? 0);
	}

	/**
	 * Delete kb_chunks for a (source, sourceId?) scope and notify the hook with the
	 * removed rowids so the kb_vec vectors can be cleaned up. FTS is synced by its
	 * own triggers; this is the single place that wires vector cleanup in.
	 */
	private deleteChunks(source: string, sourceId?: string): void {
		const rowids = (
			sourceId
				? this.db
						.prepare("SELECT rowid AS rowid FROM kb_chunks WHERE source = ? AND source_id = ?")
						.all(source, sourceId)
				: this.db.prepare("SELECT rowid AS rowid FROM kb_chunks WHERE source = ?").all(source)
		) as { rowid: number }[];
		if (rowids.length === 0) return;
		(
			sourceId
				? this.db.prepare("DELETE FROM kb_chunks WHERE source = ? AND source_id = ?").run(source, sourceId)
				: this.db.prepare("DELETE FROM kb_chunks WHERE source = ?").run(source)
		);
		this.hooks.onChunksDeleted?.(rowids.map((r) => r.rowid));
	}

	private replaceEntryChunks(
		entryId: string,
		source: string,
		title: string,
		tags: string,
		content: string,
	): void {
		this.deleteChunks(source, entryId);
		const now = Date.now();
		const insertChunk = this.db.prepare(
			"INSERT INTO kb_chunks (id, source, source_id, title, tags, content, chunk_index, embed_status, created_at, updated_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
		);
		const chunks = chunkText(content);
		for (const chunk of chunks) {
			insertChunk.run(
				randomUUID(),
				source,
				entryId,
				title,
				tags,
				chunk.text,
				chunk.chunkIndex,
				now,
				now,
			);
		}
		if (chunks.length === 0) {
			insertChunk.run(randomUUID(), source, entryId, title, tags, content || "", 0, now, now);
		}
	}
}

/** Normalize one or more comma-separated tag lists into a de-duplicated comma list. */
function unionTags(...parts: string[]): string {
	const all = parts
		.join(",")
		.split(/[,，]/)
		.map((s) => s.trim())
		.filter(Boolean);
	return [...new Set(all)].join(",");
}
