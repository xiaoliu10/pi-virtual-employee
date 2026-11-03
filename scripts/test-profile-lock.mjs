import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
mkdirSync(join(root, "node_modules/.lock-probe"), { recursive: true });
await build({
	entryPoints: [join(root, "electron/profile-lock.ts")],
	bundle: true, format: "esm", platform: "node",
	outfile: join(root, "node_modules/.lock-probe/profile-lock.mjs"),
	external: ["electron"],
	logLevel: "silent",
});
const lock = await import(pathToFileURL(join(root, "node_modules/.lock-probe/profile-lock.mjs")).href);
const { decideLock, formatLock, parseLock } = lock;

/** Identity helper: a process that is NOT us, so token comparison never short-circuits. */
const other = (pid, start, token = "held-token") => ({ pid, startTimeMs: start, token });
const mine = { pid: process.pid, startTimeMs: 1_000, token: "mine" };

test("format/parse round-trips and rejects the legacy pid-only form", () => {
	assert.equal(formatLock({ pid: 42, startTimeMs: 1700, token: "t" }), "42|1700|t");
	assert.deepEqual(parseLock("42|1700|t"), { pid: 42, startTimeMs: 1700, token: "t" });
	assert.deepEqual(parseLock("42||t"), { pid: 42, startTimeMs: null, token: "t" });
	// Legacy `1234` (v0.2.184 and earlier) → null → treated as stale.
	assert.equal(parseLock("1234"), null);
	assert.equal(parseLock("nonsense|x|y"), null);
	assert.equal(parseLock("42|1700|"), null);
});

test("no lock file → acquire", () => {
	assert.deepEqual(decideLock(null, mine), { action: "acquire" });
});

test("stale legacy lock (pid-only) is reclaimed", () => {
	assert.deepEqual(decideLock("999999", mine), { action: "acquire" });
});

test("DEFECT 1: EPERM (cross-session live process) must REFUSE, not reclaim", () => {
	// Field 2026-11-02: the updater launched the instance in another Windows
	// session; process.kill(pid,0) threw EPERM and the old code reclaimed the
	// lock of a RUNNING instance → two writers on one SQLite DB.
	const deps = { isProcessAlive: () => true }; // EPERM maps to alive=true
	const d = decideLock(formatLock(other(4321, 1_700)), mine, deps);
	assert.equal(d.action, "refuse");
	assert.equal(d.pid, 4321);
});

test("DEFECT 2: PID reuse (alive pid, different start time) is reclaimed", () => {
	// Synapse refused to start 2026-11-02: a stale lock's pid had been recycled.
	const deps = {
		isProcessAlive: () => true,
		startTimeOf: () => 9_999, // pid now belongs to a different process
	};
	const d = decideLock(formatLock(other(4321, 1_700)), mine, deps);
	assert.equal(d.action, "acquire");
});

test("same pid, same start time → genuinely running → refuse", () => {
	const deps = { isProcessAlive: () => true, startTimeOf: () => 1_700 };
	assert.equal(decideLock(formatLock(other(4321, 1_700)), mine, deps).action, "refuse");
});

test("definitely dead holder (ESRCH) is reclaimed", () => {
	const deps = { isProcessAlive: () => false };
	assert.equal(decideLock(formatLock(other(4321, 1_700)), mine, deps).action, "acquire");
});

test("indeterminate probe with no shared identity does not hard-block startup", () => {
	// A platform that cannot probe must not wedge the app forever.
	const deps = { isProcessAlive: () => null };
	assert.equal(decideLock(formatLock(other(4321, 1_700)), mine, deps).action, "acquire");
});

test("indeterminate probe whose identity equals ours refuses (same process re-entry)", () => {
	const deps = { isProcessAlive: () => null };
	const held = formatLock({ pid: 4321, startTimeMs: 1_000, token: "other-token" });
	assert.equal(decideLock(held, mine, deps).action, "refuse");
});

test("our own token re-entering acquires (idempotent)", () => {
	const selfLock = formatLock({ pid: 4321, startTimeMs: 1_700, token: mine.token });
	assert.deepEqual(decideLock(selfLock, mine, { isProcessAlive: () => true }), { action: "acquire" });
});

test("DEFECT 3: release only removes OUR lock (never the successor's)", async () => {
	const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { releaseProfileLock, acquireProfileLock } = lock;

	const dir = mkdtempSync(join(tmpdir(), "ve-lock-"));
	const lockPath = join(dir, ".profile.lock");

	// A successor's lock is on disk; our identity differs → must NOT delete it.
	const successor = formatLock({ pid: 777, startTimeMs: 5_000, token: "successor" });
	writeFileSync(lockPath, successor);
	const removed = releaseProfileLock(dir, { pid: 111, startTimeMs: 1_000, token: "ours-old" });
	assert.equal(removed, false, "foreign lock survives");
	assert.equal(readFileSync(lockPath, "utf8"), successor);

	// Our own lock IS removed.
	writeFileSync(lockPath, formatLock({ pid: 111, startTimeMs: 1_000, token: "ours-old" }));
	assert.equal(releaseProfileLock(dir, { pid: 111, startTimeMs: 1_000, token: "ours-old" }), true);
	assert.equal(existsSync(lockPath), false);
});

test("acquire writes the identity and reports the holder on refusal", async () => {
	const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { acquireProfileLock, formatLock } = lock;

	const dir = mkdtempSync(join(tmpdir(), "ve-lock2-"));
	const lockPath = join(dir, ".profile.lock");

	// Held by a live, verified-different process → refuse, surface the pid, keep the file.
	const held = formatLock({ pid: 4321, startTimeMs: 1_700, token: "holder" });
	writeFileSync(lockPath, held);
	let reported = null;
	const got = acquireProfileLock(dir, (pid) => { reported = pid; }, {
		isProcessAlive: () => true,
		startTimeOf: () => 1_700,
		randomToken: () => "new",
		log: () => {},
	});
	assert.equal(got, null);
	assert.equal(reported, 4321);
	assert.equal(readFileSync(lockPath, "utf8"), held, "refusal must not clobber the holder's lock");

	// No holder → acquire and write our identity.
	const dir2 = mkdtempSync(join(tmpdir(), "ve-lock3-"));
	const id = acquireProfileLock(dir2, () => {}, { randomToken: () => "tok", log: () => {} });
	assert.ok(id);
	const written = parseLock(readFileSync(join(dir2, ".profile.lock"), "utf8"));
	assert.equal(written.token, "tok");
	assert.equal(written.pid, process.pid);
});

test("DEFECT 1 (real probe): the default liveness probe maps EPERM to ALIVE, only ESRCH to dead", () => {
	// The tests above inject isProcessAlive, which would hide a regression in the
	// real probe — exactly how the field bug shipped. Exercise the real mapping by
	// stubbing process.kill and calling decideLock WITHOUT an injected probe.
	const original = process.kill;
	const cases = [
		["EPERM", "refuse"],
		["EACCES", "refuse"],
		["ESRCH", "acquire"],
	];
	try {
		for (const [code, expected] of cases) {
			process.kill = () => { const e = new Error(code); e.code = code; throw e; };
			const d = decideLock(formatLock(other(4321, 1_700)), mine);
			assert.equal(d.action, expected, `process.kill throwing ${code} → ${expected}`);
		}
		// A probe that succeeds means the process exists → refuse.
		process.kill = () => true;
		assert.equal(decideLock(formatLock(other(4321, 1_700)), mine).action, "refuse");
	} finally {
		process.kill = original;
	}
});
