/**
 * Scoped memory tests. Run with `node --test scripts/test-scoped-memory.mjs`.
 *
 * Pins the 2026-10-14 scoped-memory contract on the REAL store + identity
 * derivation (real node:sqlite, esbuild-bundled production TS):
 *
 *  - same (scope,owner,title) REPLACES content (correction), old body/chunks gone;
 *  - same title different owner is a distinct entry (no cross-person overwrite);
 *  - always-on index only shows profile + the matching person/conversation owner;
 *  - retrieval filters another person's / group's memory out of KB search;
 *  - owner keys derive from the verified actor (never message text), and the
 *    synthetic scheduler actor maps to the creator's DingTalk person owner;
 *  - consolidation merge never combines two scopes (covered at service level
 *    via sameScopeIds); here we cover the store-level identity inheritance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = mkdtempSync(join(root, "node_modules/.ve-scoped-memory-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "scoped.mjs");
const storeExport = join(root, "src/knowledge/store.ts").replace(/\\/g, "/");
const retrievalExport = join(root, "src/knowledge/retrieval/local-retrieval.ts").replace(/\\/g, "/");
const scopeExport = join(root, "src/knowledge/memory-scope.ts").replace(/\\/g, "/");
await build({
	stdin: {
		contents: `
			export { ConfigStore } from "${join(root, "src/db/config-store.ts").replace(/\\/g, "/")}";
			export { KnowledgeService } from "${join(root, "src/knowledge/knowledge-service.ts").replace(/\\/g, "/")}";
			export { KnowledgeContentStore } from "${storeExport}";
			export { LocalRetrievalProvider } from "${retrievalExport}";
			export { createRememberTool } from "${join(root, "src/engine/tools/save-knowledge.ts").replace(/\\/g, "/")}";
			export * from "${scopeExport}";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const mod = await import(pathToFileURL(bundle).href);
const { ConfigStore, KnowledgeService, KnowledgeContentStore, LocalRetrievalProvider, createRememberTool, deriveMemoryContext, ownerForScope, isMemoryVisible } = mod;

function makeDb() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE kb_entries (
			id TEXT PRIMARY KEY, title TEXT, tags TEXT, content TEXT,
			origin TEXT DEFAULT 'learned', confidence REAL DEFAULT 0.9,
			version INTEGER DEFAULT 1, lineage TEXT, archived INTEGER DEFAULT 0,
			review_status TEXT DEFAULT 'approved', source_url TEXT,
			hit_count INTEGER DEFAULT 0, last_used_at INTEGER, superseded_by TEXT,
			memory_scope TEXT, memory_owner TEXT, memory_summary TEXT,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE TABLE kb_chunks (
			id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT,
			title TEXT, tags TEXT, content TEXT NOT NULL, chunk_index INTEGER,
			metadata TEXT, embed_status TEXT DEFAULT 'pending', embedding_model TEXT,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE TABLE kb_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(content, content='kb_chunks', content_rowid='rowid', tokenize='trigram');
		CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
			INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
		CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
			INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
		END;
		CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
			INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
			INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
	db.transaction = (fn) => (...args) => {
		db.exec("BEGIN");
		try { const result = fn(...args); db.exec("COMMIT"); return result; }
		catch (err) { db.exec("ROLLBACK"); throw err; }
	};
	return db;
}

const MEM = ",memory,";
const chunkRows = (db, entryId) =>
	db.prepare("SELECT content FROM kb_chunks WHERE source='manual' AND source_id=? ORDER BY chunk_index").all(entryId).map((r) => r.content);

test("same scope/owner/title corrects by overwriting; old body and chunks disappear", () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db);
	const a = store.saveMemoryFact({ title: "回复语言", content: "请用英文回复。", scope: "person", owner: "person:dingtalk:A", summary: "用英文" });
	const b = store.saveMemoryFact({ title: "回复语言", content: "纠正：以后请用中文回复。", scope: "person", owner: "person:dingtalk:A", summary: "用中文" });
	assert.equal(b.id, a.id, "same key updates in place");
	assert.equal(b.merged, true);
	const row = db.prepare("SELECT content, memory_summary, version FROM kb_entries WHERE id=?").get(a.id);
	assert.ok(row.content.includes("中文"));
	assert.ok(!row.content.includes("英文"), "old fact must not remain appended");
	assert.equal(row.memory_summary, "用中文");
	assert.equal(row.version, 2);
	const chunks = chunkRows(db, a.id).join("\n");
	assert.ok(chunks.includes("中文"));
	assert.ok(!chunks.includes("英文"), "retrieval chunks must be replaced, not appended");
});

test("same title but different person owner is a distinct entry", () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db);
	const a = store.saveMemoryFact({ title: "称呼", content: "叫我小王", scope: "person", owner: "person:dingtalk:A" });
	const c = store.saveMemoryFact({ title: "称呼", content: "叫我李总", scope: "person", owner: "person:dingtalk:B" });
	assert.notEqual(a.id, c.id);
});

test("always-on index is scoped: profile shared, person/conversation owner-filtered, specificity ordered", () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db);
	store.saveMemoryFact({ title: "全局规则", content: "共享", scope: null, owner: null, summary: "共享" });
	store.saveMemoryFact({ title: "A的偏好", content: "a", scope: "person", owner: "person:dingtalk:A", summary: "A" });
	store.saveMemoryFact({ title: "B的偏好", content: "b", scope: "person", owner: "person:dingtalk:B", summary: "B" });
	store.saveMemoryFact({ title: "群G约定", content: "g", scope: "conversation", owner: "conversation:dt:group:G", summary: "G" });

	const aCtx = { personOwner: "person:dingtalk:A", conversationOwner: "conversation:dt:group:G" };
	const titles = store.listMemoryForContext(aCtx, 30).map((e) => e.title);
	assert.deepEqual(titles, ["群G约定", "A的偏好", "全局规则"], "conversation first, then person, then profile; B excluded");
	assert.ok(!titles.includes("B的偏好"));

	const bCtx = { personOwner: "person:dingtalk:B" };
	const bTitles = store.listMemoryForContext(bCtx, 30).map((e) => e.title);
	assert.ok(bTitles.includes("B的偏好") && bTitles.includes("全局规则"));
	assert.ok(!bTitles.includes("A的偏好") && !bTitles.includes("群G约定"));
});

test("derived merge inherits memory scope/owner/tag (no leak into general KB)", () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db);
	const a = store.saveMemoryFact({ title: "A1", content: "甲偏好短报告", scope: "person", owner: "person:dingtalk:A", summary: "A1" });
	const b = store.saveMemoryFact({ title: "A2", content: "甲偏好早晨发", scope: "person", owner: "person:dingtalk:A", summary: "A2" });
	const id = store.mergeEntries([a.id, b.id], { title: "甲的报告偏好", content: "合并后内容" });
	const row = db.prepare("SELECT memory_scope, memory_owner, tags FROM kb_entries WHERE id=?").get(id);
	assert.equal(row.memory_scope, "person");
	assert.equal(row.memory_owner, "person:dingtalk:A");
	assert.ok(("," + (row.tags ?? "") + ",").includes(",memory,"), "derived memory keeps the memory tag");
	// Visible to A only.
	assert.ok(store.listMemoryForContext({ personOwner: "person:dingtalk:A" }).some((e) => e.id === id));
	assert.ok(!store.listMemoryForContext({ personOwner: "person:dingtalk:B" }).some((e) => e.id === id));
});

test("identity derivation: scheduler creator maps to dingtalk person owner; owner is server-derived", () => {
	const live = deriveMemoryContext(
		{ senderId: "STAFF1", senderName: "张", channel: "dingtalk", chatType: "single" },
		"dt:STAFF1",
	);
	assert.equal(live.personOwner, "person:dingtalk:STAFF1");

	const group = deriveMemoryContext(
		{ senderId: "STAFF1", channel: "dingtalk", chatType: "group" },
		"dt:group:OPEN_G",
	);
	assert.equal(group.personOwner, "person:dingtalk:STAFF1");
	assert.equal(group.conversationOwner, "conversation:dt:group:OPEN_G");

	// Scheduled turn re-attaches the creator; the synthetic channel collapses to
	// dingtalk so person memory matches live turns, and the originating group
	// supplies conversation scope.
	const sched = deriveMemoryContext(
		{ senderId: "STAFF1", channel: "scheduler", chatType: "single", memoryConversationId: "dt:group:OPEN_G" },
		"sched:task-9",
	);
	assert.equal(sched.personOwner, "person:dingtalk:STAFF1");
	assert.equal(sched.conversationOwner, "conversation:dt:group:OPEN_G");

	// A sched: id without an originating IM conversation yields no conversation scope.
	const sched2 = deriveMemoryContext({ senderId: "STAFF1", channel: "scheduler", chatType: "single" }, "sched:task-9");
	assert.equal(sched2.conversationOwner, undefined);

	// No actor (console/anonymous) → no person owner; only profile memory.
	assert.deepEqual(deriveMemoryContext(undefined, "console-1"), {});
});

test("ownerForScope and isMemoryVisible enforce the boundary", () => {
	const ctx = { personOwner: "person:dingtalk:A", conversationOwner: "conversation:dt:group:G" };
	assert.equal(ownerForScope("profile", ctx), null);
	assert.equal(ownerForScope("person", ctx), "person:dingtalk:A");
	assert.equal(ownerForScope("conversation", ctx), "conversation:dt:group:G");
	assert.equal(isMemoryVisible("person", "person:dingtalk:B", ctx), false);
	assert.equal(isMemoryVisible("person", "person:dingtalk:A", ctx), true);
	assert.equal(isMemoryVisible("conversation", "conversation:dt:group:X", ctx), false);
	assert.equal(isMemoryVisible("profile", null, ctx), true);
	assert.equal(isMemoryVisible(null, null, ctx), true);
	assert.equal(isMemoryVisible("unknown", null, ctx), false);
});

test("local retrieval hides another person's/group's memory hits", async () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db);
	// Distinctive CJK phrases so LIKE/FTS matches only the right row.
	store.saveMemoryFact({ title: "A秘钥习惯", content: "A的独有习惯词：晨露偏好", scope: "person", owner: "person:dingtalk:A", summary: "晨露" });
	store.saveMemoryFact({ title: "B秘钥习惯", content: "B的独有习惯词：晚霞偏好", scope: "person", owner: "person:dingtalk:B", summary: "晚霞" });
	store.saveMemoryFact({ title: "公开流程", content: "公开流程词：极光规则所有人可见", scope: null, owner: null, summary: "极光" });
	const local = new LocalRetrievalProvider({
		db,
		store,
		readConfig: () => ({ topK: 10, bm25Weight: 1, vectorWeight: 0, embed: null }),
	});
	const texts = (hits) => hits.map((h) => h.snippet).join("\n");

	const a = await local.search({ query: "独有习惯词", topK: 10, memoryCtx: { personOwner: "person:dingtalk:A" } });
	assert.ok(texts(a).includes("晨露"));
	assert.ok(!texts(a).includes("晚霞"), "B's person memory must not surface to A");

	const none = await local.search({ query: "独有习惯词", topK: 10, memoryCtx: {} });
	assert.ok(!texts(none).includes("晨露") && !texts(none).includes("晚霞"), "console/no-owner sees no person memory");

	const pub = await local.search({ query: "公开流程词", topK: 10, memoryCtx: { personOwner: "person:dingtalk:A" } });
	assert.ok(texts(pub).includes("极光"), "profile knowledge stays visible to everyone");
});

function configWithRole(role) {
	return { all: () => ({ security: { adminStaffIds: role === "admin" ? ["ADMIN"] : [], people: [], defaultRole: role, conversations: [] } }) };
}

test("remember tool derives and enforces scope server-side", async () => {
	const groupCid = "dt:group:OPEN_G";
	const actorA = { senderId: "A", channel: "dingtalk", chatType: "group" };
	const calls = [];
	const knowledge = { saveMemory(input) { calls.push(input); return { id: "x", merged: false }; } };
	const make = (role) => createRememberTool({
		knowledge,
		config: configWithRole(role),
		conversationId: groupCid,
		resolveActor: () => ({ ...actorA, text: "记住" }),
	});

	// Viewer default → person.
	await make("viewer").execute("t1", { title: "偏好", content: "短报告" });
	assert.equal(calls.at(-1).scope, "person");
	assert.equal(calls.at(-1).owner, "person:dingtalk:A");

	// Viewer asks for profile → downgraded and actually saved as person.
	const refused = await make("viewer").execute("t2", { title: "全局", content: "所有人", scope: "profile" });
	assert.equal(calls.at(-1).scope, "person");
	assert.equal(refused.details.downgradedFrom, "profile");

	// Viewer asks for group conversation → downgraded to person.
	const noConv = await make("viewer").execute("t3", { title: "群", content: "群规", scope: "conversation" });
	assert.equal(calls.at(-1).scope, "person");
	assert.equal(noConv.details.downgradedFrom, "conversation");

	// Operator can write conversation memory for the group.
	await make("operator").execute("t4", { title: "群", content: "群规", scope: "conversation" });
	assert.equal(calls.at(-1).scope, "conversation");
	assert.equal(calls.at(-1).owner, `conversation:${groupCid}`);

	// Admin can write profile memory.
	await make("admin").execute("t5", { title: "全局", content: "所有人", scope: "profile" });
	assert.equal(calls.at(-1).scope, null);
	assert.equal(calls.at(-1).owner, null);
});

test("remember tool in local console writes shared profile memory", async () => {
	const calls = [];
	const tool = createRememberTool({
		knowledge: { saveMemory(input) { calls.push(input); return { id: "x", merged: true }; } },
		config: configWithRole("viewer"),
		conversationId: "console-1",
		resolveActor: () => undefined,
	});
	await tool.execute("t", { title: "本机", content: "共享规则" });
	assert.deepEqual({ scope: calls[0].scope, owner: calls[0].owner }, { scope: null, owner: null });
});

// ── Review regressions (2026-10-15 independent review): P1/P2 each get a pin ──

test("P1-1: remember without verified remote identity fails closed (never upgrades to profile)", async () => {
	const calls = [];
	const make = () => createRememberTool({
		knowledge: { saveMemory(input) { calls.push(input); return { id: "x", merged: false }; } },
		config: configWithRole("viewer"),
		conversationId: "dt:group:OPEN_G",
		resolveActor: () => undefined, // e.g. a console-created scheduled task (created_by=NULL)
	});
	for (const params of [
		{ title: "t", content: "c" }, // auto scope
		{ title: "t", content: "c", scope: "person" },
	]) {
		const res = await make().execute("t", params);
		assert.equal(res.details.ok, false);
		assert.equal(res.details.reason, "no-verified-actor");
	}
	assert.equal(calls.length, 0, "anonymous remote turns must write nothing — least of all profile");
});

test("P1-2: the memory tag is reserved — general knowledge paths cannot mint or strip it", () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db);
	// saveLearned with a forged memory tag: stripped, and absent from the memory index.
	const forged = store.saveLearned({ title: "普通知识", content: "规则内容", tags: "业务,memory" });
	const forgedRow = db.prepare("SELECT tags FROM kb_entries WHERE id=?").get(forged.id);
	assert.ok(!forgedRow.tags.includes("memory"));
	assert.equal(store.listMemoryForContext({}, 30).length, 0);
	// saveResearched likewise.
	const r = store.saveResearched({ title: "研究", content: "资料", tags: "memory" });
	assert.ok(!db.prepare("SELECT tags FROM kb_entries WHERE id=?").get(r).tags.includes("memory"));
	// revise cannot touch memory entries; retag cannot strip the reserved tag.
	const mem = store.saveMemoryFact({ title: "M", content: "事实", scope: "person", owner: "person:dingtalk:A" });
	assert.equal(store.reviseEntry(mem.id, { content: "篡改" }), undefined, "memory is corrected only via remember");
	store.retagEntry(mem.id, "普通标签");
	assert.ok(("," + db.prepare("SELECT tags FROM kb_entries WHERE id=?").get(mem.id).tags + ",").includes(",memory,"));
});

test("P2-1: saveLearned never merges into someone's memory by title collision", () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db);
	const a = store.saveMemoryFact({ title: "称呼", content: "叫我小王", scope: "person", owner: "person:dingtalk:A" });
	const b = store.saveLearned({ title: "称呼", content: "群友B说：叫我李总" });
	assert.notEqual(b.id, a.id, "title collision with a memory entry creates a separate knowledge entry");
	assert.equal(db.prepare("SELECT content FROM kb_entries WHERE id=?").get(a.id).content, "叫我小王", "A's memory untouched");
});

test("P2-2: store rejects cross-scope merges and invalid memory facts", () => {
	const db = makeDb();
	const store = new KnowledgeContentStore(db);
	const a = store.saveMemoryFact({ title: "A1", content: "a", scope: "person", owner: "person:dingtalk:A" });
	const b = store.saveMemoryFact({ title: "B1", content: "b", scope: "person", owner: "person:dingtalk:B" });
	assert.throws(() => store.mergeEntries([a.id, b.id], { title: "x", content: "y" }), /scope\/owner/);
	assert.throws(() => store.saveMemoryFact({ title: "t", content: "c", scope: "person", owner: null }), /owner/);
	assert.throws(() => store.saveMemoryFact({ title: "t", content: "c", scope: "weird", owner: null }), /scope/);
});

test("consolidation partitions by scope/owner before the LLM; memory never archived; foreign ids rejected", async () => {
	const db = makeDb();
	const svc = new KnowledgeService(db, new ConfigStore(db));
	svc.saveMemory({ title: "A偏好1", content: "甲喜欢短报告-独特词alpha", scope: "person", owner: "person:dingtalk:A" });
	svc.saveMemory({ title: "A偏好2", content: "甲喜欢早晨发送-独特词alpha", scope: "person", owner: "person:dingtalk:A" });
	svc.saveMemory({ title: "B偏好1", content: "乙喜欢详细表格-独特词beta", scope: "person", owner: "person:dingtalk:B" });
	svc.saveMemory({ title: "B偏好2", content: "乙喜欢下班前发-独特词beta", scope: "person", owner: "person:dingtalk:B" });
	svc.saveLearned({ title: "流程1", content: "对账先导出-独特词gamma" });
	svc.saveLearned({ title: "流程2", content: "对账再核对-独特词gamma" });
	const prompts = [];
	svc.setLlm(async (_sys, user) => {
		prompts.push(user);
		const ids = [...user.matchAll(/id=([0-9a-f-]{36})/g)].map((m) => m[1]);
		return JSON.stringify({ merge: [{ ids, title: "合并条目", content: "合并后的内容", tags: "合并" }] });
	});
	const report = await svc.consolidate();
	assert.equal(report.error, undefined);
	assert.equal(prompts.length, 3, "person A / person B / regular knowledge each get their own LLM call");
	for (const p of prompts) {
		const owners = ["独特词alpha", "独特词beta", "独特词gamma"].filter((w) => p.includes(w));
		assert.equal(owners.length, 1, `one prompt must contain exactly one partition's content, got ${owners}`);
	}
	assert.equal(report.merged, 6);
	assert.equal(report.derived, 3);
	const derivedA = db.prepare("SELECT memory_scope, memory_owner, tags FROM kb_entries WHERE origin='derived' AND memory_owner='person:dingtalk:A'").get();
	assert.equal(derivedA.memory_scope, "person");
	assert.ok(derivedA.tags.includes("memory"), "derived memory keeps the reserved tag and owner");

	// Memory entries are never archived by the background LLM.
	const db2 = makeDb();
	const svc2 = new KnowledgeService(db2, new ConfigStore(db2));
	const m1 = svc2.saveMemory({ title: "M1", content: "事实一", scope: "person", owner: "person:dingtalk:A" });
	svc2.saveMemory({ title: "M2", content: "事实二", scope: "person", owner: "person:dingtalk:A" });
	svc2.setLlm(async () => JSON.stringify({ archive: [m1.id] }));
	const r2 = await svc2.consolidate();
	assert.equal(r2.archived, 0);
	assert.equal(db2.prepare("SELECT COUNT(*) n FROM kb_entries WHERE archived=1").get().n, 0, "memory is corrected via remember, never silently archived");

	// Ops referencing ids outside the shown partition are rejected wholesale.
	const db3 = makeDb();
	const svc3 = new KnowledgeService(db3, new ConfigStore(db3));
	const a3 = svc3.saveMemory({ title: "X1", content: "内容x", scope: "person", owner: "person:dingtalk:A" });
	svc3.saveMemory({ title: "X1b", content: "内容x2", scope: "person", owner: "person:dingtalk:A" });
	const b3 = svc3.saveMemory({ title: "X2", content: "内容y", scope: "person", owner: "person:dingtalk:B" });
	svc3.saveMemory({ title: "X2b", content: "内容y2", scope: "person", owner: "person:dingtalk:B" });
	svc3.setLlm(async () => JSON.stringify({ merge: [{ ids: [a3.id, b3.id], title: "跨人合并", content: "不应该发生" }] }));
	const r3 = await svc3.consolidate();
	assert.equal(r3.merged, 0, "cross-owner merge op rejected in every partition");
	assert.equal(db3.prepare("SELECT COUNT(*) n FROM kb_entries WHERE archived=0").get().n, 4);
});
