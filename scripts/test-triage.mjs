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
import { DatabaseSync } from "node:sqlite";
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
const { triageMessage, countPlanSteps, isQuestion, hasLongRunningVerb, isForegroundEscape, FOREGROUND_ESCAPE_HINT } = await import(pathToFileURL(bundle).href);

const configBundle = join(outDir, "config.mjs");
await build({
	stdin: { contents: 'export { ConfigStore } from "./src/db/config-store.ts";', resolveDir: root, loader: "ts" },
	outfile: configBundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { ConfigStore } = await import(pathToFileURL(configBundle).href);
for (const [label, general, expected] of [
	["fresh install", undefined, true],
	["legacy config without dispatch", { taskPlanning: { enabled: true } }, true],
	["explicit opt-out", { chatDispatch: { enabled: false } }, false],
]) {
	test("config default: " + label, () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			if (general) db.prepare("INSERT INTO config VALUES ('appconfig', ?)").run(JSON.stringify({ general }));
			const config = new ConfigStore(db);
			assert.equal(config.all().general.chatDispatch.enabled, expected);
			assert.equal(new ConfigStore(db).all().general.chatDispatch.enabled, expected, "persists across reload");
		} finally { db.close(); }
	});
}

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
// This drives the real manager method against a contract-based store stub.
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
		get(id) { return rows.find((r) => r.id === id); },
	};
}

for (const chatDispatch of [undefined, {}, { enabled: true }]) {
test(`dispatch WIRING: creates and fires with flag ${JSON.stringify(chatDispatch)}`, async () => {
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
	// config for this path. The stub mimics the REAL contract (work-service.ts:141):
	// only a queued row fires — an unconditional-true stub is exactly how the
	// P0-1 false green survived review.
	const engine = {
		workItems: store,
		workBridge: {
			fireItem: (id) => {
				const row = store.get(id);
				const ok = !!row && row.status === "queued";
				fired.push({ id, ok, status: row?.status });
				return ok;
			},
			push: async () => ({ ok: true }),
		},
	};
	const config = {
		all: () => ({
			general: { chatDispatch },
			// Work windows demand a declared-admin creator (review P1-2) — the
			// dispatching actor must be one, exactly like the admin-tool path.
			security: { adminStaffIds: ["u1"], ownerStaffIds: [], people: [], defaultRole: "viewer" },
			capabilities: {},
		}),
	};
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
	// Review P1-1: the ACK used to promise 「前台执行」/「<id> 进度」//stop — none
	// of which had an inbound handler (the design-doc wording was copied before
	// the mechanisms landed). It now promises ONLY what exists: automatic
	// progress/completion pushes, and admin management from the task list.
	assert.match(ack, /进展与完成会自动推送/);
	// 0.2.193: the escape mechanism EXISTS now (takeForegroundEscape + handle
	// wiring), so the ACK must carry the hint again — promising it was only
	// dishonest while the wording predated the mechanism (review P1-1).
	assert.match(ack, /前台执行/, "the ACK must advertise the now-real escape hatch");
	assert.doesNotMatch(ack, /\/stop/, "/stop targets the chat session, not the work item — still must not be promised");

	const items = store.list();
	assert.equal(items.length, 1, "exactly one work item must be created");
	const item = items[0];
	assert.equal(item.origin_conversation, "dt:single:abc", "results must be pushed back to the origin conversation");
	assert.equal(item.created_by, "u1");
	assert.equal(item.created_channel, "dingtalk");
	// P0-1: fireItem/listDue/claim only accept "queued". Creating the item as
	// "working" made it a permanent orphan while the user held the ACK.
	assert.equal(item.status, "queued", `dispatch must create runnable items: ${item.status}`);
	assert.match(item.goal, /登录 spay/, "the plan must become the worker's task spec");
	assert.match(item.goal, /用户原始指令/, "the original wording must be preserved for the worker");
	assert.deepEqual(fired.map((f) => f.id), [item.id], "the window must be fired immediately");
	assert.equal(fired[0].ok, true, `real fireItem contract must accept it: ${JSON.stringify(fired)}`);
	const shortId = item.id.slice(0, 8);
	assert.ok(ack.includes(shortId), `the ACK must name the item (${shortId}) so the user can follow it: ${ack}`);

});
}

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
	const engine = {
		workItems: store,
		workBridge: {
			fireItem: (id) => { const row = store.get(id); const ok = !!row && row.status === "queued"; fired.push({ id, ok }); return ok; },
			push: async () => ({ ok: true }),
		},
	};
	// Explicit opt-out must still bypass dispatch. The security block is present
	// on purpose: WITHOUT it a run that reached isDeclaredAdmin() would throw on
	// the missing adminStaffIds and the broad catch would return undefined — the
	// test would pass even if the flag guard were deleted (review P2-1, mutation
	// verified: removing `if (!enabled) return undefined` stayed green).
	const config = {
		all: () => ({
			general: { chatDispatch: { enabled: false } },
			security: { adminStaffIds: ["u1"], ownerStaffIds: [], people: [], defaultRole: "viewer" },
			capabilities: {},
		}),
	};
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, {
		engine: { value: engine },
		config: { value: config },
	});
	const ack = await manager.tryDispatchToWorker(
		{ conversationId: "dt:single:abc", text: "登录 spay 抓取昨日账单，导出 Excel 发我", actor: { senderId: "u1", channel: "dingtalk", chatType: "single" } },
		PLAN3,
	);
	assert.equal(ack, undefined, "with the flag explicitly false the caller must run inline");
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
	let createAttempted = false;
	engine.workItems.create = () => { createAttempted = true; throw new Error("db is gone"); };
	const config = { all: () => ({ general: {}, security: { adminStaffIds: ["u"], people: [] }, capabilities: {} }) };
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, { engine: { value: engine }, config: { value: config } });
	const ack = await manager.tryDispatchToWorker(
		{ conversationId: "c", text: "登录 spay 抓取账单导出", actor: { senderId: "u", channel: "dingtalk", chatType: "single" } },
		PLAN3,
	);
	assert.equal(ack, undefined, "a throwing store must degrade to inline execution");
	assert.equal(createAttempted, true, "must reach the failing store rather than fail at an earlier guard");
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
	const ack = await manager.tryDispatchToWorker({ conversationId: "c", text: "部署测试环境并执行完整回归测试", actor: undefined }, PLAN3);
	assert.equal(ack, undefined);
});

test("dispatch WIRING: a NON-ADMIN keeps executing inline (never swallowed)", async () => {
	// Review P1-1 (field 2026-11-04): the non-admin branch used to RETURN the
	// courtesy warning. The caller treats any nonempty result as "dispatched"
	// and returns before engine.send, so a viewer's task was acknowledged in
	// text and then never executed. The branch must return undefined.
	const managerBundle = join(outDir, "mgr5.mjs");
	await build({
		stdin: { contents: `export { IMAdapterManager } from "./src/im/manager.ts";`, resolveDir: root, loader: "ts" },
		outfile: managerBundle, bundle: true, platform: "node", format: "esm",
		packages: "external", logLevel: "silent",
	});
	const { IMAdapterManager } = await import(pathToFileURL(managerBundle).href + `?t=${Date.now()}`);
	const store = makeMemoryStore();
	const engine = {
		workItems: store,
		workBridge: { fireItem: () => true, push: async () => ({ ok: true }) },
	};
	const config = {
		all: () => ({
			general: {}, // absent → default ON, the path that exposes this to legacy installs
			security: { adminStaffIds: ["admin1"], ownerStaffIds: [], people: [], defaultRole: "viewer" },
			capabilities: {},
		}),
	};
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, { engine: { value: engine }, config: { value: config } });
	const ack = await manager.tryDispatchToWorker(
		{ conversationId: "dt:single:abc", text: "登录 spay 系统抓取昨日账单，然后导出 Excel 发我", actor: { senderId: "viewer1", channel: "dingtalk", chatType: "single" } },
		PLAN3,
	);
	assert.equal(ack, undefined, "a viewer must fall through to inline execution, not get an ACK");
	assert.equal(store.list().length, 0, "and no work item may be created for them");
});

test("isForegroundEscape: exact phrase only — sentences containing the words must not hijack", () => {
	for (const ok of ["前台执行", " 前台执行 ", "！前台执行。", "前台执行！", "。前台执行、"]) {
		assert.equal(isForegroundEscape(ok), true, `must match: ${JSON.stringify(ok)}`);
	}
	for (const bad of ["", "前台执行一下", "请前台执行这个任务", "改为前台", "确认授权", "前台", "帮我前台执行一下再导出"]) {
		assert.equal(isForegroundEscape(bad), false, `must NOT match: ${JSON.stringify(bad)}`);
	}
	assert.equal(FOREGROUND_ESCAPE_HINT.includes("前台执行"), true, "hint and matcher must agree on the phrase");
});
