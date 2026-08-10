/**
 * Knowledge-base retrieval contracts.
 *
 * The engine, tools and IPC depend only on `KnowledgeService` (the facade) and
 * these interfaces — never on a concrete store/provider — so retrieval can be
 * swapped or extended (local hybrid vs an external HTTP RAG) without touching
 * call sites.
 */

/** A chunk to be indexed by a provider that supports upsert. */
export interface ChunkInput {
	chunkId: string;
	source: string;
	sourceId: string;
	title: string | null;
	tags: string | null;
	content: string;
	chunkIndex: number;
	metadata?: Record<string, unknown>;
}

/**
 * A scored retrieval hit. `id` mirrors `chunkId` so the result stays
 * structurally compatible with the legacy `SearchHit` shape used over IPC.
 */
export interface RetrievalHit {
	id: string; // = chunkId; kept for legacy SearchHit compatibility
	chunkId: string;
	source: string;
	sourceId: string;
	title: string | null;
	tags: string | null;
	snippet: string;
	score: number;
	scores?: { bm25?: number; vector?: number; rerank?: number };
	origin: string; // "local" | provider id
}

export interface SearchRequest {
	query: string;
	topK: number;
}

export interface HealthStatus {
	ok: boolean;
	ready: boolean;
	detail?: string;
}

export interface ReindexReport {
	total: number;
	indexed: number;
	failed: number;
	skipped: number;
	detail?: string;
}

/**
 * Pluggable retrieval abstraction. The built-in local hybrid provider and any
 * external HTTP adapter both implement this.
 */
export interface RetrievalProvider {
	readonly id: string;
	readonly kind: "local" | "external";
	readonly capabilities: { upsert: boolean; delete: boolean; vector: boolean; rerank: boolean };
	search(req: SearchRequest): Promise<RetrievalHit[]>;
	upsert?(chunks: ChunkInput[]): Promise<void>;
	delete?(opts: { source?: string; sourceId?: string }): Promise<void>;
	reindex?(): Promise<ReindexReport>;
	health(): Promise<HealthStatus>;
}

/** Embedding provider (OpenAI-compatible). Wired up in P1. */
export interface EmbedProvider {
	readonly model: string;
	readonly dims: number;
	embed(texts: string[]): Promise<Float32Array[]>;
	embedOne(text: string): Promise<Float32Array>;
}
