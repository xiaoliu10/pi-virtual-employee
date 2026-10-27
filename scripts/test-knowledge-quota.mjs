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
