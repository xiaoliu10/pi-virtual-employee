/** Work tool security/queue contract tests; no native DB, IM, or executor. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.work-tools-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "work-tools.mjs");
await build({
	stdin: { contents: 'export { createWorkTools } from "./src/engine/tools/work.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { createWorkTools } = await import(pathToFileURL(bundle).href);

const GROUP = "dt:group:source";
const SINGLE = "dt:admin";
const ID = "a1234567-1111-2222-3333-444444444444";
const actor = (overrides = {}) => ({ senderId: "admin", channel: "dingtalk", chatType: "group", text: "确认继续", ...overrides });
const row = (overrides = {}) => ({
	id: ID,
	title: "来源任务",
	goal: "完整目标\n逐笔核对订单并汇报异常",
	conditions: "08:00-09:30 不可手动对账",
	progress: "已核对 60%",
	lessons: JSON.stringify(["登录态失效需重新登录", "对账在第三个标签"]),
	origin_conversation: GROUP,
	origin_note: "来源证据",
	status: "proposed",
	question: null,
	next_check_at: null,
	created_by: null,
	answer: null,
	created_at: 1000,
	updated_at: 2000,
	...overrides,
});

function fixture(opts = {}) {
	const conversationId = opts.conversationId ?? GROUP;
	let liveActor = Object.hasOwn(opts, "actor") ? opts.actor : actor();
	const security = {
		adminStaffIds: ["admin"],
		defaultRole: "viewer",
		people: [],
		...opts.security,
	};
	const rows = new Map((opts.rows ?? [row({ origin_conversation: conversationId })]).map((item) => [item.id, { ...item }]));
	const writes = [];
	const events = [];
	const fired = [];
	const cancelled = [];
	const mined = [];
	const store = {
		get: (id) => rows.get(id),
		list: () => [...rows.values()],
		confirm(id, createdBy) {
			writes.push(["confirm", id, createdBy]);
			events.push("confirm");
			if (opts.failConfirm) return undefined;
			const item = rows.get(id);
			if (!item || item.status !== "proposed") return undefined;
			Object.assign(item, { status: "queued", created_by: createdBy });
			return item;
		},
		resume(id, answer) {
			writes.push(["resume", id, answer]);
			events.push("resume");
			if (opts.failResume) return undefined;
			const item = rows.get(id);
			if (!item || item.status !== "waiting_human") return undefined;
			Object.assign(item, { status: "queued", answer: answer ?? item.answer, question: null, next_check_at: null });
			return item;
		},
		cancel(id) {
			writes.push(["cancel", id]);
			events.push("cancel");
			const item = rows.get(id);
			if (!item || opts.failCancel) return undefined;
			Object.assign(item, { status: "cancelled", question: null, next_check_at: null });
			return item;
		},
		setField(id, field, content) {
			writes.push([field, id, content]);
			const item = rows.get(id);
			if (!item || item.status === "done" || item.status === "cancelled") return undefined;
			const column = field === "set_conditions" ? "conditions" : field === "set_progress" ? "progress" : field;
			if (!["title", "goal", "conditions", "progress"].includes(column)) return undefined;
			item[column] = content;
			return item;
		},
		setSchedule(id, at, reason) {
			const item = rows.get(id);
			if (!item || !["queued", "waiting_human", "scheduled"].includes(item.status)) return undefined;
			writes.push(["setSchedule", id, at, reason]);
			events.push("setSchedule");
			Object.assign(item, { status: "scheduled", question: null, next_check_at: at });
			if (reason !== undefined) item.next_check_reason = reason;
			return item;
		},
		pause(id, reason) {
			const item = rows.get(id);
			if (!item || !["queued", "scheduled", "working"].includes(item.status)) return undefined;
			writes.push(["pause", id, reason]);
			events.push("pause");
			Object.assign(item, {
				status: "waiting_human",
				question: `管理员暂停：${reason || "管理员主动暂停"}`.slice(0, 500),
				next_check_at: null,
				next_check_reason: null,
			});
			return item;
		},
		addLesson(id, content) {
			writes.push(["add_lesson", id, content]);
			const item = rows.get(id);
			item.lessons = JSON.stringify([...JSON.parse(item.lessons ?? "[]"), content]);
			return item;
		},
	};
	const tools = createWorkTools({
		workItems: store,
		config: { all: () => ({ security }) },
		conversationId,
		resolveActor: (id) => { assert.equal(id, conversationId); return liveActor; },
		fireItem: (id) => {
			events.push("fire");
			fired.push(id);
			assert.equal(rows.get(id).status, "queued", "persist the queue transition BEFORE firing");
			if (opts.onFire) opts.onFire(rows.get(id));
			return opts.fireResult ?? true;
		},
		...(opts.withCancel ? { cancelItem: async (id) => {
			events.push("abort");
			cancelled.push(id);
			const st = rows.get(id)?.status;
			assert.ok(
				st === "cancelled" || (st === "waiting_human" && String(rows.get(id).question ?? "").startsWith("管理员暂停")),
				"persist the durable stop BEFORE aborting",
			);
			if (opts.failAbort) throw new Error("executor unavailable");
		} } : {}),
		mine: async (params) => {
			mined.push(params);
			return opts.mineResult ?? { scanned: 2, proposals: [] };
		},
	});
	return {
		rows, writes, fired, cancelled, events, mined, security,
		setActor: (value) => { liveActor = value; },
		items: (params) => tools.find((tool) => tool.name === "manage_work_items").execute("call", params),
		notebook: (params) => tools.find((tool) => tool.name === "manage_work").execute("call", params),
	};
}

function refused(result, f) {
	assert.equal(result.details.ok, false);
	assert.equal(result.details.refused, true);
	assert.deepEqual(f.writes, [], "refusal must not mutate");
	assert.deepEqual(f.fired, []);
	assert.deepEqual(f.cancelled, []);
	assert.deepEqual(f.mined, []);
}

for (const chatType of ["group", "single"]) {
	test(`${chatType} verified admin confirms a proposal and records confirming identity`, async () => {
		const f = fixture({ conversationId: chatType === "group" ? GROUP : SINGLE, actor: actor({ chatType, text: "确认创建" }) });
		const result = await f.items({ action: "confirm", id: ID.slice(0, 8) });
		assert.equal(result.details.ok, true);
		assert.equal(result.details.confirmed, true);
		assert.equal(result.details.fired, true);
		assert.equal(f.rows.get(ID).created_by, "admin");
		assert.deepEqual(f.writes, [["confirm", ID, "admin"]]);
		assert.deepEqual(f.events, ["confirm", "fire"]);
	});

	test(`${chatType} admin explicitly resumes with persisted answer even when runner is busy`, async () => {
		const answer = "资源已开通，确认继续；审批凭证 123";
		const f = fixture({
			conversationId: chatType === "group" ? GROUP : SINGLE,
			actor: actor({ chatType }),
			rows: [row({ origin_conversation: chatType === "group" ? GROUP : SINGLE, status: "waiting_human", question: "请开通资源", created_by: "previous-admin" })],
			fireResult: false,
			onFire: (item) => assert.equal(item.answer, answer),
		});
		const result = await f.items({ action: "resume", id: ID.slice(0, 8), answer });
		assert.equal(result.details.ok, true);
		assert.equal(result.details.resumed, true);
		assert.equal(result.details.queued, true);
		assert.equal(result.details.fired, false);
		assert.equal(f.rows.get(ID).status, "queued");
		assert.equal(f.rows.get(ID).answer, answer);
		assert.deepEqual(f.writes, [["resume", ID, answer]]);
		assert.deepEqual(f.events, ["resume", "fire"]);
	});
}

for (const channel of ["feishu", "wecom", "echo"]) {
	test(`${channel} verified source group admin can confirm`, async () => {
		const f = fixture({ conversationId: `${channel}:group:source`, actor: actor({ channel }) });
		assert.equal((await f.items({ action: "confirm", id: ID })).details.ok, true);
	});
}

const invalidActors = [
	["unverified", undefined],
	["scheduler", actor({ channel: "scheduler" })],
	["missing sender", actor({ senderId: "" })],
	["whitespace sender", actor({ senderId: "  " })],
	["missing channel", actor({ channel: undefined })],
	["unknown channel", actor({ channel: "console" })],
	["dt is not the dingtalk adapter name", actor({ channel: "dt" })],
	["channel/source mismatch", actor({ channel: "feishu" })],
	["invalid chat type", actor({ chatType: "unknown" })],
	["viewer creator", actor({ senderId: "creator" })],
	["operator creator", actor({ senderId: "operator" })],
	["revoked admin creator", actor({ senderId: "revoked" })],
];
for (const [label, invalid] of invalidActors) {
	for (const action of ["confirm", "resume", "cancel", "mine"]) {
		test(`${action} refuses ${label} without writes or executor calls`, async () => {
			const f = fixture({
				actor: invalid,
				security: { adminStaffIds: ["admin", "revoked"], people: [{ staffId: "revoked", role: "viewer" }, { staffId: "operator", role: "operator" }] },
				rows: [row({ status: action === "confirm" ? "proposed" : "waiting_human", created_by: invalid?.senderId ?? "admin" })],
			});
			refused(await f.items({ action, id: ID, answer: "不要写入" }), f);
		});
	}
}

for (const [label, invalid] of invalidActors) {
	test(`update/pause refuse ${label} without writes or executor calls`, async () => {
		const f = fixture({
			actor: invalid,
			security: { adminStaffIds: ["admin", "revoked"], people: [{ staffId: "revoked", role: "viewer" }, { staffId: "operator", role: "operator" }] },
			rows: [row({ status: "scheduled", next_check_at: Date.now() + 3_600_000, created_by: invalid?.senderId ?? "admin" })],
		});
		refused(await f.items({ action: "update", id: ID, conditions: "不得写入", nextCheck: "30m" }), f);
		refused(await f.items({ action: "pause", id: ID, reason: "不得写入" }), f);
	});
}

for (const text of ["继续", "你好", "可以改吗", "不要确认", "不确认", "取消，确认", "别执行了，确认", "确认但停止", "no confirm", "don't confirm", "", undefined]) {
	for (const action of ["confirm", "resume"]) {
		test(`${action} requires positive explicit CURRENT confirmation: ${text}`, async () => {
			const f = fixture({ actor: actor({ text }), rows: [row({ status: action === "confirm" ? "proposed" : "waiting_human" })] });
			refused(await f.items({ action, id: ID, answer: "不应持久化" }), f);
		});
	}
}

test("a revoked live admin cannot rely on an earlier confirmation", async () => {
	const f = fixture();
	f.security.people.push({ staffId: "admin", role: "operator" });
	refused(await f.items({ action: "confirm", id: ID }), f);
});

test("default admin without named admin declaration grants no work authority", async () => {
	const f = fixture({ security: { adminStaffIds: [], people: [], defaultRole: "admin" } });
	refused(await f.items({ action: "confirm", id: ID }), f);
});

test("explicit role-assigned admin can confirm without legacy whitelist", async () => {
	const f = fixture({ security: { adminStaffIds: [], people: [{ staffId: "admin", role: "admin" }] } });
	assert.equal((await f.items({ action: "confirm", id: ID })).details.ok, true);
});

for (const senderId of ["admin", "viewer", "operator"]) {
	test(`list/get for ${senderId} never expose other source titles, questions or details`, async () => {
		const hidden = row({ id: "private-item", title: "PRIVATE_TITLE", goal: "PRIVATE_GOAL", question: "PRIVATE_QUESTION", origin_conversation: "dt:someone-else", status: "waiting_human" });
		const f = fixture({ actor: actor({ senderId }), rows: [hidden, row({ status: "waiting_human", question: "本来源问题" })] });
		const list = await f.items({ action: "list" });
		assert.equal(list.details.count, 1);
		assert.equal(list.details.items[0].id, ID);
		assert.doesNotMatch(JSON.stringify(list), /PRIVATE_/);
		const get = await f.items({ action: "get", id: ID.slice(0, 8) });
		assert.equal(get.details.ok, true);
		assert.equal(get.details.item.goal, row().goal);
		assert.equal(get.details.item.conditions, row().conditions);
		assert.equal(get.details.item.progress, row().progress);
		assert.deepEqual(get.details.item.lessons, JSON.parse(row().lessons));
		assert.match(get.content[0].text, /完整目标\n逐笔/);
		assert.match(get.content[0].text, /第三个标签/);
		assert.doesNotMatch(JSON.stringify(get), /PRIVATE_/);
		const missing = await f.items({ action: "get", id: "private-item" });
		refused(missing, f);
		assert.doesNotMatch(JSON.stringify(missing), /PRIVATE_/);
	});
}

test("scope filtering happens before the 30-item list limit; null origins are inaccessible", async () => {
	const f = fixture({ rows: [
		...Array.from({ length: 40 }, (_, n) => row({ id: `hidden-${n}`, title: "PRIVATE_TITLE", origin_conversation: n === 0 ? null : "dt:other" })),
		row(),
	] });
	const result = await f.items({ action: "list" });
	assert.equal(result.details.count, 1);
	assert.equal(result.details.items[0].id, ID);
	assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TITLE/);
});

for (const action of ["confirm", "resume", "cancel"]) {
	test(`${action} cannot mutate another source even for an admin`, async () => {
		const f = fixture({ rows: [row({ origin_conversation: SINGLE, title: "PRIVATE_TITLE", status: action === "confirm" ? "proposed" : "waiting_human" })] });
		const result = await f.items({ action, id: ID });
		refused(result, f);
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TITLE/);
	});
}

test("mine requires verified admin but only echoes current-source proposals", async () => {
	const f = fixture({ mineResult: { scanned: 3, proposals: [
		{ id: ID, title: "本会话提案", originConversation: GROUP },
		{ id: "private", title: "PRIVATE_TITLE", goal: "PRIVATE_GOAL", originConversation: SINGLE },
	] } });
	const result = await f.items({ action: "mine" });
	assert.deepEqual(f.mined, [{ maxProposals: 3 }]);
	assert.equal(result.details.proposals, 1);
	assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
	assert.match(result.content[0].text, /本会话提案/);
	assert.deepEqual(f.writes, []);
});

for (const action of ["get", "confirm", "resume", "cancel"]) {
	test(`${action} refuses ambiguous prefixes without mutation`, async () => {
		const f = fixture({ rows: [row({ status: "waiting_human" }), row({ id: "a1234567-other", status: "waiting_human" })] });
		const result = await f.items({ action, id: "a1234567" });
		refused(result, f);
		assert.match(result.content[0].text, /歧义/);
	});
}

test("prefix matching is source-limited and exact IDs win over longer matching IDs", async () => {
	const f = fixture({ rows: [row(), row({ id: `${ID}-hidden`, origin_conversation: SINGLE })] });
	assert.equal((await f.items({ action: "get", id: "a" })).details.item.id, ID);
	const exact = fixture({ rows: [row({ id: "short" }), row({ id: "short-long" })] });
	assert.equal((await exact.items({ action: "get", id: "short" })).details.item.id, "short");
});

for (const action of ["confirm", "resume"]) {
	for (const status of ["queued", "working", "scheduled", "done", "cancelled", action === "confirm" ? "waiting_human" : "proposed"]) {
		test(`${action} refuses invalid state ${status} before writes`, async () => {
			const f = fixture({ rows: [row({ status })] });
			refused(await f.items({ action, id: ID }), f);
		});
	}
}

test("confirm remains queued when fireItem is busy", async () => {
	const f = fixture({ fireResult: false });
	const result = await f.items({ action: "confirm", id: ID });
	assert.equal(result.details.ok, true);
	assert.equal(result.details.queued, true);
	assert.equal(f.rows.get(ID).status, "queued");
});

for (const action of ["confirm", "resume"]) {
	test(`${action} does not fire or report success on failed store transition`, async () => {
		const f = fixture({ failConfirm: true, failResume: true, rows: [row({ status: action === "confirm" ? "proposed" : "waiting_human" })] });
		const result = await f.items({ action, id: ID });
		assert.equal(result.details.ok, false);
		assert.deepEqual(f.fired, []);
	});
}

test("resume can omit answer and rejects a nontext answer before writing", async () => {
	const f = fixture({ rows: [row({ status: "waiting_human", answer: "已有答复" })], onFire: (item) => assert.equal(item.answer, "已有答复") });
	assert.equal((await f.items({ action: "resume", id: ID })).details.ok, true);
	const bad = fixture({ rows: [row({ status: "waiting_human" })] });
	refused(await bad.items({ action: "resume", id: ID, answer: 42 }), bad);
});

for (const status of ["done", "cancelled"]) {
	test(`cancel rejects terminal ${status} before any write or abort`, async () => {
		const f = fixture({ rows: [row({ status })], withCancel: true });
		refused(await f.items({ action: "cancel", id: ID }), f);
	});
}

test("cancel persists first and notifies optional abort bridge", async () => {
	const f = fixture({ actor: actor({ text: "取消这个任务" }), rows: [row({ status: "working" })], withCancel: true });
	const result = await f.items({ action: "cancel", id: ID });
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.abortRequested, true);
	assert.deepEqual(f.events, ["cancel", "abort"]);
	assert.deepEqual(f.cancelled, [ID]);
});

for (const withCancel of [false, true]) {
	test(`cancel without a successful abort bridge stays durable and does not claim hard abort (${withCancel})`, async () => {
		const f = fixture({ rows: [row({ status: "working" })], withCancel, failAbort: true });
		const result = await f.items({ action: "cancel", id: ID });
		assert.equal(result.details.ok, true);
		assert.equal(result.details.abortRequested, false);
		assert.equal(f.rows.get(ID).status, "cancelled");
		assert.match(result.content[0].text, /立即中止/);
	});
}

test("failed cancellation never aborts executor or claims success", async () => {
	const f = fixture({ failCancel: true, withCancel: true });
	assert.equal((await f.items({ action: "cancel", id: ID })).details.ok, false);
	assert.deepEqual(f.cancelled, []);
});

test("confirm applies admin rewrites before queueing and still records the confirming admin", async () => {
	const f = fixture({ actor: actor({ chatType: "group", text: "确认创建" }) });
	const result = await f.items({
		action: "confirm", id: ID.slice(0, 8),
		title: "  新标题  ", goal: "改成按需跟进，删掉每天16:30", conditions: "有异常才查，不固定时刻",
	});
	assert.equal(result.details.ok, true);
	assert.deepEqual(result.details.modified, ["标题", "目标", "执行条件"]);
	assert.match(result.content[0].text, /已按管理员要求修改/);
	assert.equal(f.rows.get(ID).title, "新标题");
	assert.equal(f.rows.get(ID).goal, "改成按需跟进，删掉每天16:30");
	assert.equal(f.rows.get(ID).conditions, "有异常才查，不固定时刻");
	assert.equal(f.rows.get(ID).status, "queued");
	assert.equal(f.rows.get(ID).created_by, "admin", "confirming admin is still the rewriter");
	assert.deepEqual(f.writes, [
		["title", ID, "新标题"],
		["goal", ID, "改成按需跟进，删掉每天16:30"],
		["conditions", ID, "有异常才查，不固定时刻"],
		["confirm", ID, "admin"],
	]);
	assert.deepEqual(f.fired, [ID]);
});

test("confirm with a partial rewrite applies only the given field", async () => {
	const f = fixture({ actor: actor({ text: "确认创建" }) });
	const result = await f.items({ action: "confirm", id: ID, goal: "只改目标" });
	assert.equal(result.details.ok, true);
	assert.deepEqual(result.details.modified, ["目标"]);
	assert.equal(f.rows.get(ID).title, row().title, "untitled rewrite keeps the mined title");
	assert.equal(f.rows.get(ID).conditions, row().conditions);
});

for (const [label, params] of [
	["empty title", { title: "   " }],
	["oversized title", { title: "长".repeat(81) }],
	["empty goal", { goal: "" }],
	["oversized goal", { goal: "长".repeat(2001) }],
	["oversized conditions", { conditions: "长".repeat(1001) }],
	["nontext title", { title: 42 }],
]) {
	test(`confirm refuses ${label} with zero writes and no queueing`, async () => {
		const f = fixture({ actor: actor({ text: "确认创建" }) });
		const result = await f.items({ action: "confirm", id: ID, ...params });
		refused(result, f);
		assert.equal(f.rows.get(ID).status, "proposed", "all-or-nothing: nothing applied");
		assert.match(result.content[0].text, /不能为空|不能超过|必须是文本/);
	});
}

test("update reschedules a waiting_human item and rewrites conditions without an explicit confirmation phrase", async () => {
	const f = fixture({
		actor: actor({ text: "改成等批次生成后再查" }),
		rows: [row({ status: "waiting_human", question: "需要人工" })],
	});
	const before = Date.now();
	const result = await f.items({ action: "update", id: ID, nextCheck: "30m", conditions: "等晚间批次生成后再查", reason: "等批次" });
	assert.equal(result.details.ok, true);
	assert.equal(result.details.applied.length, 2);
	const item = f.rows.get(ID);
	assert.equal(item.status, "scheduled");
	assert.equal(item.question, null, "reschedule clears the human question");
	assert.ok(item.next_check_at >= before + 30 * 60_000, "30m lands at least 30 minutes out");
	assert.ok(item.next_check_at < before + 31 * 60_000);
	assert.equal(item.next_check_reason, "等批次");
	assert.equal(item.conditions, "等晚间批次生成后再查");
	assert.equal(f.writes.length, 2);
	assert.deepEqual(f.writes[0], ["conditions", ID, "等晚间批次生成后再查"]);
	assert.equal(f.writes[1][0], "setSchedule");
	assert.equal(f.writes[1][2], item.next_check_at);
	assert.equal(f.writes[1][3], "等批次");
});

for (const [label, status, params, pattern] of [
	["invalid nextCheck", "waiting_human", { nextCheck: "垃圾" }, /15 分钟|非法/],
	["too-near nextCheck", "waiting_human", { nextCheck: "1m" }, /15 分钟/],
	["nextCheck while working", "working", { nextCheck: "30m" }, /pause|等本轮结束/],
	["text rewrites while working", "working", { conditions: "新条件" }, /pause|等本轮结束/],
	["goal rewrite while working", "working", { goal: "新目标" }, /pause|等本轮结束/],
	["nextCheck on a proposal", "proposed", { nextCheck: "30m" }, /确认创建/],
	["terminal state", "done", {}, /不能调整/],
	["no fields at all", "waiting_human", {}, /提供要调整/],
	["empty rewrite", "waiting_human", { title: " " }, /不能为空/],
]) {
	test(`update refuses ${label} without mutation`, async () => {
		const f = fixture({ rows: [row({ status, created_by: "admin" })] });
		const result = await f.items({ action: "update", id: ID, ...params });
		refused(result, f);
		assert.match(result.content[0].text, pattern);
	});
}

test("update refuses mid-window rewrites (stale window could overwrite); queued/proposed still editable", async () => {
	// Copilot review 2026-10-02: the in-flight window already built its prompt
	// from the old text; a later manage_work write or its outcome could silently
	// overwrite the admin's new values. Mid-window rewrites are refused.
	const working = fixture({ rows: [row({ status: "working", created_by: "admin" })] });
	const before = working.rows.get(ID).conditions;
	const refusedResult = await working.items({ action: "update", id: ID, conditions: "本轮就生效的新条件", goal: "执行中也能改目标" });
	refused(refusedResult, working);
	assert.match(refusedResult.content[0].text, /pause/);
	assert.equal(working.rows.get(ID).conditions, before, "zero writes while working");
	const proposed = fixture({ rows: [row({ status: "proposed" })] });
	assert.equal((await proposed.items({ action: "update", id: ID, title: "提案也能先改标题" })).details.ok, true);
	assert.equal(proposed.rows.get(ID).title, "提案也能先改标题");
});

test("update acknowledgement names the updated title when rewritten", async () => {
	const f = fixture({ rows: [row({ status: "waiting_human", created_by: "admin" })] });
	const result = await f.items({ action: "update", id: ID, title: "新标题", conditions: "新条件" });
	assert.equal(result.details.ok, true);
	assert.match(result.content[0].text, /新标题/);
	assert.doesNotMatch(result.content[0].text, /月末对账/);
});

test("pause turns a scheduled item into a marked waiting_human and best-effort aborts", async () => {
	const f = fixture({ rows: [row({ status: "scheduled", next_check_at: Date.now() + 3_600_000, next_check_reason: "每日巡检" })], withCancel: true });
	const result = await f.items({ action: "pause", id: ID, reason: "先核对口径" });
	assert.equal(result.details.ok, true);
	assert.equal(result.details.paused, true);
	assert.equal(result.details.abortRequested, true);
	const item = f.rows.get(ID);
	assert.equal(item.status, "waiting_human");
	assert.equal(item.question, "管理员暂停：先核对口径");
	assert.equal(item.next_check_at, null);
	assert.equal(item.next_check_reason, null);
	assert.deepEqual(f.writes, [["pause", ID, "先核对口径"]]);
	assert.deepEqual(f.events, ["pause", "abort"]);
	assert.match(result.content[0].text, /确认继续/);
});

for (const [label, status] of [["proposal", "proposed"], ["done", "done"], ["cancelled", "cancelled"], ["already paused", "waiting_human"]]) {
	test(`pause refuses ${label} without aborting`, async () => {
		const f = fixture({ rows: [row({ status })], withCancel: true });
		const result = await f.items({ action: "pause", id: ID });
		refused(result, f);
		if (label === "proposal") assert.match(result.content[0].text, /cancel/);
	});
}

test("pause stays durable when the abort bridge is missing or fails", async () => {
	for (const withCancel of [false, true]) {
		const f = fixture({ rows: [row({ status: "working", created_by: "admin" })], withCancel, failAbort: true });
		const result = await f.items({ action: "pause", id: ID, reason: "先停一下" });
		assert.equal(result.details.ok, true);
		assert.equal(result.details.abortRequested, false);
		assert.equal(f.rows.get(ID).status, "waiting_human");
		assert.match(result.content[0].text, /立即中止/);
	}
});

function notebookFixture(opts = {}) {
	return fixture({
		conversationId: `work:${ID}`,
		actor: actor({ channel: "scheduler", chatType: "single", text: "开始工作" }),
		rows: [row({ status: "working", created_by: "admin" })],
		...opts,
	});
}

for (const action of ["set_conditions", "set_progress", "add_lesson"]) {
	test(`notebook ${action} accepts only matching active work scheduler/admin identity`, async () => {
		const f = notebookFixture();
		const result = await f.notebook({ action, content: "  新笔记  " });
		assert.equal(result.details.ok, true);
		assert.deepEqual(f.writes, [[action, ID, "新笔记"]]);
	});
}

const invalidNotebooks = [
	["source IM conversation", { conversationId: GROUP }],
	["sched conversation", { conversationId: `sched:${ID}` }],
	["empty work id", { conversationId: "work:" }],
	["unknown work id", { conversationId: "work:unknown" }],
	["prefix instead of matching full work id", { conversationId: `work:${ID.slice(0, 8)}` }],
	["no actor", { actor: undefined }],
	["interactive actor", { actor: actor({ chatType: "single" }) }],
	["scheduler missing sender", { actor: actor({ channel: "scheduler", chatType: "single", senderId: "" }) }],
	["scheduler wrong creator", { actor: actor({ channel: "scheduler", chatType: "single", senderId: "other-admin" }), security: { adminStaffIds: ["admin", "other-admin"] } }],
	["scheduler invalid chat type", { actor: actor({ channel: "scheduler", chatType: "group" }) }],
	["missing creator", { rows: [row({ status: "working", created_by: null })] }],
	["revoked creator", { security: { people: [{ staffId: "admin", role: "viewer" }] } }],
	["default admin only", { security: { adminStaffIds: [], defaultRole: "admin" } }],
	...["proposed", "queued", "waiting_human", "scheduled", "done", "cancelled"].map((status) => [status, { rows: [row({ status, created_by: "admin" })] }]),
];
for (const [label, opts] of invalidNotebooks) {
	test(`notebook refuses ${label} before mutation`, async () => {
		const f = notebookFixture(opts);
		refused(await f.notebook({ action: "set_progress", content: "不得写入" }), f);
	});
}

test("notebook checks live creator role for every write", async () => {
	const f = notebookFixture();
	f.security.people.push({ staffId: "admin", role: "operator" });
	refused(await f.notebook({ action: "add_lesson", content: "不得写入" }), f);
});

test("invalid notebook action/content cannot reach setField", async () => {
	for (const params of [{ action: "set_status", content: "done" }, { action: "set_progress", content: " " }, { action: "set_conditions", content: undefined }]) {
		const f = notebookFixture();
		refused(await f.notebook(params), f);
	}
});

test("get and notebook tolerate malformed lessons JSON", async () => {
	const f = fixture({ rows: [row({ lessons: '{"not":"array"}' })] });
	assert.deepEqual((await f.items({ action: "get", id: ID })).details.item.lessons, []);
	const notebook = notebookFixture({ rows: [row({ status: "working", created_by: "admin", lessons: "broken json" })] });
	assert.equal((await notebook.notebook({ action: "set_progress", content: "记录" })).details.ok, true);
});

for (const action of ["list", "get"]) {
	test(`${action} refuses unverified/local/scheduler contexts, regardless of default role`, async () => {
		for (const opts of [{ actor: undefined }, { actor: actor({ channel: "scheduler" }) }, { conversationId: "local-console", actor: undefined }, { actor: actor({ senderId: "" }) }]) {
			const f = fixture({ security: { defaultRole: "admin" }, ...opts });
			refused(await f.items({ action, id: ID }), f);
		}
	});
}

test("missing IDs and invalid actions cannot mutate", async () => {
	for (const params of [{ action: "cancel" }, { action: "resume", id: " " }, { action: "unexpected", id: ID }]) {
		const f = fixture();
		refused(await f.items(params), f);
	}
});
