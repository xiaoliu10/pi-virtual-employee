/**
 * Upgrade acceptance: work interrupted by an APP UPDATE keeps going.
 *
 * This is the incident the whole feature exists for — the user was mid-task in
 * two conversations when an upgrade restarted the app, and both tasks were lost.
 * It is a DIFFERENT path from the crash tests: the update path closes the runtime
 * on purpose (`prepareToInstall` → `close()`), so recovery must treat a graceful
 * close exactly like a crash when a run was mid-tool.
 *
 * What this pins:
 *   1. `close()` during a live tool leaves the submission recoverable (not
 *      silently settled, not marked done),
 *   2. reopening continues that run — the interrupted unsafe tool does NOT run
 *      again, the already-completed safe tool does NOT run again,
 *   3. the recovered answer is delivered to the conversation exactly once.
 *
 * The update's bounded close (`Promise.race([close, 8s])`) is part of the path
 * under test: if close exceeds its bound the process dies right after, which is
 * the crash case — so the assertion is simply "either way, the work resumes".
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.durable-upgrade-"));
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

const child = join(root, "scripts", "fixtures", "durable-upgrade-child.mjs");
const eventsPath = join(dir, "events.log");
const dataDir = join(dir, "profile");
const spawnChild = (phase) => spawn(process.execPath, [child, dataDir, phase, eventsPath, bundle], { stdio: "inherit" });

const waitFor = async (marker, timeoutMs = 25_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = await readFile(eventsPath, "utf8").catch(() => "");
		if (text.split("\n").includes(marker)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${marker}`);
};

test("an upgrade during a live tool does not lose the work", async () => {
	// Phase 1 runs like the app: work starts, then the update path calls close().
	const first = spawnChild("upgrade");
	await waitFor("blocked");
	await waitFor("close-called");
	await new Promise((resolve) => first.on("exit", resolve));

	const before = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
	assert.ok(before.includes("blocked"), "the run must be mid-tool when the update closes the runtime");

	// Phase 2 = the newly installed version starting up.
	const second = spawnChild("resume");
	const code = await new Promise((resolve) => second.on("exit", resolve));
	assert.equal(code, 0, "the restarted app exits cleanly");

	const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
	assert.equal(
		events.filter((e) => e === "recovered-count:1").length,
		1,
		"CRITICAL: an upgrade must not lose the interrupted run",
	);
	assert.equal(
		events.filter((e) => e.startsWith("unsafe-rerun")).length,
		0,
		"CRITICAL: the interrupted unsafe tool must not run again after the upgrade",
	);
	assert.equal(
		events.filter((e) => e.startsWith("safe:")).length,
		1,
		"CRITICAL: the completed tool must not re-run after the upgrade",
	);
	assert.ok(events.includes("recovered:chat:upgrade:升级后继续完成"), "the recovered answer must be delivered once");
	assert.ok(events.includes("history:chat:upgrade:user,assistant"), "exactly one user turn and one answer in the transcript");
});
