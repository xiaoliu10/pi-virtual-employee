/**
 * Built-in local retrieval provider: BM25 (FTS5 → LIKE) fused with vector
 * recall (sqlite-vec) via Reciprocal Rank Fusion.
 *
 * Vector recall is optional: if no VecStore or EmbedProvider is wired in, or any
 * step throws, search degrades to BM25-only. BM25 is the always-available floor.
 */
import type { DB } from "../../db/sqlite.js";
import type { ChunkRow, KnowledgeContentStore } from "../store.js";
import type {
	EmbedProvider,
	HealthStatus,
	ReindexReport,
	RetrievalHit,
	RetrievalProvider,
	SearchRequest,
} from "../types.js";
import type { VecStore } from "../vec-store.js";

export interface LocalRetrievalConfig {
	topK: number;
	bm25Weight: number;
	vectorWeight: number;
	/** Active embedding provider, or null when vector recall is disabled. */
	embed: EmbedProvider | null;
}

export interface LocalRetrievalOptions {
	db: DB;
	store: KnowledgeContentStore;
	vec?: VecStore;
	/** Read live config (weights / topK / active embed provider) at call time. */
	readConfig: () => LocalRetrievalConfig;
}

export class LocalRetrievalProvider implements RetrievalProvider {
	readonly id = "local";
	readonly kind = "local" as const;
	readonly capabilities = { upsert: true, delete: true, vector: true, rerank: false };

	constructor(private readonly opts: LocalRetrievalOptions) {}

	async search(req: SearchRequest): Promise<RetrievalHit[]> {
		const trimmed = req.query.trim();
		if (!trimmed) return [];
		const cfg = this.opts.readConfig();
		const limit = req.topK || cfg.topK;
		const k = 60; // RRF constant — keep in sync with rrf.ts DEFAULT_K.

		// BM25 recall — always available (the fallback floor).
		const bm25Rows = this.ftsEnabled()
			? this.ftsSearch(trimmed, limit)
			: this.likeSearch(trimmed, limit);

		// Vector recall — optional, degrades to BM25-only on any failure.
		const vectorRows = await this.vectorRecall(trimmed, limit, cfg);

		// Compute per-component RRF contributions so callers see real scores
		// (instead of the previous hardcoded { bm25: 1 }).
		const contrib = new Map<string, { row: ChunkRow; bm25: number; vector: number }>();
		bm25Rows.forEach((row, i) =>
			contrib.set(row.id, { row, bm25: cfg.bm25Weight / (k + i + 1), vector: 0 }),
		);
		vectorRows.forEach((row, i) => {
			const c = contrib.get(row.id);
			if (c) c.vector = cfg.vectorWeight / (k + i + 1);
			else contrib.set(row.id, { row, bm25: 0, vector: cfg.vectorWeight / (k + i + 1) });
		});

		// Fused score = sum of contributions (matches reciprocalRankFuse output).
		const scored = [...contrib.values()].map((c) => ({
			row: c.row,
			score: c.bm25 + c.vector,
			bm25: c.bm25,
			vector: c.vector,
		}));

		// Enrich with entry-level metadata (confidence / review / archived /
		// superseded) for manual entries, then filter rigor-violating hits.
		const manualIds = scored
			.map((s) => (s.row.source === "manual" && s.row.source_id ? s.row.source_id : null))
			.filter((x): x is string => !!x);
		const meta = this.opts.store.fetchEntryMeta(manualIds);

		const filtered = scored.filter((s) => {
			if (s.row.source !== "manual" || !s.row.source_id) return true; // docs have no review state
			const m = meta.get(s.row.source_id);
			if (!m) return true;
			if (m.archived || m.review_status === "rejected" || m.superseded_by) return false;
			return true;
		});

		// Weight by confidence and penalize unvetted (pending) entries.
		const weighted = filtered.map((s) => {
			const m = s.row.source === "manual" && s.row.source_id ? meta.get(s.row.source_id) : undefined;
			const confidence = m?.confidence ?? 1;
			const pending = m?.review_status === "pending";
			let score = s.score * (0.6 + 0.8 * confidence);
			if (pending) score *= 0.7;
			return {
				row: s.row,
				score,
				bm25: s.bm25,
				vector: s.vector,
			};
		});

		const top = weighted.sort((a, b) => b.score - a.score).slice(0, limit);

		// Best-effort usage feedback for the manual entries that surfaced.
		const usedIds = top
			.map((s) => (s.row.source === "manual" && s.row.source_id ? s.row.source_id : null))
			.filter((x): x is string => !!x);
		try {
			this.opts.store.bumpUsage(usedIds);
		} catch {
			/* non-fatal — retrieval must never fail on feedback writes */
		}

		return top.map((s) => {
			const hit = toHit(s.row);
			hit.score = s.score;
			hit.scores = { bm25: s.bm25, vector: s.vector };
			return hit;
		});
	}

	async health(): Promise<HealthStatus> {
		const vecOn = !!this.opts.vec?.isAvailable();
		return {
			ok: true,
			ready: true,
			detail: `${this.ftsEnabled() ? "fts5" : "like"}${vecOn ? "+vector" : ""}`,
		};
	}

	/** Indexing is driven by KnowledgeService (it owns the embed provider). */
	async reindex(): Promise<ReindexReport> {
		return { total: 0, indexed: 0, failed: 0, skipped: 0 };
	}

	private async vectorRecall(
		query: string,
		limit: number,
		cfg: LocalRetrievalConfig,
	): Promise<ChunkRow[]> {
		const vec = this.opts.vec;
		if (cfg.vectorWeight <= 0 || !vec?.isAvailable() || !cfg.embed) return [];
		try {
			const qVec = await cfg.embed.embedOne(query);
			const knn = vec.knn(qVec, limit);
			if (knn.length === 0) return [];
			const byId = new Map(this.fetchChunks(knn.map((h) => h.chunkId)).map((r) => [r.id, r]));
			// Preserve KNN order (already sorted by distance) for RRF ranking.
			return knn
				.map((h) => byId.get(h.chunkId))
				.filter((r): r is ChunkRow => !!r);
		} catch (err) {
			console.warn("[knowledge] vector recall failed, using BM25 only:", (err as Error).message);
			return [];
		}
	}

	private fetchChunks(ids: string[]): ChunkRow[] {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(",");
		return this.opts.db
			.prepare(
				`SELECT id, source, source_id, title, tags, content, chunk_index, metadata,
				        embed_status, embedding_model
				 FROM kb_chunks WHERE id IN (${placeholders})`,
			)
			.all(...ids) as ChunkRow[];
	}

	private ftsEnabled(): boolean {
		return this.opts.store.ftsEnabled();
	}

	private ftsSearch(query: string, limit: number): ChunkRow[] {
		const ftsQuery = toFtsQuery(query);
		return this.opts.db
			.prepare(
				`SELECT c.id AS id, c.source AS source, c.source_id AS source_id, c.title AS title,
				        c.tags AS tags, c.content AS content, c.chunk_index AS chunk_index,
				        c.metadata AS metadata, c.embed_status AS embed_status,
				        c.embedding_model AS embedding_model
				 FROM kb_chunks_fts JOIN kb_chunks c ON c.rowid = kb_chunks_fts.rowid
				 WHERE kb_chunks_fts MATCH ?
				 ORDER BY rank LIMIT ?`,
			)
			.all(ftsQuery, limit) as ChunkRow[];
	}

	private likeSearch(query: string, limit: number): ChunkRow[] {
		const pattern = `%${query.replace(/[%_]/g, (m) => "\\" + m)}%`;
		return this.opts.db
			.prepare(
				`SELECT id, source, source_id, title, tags, content, chunk_index, metadata,
				        embed_status, embedding_model
				 FROM kb_chunks
				 WHERE content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
				 ORDER BY updated_at DESC LIMIT ?`,
			)
			.all(pattern, pattern, limit) as ChunkRow[];
	}
}

function toHit(row: ChunkRow): RetrievalHit {
	return {
		id: row.id,
		chunkId: row.id,
		source: row.source,
		sourceId: row.source_id ?? "",
		title: row.title,
		tags: row.tags,
		// Return the FULL chunk content, not a truncated preview. Chunks are already
		// bounded by the chunker (~chunk.size chars), and critical values (URLs,
		// accounts, step-by-step procedures) often sit well past the first 160 chars —
		// a short snippet made the model believe the KB was missing data it actually has.
		snippet: row.content || "",
		score: 1,
		scores: { bm25: 1 },
		origin: "local",
	};
}

/**
 * Build an FTS5 query: quote each token, OR-joined, to keep user input safe.
 *
 * With the `trigram` tokenizer, CJK runs of >=3 chars are slid into 3-char
 * windows so a space-less Chinese sentence still matches the substrings it
 * contains (unicode61 treated the whole run as one token → no match).
 */
function toFtsQuery(query: string): string {
	const tokens = query
		.split(/[\s,，。、；;]+/)
		.map((token) => token.trim())
		.filter(Boolean);
	const parts: string[] = [];
	for (const token of tokens) {
		if (hasCjk(token) && token.length >= 3) {
			for (let i = 0; i + 3 <= token.length; i++) parts.push(token.slice(i, i + 3));
		} else {
			parts.push(token);
		}
	}
	const quoted = parts.map((p) => `"${p.replace(/"/g, '""')}"`);
	return quoted.length ? quoted.join(" OR ") : `"${query.replace(/"/g, '""')}"`;
}

function hasCjk(token: string): boolean {
	return /[㐀-鿿]/.test(token);
}
