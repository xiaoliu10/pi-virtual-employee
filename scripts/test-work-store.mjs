/** Real SQL via node:sqlite; never load/rebuild the Electron native addon. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = await mkdtemp(join(root, "node_modules/.work-store-test-"));
after(() => rm(tmp, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/db/work-item-store.ts")], outfile: join(tmp, "store.mjs"), bundle: true, platform: "node", format: "esm", packages: "external" });
const { WorkItemStore } = await import(pathToFileURL(join(tmp, "store.mjs")));
const schema = (await readFile(join(root, "src/db/sqlite.ts"), "utf8")).match(/CREATE TABLE IF NOT EXISTS work_items \([\s\S]*?\);/)[0];
function fixture(t) {
	const db = new DatabaseSync(":memory:");
	db.exec(schema);
	if (!db.prepare("PRAGMA table_info(work_items)").all().some(c => c.name === "answer")) db.exec("ALTER TABLE work_items ADD COLUMN answer TEXT");
	t.after(() => db.close());
	return { db, store: new WorkItemStore({ prepare: (sql) => db.prepare(sql) }) };
}
function create(store, status = "proposed") { return store.create({ title: "月末对账", goal: "核对流水", status, createdBy: "proposer", originConversation: "dt:source" }); }

test("confirm atomically records confirming admin and queues only proposals", t => {
	const { store } = fixture(t);
	const item = create(store);
	assert.equal(store.confirm(item.id, ""), undefined);
	const confirmed = store.confirm(item.id, "verified-admin");
	assert.equal(confirmed.status, "queued");
	assert.equal(confirmed.created_by, "verified-admin");
	assert.equal(store.confirm(item.id, "other-admin"), undefined);
	assert.equal(store.get(item.id).created_by, "verified-admin");
});

test("queued confirmations and due items selected FIFO; future and blocked items excluded", t => {
	const { db, store } = fixture(t);
	const due = create(store, "scheduled");
	const queued = create(store, "queued");
	const future = create(store, "scheduled");
	create(store, "waiting_human"); create(store, "proposed");
	db.prepare("UPDATE work_items SET next_check_at = ? WHERE id = ?").run(100, due.id);
	db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(200, queued.id);
	db.prepare("UPDATE work_items SET next_check_at = ? WHERE id = ?").run(500, future.id);
	assert.deepEqual(store.listDue(300).map(i => i.id), [due.id, queued.id]);
	assert.equal(store.nextWakeAt(), 100);
	assert.ok(store.claim(due.id, 300));
	assert.equal(store.claim(due.id, 300), undefined);
	assert.equal(store.claim(future.id, 300), undefined);
	assert.equal(store.nextWakeAt(), 500);
	assert.deepEqual(store.listByStatus(), []);
});

test("startup working recovery waits human without consuming answer or notebook", t => {
	const { db, store } = fixture(t);
	const item = create(store, "working");
	store.setField(item.id, "conditions", "勿重复扣款");
	store.addLesson(item.id, "先核查付款结果");
	db.prepare("UPDATE work_items SET answer = ? WHERE id = ?").run("已审批", item.id);
	store.recoverWorking();
	const recovered = store.get(item.id);
	assert.equal(recovered.status, "waiting_human");
	assert.equal(recovered.answer, "已审批");
	assert.match(recovered.question, /核查/);
	assert.equal(recovered.conditions, "勿重复扣款");
	assert.equal(store.claim(item.id, Date.now()), undefined);
});

test("resume atomically stages answer ONLY waiting_human; failed sends retain it", t => {
	const { store } = fixture(t);
	const item = create(store, "waiting_human");
	assert.equal(store.resume(item.id, "财务已审批").status, "queued");
	assert.equal(store.get(item.id).answer, "财务已审批");
	assert.equal(store.resume(item.id, "覆盖攻击"), undefined);
	assert.equal(store.get(item.id).answer, "财务已审批");
	store.claim(item.id, Date.now());
	store.clearAnswer(item.id, "错误答案");
	assert.equal(store.get(item.id).answer, "财务已审批");
	store.setStatus(item.id, "waiting_human", "发送失败", null);
	store.resume(item.id); // retry without replacing retained answer
	store.claim(item.id, Date.now());
	store.clearAnswer(item.id, "财务已审批");
	assert.equal(store.get(item.id).answer, null);
});

test("terminal states survive late runner/tool writes, cancel, confirm and resume", t => {
	const { store } = fixture(t);
	for (const terminal of ["done", "cancelled"]) {
		const item = create(store, "working");
		store.setField(item.id, "progress", "原笔记");
		store.setStatus(item.id, terminal, null, null);
		store.setStatus(item.id, "scheduled", null, Date.now());
		store.setStatus(item.id, "waiting_human", "晚到结果", null);
		store.setField(item.id, "progress", "晚到笔记");
		store.addLesson(item.id, "晚到经验");
		store.cancel(item.id);
		assert.equal(store.resume(item.id, "继续"), undefined);
		assert.equal(store.confirm(item.id, "admin"), undefined);
		assert.equal(store.get(item.id).status, terminal);
		assert.equal(store.get(item.id).progress, "原笔记");
		assert.equal(store.get(item.id).lessons, null);
	}
});

test("generic status writes cannot bypass admin confirm or explicit human resume", t => {
	const { store } = fixture(t);
	for (const status of ["proposed", "waiting_human"]) {
		const item = create(store, status);
		store.setStatus(item.id, "queued", null, null);
		store.setStatus(item.id, "scheduled", null, 1);
		assert.equal(store.get(item.id).status, status);
	}
});

test("fixed_streak only moves while scheduled; reason persists and clears with state", t => {
	const { store } = fixture(t);
	const item = create(store);
	store.confirm(item.id, "admin");
	store.setFixedStreak(item.id, 5);
	assert.equal(store.get(item.id).fixed_streak, 0, "queued items carry no streak");
	const working = store.claim(item.id, Date.now());
	assert.equal(working.status, "working");
	store.setStatus(item.id, "scheduled", null, Date.now() + 3_600_000, "等晚间批次");
	assert.equal(store.get(item.id).next_check_reason, "等晚间批次");
	store.setFixedStreak(item.id, 3);
	assert.equal(store.get(item.id).fixed_streak, 3);
	store.setStatus(item.id, "waiting_human", "需要人工", null);
	assert.equal(store.get(item.id).status, "scheduled", "only the runner (from working) may leave scheduled");
	// Real runner path: the due scheduled item is claimed back to working, then paused.
	const again = store.claim(item.id, Date.now() + 7_200_000);
	assert.equal(again.status, "working");
	store.setStatus(item.id, "waiting_human", "需要人工", null);
	assert.equal(store.get(item.id).next_check_reason, null, "stale reason must not survive into waiting_human");
	assert.equal(store.get(item.id).fixed_streak, 3, "streak number is retained but only read on scheduled wake");
});
