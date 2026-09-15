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
	assert.match(res.content[0].text, /身份: 已授权（b\*\*\*）/, "ids are masked, even to an admin");
	assert.match(res.content[0].text, /身份: 未授权——无人值守只能用对话与知识库/);
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
	assert.equal(res.details.unauthorized, 2);
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

test("creating a task without an identity says so, and how to fix it", async (t) => {
	// Created in a group: allowed, but runs unattended with no identity.
	const grouped = build1(t, { security: { adminStaffIds: ["boss"] } }, [], actor("boss", "group"), "dt:group:prod");
	let res = await tool(grouped.tools, "create_scheduled_task").execute("c1", { title: "巡检", prompt: "查一下", cron: "0 9 * * *" });
	assert.equal(res.details.createdBy, null);
	assert.match(res.content.map((c) => c.text).join("\n"), /未记录执行身份/);
	assert.match(res.content.map((c) => c.text).join("\n"), /authorize_scheduled_task/, "the admin is told the remedy, not left stuck");

	// Created in a 1:1 admin chat with 确认: identity captured.
	const direct = build1(t, { security: { adminStaffIds: ["boss"] } }, [], actor("boss", "single", "建个任务，确认"));
	res = await tool(direct.tools, "create_scheduled_task").execute("c2", { title: "巡检", prompt: "查一下", cron: "0 9 * * *" });
	assert.equal(res.details.createdBy, "boss");
	assert.doesNotMatch(res.content.map((c) => c.text).join("\n"), /未记录执行身份/);
});
