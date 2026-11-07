/**
 * WorkerService / WorkerTaskStore — the Router/Worker infrastructure tests.
 *
 * The ruling these tests pin (user, 2026-11-07): Router/Worker is
 * INFRASTRUCTURE with a LINEAR lifecycle (queued → running → done), structurally
 * separate from the autonomous task system (work_items). The load-bearing
 * assertions:
 *   - a finished worker is finished FOREVER (no scheduled/waiting states exist)
 *   - a model emitting work-item markers ([[NEXT_CHECK]] / [[TASK_DONE]]) in a
 *     worker session is INERT — plain text delivered verbatim, nothing parsed,
 *     nothing scheduled (the structural-separation touchstone)
 *   - follow-up messages continue the SAME durable session as conversation,
 *     without re-opening the settled state
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, "node_modules/.worker-svc-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

await build({
	stdin: {
		contents: `export { WorkerTaskStore } from "./src/router/worker-tasks.ts";\nexport { WorkerService } from "./src/router/worker-service.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(dir, "ws.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { WorkerTaskStore, WorkerService } = await import(pathToFileURL(join(dir, "ws.mjs")).href);

function harness(overrides = {}) {
	const db = new DatabaseSync(":memory:");
	WorkerTaskStore.migrate(db);
	const store = new WorkerTaskStore(db);
	const h = {
		db, store,
		sessions: [], sends: [], pushes: [], errors: [],
		open: async (cid) => { h.sessions.push(cid); return { cid }; },
		send: async (session, message) => {
			h.sends.push({ session, message });
			return overrides.reply ? overrides.reply(h) : { reply: "统计完成：最近7天共 37 笔。" };
		},
		push: async (cid, text) => { h.pushes.push({ cid, text }); },
	};
	const service = new WorkerService(store, {
		open: h.open, send: h.send, push: h.push,
		maxConcurrent: 3, clock: { now: () => Date.now(), setTimeout: (fn) => { h.wake = fn; return fn; } },
		onError: (e) => h.errors.push(e),
		...overrides.service,
	});
	return { h, service };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

test("linear lifecycle: spawn → running → done, result delivered to the SOURCE conversation", async () => {
	const { h, service } = harness();
	const w = service.spawn({ instruction: "统计最近7天对账结果", sourceConversation: "dt:group:g1", createdBy: "ma1", maxMinutes: 10 });
	assert.equal(w.status, "queued");
	assert.equal(h.db.prepare("SELECT COUNT(*) c FROM worker_tasks WHERE status != 'done'").get().c, 1);
	service.start(); await flush();
	const row = h.store.get(w.id);
	assert.equal(row.status, "done", "a worker settles done — there is no third state to wait in");
	assert.match(row.result, /37 笔/);
	assert.equal(row.finished_at != null, true);
	assert.deepEqual(h.pushes.map((p) => p.cid), ["dt:group:g1"], "delivery goes to the SOURCE conversation");
	assert.match(h.pushes[0].text, /37 笔/);
	// the durable session id is the worker prefix, NOT work:/sched:
	assert.match(h.store.get(w.id).conversation_id, /^worker:/);
});

test("STRUCTURAL SEPARATION: work-item markers in a worker reply are inert text", async () => {
	const { h, service } = harness({
		reply: () => ({ reply: "阶段完成。\n[[NEXT_CHECK]]: 2026-11-07 00:50 | 重查\n[[TASK_DONE]]" }),
	});
	const w = service.spawn({ instruction: "做一件事", sourceConversation: "dt:group:g2", createdBy: "ma1" });
	service.start(); await flush();
	const row = h.store.get(w.id);
	assert.equal(row.status, "done", "markers cannot move the linear state machine");
	assert.equal(row.next_check_at, undefined, "the column does not even exist on worker_tasks");
	const pushed = h.pushes.map((p) => p.text).join("\n");
	assert.match(pushed, /\[\[NEXT_CHECK\]\]/, "markers ride through as PLAIN TEXT — nothing parsed them");
	// and nothing was scheduled: the store has no scheduling columns to write to
	const cols = h.db.prepare("PRAGMA table_info(worker_tasks)").all().map((c) => c.name);
	for (const dead of ["next_check_at", "cadence_ms", "resident", "fixed_streak", "timeout_streak", "kicked_off"]) {
		assert.ok(!cols.includes(dead), `worker_tasks must not carry the autonomous column: ${dead}`);
	}
});

test("error is a TERMINAL state: failure notice delivered, nothing retried or scheduled", async () => {
	const { h, service } = harness({ reply: () => ({ error: "gateway timeout" }) });
	const w = service.spawn({ instruction: "x", sourceConversation: "dt:s1", createdBy: "ma1" });
	service.start(); await flush();
	const row = h.store.get(w.id);
	assert.equal(row.status, "done", "failure is still terminal — no retry loop, no pause state");
	assert.match(row.error, /gateway timeout/);
	assert.equal(h.sends.length, 1, "no silent retry: exactly one send for one dispatch");
	assert.equal(h.pushes.length, 1);
	assert.match(h.pushes[0].text, /gateway timeout/, "the failure notice reaches the source conversation");
});

test("follow-up message continues the SAME session as CONVERSATION, state stays settled", async () => {
	const { h, service } = harness();
	const w = service.spawn({ instruction: "第一件事", sourceConversation: "dt:s2", createdBy: "ma1" });
	service.start(); await flush();
	assert.equal(h.store.get(w.id).status, "done");
	const before = h.sends.length;
	const routed = await service.inject("dt:s2", "把上一条按部门拆开再看一遍", "ma1");
	assert.equal(routed, true, "a follow-up routes into the same worker session");
	await flush();
	assert.equal(h.sessions.filter((s) => s === h.store.get(w.id).conversation_id).length, 2, "same durable session (context continuity)");
	assert.match(h.sends[before].message, /按部门拆开/);
	assert.equal(h.store.get(w.id).status, "done", "follow-up is conversation, NOT a state transition");
	assert.ok(h.pushes.length >= 2, "the follow-up's reply is also delivered");
});

test("follow-up in a conversation with no worker returns false (Router decides anew)", async () => {
	const { service } = harness();
	assert.equal(await service.inject("dt:noworker", "你好", "ma1"), false);
});

test("claim is atomic: one dispatch runs exactly once", async () => {
	const { h, service } = harness();
	const w = service.spawn({ instruction: "x", sourceConversation: "dt:s3", createdBy: "ma1" });
	service.start();
	const direct = h.store.claim(Date.now());
	assert.equal(direct, undefined, "already claimed by the service tick");
	await flush();
	assert.equal(h.sends.length, 1);
	assert.equal(h.store.get(w.id).status, "done");
});
