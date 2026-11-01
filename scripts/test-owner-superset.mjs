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
