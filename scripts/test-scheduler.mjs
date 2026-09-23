/**
 * Scheduled-task tooling tests. Run with `npm run test:scheduler`.
 *
 * The behaviour under test is the identity plumbing that decides what an
 * unattended run may do: a task carries an identity only when a verified 1:1
 * admin captured it with 「确认」, and `authorize_scheduled_task` is how an
 * identity-less task (created in a GROUP, by an older version, or from the
 * console) is repaired after the fact — now including the batch form, because
 * the normal case is "all of these are mine, authorise them all".
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.scheduler-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "scheduler.mjs");
await build({
	stdin: {
		contents: `
			export { ConfigStore } from "./src/db/config-store.ts";
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
});
const { ConfigStore, createSchedulerTools } = await import(pathToFileURL(bundle).href);

function store(t, seed = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	t.after(() => db.close());
	if (Object.keys(seed).length) config.replaceAll(seed);
	return config;
}

/** Minimal stand-in for SchedulerService — the tools only use these five calls. */
function fakeScheduler(t, rows) {
	const tasks = rows.map((r, i) => ({
		id: r.id ?? `t${i + 1}`,
		title: r.title ?? `任务${i + 1}`,
		prompt: r.prompt ?? "干点活",
		cron: r.cron ?? "0 9 * * *",
		enabled: r.enabled ?? 1,
		conversation_id: r.conversation_id ?? null,
		origin: r.origin ?? "im",
		created_by: r.created_by ?? null,
		last_run_at: null,
		next_run_at: Date.now() + 3_600_000,
		last_status: null,
		created_at: Date.now(),
		updated_at: Date.now(),
	}));
	return {
		list: () => tasks,
		setCreatedBy: (id, senderId) => {
			const found = tasks.find((x) => x.id === id);
			if (!found) return undefined;
			found.created_by = senderId;
			return found;
		},
		create: (input) => {
			const row = { ...tasks[0], ...input, id: `t${tasks.length + 1}`, created_by: input.createdBy ?? null };
			tasks.push(row);
			return row;
		},
		delete: () => {},
		setEnabled: () => {},
		update: () => undefined,
		validateCron: () => {},
	};
}

const actor = (senderId, chatType = "single", text = "确认") => ({ senderId, chatType, channel: "dingtalk", text });
const tool = (tools, name) => tools.find((x) => x.name === name);

function build1(t, seed, rows, who, conversationId = "dt:boss") {
	const config = store(t, seed);
	const scheduler = fakeScheduler(t, rows);
	const tools = createSchedulerTools(scheduler, conversationId, "im", config, () => who);
	return { config, scheduler, tools };
}

test("list shows which tasks carry an unattended identity", async (t) => {
	const { tools } = build1(
		t,
		{ security: { adminStaffIds: ["boss"] } },
		[
			{ title: "早报", created_by: "boss" },
			{ title: "群里的巡检" },
		],
		actor("boss"),
	);
	const res = await tool(tools, "list_scheduled_tasks").execute("l1", {});
	assert.equal(res.details.count, 2);
	assert.equal(res.details.unauthorized, 1);
	assert.match(res.content[0].text, /执行身份: 跟随创建人 b\*\*\*（当前 admin）/, "ids are masked, even to an admin");
	assert.match(res.content[0].text, /执行身份: 未记录（控制台\/旧版本创建）/, "an identity-less row is named as such");
	assert.match(res.content[0].text, /给所有定时任务授权/, "it tells the admin the one-line batch remedy");
});

test("authorize all=true stamps every identity-less task in one go", async (t) => {
	const { config, tools } = build1(
		t,
		{ security: { adminStaffIds: ["boss"] } },
		[
			{ title: "早报", created_by: "boss" },
			{ title: "群里的巡检" },
			{ title: "旧版遗留", created_by: null },
		],
		actor("boss", "single", "都给上权限，确认"),
	);
	const res = await tool(tools, "authorize_scheduled_task").execute("a1", { all: true });
	assert.equal(res.details.authorized, 2, "only the identity-less ones are written");
	assert.deepEqual(res.details.titles, ["群里的巡检", "旧版遗留"]);
	assert.match(res.content[0].text, /已授权全部 2 个/);
	assert.match(res.content[0].text, /cron、prompt 与执行历史均未改动/);
	const rows = (await tool(tools, "list_scheduled_tasks").execute("l1", {})).details;
	assert.equal(rows.unauthorized, 0);

	// Running it again is a no-op, not an error.
	const again = await tool(tools, "authorize_scheduled_task").execute("a2", { all: true });
	assert.equal(again.details.authorized, 0);
	assert.match(again.content[0].text, /没有需要授权的任务/);
});

test("authorize without a target lists what needs it; single id still works", async (t) => {
	const { tools } = build1(
		t,
		{ security: { adminStaffIds: ["boss"] } },
		[{ title: "甲" }, { title: "乙" }],
		actor("boss"),
	);
	let res = await tool(tools, "authorize_scheduled_task").execute("a1", {});
	assert.equal(res.details.ok, false);
	assert.equal(res.details.unauthorized, 2, "two candidates → ask instead of guessing");
	assert.match(res.content[0].text, /all=true/);
	assert.match(res.content[0].text, /甲/);

	res = await tool(tools, "authorize_scheduled_task").execute("a2", { id: "t1" });
	assert.equal(res.details.ok, true);
	assert.equal(res.details.title, "甲");
	res = await tool(tools, "authorize_scheduled_task").execute("a3", { id: "nope" });
	assert.equal(res.details.ok, false);
	assert.match(res.content[0].text, /未找到 id/);
});

test("authorize is refused without a 1:1 admin and an explicit confirmation", async (t) => {
	// A group request must not手滑 authorise everything.
	const inGroup = build1(t, { security: { adminStaffIds: ["boss"] } }, [{ title: "甲" }], actor("boss", "group"), "dt:group:prod");
	let res = await tool(inGroup.tools, "authorize_scheduled_task").execute("g1", { all: true });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /单聊/);
	assert.equal(inGroup.scheduler.list()[0].created_by, null, "nothing was written");

	// A non-admin in a 1:1 chat cannot escalate every task to admin.
	const asMember = build1(t, { security: { adminStaffIds: ["boss"] } }, [{ title: "甲" }], actor("alice"));
	res = await tool(asMember.tools, "authorize_scheduled_task").execute("m1", { all: true });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /不是本系统的管理员/);

	// An admin who has not said 确认 yet gets the prompt, not the write.
	const unconfirmed = build1(t, { security: { adminStaffIds: ["boss"] } }, [{ title: "甲" }], actor("boss", "single", "把定时任务都授权了"));
	res = await tool(unconfirmed.tools, "authorize_scheduled_task").execute("u1", { all: true });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /确认/);
	assert.equal(unconfirmed.scheduler.list()[0].created_by, null);
});

test("a task created in a GROUP is authorized from the 1:1 chat, and keeps pushing to its group", async (t) => {
	// The user's question: 「群里设置的定时任务呢？单聊可以授权吗？」 — yes. The
	// authorization act must happen in a 1:1 admin chat, but the TASK being
	// authorized is unrestricted: origin and push target are untouched.
	const { tools } = build1(
		t,
		{ security: { adminStaffIds: ["boss"] } },
		[
			{ title: "群里建的日报", conversation_id: "dt:group:cidABC=", origin: "im" },
			{ title: "本会话建的巡检", conversation_id: "dt:boss", origin: "im" },
			{ title: "控制台遗留", conversation_id: null, origin: "console" },
		],
		actor("boss", "single", "给所有定时任务都授权，确认"),
		"dt:boss",
	);

	const res = await tool(tools, "authorize_scheduled_task").execute("a1", { all: true });
	assert.equal(res.details.authorized, 3, "group / console / own tasks are all eligible");
	assert.equal(res.details.authorizedElsewhere, 2, "the two not created here are flagged");
	// The warning is the safety half: creation is open to anyone, and authorizing
	// hands the task the admin's identity.
	assert.match(res.content[0].text, /不是在当前会话创建的/);
	assert.match(res.content[0].text, /群里建的日报（群聊 dt\*\*\*C=/);
	assert.match(res.content[0].text, /任何人在群里都能让机器人建任务/);

	const listed = await tool(tools, "list_scheduled_tasks").execute("l1", {});
	assert.match(listed.content[0].text, /创建于: 群聊 dt\*\*\*C=/, "list shows where each task came from");
	assert.match(listed.content[0].text, /创建于: 本会话/);
	assert.match(listed.content[0].text, /创建于: 控制台\/旧版本/);
	assert.equal(listed.details.unauthorized, 0);
});

test("the pending list names each task's origin, and flags nothing when all are local", async (t) => {
	const { tools } = build1(
		t,
		{ security: { adminStaffIds: ["boss"] } },
		[{ title: "甲", conversation_id: "dt:boss" }, { title: "乙", conversation_id: "dt:boss" }],
		actor("boss"),
		"dt:boss",
	);
	let res = await tool(tools, "authorize_scheduled_task").execute("p1", {});
	assert.match(res.content[0].text, /甲（id=t1，创建于本会话）/, "the origin is part of the pick list");

	res = await tool(tools, "authorize_scheduled_task").execute("p2", { all: true });
	assert.equal(res.details.authorized, 2);
	assert.equal(res.details.authorizedElsewhere, 0);
	assert.doesNotMatch(res.content[0].text, /不是在当前会话创建的/, "tasks created here need no warning");
});

test("a task created in a GROUP inherits its creator's role (no separate authorization)", async (t) => {
	// The user rejected the previous model outright: 「群聊创建的任务默认跟随创建人
	// 的权限，如果每个群聊定时任务都要单聊授权的话 那这个权限体系就是有问题」.
	// So creation in a group must attach the platform-verified creator, and the
	// task then runs at that person's CURRENT role.
	const grouped = build1(t, { security: { adminStaffIds: ["boss"], people: [{ staffId: "op", role: "operator" }] } }, [], actor("op", "group"), "dt:group:prod");
	let res = await tool(grouped.tools, "create_scheduled_task").execute("c1", { title: "巡检", prompt: "查一下", cron: "0 9 * * *" });
	assert.equal(res.details.createdBy, "op", "the group sender's verified id is recorded");
	const text = res.content.map((c) => c.text).join("\n");
	assert.match(text, /跟随创建人的权限/);
	assert.match(text, /当前 operator/, "the reply states the role the task will run at");
	assert.doesNotMatch(text, /authorize_scheduled_task/, "no authorization detour is offered");

	// A 1:1 admin creating a task gets an admin-backed task, as before.
	const direct = build1(t, { security: { adminStaffIds: ["boss"] } }, [], actor("boss", "single", "建个任务"));
	res = await tool(direct.tools, "create_scheduled_task").execute("c2", { title: "巡检", prompt: "查一下", cron: "0 9 * * *" });
	assert.equal(res.details.createdBy, "boss");
	assert.match(res.content.map((c) => c.text).join("\n"), /当前 admin/);
});

test("the task list reports the creator's CURRENT role and flags a demotion", async (t) => {
	const { config, tools } = build1(
		t,
		{ security: { adminStaffIds: [], people: [{ staffId: "op", role: "operator" }, { staffId: "ex", role: "viewer" }] } },
		[
			{ title: "运维巡检", created_by: "op" },
			{ title: "被降权的任务", created_by: "ex" },
			{ title: "控制台遗留" },
		],
		actor("op"),
	);
	let res = await tool(tools, "list_scheduled_tasks").execute("l1", {});
	assert.match(res.content[0].text, /跟随创建人 o\*\*\*（当前 operator）/, "the effective role is shown, resolved live");
	assert.match(res.content[0].text, /⚠️ 创建人已被降为 viewer/, "a demoted creator is called out, not silently degraded");
	assert.match(res.content[0].text, /控制台\/旧版本创建/, "legacy rows are distinguished from role-following ones");
	assert.equal(res.details.unauthorized, 1, "only the identity-less legacy row needs repair");

	// Demoting the creator immediately changes what the task may do.
	config.update({ security: { people: [{ staffId: "op", role: "viewer" }] } });
	res = await tool(tools, "list_scheduled_tasks").execute("l2", {});
	assert.match(res.content[0].text, /跟随创建人 o\*\*\*（当前 viewer）/, "live re-check, no task rebuild needed");
});

test("an unaddressed authorization resolves the single pending task, and asks when ambiguous", async (t) => {
	// 小派 told the admin to say 「给定时任务授权，确认」 — that phrasing must work
	// when exactly one task needs repair, and must not guess when several do.
	const one = build1(t, { security: { adminStaffIds: ["boss"] } }, [{ title: "控制台遗留" }], actor("boss", "single", "给定时任务授权，确认"));
	let res = await tool(one.tools, "authorize_scheduled_task").execute("a1", {});
	assert.equal(res.details.ok, true);
	assert.equal(res.details.title, "控制台遗留", "the only candidate is unambiguous");

	const many = build1(t, { security: { adminStaffIds: ["boss"] } }, [{ title: "甲" }, { title: "乙" }], actor("boss", "single", "给定时任务授权，确认"));
	res = await tool(many.tools, "authorize_scheduled_task").execute("a2", {});
	assert.equal(res.details.ok, false);
	assert.equal(res.details.unauthorized, 2);
	assert.match(res.content[0].text, /有 2 个任务没有执行身份/);
});

// Field incident 2026-09-22: a task created in a GROUP had its push target
// silently rerouted to the editor's 1:1 chat — the model passed bindCurrent
// because "the edit came from here". Editing CONTENT must never touch the push
// target; rebinding an existing target is an explicitly confirmed operation.
function bindBuild(t, rows, who, conversationId = "dt:boss") {
	const scheduler = bindFake(t, rows);
	const tools = createSchedulerTools(scheduler, conversationId, "im", store(t, {}), () => who);
	return { scheduler, tools };
}

function bindFake(t, rows) {
	const tasks = rows.map((r, i) => ({
		id: `t${i + 1}`,
		title: r.title,
		cron: "0 9 * * *",
		enabled: 1,
		conversation_id: r.conversation_id ?? null,
		origin: r.conversation_id ? "im" : "console",
		created_by: null,
		last_run_at: null,
		next_run_at: Date.now() + 3_600_000,
		last_status: null,
		created_at: Date.now(),
		updated_at: Date.now(),
	}));
	return {
		list: () => tasks,
		get: (id) => tasks.find((x) => x.id === id),
		create: (input) => {
			const row = { ...tasks[0], ...input, id: `t${tasks.length + 1}` };
			tasks.push(row);
			return row;
		},
		delete: () => {},
		setEnabled: () => {},
		setCreatedBy: () => undefined,
		update: (id, patch, nextRunAt) => {
			const row = tasks.find((x) => x.id === id);
			if (!row) return undefined;
			Object.assign(row, {
				...(patch.title !== undefined ? { title: patch.title } : {}),
				...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
				...(patch.cron !== undefined ? { cron: patch.cron } : {}),
				...(patch.conversationId !== undefined ? { conversation_id: patch.conversationId } : {}),
				...(nextRunAt !== undefined ? { next_run_at: nextRunAt } : {}),
				updated_at: Date.now(),
			});
			return row;
		},
		validateCron: () => {},
	};
}

test("editing a task from another conversation never touches its push target", async (t) => {
	const h = bindBuild(t, [{ title: "对账日报", conversation_id: "dt:group:g1" }], actor("boss", "single", "把任务标题改一下"));
	let res = await tool(h.tools, "update_scheduled_task").execute("u1", { id: "t1", title: "新标题" });
	assert.equal(res.details.ok, true);
	assert.equal(h.scheduler.get("t1").conversation_id, "dt:group:g1", "the group target survives a 1:1 edit");
	assert.match(res.content[0].text, /推送目标未变/, "the reply states the target was left alone");
});

test("bindCurrent from another conversation is refused without an explicit 「确认」", async (t) => {
	const h = bindBuild(t, [{ title: "对账日报", conversation_id: "dt:group:g1" }], actor("boss", "single", "顺便把任务改绑一下"));
	let res = await tool(h.tools, "update_scheduled_task").execute("u1", { id: "t1", title: "新标题", bindCurrent: true });
	assert.equal(res.details.ok, false);
	assert.equal(res.details.needsConfirmation, true);
	assert.equal(h.scheduler.get("t1").conversation_id, "dt:group:g1", "refusal leaves the group target intact");
	assert.equal(h.scheduler.get("t1").title, "对账日报", "the whole call is refused atomically — no half-applied patch");
	assert.match(res.content[0].text, /未改绑推送目标/);
	assert.match(res.content[0].text, /包含「确认」/);

	// With the explicit confirmation in the current message, the rebind goes through.
	const ok = bindBuild(t, [{ title: "对账日报", conversation_id: "dt:group:g1" }], actor("boss", "single", "把推送改到这个群，确认"));
	res = await tool(ok.tools, "update_scheduled_task").execute("u2", { id: "t1", bindCurrent: true });
	assert.equal(res.details.ok, true);
	assert.equal(ok.scheduler.get("t1").conversation_id, "dt:boss", "confirmed rebind moves the target");
	assert.match(res.content[0].text, /推送目标→当前单聊/);
});

test("binding a target-less (console/legacy) task is the rescue path and needs no confirmation", async (t) => {
	const h = bindBuild(t, [{ title: "控制台遗留" }], actor("boss", "single", "帮它配个推送"));
	const res = await tool(h.tools, "update_scheduled_task").execute("u1", { id: "t1", bindCurrent: true });
	assert.equal(res.details.ok, true);
	assert.equal(h.scheduler.get("t1").conversation_id, "dt:boss");
	assert.equal(res.details.pushTargetChanged, true);
});

test("bindCurrent from the task's own conversation is a no-op change, no ceremony", async (t) => {
	const h = bindBuild(t, [{ title: "群任务", conversation_id: "dt:group:g1" }], actor("boss", "single", "改下标题"), "dt:group:g1");
	const res = await tool(h.tools, "update_scheduled_task").execute("u1", { id: "t1", title: "改名", bindCurrent: true });
	assert.equal(res.details.ok, true);
	assert.equal(h.scheduler.get("t1").conversation_id, "dt:group:g1");
});
