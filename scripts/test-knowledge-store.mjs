/**
 * KnowledgeContentStore save/re-chunk regression tests. Run with
 * `node --test scripts/test-knowledge-store.mjs`. Real SQL via node:sqlite
 * (never the Electron-ABI better-sqlite3 build); the onChunksDeleted hook is
 * stubbed to mimic VecStore behaviour.
 *
 * Field incident this file exists for (2026-10-01): an autonomous work item
 * finishing at "step 6" tried to save a learned pitfall and the KB backend
 * errored "no such table: kb_vec". Earlier auto-writes had all succeeded —
 * because they all CREATED new entries: deleteChunks early-returns on an empty
 * rowid list and never fires the hook. This save matched an EXISTING entry by
 * title → UPDATE branch → deleteByRowids(non-empty) against a never-created
 * kb_vec (embed provider never fully configured) → throw. Worse, the throw
 * landed between "old chunks deleted" and "new chunks inserted", leaving the
 * existing entry present but unretrievable.
 *
 * Pinned properties: creating never fires the hook; updating fires it with the
 * replaced chunk rowids and completes fully; a throwing hook propagates but
 * leaves exactly the documented partial state (the production guard lives in
 * VecStore — deleteByRowids no-ops on a missing table — which makes this
 * unreachable); with a no-op hook (the fixed VecStore) the update is complete
 * and consistent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.kbstore-test-"));
process.on("exit", () => {
	void rm(workDir, { recursive: true, force: true });
});
const bundle = join(workDir, "knowledge-store.mjs");
await build({
	stdin: { contents: `export * from "${join(root, "src/knowledge/store.ts")}";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { KnowledgeContentStore } = await import(pathToFileURL(bundle).href);

const MANUAL = "manual";
function makeDb() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE kb_entries (
			id TEXT PRIMARY KEY, title TEXT, tags TEXT, content TEXT,
			origin TEXT, confidence REAL, version INTEGER DEFAULT 1, lineage TEXT,
			archived INTEGER DEFAULT 0, review_status TEXT DEFAULT 'approved',
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE TABLE kb_chunks (
			id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT,
			title TEXT, tags TEXT, content TEXT NOT NULL,
			chunk_index INTEGER, embed_status TEXT DEFAULT 'pending',
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE INDEX idx_kb_chunks_source ON kb_chunks(source, source_id);
	`);
	return db;
}
const chunkCount = (db, entryId) =>
	db.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE source = ? AND source_id = ?").get(MANUAL, entryId).n;

test("creating an entry never fires onChunksDeleted; chunks are indexed", () => {
	const db = makeDb();
	const fired = [];
	const store = new KnowledgeContentStore(db, { onChunksDeleted: (rowids) => fired.push(rowids) });
	const entry = store.saveLearned({ title: "新坑：cmd 转义", content: "命令里的 & 要用 [char]38 构造。", tags: "踩坑" });
	assert.deepEqual(fired, [], "creation must not touch the vector cleanup hook");
	assert.ok(chunkCount(db, entry.id) >= 1, "chunks inserted for retrieval");
});

test("saving an existing title fires the hook with replaced rowids and completes consistently", () => {
	const db = makeDb();
	const fired = [];
	const store = new KnowledgeContentStore(db, { onChunksDeleted: (rowids) => fired.push(rowids) });
	const first = store.saveLearned({ title: "对账坑位", content: "第一版内容。" });
	const chunksBefore = chunkCount(db, first.id);
	const second = store.saveLearned({ title: "对账坑位", content: "第二版内容，补充了细节。" });
	assert.equal(second.id, first.id, "same title updates in place");
	assert.equal(second.merged, true);
	assert.equal(fired.length, 1, "update fires the hook exactly once");
	assert.equal(fired[0].length, chunksBefore, "hook receives the replaced chunk rowids");
	const entry = db.prepare("SELECT content FROM kb_entries WHERE id = ?").get(first.id);
	assert.match(entry.content, /第二版内容/);
	assert.equal(chunkCount(db, first.id) >= 1, true, "replacement chunks are in place");
	assert.equal(fired[0].includes(...fired[0]) && fired[0].every((r) => typeof r === "number"), true);
});

test("a throwing cleanup hook reproduces the field damage: throw + chunks lost", () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db, {
		onChunksDeleted: () => {
			throw new Error("no such table: kb_vec");
		},
	});
	const first = store.saveLearned({ title: "踩坑条目", content: "初始内容。" });
	assert.throws(
		() => store.saveLearned({ title: "踩坑条目", content: "更新内容。" }),
		/no such table: kb_vec/,
	);
	// The documented partial state this test pins: entry content was updated,
	// old chunks were deleted, new chunks never inserted → unretrievable entry.
	assert.ok(chunkCount(db, first.id) === 0, "chunks deleted without replacement");
	// Production is protected one layer down: VecStore.deleteByRowids no-ops on
	// a missing table (PR #17), so the hook can no longer throw this way.
});

test("with the fixed no-op hook the update path is fully consistent", () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db, { onChunksDeleted: () => {} }); // VecStore post-#17
	const first = store.saveLearned({ title: "可恢复条目", content: "初始内容。" });
	store.saveLearned({ title: "可恢复条目", content: "修正后的完整内容。" });
	const entry = db.prepare("SELECT content FROM kb_entries WHERE id = ?").get(first.id);
	assert.match(entry.content, /修正后的完整内容/);
	assert.ok(chunkCount(db, first.id) >= 1, "chunks rebuilt — entry stays retrievable");
});
