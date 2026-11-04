/**
 * Profile lock: stale-lock recovery.
 *
 * Field 2026-11-04: after an update-related hard kill, Orion would not start for
 * an hour. Its .profile.lock still held a DEAD pid (27708) and nothing reclaimed
 * it — the profile was permanently wedged until an operator deleted the file by
 * hand. The lock must reclaim itself when the recorded owner is gone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const out = join(mkdtempSync(join(root, "node_modules/.lock-test-")), "lock.mjs");
await build({
	stdin: {
		contents: `export { acquireProfileLock, isProcessAlive } from "./electron/profile-lock-core.ts";`,
		resolveDir: root, loader: "ts",
	},
	outfile: out, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { acquireProfileLock, isProcessAlive } = await import(pathToFileURL(out).href + `?t=${Date.now()}`);

function withDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "ve-lock-"));
	mkdirSync(dir, { recursive: true });
	return fn(dir);
}

test("no lock file → acquires it", () => {
	withDir((dir) => {
		const r = acquireProfileLock(dir, { pid: 4242, isAlive: () => false });
		assert.equal(r.acquired, true);
		assert.equal(readFileSync(join(dir, ".profile.lock"), "utf8"), "4242");
	});
});

test("THE FIELD BUG: a lock held by a DEAD process is reclaimed", () => {
	withDir((dir) => {
		writeFileSync(join(dir, ".profile.lock"), "27708");
		// 27708 is gone. Before the fix, process.kill(pid, 0) on Windows could
		// resolve without throwing for a dead pid, so the app concluded "already
		// running" and quit — leaving the profile unstartable forever.
		const r = acquireProfileLock(dir, { pid: 4242, isAlive: () => false });
		assert.equal(r.acquired, true, "a stale lock must be reclaimed, not obeyed");
		assert.equal(readFileSync(join(dir, ".profile.lock"), "utf8"), "4242");
	});
});

test("a lock held by a LIVE process is respected (no double-start)", () => {
	withDir((dir) => {
		writeFileSync(join(dir, ".profile.lock"), "9999");
		const r = acquireProfileLock(dir, { pid: 4242, isAlive: (p) => p === 9999 });
		assert.equal(r.acquired, false);
		assert.equal(r.reason, "in-use");
		assert.equal(readFileSync(join(dir, ".profile.lock"), "utf8"), "9999", "must not clobber a live lock");
	});
});

test("a corrupt lock file (garbage/empty) is reclaimed rather than wedging the app", () => {
	for (const bad of ["", "not-a-pid", "-1", "0"]) {
		withDir((dir) => {
			writeFileSync(join(dir, ".profile.lock"), bad);
			const r = acquireProfileLock(dir, { pid: 4242, isAlive: () => false });
			assert.equal(r.acquired, true, `corrupt lock ${JSON.stringify(bad)} must be reclaimed`);
		});
	}
});

test("our OWN pid in the lock (restart in place) is reclaimed", () => {
	withDir((dir) => {
		writeFileSync(join(dir, ".profile.lock"), "4242");
		const r = acquireProfileLock(dir, { pid: 4242, isAlive: () => true });
		assert.equal(r.acquired, true, "a lock naming ourselves is a leftover from our own restart");
	});
});

test("isProcessAlive distinguishes self and dead pids", () => {
	assert.equal(isProcessAlive(process.pid), true, "we are obviously alive");
	assert.equal(isProcessAlive(999_999_999), false, "an impossible pid is dead");
});
