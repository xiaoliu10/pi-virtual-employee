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
const { triageMessage, countPlanSteps, isQuestion, hasLongRunningVerb, isForegroundEscape, FOREGROUND_ESCAPE_HINT, isDeepTask, isBareContextToken, looksLikeInputRequest } = await import(pathToFileURL(bundle).href);

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

test("no plan → still ROUTED (architecture: the Router does not execute tasks)", () => {
	const d = triageMessage({ text: "登录 spay 抓取昨日账单并导出 Excel", plan: undefined, looksLikeTask: true }, true);
	assert.equal(d.dispatch, true, "a task-shaped message routes even without a plan — the Worker plans for itself");
});

test("a single-step plan still ROUTES (shape decides, not step count)", () => {
	const d = triageMessage({ text: "导出昨天的报表", plan: PLAN1, looksLikeTask: true }, true);
	assert.equal(d.dispatch, true, "routing is by SHAPE (task vs question), never by estimated effort");
});

test("a task without a long-running verb still ROUTES", () => {
	const plan = `1. 看一下当前配置\n2. 告诉我端口号`;
	const d = triageMessage({ text: "看一下当前配置然后告诉我端口号", plan, looksLikeTask: true }, true);
	assert.equal(d.dispatch, true, "verb length is not a routing criterion any more");
});

test("a QUESTION about a long-running thing stays inline", () => {
	// 「监控脚本还在跑吗」 must not become a background task.
	const d = triageMessage({ text: "监控脚本还在跑吗？", plan: PLAN3, looksLikeTask: true }, true);
	assert.equal(d.dispatch, false);
	assert.equal(d.reason, "question");
});

test("the real dispatch case: a clear multi-step task routes", () => {
	const d = triageMessage({ text: "登录 spay 系统抓取昨日账单，然后导出 Excel 发我", plan: PLAN3, looksLikeTask: true }, true);
	assert.equal(d.dispatch, true);
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

// ── field 2026-11-09: 「继续 登录生产后台管理」 died as foreground narration ──
// 登录 was a task verb (task-planner looksLikeTask) but missing from the
// long-running vocabulary. The added verbs are all multi-character forms (the
// 盯/爬 lesson) and must not weaken the question / short-chat exemptions.

test("hasLongRunningVerb recognises the login/verification vocabulary (field 2026-11-09)", () => {
	for (const t of ["登录生产后台", "登陆系统", "检查当前环境", "验证登录状态", "打开管理端", "访问控制台", "上传附件", "同步数据", "重启服务"]) {
		assert.equal(hasLongRunningVerb(t), true, `should look long-running: ${t}`);
	}
});

test("login-shaped task messages route with a ≥2-step plan (field dispatch case)", () => {
	// The exact field message, task-shaped with the side pass's plan.
	const d = triageMessage({ text: "继续 登录生产后台管理", plan: PLAN3, looksLikeTask: true }, true);
	assert.equal(d.dispatch, true, "the field message must route, not stay foreground");
	for (const text of ["登录 spay 后台，然后检查环境并验证登录状态", "重启网关服务，再检查健康状态"]) {
		const decision = triageMessage({ text, plan: PLAN3, looksLikeTask: true }, true);
		assert.equal(decision.dispatch, true, `must route: ${text}`);
	}
});

test("the new verbs never override the question / short-utterance exemptions", () => {
	// Question shapes carrying a new verb stay inline.
	for (const text of ["登录入口在哪", "重启了吗", "验证是什么意思", "怎么上传？"]) {
		const d = triageMessage({ text, plan: PLAN3, looksLikeTask: true }, true);
		assert.equal(d.dispatch, false, `question must stay inline: ${text}`);
		assert.equal(d.reason, "question");
	}
	// isQuestion's short exemption keys off TASK_VERB_HINT, not this verb list:
	// a bare new verb + 一下 with no hint stays chat, exactly as before.
	for (const text of ["验证一下", "同步一下", "打开一下"]) {
		assert.equal(isQuestion(text), true, `short utterance stays chat: ${text}`);
		const d = triageMessage({ text, plan: PLAN3, looksLikeTask: true }, true);
		assert.equal(d.dispatch, false);
		assert.equal(d.reason, "question");
	}
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

test("follow-up FIRST: a bare question routes into the RUNNING worker, not the inline session (field 2026-11-07)", async () => {
	const managerBundle = join(outDir, "mgr2.mjs");
	await build({
		stdin: {
			contents: `
				export { IMAdapterManager } from "./src/im/manager.ts";
				export { WorkerTaskStore } from "./src/router/worker-tasks.ts";
				export { WorkerService } from "./src/router/worker-service.ts";
			`,
			resolveDir: root, loader: "ts",
		},
		outfile: managerBundle, bundle: true, platform: "node", format: "esm",
		packages: "external", logLevel: "silent",
	});
	const { IMAdapterManager, WorkerTaskStore, WorkerService } = await import(pathToFileURL(managerBundle).href + `?t=${Date.now()}`);
	const db = new DatabaseSync(":memory:");
	WorkerTaskStore.migrate(db);
	const store = new WorkerTaskStore(db);
	const sends = [];
	const service = new WorkerService(store, {
		open: async (cid) => ({ cid }),
		send: async (_s, message) => { sends.push(message); return { reply: "收到验证码 123456，正在写入" }; },
		push: async () => {},
		clock: { now: () => Date.now(), setTimeout: () => {} },
	});
	const engine = {
		workerBridge: {
			spawn: (spec) => service.spawn(spec),
			inject: (cid, message, senderId) => service.inject(cid, message, senderId),
			cancelForEscape: (cid, senderId, note) => service.cancelForEscape(cid, senderId, note),
		},
	};
	const config = {
		all: () => ({
			general: {},
			security: { adminStaffIds: ["u1"], ownerStaffIds: [], people: [], defaultRole: "viewer" },
			capabilities: {},
		}),
	};
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, { engine: { value: engine }, config: { value: config } });

	const ack1 = await manager.tryDispatchToWorker(
		{ conversationId: "dt:g1", text: "跑一下平阳数币今日金额监控", actor: { senderId: "u1", channel: "dingtalk", chatType: "group" } },
		undefined,
	);
	assert.equal(ack1, "");
	service.start();
	await new Promise((r) => setTimeout(r, 30));

	const ack2 = await manager.tryDispatchToWorker(
		{ conversationId: "dt:g1", text: "我没收到验证码，是不是没触发发送", actor: { senderId: "u1", channel: "dingtalk", chatType: "group" } },
		undefined,
	);
	assert.equal(ack2, "", "the follow-up is absorbed by the worker; the Router stays silent");
	assert.equal(sends.length, 2, "the question reached the worker session as a new turn");
	assert.match(sends[1], /没触发发送/, "the user's actual wording arrives in the worker session");
});

for (const chatDispatch of [undefined, {}, { enabled: true }]) {
test(`dispatch WIRING: spawns a worker with flag ${JSON.stringify(chatDispatch)}`, async () => {
	const managerBundle = join(outDir, "mgr.mjs");
	await build({
		stdin: {
			contents: `
				export { IMAdapterManager } from "./src/im/manager.ts";
				export { WorkerTaskStore } from "./src/router/worker-tasks.ts";
				export { WorkerService } from "./src/router/worker-service.ts";
			`,
			resolveDir: root, loader: "ts",
		},
		outfile: managerBundle, bundle: true, platform: "node", format: "esm",
		packages: "external", logLevel: "silent",
	});
	const { IMAdapterManager, WorkerTaskStore, WorkerService } = await import(pathToFileURL(managerBundle).href + `?t=${Date.now()}`);
	const db = new DatabaseSync(":memory:");
	WorkerTaskStore.migrate(db);
	const store = new WorkerTaskStore(db);
	const pushes = [];
	const service = new WorkerService(store, {
		open: async (cid) => ({ cid }),
		send: async () => ({ reply: "完成" }),
		push: async (cid, text) => { pushes.push({ cid, text }); },
		clock: { now: () => Date.now(), setTimeout: () => {} },
	});
	const engine = {
		workerBridge: {
			spawn: (spec) => service.spawn(spec),
			inject: (cid, message, senderId) => service.inject(cid, message, senderId),
			cancelForEscape: (cid, senderId, note) => service.cancelForEscape(cid, senderId, note),
		},
	};
	const config = {
		all: () => ({
			general: { chatDispatch },
			security: { adminStaffIds: ["u1"], ownerStaffIds: [], people: [], defaultRole: "viewer" },
			capabilities: {},
		}),
	};
	const manager = Object.create(IMAdapterManager.prototype);
	Object.defineProperties(manager, { engine: { value: engine }, config: { value: config } });

	const ack = await manager.tryDispatchToWorker(
		{ conversationId: "dt:single:abc", text: "登录 spay 抓取昨日账单，导出 Excel 发我", actor: { senderId: "u1", channel: "dingtalk", chatType: "single" } },
		PLAN3,
	);

	// Router/Worker infrastructure (2026-11-07): dispatch spawns a WORKER —
	// never a work item. Empty string = handed off, stay silent.
	assert.equal(ack, "", "the Router stays silent; the Worker reports by itself");
	const rows = store.listRecent(5);
	assert.equal(rows.length, 1, "exactly one worker must be spawned");
	const row = rows[0];
	assert.equal(row.source_conversation, "dt:single:abc", "results must be pushed back to the origin conversation");
	assert.equal(row.created_by, "u1");
	assert.equal(row.status, "queued", "dispatch must create a queued worker");
	assert.match(row.instruction, /登录 spay/, "the plan must become the worker's instruction");
	assert.match(row.instruction, /用户原始指令/, "the original wording must be preserved");
	// NO admin gate: Worker is dialogue infrastructure — RBAC governs the send
	// path per actor, exactly like an inline turn (2026-11-07).
});

}


// NOTE (review 94189d6f P1 resolution): the production call site (manager.ts)
// passes looksLikeTask:true for the planless dispatch path BY DESIGN (7457cdd
// "Router 只路由"): the not-task gate is intentionally bypassed and
// isQuestion/isSmallTalk are the real gatekeepers. Passing the real detector
// there REGRESSES dispatch for genuine task messages lacking multi-step
// evidence (verified: 「跑一下平阳数币今日金额监控」 stops routing). So these tests
// pin the field message through the shape checks, as production does.
test("the field message routes via the shape checks (production passes looksLikeTask:true)", () => {
	const d = triageMessage({ text: "继续 登录生产后台管理", plan: undefined, looksLikeTask: true }, true);
	assert.equal(d.dispatch, true, "「继续 登录生产后台管理」 is not a question (TASK_VERB_HINT carve-out) and not smalltalk → routed to a Worker");
});

test("a question-shaped short message with a task verb stays foreground (isQuestion)", () => {
	const d = triageMessage({ text: "登录密码是什么", plan: undefined, looksLikeTask: true }, true);
	assert.equal(d.dispatch, false, "Q&A must not be dispatched just because it carries a task verb");
	assert.equal(d.reason, "question");
});

// ─── 2026-11-10: bare context tokens never dispatch (review 7ba60092 P1) ────
// Field: 「875055」/「0002026110800003400」 reached a context-less worker (injected
// into a DONE one, or spawned as a fresh one) that guessed and asked 「这是什么
// 类型的编号？」. The manager's planless dispatch calls triageMessage with
// looksLikeTask hardcoded TRUE — the guard must fire at exactly this seam,
// otherwise the inject-gate fall-through loops back into a new worker.
test("bare context tokens stay inline at the manager's decision seam", () => {
	for (const t of ["875055", "0002026110800003400", "ORDER-2026-11-10-0001",
		"550e8400-e29b-41d4-a716-446655440000", "875055。", " 004966 ", "A" + "9".repeat(63)]) {
		const d = triageMessage({ text: t, plan: undefined, looksLikeTask: true }, true);
		assert.equal(d.dispatch, false, `bare token must stay inline: ${t}`);
	}
	assert.equal(triageMessage({ text: "0002026110800003400", plan: undefined, looksLikeTask: true }, true).reason,
		"reference", "long bare token routes as reference, not task");
});

test("isBareContextToken: cap boundary + CJK exclusion", () => {
	// ≤64 chars is a token, 65+ is not (documents the arbitrary cap).
	assert.equal(isBareContextToken("9".repeat(64)), true);
	assert.equal(isBareContextToken("9".repeat(65)), false);
	// CJK text is never a bare token — continuation words and mixed sentences
	// keep their existing routes.
	for (const t of ["重新执行", "继续", "结果呢", "查一下这笔流水 004966"]) {
		assert.equal(isBareContextToken(t), false, `CJK text is not a bare token: ${t}`);
	}
});

test("looksLikeInputRequest: explicit tail asks match (the spay field shape + variants)", () => {
	// The exact field message (2026-11-10, spay group) — ask sits in the tail.
	const field = "是的，如果是 spay 系统登录流程走到的验证码环节，那确实是我（或后台任务）触发登录时系统发到你手机的。你刚收到的是哪条？如果是 spay 生产环境的短信验证码，发给我（6位数字），我立刻用它完成登录继续跑。";
	assert.equal(looksLikeInputRequest(field), true, "发给我（6位数字） in the tail must match");
	assert.equal(looksLikeInputRequest("详情页打不开，请提供订单号，我继续查。"), true);
	assert.equal(looksLikeInputRequest("收到验证码后我再继续。"), true);
	assert.equal(looksLikeInputRequest("核对无误，请把回执发给我即可结束。"), true);
});

test("looksLikeInputRequest: real completion/error reports NEVER match (review 20886054 P1-1 probes)", () => {
	// Every line below is a normal report shape that full-text matching used to
	// catch via an incidental substring — the silent re-entry of the 2026-11-08
	// bare-token incident.
	assert.equal(looksLikeInputRequest("任务失败：登录页一直提示请输入验证码，重试三次后放弃。"), false, "quoted UI prompt (提示请输入)");
	assert.equal(looksLikeInputRequest("查完了：系统告诉我该订单已于昨日退款。"), false, "转述来源（告诉我）");
	assert.equal(looksLikeInputRequest("导出完成：共 37 笔，其中 6 位数字的旧单号已全部标注。"), false, "\d位数字 in a report");
	assert.equal(looksLikeInputRequest("已修复。之后如再遇到需要你授权的操作，我会先问你。"), false, "需要你 in a completion note");
	assert.equal(looksLikeInputRequest("收到数据后我立刻做了三重比对，无差异。"), false, "past-tense 收到…后我…");
	assert.equal(looksLikeInputRequest("报表已生成，请把文件转发给财务组即可。"), false, "outbound 转发给…, not an input ask");
});

test("looksLikeInputRequest: tail-anchored — ask survives in long reports, mid-text asks do not capture", () => {
	// P2-1: a long report (>2000 chars) whose LAST sentence asks must still match.
	const pad = "报表明细：" + "甲乙丙丁戊己庚辛壬癸".repeat(250) + "。";
	assert.ok(pad.length > 2000);
	assert.equal(looksLikeInputRequest(pad + "下一步需要登录复核，请把手机收到的验证码发给我。"), true, "tail ask in a long report");
	// A mid-report ask followed by a long completion tail does NOT capture.
	assert.equal(looksLikeInputRequest("中途请提供工号核验。" + pad + "全部完成，报表已生成。"), false, "stale mid-report ask");
});
