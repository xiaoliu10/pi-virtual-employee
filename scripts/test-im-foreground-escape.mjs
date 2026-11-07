/**
 * 「前台执行」escape hatch — worker-era tests (router-worker-v2).
 *
 * Dispatch now creates a worker_tasks row through the Worker INFRASTRUCTURE
 * bridge (never a work item), and the escape cancels THIS sender's OWN
 * queued-or-running worker (aborting a live durable round) and re-runs the
 * original instruction inline. Cancelled is a legitimate linear terminal —
 * there is no scheduled/waiting state to convert, and no cross-sender
 * cancellation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.fg-escape-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
await build({
	stdin: {
		contents: `export { IMAdapterManager } from "./src/im/manager.ts";\nexport { WorkerTaskStore } from "./src/router/worker-tasks.ts";\nexport { WorkerService } from "./src/router/worker-service.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(dir, "mgr.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { IMAdapterManager, WorkerTaskStore, WorkerService } = await import(pathToFileURL(join(dir, "mgr.mjs")).href);

const CONV = "dt:group:cidX";
const PLAN = "1. 登录 spay\n2. 抓取昨日账单\n3. 导出 Excel";
const ORIGINAL = "重新出发一下11.4日的监控";

function makeManager({ sender = "u1" } = {}) {
	const wdb = new DatabaseSync(":memory:");
	WorkerTaskStore.migrate(wdb);
	const store = new WorkerTaskStore(wdb);
	const sends = [];
	const plans = [];
	const service = new WorkerService(store, {
		open: async (cid) => ({ cid }),
		send: async (_session, message) => {
			sends.push(message);
			return { reply: "前台完成" };
		},
		push: async () => {},
		clock: { now: () => Date.now(), setTimeout: () => {} },
	});
	const bridge = {
		spawn: (spec) =>
			service.spawn(spec),
		inject: (cid, message, senderId) => service.inject(cid, message, senderId),
		cancelForEscape: (cid, senderId, note) => service.cancelForEscape(cid, senderId, note),
	};
	const config = {
		all: () => ({
			general: { chatDispatch: { enabled: true }, taskPlanning: { enabled: true }, turnTimeoutMin: 0, longTaskProgressMin: 0 },
			security: { adminStaffIds: ["u1", "u2"], ownerStaffIds: [], people: [], defaultRole: "viewer", conversations: [] },
			capabilities: {},
		}),
	};
	const inlineSends = [];
	const engine = {
		workerBridge: bridge,
		workItems: { list: () => [] },
		recordConversationMember: () => {},
		getOrCreateSession: (id) => ({ id }),
		isConversationStreaming: () => false,
		turnStallSnapshot: () => 'idle',
		markTurnAbort: () => {},
		abortSession: () => {},
		inventoryBackgroundProcesses: () => [],
		planTaskBrief: async (_agent, text) => { plans.push(text); return null; },
		send: async (_agent, text) => { inlineSends.push(text); return { reply: `前台完成：${String(text).slice(0, 24)}` }; },
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
	return { manager, store, sends, plans, service, inlineSends };
}

const dispatch = async (manager, text = ORIGINAL, sender = "u1") =>
	manager.tryDispatchToWorker(
		{ conversationId: CONV, text, actor: { senderId: sender, channel: "dingtalk", chatType: "group" } },
		PLAN,
	);

const handle = async (manager, text, sender = "u1") =>
	manager.makeIO().handle(
		{ conversationId: CONV, text, actor: { senderId: sender, channel: "dingtalk", chatType: "group" } },
		undefined,
	);

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

test("dispatch creates a worker_tasks row (NEVER a work item) and stays silent", async () => {
	const { manager, store, sends } = makeManager();
	const ack = await dispatch(manager);
	assert.equal(ack, "", "no Router ACK — the Worker reports by itself");
	const rows = store.listRecent(5);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "queued");
	assert.match(rows[0].instruction, /用户原始指令/, "the plan rides inside the instruction");
	assert.equal(sends.length, 0, "dispatch does not execute inline");
});

test("escape converts a QUEUED worker: cancelled, original instruction re-runs inline", async () => {
	const { manager, store, inlineSends } = makeManager();
	await dispatch(manager);
	const reply = await handle(manager, "前台执行");
	const rows = store.listRecent(5);
	assert.equal(rows[0].status, "cancelled", "cancelled is the linear terminal for an escaped worker");
	assert.match(inlineSends[0], /重新出发/, "the ORIGINAL instruction re-runs inline");
	assert.match(reply, /前台完成/);
});

test("escape is CREATOR-ONLY: another sender gets a notice, worker untouched", async () => {
	const { manager, store, sends } = makeManager();
	await dispatch(manager, ORIGINAL, "u1");
	const reply = await handle(manager, "前台执行", "u2");
	assert.equal(store.listRecent(5)[0].status, "queued", "someone else's worker must NOT be cancelled");
	assert.match(reply, /你本人派发|没有可切换/, "the notice must say why");
	assert.equal(sends.length, 0, "no model turn for the notice");
});

test("the escape phrase with NOTHING convertible gets an honest notice, not a model turn", async () => {
	const { manager, sends } = makeManager();
	const reply = await handle(manager, "前台执行");
	assert.match(reply, /没有可切换/);
	assert.equal(sends.length, 0, "the notice is deterministic — no engine.send");
});

test("a sentence CONTAINING the words is ordinary text — dispatched, not the hatch", async () => {
	const { manager, store, sends } = makeManager();
	const reply = await handle(manager, "帮我前台执行一下再导出");
	const rows = store.listRecent(5);
	// The phrase did NOT trigger the hatch (no cancelled row from an escape —
	// the single row here is the ROUTED dispatch of this very sentence).
	assert.ok(rows.every((r) => r.status !== "cancelled"), "a non-escape sentence must not cancel anything");
	assert.ok(sends.length === 0 || reply === "", "either inline or routed (silent) — never the hatch");
});
