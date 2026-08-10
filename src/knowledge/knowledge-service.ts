/**
 * KnowledgeService — the single facade the engine, tools and IPC depend on.
 *
 * Reads the latest config on every call, so value-type options take effect via
 * `config:set` with no extra IPC. Retrieval routes to the local provider, which
 * fuses BM25 + vector (sqlite-vec) via RRF.
 *
 * Vector lifecycle:
 *  - `activeEmbedProvider()` lazily builds/caches an OpenAI-compatible embedder
 *    keyed by supplier|model|dims, recreating the kb_vec table when dims change.
 *  - `runIndexing()` drains `embed_status='pending'` chunks in batches; auto-index
 *    (incremental) fires after content changes, `reindex()` rebuilds from scratch.
 *  - Any vector failure degrades to BM25; BM25 is always available.
 */
import type { ConfigStore, ExternalProviderConfig, KbConfig, Supplier } from "../db/config-store.js";
import type { DB } from "../db/sqlite.js";
import { OpenAIEmbedProvider, probeEmbeddingDimensions } from "./embed/openai-embed.js";
import { ExternalHttpRetrievalProvider } from "./retrieval/external-http.js";
import { ExternalClient, type ExternalDoc } from "./external/external-client.js";
import { LocalRetrievalProvider } from "./retrieval/local-retrieval.js";
import { reciprocalRankFuse } from "./retrieval/rrf.js";
import { webSearch, type WebSearchHit } from "./research/web-search.js";
import type { EntryWithSnippet, KbGap, KnowledgeDoc, KnowledgeEntry, PendingChunk } from "./store.js";
import { KnowledgeContentStore } from "./store.js";
import { clusterBySimilarity } from "./clustering.js";
import type { ReindexReport, RetrievalHit } from "./types.js";
import { VecStore } from "./vec-store.js";
import {
	CONSOLIDATE_SYSTEM,
	RESEARCH_SYNTHESIS_SYSTEM,
	buildConsolidationPrompt,
	buildResearchSynthesisPrompt,
	ensureCriticalValuesPreserved,
	extractCriticalValues,
	parseConsolidationOps,
	parseResearchSynthesis,
	type ConsolidateReport,
} from "./consolidation.js";

interface EmbedCache {
	fingerprint: string;
	provider: OpenAIEmbedProvider;
}

const INDEX_BATCH = 200;

export interface VectorStatus {
	available: boolean;
	enabled: boolean;
	dims: number;
	pending: number;
	indexed: number;
	failed: number;
}

export class KnowledgeService {
	private readonly store: KnowledgeContentStore;
	private readonly vec: VecStore;
	private readonly local: LocalRetrievalProvider;
	private embedCache: EmbedCache | null = null;
	private indexing: Promise<ReindexReport> | null = null;
	private llm: ((system: string, user: string) => Promise<string>) | null = null;
	private consolidating: Promise<ConsolidateReport> | null = null;

	constructor(
		private readonly db: DB,
		private readonly config: ConfigStore,
		vecExtensionPath?: string,
	) {
		this.vec = new VecStore(db, vecExtensionPath);
		this.vec.init();
		this.store = new KnowledgeContentStore(db, {
			// Clean up kb_vec vectors whenever chunks are removed (delete/archive/
			// replace/import). vec.deleteByRowids no-ops when the extension is
			// unavailable, so this never breaks the core deletion path.
			onChunksDeleted: (rowids) => this.vec.deleteByRowids(rowids),
		});
		this.local = new LocalRetrievalProvider({
			db,
			store: this.store,
			vec: this.vec,
			readConfig: () => {
				const kb = this.config.all().kb;
				return {
					topK: kb.local.topK,
					bm25Weight: kb.local.hybrid.bm25Weight,
					vectorWeight: kb.local.hybrid.vectorEnabled ? kb.local.hybrid.vectorWeight : 0,
					embed: this.activeEmbedProvider(),
				};
			},
		});
	}

	// --- content management (proxied to the store, with auto-index hook) ---
	listEntries(options: { includeArchived?: boolean } = {}): KnowledgeEntry[] {
		return this.store.listEntries(options);
	}

	upsertEntry(input: { id?: string; title: string; tags: string; content: string }): KnowledgeEntry {
		const entry = this.store.upsertEntry(input);
		void this.maybeAutoIndex();
		return entry;
	}

	/** Auto-learn: persist reusable knowledge extracted from conversation (de-dupes by title). */
	saveLearned(input: { title: string; content: string; tags?: string }): { id: string; merged: boolean } {
		const result = this.store.saveLearned(input);
		void this.maybeAutoIndex();
		return result;
	}

	/**
	 * Revise an existing entry — the corrective-overwrite path. mode="replace"
	 * overwrites content (a correction); mode="append" adds to it. Bumps version.
	 * Used by save_to_knowledge when the LLM refines an existing entry by id.
	 */
	reviseEntry(
		id: string,
		input: { content: string; title?: string; tags?: string; mode?: "replace" | "append" },
	): { id: string; revised: boolean } {
		const entry = this.store.reviseEntry(id, input);
		if (entry) void this.maybeAutoIndex();
		return { id, revised: !!entry };
	}

	/** Record a KB miss so the auto-research loop (and UI) can surface recurring gaps. */
	recordGap(query: string): void {
		this.store.recordGap(query);
	}

	/** Run a web search via the configured research engine. */
	async researchWeb(query: string): Promise<WebSearchHit[]> {
		const r = this.kb().research;
		return webSearch(query, { engine: r.engine });
	}

	/**
	 * Persist a finding from auto-research: low confidence + pending review, with
	 * provenance. Resolves any matching gap so recurring misses clear once answered.
	 */
	saveResearched(input: {
		title: string;
		content: string;
		tags?: string;
		sourceUrl?: string;
		gapQuery?: string;
	}): { id: string } {
		const id = this.store.saveResearched(input);
		if (input.gapQuery) this.store.resolveGap(input.gapQuery);
		void this.maybeAutoIndex();
		return { id };
	}

	deleteEntry(id: string): void {
		this.store.deleteEntry(id);
	}

	/** Soft-archive an entry (skips retrieval, recoverable via restoreEntry). */
	archiveEntry(id: string): void {
		this.store.archiveEntry(id);
	}

	/** Restore an archived entry and re-index its rebuilt chunks. */
	restoreEntry(id: string): void {
		this.store.restoreEntry(id);
		void this.maybeAutoIndex();
	}

	/** Keyword search over live entries (management list / delete-target lookup). */
	searchEntries(query: string, limit?: number): EntryWithSnippet[] {
		return this.store.searchEntries(query, limit);
	}

	listDocs(): KnowledgeDoc[] {
		return this.store.listDocs();
	}

	deleteDoc(id: string): void {
		this.store.deleteDoc(id);
	}

	async importDocument(absPath: string, displayName: string): Promise<number> {
		const chunks = await this.store.importDocument(absPath, displayName);
		if (chunks > 0) void this.maybeAutoIndex();
		return chunks;
	}

	// --- retrieval ---
	async search(query: string): Promise<RetrievalHit[]> {
		const kb = this.kb();
		const topK = kb.local.topK;
		const localHits = await this.local.search({ query, topK });
		if (kb.mode !== "external") return localHits;

		// mode is additive: local is primary, external source(s) extend coverage.
		const externals = this.activeExternalProviders(kb);
		if (externals.length === 0) return localHits;

		const externalLists = await Promise.all(
			externals.map(async (cfg) => {
				try {
					return await new ExternalHttpRetrievalProvider(cfg).search({ query, topK });
				} catch (err) {
					console.warn(`[knowledge] external "${cfg.name}" failed:`, (err as Error).message);
					return [];
				}
			}),
		);

		// 内置为主、外接仅作扩展：本地权重高于外接。外接 snippet 由对方服务端返回、
		// 可能被截断，完整的本地内容应优先；本地命中不足 topK 时外接才补位。
		const fused = reciprocalRankFuse<RetrievalHit>(
			[
				{ list: localHits, weight: 1 },
				...externalLists.map((list) => ({ list, weight: 0.5 })),
			],
			(h) => h.chunkId,
		);
		return [...fused.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)
			.map(({ item, score }) => ({ ...item, score }));
	}

	private activeExternalProviders(kb: KbConfig): ExternalProviderConfig[] {
		const enabled = kb.external.providers.filter((p) => p.enabled);
		return kb.external.activeId ? enabled.filter((p) => p.id === kb.external.activeId) : enabled;
	}

	// --- vector lifecycle ---
	vectorStatus(): VectorStatus {
		return {
			available: this.vec.isAvailable(),
			enabled: !!this.activeEmbedProvider(),
			dims: this.vec.currentDimensions(),
			pending: this.store.countByStatus("pending"),
			indexed: this.store.countByStatus("indexed"),
			failed: this.store.countByStatus("failed"),
		};
	}

	/** Full rebuild: clear vectors + reset all chunks to pending, then index. */
	async reindex(): Promise<ReindexReport> {
		return this.enqueueIndex(true);
	}

	/**
	 * Boot-time self-heal: pick up chunks a previous run left in pending/failed
	 * (crash, upgrade, or a transient embedding failure). Best-effort.
	 */
	async indexOutstanding(): Promise<ReindexReport> {
		if (!this.activeEmbedProvider()) return { total: 0, indexed: 0, failed: 0, skipped: 0 };
		// Failed chunks need a clean pass (reset clears kb_vec and re-queues all).
		if (this.store.countByStatus("failed") > 0) return this.enqueueIndex(true);
		if (this.store.countByStatus("pending") > 0) return this.enqueueIndex(false);
		return { total: 0, indexed: 0, failed: 0, skipped: 0 };
	}

	/** Inject the LLM completion callback (used by consolidation). Setter avoids an engine↔service cycle. */
	setLlm(fn: (system: string, user: string) => Promise<string>): void {
		this.llm = fn;
	}

	/** Consolidate learned entries via the LLM (merge / archive / retag / generalize). */
	async consolidate(): Promise<ConsolidateReport> {
		if (this.consolidating) return this.consolidating;
		const run = this.runConsolidation().catch(
			(err): ConsolidateReport => ({
				merged: 0,
				archived: 0,
				derived: 0,
				retagged: 0,
				skipped: 0,
				error: (err as Error).message,
			}),
		);
		this.consolidating = run.finally(() => {
			if (this.consolidating === run) this.consolidating = null;
		});
		return run;
	}

	private async runConsolidation(): Promise<ConsolidateReport> {
		if (!this.llm) {
			return { merged: 0, archived: 0, derived: 0, retagged: 0, skipped: 0, error: "llm 未接入" };
		}
		const kb = this.kb();
		const batch = Math.max(2, Math.floor(kb.learn.consolidate.batch) || 40);
		const candidates = this.store.listConsolidationCandidates(batch);
		if (candidates.length < 2) {
			return { merged: 0, archived: 0, derived: 0, retagged: 0, skipped: candidates.length };
		}
		// Semantic pre-clustering: embed candidate titles and group related entries
		// so the model merges/generalizes within coherent groups. Skipped (no LLM
		// cost) when the embed provider or vector recall is unavailable.
		const groups = await this.clusterCandidates(candidates).catch(() => undefined);
		const reply = await this.llm(CONSOLIDATE_SYSTEM, buildConsolidationPrompt(candidates, groups));
		const ops = parseConsolidationOps(reply);

		// id → content for the whitelist backstop. op.ids are always a subset of the
		// candidate batch the model was shown, so this map covers every source.
		const contentById = new Map(candidates.map((c) => [c.id, c.content]));
		const sourceContent = (id: string): string => contentById.get(id) ?? "";

		let merged = 0;
		let archived = 0;
		let derived = 0;
		let retagged = 0;
		const txn = this.db.transaction(() => {
			for (const op of ops.merge) {
				// Deterministic credential backstop: if the model redacted/dropped any
				// critical value (地址/账号/密码/卡号/商户号/密钥/端口…) from a source, force
				// it back into the merged entry verbatim.
				const { content, restored } = ensureCriticalValuesPreserved(
					op.content,
					op.ids.map(sourceContent),
				);
				if (restored.length > 0) {
					console.warn(
						`[knowledge] consolidation restored ${restored.length} critical value(s) the model dropped:`,
						restored.map((r) => r.label).join(", "),
					);
				}
				this.store.mergeEntries(op.ids, { title: op.title, content, tags: op.tags });
				merged += op.ids.length;
				derived += 1;
			}
			for (const id of ops.archive) {
				// Never drop an entry that carries production credentials — archiving
				// deletes its chunks, so the whitelist backstop must block it here too.
				if (extractCriticalValues(sourceContent(id)).length > 0) {
					console.warn(`[knowledge] refused to archive ${id}: contains critical values`);
					continue;
				}
				this.store.archiveEntry(id);
				archived += 1;
			}
			for (const op of ops.retag) {
				this.store.retagEntry(op.id, op.tags);
				retagged += 1;
			}
		});
		txn();
		void this.maybeAutoIndex();
		this.store.setConsolidatedAt(Date.now());
		return { merged, archived, derived, retagged, skipped: 0 };
	}

	/**
	 * Embed candidate titles and cluster by cosine similarity so consolidation
	 * processes related entries together. Returns undefined when embedding is
	 * unavailable (vector recall off / no provider) — caller then falls back to a
	 * flat batch.
	 */
	private async clusterCandidates(candidates: KnowledgeEntry[]): Promise<string[][] | undefined> {
		const embed = this.activeEmbedProvider();
		if (!embed) return undefined;
		const titles = candidates.map((c) => c.title || c.content.slice(0, 32) || c.id);
		const vecs = await embed.embed(titles);
		const items = candidates.map((c, i) => ({ id: c.id, vec: vecs[i] }));
		return clusterBySimilarity(items, 0.75);
	}

	/** Status of the auto-learn / consolidation system (for the UI). */
	learnStatus(): {
		learnEnabled: boolean;
		consolidateEnabled: boolean;
		intervalMinutes: number;
		consolidatedAt: number;
		researchedAt: number;
		learnedCount: number;
		derivedCount: number;
		researchCount: number;
		pendingCount: number;
		archivedCount: number;
		researchEnabled: boolean;
		gapCount: number;
	} {
		const kb = this.kb();
		return {
			learnEnabled: kb.learn.enabled,
			consolidateEnabled: kb.learn.consolidate.enabled,
			intervalMinutes: kb.learn.consolidate.intervalMinutes,
			consolidatedAt: this.store.getConsolidatedAt(),
			researchedAt: this.store.getResearchedAt(),
			learnedCount: this.store.countByOrigin("learned"),
			derivedCount: this.store.countByOrigin("derived"),
			researchCount: this.store.countByOrigin("research"),
			pendingCount: this.store.countByReview("pending"),
			archivedCount: this.store.countArchived(),
			researchEnabled: kb.research.enabled,
			gapCount: this.store.countGaps(),
		};
	}

	/** List recorded KB gaps (auto-research loop), most-requested first. */
	listGaps(limit = 20): KbGap[] {
		return this.store.listGaps(limit);
	}

	/** Dismiss a gap (e.g. after manual review or when irrelevant). */
	resolveGap(query: string): void {
		this.store.resolveGap(query);
	}

	/** Promote a pending (e.g. research) entry to approved — vetted knowledge. */
	approveEntry(id: string): void {
		this.store.setReviewStatus(id, "approved");
	}

	/**
	 * Gap-driven auto-research: pick the most-requested KB misses, web-search
	 * each, and distill hits into pending/low-confidence entries. This is the
	 * "offline self-learning" loop — it runs independent of any live chat, so
	 * recurring questions get answered proactively. No-ops when research is off
	 * or no LLM/gaps are available.
	 */
	async researchGaps(): Promise<{ researched: number; gaps: number; skipped: number; error?: string }> {
		if (!this.kb().research.enabled || !this.llm) {
			return { researched: 0, gaps: 0, skipped: 0 };
		}
		const gaps = this.store.listGaps(5).filter((g) => g.count >= 1);
		if (gaps.length === 0) return { researched: 0, gaps: 0, skipped: 0 };

		let researched = 0;
		let skipped = 0;
		for (const gap of gaps) {
			try {
				const hits = await this.researchWeb(gap.query);
				if (hits.length === 0) {
					skipped += 1;
					continue;
				}
				const reply = await this.llm(
					RESEARCH_SYNTHESIS_SYSTEM,
					buildResearchSynthesisPrompt(gap.query, hits.slice(0, 5)),
				);
				const synth = parseResearchSynthesis(reply);
				if (synth.skip || !synth.title || !synth.content) {
					skipped += 1;
					continue;
				}
				this.saveResearched({
					title: synth.title,
					content: synth.content,
					tags: synth.tags,
					sourceUrl: hits[0].url,
					gapQuery: gap.query,
				});
				researched += 1;
			} catch (err) {
				console.warn(`[knowledge] research gap "${gap.query}" failed:`, (err as Error).message);
				skipped += 1;
			}
		}
		if (researched > 0) void this.maybeAutoIndex();
		this.store.setResearchedAt(Date.now());
		return { researched, gaps: gaps.length, skipped };
	}

	/** Probe an endpoint+model for its real output dimension (UI backfill). */
	async testEmbedding(
		input: { baseUrl: string; apiKey: string; model: string },
	): Promise<{ ok: boolean; dims: number; error?: string }> {
		try {
			const dims = await probeEmbeddingDimensions(input);
			return { ok: true, dims };
		} catch (err) {
			return { ok: false, dims: 0, error: (err as Error).message };
		}
	}

	/** Connection test for an external provider config (used by the settings UI). */
	async testExternal(
		cfg: ExternalProviderConfig,
	): Promise<{ ok: boolean; count: number; error?: string }> {
		try {
			const hits = await new ExternalHttpRetrievalProvider(cfg).search({ query: "测试", topK: 3 });
			return { ok: true, count: hits.length };
		} catch (err) {
			return { ok: false, count: 0, error: (err as Error).message };
		}
	}

	/** List documents in an external knowledge base (by provider id). */
	async listExternalDocuments(providerId: string): Promise<ExternalDoc[]> {
		return new ExternalClient(this.externalProvider(providerId)).listDocuments();
	}

	/**
	 * List accessible datasets for an external provider. Takes a draft config
	 * (not a provider id) so the settings UI can populate the dataset dropdown
	 * right after the user enters baseUrl + apiKey, before saving.
	 */
	async listExternalDatasets(cfg: ExternalProviderConfig): Promise<{ id: string; name: string }[]> {
		return new ExternalClient(cfg).listDatasets();
	}

	/**
	 * Upload a file to an external knowledge base. For presets that need an
	 * explicit parse step after upload (e.g. RAGFlow), trigger it automatically;
	 * Dify indexes asynchronously and has no parse op, so it is skipped.
	 */
	async uploadToExternal(
		providerId: string,
		filePath: string,
		fileName: string,
	): Promise<{ ok: boolean; documentIds: string[]; parsed: boolean; error?: string }> {
		try {
			const cfg = this.externalProvider(providerId);
			const client = new ExternalClient(cfg);
			const { documentIds } = await client.uploadDocument(filePath, fileName);
			let parsed = false;
			if (documentIds.length > 0 && cfg.operations.parse) {
				try {
					await client.parseDocument(documentIds);
					parsed = true;
				} catch (err) {
					console.warn("[knowledge] external auto-parse failed:", (err as Error).message);
				}
			}
			return { ok: true, documentIds, parsed };
		} catch (err) {
			return { ok: false, documentIds: [], parsed: false, error: (err as Error).message };
		}
	}

	/** Re-parse one document (by id) or all documents in an external knowledge base. */
	async parseExternal(
		providerId: string,
		documentId?: string,
	): Promise<{ ok: boolean; parsed: number; error?: string }> {
		try {
			const cfg = this.externalProvider(providerId);
			const client = new ExternalClient(cfg);
			const ids = documentId
				? [documentId]
				: (await client.listDocuments()).map((d) => d.id).filter(Boolean);
			await client.parseDocument(ids);
			return { ok: true, parsed: ids.length };
		} catch (err) {
			return { ok: false, parsed: 0, error: (err as Error).message };
		}
	}

	private externalProvider(providerId: string): ExternalProviderConfig {
		const p = this.kb().external.providers.find((x) => x.id === providerId);
		if (!p) throw new Error("未找到该外接知识库配置");
		return p;
	}

	isFtsEnabled(): boolean {
		return this.store.ftsEnabled();
	}

	count(): number {
		return this.store.count();
	}

	// --- internals ---
	private async maybeAutoIndex(): Promise<void> {
		if (!this.kb().local.autoIndex) return;
		if (!this.activeEmbedProvider()) return;
		if (this.indexing) return; // an in-flight run already drains pending chunks
		await this.enqueueIndex(false).catch((err) =>
			console.warn("[knowledge] auto-index failed:", (err as Error).message),
		);
	}

	/** Chain indexing runs serially; each caller waits for its own run. */
	private enqueueIndex(reset: boolean): Promise<ReindexReport> {
		const previous = this.indexing;
		const run = (previous ?? Promise.resolve()).then(() => this.runIndexing({ reset }));
		this.indexing = run.finally(() => {
			if (this.indexing === run) this.indexing = null;
		});
		return run;
	}

	private async runIndexing(opts: { reset: boolean }): Promise<ReindexReport> {
		const embed = this.activeEmbedProvider();
		if (!embed || !this.vec.isAvailable()) {
			return { total: 0, indexed: 0, failed: 0, skipped: this.store.count() };
		}
		this.vec.ensureTable(embed.dims);
		if (opts.reset) {
			this.vec.clear();
			this.store.resetAllForReindex();
		}

		let total = 0;
		let indexed = 0;
		let failed = 0;
		for (;;) {
			const batch = this.store.listPendingChunks(INDEX_BATCH);
			if (batch.length === 0) break;
			total += batch.length;
			try {
				const vectors = await embed.embed(batch.map((c) => c.content));
				this.writeVectors(batch, vectors);
				this.store.markEmbedded(batch.map((c) => c.id), embed.model);
				indexed += batch.length;
			} catch (err) {
				console.warn("[knowledge] embedding batch failed:", (err as Error).message);
				this.store.markEmbedFailed(batch.map((c) => c.id));
				failed += batch.length;
			}
		}
		return { total, indexed, failed, skipped: 0 };
	}

	private writeVectors(batch: PendingChunk[], vectors: Float32Array[]): void {
		const txn = this.db.transaction((rows: PendingChunk[]) => {
			for (let i = 0; i < rows.length; i++) {
				this.vec.upsert(rows[i].rowid, vectors[i], rows[i].id, rows[i].source);
			}
		});
		txn(batch);
	}

	/** Cached embed provider for the current embedding config, or null. */
	private activeEmbedProvider(): OpenAIEmbedProvider | null {
		const kb = this.kb();
		if (!kb.local.hybrid.vectorEnabled || !this.vec.isAvailable()) return null;
		const emb = kb.local.embedding;
		if (!emb.model) return null;

		const endpoint = this.resolveEmbedEndpoint(emb);
		if (!endpoint.baseUrl || !endpoint.apiKey) return null;

		const fingerprint = `${emb.mode}|${endpoint.baseUrl}|${emb.model}|${emb.dimensions}`;
		if (this.embedCache?.fingerprint === fingerprint) return this.embedCache.provider;

		this.vec.ensureTable(emb.dimensions);
		const provider = new OpenAIEmbedProvider({
			baseUrl: endpoint.baseUrl,
			apiKey: endpoint.apiKey,
			model: emb.model,
			dims: emb.dimensions,
			batchSize: emb.batchSize,
		});
		this.embedCache = { fingerprint, provider };
		return provider;
	}

	/** Resolve the embedding endpoint: a dedicated baseUrl+apiKey, or reuse a supplier. */
	private resolveEmbedEndpoint(emb: KbConfig["local"]["embedding"]): { baseUrl: string; apiKey: string } {
		if (emb.mode === "custom") return { baseUrl: emb.baseUrl.trim(), apiKey: emb.apiKey };
		const supplier = this.resolveSupplier(emb.supplierId);
		return supplier ? { baseUrl: supplier.baseUrl, apiKey: supplier.apiKey } : { baseUrl: "", apiKey: "" };
	}

	private resolveSupplier(supplierId: string): Supplier | undefined {
		return this.config
			.all()
			.model.suppliers.find((s) => s.id === supplierId && s.enabled && s.apiType === "openai");
	}

	private kb(): KbConfig {
		return this.config.all().kb;
	}
}
