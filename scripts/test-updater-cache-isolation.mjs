/**
 * Per-profile updater cache isolation. Run: `node --test scripts/test-updater-cache-isolation.mjs`.
 *
 * Field incident (2026-11-12): three profiles on the Windows box shared ONE
 * updater cache dir because the old fix guarded on `setUpdaterCacheDir` — an
 * API electron-updater 6.8.9 does not have — and SILENTLY returned for every
 * profile. Instances running `emptyDir(pending)` over the same folder deleted
 * each other's finished downloads: rename-ENOENT, watchdog copyfile-ENOENT,
 * installer spawn-ENOENT, machine breaker open.
 *
 * Pinned properties:
 *  - a non-default profile ALWAYS ends up either isolated (INFO names the dir)
 *    or explicitly non-isolated with a reason — never a silent no-op;
 *  - the actual mechanism on 6.x is pre-seeding `downloadedUpdateHelper`, which
 *    makes `getOrCreateDownloadHelper()`'s cache hit before the shared dir is
 *    ever created;
 *  - a newer official `setUpdaterCacheDir` API takes precedence when present;
 *  - every failure mode is fail-soft: the updater keeps working, just un-isolated.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.cache-iso-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
await build({
	stdin: { contents: `export { applyUpdaterCacheIsolation, isolatedUpdaterCacheDir } from "./electron/updater-cache-isolation.ts";`, resolveDir: root, loader: "ts" },
	outfile: join(dir, "iso.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { applyUpdaterCacheIsolation, isolatedUpdaterCacheDir } = await import(pathToFileURL(join(dir, "iso.mjs")).href);

const BASE = "C:\\Users\\x\\AppData\\Local\\pi-virtual-employee-updater";
/** Fakes the 6.8.9 reality: constructor stores cacheDir, nothing else exists. */
const REALISH_HELPER = class { constructor(cacheDir) { this.cacheDir = cacheDir; } };

test("the exact field failure shape (6.8.9, no setUpdaterCacheDir) is now isolated via pre-seeded helper", () => {
	const updater = {}; // 6.8.9: no setUpdaterCacheDir, no pre-existing helper
	const outcome = applyUpdaterCacheIsolation("Nova", updater, REALISH_HELPER, BASE);
	assert.equal(outcome.isolated, true, "isolation MUST happen, not silently skip");
	assert.match(outcome.cacheDir, /pi-virtual-employee-updater-Nova$/, "profile-suffixed dir");
	const helper = updater.downloadedUpdateHelper;
	assert.ok(helper, "the pre-seeded helper is what getOrCreateDownloadHelper() will cache-hit on");
	assert.equal(helper.cacheDir, `${BASE}-Nova`);
	assert.match(outcome.detail, /pre-seeded/);
});

test("a default profile keeps the shared dir (no orphaned download, no helper installed)", () => {
	for (const name of ["", "default"]) {
		const updater = {};
		const outcome = applyUpdaterCacheIsolation(name, updater, REALISH_HELPER, BASE);
		assert.equal(outcome.isolated, false);
		assert.equal(outcome.cacheDir, BASE);
		assert.equal(updater.downloadedUpdateHelper, undefined, "default profile must not be touched");
	}
});

test("an official setUpdaterCacheDir API wins and the helper is not pre-seeded", () => {
	const calls = [];
	const updater = { setUpdaterCacheDir: (d) => calls.push(d) };
	const outcome = applyUpdaterCacheIsolation("Orion", updater, REALISH_HELPER, BASE);
	assert.equal(outcome.isolated, true);
	assert.deepEqual(calls, [`${BASE}-Orion`]);
	assert.equal(updater.downloadedUpdateHelper, undefined, "official API path leaves internals untouched");
	assert.match(outcome.detail, /setUpdaterCacheDir/);
});

test("a missing helper class is reported, never silent — the caller turns it into a WARN", () => {
	const updater = {};
	const outcome = applyUpdaterCacheIsolation("Synapse", updater, null, BASE);
	assert.equal(outcome.isolated, false);
	assert.match(outcome.detail, /unavailable/, "the log must name why (the old bug was silence)");
	assert.equal(updater.downloadedUpdateHelper, undefined);
});

test("a throwing helper constructor is fail-soft with a named reason", () => {
	const updater = {};
	const boom = class { constructor() { throw new Error("constructor signature changed"); } };
	const outcome = applyUpdaterCacheIsolation("Synapse", updater, boom, BASE);
	assert.equal(outcome.isolated, false);
	assert.match(outcome.detail, /construction failed/);
	assert.equal(updater.downloadedUpdateHelper, undefined, "a failed pre-seed must not leave a half-object");
});

test("a helper that ignores the cache-dir argument is rejected (future API drift guard)", () => {
	const updater = {};
	const stubborn = class { constructor() { this.cacheDir = BASE; } };
	const outcome = applyUpdaterCacheIsolation("Nova", updater, stubborn, BASE);
	assert.equal(outcome.isolated, false);
	assert.match(outcome.detail, /ignored the cache dir/);
	assert.equal(updater.downloadedUpdateHelper, undefined);
});

test("path naming: only non-default profiles get a suffix", () => {
	assert.equal(isolatedUpdaterCacheDir(BASE, "Nova"), `${BASE}-Nova`);
	assert.equal(isolatedUpdaterCacheDir(BASE, "default"), BASE);
	assert.equal(isolatedUpdaterCacheDir(BASE, ""), BASE);
});
