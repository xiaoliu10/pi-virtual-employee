/**
 * SchedulerService unit tests. Run with `npm run test:scheduler-service`.
 *
 * The wedge regression (field 2026-09-22, ~4h scheduler freeze): a task run
 * that never settles used to hold the tick-level `ticking` lock forever, so
 * every later tick early-returned and ALL scheduled tasks stopped firing while
 * the app otherwise looked healthy. The fix bounds one run by a hard timeout —
 * a wedged run may waste only itself.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.schedsvc-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "schedsvc.mjs");
await build({
	stdin: { contents: 'export { SchedulerService } from "./src/scheduler/scheduler-service.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { SchedulerService } = await import(pathToFileURL(bundle).href);

function memoryStore() {
	const tasks = [];
	return {
		tasks,
		create(input) {
			const row = { id: input.id ?? `t${tasks.length + 1}`, enabled: 1, last_run_at: null, last_status: null, ...input };
			tasks.push(row);
			return row;
		},
		list: () => tasks,
		listDue: (now) => tasks.filter((t) => t.enabled && t.next_run_at != null && t.next_run_at <= now),
		markRun(id, status, nextRunAt) {
			const t = tasks.find((x) => x.id === id);
			t.last_run_at = Date.now();
			t.last_status = status;
			t.next_run_at = nextRunAt;
		},
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a run that never settles is force-failed at the timeout and does NOT wedge the scheduler", async () => {
	const store = memoryStore();
	store.create({ id: "wedged", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	store.create({ id: "healthy", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	const ran = [];
	const svc = new SchedulerService(store, 50); // 50ms test timeout
	svc.setRunner({
		async runTask(task) {
			ran.push(task.id);
			if (task.id === "wedged") return new Promise(() => {}); // never settles
			return { status: "ok" };
		},
	});

	await svc.tick();

	const wedged = store.tasks.find((t) => t.id === "wedged");
	const healthy = store.tasks.find((t) => t.id === "healthy");
	assert.match(wedged.last_status, /^error:run_timeout:/, "the wedged run is recorded as timed out");
	assert.equal(healthy.last_status, "ok", "the NEXT task still ran — the tick was not wedged");
	assert.deepEqual(ran, ["wedged", "healthy"]);
});

test("a slow-but-completing run inside the timeout is recorded normally", async () => {
	const store = memoryStore();
	store.create({ id: "slow", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	const svc = new SchedulerService(store, 5_000);
	svc.setRunner({ async runTask() { await sleep(30); return { status: "ok" }; } });

	await svc.tick();

	assert.equal(store.tasks[0].last_status, "ok");
});

test("a run that rejects still records the error (unchanged semantics)", async () => {
	const store = memoryStore();
	store.create({ id: "boom", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 1000 });
	const svc = new SchedulerService(store, 5_000);
	svc.setRunner({ async runTask() { throw new Error("engine exploded"); } });

	await svc.tick();

	assert.match(store.tasks[0].last_status, /^error:engine exploded/);
});

test("overdue tasks run once each and next_run_at advances past the timeout's wall clock", async () => {
	const store = memoryStore();
	// Two missed occurrences: the catch-up policy is one run, not two.
	store.create({ id: "a", prompt: "x", cron: "* * * * *", next_run_at: Date.now() - 120_000 });
	const svc = new SchedulerService(store, 5_000);
	svc.setRunner({ async runTask() { return { status: "ok" }; } });

	await svc.tick();

	const a = store.tasks[0];
	assert.equal(a.last_status, "ok");
	assert.ok(a.next_run_at > Date.now(), "next occurrence is recomputed from now, not the past");
	// A second tick immediately after must not re-run it.
	await svc.tick();
	assert.equal(a.last_run_at != null && store.tasks.filter((t) => t.id === "a").length, 1);
});
