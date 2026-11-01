/**
 * owner is a strict superset of admin (2026-10-31 field bug).
 *
 * A deployment owner was asked to type 「确认」 before run_command would fire —
 * the confirmation exemption compared `role !== "admin"` literally, so granting
 * owner SILENTLY REMOVED admin powers. The design doc is explicit: every
 * admin-gated action must accept owner. These tests pin the superset at each
 * gate that had the literal-comparison bug:
 *   shell confirmation exemption, shell allowlist bypass, confirmAuthorization,
 *   profile-scope memory, scheduler resume, and the scheduler scope description.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const workDir = join(root, "node_modules/.owner-superset-test-");
mkdirSync(workDir, { recursive: true });
const dir = workDir;
const bundle = join(dir, "o.mjs");
await build({
	stdin: { contents: `
		export { ConfigStore } from "./src/db/config-store.ts";
		export { createRunCommandTool } from "./src/engine/tools/shell.ts";
	`, resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
});
const { ConfigStore, createRunCommandTool } = await import(pathToFileURL(bundle).href);

/** An owner actor whose text deliberately does NOT contain 「确认」. */
function ownerFixture(t) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	t.after(() => db.close());
	config.replaceAll({
		security: { ownerStaffIds: ["the-owner"], adminStaffIds: ["an-admin"] },
		capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
	});
	const actor = { channel: "dingtalk", chatType: "single", senderId: "the-owner", text: "跑一下这个命令" };
	const deps = { config, resolveActor: () => actor, onConfigChanged: () => {}, conversationId: "dt:single:o" };
	const tool = createRunCommandTool(deps);
	return { config, tool, run: (cmd = "echo hi") => tool.execute("t", { command: cmd, workingDir: process.cwd() }) };
}

test("owner runs commands WITHOUT the confirmation keyword (field bug regression)", async (t) => {
	const { run } = ownerFixture(t);
	const result = await run("echo owner-superset-ok");
	const text = JSON.stringify(result);
	assert.ok(!text.includes("确认"), "owner must not be asked for the confirmation keyword");
	assert.ok(!JSON.stringify(result).includes("refused"), "owner's command runs");
});

test("operator WITHOUT 确认 is still refused (the gate keeps its purpose)", async (t) => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	t.after(() => db.close());
	config.replaceAll({
		security: { adminStaffIds: ["an-admin"], people: [{ staffId: "op-user", role: "operator" }] },
		capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
	});
	const actor = { channel: "dingtalk", chatType: "single", senderId: "op-user", text: "直接跑，别问" };
	const tool = createRunCommandTool({ config, resolveActor: () => actor, onConfigChanged: () => {}, conversationId: "dt:single:op" });
	const result = await tool.execute("t", { command: "echo hi", workingDir: process.cwd() });
	assert.ok(JSON.stringify(result).includes("确认"), "operator is still asked for the keyword");
});

test("a quote-bearing admin also passes the gate (no behavior change from the rank rewrite)", async (t) => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	t.after(() => db.close());
	config.replaceAll({
		security: { adminStaffIds: ["an-admin"] },
		capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
	});
	const actor = { channel: "dingtalk", chatType: "single", senderId: "an-admin", text: "执行" };
	const tool = createRunCommandTool({ config, resolveActor: () => actor, onConfigChanged: () => {}, conversationId: "dt:single:a" });
	const result = await tool.execute("t", { command: "echo admin-ok", workingDir: process.cwd() });
	assert.ok(!JSON.stringify(result).includes("确认"), "admin keeps confirmation-free shell");
});

test("owner escapes the operator allowlist (superset, not demotion)", async (t) => {
	const { run } = ownerFixture(t);
	// "pwd" is NOT in the ["node"] allowlist: an owner must run it like an admin,
	// while an operator would be refused by the whitelist check.
	const result = await run("pwd");
	assert.ok(!JSON.stringify(result).includes("白名单"), "owner is not demoted to the allowlist");
});

// ── the other four gates (round-2 Copilot: regressions must be catchable) ──
const bundle2 = join(dir, "o2.mjs");
await build({
	stdin: { contents: `
		export { effectiveAuthorizationRole } from "./src/security/permissions.ts";
		export { createRememberTool } from "./src/engine/tools/save-knowledge.ts";
		export { createSchedulerTools } from "./src/engine/tools/scheduler.ts";
	`, resolveDir: root, loader: "ts" },
	outfile: bundle2, bundle: true, platform: "node", format: "esm", packages: "external",
});
const { effectiveAuthorizationRole, createRememberTool, createSchedulerTools } = await import(pathToFileURL(bundle2).href);

function dbWithRoles(t) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	t.after(() => db.close());
	config.replaceAll({ security: { ownerStaffIds: ["the-owner"], adminStaffIds: ["an-admin"], people: [{ staffId: "op-user", role: "operator" }] } });
	return config;
}

test("authorization: owner passes, operator/viewer refused, widget admin passes", (t) => {
	const config = dbWithRoles(t);
	const rankCheck = (actor) => {
		const role = effectiveAuthorizationRole(actor, config);
		return { role, ok: ["admin", "owner"].includes(role) };
	};
	assert.deepEqual(rankCheck({ senderId: "the-owner", channel: "dingtalk", chatType: "single" }), { role: "owner", ok: true }, "owner can authorize");
	assert.deepEqual(rankCheck({ senderId: "an-admin", channel: "dingtalk", chatType: "single" }), { role: "admin", ok: true });
	assert.equal(rankCheck({ senderId: "op-user", channel: "dingtalk", chatType: "single" }).ok, false, "operator cannot authorize");
	assert.equal(rankCheck(undefined).ok, false, "no actor cannot authorize");
	const widgetAdmin = { senderId: "widget-user-u1", channel: "widget", chatType: "single", verifiedRole: "admin" };
	assert.equal(rankCheck(widgetAdmin).ok, true, "a ticketed admin can authorize");
});

test("remember: owner writes profile scope WITHOUT downgrade; viewer still downgraded", async (t) => {
	const config = dbWithRoles(t);
	const calls = [];
	const knowledge = { saveMemory(input) { calls.push(input); return { id: "x", merged: false }; } };
	const mk = (senderId) => createRememberTool({
		knowledge, config,
		conversationId: "dt:group:g1",
		resolveActor: () => ({ senderId, channel: "dingtalk", chatType: "group", text: "记住" }),
	});

	await mk("the-owner").execute("t", { title: "全局规则", content: "所有人共享", scope: "profile" });
	assert.equal(calls.at(-1).scope, null, "owner's profile write lands as shared (scope=null)");
	assert.equal(calls.at(-1).downgradedFrom, undefined, "no downgrade for owner");

	await mk("op-user").execute("t2", { title: "全局规则", content: "所有人共享", scope: "profile" });
	assert.equal(calls.at(-1).scope, "person", "operator's profile ask is still downgraded to person");
});

function schedulerStub(tasks) {
	return {
		list: () => tasks,
		get: (id) => tasks.find((x) => x.id === id),
		stageAnswer: (id, answer) => { tasks.find((x) => x.id === id).staged = answer; },
		fireNow: (id) => {
			const found = tasks.find((x) => x.id === id);
			if (!found?.autonomous || !found.chain_state) return false;
			found.fired = (found.fired ?? 0) + 1;
			return true;
		},
		delete: () => {},
		validateCron: () => true,
	};
}

const chainTask = {
	id: "task-1", title: "巡检", autonomous: true, chain_state: { paused: "human" },
	created_by: "someone-else", created_channel: "scheduler", enabled: 1,
};

test("scheduler resume: a NON-creator owner can resume; a non-creator viewer cannot", async (t) => {
	const config = dbWithRoles(t);
	const tasks = [JSON.parse(JSON.stringify(chainTask))];
	const tools = createSchedulerTools(schedulerStub(tasks), "dt:single:o", "dt:single:o", config,
		() => ({ senderId: "the-owner", channel: "dingtalk", chatType: "single", text: "继续" }));
	const resume = tools.find((x) => x.name === "resume_scheduled_task");
	const result = await resume.execute("t", { id: "task-1" });
	assert.equal(tasks[0].fired, 1, "owner (not the creator) resumes the chain");
	assert.ok(!JSON.stringify(result).includes("refused"), "not refused");

	// Low-privilege boundary: a non-creator viewer is still refused.
	const tasks2 = [JSON.parse(JSON.stringify(chainTask))];
	const tools2 = createSchedulerTools(schedulerStub(tasks2), "dt:single:v", "dt:single:v", config,
		() => ({ senderId: "random-viewer", channel: "dingtalk", chatType: "single", text: "继续" }));
	const resume2 = tools2.find((x) => x.name === "resume_scheduled_task");
	const result2 = await resume2.execute("t", { id: "task-1" });
	assert.equal(tasks2[0].fired, undefined, "viewer does not fire the chain");
	assert.ok(JSON.stringify(result2).includes("需要管理员或任务创建人"), "viewer refusal preserved");
});

test("scheduler CREATE describes an owner's unattended identity as admin-tier scope", async (t) => {
	const config = dbWithRoles(t);
	const tasks = [];
	const sched = schedulerStub(tasks);
	sched.create = (input) => {
		const task = { id: "task-2", enabled: 1, next_run_at: "2026-01-01T00:00:00", ...input };
		tasks.push(task);
		return task;
	};
	const tools = createSchedulerTools(sched, "dt:single:o", "dt:single:o", config,
		() => ({ senderId: "the-owner", channel: "dingtalk", chatType: "single", text: "建一个" }));
	const create = tools.find((x) => x.name === "create_scheduled_task");
	const result = await create.execute("t", { title: "巡检", prompt: "做巡检", cron: "0 9 * * *" });
	const text = JSON.stringify(result);
	// The unattended identity used to be described as "仅对话与知识库" for owner —
	// a display of the very demotion this fix removes.
	assert.ok(text.includes("完整命令"), "owner's unattended identity reads as admin-tier scope");
	assert.ok(!text.includes("仅对话与知识库"), "no viewer-tier wording for owner");
});
