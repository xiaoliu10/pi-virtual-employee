/**
 * Updater temp-file sweep rule tests (field 2026-10-14).
 *
 * One host's auto-update died with:
 *   ENOENT: rename '…/pending/temp-Pi-Virtual-Employee-Setup-0.2.146-x64.exe'
 *         → '…/pending/Pi-Virtual-Employee-Setup-0.2.146-x64.exe'
 * The old sweep matched only .tmp/.blocked suffixes, so it could never delete
 * electron-updater's real temp name ("temp-<installer>.exe") and the failure
 * repeated every cycle until the cache was cleared by hand.
 *
 * sweepStaleUpdaterTemps lives inside the Electron main module (needs
 * app/LOCALAPPDATA), so this file pins its FILENAME predicate as an executable
 * record of the field regression. Honest scope: this is a mirror of the rule in
 * updater.ts, not an anti-drift guard — editing updater.ts alone will not turn
 * these tests red (the repo has no way to import the main module into node:test).
 * The age-guard policy is covered by code reading, not here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

/** Mirror of the predicate in electron/updater.ts sweepStaleUpdaterTemps. */
function isSweepableTemp(name) {
	return /^temp-/i.test(name) || /\.(tmp|blocked)$/i.test(name);
}

test("the real electron-updater temp name is sweepable (the field regression)", () => {
	// Exactly what failed on the host: pending/temp-<installer>.exe
	assert.equal(isSweepableTemp("temp-Pi-Virtual-Employee-Setup-0.2.146-x64.exe"), true,
		"electron-updater's temp-<installer>.exe must be swept");
	assert.equal(isSweepableTemp("temp-anything.exe"), true);
	assert.equal(isSweepableTemp("TEMP-Uppercase.exe"), true, "case-insensitive");
});

test("legacy .tmp/.blocked suffixes stay covered", () => {
	assert.equal(isSweepableTemp("Pi-Virtual-Employee-Setup-0.2.146-x64.exe.tmp"), true);
	assert.equal(isSweepableTemp("partial.download.blocked"), true);
});

test("real installers and unrelated cache files are NEVER swept", () => {
	assert.equal(isSweepableTemp("Pi-Virtual-Employee-Setup-0.2.146-x64.exe"), false,
		"a completed installer in pending/ is the update we are about to install");
	assert.equal(isSweepableTemp("Pi-Virtual-Employee-Setup-0.2.146-x64.exe.blockmap"), false);
	assert.equal(isSweepableTemp("latest.yml"), false);
	assert.equal(isSweepableTemp("nupkg"), false);
});
