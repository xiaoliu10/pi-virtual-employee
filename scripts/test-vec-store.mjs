/**
 * VecStore regression tests. Run with `node --test scripts/test-vec-store.mjs`.
 *
 * Field incident this file exists for (2026-10-01): a deployment had the
 * sqlite-vec extension loading fine but NO fully configured embed provider, so
 * the lazy `kb_vec` virtual table was never created. The first saveLearned →
 * replaceEntryChunks → onChunksDeleted → vec.deleteByRowids chain threw
 * "no such table: kb_vec" and the learned entry was lost. The store's own
 * comment claimed cleanup "never breaks the core deletion path" — true only
 * for the extension-missing case, not the table-missing case.
 *
 * Pinned properties: with the extension AVAILABLE but the table ABSENT,
 * cleanup (deleteByRowids/clear) and upsert no-op instead of throwing; once
 * ensureTable creates the table, writes/deletes work; a dimension change
 * recreates the table and keeps the guard honest. No native deps: a fake DB
 * mimics real SQLite semantics ("no such table" on unregistered kb_vec SQL).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.vec-test-"));
process.on("exit", () => {
	void rm(workDir, { recursive: true, force: true });
});
const bundle = join(workDir, "vec-store.mjs");
await build({
	stdin: { contents: `export * from "${join(root, "src/knowledge/vec-store.ts")}";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { VecStore } = await import(pathToFileURL(bundle).href);

/** Fake DB: kb_vec SQL throws "no such table" until CREATE ran; kb_state is a map. */
function fakeDb() {
	const tables = new Set();
	const state = new Map();
	const vecRows = new Map();
	const isVecSql = (sql) => /\bkb_vec\b/.test(sql);
	const isStateSql = (sql) => /\bkb_state\b/.test(sql);
	const db = {
		loaded: "",
		loadExtension(path) {
			db.loaded = path;
		},
		exec(sql) {
			if (/CREATE VIRTUAL TABLE kb_vec/.test(sql)) {
				if (!tables.has("kb_vec")) tables.add("kb_vec");
				return;
			}
			if (/DROP TABLE kb_vec/.test(sql)) {
				if (!tables.has("kb_vec")) throw new Error("no such table: kb_vec");
				tables.delete("kb_vec");
				vecRows.clear();
				return;
			}
			if (isVecSql(sql) && !tables.has("kb_vec")) throw new Error("no such table: kb_vec");
			if (/DELETE FROM kb_vec/.test(sql)) vecRows.clear();
		},
		prepare(sql) {
			return {
				get(...args) {
					if (/sqlite_master/.test(sql)) return tables.has("kb_vec") ? { name: "kb_vec" } : undefined;
					if (isStateSql(sql)) {
						const key = args[0];
						return state.has(key) ? { value: state.get(key) } : undefined;
					}
					if (isVecSql(sql) && !tables.has("kb_vec")) throw new Error("no such table: kb_vec");
					return undefined;
				},
				run(...args) {
					if (isStateSql(sql)) {
						state.set(args[0], args[1]);
						return { changes: 1 };
					}
					if (isVecSql(sql) && !tables.has("kb_vec")) throw new Error("no such table: kb_vec");
					if (/DELETE FROM kb_vec WHERE rowid IN \(/.test(sql)) {
						for (const a of args) vecRows.delete(Number(a));
						return { changes: args.length };
					}
					if (/DELETE FROM kb_vec WHERE rowid = \?/.test(sql)) vecRows.delete(Number(args[0]));
					if (/INSERT INTO kb_vec/.test(sql)) vecRows.set(Number(args[0]), args[2]);
					return { changes: 1 };
				},
				all(...args) {
					if (isVecSql(sql) && !tables.has("kb_vec")) throw new Error("no such table: kb_vec");
					return [...vecRows.entries()].slice(0, Number(args[0] ?? vecRows.size)).map(([rowid, chunkId]) => ({ chunkId, rowid }));
				},
			};
		},
		_tables: tables,
		_vecRows: vecRows,
	};
	return db;
}

const vec1 = new Float32Array([1, 0, 0]);

test("extension available but table never created: cleanup and upsert no-op instead of throwing", () => {
	const db = fakeDb();
	const vec = new VecStore(db);
	assert.equal(vec.init(), true, "extension loads");
	assert.equal(vec.isAvailable(), true);

	// The exact field chain: first saveLearned deletes chunks BEFORE any
	// ensureTable has ever run. This must not throw.
	assert.doesNotThrow(() => vec.deleteByRowids([1, 2, 3]));
	assert.doesNotThrow(() => vec.clear());
	assert.doesNotThrow(() => vec.upsert(1, vec1, "c1", "manual"));
	assert.equal(vec.currentDimensions(), 0);
	assert.deepEqual(vec.knn(vec1, 5), [], "search on a missing table returns nothing");
});

test("ensureTable creates the table; writes and deletes then work", () => {
	const db = fakeDb();
	const vec = new VecStore(db);
	vec.init();
	vec.ensureTable(3);
	vec.upsert(7, vec1, "c7", "learned");
	assert.equal(db._vecRows.get(7), "c7", "vector inserted after ensureTable");
	vec.deleteByRowids([7]);
	assert.equal(db._vecRows.has(7), false, "vector deleted");
	vec.clear();
	assert.equal(db._vecRows.size, 0);
});

test("dimension change drops and recreates; guard stays honest after drop", () => {
	const db = fakeDb();
	const vec = new VecStore(db);
	vec.init();
	vec.ensureTable(3);
	vec.upsert(1, vec1, "c1", "learned");
	vec.ensureTable(4); // dims changed → drop + recreate
	assert.equal(vec.currentDimensions(), 4);
	vec.deleteByRowids([1]); // table exists again (empty) → must not throw
	assert.doesNotThrow(() => vec.clear());

	// Simulate an external drop (e.g. an import/restore path): the next cleanup
	// must verify existence instead of trusting a previous CREATE.
	db._tables.delete("kb_vec");
	db._vecRows.clear();
	assert.doesNotThrow(() => vec.deleteByRowids([9]));
	assert.doesNotThrow(() => vec.clear());
	assert.doesNotThrow(() => vec.upsert(2, vec1, "c2", "manual"));
});

test("extension unavailable keeps degrading everything to no-ops", () => {
	const db = fakeDb();
	db.loadExtension = () => {
		throw new Error("cannot open shared object file");
	};
	const vec = new VecStore(db);
	assert.equal(vec.init(), false);
	assert.equal(vec.isAvailable(), false);
	assert.doesNotThrow(() => vec.deleteByRowids([1]));
	assert.doesNotThrow(() => vec.ensureTable(3));
	assert.doesNotThrow(() => vec.upsert(1, vec1, "c1", "manual"));
});
