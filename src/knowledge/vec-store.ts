/**
 * sqlite-vec wrapper.
 *
 * Loads the `vec0` loadable extension once per DB and manages the `kb_vec`
 * virtual table: one row per embedded chunk, keyed by the kb_chunks rowid, with
 * a `chunk_id` auxiliary column holding the kb_chunks text id for joins.
 *
 * Degrades gracefully: if the extension or its platform binary is unavailable,
 * `init()` reports not-available and every method no-ops, so retrieval falls
 * back to pure BM25. Vector data lives only in vec0, so a dimension change just
 * drops and recreates this one table.
 */
import { getLoadablePath } from "sqlite-vec";
import type { DB } from "../db/sqlite.js";

export interface VecKnnHit {
	chunkId: string;
	distance: number; // cosine: 1 - cos_sim (smaller is better)
}

const DIMS_KEY = "vec_dims";

/**
 * vec0's xUpdate strictly type-checks the primary key (SQLITE_INTEGER only),
 * and this better-sqlite3 build binds plain JS numbers as REAL. Bind rowids
 * and limits as BigInt so they arrive as true integers.
 */
const toInt = (n: number): bigint => BigInt(Math.trunc(n));

export class VecStore {
	private initialized = false;
	private available = false;
	private currentDims = 0;

	constructor(
		private readonly db: DB,
		private readonly extensionPath?: string,
	) {}

	/** Load the vec0 extension. Idempotent. Returns availability. */
	init(): boolean {
		if (this.initialized) return this.available;
		this.initialized = true;
		try {
			const extPath = this.extensionPath ?? getLoadablePath(); // throws if the platform binary is missing
			this.db.loadExtension(extPath);
			this.available = true;
		} catch (err) {
			console.warn(
				"[knowledge] sqlite-vec unavailable — vector retrieval disabled:",
				(err as Error).message,
			);
			this.available = false;
		}
		return this.available;
	}

	isAvailable(): boolean {
		return this.available;
	}

	currentDimensions(): number {
		return this.currentDims || this.readDims();
	}

	/** Ensure kb_vec exists for `dims`; recreate if the dimension changed. */
	ensureTable(dims: number): void {
		if (!this.available || dims <= 0) return;
		const existing = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_vec'")
			.get() as { name?: string } | undefined;

		if (existing) {
			const stored = this.readDims();
			if (stored === dims) {
				this.currentDims = dims;
				return;
			}
			// Dimension changed → drop & recreate; all embeddings must be re-run.
			try {
				this.db.exec("DROP TABLE kb_vec");
			} catch (err) {
				this.markUnavailable("drop kb_vec", err);
				return;
			}
		}

		try {
			this.db.exec(
				`CREATE VIRTUAL TABLE kb_vec USING vec0(
					embedding float[${dims}] distance_metric=cosine,
					+chunk_id TEXT,
					+source TEXT
				)`,
			);
			this.writeDims(dims);
			this.currentDims = dims;
		} catch (err) {
			this.markUnavailable("create kb_vec", err);
		}
	}

	/** Insert (or replace) the vector for a kb_chunks rowid. */
	upsert(rowid: number, embedding: Float32Array, chunkId: string, source: string): void {
		if (!this.available) return;
		const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
		this.db.prepare("DELETE FROM kb_vec WHERE rowid = ?").run(toInt(rowid));
		this.db
			.prepare("INSERT INTO kb_vec (rowid, embedding, chunk_id, source) VALUES (?, ?, ?, ?)")
			.run(toInt(rowid), buf, chunkId, source);
	}

	deleteByRowids(rowids: number[]): void {
		if (!this.available || rowids.length === 0) return;
		const placeholders = rowids.map(() => "?").join(",");
		this.db.prepare(`DELETE FROM kb_vec WHERE rowid IN (${placeholders})`).run(...rowids.map(toInt));
	}

	/** KNN search over the query vector; returns chunk ids + cosine distance. */
	knn(embedding: Float32Array, k: number): VecKnnHit[] {
		if (!this.available) return [];
		const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
		return this.db
			.prepare(
				`SELECT chunk_id AS chunkId, distance
				 FROM kb_vec
				 WHERE embedding MATCH ?
				 ORDER BY distance
				 LIMIT ?`,
			)
			.all(buf, toInt(k)) as VecKnnHit[];
	}

	/** Remove all vectors (used before a full reindex). */
	clear(): void {
		if (!this.available) return;
		this.db.exec("DELETE FROM kb_vec");
	}

	private readDims(): number {
		const row = this.db.prepare("SELECT value FROM kb_state WHERE key = ?").get(DIMS_KEY) as
			| { value: string }
			| undefined;
		return row ? Number(row.value) || 0 : 0;
	}

	private writeDims(dims: number): void {
		this.db
			.prepare(
				"INSERT INTO kb_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(DIMS_KEY, String(dims));
	}

	private markUnavailable(what: string, err: unknown): void {
		this.available = false;
		console.warn(`[knowledge] sqlite-vec ${what} failed — disabling vector:`, (err as Error).message);
	}
}
