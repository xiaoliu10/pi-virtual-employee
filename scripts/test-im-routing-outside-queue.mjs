/**
 * Routing OUTSIDE the per-conversation queue (user ruling 2026-11-12: 「一起修」).
 *
 * Before: EVERYTHING ran inside `serialize(cid, …)` — so while an inline turn
 * occupied the chat (a foreground escape re-run, a question the triage kept,
 * dispatch disabled), the NEXT message could not even be triaged. A new task
 * waited hours for the inline turn to finish instead of dispatching to a
 * parallel worker.
 *
 * After: gates + plan + triage/dispatch run OUTSIDE the queue; only the inline
 * execution stays serialized (the kernel refuses concurrent prompts on the
 * same conversation's Agent).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.routing-oq-test-"));
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

const CONV = "dt:single:u1";
const PLAN = "1. 登录数币平台\n2. 查询平阳今日金额\n3. 汇总回报";
// MUST stay inline: triage keeps questions/smalltalk in the Router, and the
// planless dispatch path passes looksLikeTask:true — only isQuestion/isSmallTalk
// keep a message in the chat. This is the occupant that used to block triage.
const LONG_INLINE = "在吗？还在处理吗？";
// MUST dispatch: names an external system (sls) — an EXTERNAL_SYSTEM_MARKER deep
// task — and opens with an action verb, so no question marker keeps it inline.
// (「帮我查一下…」 deliberately stays a Router question — existing triage.)
const NEW_TASK = "排查 sls 里平阳今天的数币交易流水，导出明细";

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function makeManager() {
	const wdb = new DatabaseSync(":memory:");
	WorkerTaskStore.migrate(wdb);
	const store = new WorkerTaskStore(wdb);
	const service = new WorkerService(store, {
		open: async (cid) => ({ cid }),
		send: async () => ({ reply: "数币查好了" }),
		push: async () => {},
		clock: { now: () => Date.now(), setTimeout: () => {} },
	});
	const bridge = {
		spawn: (spec) => service.spawn(spec),
		inject: (cid, message, senderId) => service.inject(cid, message, senderId),
	};
	const config = {
		all: () => ({
			general: { chatDispatch: { enabled: true }, taskPlanning: { enabled: true }, turnTimeoutMin: 0, longTaskProgressMin: 0 },
			security: { adminStaffIds: ["u1"], ownerStaffIds: [], people: [], defaultRole: "admin", conversations: [] },
			capabilities: {},
		}),
	};
	const inlineSends = [];
	let releaseInline;
	const inlineStarted = new Promise((r) => { releaseInline = r; });
	let releaseInlineNow;
	const inlineGate = new Promise((r) => { releaseInlineNow = r; });
	const engine = {
		workerBridge: bridge,
		workItems: { list: () => [] },
		recordConversationMember: () => {},
		getOrCreateSession: (id) => ({ id }),
		isConversationStreaming: () => false,
		turnStallSnapshot: () => "idle",
		markTurnAbort: () => {},
		abortSession: () => {},
		inventoryBackgroundProcesses: () => [],
		planTaskBrief: async (_agent, text) =>
			text.includes("数币") ? { chatText: "计划：查平阳数币", turnContext: PLAN } : null,
		send: async (_agent, text) => {
			inlineSends.push(text);
			releaseInline();
			await inlineGate; // the inline turn occupies the chat until the test releases it
			return { reply: `前台完成：${String(text).slice(0, 24)}` };
		},
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
	return { manager, store, service, inlineSends, releaseInlineNow: () => releaseInlineNow(), waitInlineStarted: () => inlineStarted };
}

const handle = (manager, text) =>
	manager.makeIO().handle({ conversationId: CONV, text, actor: { senderId: "u1", channel: "dingtalk", chatType: "single" } }, undefined);

test("a new task dispatches to a parallel worker while an inline turn occupies the chat", async () => {
	const { manager, store, inlineSends, releaseInlineNow, waitInlineStarted } = makeManager();
	const first = handle(manager, LONG_INLINE); // question → triage keeps it inline; the send hangs
	await Promise.race([
		waitInlineStarted(),
		new Promise((_, rej) => setTimeout(() => rej(new Error("inline turn never started — the occupant was dispatched, not kept inline")), 3000)),
	]);
	try {
		assert.equal(inlineSends.length, 1, "the inline turn is running");

		// THE REGRESSION: this used to wait behind the hanging inline turn before
		// even reaching triage. Now routing happens outside the queue.
		const second = await Promise.race([
			handle(manager, NEW_TASK),
			new Promise((_, rej) => setTimeout(() => rej(new Error("routing blocked: the new task did not resolve while the inline turn hangs")), 3000)),
		]);
		assert.equal(second, "", "dispatched silently (worker owns signalling)");
		const rows = store.listRecent(5);
		assert.equal(rows.length, 1, "exactly one worker row — the new task, not the inline turn");
		assert.equal(rows[0].status, "queued", "a parallel worker was spawned for the new task");
		assert.equal(inlineSends.length, 1, "the new task did NOT wait to run inline");

		releaseInlineNow();
		const firstReply = await first;
		assert.match(firstReply, /前台完成/, "the inline turn still completes and answers");
		await flush();
	} finally {
		releaseInlineNow();
		await flush();
	}
});

test("a plain question during an inline turn still queues inline (FIFO) — documented boundary", async () => {
	const { manager, inlineSends, releaseInlineNow, waitInlineStarted } = makeManager();
	const first = handle(manager, LONG_INLINE);
	await Promise.race([
		waitInlineStarted(),
		new Promise((_, rej) => setTimeout(() => rej(new Error("inline turn never started — the occupant was dispatched, not kept inline")), 3000)),
	]);
	try {
		const question = handle(manager, "在吗");
		await flush();
		assert.equal(inlineSends.length, 1, "the question must not run concurrently on the same Agent");
		releaseInlineNow();
		const [, r2] = await Promise.all([first, question]);
		assert.match(r2, /前台完成/, "the queued question answers after the inline turn settles");
	} finally {
		releaseInlineNow();
		await flush();
	}
});
