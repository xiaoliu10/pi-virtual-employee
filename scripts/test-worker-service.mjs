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
		contents: `export { WorkerTaskStore } from "./src/router/worker-tasks.ts";\nexport { WorkerService, buildSourceContextExcerpt, SOURCE_CONTEXT_MAX_MESSAGES, SOURCE_CONTEXT_MAX_CHARS, SOURCE_CONTEXT_MAX_PER_MESSAGE } from "./src/router/worker-service.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(dir, "ws.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { WorkerTaskStore, WorkerService, buildSourceContextExcerpt, SOURCE_CONTEXT_MAX_MESSAGES, SOURCE_CONTEXT_MAX_CHARS, SOURCE_CONTEXT_MAX_PER_MESSAGE } =
	await import(pathToFileURL(join(dir, "ws.mjs")).href);

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

test("「重新执行」respawns the interrupted worker deterministically (no context needed)", async () => {
	// Field 2026-11-08: the interrupt notice promised 「回复『重新执行』我就重跑
	// 这一轮」. The user replied exactly that in the group — and the model asked
	// 「请告诉我要重新执行的具体任务是什么？」. Three defects stacked: the worker
	// session's transcript is in-memory (gone with the restart), the notice never
	// landed in the group's history, and nothing anywhere recognized「重新执行」.
	//
	// The fix is DETERMINISTIC: the re-run is spawned from worker_tasks itself
	// (the original instruction survives there), before the message can reach
	// the empty session.
	const { h, service } = harness();
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, error, max_minutes, conversation_id, created_at, started_at)
		VALUES ('wdead', '每日对账异常动态巡检与群内汇报（7天版·明细报告）继续', 'dt:group:g1', 'ma1', 'error', '应用在执行中退出，该轮未跑完（可回复「重新执行」重跑）', 30, 'worker:wdead', ?, ?)`).run(past, past);

	const injected = await service.inject("dt:group:g1", "重新执行", "ma1");
	assert.equal(injected, true, "「重新执行」 must be claimed");

	// A NEW worker row with the SAME instruction — that is the whole point:
	// the instruction survives in worker_tasks when nothing else does.
	const rows = h.db.prepare("SELECT * FROM worker_tasks ORDER BY created_at").all();
	assert.equal(rows.length, 2, "exactly one new spawn");
	const [, fresh] = rows;
	assert.equal(fresh.status, "queued");
	assert.equal(fresh.instruction, "每日对账异常动态巡检与群内汇报（7天版·明细报告）继续");
	assert.equal(fresh.source_conversation, "dt:group:g1");
	assert.equal(fresh.created_by, "ma1", "identity stays with the ORIGINAL creator");
	assert.equal(fresh.max_minutes, 30);
	assert.notEqual(fresh.id, "wdead", "a NEW row, not a resurrection of the dead one");

	// The confirmation goes out as a push ONLY — it must NOT be written into
	// the source conversation's history (0.2.207's recordDelivery did that, and
	// every worker reply copied there landed as a user-less assistant fragment
	// that poisoned the chat's rehydrated context). The「重新执行」reply is
	// claimed deterministically in inject() — it never needed history.
	const confirm = h.pushes.find((p) => /已重新派发/.test(p.text));
	assert.ok(confirm, "a confirmation must be pushed");

	// The empty dead session must NOT receive the message (that is what produced
	// 「请告诉我要重新执行的具体任务」): no open/send on the old session.
	assert.equal(h.sends.length, 0, "no model turn on the dead session");
});

test("re-run enriches the instruction with the matching task context", async () => {
	// The interrupted row's instruction is often a bare title + 「继续」 — the
	// substance (goal/conditions/progress) lives in the matching work item.
	// Without enrichment the fresh worker starts from two bare user lines and
	// re-explores from zero (the original run burned half an hour accumulating).
	const { h, service } = harness({
		service: {
			taskContext: (sourceConversation, instruction) =>
				`【任务目标（来自自主任务 3db7f642，重跑请接着做）】\n每日巡检 spay 最近 7 天全部商户的日终对账异常\n【中断前的进展（供参考，请核实后继续）】\n已扫 7 天，异常 59`,
		},
	});
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, error, conversation_id, created_at, started_at)
		VALUES ('wdead', '每日对账异常动态巡检与群内汇报（7天版·明细报告）继续', 'dt:group:g1', 'ma1', 'error', '应用在执行中退出，该轮未跑完', 'worker:wdead', ?, ?)`).run(past, past);

	await service.inject("dt:group:g1", "重新执行", "ma1");
	const fresh = h.db.prepare("SELECT * FROM worker_tasks WHERE id != 'wdead'").get();
	assert.match(fresh.instruction, /每日对账异常动态巡检与群内汇报（7天版·明细报告）继续/, "original instruction kept");
	assert.match(fresh.instruction, /【任务目标/, "goal attached");
	assert.match(fresh.instruction, /中断前的进展/, "progress attached");
});

test("re-run without available context keeps the bare instruction (lookup failure is fine)", async () => {
	const { h, service } = harness({ service: { taskContext: () => null } });
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, error, conversation_id, created_at, started_at)
		VALUES ('wdead', '巡检 继续', 'dt:group:g1', 'ma1', 'error', '应用在执行中退出', 'worker:wdead', ?, ?)`).run(past, past);
	await service.inject("dt:group:g1", "重新执行", "ma1");
	const fresh = h.db.prepare("SELECT * FROM worker_tasks WHERE id != 'wdead'").get();
	assert.equal(fresh.instruction, "巡检 继续", "no context → instruction unchanged, the worker can still explore");
});

test("「重新执行」 with NO interrupted worker falls through to the ordinary follow-up", async () => {
	const { h, service } = harness();
	const past = Date.now() - 60 * 60_000;
	// A DONE worker exists — follow-up on it is conversation (settled semantics).
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, result, conversation_id, created_at, started_at, finished_at)
		VALUES ('wdone', '统计任务', 'dt:group:g1', 'ma1', 'done', '完成', 'worker:wdone', ?, ?, ?)`).run(past, past, past);
	const injected = await service.inject("dt:group:g1", "重新执行", "ma1");
	assert.equal(injected, true, "still routed as follow-up");
	assert.equal(h.db.prepare("SELECT COUNT(*) c FROM worker_tasks").get().c, 1, "no new spawn");
	assert.equal(h.sends.length, 1, "the message reached the settled session as conversation");
	const already = h.pushes.filter((p) => /已重新派发/.test(p.text));
	assert.equal(already.length, 0, "no misleading confirmation");
});

test("a non-retry message never triggers the respawn (exact-match guard)", async () => {
	const { h, service } = harness();
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, error, conversation_id, created_at, started_at)
		VALUES ('wdead', '巡检', 'dt:group:g1', 'ma1', 'error', '应用在执行中退出，该轮未跑完', 'worker:wdead', ?, ?)`).run(past, past);
	// 「不要重新执行」 is a DIFFERENT sentence — exact-match keeps it out.
	const injected = await service.inject("dt:group:g1", "不要重新执行", "ma1");
	assert.equal(injected, true, "still a follow-up on the dead session's conversation");
	assert.equal(h.db.prepare("SELECT COUNT(*) c FROM worker_tasks").get().c, 1, "no spawn from a non-exact match");
});

test("the interrupt notice is a PUSH only — never a history write", async () => {
	// Field regression 2026-11-08 (0.2.207 recordDelivery): worker replies copied
	// into the source conversation's history arrived WITHOUT their user turns
	// (those live in the worker session), so the chat's rehydrated context became
	// a pile of orphan assistant fragments. History writes for worker deliveries
	// are banned; the invited reply (「重新执行」) is claimed in inject().
	const { h, service } = harness();
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wdead', '巡检', 'dt:group:g1', 'ma1', 'running', 'worker:wdead', ?, ?)`).run(past, past);
	service.start();
	await flush();
	const notice = h.pushes.find((p) => /任务被中断/.test(p.text));
	assert.ok(notice, "the interrupt notice must be pushed to the source conversation");
});

test("the final result is a PUSH only — never a history write", async () => {
	const { h, service } = harness();
	service.spawn({ instruction: "统计", sourceConversation: "dt:group:g1", createdBy: "ma1" });
	service.start(); await flush();
	const pushed = h.pushes.find((p) => /37 笔/.test(p.text));
	assert.ok(pushed, "the result must be pushed to the source conversation");
});

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

test("a DETERMINISTIC Chinese failure reply is delivered VERBATIM (field 2026-11-08)", async () => {
	// Field: send() returned { reply: 中文兜底(含原因和续跑指引), error: 英文原文,
	// deterministic: true } and runTurn pushed 「⚠️ 执行未完成：This operation was
	// aborted」 — DISCARDING the Chinese explanation because `r.error || !text`
	// treated any error as more urgent than the reply. The deterministic reply IS
	// the finished failure message; appending the raw error after it would be
	// noise on noise.
	const { h, service } = harness({ reply: (h) => ({
		reply: "⚠️ 这次执行被系统中止了。常见原因：① 长时间无进展…可以回复「继续」接着做。",
		error: "This operation was aborted",
		deterministic: true,
	}) });
	service.spawn({ instruction: "统计", sourceConversation: "dt:group:g1", createdBy: "ma1" });
	service.start(); await flush();
	const pushed = h.pushes.map((p) => p.text).join("\n");
	assert.match(pushed, /这次执行被系统中止了/, "the Chinese reply must be delivered");
	assert.doesNotMatch(pushed, /执行未完成：/, "no appended failure line — the reply already IS the failure report");
	assert.doesNotMatch(pushed, /This operation was aborted/, "no English leaks to the user at all");
});

test("a NON-deterministic reply with an error keeps the failure signal (appended)", async () => {
	// Review e6c6fd82 #1: { reply: 模型正常回答, error: "…", deterministic: false }
	// means the model answered something but the run still recorded a failure.
	// Replacing (or dropping) the error hides that the task is unfinished — the
	// failure line must be APPENDED after the reply, not swallow it.
	const { h, service } = harness({ reply: (h) => ({
		reply: "已完成第一步的核对，明细如下：…",
		error: "tool channel died mid-run",
		deterministic: false,
	}) });
	service.spawn({ instruction: "统计", sourceConversation: "dt:group:g1", createdBy: "ma1" });
	service.start(); await flush();
	const pushed = h.pushes[0]?.text ?? "";
	assert.match(pushed, /已完成第一步的核对/, "the model's partial answer is delivered");
	assert.match(pushed, /⚠️ 执行未完成：tool channel died mid-run/, "the failure signal is appended");
	assert.ok(pushed.indexOf("已完成第一步") < pushed.indexOf("执行未完成"), "answer first, failure after");
});

test("an error with NO reply still falls back to 执行未完成", async () => {
	const { h, service } = harness({ reply: (h) => ({ reply: "", error: "something broke" }) });
	service.spawn({ instruction: "统计", sourceConversation: "dt:group:g1", createdBy: "ma1" });
	service.start(); await flush();
	assert.match(h.pushes[0]?.text ?? "", /执行未完成：something broke/);
});

test("a FINISHED worker no longer swallows a NEW task request — triage decides (field 23:44)", async () => {
	// Field 2026-11-08 23:44: a fresh serial-number lookup was injected into the
	// finished 「平阳数币监控」 worker, whose boundary brief turned it away with
	// 「我这边只负责…没有…能力或权限」. The gate: done/error workers keep the
	// CONTINUATION contract (non-task follow-ups still inject) but a task-shaped
	// NEW request falls through to triage (spawn/inline decides).
	const { h, service } = harness();
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wdone', '平阳数币今日交易金额监控', 'dt:group:g1', 'ma1', 'done', 'worker:wdone', ?, ?)`).run(past, past);
	const taskMsg = "0002026110800003400。帮我查一下这笔流水的支付渠道下单日志，先查 spay 再查 sls，然后汇总异常";
	assert.equal(await service.inject("dt:group:g1", taskMsg, "ma1"), false, "task-shaped request into a done worker → falls through");
	// Conversational follow-up on the SAME finished worker still injects (contract).
	assert.equal(await service.inject("dt:group:g1", "结果呢", "ma1"), true, "non-task follow-up keeps the continuation contract");
	assert.equal(await service.inject("dt:group:g1", "继续", "ma1"), true, "「继续」 still continues");
});

test("a FINISHED worker does not swallow a BARE context token — the foreground history resolves it (field 2026-11-10)", async () => {
	// Field 2026-11-10, single chat: the user sent 「875055」 (a number the chat
	// had contextualized turns ago). The most recent worker was DONE; the bare
	// token was injected into it, and that session — born with its instruction
	// only, no chat history — guessed 订单系统, found nothing, and asked
	// 「这是什么类型的编号？」: the employee forgot a conversation it was part of.
	// Review 7ba60092 P1: "falls through to the foreground" is provable END-TO-END —
	// triageMessage carries the same shared guard (reason=reference, pinned in
	// test-triage.mjs), so the planless dispatch cannot re-spawn a context-less
	// worker for the token either.
	const { h, service } = harness();
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wbare', '发送短信后锁住页面，登录成功才能关', 'dt:single:m1', 'u1', 'done', 'worker:wbare', ?, ?)`).run(past, past);
	assert.equal(await service.inject("dt:single:m1", "875055", "u1"), false, "bare digits fall through to the foreground (which has the chat context)");
	assert.equal(await service.inject("dt:single:m1", "A875055", "u1"), false, "prefixed codes too");
	assert.equal(await service.inject("dt:single:m1", "0002026110800003400", "u1"), false, "19-digit serials too");
	assert.equal(await service.inject("dt:single:m1", " 875055 ", "u1"), false, "surrounding whitespace does not matter");
	assert.equal(await service.inject("dt:single:m1", "875055。", "u1"), false, "trailing CJK punctuation does not defeat the guard (review P2-1)");
	assert.equal(await service.inject("dt:single:m1", "ORDER-2026-11-10-0001", "u1"), false, "order-id shape too");
	// The continuation contract for worker-relative follow-ups is untouched.
	assert.equal(await service.inject("dt:single:m1", "结果呢", "u1"), true, "「结果呢」 still continues the finished worker");
	assert.equal(await service.inject("dt:single:m1", "继续", "u1"), true, "「继续」 still continues");
});

test("a CANCELLED worker gets the same bare-token guard (review P3-4)", async () => {
	const { h, service } = harness();
	const past = Date.now() - 60 * 60_000;
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wcan', '发送短信后锁住页面，登录成功才能关', 'dt:single:m3', 'u1', 'cancelled', 'worker:wcan', ?, ?)`).run(past, past);
	assert.equal(await service.inject("dt:single:m3", "ORDER-2026-11-10-0001", "u1"), false, "cancelled worker must not swallow a bare order id");
	assert.equal(await service.inject("dt:single:m3", "结果呢", "u1"), true, "continuation still reaches the cancelled worker");
});

// ─── 2026-11-10: a dispatched worker carries the source conversation ────────
// User ruling: 「worker 还是需要对话记录的，不然一直丢上下文体验非常差」. Field: a
// worker spawned from a single chat was born with the instruction alone, so it
// could not resolve 「875055」 — the answer was three turns up in the very chat
// that spawned it.

test("buildSourceContextExcerpt renders a tail-aligned block with role labels", () => {
	const rows = [
		{ role: "user", content: "我的编号 875055 是单号" },
		{ role: "assistant", content: "明白，875055 是单号。" },
		{ role: "user", content: "查一下它的支付渠道" },
	];
	const block = buildSourceContextExcerpt(rows);
	assert.ok(block.includes("【来源会话近期上下文"), "block header present");
	assert.ok(block.includes("用户: 我的编号 875055 是单号"), "user line labelled");
	assert.ok(block.includes("助手: 明白，875055 是单号。"), "assistant line labelled");
	// Chronological order restored after the backwards walk.
	assert.ok(block.indexOf("我的编号") < block.indexOf("查一下它的支付渠道"), "chronological order");
	assert.ok(!block.includes("更早的消息已省略"), "no omission marker when everything fits");
});

test("buildSourceContextExcerpt filters synthetic delivery notices and empty rows", () => {
	const rows = [
		{ role: "user", content: "帮我查流水" },
		{ role: "assistant", content: "执行已暂停，请检查恢复状态。" },
		{ role: "assistant", content: "   " },
		{ role: "assistant", content: null },
	];
	const block = buildSourceContextExcerpt(rows);
	assert.ok(block.includes("帮我查流水"));
	assert.ok(!block.includes("执行已暂停"), "synthetic notice never fed back to a worker");
	assert.ok(!block.includes("助手: \n"), "empty rows skipped");
	assert.equal(buildSourceContextExcerpt([]), null, "nothing usable → null");
	assert.equal(buildSourceContextExcerpt([{ role: "assistant", content: "执行已暂停，请检查恢复状态。" }]), null, "only notices → null");
});

test("buildSourceContextExcerpt enforces the per-message and total caps", () => {
	const long = "字".repeat(SOURCE_CONTEXT_MAX_PER_MESSAGE + 200);
	const one = buildSourceContextExcerpt([{ role: "user", content: long }]);
	assert.ok(one.includes("…"), "per-message truncation marker");
	assert.ok(one.length <= SOURCE_CONTEXT_MAX_PER_MESSAGE + 80, "per-message cap applied");

	const many = Array.from({ length: SOURCE_CONTEXT_MAX_MESSAGES + 6 }, (_, i) => ({ role: "user", content: `第${i}条` }));
	const block = buildSourceContextExcerpt(many);
	assert.ok(block.includes("（更早的消息已省略）"), "omission marker when the window overflows");
	assert.ok(block.includes(`第${SOURCE_CONTEXT_MAX_MESSAGES + 5}条`), "newest row always kept");
	assert.ok(!block.includes("第0条"), "oldest rows dropped first");
	assert.ok(block.length <= SOURCE_CONTEXT_MAX_CHARS + 200, "total cap honoured");
});

test("buildSourceContextExcerpt survives non-string content shapes", () => {
	const block = buildSourceContextExcerpt([
		{ role: "user", content: [{ type: "text", text: "数组形态" }] },
		{ role: "user", content: { text: "对象形态" } },
	]);
	assert.ok(block.includes("数组形态"));
	assert.ok(block.includes("对象形态"));
});

test("the dispatch turn carries source context; follow-ups do not", async () => {
	const context = "【来源会话近期上下文（用于理解指令中的指代，不要单独复述）】\n用户: 875055 是单号";
	const { h, service } = harness({ service: { sourceContext: () => context } });
	service.spawn({ instruction: "1. 查渠道\n\n[用户原始指令]\n查一下这笔流水", sourceConversation: "dt:single:m9", createdBy: "u1" });
	service.start();
	await flush();
	assert.equal(h.sends.length, 1);
	assert.equal(h.sends[0].message, `${context}\n\n【任务指令】\n1. 查渠道\n\n[用户原始指令]\n查一下这笔流水`, "context block precedes the instruction");
	assert.ok(h.sends[0].message.indexOf("875055") < h.sends[0].message.indexOf("【任务指令】"), "context first, instruction last (recency)");
	// A follow-up continues the worker's own session — no re-injection.
	await service.inject("dt:single:m9", "结果呢", "u1");
	await flush();
	assert.equal(h.sends[1].message, "结果呢", "follow-ups are verbatim, not context-prefixed");
});

test("a null source context leaves the dispatch message byte-identical", async () => {
	for (const sourceContext of [undefined, () => null]) {
		const { h, service } = harness(sourceContext ? { service: { sourceContext } } : {});
		const instruction = "1. 查渠道\n\n[用户原始指令]\n查一下这笔流水";
		service.spawn({ instruction, sourceConversation: "dt:single:m10", createdBy: "u1" });
		service.start();
		await flush();
		assert.equal(h.sends[0].message, instruction, "no block, no header, no drift");
	}
});

test("a LIVE worker still receives bare tokens (verification-code flow, field 2026-11-07)", async () => {
	const { h, service } = harness();
	const now = Date.now();
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wcode', '发送短信后锁住页面，登录成功才能关', 'dt:single:m1', 'u1', 'running', 'worker:wcode', ?, ?)`).run(now, now);
	assert.equal(await service.inject("dt:single:m1", "875055", "u1"), true, "the worker asked for the code — a running worker owns it unconditionally");
});

test("a LIVE worker still owns the dialogue unconditionally", async () => {
	const { h, service } = harness();
	const now = Date.now();
	h.db.prepare(`INSERT INTO worker_tasks (id, instruction, source_conversation, created_by, status, conversation_id, created_at, started_at)
		VALUES ('wlive', '长任务执行中', 'dt:group:g1', 'ma1', 'running', 'worker:wlive', ?, ?)`).run(now, now);
	const taskMsg = "0002026110800003400。帮我查一下这笔流水的支付渠道下单日志，先查 spay 再查 sls，然后汇总异常";
	assert.equal(await service.inject("dt:group:g1", taskMsg, "ma1"), true, "even task-shaped text reaches a running worker (verification codes etc.)");
});
