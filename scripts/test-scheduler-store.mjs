/**
 * ScheduledTaskStore tests — the real SQLite layer (migration included).
 *
 * Focus: the silent flag (2026-10-09). A maintenance task (e.g. a token
 * keep-alive) must be able to run WITHOUT pushing its completion notice —
 * the ⏰ completion + report-link push is product-level (main.ts scheduler
 * runner) and cannot be muted from the prompt. The flag persists across
 * restarts, defaults to 0 (push) for existing rows, and update() merges
 * without disturbing the schedule.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.scheduler-store-test-"));
after(() => rm(workDir, { recursive: true, force: true }));

const bundle = join(workDir, "store.mjs");
await build({
	stdin: { contents: 'export { ScheduledTaskStore } from "./src/db/scheduled-task-store.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { ScheduledTaskStore } = await import(pathToFileURL(bundle).href);

/** The production migration for the silent column (mirrors src/db/sqlite.ts). */
function migrateSilentColumn(d) {
	const cols = new Set(d.prepare("PRAGMA table_info(scheduled_tasks)").all().map((r) => r.name));
	if (!cols.has("silent")) d.exec("ALTER TABLE scheduled_tasks ADD COLUMN silent INTEGER NOT NULL DEFAULT 0");
}

/** Real DB with the scheduled_tasks schema (base + the sqlite.ts migrations). */
function db(t, withLegacyRow = false) {
	const d = new DatabaseSync(":memory:");
	d.exec(`
		CREATE TABLE IF NOT EXISTS scheduled_tasks (
			id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1, conversation_id TEXT, origin TEXT NOT NULL DEFAULT 'console',
			created_by TEXT, last_run_at INTEGER, next_run_at INTEGER, last_status TEXT,
			autonomous INTEGER NOT NULL DEFAULT 0, max_turns INTEGER, max_minutes INTEGER, chain_state TEXT,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
	`);
	if (withLegacyRow) {
		// A pre-silent-migration row: same schema minus the silent column.
		d.exec(`CREATE TABLE legacy_tasks AS SELECT * FROM scheduled_tasks WHERE 0;`);
		d.exec(`DROP TABLE scheduled_tasks;`);
		d.exec(`CREATE TABLE scheduled_tasks (
			id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1, conversation_id TEXT, origin TEXT NOT NULL DEFAULT 'console',
			created_by TEXT, last_run_at INTEGER, next_run_at INTEGER, last_status TEXT,
			autonomous INTEGER NOT NULL DEFAULT 0, max_turns INTEGER, max_minutes INTEGER, chain_state TEXT,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
		d.exec(`INSERT INTO scheduled_tasks (id, title, prompt, cron, conversation_id, created_at, updated_at)
			VALUES ('legacy', '旧任务', '干活', '0 9 * * *', 'dt:boss', 1, 1)`);
	}
	t.after(() => d.close());
	return d;
}

test("create defaults silent to 0 (push) and stores an explicit 1", (t) => {
	const d = db(t);
	migrateSilentColumn(d);
	const store = new ScheduledTaskStore(d);
	const pushy = store.create({ title: "早报", prompt: "p", cron: "0 9 * * *", nextRunAt: Date.now() + 3_600_000 });
	const quiet = store.create({ title: "保活", prompt: "p", cron: "0 */5 * * *", silent: true, nextRunAt: Date.now() + 3_600_000 });
	assert.equal(pushy.silent, 0);
	assert.equal(quiet.silent, 1);
	assert.equal(store.get(quiet.id)?.silent, 1, "persisted");
});

test("update merges silent without touching prompt/cron/schedule", (t) => {
	const d = db(t);
	migrateSilentColumn(d);
	const store = new ScheduledTaskStore(d);
	const row = store.create({ title: "保活", prompt: "p", cron: "0 */5 * * *", nextRunAt: Date.now() + 3_600_000 });
	const before = store.get(row.id);
	assert.ok(before);
	const updated = store.update(row.id, { silent: true });
	assert.equal(updated?.silent, 1);
	assert.equal(updated?.prompt, before.prompt, "prompt untouched");
	assert.equal(updated?.cron, before.cron, "cron untouched");
	assert.equal(updated?.next_run_at, before.next_run_at, "schedule untouched");
	const off = store.update(row.id, { silent: false });
	assert.equal(off?.silent, 0, "flips back");
});

test("legacy rows (pre-silent schema) read as 0 — push semantics preserved", (t) => {
	const d = db(t, true);
	// Before the migration the store tolerates the missing column…
	const store0 = new ScheduledTaskStore(d);
	const row = store0.get("legacy");
	assert.ok(row);
	// The store spreads the raw row; a pre-migration DB simply has no column.
	assert.equal(row.silent ?? 0, 0, "absent column reads as the push default");
	// …and after the migration the row still reads 0 (push) and can be flipped.
	migrateSilentColumn(d);
	assert.equal(store0.get("legacy").silent, 0, "migrated legacy rows keep push semantics");
	const updated = store0.update("legacy", { silent: true });
	assert.equal(updated?.silent, 1);
});
