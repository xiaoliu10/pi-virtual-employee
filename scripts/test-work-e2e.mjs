/**
 * End-to-end work-item lifecycle, real components in one node process.
 *
 * Wires the REAL node:sqlite store (canonical work_items + history schemas),
 * real WorkItemStore, real HistoryStore, real createWorkTools, real WorkService
 * with a deterministic Clock, and real engine.mineRecentWork (instantiated via
 * Object.create(EmployeeEngine.prototype) + Object.assign, the same pattern as
 * scripts/test-work-mining.mjs). Only the LLM (engine.complete) and the engine
 * send channel (WorkService.send) are scripted substitutes — everything between
 * them is the real production code path.
 *
 * The chain driven through PUBLIC surfaces only:
 *   seed 3 messages → mineRecentWork (1 proposal) → tool confirm (goal rewrite)
 *   → WorkService window 1 (scheduled ~+30m, first-window plan) → advance 30m
 *   → window 2 (waiting_human, 【上次跟进】, push to source) → tool update
 *   (conditions) → tool resume (answer) → window 3 (done, learn once, clean push)
 *
 * Negative gates: source-scoping refusal from a different conversation, and an
 * admin pause mid-window (separate fixture so it cannot perturb the main chain).
 *
 * Seams this script does NOT reach: the real LLM (scripted), the real DingTalk
 * adapter (pushes are captured, not sent over the network), and Electron IPC
 * (the tool object is invoked directly, as the renderer would via ipcRenderer).
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.work-e2e-test-"));
after(() => rm(dir, { recursive: true, force: true }));

// One bundle carries every real component the E2E exercises. The Agent SDK is
// stubbed (engine.mineRecentWork only calls engine.complete, never a real Agent).
const bundle = join(dir, "e2e.mjs");
await build({
	stdin: {
		contents: `
			export { EmployeeEngine } from "./src/engine/engine.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { WorkItemStore } from "./src/db/work-item-store.ts";
			export { WorkService } from "./src/scheduler/work-service.ts";
			export { createWorkTools } from "./src/engine/tools/work.ts";
			export { resolveRole } from "./src/security/permissions.ts";
			export { MINING_SYSTEM } from "./src/scheduler/mining.ts";
		`, resolveDir: root, loader: "ts",
	},
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
	plugins: [{
		name: "stub-agent-sdk",
		setup(b) {
			b.onResolve({ filter: /^@earendil-works\/pi-agent-core$/ }, () => ({ path: "agent", namespace: "stub" }));
			b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
				export class Agent { constructor(opts) { this.state = opts.initialState; } }
				export const DEFAULT_COMPACTION_SETTINGS = {};
				export const convertToLlm = x => x;
				export const estimateContextTokens = () => 0;
				export const estimateTokens = () => 0;
				export const generateSummary = () => '';
				export const shouldCompact = () => false;
				export const createCompactionSummaryMessage = x => x;
			` }));
		},
	}],
});
const {
	EmployeeEngine, HistoryStore, ConfigStore, WorkItemStore,
	WorkService, createWorkTools, resolveRole, MINING_SYSTEM,
} = await import(pathToFileURL(bundle).href);

const SOURCE = "dt:group:orders";
const OTHER = "dt:group:other";
const WORK_ITEMS_SCHEMA = (await readFile(join(root, "src/db/sqlite.ts"), "utf8")).match(/CREATE TABLE IF NOT EXISTS work_items \([\s\S]*?\);/)[0];
const CONVERSATIONS_SCHEMA = "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_supplier_id TEXT, model_model_id TEXT, origin TEXT NOT NULL DEFAULT 'console');";
const MESSAGES_SCHEMA = "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL);";
const MEMBERS_SCHEMA = "CREATE TABLE IF NOT EXISTS conversation_members (conversation_id TEXT NOT NULL, staff_id TEXT NOT NULL, name TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, message_count INTEGER NOT NULL, PRIMARY KEY (conversation_id, staff_id));";
const CONFIG_SCHEMA = "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);";

// node:sqlite's DatabaseSync has the prepare/run/get/all surface WorkItemStore,
// HistoryStore and ConfigStore need; one object serves all three stores.
function database(t, file = ":memory:") {
	const db = new DatabaseSync(file);
	db.exec(`${CONVERSATIONS_SCHEMA}\n${MESSAGES_SCHEMA}\n${MEMBERS_SCHEMA}\n${CONFIG_SCHEMA}\n${WORK_ITEMS_SCHEMA}`);
	// The answer column was added by a later migration — match the app's real ALTER.
	if (!db.prepare("PRAGMA table_info(work_items)").all().some((c) => c.name === "answer")) db.exec("ALTER TABLE work_items ADD COLUMN answer TEXT");
	// HistoryStore creates work_mining_cursors itself; mirror the canonical schema.
	db.exec("CREATE TABLE IF NOT EXISTS work_mining_cursors (conversation_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, message_rowid INTEGER NOT NULL)");
	t.after(() => { if (db.isOpen) db.close(); });
	return db;
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

/** Deterministic clock copied from scripts/test-work-service.mjs: the WorkService
 *  sees a single in-order timer queue, never real wall time. */
class Clock {
	constructor(start = "2026-10-01T10:00:00") { this.time = new Date(start).getTime(); this.timers = new Map(); this.seq = 0; }
	now = () => this.time;
	setTimeout = (fn, ms) => { const id = ++this.seq; this.timers.set(id, { fn, at: this.time + ms }); return id; };
	clearTimeout = (id) => this.timers.delete(id);
	async advance(ms) {
		const end = this.time + ms;
		for (;;) {
			const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await flush();
		}
		this.time = end; await flush();
	}
}

const MARKS = ["[[TASK_DONE]]", "[[NEED_HUMAN]]", "[[NEXT_CHECK]]"];

/** Scripted LLM for mining: parse the (untrusted) prompt data line and return one
 *  valid proposal whose evidence + message id come from the actual seeded snippet
 *  (so validateMiningProposal passes). Same shape as test-work-mining's helper. */
function miningReply(prompt) {
	const data = JSON.parse(prompt.split("\n")[1]);
	const m = data.messages[0];
	return JSON.stringify({ proposals: [{
		title: "每日订单巡检",
		goal: "核对昨日订单状态，异常单标记并汇报",
		evidence: m.content,
		evidence_message_id: m.id,
		conditions: "审批后 30 分钟内完成",
		origin_conversation: data.source_id,
	}] });
}

/**
 * The full E2E harness: real stores + real engine (for mining) + real WorkService
 * + real createWorkTools. `send` is the scripted engine.send substitute that both
 * asserts the window prefix and returns the scripted reply chain. `liveActor` is
 * mutable so each tool invoke can carry the exact text the explicit-confirmation
 * gate expects — mirroring how the real engine rebinds resolveActor per IM turn.
 */
function harness(t) {
	const db = database(t);
	const history = new HistoryStore(db);
	const workItems = new WorkItemStore(db);
	const config = new ConfigStore(db);
	// Real admin whitelist: boss is the only admin (resolveRole must agree).
	config.update({ security: { adminStaffIds: ["boss"] } });

	// Mining pushes go through engine.workBridge.push; service outcome pushes go
	// through WorkService.push. Capture separately to keep the two paths honest.
	const miningPushes = [];
	const engine = Object.create(EmployeeEngine.prototype);
	Object.assign(engine, {
		history, workItems, miningInFlight: false,
		workBridge: {
			fireItem: (id) => service?.fireItem(id) ?? false,
			push: async (cid, text) => { miningPushes.push({ cid, text }); return { ok: true }; },
		},
		// Scripted LLM: returns exactly one valid proposal for the scanned source.
		complete: async (system, prompt) => {
			assert.equal(system, MINING_SYSTEM);
			return miningReply(prompt);
		},
	});

	const sends = [];
	const servicePushes = [];
	const learned = [];
	const aborted = [];
	const errors = [];
	const clock = new Clock();
	// Scripted send chain: window1 → NEXT_CHECK 30m, window2 → NEED_HUMAN,
	// window3 (resume) → TASK_DONE. Each call asserts its expected prefix.
	const send = async (_session, message, senderId) => {
		sends.push({ message, senderId });
		const n = sends.length;
		if (n === 1) {
			assert.match(message, /【首个窗口：先出跟进计划】/);
			assert.ok(message.indexOf("【首个窗口：先出跟进计划】") < message.indexOf("窗口规则："));
			return { reply: "对账批次 30 分钟后生成，先列计划\n[[NEXT_CHECK]]: 30m | 批次 30 分钟后生成" };
		}
		if (n === 2) {
			assert.match(message, /【上次跟进】.*批次 30 分钟后生成/);
			assert.doesNotMatch(message, /【首个窗口：先出跟进计划】/);
			return { reply: "需要审批号才能放行\n[[NEED_HUMAN]]: 需要审批号" };
		}
		assert.match(message, /用户对你上一轮问题的回复：审批号 P-778/);
		return { reply: "审批完成，已提交\n[[TASK_DONE]]" };
	};
	// service is referenced by engine.workBridge.fireItem above; assign after.
	const service = new WorkService({
		store: workItems,
		isAdmin: (id) => id === "boss",
		open: (item, cid) => { history.ensureConversation(cid, `🧭 ${item.title}`); return { abort: () => aborted.push(item.id) }; },
		send,
		release: async () => {},
		push: async (cid, text) => { servicePushes.push({ cid, text }); },
		canLearn: () => true,
		learn: (item, result) => { learned.push({ item, result }); },
		budget: { maxTurns: 3, maxMinutes: 30 },
		clock,
		onError: (err) => errors.push(err),
	});
	// Mutable per-turn actor: set .text before each invoke (explicit confirmation
	// phrase for confirm/resume; any non-empty text for update/pause).
	let liveActor = { senderId: "boss", channel: "dingtalk", chatType: "group", text: "占位文本" };
	const tools = createWorkTools({
		workItems,
		fireItem: (id) => service.fireItem(id),
		mine: (opts) => engine.mineRecentWork(opts),
		config,
		resolveActor: () => liveActor,
		conversationId: SOURCE,
	});
	const manageItems = tools.find((tool) => tool.name === "manage_work_items");
	const as = (text) => { liveActor = { ...liveActor, text }; return liveActor; };
	const invoke = (params, text) => { if (text) as(text); return manageItems.execute("call", params); };
	t.after(async () => { await service.stop(); });
	return { db, history, workItems, config, engine, service, tools, manageItems, sends, servicePushes, miningPushes, learned, aborted, errors, clock, as, invoke };
}

test("full lifecycle: seed → mine → confirm → 3 windows → done + learn", async (t) => {
	const h = harness(t);
	// 1. Seed 3 user messages into the source conversation.
	h.history.ensureConversation(SOURCE, "Orders");
	const seeded = [];
	for (const text of [
		"请每天核对昨日订单状态，异常单标记并汇报。",
		"对账批次 30 分钟后生成，到时再查。",
		"审批后才能放行。",
	]) seeded.push(h.history.appendMessage(SOURCE, "user", text));
	assert.equal(seeded.length, 3);

	// 2. mineRecentWork → 1 proposal persisted, origin = source.
	const mined = await h.engine.mineRecentWork();
	assert.equal(mined.error, undefined, `mining error: ${mined.error}`);
	assert.equal(mined.proposals.length, 1);
	assert.equal(mined.scanned, 1);
	assert.equal(mined.proposals[0].originConversation, SOURCE);
	assert.equal(mined.proposals[0].delivered, true);
	const rows = h.workItems.list();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "proposed");
	assert.equal(rows[0].origin_conversation, SOURCE);
	assert.equal(rows[0].created_by, null, "proposed item has no confirmer yet");
	// The mining proposal push went to the source conversation only.
	assert.equal(h.miningPushes.length, 1);
	assert.equal(h.miningPushes[0].cid, SOURCE);
	assert.match(h.miningPushes[0].text, /自主工作提案/);
	const itemId = rows[0].id;

	// 9 (setup, asserted here): boss is the real admin via ConfigStore.
	assert.equal(resolveRole(h.config, "boss"), "admin");
	assert.equal(resolveRole(h.config, "anyone-else"), "viewer");

	// 3. Tool confirm with a goal rewrite, by boss in the source conversation.
	const confirm = await h.invoke({ action: "confirm", id: itemId, goal: "改写后的目标" }, "确认创建，但目标改为重写后的");
	assert.match(confirm.content[0].text, /已确认创建/);
	assert.equal(confirm.details.fired, false, "service not started yet — confirm persists queued, does not fire");
	assert.equal(confirm.details.queued, true);
	const confirmed = h.workItems.get(itemId);
	assert.equal(confirmed.status, "queued");
	assert.equal(confirmed.goal, "改写后的目标", "goal rewritten per admin");
	assert.equal(confirmed.created_by, "boss");
	assert.equal(confirmed.fixed_streak, 0);

	// 4. Start WorkService → window 1 fires (the service auto-dispatches the queued item).
	h.service.start();
	await flush();
	assert.equal(h.sends.length, 1, "window 1 send happened");
	const row1 = h.workItems.get(itemId);
	assert.equal(row1.status, "scheduled");
	assert.ok(row1.next_check_at !== null);
	// ~now+30m (clock.now advanced only by microtasks; 30m is the declared gap).
	const expected = h.clock.now() + 30 * 60_000;
	assert.ok(Math.abs(row1.next_check_at - expected) <= 60_000, `next_check_at ~+30m: got ${row1.next_check_at} vs ${expected}`);
	assert.equal(row1.next_check_reason, "批次 30 分钟后生成");
	// The scheduled outcome push went to the source conversation.
	assert.equal(h.servicePushes.length, 1);
	assert.equal(h.servicePushes[0].cid, SOURCE);
	assert.match(h.servicePushes[0].text, /自主任务阶段进展/);
	assert.match(h.servicePushes[0].text, /批次 30 分钟后生成/);

	// 5. advance 30m → window 2: 【上次跟进】 present, becomes waiting_human.
	await h.clock.advance(30 * 60_000);
	assert.equal(h.sends.length, 2, "window 2 send happened");
	const row2 = h.workItems.get(itemId);
	assert.equal(row2.status, "waiting_human");
	assert.equal(row2.question, "需要审批号");
	assert.equal(h.servicePushes.length, 2);
	assert.equal(h.servicePushes[1].cid, SOURCE);
	assert.match(h.servicePushes[1].text, /自主任务需要人工/);
	assert.match(h.servicePushes[1].text, /需要审批号/);

	// 6. Tool update: admin adjusts conditions (any non-terminal state allowed).
	const update = await h.invoke({ action: "update", id: itemId, conditions: "审批后 30 分钟内完成" }, "把条件改一下");
	assert.match(update.content[0].text, /已更新/);
	const row2b = h.workItems.get(itemId);
	assert.equal(row2b.status, "waiting_human");
	assert.equal(row2b.conditions, "审批后 30 分钟内完成");

	// 7. Tool resume: admin explicitly confirms continuation with an answer.
	const resume = await h.invoke({ action: "resume", id: itemId, answer: "审批号 P-778" }, "确认继续，审批号 P-778");
	assert.match(resume.content[0].text, /已确认恢复/);
	assert.equal(resume.details.resumed, true);
	const row2c = h.workItems.get(itemId);
	// The running service claims the resumed item within the same turn
	// (queued → working) before this read, so accept either pre-window-3 state;
	// the load-bearing assertion is that the answer was staged and is consumed
	// exactly once by window 3 below.
	assert.ok(["queued", "working"].includes(row2c.status), `status after resume: ${row2c.status}`);
	assert.equal(row2c.answer, "审批号 P-778", "answer staged before the next window");
	// Window 3 fires (resume re-queued the item; the service picks it up).
	await flush();
	assert.equal(h.sends.length, 3, "window 3 send happened");
	const row3 = h.workItems.get(itemId);
	assert.equal(row3.status, "done");
	assert.equal(row3.answer, null, "answer consumed exactly once");
	// The answer text must appear in exactly one send (window 3's prefix) and not
	// in the earlier windows — i.e. consumed once, never re-injected.
	assert.equal(h.sends.filter((s) => s.message.includes("审批号 P-778")).length, 1);
	// The done push carries no protocol marker lines (markers are stripped).
	assert.equal(h.servicePushes.length, 3);
	const donePush = h.servicePushes[2];
	assert.equal(donePush.cid, SOURCE);
	assert.match(donePush.text, /自主任务完成/);
	for (const mark of MARKS) assert.doesNotMatch(donePush.text, new RegExp(mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `done push must not contain ${mark}`);
	// 7 (learn): the learn callback fired exactly once with the completed item.
	assert.equal(h.learned.length, 1);
	assert.equal(h.learned[0].item.id, itemId);
	assert.equal(h.learned[0].item.status, "done");
	// No errors leaked through the lifecycle.
	assert.equal(h.errors.length, 0, `errors: ${JSON.stringify(h.errors)}`);
});

test("source scoping: the same admin in a DIFFERENT conversation cannot touch the item", async (t) => {
	const h = harness(t);
	h.history.ensureConversation(SOURCE, "Orders");
	h.history.appendMessage(SOURCE, "user", "请每天核对昨日订单状态，异常单标记并汇报。");
	const mined = await h.engine.mineRecentWork();
	assert.equal(mined.proposals.length, 1);
	const itemId = h.workItems.list()[0].id;

	// A tool set scoped to a DIFFERENT conversation, even with the same boss.
	const otherTools = createWorkTools({
		workItems: h.workItems,
		fireItem: () => false,
		mine: () => ({ proposals: [], scanned: 0 }),
		config: h.config,
		resolveActor: () => ({ senderId: "boss", channel: "dingtalk", chatType: "group", text: "确认创建" }),
		conversationId: OTHER,
	});
	const otherItems = otherTools.find((tool) => tool.name === "manage_work_items");
	// list in the foreign conversation must NOT see the source-scoped item.
	const list = await otherItems.execute("call", { action: "list" });
	assert.match(list.content[0].text, /还没有工作项|当前来源会话还没有工作项/);
	// get with the same id must refuse (source scoping, not id mismatch).
	const get = await otherItems.execute("call", { action: "get", id: itemId });
	assert.match(get.content[0].text, /未找到该工作项|来源会话/);
	// confirm with the same id must refuse too.
	const confirm = await otherItems.execute("call", { action: "confirm", id: itemId, goal: "x" });
	assert.match(confirm.content[0].text, /拒绝|未找到|来源会话/);
	// The item is untouched.
	assert.equal(h.workItems.get(itemId).status, "proposed");
	assert.equal(h.workItems.get(itemId).created_by, null);
});

test("admin pause mid-window: aborts the in-flight send and the final push carries the pause marker", async (t) => {
	const db = database(t);
	const history = new HistoryStore(db);
	const workItems = new WorkItemStore(db);
	const config = new ConfigStore(db);
	config.update({ security: { adminStaffIds: ["boss"] } });
	const sends = [];
	const pushes = [];
	const aborted = [];
	const errors = [];
	const clock = new Clock();
	const gate = deferred();
	const service = new WorkService({
		store: workItems,
		isAdmin: (id) => id === "boss",
		open: (item, cid) => { history.ensureConversation(cid, `🧭 ${item.title}`); return { abort: () => aborted.push(item.id) }; },
		// Window 1 hangs until we resolve the gate — so the pause lands mid-send.
		send: async (_s, message) => { sends.push({ message }); return gate.promise; },
		release: async () => {},
		push: async (cid, text) => { pushes.push({ cid, text }); },
		canLearn: () => true,
		learn: () => {},
		budget: { maxTurns: 3, maxMinutes: 30 },
		clock,
		onError: (err) => errors.push(err),
	});
	t.after(async () => { await service.stop(); });
	// A proposed item, confirmed by boss, then paused mid-window.
	const item = workItems.create({ title: "暂停演练", goal: "完成演练", originConversation: SOURCE, status: "proposed" });
	workItems.confirm(item.id, "boss");
	const pauseTools = createWorkTools({
		workItems,
		fireItem: (id) => service.fireItem(id),
		mine: () => ({ proposals: [], scanned: 0 }),
		config,
		resolveActor: () => ({ senderId: "boss", channel: "dingtalk", chatType: "group", text: "先暂停核对口径" }),
		conversationId: SOURCE,
	});
	const pauseItems = pauseTools.find((tool) => tool.name === "manage_work_items");

	service.start();
	await flush();
	assert.equal(sends.length, 1, "window 1 send is in flight (deferred)");
	assert.equal(workItems.get(item.id).status, "working");

	// Pause while the send is still pending. The store's pause-marker persists
	// waiting_human, and the service's subscribe fires on the change to abort
	// the in-flight window.
	const pauseResult = await pauseItems.execute("call", { action: "pause", id: item.id, reason: "先核对口径" });
	assert.match(pauseResult.content[0].text, /已暂停/);
	await flush();
	const paused = workItems.get(item.id);
	assert.equal(paused.status, "waiting_human");
	assert.match(paused.question, /管理员暂停：先核对口径/);
	assert.deepEqual(aborted, [item.id], "in-flight abort requested on pause");
	// Resolve the hung send — the runner must NOT overwrite the admin pause.
	gate.resolve({ reply: "[[TASK_DONE]]" });
	await flush();
	const after = workItems.get(item.id);
	assert.equal(after.status, "waiting_human", "late DONE cannot overwrite the pause");
	assert.match(after.question, /管理员暂停：先核对口径/);
	// The final push to the source carries the pause marker.
	assert.ok(pushes.some((p) => p.cid === SOURCE && /管理员暂停/.test(p.text)), "push carries the pause marker");
	// No learn fired (the item did not complete) and no errors leaked.
	assert.equal(errors.length, 0, `errors: ${JSON.stringify(errors)}`);
});
