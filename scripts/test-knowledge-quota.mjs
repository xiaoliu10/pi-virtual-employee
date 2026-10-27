/**
 * Layered retrieval quota (2026-10-27): memory and knowledge are recalled in
 * SEPARATE passes so a wall of memory hits can never hide knowledge from the
 * quota. Review probes: a single pass + fixed overscan still returned only
 * memory at topK=6 while a matching knowledge hit existed.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.kb-quota-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "quota.mjs");
await build({
	stdin: { contents: `export { KnowledgeService } from "./src/knowledge/knowledge-service.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { KnowledgeService } = await import(pathToFileURL(bundle).href);

/**
 * Exercise the real applySourceQuota through a service instance whose local
 * provider returns scripted hits. Keeps the assertion on the production quota
 * math (where both review bugs lived) without a full retrieval stack.
 */
function makeService(hits, topK) {
	const svc = Object.create(KnowledgeService.prototype);
	svc.kb = () => ({ mode: "local", local: { topK } });
	svc.local = {
		search: async ({ kindFilter }) =>
			hits.filter((h) => (kindFilter === "memory" ? h.tags.includes("memory") : !h.tags.includes("memory"))),
	};
	return svc;
}

const memoryHit = (i) => ({ id: `m${i}`, chunkId: `m${i}`, source: "manual", sourceId: `m${i}`, title: `m${i}`, tags: ",memory,", snippet: "", score: 1, origin: "local" });
const knowledgeHit = (i) => ({ id: `k${i}`, chunkId: `k${i}`, source: "doc", sourceId: `k${i}`, title: `k${i}`, tags: "", snippet: "", score: 1, origin: "local" });

test("a wall of memory hits cannot hide existing knowledge (separate passes)", async () => {
	// 30 memory hits ranking above one knowledge hit — the reviewer's scenario.
	const hits = [...Array.from({ length: 30 }, (_, i) => memoryHit(i)), knowledgeHit(0)];
	const out = await makeService(hits, 6).search("部署");
	assert.equal(out.length, 6, "topK honored");
	assert.ok(out.some((h) => h.id.startsWith("k")), `knowledge must survive a wall of memory, got ${out.map((h) => h.id).join(",")}`);
	// Memory fills leftover slots when knowledge has nothing more to offer (only
	// one knowledge hit exists here) — the CAP binds only when knowledge competes.
	assert.ok(out.filter((h) => h.tags.includes("memory")).length >= 1, "memory still present");
});

test("memory is capped when knowledge has enough to compete", async () => {
	const hits = [...Array.from({ length: 10 }, (_, i) => memoryHit(i)), ...Array.from({ length: 10 }, (_, i) => knowledgeHit(i))];
	const out = await makeService(hits, 6).search("部署");
	const memoryCount = out.filter((h) => h.tags.includes("memory")).length;
	assert.ok(memoryCount <= 3, `memory must stay under MEMORY_SEARCH_CAP=3 when knowledge competes, got ${memoryCount}`);
	assert.ok(out.filter((h) => !h.tags.includes("memory")).length >= 3, "knowledge gets the remainder");
});

test("knowledge keeps at least one slot even for tiny topK", async () => {
	const hits = [...Array.from({ length: 8 }, (_, i) => memoryHit(i)), ...Array.from({ length: 8 }, (_, i) => knowledgeHit(i))];
	for (const topK of [1, 2, 3]) {
		const out = await makeService(hits, topK).search("部署");
		assert.equal(out.length, topK, `topK=${topK} returns exactly topK`);
		assert.ok(out.some((h) => h.id.startsWith("k")), `topK=${topK} must keep a knowledge slot, got ${out.map((h) => h.id).join(",")}`);
	}
});

test("memory-only and knowledge-only corpora degrade gracefully", async () => {
	const onlyMemory = await makeService([memoryHit(0), memoryHit(1)], 5).search("q");
	assert.equal(onlyMemory.length, 2, "no knowledge to reserve for → memory fills");

	const onlyKnowledge = await makeService([knowledgeHit(0), knowledgeHit(1), knowledgeHit(2)], 5).search("q");
	assert.equal(onlyKnowledge.length, 3, "no memory competing → knowledge fills");

	const empty = await makeService([], 5).search("q");
	assert.deepEqual(empty, [], "empty corpus yields empty results");
});

// ─── Real retrieval path: kindFilter must partition on the ACTUAL SQL/vector
// backends, not on a scripted stub. The reviewer's mutation probes M9/STUB and
// M10 were undetected because every quota test above injects hits directly;
// these run LocalRetrievalProvider against a real sqlite corpus.

let bundleSeq = 0;
/** Bundle an arbitrary module for probing (kept separate from the quota stub). */
async function bundleWith(contents) {
	bundleSeq += 1;
	const out = join(dir, `probe-${bundleSeq}.mjs`);
	await build({ stdin: { contents, resolveDir: root, loader: "ts" }, outfile: out, bundle: true, platform: "node", format: "esm", packages: "external" });
	return out;
}

let LocalRetrievalProviderMemo;
/** Build the real retrieval bundle lazily, inside a test (avoids module-level
 *  top-level await racing the after() cleanup). */
async function localRetrievalProvider() {
	if (LocalRetrievalProviderMemo) return LocalRetrievalProviderMemo;
	const out = join(dir, "real.mjs");
	await build({
		stdin: {
			contents: `export { LocalRetrievalProvider } from "./src/knowledge/retrieval/local-retrieval.ts";`,
			resolveDir: root,
			loader: "ts",
		},
		outfile: out,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
	});
	LocalRetrievalProviderMemo = (await import(pathToFileURL(out).href)).LocalRetrievalProvider;
	return LocalRetrievalProviderMemo;
}

function realCorpus() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE kb_chunks (
			id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT, title TEXT, tags TEXT,
			content TEXT NOT NULL, chunk_index INTEGER, metadata TEXT,
			embed_status TEXT DEFAULT 'pending', embedding_model TEXT,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
			content, title, tags, tokenize = 'trigram'
		);
	`);
	const now = Date.now();
	const ins = db.prepare(
		"INSERT INTO kb_chunks (id, source, source_id, title, tags, content, chunk_index, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
	);
	const fts = db.prepare("INSERT INTO kb_chunks_fts (rowid, title, tags, content) VALUES (?,?,?,?)");
	const add = (id, title, tags, content) => {
		const r = ins.run(id, "manual", id, title, tags, content, 0, now, now);
		fts.run(r.lastInsertRowid, title, tags, content);
	};
	add("m1", "部署审批人", ",memory,", "生产部署流程需要王工审批");
	add("k1", "生产部署流程", "", "生产部署流程分为预发和正式两个阶段");
	add("m2", "MemoryCase", ",Memory,", "生产部署流程里大小写混合的记忆标签");
	add("m3", "UPPER", ",MEMORY,", "生产部署流程全大写标签记忆");
	return db;
}

async function provider(db) {
	const LocalRetrievalProvider = await localRetrievalProvider();
	return new LocalRetrievalProvider({
		db,
		store: {
			ftsEnabled: () => true,
			// Return no metadata: this test is about kind partitioning in SQL,
			// not about scope/visibility enrichment (covered by scoped-memory tests).
			fetchEntryMeta: () => new Map(),
			fetchMemoryMeta: () => new Map(),
			bumpUsage: () => {},
		},
		readConfig: () => ({ topK: 20, bm25Weight: 1, vectorWeight: 0, embed: null }),
	});
}

test("kindFilter really partitions the FTS path (mutation M9)", async () => {
	const p = await provider(realCorpus());
	const memory = await p.search({ query: "生产部署流程", topK: 20, kindFilter: "memory" });
	const knowledge = await p.search({ query: "生产部署流程", topK: 20, kindFilter: "knowledge" });

	assert.ok(memory.length > 0, "memory partition is non-empty");
	assert.ok(knowledge.length > 0, "knowledge partition is non-empty");
	for (const hit of memory) assert.ok(/,memory,/i.test(hit.tags ?? ""), `memory partition leaked ${hit.title} (tags=${hit.tags})`);
	for (const hit of knowledge) assert.ok(!/,memory,/i.test(hit.tags ?? ""), `knowledge partition leaked ${hit.title} (tags=${hit.tags})`);
	// Exhaustive: every row appears on exactly one side, never both and never none.
	const ids = [...memory, ...knowledge].map((h) => h.sourceId).sort();
	assert.equal(new Set(ids).size, ids.length, "a row belongs to exactly one partition");
	assert.ok(ids.length >= 2, "partitions cover the corpus");
});

test("a case-variant memory tag has ONE identity across paths (M9/M10)", async () => {
	const db = realCorpus();
	const p = await provider(db);
	const memory = await p.search({ query: "生产部署流程", topK: 20, kindFilter: "memory" });
	const knowledge = await p.search({ query: "生产部署流程", topK: 20, kindFilter: "knowledge" });
	// "Memory"/"MEMORY" rows come from LLM tool args, so both are reachable.
	for (const id of ["m2", "m3"]) {
		const inMemory = memory.some((h) => h.sourceId === id);
		const inKnowledge = knowledge.some((h) => h.sourceId === id);
		assert.ok(inMemory || inKnowledge, `${id} must appear somewhere`);
		assert.ok(!(inMemory && inKnowledge), `${id} must not appear on both sides`);
	}
});

test("kindFilter with no filter still returns both kinds", async () => {
	const p = await provider(realCorpus());
	const all = await p.search({ query: "生产部署流程", topK: 20 });
	const memory = await p.search({ query: "生产部署流程", topK: 20, kindFilter: "memory" });
	const knowledge = await p.search({ query: "生产部署流程", topK: 20, kindFilter: "knowledge" });
	assert.equal(all.length, memory.length + knowledge.length, "unfiltered = both partitions");
});

test("kindMatches (the vector-path filter) agrees with the SQL clause (M10)", async () => {
	// The vector path filters in JS while FTS filters in SQL. If they disagree,
	// the SAME row is memory on one path and knowledge on the other. Probe the
	// JS predicate directly so this is detectable without an embed provider.
	const mod = await import(pathToFileURL(await bundleWith(`export { hasMemoryTag } from "./src/knowledge/store.ts";`)).href);
	const cases = [",memory,", ",Memory,", ",MEMORY,", "Memory,ops", "MEMORY", ",daily,memory", ",daily,", "", null];
	const sqlMem = (tags) => /(^|,)memory(,|$)/i.test(`,${(tags ?? "").replace(/^,|,$/g, "")},`);
	for (const tags of cases) {
		assert.equal(mod.hasMemoryTag(tags), sqlMem(tags), `JS/SQL disagree for tags=${JSON.stringify(tags)}`);
	}
});

test("hasMemoryTag is case-insensitive on every reachable spelling", async () => {
	const mod = await import(pathToFileURL(await bundleWith(`export { hasMemoryTag } from "./src/knowledge/store.ts";`)).href);
	for (const tags of [",Memory,", ",MEMORY,", "Memory", "memory, MEMORY", ",MemorY,)"] ) {
		assert.equal(mod.hasMemoryTag(tags), true, `${JSON.stringify(tags)} must be recognised as memory`);
	}
	// A tag that merely CONTAINS "memory" is not the memory tag.
	for (const tags of [",memoryx,", ",nonmemory,", ",memories,"]) {
		assert.equal(mod.hasMemoryTag(tags), false, `${JSON.stringify(tags)} must not be memory`);
	}
});

test("the vector path applies the same kind partition as SQL (M10, real path)", async () => {
	// Exercise vectorRecall end-to-end: same corpus, vectors available, so the
	// JS-side kindMatches filter is what decides membership. If that filter is
	// removed or made case-sensitive, the partition assertions below break even
	// though the SQL clause is intact.
	const LRP = await localRetrievalProvider();
	const db = realCorpus();
	const ids = db.prepare("SELECT id FROM kb_chunks").all().map((r) => r.id);
	const vec = {
		isAvailable: () => true,
		knn: () => ids.map((id) => ({ chunkId: id, distance: 0 })),
	};
	const mk = () =>
		new LRP({
			db,
			store: { ftsEnabled: () => true, fetchEntryMeta: () => new Map(), fetchMemoryMeta: () => new Map(), bumpUsage: () => {} },
			vec,
			readConfig: () => ({ topK: 20, bm25Weight: 1, vectorWeight: 1, embed: { embedOne: async () => new Float32Array([0.1]) } }),
		});

	const memory = await mk().search({ query: "生产部署流程", topK: 20, kindFilter: "memory" });
	const knowledge = await mk().search({ query: "生产部署流程", topK: 20, kindFilter: "knowledge" });
	assert.ok(memory.some((h) => h.sourceId === "m1"), "vector path keeps memory rows in the memory partition");
	assert.ok(!memory.some((h) => h.sourceId === "k1"), "vector path must not leak knowledge into the memory partition");
	assert.ok(!knowledge.some((h) => /,memory,/i.test(h.tags ?? "")), "vector path must not leak memory into knowledge");
});
