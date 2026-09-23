/** Run with npm run test:shell. Uses an isolated SQLite DB and real child processes. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Keep external package resolution under the project's node_modules. No app data is opened.
const workDir = await mkdtemp(join(root, "node_modules/.shell-timeout-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "tools.mjs");
await build({
	stdin: {
		contents: `
			export { ConfigStore } from "./src/db/config-store.ts";
			export { createRunCommandTool, createManageProcessTool, disposeShellCommands, hasActiveShellCommands } from "./src/engine/tools/shell.ts";
			export { createManageSettingsTool } from "./src/engine/tools/settings.ts";
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
const { ConfigStore, createRunCommandTool, createManageProcessTool, createManageSettingsTool, disposeShellCommands, hasActiveShellCommands } = await import(pathToFileURL(bundle).href);
await writeFile(join(workDir, "command.cjs"), `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
if (process.argv[2] === "tree") {
	spawn(process.execPath, [__filename, "leaf", process.argv[3]], { stdio: "inherit" });
	setTimeout(() => {}, 4000);
} else if (process.argv[2] === "leaf") {
	console.log("descendant started");
	setTimeout(() => writeFileSync(process.argv[3], "survived"), 2000);
} else if (process.argv[2] === "flood") {
	process.stdout.write("中🙂".repeat(80000));
	process.stdout.write("stdout finished\\n");
	process.stderr.write("stderr finished\\n");
} else {
	console.log("started");
	setTimeout(() => console.log("finished"), Number(process.argv[2]));
}
`);

function fixture(t) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	t.after(() => { disposeShellCommands(config); db.close(); });
	config.replaceAll({
		security: { adminStaffIds: ["test-admin"] },
		capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
	});
	const actor = { channel: "dingtalk", chatType: "single", senderId: "test-admin", text: "确认" };
	const deps = { config, resolveActor: () => actor, onConfigChanged: () => {}, conversationId: "test:timeout" };
	const tool = createRunCommandTool(deps);
	const processTool = createManageProcessTool(deps);
	return {
		db, config, actor, deps, tool, processTool,
		run: (ms = 1250) => tool.execute("test-run", { command: `node command.cjs ${ms}`, workingDir: workDir }),
		background: (ms = 1500) => tool.execute("test-background", { command: `node command.cjs ${ms}`, workingDir: workDir, background: true }),
	};
}

test("new and legacy configs persist the 60-second default without losing shell settings", (t) => {
	const { db, config } = fixture(t);
	assert.equal(config.all().capabilities.shell.timeoutSec, 60);
	const legacy = config.all();
	delete legacy.capabilities.shell.timeoutSec;
	db.prepare("UPDATE config SET value = ? WHERE key = 'appconfig'").run(JSON.stringify(legacy));
	assert.deepEqual(new ConfigStore(db).all().capabilities.shell, {
		enabled: true, allowedCommands: ["node"], timeoutSec: 60, backgroundTimeoutSec: 0, pollTimeoutSec: 30,
	});
	const persisted = JSON.parse(db.prepare("SELECT value FROM config WHERE key = 'appconfig'").get().value);
	assert.equal(persisted.capabilities.shell.timeoutSec, 60);
});

test("timeout values survive updates, reloads and imports, with safe invalid-value handling", (t) => {
	const { config, db } = fixture(t);
	for (const [value, expected] of [
		[600, 600], [0, 0], [1, 1], [1.9, 1], [0.5, 1],
		[-1, 60], [NaN, 60], [Infinity, 60], [null, 60], ["600", 60], [false, 60],
		[2_147_483, 2_147_483], [Number.MAX_VALUE, 2_147_483],
	]) {
		config.update({ capabilities: { shell: { timeoutSec: value } } });
		assert.equal(new ConfigStore(db).all().capabilities.shell.timeoutSec, expected, String(value));
	}
	config.update({ capabilities: { shell: { timeoutSec: 600 } } });
	config.update({ capabilities: { shell: { enabled: false } } });
	assert.equal(config.all().capabilities.shell.timeoutSec, 600);
	const exported = config.all();
	config.replaceAll({});
	assert.equal(config.all().capabilities.shell.timeoutSec, 60);
	config.replaceAll(exported);
	assert.equal(config.all().capabilities.shell.timeoutSec, 600);
});

test("admin settings change the next invocation of an existing run_command tool", async (t) => {
	const { deps, config, run } = fixture(t);
	const settings = createManageSettingsTool(deps);
	const result = await settings.execute("set-timeout", { action: "set", path: "capabilities.shell.timeoutSec", value: 1 });
	assert.equal(result.details.newValue, 1);
	const timedOut = await run();
	assert.equal(timedOut.details.timedOut, true);
	assert.equal(timedOut.details.code, null);
	assert.match(timedOut.content[0].text, /超过 1 秒/);
	assert.match(timedOut.content[0].text, /capabilities\.shell\.timeoutSec/);
	config.update({ capabilities: { shell: { timeoutSec: 3 } } });
	const completed = await run();
	assert.equal(completed.details.timedOut, false);
	assert.equal(completed.details.code, 0);
	assert.equal(completed.details.timeoutSec, 3);
	assert.match(completed.content[0].text, /finished/);
});

test("timeout edits require a confirmed admin in an IM single chat", async (t) => {
	const { deps, config, actor } = fixture(t);
	const settings = createManageSettingsTool(deps);
	for (const patch of [
		{ senderId: "non-admin", text: "确认", chatType: "single", channel: "dingtalk" },
		{ senderId: "test-admin", text: "请修改超时", chatType: "single", channel: "dingtalk" },
		{ senderId: "test-admin", text: "确认", chatType: "group", channel: "dingtalk" },
		{ senderId: "test-admin", text: "确认", chatType: "single", channel: "scheduler" },
	]) {
		Object.assign(actor, patch);
		const result = await settings.execute("denied-edit", { action: "set", path: "capabilities.shell.timeoutSec", value: 600 });
		assert.equal(result.details.refused, true);
		assert.equal(config.all().capabilities.shell.timeoutSec, 60);
	}
});

test("longer and unlimited runs survive the former 60-second deadline", async (t) => {
	const { config, run } = fixture(t);
	// Advance only the parent's timeout clock; real child processes finish normally.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const timeoutSec of [120, 0]) {
		config.update({ capabilities: { shell: { timeoutSec } } });
		const pending = run(50);
		t.mock.timers.tick(61_000);
		const result = await pending;
		assert.equal(result.details.timedOut, false, `timeoutSec=${timeoutSec}`);
		assert.equal(result.details.code, 0);
		assert.match(result.content[0].text, /finished/);
	}
});

test("a running command keeps its starting limit after the config changes", async (t) => {
	const { config, run } = fixture(t);
	config.update({ capabilities: { shell: { timeoutSec: 1 } } });
	const pending = run();
	config.update({ capabilities: { shell: { timeoutSec: 0 } } });
	assert.equal((await pending).details.timedOut, true);
});

test("scheduled runs enforce the configured timeout and record it in the audit", async (t) => {
	const { config, actor, deps } = fixture(t);
	actor.channel = "scheduler";
	actor.text = "scheduled task";
	config.update({ capabilities: { shell: { timeoutSec: 1 } } });
	const auditLogPath = join(workDir, "audit.log");
	const tool = createRunCommandTool({ ...deps, conversationId: "sched:timeout", auditLogPath });
	const result = await tool.execute("test-scheduled-run", { command: "node command.cjs 1250", workingDir: workDir });
	assert.equal(result.details.timedOut, true);
	const events = (await readFile(auditLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(events.map(({ event, timeoutSec }) => [event, timeoutSec]), [["start", 1], ["finish", 1]]);
	assert.equal(events[0].channel, "scheduler");
});

test("a configured timeout still terminates descendant processes", async (t) => {
	const { config, tool } = fixture(t);
	config.update({ capabilities: { shell: { timeoutSec: 1 } } });
	const marker = join(workDir, "descendant-survived.txt");
	const result = await tool.execute("test-tree", { command: "node command.cjs tree descendant-survived.txt", workingDir: workDir });
	assert.equal(result.details.timedOut, true);
	assert.match(result.content[0].text, /descendant started/);
	await delay(2200);
	assert.equal(existsSync(marker), false, "descendant must be killed before it writes the marker");
});

test("background polling yields without killing the process and reads incremental output after tool rebuild", async (t) => {
	const { deps, config, actor, background } = fixture(t);
	const settings = createManageSettingsTool(deps);
	for (const [key, value] of [["timeoutSec", 1], ["backgroundTimeoutSec", 0], ["pollTimeoutSec", 1]]) {
		const result = await settings.execute("set", { action: "set", path: `capabilities.shell.${key}`, value });
		assert.equal(result.details.newValue, value);
	}
	const started = await background(1800);
	assert.equal(started.details.status, "running");
	assert.ok(started.details.sessionId);
	assert.ok(started.details.pid);
	assert.equal(hasActiveShellCommands(config), true);
	actor.text = "查看进度"; // no repeated confirmation for supervision
	const processTool = createManageProcessTool(deps);
	const sessionId = started.details.sessionId;
	const waiting = await processTool.execute("poll", { action: "poll", sessionId, offset: 0 });
	assert.equal(waiting.details.status, "running");
	assert.match(waiting.details.output, /started/);
	assert.equal(waiting.details.timeoutSec, 0);
	const finished = await processTool.execute("poll", { action: "poll", sessionId, waitSec: 3, offset: waiting.details.nextOffset });
	assert.equal(finished.details.status, "exited");
	assert.equal(finished.details.code, 0);
	assert.match(finished.details.output, /finished/);
	assert.doesNotMatch(finished.details.output, /started/);
	assert.equal(hasActiveShellCommands(config), false);
});

test("the original 60-second limit does not terminate default background sessions", async (t) => {
	const { background, processTool } = fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const started = await background(100);
	t.mock.timers.tick(61_000);
	const result = await processTool.execute("poll", { action: "poll", sessionId: started.details.sessionId, waitSec: 10 });
	assert.equal(result.details.timedOut, false);
	assert.equal(result.details.code, 0);
});

test("background runtime limit is independent of the poll wait and the synchronous limit", async (t) => {
	const { config, background, processTool } = fixture(t);
	config.update({ capabilities: { shell: { timeoutSec: 0, backgroundTimeoutSec: 1 } } });
	const started = await background();
	// Changes apply to new commands only.
	config.update({ capabilities: { shell: { backgroundTimeoutSec: 0 } } });
	const result = await processTool.execute("poll", { action: "poll", sessionId: started.details.sessionId, waitSec: 3 });
	assert.equal(result.details.status, "timed_out");
	assert.equal(result.details.timeoutSec, 1);
	assert.match(result.content[0].text, /backgroundTimeoutSec/);
});

test("cancelling a long poll leaves the process running; confirmed kill terminates its tree", async (t) => {
	const { tool, actor, processTool, config } = fixture(t);
	const started = await tool.execute("tree", { command: "node command.cjs tree background-descendant.txt", workingDir: workDir, background: true });
	const sessionId = started.details.sessionId;
	const initial = await processTool.execute("poll", { action: "poll", sessionId, waitSec: 1 });
	assert.match(initial.details.output, /descendant started/);
	actor.text = "查看进度";
	const abort = new AbortController();
	const pending = processTool.execute("poll", { action: "poll", sessionId, waitSec: 840 }, abort.signal);
	abort.abort();
	assert.equal((await pending).details.status, "running");
	assert.equal(hasActiveShellCommands(config), true);
	assert.equal((await processTool.execute("kill", { action: "kill", sessionId })).details.refused, true);
	for (const text of ["确认，但不要停止", "确认，不能终止", "yes, do not stop"]) {
		actor.text = text;
		assert.equal((await processTool.execute("kill", { action: "kill", sessionId })).details.refused, true);
	}
	actor.text = "确认终止这个任务";
	const killed = await processTool.execute("kill", { action: "kill", sessionId });
	assert.equal(killed.details.status, "killed");
	await delay(2200);
	assert.equal(existsSync(join(workDir, "background-descendant.txt")), false);
});

test("process sessions remain private to the verified admin, channel and conversation", async (t) => {
	const { deps, config, actor, background, processTool } = fixture(t);
	const { details: { sessionId } } = await background(100);
	config.update({ security: { adminStaffIds: ["test-admin", "another-admin"] } });
	for (const patch of [
		{ senderId: "another-admin", channel: "dingtalk", chatType: "single" },
		{ senderId: "test-admin", channel: "feishu", chatType: "single" },
	]) {
		Object.assign(actor, patch);
		assert.equal((await processTool.execute("log", { action: "log", sessionId })).details.refused, true);
	}
	// Group chats are allowed since the 1:1-only gate was removed (user ruling
	// 2026-09-23): same verified admin in the same conversation reads fine —
	// privacy is scoped by owner+channel+conversation, not by chat type.
	Object.assign(actor, { senderId: "test-admin", channel: "dingtalk", chatType: "group" });
	assert.equal((await processTool.execute("log", { action: "log", sessionId })).details.refused, undefined);
	Object.assign(actor, { senderId: "test-admin", channel: "dingtalk", chatType: "single", text: "查看状态" });
	const otherConversation = createManageProcessTool({ ...deps, conversationId: "other:conversation" });
	assert.equal((await otherConversation.execute("log", { action: "log", sessionId })).details.refused, true);
	assert.equal((await otherConversation.execute("list", { action: "list" })).details.sessions.length, 0);
	config.update({ security: { adminStaffIds: ["another-admin"] } });
	assert.equal((await processTool.execute("log", { action: "log", sessionId })).details.refused, true);
	config.update({ security: { adminStaffIds: ["test-admin"] }, capabilities: { shell: { enabled: false } } });
	// Disabling new launches does not prevent supervising existing commands.
	assert.equal((await processTool.execute("poll", { action: "poll", sessionId, waitSec: 1 })).details.code, 0);
});

test("log paging retains the latest output, drains both streams and preserves UTF-8 boundaries", async (t) => {
	const { background, processTool } = fixture(t);
	const { details: { sessionId } } = await background("flood");
	const result = await processTool.execute("poll", { action: "poll", sessionId, waitSec: 3, offset: 0 });
	assert.equal(result.details.code, 0);
	assert.equal(result.details.truncated, true);
	assert.ok(result.details.offset > 0);
	let page = result;
	let output = "";
	do {
		assert.doesNotMatch(page.content[0].text, /\uFFFD/);
		const text = page.content[0].text;
		output += text.slice(text.indexOf("\n\n") + 2);
		if (!page.details.hasMore) break;
		const next = await processTool.execute("log", { action: "log", sessionId, offset: page.details.nextOffset });
		assert.ok(next.details.nextOffset > page.details.nextOffset);
		page = next;
	} while (true);
	assert.ok(output.includes("stdout finished"), `stdout tail missing: ${output.slice(-100)}`);
	assert.ok(output.includes("stderr finished"), `stderr tail missing: ${output.slice(-100)}`);
	assert.equal(page.details.nextOffset, page.details.totalBytes);
});

test("background startup failures and nonzero exits remain visible", async (t) => {
	const { tool, processTool } = fixture(t);
	const failed = await tool.execute("bad-dir", { command: "node command.cjs 1", workingDir: join(workDir, "missing-dir"), background: true });
	assert.equal(failed.details.status, "failed");
	assert.match(failed.details.output, /无法启动命令/);
	const missing = await tool.execute("bad-script", { command: "node missing-script.cjs", workingDir: workDir, background: true });
	const finished = await processTool.execute("poll", { action: "poll", sessionId: missing.details.sessionId, waitSec: 3 });
	assert.equal(finished.details.status, "exited");
	assert.notEqual(finished.details.code, 0);
	assert.match(finished.details.output, /MODULE_NOT_FOUND/);
});

test("application shutdown ends command supervision and removes retained sessions", async (t) => {
	const { config, background, processTool } = fixture(t);
	await background();
	assert.equal(hasActiveShellCommands(config), true);
	disposeShellCommands(config);
	assert.equal(hasActiveShellCommands(config), false);
	assert.equal((await processTool.execute("list", { action: "list" })).details.sessions.length, 0);
});

// Field 2026-09-23: an SLS triage needed run_command FROM THE GROUP where the
// task lived, but the gate refused every non-single chat. User ruling: drop the
// 1:1-only gate — identity, role tiering, and the explicit 「确认」 hold in
// groups exactly as in single chats.
test("run_command works from a group chat: admin+confirm executes, viewer is refused", async (t) => {
	const { tool, actor, config } = fixture(t);
	Object.assign(actor, { chatType: "group", conversationId: "dt:group:ops" });

	const done = await tool.execute("g1", { command: "node command.cjs 10", workingDir: workDir });
	assert.equal(done.details.refused, undefined, "admin + 确认 in a group runs the command");
	assert.match(done.content[0].text, /finished/);

	// No confirmation in the current message → still refused, same as single chat.
	const prev = actor.text;
	actor.text = "跑一下这个";
	const unconfirmed = await tool.execute("g2", { command: "node command.cjs 10", workingDir: workDir });
	assert.equal(unconfirmed.details.refused, true);
	assert.match(unconfirmed.content[0].text, /确认/);
	actor.text = prev;

	// Viewer in a group is refused on role, exactly as in single chat.
	Object.assign(actor, { senderId: "peasant", text: "确认" });
	config.update({ security: { people: [{ staffId: "peasant", role: "viewer" }] } });
	const denied = await tool.execute("g3", { command: "node command.cjs 10", workingDir: workDir });
	assert.equal(denied.details.refused, true);
	assert.match(denied.content[0].text, /没有命令执行权限/);
});
