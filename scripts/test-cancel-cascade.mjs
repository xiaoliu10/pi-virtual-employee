/** Task-cancel resource cascade (field 2026-11-06: a cancelled task's query
 * script + browser kept running 15–20min and held spay_profile, blocking every
 * later login with PROFILE_MASTER_BUSY).
 *
 * stopBackgroundProcesses kills ONLY the conversation's own running processes
 * (tree kill takes child browsers with them); abortSession cascades on every
 * path incl. the durable early-return. Real processes via the real run_command
 * factory; no mocks of the registry itself. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.cascade-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const bundle = join(dir, "c.mjs");
await build({
	stdin: {
		contents: `
			export { stopBackgroundProcesses, runningBackgroundProcesses, createRunCommandTool } from "./src/engine/tools/shell.ts";
			export { EmployeeEngine } from "./src/engine/engine.ts";
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
const { stopBackgroundProcesses, runningBackgroundProcesses, createRunCommandTool, EmployeeEngine } = await import(pathToFileURL(bundle).href);

function fakeConfig() {
	return {
		all: () => ({
			capabilities: { shell: { enabled: true, timeoutSec: 60, backgroundTimeoutSec: 0, pollTimeoutSec: 1 } },
			security: { adminStaffIds: ["admin"], ownerStaffIds: [], people: [], defaultRole: "viewer", adminFullAccess: true },
		}),
	};
}

function runCommandFor(config, conversationId) {
	return createRunCommandTool({
		config,
		conversationId,
		resolveActor: () => ({ senderId: "admin", channel: "scheduler", chatType: "single" }),
		onConfigChanged: () => {},
	});
}

test("cancel cascade: a conversation's running background processes are tree-killed; others are spared", async () => {
	const config = fakeConfig();
	const mine = runCommandFor(config, "work:task-1");
	const other = runCommandFor(config, "work:task-2");
	const start = await mine.execute("t1", { command: 'node -e "setTimeout(()=>{},60000)"', background: true });
	assert.match(start.content[0].text, /pid=/, "background process started");
	await other.execute("t2", { command: 'node -e "setTimeout(()=>{},60000)"', background: true });
	assert.equal(runningBackgroundProcesses(config, "work:task-1").length, 1);
	assert.equal(runningBackgroundProcesses(config, "work:task-2").length, 1);

	const killed = stopBackgroundProcesses(config, "work:task-1");
	assert.equal(killed.length, 1, "exactly the cancelled conversation's process is stopped");
	assert.ok(killed[0].sessionId && killed[0].command.includes("node"), "audit entry carries sessionId+command");
	assert.equal(runningBackgroundProcesses(config, "work:task-1").length, 0, "cancelled conversation has no running process left");
	assert.equal(runningBackgroundProcesses(config, "work:task-2").length, 1, "OTHER conversation's process must be spared");
	// cleanup the spared one too so no test process leaks
	stopBackgroundProcesses(config, "work:task-2");
});

test("cascade on a conversation with nothing running is a no-op", () => {
	assert.deepEqual(stopBackgroundProcesses(fakeConfig(), "dt:empty"), []);
});

test("abortSession cascades BEFORE the durable early-return (regression: resource cleanup must not be skipped)", async () => {
	const config = fakeConfig();
	await runCommandFor(config, "work:doomed").execute("t1", { command: 'node -e "setTimeout(()=>{},60000)"', background: true });
	assert.equal(runningBackgroundProcesses(config, "work:doomed").length, 1);
	const engine = Object.create(EmployeeEngine.prototype);
	engine.config = config;
	engine.durableRuntime = { abort: () => true };
	engine.sessions = new Map();
	engine.turnIds = new Set();
	engine.turnAborts = new Map();
	engine.hostByAgent = new Map();
	assert.equal(engine.abortSession("work:doomed"), true, "durable abort still returns true");
	assert.equal(runningBackgroundProcesses(config, "work:doomed").length, 0, "the durable early-return must NOT skip the cascade");
});
