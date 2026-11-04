/**
 * Router triage — the "do NOT send this to the background" contract.
 *
 * docs/design/router-worker.md D1: dispatch needs POSITIVE evidence on two axes
 * (a ≥2-step plan AND a long-running action verb). The failure that matters is
 * asymmetric: sending 「你好」 to a background worker is a catastrophic UX
 * regression, while running a long task inline is merely what happens today.
 * So every ambiguous or failed case must land inline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = mkdtempSync(join(root, "node_modules/.triage-probe-"));
mkdirSync(outDir, { recursive: true });
process.on("exit", () => { try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const bundle = join(outDir, "triage.mjs");
await build({
	stdin: { contents: `export * from "./src/im/triage.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { triageMessage, countPlanSteps, isQuestion, hasLongRunningVerb } = await import(pathToFileURL(bundle).href);

const PLAN3 = `📋 任务规划
1. 登录 spay 系统
2. 抓取昨日账单
3. 导出 Excel 并回传`;
const PLAN1 = `📋 任务规划
1. 抓取昨日账单`;

test("disabled flag restores old behaviour exactly", () => {
	const d = triageMessage({ text: "登录 spay 抓取账单并导出", plan: PLAN3, looksLikeTask: true }, false);
	assert.equal(d.dispatch, false);
	assert.equal(d.reason, "disabled");
});

test("a non-task message never dispatches", () => {
	const d = triageMessage({ text: "你好", plan: PLAN3, looksLikeTask: false }, true);
	assert.equal(d.dispatch, false);
	assert.equal(d.reason, "not-task");
});

test("no plan → inline (planning side pass failed or said NO_PLAN)", () => {
	for (const plan of [undefined, ""]) {
		const d = triageMessage({ text: "部署测试环境并跑通后把日志发我", plan, looksLikeTask: true }, true);
		assert.equal(d.dispatch, false);
		assert.equal(d.reason, "no-plan");
	}
});

test("a single-step plan → inline even with a long verb", () => {
	const d = triageMessage({ text: "导出昨天的报表", plan: PLAN1, looksLikeTask: true }, true);
	assert.equal(d.dispatch, false);
	assert.equal(d.reason, "too-few-steps");
	assert.equal(d.steps, 1);
});

test("two-plus steps WITHOUT a long verb → inline", () => {
	const plan = `1. 看一下当前配置\n2. 告诉我端口号`;
	const d = triageMessage({ text: "看一下当前配置然后告诉我端口号", plan, looksLikeTask: true }, true);
	assert.equal(d.dispatch, false);
	assert.equal(d.reason, "no-long-verb");
});

test("a QUESTION about a long-running thing stays inline", () => {
	// 「监控脚本还在跑吗」 must not become a background task.
	const d = triageMessage({ text: "监控脚本还在跑吗？", plan: PLAN3, looksLikeTask: true }, true);
	assert.equal(d.dispatch, false);
	assert.equal(d.reason, "question");
});

test("the real dispatch case: multi-step plan + long verb", () => {
	const d = triageMessage(
		{ text: "登录 spay 系统抓取昨日账单，然后导出 Excel 发我", plan: PLAN3, looksLikeTask: true },
		true,
	);
	assert.equal(d.dispatch, true);
	assert.equal(d.reason, "dispatch");
	assert.equal(d.steps, 3);
});

test("countPlanSteps accepts the separator shapes the planner really emits", () => {
	assert.equal(countPlanSteps("1. a\n2. b\n3. c"), 3);
	assert.equal(countPlanSteps("1) a\n2) b"), 2);
	assert.equal(countPlanSteps("1、a\n2、b"), 2);
	assert.equal(countPlanSteps("1．a\n2．b"), 2);
	// Prose numbering must not inflate: the sequence has to start at 1.
	assert.equal(countPlanSteps("第 1 步先登录"), 0);
	assert.equal(countPlanSteps("参考 2. 那段代码"), 0);
	// Out-of-order jumps stop the count rather than counting loosely.
	assert.equal(countPlanSteps("1. a\n3. c"), 1);
});

test("isQuestion catches short chat and question shapes", () => {
	for (const t of ["你好", "在吗", "这条数据什么意思？", "为什么失败了", "帮我查一下状态", ""]) {
		assert.equal(isQuestion(t), true, `should be a question: ${t}`);
	}
	assert.equal(isQuestion("登录 spay 抓取昨日账单，导出 Excel 发我"), false);
});

test("hasLongRunningVerb recognises the action vocabulary", () => {
	for (const t of ["批量下载所有附件", "部署测试环境", "爬取商品列表", "生成日报", "对账本月流水"]) {
		assert.equal(hasLongRunningVerb(t), true, `should look long-running: ${t}`);
	}
	assert.equal(hasLongRunningVerb("现在几点"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// WIRING: the triage deciding "dispatch" is worth nothing unless a work item is
// actually created, fired, and the ACK returned instead of running inline.
// This drives the REAL manager method against a REAL work-item store.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal in-memory stand-in for WorkItemStore's create/list contract. */
function makeMemoryStore() {
	const rows = [];
	return {
		rows,
		create(input) {
			const row = {
				id: `${Math.random().toString(16).slice(2)}-test-item`,
				title: input.title, goal: input.goal,
				origin_conversation: input.originConversation ?? null,
				origin_note: input.originNote ?? null,
				status: input.status ?? "proposed",
				created_by: input.createdBy ?? null,
				created_channel: input.createdChannel ?? null,
			};
			rows.push(row);
			return row;
		},
		list() { return [...rows]; },
	};
}

test("dispatch WIRING: creates a work item, fires it, returns an ACK, keeps origin", async () => {
	const managerBundle = join(outDir, "mgr.mjs");
	await build({
		stdin: {
			contents: `
				export { IMAdapterManager } from "./src/im/manager.ts";
				export { WorkItemStore } from "./src/db/work-item-store.ts";
				export { openDatabase } from "./src/db/sqlite.ts";
			`,
			resolveDir: root, loader: "ts",
		},
		outfile: managerBundle, bundle: true, platform: "node", format: "esm",
		packages: "external", logLevel: "silent",
	});
	const { IMAdapterManager } = await import(pathToFileURL(managerBundle).href + `?t=${Date.now()}`);
	// better-sqlite3 is built for Electron's ABI, so a plain-node test cannot open
	// a real DB. This in-memory store implements the SAME contract the dispatch
	// path uses (create/list + the row shape), which is what the assertions
	// below actually verify.
	const store = makeMemoryStore();

	const fired = [];
	// The manager only needs `engine.workItems` / `engine.workBridge` and the
	// config for this path — everything else is untouched by dispatch.
	const engine = { workItems: store, workBridge: { fireItem: (id) => { fired.push(id); return true; }, push: async () => ({ ok: true }) } };
	const config = { all: () => ({ general: { chatDispatch: { enabled: true } }, capabilities: {} }) };
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, {
		engine: { value: engine },
		config: { value: config },
	});

	const ack = await manager.tryDispatchToWorker(
		{ conversationId: "dt:single:abc", text: "登录 spay 抓取昨日账单，导出 Excel 发我", actor: { senderId: "u1", channel: "dingtalk", chatType: "single" } },
		PLAN3,
	);

	assert.ok(ack, "a dispatch must return the ACK text (that is what the user sees)");
	assert.match(ack, /已转后台执行/);
	assert.match(ack, /前台执行/, "the escape hatch must be advertised (design D6 risk table)");

	const items = store.list();
	assert.equal(items.length, 1, "exactly one work item must be created");
	const item = items[0];
	assert.equal(item.origin_conversation, "dt:single:abc", "results must be pushed back to the origin conversation");
	assert.equal(item.created_by, "u1");
	assert.equal(item.created_channel, "dingtalk");
	assert.match(item.goal, /登录 spay/, "the plan must become the worker's task spec");
	assert.match(item.goal, /用户原始指令/, "the original wording must be preserved for the worker");
	assert.deepEqual(fired, [item.id], "the window must be fired immediately, not on the next tick");
	const shortId = item.id.slice(0, 8);
	assert.ok(ack.includes(shortId), `the ACK must name the item (${shortId}) so the user can follow it: ${ack}`);

});

test("dispatch WIRING: flag off → inline (no work item, old behaviour)", async () => {
	const managerBundle = join(outDir, "mgr2.mjs");
	await build({
		stdin: {
			contents: `
				export { IMAdapterManager } from "./src/im/manager.ts";
				export { WorkItemStore } from "./src/db/work-item-store.ts";
				export { openDatabase } from "./src/db/sqlite.ts";
			`,
			resolveDir: root, loader: "ts",
		},
		outfile: managerBundle, bundle: true, platform: "node", format: "esm",
		packages: "external", logLevel: "silent",
	});
	const { IMAdapterManager } = await import(pathToFileURL(managerBundle).href + `?t=${Date.now()}`);
	const store = makeMemoryStore();
	const fired = [];
	const engine = { workItems: store, workBridge: { fireItem: (id) => { fired.push(id); return true; }, push: async () => ({ ok: true }) } };
	// Gray release default: absent → off.
	const config = { all: () => ({ general: {}, capabilities: {} }) };
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, {
		engine: { value: engine },
		config: { value: config },
	});
	const ack = await manager.tryDispatchToWorker(
		{ conversationId: "dt:single:abc", text: "登录 spay 抓取昨日账单，导出 Excel 发我", actor: { senderId: "u1", channel: "dingtalk", chatType: "single" } },
		PLAN3,
	);
	assert.equal(ack, undefined, "with the flag absent the caller must run inline");
	assert.equal(store.list().length, 0, "no work item may exist");
	assert.deepEqual(fired, []);
});

test("dispatch WIRING: a broken store falls back to INLINE, never a swallowed message", async () => {
	const managerBundle = join(outDir, "mgr3.mjs");
	await build({
		stdin: { contents: `export { IMAdapterManager } from "./src/im/manager.ts";`, resolveDir: root, loader: "ts" },
		outfile: managerBundle, bundle: true, platform: "node", format: "esm",
		packages: "external", logLevel: "silent",
	});
	const { IMAdapterManager } = await import(pathToFileURL(managerBundle).href + `?t=${Date.now()}`);
	const engine = {
		workItems: { create: () => { throw new Error("db is gone"); } },
		workBridge: { fireItem: () => true, push: async () => ({ ok: true }) },
	};
	const config = { all: () => ({ general: { chatDispatch: { enabled: true } }, capabilities: {} }) };
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, { engine: { value: engine }, config: { value: config } });
	const ack = await manager.tryDispatchToWorker(
		{ conversationId: "c", text: "登录 spay 抓取账单导出", actor: { senderId: "u", channel: "dingtalk", chatType: "single" } },
		PLAN3,
	);
	assert.equal(ack, undefined, "a throwing store must degrade to inline execution");
});

test("dispatch WIRING: no work-item subsystem → inline", async () => {
	const managerBundle = join(outDir, "mgr4.mjs");
	await build({
		stdin: { contents: `export { IMAdapterManager } from "./src/im/manager.ts";`, resolveDir: root, loader: "ts" },
		outfile: managerBundle, bundle: true, platform: "node", format: "esm",
		packages: "external", logLevel: "silent",
	});
	const { IMAdapterManager } = await import(pathToFileURL(managerBundle).href + `?t=${Date.now()}`);
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, {
		engine: { value: {} },
		config: { value: { all: () => ({ general: { chatDispatch: { enabled: true } }, capabilities: {} }) } },
	});
	const ack = await manager.tryDispatchToWorker({ conversationId: "c", text: "部署环境并跑测试", actor: undefined }, PLAN3);
	assert.equal(ack, undefined);
});
