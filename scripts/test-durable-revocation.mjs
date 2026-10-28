/**
 * Revocation reaches a RECOVERED run.
 *
 * The security question a crash-recovery feature must answer is not "does the
 * role check run" but "does it run against the CURRENT config, at call time, in
 * the process that resumed the work" — an in-memory role captured before the
 * crash would silently keep old authority after a demotion.
 *
 * Scenario (real two-process run, same as the multi-crash acceptance):
 *   start   a person who IS an admin calls a guarded tool, then blocks in an
 *           unsafe step so the process can be killed.
 *   mutate  the config row is edited BETWEEN the two processes: the person is
 *           removed from admin (exactly what an operator does on demotion).
 *   resume  the recovered run must be DENIED — the durable document stores the
 *           staff id REFERENCE, never the role.
 *
 * The negative control lives in the same run: a still-admin person's recovered
 * run must be ALLOWED, so a blanket "deny everything after restart" cannot pass.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.durable-revoke-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "runtime.mjs");
await build({
	stdin: {
		contents: `export { DurableRuntime } from "./src/engine/durable/runtime.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { checkPermission, resolveRole } from "./src/security/permissions.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});

const child = join(root, "scripts", "fixtures", "durable-revoke-child.mjs");
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

test("a demoted person loses the guarded capability on the RECOVERED run", async () => {
	const first = spawnChild("start");
	await waitFor("blocked:demoted-person");
	await waitFor("blocked:still-admin");
	first.kill("SIGKILL");
	await new Promise((resolve) => first.on("exit", resolve));

	const second = spawnChild("resume");
	const code = await new Promise((resolve) => second.on("exit", resolve));
	assert.equal(code, 0, "resume process exits cleanly");

	const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
	// The demoted caller must be refused AFTER recovery.
	assert.ok(
		events.includes("denied:demoted-person"),
		"CRITICAL: a demoted person must not keep admin authority on a recovered run",
	);
	// Negative control: an admin who is STILL admin keeps working.
	assert.ok(
		events.includes("allowed:still-admin"),
		"control failed: a still-authorised person must not be blocked after recovery",
	);
	// The role must be re-derived, not read from the persisted document.
	assert.ok(events.includes("role:demoted-person:viewer"), "recovered role must be recomputed from current config");
	assert.ok(events.includes("role:still-admin:admin"), "the control person's role must still resolve as admin");
});
