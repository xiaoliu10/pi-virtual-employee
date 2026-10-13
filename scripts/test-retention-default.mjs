/**
 * oneOffRetentionDays default-bump tests (field 2026-10-13: user ruling raised
 * the one-off conversation retention default from 7 to 30 days).
 *
 * Real ConfigStore on real SQLite. The interesting part is the ONE-TIME
 * migration: a persisted 7 (the 0.2.145 default) is carried forward to 30,
 * while any other stored value is the user's deliberate choice and survives.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.retention-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "retention.mjs");
await build({
	stdin: { contents: 'export { ConfigStore } from "./src/db/config-store.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { ConfigStore } = await import(pathToFileURL(bundle).href);

function freshDb() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
	return db;
}

test("a persisted legacy 7 is carried forward to the new 30-day default", () => {
	const db = freshDb();
	// Exactly what 0.2.145 wrote: the field present with the old default.
	db.prepare("INSERT INTO config (key, value) VALUES ('appconfig', ?)").run(
		JSON.stringify({ general: { oneOffRetentionDays: 7 } }),
	);
	const config = new ConfigStore(db);
	assert.equal(config.all().general.oneOffRetentionDays, 30, "the old default is upgraded, not re-read forever");
});

test("a user's own value survives the default bump", () => {
	const db = freshDb();
	db.prepare("INSERT INTO config (key, value) VALUES ('appconfig', ?)").run(
		JSON.stringify({ general: { oneOffRetentionDays: 90 } }),
	);
	const config = new ConfigStore(db);
	assert.equal(config.all().general.oneOffRetentionDays, 90, "an explicit 90 is the user's choice");
	const off = freshDb();
	off.prepare("INSERT INTO config (key, value) VALUES ('appconfig', ?)").run(
		JSON.stringify({ general: { oneOffRetentionDays: 0 } }),
	);
	assert.equal(new ConfigStore(off).all().general.oneOffRetentionDays, 0, "0 = disabled survives too");
});

test("a config with no stored value gets 30", () => {
	const db = freshDb();
	db.prepare("INSERT INTO config (key, value) VALUES ('appconfig', ?)").run(JSON.stringify({ general: {} }));
	assert.equal(new ConfigStore(db).all().general.oneOffRetentionDays, 30);
});

test("the value round-trips through update()", () => {
	const config = new ConfigStore(freshDb());
	config.update({ general: { oneOffRetentionDays: 14 } });
	assert.equal(config.all().general.oneOffRetentionDays, 14, "written value is read back");
	// A subsequent update that does not mention the field must not reset it.
	config.update({ general: { longTaskProgressMin: 15 } });
	assert.equal(config.all().general.oneOffRetentionDays, 14, "unrelated updates keep the value");
});
