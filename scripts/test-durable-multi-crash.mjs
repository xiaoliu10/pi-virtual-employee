/**
 * Acceptance: TWO conversations killed mid-tool are both continued after a
 * restart, through VE's own durable runtime (not a bare Harness probe).
 *
 * The field incident was exactly this shape — two tasks in flight when an
 * upgrade restarted the app — so a single-conversation probe cannot close it.
 *
 * What this pins (each assertion has failed at least once during development):
 *   1. both conversations had started and were mid-tool at kill time,
 *   2. after reopen, BOTH finish without anyone calling send() again,
 *   3. each finish reports to its OWN conversation (no cross-wiring),
 *   4. the interrupted unsafe tool never runs again (`unsafe-rerun` absent),
 *   5. the completed safe tool never runs again,
 *   6. each transcript holds exactly one user turn + one answer (idempotent
 *      projection — a duplicate would show as two assistant rows).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.durable-multi-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "runtime.mjs");
await build({
	stdin: {
		contents: 'export { DurableRuntime } from "./src/engine/durable/runtime.ts"; export { HistoryStore } from "./src/db/history-store.ts";',
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});

const child = join(root, "scripts", "fixtures", "durable-multi-crash-child.mjs");
const eventsPath = join(dir, "events.log");
const dataDir = join(dir, "profile");
const spawnChild = (phase) =>
	spawn(process.execPath, [child, dataDir, phase, eventsPath, bundle], { stdio: "inherit" });

const waitForLine = async (marker, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = await readFile(eventsPath, "utf8").catch(() => "");
		if (text.includes(`${marker}\n`) || text.endsWith(marker)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${marker}`);
};

test("two interrupted conversations both continue after a restart", async () => {
	const first = spawnChild("start");
	await waitForLine("unsafe-start:dingtalk:alpha");
	await waitForLine("unsafe-start:dingtalk:beta"); // BOTH live at kill time
	first.kill("SIGKILL");
	await new Promise((resolve) => first.on("exit", resolve));

	const before = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
	assert.equal(before.filter((e) => e.startsWith("safe:")).length, 2, "both conversations finished their safe step once");

	const second = spawnChild("resume");
	const code = await new Promise((resolve) => second.on("exit", resolve));
	assert.equal(code, 0, "the resume process exits cleanly");

	const after_ = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
	// 1+2: both were pending and both finished on their own.
	assert.equal(after_.filter((e) => e === "recovered-count:2").length, 1, "BOTH conversations must be continued after the restart");
	// 3: each answer went to its own conversation.
	assert.ok(after_.some((e) => e.startsWith("recovered:dingtalk:alpha|recovered done|durable:")), "alpha's answer must report to alpha");
	assert.ok(after_.some((e) => e.startsWith("recovered:dingtalk:beta|recovered done|durable:")), "beta's answer must report to beta");
	assert.equal(after_.filter((e) => e.startsWith("redeliver:dingtalk:alpha")).length, 1, "alpha redelivered exactly once");
	assert.equal(after_.filter((e) => e.startsWith("redeliver:dingtalk:beta")).length, 1, "beta redelivered exactly once");
	// 4: the interrupted unsafe call must never run again.
	assert.equal(after_.filter((e) => e.startsWith("unsafe-rerun:")).length, 0, "CRITICAL: an interrupted unsafe tool must not run again");
	// 5: the completed safe call must never run again.
	assert.equal(after_.filter((e) => e.startsWith("safe:")).length, 2, "CRITICAL: a completed tool must not re-run");
	// 6: idempotent projection — one user turn + one answer per conversation.
	assert.ok(after_.includes("history:dingtalk:alpha:user,assistant"), "alpha must hold exactly one user turn and one answer");
	assert.ok(after_.includes("history:dingtalk:beta:user,assistant"), "beta must hold exactly one user turn and one answer");
	assert.ok(after_.includes("answer:dingtalk:alpha:recovered done"), "alpha's projected answer must be the recovered reply");
	assert.ok(after_.includes("answer:dingtalk:beta:recovered done"), "beta's projected answer must be the recovered reply");
});
