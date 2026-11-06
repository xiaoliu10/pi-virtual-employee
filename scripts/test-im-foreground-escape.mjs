/**
 * 「前台执行」escape hatch (router-worker design D6, landed 0.2.193).
 *
 * Field 2026-11-05: a chat-dispatched rerun of a scheduled task's failed run
 * pushed as 「自主任务阶段进展」 and the user complained the thing was never an
 * autonomous task. The dispatch already had a documented escape (D6: "回复
 * 「前台执行」可立即切回") but the ACK could not even mention it — no inbound
 * handler existed (review P1-1).
 *
 * Pinned here, through the REAL manager handle() flow with a REAL work-item
 * store:
 *  - creator-only conversion (another sender in the same group cannot recall
 *    someone else's task);
 *  - queued AND scheduled items convert (a working window is refused — a
 *    foreground rerun would double-execute the work);
 *  - conversion cancels the item and re-runs the ORIGINAL instruction inline
 *    (restored from the goal's [用户原始指令] block);
 *  - the re-run skips plan-ahead AND triage: no new work item, no plan card —
 *    a foreground escape that re-dispatches to background would be absurd;
 *  - the escape phrase alone (nothing convertible) gets an honest notice, not
 *    a model turn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.fg-escape-test-"));
process.on("exit", () => { void rm(dir, { recursive: true, force: true }).catch(() => {}); });
const bundle = join(dir, "mgr.mjs");
await build({
	stdin: {
		contents: `
			export { IMAdapterManager } from "./src/im/manager.ts";
			export { WorkItemStore } from "./src/db/work-item-store.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { IMAdapterManager, WorkItemStore } = await import(pathToFileURL(bundle).href);

/** Real sqlite-backed store (same schema the app uses). */
function makeStore() {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE IF NOT EXISTS work_items (
		id TEXT PRIMARY KEY, title TEXT, goal TEXT, conditions TEXT, progress TEXT, lessons TEXT,
		origin_conversation TEXT, origin_note TEXT, origin TEXT, status TEXT, question TEXT,
		next_check_at INTEGER, next_check_reason TEXT, fixed_streak INTEGER, timeout_streak INTEGER,
		fallback_streak INTEGER, max_minutes INTEGER, last_remind_at INTEGER, remind_count INTEGER,
		cadence_ms INTEGER, kicked_off INTEGER, created_by TEXT, created_channel TEXT, priority INTEGER,
		resident INTEGER, created_at INTEGER, updated_at INTEGER, answer TEXT)`);
	return new WorkItemStore({ prepare: (sql) => db.prepare(sql) });
}

/** Manager harness: real store + stub engine, wired like test-triage.mjs does. */
function makeManager({ store = makeStore(), sender = "u1", plan = null } = {}) {
	const sends = [];
	const plans = [];
	const fired = [];
	const engine = {
		workItems: store,
		workBridge: { fireItem: (id) => { fired.push(id); return true; } },
		getOrCreateSession: (id) => ({ id }),
		isConversationStreaming: () => false,
		recordConversationMember: () => {},
		inventoryBackgroundProcesses: () => [],
		planTaskBrief: async (_agent, text) => { plans.push(text); return plan; },
		send: async (_agent, text) => { sends.push(text); return { reply: `前台完成：${String(text).slice(0, 24)}` }; },
		confirmAuthorization: async () => "授权",
	};
	const config = {
		all: () => ({
			general: { chatDispatch: { enabled: true }, taskPlanning: { enabled: true }, turnTimeoutMin: 0, longTaskProgressMin: 0 },
			security: { adminStaffIds: ["u1", "u2"], ownerStaffIds: [], people: [], defaultRole: "viewer", conversations: [] },
			capabilities: {},
		}),
	};
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, {
		engine: { value: engine },
		config: { value: config },
		active: { value: new Map() },
		chains: { value: new Map() },
		inventoryTimers: { value: new Map() },
		applied: { value: new Map() },
	});
	return { manager, store, sends, plans, fired };
}

const CONV = "dt:group:cidX";
const PLAN = "1. 登录 spay\n2. 抓取昨日账单\n3. 导出 Excel";
const ORIGINAL = "重新出发一下11.4日的监控";

/** Dispatch a chat message the way manager.tryDispatchToWorker would, then
 *  hand the escape phrase to the REAL handle() flow. */
async function dispatchAndEscape({ status = "queued", sender = "u1", extra = {} } = {}) {
	const { manager, store, sends, plans, fired } = makeManager({ sender });
	// Dispatch through the REAL path — the item must come from
	// tryDispatchToWorker itself (title/goal/origin exactly as shipped).
	const ack = await manager.tryDispatchToWorker(
		{ conversationId: CONV, text: ORIGINAL, actor: { senderId: "u1", channel: "dingtalk", chatType: "group" } },
		PLAN,
	);
	const item = store.list()[0];
	assert.ok(item, "dispatch must have created the work item");
	assert.equal(item.origin, "chat", "Router dispatch must stamp the STRUCTURED origin — the note alone is forgeable (2026-11-05)");
	// Transition the DISPATCHED item (setStatus rejects "working"; claim is the
	// real transition a WorkService window uses).
	if (status === "scheduled") store.setStatus(item.id, "scheduled", null, Date.now() + 60_000, "tengine 慢，下个窗口重试");
	if (status === "working") store.claim(item.id, Date.now());
	const reply = await manager.makeIO().handle(
		{ conversationId: CONV, text: "前台执行", actor: { senderId: sender, channel: "dingtalk", chatType: "group" } },
		undefined,
	);
	return { ack, reply, item, store, sends, plans, fired, ...extra };
}

test("escape converts a QUEUED chat-dispatched item: cancelled, original instruction re-runs inline", async () => {
	const { ack, reply, item, store, sends, plans, fired } = await dispatchAndEscape();
	assert.ok(ack, "dispatch must have ACKed");
	assert.match(ack, /前台执行/, "the ACK must advertise the escape hatch");
	assert.equal(store.get(item.id).status, "cancelled", "the item must be cancelled");
	assert.equal(sends.length, 1, "exactly one inline turn");
	assert.equal(sends[0], ORIGINAL, "the ORIGINAL instruction (from the goal) must re-run, not the phrase");
	assert.match(reply, /前台完成/, "the inline reply must come back to the chat");
	assert.equal(plans.length, 0, "plan-ahead must be skipped for an escaped re-run");
	assert.equal(fired.length, 1, "no NEW work item may be created (no re-dispatch)");
	const items = store.list();
	assert.equal(items.length, 1, "still exactly one item — the escape must not create a second");
});

test("escape converts a SCHEDULED item too (first window ended with a next check)", async () => {
	const { reply, item, store, sends } = await dispatchAndEscape({ status: "scheduled" });
	assert.equal(store.get(item.id).status, "cancelled");
	assert.equal(sends[0], ORIGINAL);
	assert.match(reply, /前台完成/);
});

test("escape is CREATOR-ONLY: another sender in the same group gets a notice, item untouched", async () => {
	const { reply, item, store, sends } = await dispatchAndEscape({ sender: "u2" });
	assert.equal(store.get(item.id).status, "queued", "someone else's item must NOT be cancelled");
	assert.match(reply, /由你本人转派/, "the notice must say why");
	assert.equal(sends.length, 0, "no model turn for the notice");
});

test("a WORKING item is refused honestly (a foreground rerun would double-execute)", async () => {
	const { reply, item, store } = await dispatchAndEscape({ status: "working" });
	assert.equal(store.get(item.id).status, "working", "working items must not be converted");
	assert.match(reply, /正在执行中|控制台取消/, "the refusal must say what to do instead");
});

test("the escape phrase with NOTHING convertible gets an honest notice, not a model turn", async () => {
	const { manager, sends } = makeManager();
	const reply = await manager.makeIO().handle(
		{ conversationId: CONV, text: "前台执行", actor: { senderId: "u1", channel: "dingtalk", chatType: "single" } },
		undefined,
	);
	assert.match(reply, /没有可切换/);
	assert.equal(sends.length, 0, "the notice is deterministic — no engine.send");
});

test("a row claiming chat in its NOTE but marked injected is NOT convertible — structured origin wins", async () => {
	const { manager, store, sends } = makeManager();
	const item = store.create({
		title: "t", goal: `${PLAN}\n\n[用户原始指令]\n${ORIGINAL}`,
		originConversation: CONV, originNote: "从聊天转派（Router）", origin: "injected",
		status: "queued", createdBy: "u1", createdChannel: "dingtalk", priority: 0,
	});
	const reply = await manager.makeIO().handle(
		{ conversationId: CONV, text: "前台执行", actor: { senderId: "u1", channel: "dingtalk", chatType: "group" } },
		undefined,
	);
	assert.equal(store.get(item.id).status, "queued", "an injected row must not be escaped however its note reads");
	assert.match(reply, /没有可切换/, "the refusal is honest — nothing convertible");
	assert.equal(sends.length, 0);
});

test("a sentence CONTAINING the words is ordinary text — it goes to the model, not the hatch", async () => {
	const { manager, store, sends } = makeManager();
	const item = store.create({
		title: "t", goal: `${PLAN}\n\n[用户原始指令]\n${ORIGINAL}`,
		originConversation: CONV, originNote: "从聊天转派（Router）", status: "queued",
		createdBy: "u1", createdChannel: "dingtalk", priority: 0,
	});
	const reply = await manager.makeIO().handle(
		{ conversationId: CONV, text: "帮我前台执行一下再导出", actor: { senderId: "u1", channel: "dingtalk", chatType: "group" } },
		undefined,
	);
	// The phrase did NOT trigger the hatch: the earlier item stays queued.
	assert.equal(store.get(item.id).status, "queued", "a non-escape sentence must not cancel anything");
	// Architecture 2026-11-06 (route-by-default): this sentence is a TASK
	// ("…再导出"), so the Router routes it to a Worker instead of executing it.
	// The contract this test guards is "the escape hatch did not fire", which
	// both paths satisfy — inline (old) or dispatched (new).
	assert.ok(sends.length === 1 || /已转后台执行/.test(reply), "either inline or routed — never the hatch");
});
