/** Worker-window tool gates: router/worker must not morph into scheduled or
 * autonomous (resident) tasks; one-shot derivation is allowed (user ruling
 * 2026-11-06). Factory-level tests, no engine/IM needed. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.worker-gate-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const bundle = join(dir, "tools.mjs");
await build({
	stdin: {
		contents: `
			export { createWorkTools } from "./src/engine/tools/work.ts";
			export { createSchedulerTools } from "./src/engine/tools/scheduler.ts";
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
const { createWorkTools, createSchedulerTools } = await import(pathToFileURL(bundle).href);

/** Minimal in-memory WorkItemStore stand-in (only what the tools touch). */
function fakeStore() {
	const rows = [];
	return {
		rows,
		create(input) {
			const row = {
				id: `id-${rows.length + 1}-${Math.random().toString(16).slice(2, 6)}`,
				title: input.title, goal: input.goal,
				conditions: null, progress: null, lessons: "[]",
				origin_conversation: input.originConversation ?? null,
				origin_note: input.originNote ?? null,
				origin: input.origin ?? null,
				status: input.status ?? "proposed",
				question: null, next_check_at: null, next_check_reason: null,
				created_by: input.createdBy ?? null,
				created_channel: input.createdChannel ?? null,
				priority: input.priority ?? 100,
				resident: input.resident ? 1 : 0,
				updated_at: Date.now(),
			};
			rows.push(row);
			return row;
		},
		get: (id) => rows.find((r) => r.id === id),
		list: () => rows,
		addLesson: (id, c) => { const r = rows.find((x) => x.id === id); if (r) r.lessons = JSON.stringify([c]); return r; },
		setField: (id, f, v) => { const r = rows.find((x) => x.id === id); if (r) r[f] = v; return r; },
	};
}

const config = { all: () => ({ security: { adminStaffIds: ["admin"], ownerStaffIds: [], people: [], defaultRole: "viewer", adminFullAccess: true }, capabilities: {} }) };
const WORK = "work:a1234567-1111-2222-3333-444444444444";
const schedulerActor = { senderId: "admin", channel: "scheduler", chatType: "single" };

function workTool(store, conversationId, fired = []) {
	const resolveActor = (cid) => (cid.startsWith("work:") ? schedulerActor : { senderId: "admin", channel: "dingtalk", chatType: "group", text: "确认创建" });
	const tools = createWorkTools({
		workItems: store,
		fireItem: (id) => { fired.push(id); return true; },
		mine: async () => ({ proposals: [], scanned: 0 }),
		config,
		resolveActor,
		conversationId,
	});
	return tools.find((t) => t.name === "manage_work_items");
}

function schedulerTool(conversationId, created = []) {
	const fake = {
		validateCron: (cron) => { if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(cron)) throw new Error("bad cron"); },
		create: (input) => { created.push(input); return { id: "st-1", title: input.title, next_run_at: 1790000000000, autonomous: input.autonomous === true, silent: input.silent === true, created_by: input.createdBy }; },
		list: () => created.map((c) => ({ enabled: 1, created_by: c.createdBy, created_channel: c.createdChannel })),
	};
	const tools = createSchedulerTools(fake, conversationId, "im", config, (cid) => (cid.startsWith("work:") ? schedulerActor : { senderId: "admin", channel: "dingtalk", chatType: "group" }));
	return tools.find((t) => t.name === "create_scheduled_task");
}

const text = (r) => r.content?.[0]?.text ?? "";

test("worker window: EVERY mutating scheduler tool is refused (create/update/toggle/delete/authorize)", async () => {
	// review P1-2: the first gate covered only create — a worker could still
	// update/toggle an EXISTING task into an autonomous recurring one.
	const created = [];
	const tools = createSchedulerTools(
		{
			validateCron: () => {},
			create: (input) => { created.push(input); return { id: "st-1", title: input.title, next_run_at: 1 }; },
			list: () => created.map((c) => ({ enabled: 1, created_by: c.createdBy, created_channel: c.createdChannel })),
			get: () => ({ id: "st-1", title: "已有任务", autonomous: true, chain_state: "x" }),
			delete: () => {},
			setEnabled: () => {},
			update: () => ({}),
		},
		WORK, "im", config, (cid) => (cid.startsWith("work:") ? schedulerActor : { senderId: "admin", channel: "dingtalk", chatType: "group" }),
	);
	const byName = (n) => tools.find((t) => t.name === n);
	for (const [name, params] of [
		["create_scheduled_task", { title: "x", prompt: "y", cron: "0 9 * * *" }],
		["update_scheduled_task", { id: "st-1", autonomous: true, prompt: "new background recurring goal" }],
		["toggle_scheduled_task", { id: "st-1", enabled: true }],
		["delete_scheduled_task", { id: "st-1" }],
		["authorize_scheduled_task", { id: "st-1" }],
		["resume_scheduled_task", { id: "st-1" }],
	]) {
		const r = await byName(name).execute("t", params);
		assert.equal(r.details?.refused, true, `${name} must be refused in a worker window`);
		assert.equal(r.details?.reason, "worker-window-cannot-mutate-scheduled");
		assert.match(text(r), /不能创建或变更定时任务/);
	}
	assert.equal(created.length, 0, "no scheduled task may actually be created");
	// read-only tools stay allowed
	assert.ok(byName("list_scheduled_tasks").execute.length >= 0);
});

test("worker window: mine and confirm are refused (no autonomous-task pollution)", async () => {
	const tool = workTool(new fakeStore(), WORK);
	const mine = await tool.execute("t1", { action: "mine" });
	assert.equal(mine.details?.refused, true);
	assert.match(text(mine), /挖掘或确认自主任务提案/);
	const confirm = await tool.execute("t2", { action: "confirm", id: "whatever" });
	assert.equal(confirm.details?.refused, true);
});

test("worker window: creating a RESIDENT task is refused (one-shot only)", async () => {
	const tool = workTool(new fakeStore(), WORK);
	const r = await tool.execute("t1", { action: "create", title: "巡检", goal: "持续盯着", resident: true });
	assert.equal(r.details?.refused, true);
	assert.match(text(r), /一次性任务/);
});

test("worker window: creating a ONE-SHOT task succeeds as origin=manual, queued+fired, chain identity", async () => {
	const store = new fakeStore();
	const fired = [];
	const tool = workTool(store, WORK, fired);
	const r = await tool.execute("t1", { action: "create", title: "补查剩余订单", goal: "把剩余订单核对完" });
	assert.equal(r.details?.ok, true, text(r));
	const row = store.rows[0];
	assert.equal(row.origin, "manual", "derived task must be one-shot (manual: no self-follow-up)");
	assert.equal(row.origin_conversation, WORK);
	assert.equal(row.status, "queued");
	assert.equal(row.created_by, "admin", "chain identity flows from the worker's scheduler actor");
	assert.deepEqual(fired, [row.id], "derived task fires immediately");
	assert.match(text(r), /一次性任务/);
});

test("worker window: derivation is capped at 3 unfinished tasks", async () => {
	const store = new fakeStore();
	const tool = workTool(store, WORK);
	for (let i = 0; i < 3; i++) {
		const r = await tool.execute(`t${i}`, { action: "create", title: `派生${i}`, goal: "g" });
		assert.equal(r.details?.ok, true, text(r));
	}
	const r4 = await tool.execute("t3", { action: "create", title: "第4个", goal: "g" });
	assert.equal(r4.details?.refused, true);
	assert.match(text(r4), /上限/);
});

test("worker window: finished derivations do not count against the cap", async () => {
	const store = new fakeStore();
	const tool = workTool(store, WORK);
	for (let i = 0; i < 3; i++) {
		const r = await tool.execute(`t${i}`, { action: "create", title: `派生${i}`, goal: "g" });
		assert.equal(r.details?.ok, true);
	}
	store.rows.forEach((r) => { r.status = "done"; });
	const r4 = await tool.execute("t4", { action: "create", title: "再来一个", goal: "g" });
	assert.equal(r4.details?.ok, true, "finished derivations must not block new ones");
});

test("worker window: get returns FULL details of one derivation (found / missing / ambiguous)", async () => {
	const store = new fakeStore();
	const tool = workTool(store, WORK);
	const created = await tool.execute("c1", { action: "create", title: "派生详情", goal: "完整目标", conditions: "时间窗" });
	const id = created.details.id;
	store.rows[0].progress = "核对到 60%";
	store.rows[0].lessons = JSON.stringify(["登录态会过期"]);
	const got = await tool.execute("g1", { action: "get", id: id.slice(0, 8) });
	assert.match(text(got), /完整目标/);
	assert.match(text(got), /核对到 60%/);
	assert.match(text(got), /登录态会过期/);
	const missing = await tool.execute("g2", { action: "get", id: "zzzz" });
	assert.equal(missing.details?.refused, true);
	const noId = await tool.execute("g3", { action: "get" });
	assert.equal(noId.details?.refused, true);
});

test("worker window: derivation DEPTH is capped at 1 — a derived task cannot derive", async () => {
	// review P2-1: the per-window cap counts only direct children; without a
	// depth limit a derived task's own window could farm grandchildren forever.
	const store = new fakeStore();
	const parent = store.create({
		title: "一层派生", goal: "g", originConversation: WORK,
		originNote: "后台任务派生（一次性）", origin: "manual", status: "queued",
		createdBy: "admin", createdChannel: "scheduler",
	});
	const childWindow = `work:${parent.id}`;
	const tool = workTool(store, childWindow);
	const r = await tool.execute("t1", { action: "create", title: "孙代任务", goal: "g" });
	assert.equal(r.details?.refused, true, text(r));
	assert.match(text(r), /不能再派生/);
	assert.equal(store.rows.length, 1, "no grandchild may be created");
});

test("worker window: list shows only its own derivations; resume/pause/cancel/update refused", async () => {
	const store = new fakeStore();
	const tool = workTool(store, WORK);
	await tool.execute("t0", { action: "create", title: "派生A", goal: "g" });
	const foreign = new fakeStore();
	foreign.create({ title: "别人的任务", goal: "g", originConversation: "dt:group:other" });
	store.rows.push(...foreign.rows);
	const list = await tool.execute("l1", { action: "list" });
	assert.equal(list.details?.count, 1, "worker window sees only its own derivations");
	assert.match(text(list), /派生A/);

	for (const action of ["resume", "pause", "cancel", "update"]) {
		const r = await tool.execute(action, { action, id: "whatever" });
		assert.equal(r.details?.refused, true, `${action} must be refused in a worker window`);
	}
});

test("IM conversations are unaffected: scheduled create and autonomous create still work", async () => {
	const created = [];
	const tool = schedulerTool("dt:admin", created);
	const r = await tool.execute("t1", { title: "每日早报", prompt: "查订单", cron: "0 9 * * *" });
	assert.equal(r.details?.ok, true, text(r));
	assert.equal(created.length, 1, "IM-created scheduled task still works");

	const store = new fakeStore();
	const fired = [];
	const wt = workTool(store, "dt:admin", fired);
	const wr = await wt.execute("t1", { action: "create", title: "自主任务", goal: "g" });
	assert.equal(wr.details?.ok, true, text(wr));
	assert.equal(store.rows[0].origin, "mining", "IM-ordered create keeps origin=mining");
	assert.deepEqual(fired, [store.rows[0].id]);
});
