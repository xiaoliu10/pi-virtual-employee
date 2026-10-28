#!/usr/bin/env node
/**
 * Real cross-process crash recovery: SIGKILL a running durable conversation and
 * prove the restarted process resumes it without repeating a completed tool.
 *
 * The in-process test in `test-durable-recovery.mjs` covers the storage and
 * adapter contracts; THIS one covers what the field incident actually was — the
 * process dies (upgrade / kill) while a tool is executing.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = join(root, "scripts/fixtures/durable-crash-child.mjs");
const dir = await mkdtemp(join(root, "node_modules/.durable-crash-"));
after(() => rm(dir, { recursive: true, force: true }));

const dbPath = join(dir, "crash.sqlite");
const eventsPath = join(dir, "events.log");

function spawnChild(phase) {
	return spawn(process.execPath, [child, dbPath, phase, eventsPath], { stdio: "inherit" });
}

async function waitForEvent(marker, timeoutMs = 20_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(eventsPath)) {
			const lines = (await readFile(eventsPath, "utf8")).split("\n");
			if (lines.includes(marker)) return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${marker}`);
}

test("a SIGKILL mid-tool resumes the run and never repeats the completed call", async () => {
	const first = spawnChild("start");
	let killed = false;
	try {
		// The child records step 1, then blocks inside the unsafe step 2.
		await waitForEvent("external");
		first.kill("SIGKILL");
		killed = true;
	} finally {
		if (!killed) first.kill("SIGKILL");
	}
	await new Promise((resolve) => first.on("exit", resolve));

	const before = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
	assert.equal(before.filter((e) => e === "completed").length, 1, "step 1 ran once before the crash");
	assert.equal(before.filter((e) => e === "external").length, 1, "step 2 started before the crash");

	// Restarted process: recovery must resume, not replay step 1.
	const second = spawnChild("resume");
	const code = await new Promise((resolve) => second.on("exit", resolve));
	assert.equal(code, 0, "the resume process exits cleanly");

	const after = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
	assert.equal(
		after.filter((e) => e === "completed").length,
		1,
		"CRITICAL: recovery must NOT re-run the already-completed tool",
	);
	assert.equal(
		after.filter((e) => e === "external").length,
		1,
		"CRITICAL: an interrupted unsafe tool must NOT be silently retried",
	);
	// The restarted process must have found UNFINISHED work. Without this, "it
	// recovered" could mean "it started clean and ran something new" — a mutant
	// that skips resume() produced byte-identical final output, because
	// submission.wait() itself starts scheduling (verified by mutation).
	assert.ok(
		after.includes("pre-resume-pending:1"),
		"the restarted process must see the interrupted submission as pending",
	);
	// The submission must reach a DEFINITE terminal state. Accepting any
	// `settled:*` made this assertion vacuous: a mutant that never called
	// harness.resume() still recorded `settled:unknown` and passed (review finding).
	const settled = after.filter((e) => e.startsWith("settled:")).map((e) => e.slice("settled:".length));
	assert.ok(settled.length > 0, "the pending submission reached a terminal state after recovery");
	for (const status of settled) {
		assert.ok(
			["done", "failed", "unanswered"].includes(status),
			`recovery must produce a definite outcome, got "${status}"`,
		);
	}
	// The interrupted call's outcome must be IN the recovered context — otherwise
	// "recovered" could just mean "silently dropped".
	assert.ok(
		after.includes("interrupted-in-context:true"),
		"the recovered transcript must carry the interrupted tool's outcome",
	);
});
