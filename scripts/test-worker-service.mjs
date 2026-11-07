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

test("INTERRUPTION notice: says WHY, asks whether to re-run, and starts nothing", async () => {
	// User rulings, 2026-11-07 — both halves are load-bearing:
	//  (1) 「可以给一个提示 因为什么原因中断了 问用户是否原因重跑」 — silence is not
	//      restraint. The group watched a progress note promise 「报告已生成完毕」
	//      and then nothing ever arrived.
	//  (2) 「崩溃恢复不见得是一件好事，要克制，如果一直不停的触发是有问题的，会
	//      造成死循环，模型后台空转」 — the notice must not start work by itself.
	const { h, service } = harness();
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wdead', '每日对账异常动态巡检（7天版·明细报告）继续', 'dt:group:g1', 'ma1', 'running', 'worker:wdead', ?, ?)`).run(past, past);

	service.start();
	await flush();

	const row = h.store.get("wdead");
	assert.equal(row.status, "error", "a stale row must not claim to be running any more");
	assert.match(row.error, /应用在执行中退出/, "the recorded reason must name the cause");
	assert.equal(row.finished_at != null, true, "it must look finished, not alive");

	const notices = h.pushes.filter((x) => x.cid === "dt:group:g1");
	assert.equal(notices.length, 1, "exactly ONE notice per interrupted worker");
	const text = notices[0].text;
	assert.match(text, /任务被中断/, "it must name what happened");
	assert.match(text, /原因/, "it must state a reason (the user asked 「为什么原因中断」)");
	assert.match(text, /升级 \/ 重启 \/ 崩溃/, "the reason must be concrete, not vague");
	assert.match(text, /不能当作结果/, "it must warn that earlier progress notes were estimates");
	assert.match(text, /重新执行/, "it must offer the re-run choice");

	// The restraint half: reporting is not doing.
	assert.equal(h.sends.length, 0, "the notice must NOT re-run the worker by itself");
	assert.equal(h.sessions.length, 0, "it must not even open a session (zero model turns)");
	assert.equal(h.db.prepare("SELECT COUNT(*) c FROM worker_tasks WHERE status = 'queued'").get().c, 0,
		"it must not re-queue");
});

test("INTERRUPTION notice is once-per-row: a reboot loop cannot produce a notice loop", async () => {
	// This is what makes ruling (2) safe while still honouring ruling (1):
	// recoverOrphans only returns rows it actually FLIPPED, and the UPDATE is
	// gated on status='running', so the second boot finds nothing and stays
	// silent. Five reboots must not mean five notices.
	const { h, service } = harness();
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wdead', '巡检', 'dt:group:g1', 'ma1', 'running', 'worker:wdead', ?, ?)`).run(past, past);

	service.start();          // boot 1 — flips + notifies
	await flush();
	service.stop();
	service.start();          // boot 2 — must be a total no-op
	await flush();
	service.stop();
	service.start();          // boot 3
	await flush();

	assert.equal(h.pushes.length, 1, "exactly one notice across three boots");
	assert.equal(h.db.prepare("SELECT COUNT(*) c FROM worker_tasks WHERE status = 'error'").get().c, 1);
});

test("INTERRUPTION notice never rewrites an already-reconciled row", async () => {
	// finished_at / error are the observable: a repeat flip would re-stamp them.
	const { h } = harness();
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wdead', '巡检', 'dt:group:g1', 'ma1', 'running', 'worker:wdead', ?, ?)`).run(past, past);

	const first = h.store.recoverOrphans(Date.now(), "REASON-1");
	assert.equal(first.length, 1, "the first boot flips the orphan");
	const stamp = h.store.get("wdead").finished_at;
	for (const later of [60_000, 86_400_000, 7 * 86_400_000]) {
		const again = h.store.recoverOrphans(Date.now() + later, "REBOOT-" + later);
		assert.equal(again.length, 0, `boot +${later}ms must be a no-op`);
	}
	const after = h.store.get("wdead");
	assert.equal(after.finished_at, stamp, "a repeat boot must NOT re-stamp finished_at");
	assert.equal(after.error, "REASON-1", "a repeat boot must NOT rewrite the recorded reason");
});

test("reconciliation leaves THIS process's live rows alone", async () => {
	const { h } = harness();
	const now = Date.now();
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wlive', '活着的任务', 'dt:group:g1', 'ma1', 'running', 'worker:wlive', ?, ?)`).run(now, now + 1);
	const victims = h.store.recoverOrphans(now, "x");
	assert.equal(victims.length, 0, "a row started after boot is live work");
	assert.equal(h.store.get("wlive").status, "running", "live work must keep running");
});

test("hasActive() sees queued AND running workers (the update gate)", async () => {
	// durableRuntime.busy goes false BETWEEN two submissions of the same worker,
	// and a queued worker has never been busy — so "model idle" alone lets an
	// unattended restart land in the middle of a task.
	const { h, service } = harness();
	assert.equal(h.store.hasActive(), false, "empty queue = nothing owed");
	service.spawn({ instruction: "长任务", sourceConversation: "dt:group:g1", createdBy: "ma1" });
	assert.equal(h.store.hasActive(), true, "a QUEUED worker already owes a result");
	service.start();
	await flush();
	assert.equal(h.store.hasActive(), false, "settled = nothing owed");
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

test("concurrent follow-ups on ONE worker session serialize instead of hitting the kernel's already-processing refusal", async () => {
	// Field 2026-11-07 (box): the user typed while the worker was still running;
	// pi-agent-core refuses a concurrent prompt ("Agent is already processing.
	// Specify streamingBehavior…") and the user saw 执行未完成. A worker is
	// DIALOGUE infrastructure — the second message must queue and answer NEXT.
	let active = 0, maxActive = 0;
	// Simulate the kernel's mutual exclusion: a non-serialized second prompt throws.
	let sendCount = 0;
	const serializedSend = async (session, message) => {
		sendCount += 1;
		active += 1;
		maxActive = Math.max(maxActive, active);
		try {
			if (active > 1) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
			await new Promise((r) => setTimeout(r, 20));
			return { reply: "已处理：" + message };
		} finally {
			active -= 1;
		}
	};
	const { h, service } = harness({ service: { send: serializedSend } });
	const flushLong = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 5)); };

	const w = service.spawn({ instruction: "第一件事", sourceConversation: "dt:serial", createdBy: "ma1" });
	service.start();
	await flush();
	// three rapid follow-ups while the same session is in use
	await Promise.all([
		service.inject("dt:serial", "追问一", "ma1"),
		service.inject("dt:serial", "追问二", "ma1"),
		service.inject("dt:serial", "追问三", "ma1"),
	]);
	await flushLong();
	assert.equal(maxActive, 1, "exactly one prompt may be in flight per session (serialized chain)");
	const texts = h.pushes.map((p) => p.text).join("\n");
	assert.ok(!texts.includes("already processing"), "no follow-up may surface the kernel's concurrency refusal");
	assert.equal(sendCount, 4, "the dispatch turn + all three follow-ups ran");
	assert.equal(h.store.get(w.id).status, "done", "follow-ups never move the linear state machine");
});

test("follow-up in a conversation with no worker returns false (Router decides anew)", async () => {
	const { service } = harness();
	assert.equal(await service.inject("dt:noworker", "你好", "ma1"), false);
});

test("worker session resolves back to its SOURCE conversation for tool scoping", async () => {
	// Field 2026-11-07 (box): inside a worker, `manage_work_items list` answered
	// 「当前来源会话还没有自主任务」 while the source chat actually owned one —
	// tools were scoped to the worker's own transcript id. The reverse lookup is
	// what main.ts feeds resolveOriginConversation.
	const { h, service } = harness();
	const w = service.spawn({ instruction: "查自主任务", sourceConversation: "dt:group:origin", createdBy: "ma1" });
	service.start();
	await flush();
	const convId = h.store.get(w.id).conversation_id;
	assert.ok(convId, "the dispatch round recorded its durable conversation id");
	assert.equal(h.store.sourceForConversation(convId), "dt:group:origin", "transcript id → origin chat");
	assert.equal(h.store.sourceForConversation("dt:unknown"), undefined, "unknown ids resolve to nothing (inline fallback)");
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
