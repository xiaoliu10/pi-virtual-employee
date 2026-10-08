/** Mock engine + deferred sends + deterministic timers; real node:sqlite store. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = await mkdtemp(join(root, "node_modules/.work-service-test-"));
after(() => rm(tmp, { recursive: true, force: true }));
await build({ stdin: { contents: 'export * from "./src/scheduler/work-service.ts"; export * from "./src/db/work-item-store.ts";', resolveDir: root, loader: "ts" }, outfile: join(tmp, "service.mjs"), bundle: true, platform: "node", format: "esm", packages: "external" });
const { WorkService, WorkItemStore, buildWorkLearning } = await import(pathToFileURL(join(tmp, "service.mjs")));
const schema = (await readFile(join(root, "src/db/sqlite.ts"), "utf8")).match(/CREATE TABLE IF NOT EXISTS work_items \([\s\S]*?\);/)[0];
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
class Clock {
	time = new Date("2026-10-01T10:00:00").getTime();
	timers = new Map(); seq = 0;
	now = () => this.time;
	setTimeout = (fn, ms) => { const id = ++this.seq; this.timers.set(id, { fn, at: this.time + ms }); return id; };
	clearTimeout = id => this.timers.delete(id);
	async advance(ms) {
		const end = this.time + ms;
		for (;;) {
			const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await flush();
		}
		this.time = end; await flush();
	}
}
function fixture(t, overrides = {}) {
	const db = new DatabaseSync(":memory:"); db.exec(schema);
	if (!db.prepare("PRAGMA table_info(work_items)").all().some(c => c.name === "answer")) db.exec("ALTER TABLE work_items ADD COLUMN answer TEXT");
	const h = { db, store: new WorkItemStore({ prepare: sql => db.prepare(sql) }), clock: new Clock(), sends: [], pushes: [], learned: [], released: [], errors: [], aborted: [], gates: [], admin: true };
	h.service = new WorkService({
		store: h.store, clock: h.clock, budget: { maxTurns: 3, maxMinutes: 30 },
		isAdmin: id => h.admin && id === "admin",
		open: (item, cid) => ({ id: item.id, cid, abort: () => h.aborted.push(item.id) }),
		send: async (session, message, actor) => { h.sends.push({ session, message, actor }); return overrides.send ? overrides.send(h, session, message) : { reply: "成果\n[[TASK_DONE]]" }; },
		release: async cid => { h.released.push(cid); if (overrides.release) await overrides.release(h); },
		push: async (cid, text) => { h.pushes.push({ cid, text }); if (overrides.push) await overrides.push(h); },
		learn: (item, result) => { h.learned.push({ item, result }); },
		onError: err => h.errors.push(err),
		lastInboundAt: overrides.lastInboundAt ? (cid, sinceTs) => overrides.lastInboundAt(cid, sinceTs) : undefined,
		...overrides.options,
	});
	h.create = (status = "queued", extra = {}) => h.store.create({ title: "月末对账", goal: "完成月末核对", status, createdBy: "admin", originConversation: "dt:source", ...extra });
	h.gate = () => { const gate = deferred(); h.gates.push(gate); return gate; };
	t.after(async () => { for (const gate of h.gates) gate.resolve({ reply: "[[TASK_DONE]]" }); await h.service.stop(); db.close(); });
	return h;
}

test("done persists, each turn and KB see fresh conditions/progress/lessons; only source gets pushed", async t => {
	const h = fixture(t, { send: (h, session) => {
		if (h.sends.length === 1) {
			h.store.setField(session.id, "conditions", "自动对账期间勿手动触发");
			h.store.setField(session.id, "progress", "已核对60%（明确笔记）");
			h.store.addLesson(session.id, "页面在第三个标签");
			return { reply: "继续推进中" };
		}
		h.store.addLesson(session.id, "完成时新发现");
		return { reply: "核对全部完成\n[[TASK_DONE]]" };
	} });
	const item = h.create();
	h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "done");
	assert.match(h.sends[0].message, /【目标】完成月末核对/);
	assert.match(h.sends[1].message, /自动对账期间勿手动触发/);
	assert.match(h.sends[1].message, /已核对60%/);
	assert.match(h.sends[1].message, /页面在第三个标签/);
	assert.ok(h.sends.every(s => s.actor === "admin"));
	assert.equal(h.learned.length, 1);
	assert.match(h.learned[0].item.lessons, /完成时新发现/);
	assert.match(h.learned[0].item.progress, /明确笔记/);
	assert.deepEqual(h.pushes.map(p => p.cid), ["dt:source"]);
	assert.doesNotMatch(h.pushes[0].text, /TASK_DONE/);
	assert.deepEqual(h.released, [`work:${item.id}`]);
	assert.equal(h.clock.timers.size, 0);
});

test("human always wins, never wakes without explicit resume, answer appears once then clears", async t => {
	const h = fixture(t, { send: h => h.sends.length === 1 ? { reply: "[[NEED_HUMAN]]: 请审批\n[[TASK_DONE]]" } : h.sends.length === 2 ? { reply: "继续推进" } : { reply: "[[TASK_DONE]]" } });
	const item = h.create(); h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "waiting_human");
	assert.equal(h.service.fireItem(item.id), false);
	assert.equal(h.learned.length, 0);
	await h.clock.advance(7 * 86_400_000);
	assert.equal(h.sends.length, 1, "reminders push but never SEND/resume");
	assert.equal(h.clock.timers.size, 1, "reminder timer re-arms (no auto-resume though)");
	h.store.resume(item.id, "财务审批已通过"); await flush();
	assert.match(h.sends[1].message, /财务审批已通过/);
	assert.doesNotMatch(h.sends[2].message, /财务审批已通过/);
	assert.equal(h.store.get(item.id).answer, null);
	assert.equal(h.store.get(item.id).status, "done");
});

test("model-selected 30m follow-up uses one exact timer, not periodic polling", async t => {
	const h = fixture(t, { send: h => h.sends.length === 1 ? { reply: "阶段成果\n[[NEXT_CHECK]]: 30m | 等批次完成" } : { reply: "[[TASK_DONE]]" } });
	const item = h.create(); h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "scheduled");
	assert.equal(h.clock.timers.size, 1);
	await h.clock.advance(29 * 60_000);
	assert.equal(h.sends.length, 1);
	await h.clock.advance(60_000);
	assert.equal(h.sends.length, 2);
	assert.equal(h.store.get(item.id).status, "done");
});

test("markerless exhausted budget waits for humans; ANY declared time (even unusable) soft-falls-back", async t => {
	// Field 2026-10-03: an unusable/unparseable declared time used to pause the
	// item with NO next time at all — the chain died on a format slip. Both must
	// keep the chain alive now; only a markerless exhausted budget waits.
	for (const reply of ["[[NEXT_CHECK]]: 1m | 空跑", "[[NEXT_CHECK]]: 嘎嘎"]) {
		const h = fixture(t, { send: () => ({ reply }) });
		const item = h.create(); h.service.start(); await flush();
		assert.equal(h.store.get(item.id).status, "scheduled", reply);
		assert.ok(h.clock.timers.size >= 1, reply);
	}
	const bare = fixture(t, { send: () => ({ reply: "进行中" }) });
	const bareItem = bare.create(); bare.service.start(); await flush();
	assert.equal(bare.store.get(bareItem.id).status, "waiting_human", "markerless exhausted budget");
	assert.equal(bare.clock.timers.size, 1, "only the reminder timer — no auto-retry");
	assert.equal(bare.learned.length, 0);
});

test("unparseable NEXT_CHECK no longer kills the chain (soft 1h fallback) — field 2026-10-03", async t => {
	const h = fixture(t, { send: () => ({ reply: "[[NEXT_CHECK]]: 嘎嘎 09:00!! | 批次后检查" }) });
	const item = h.create(); h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "scheduled", "chain stays alive");
	assert.ok(h.clock.timers.size >= 1, "a re-check timer exists");
});

test("throws are never retried; returned no-reply errors get graded quiet retries (user ruling 2026-10-08)", async t => {
	for (const mode of ["throw", "error"]) {
		const h = fixture(t, { send: () => { if (mode === "throw") throw new Error("secret=do-not-push"); return { error: "secret=do-not-push" }; } });
		const item = h.create("waiting_human"); h.store.resume(item.id, "审批通过");
		h.service.start(); await flush();
		// throw: exactly one attempt (an arbitrary exception may be anything) —
		// the window settles immediately. error (engine no-reply class): 1 + 2
		// graded quiet retries, then the honest pause — the window is still
		// running inside the backoff until the retries exhaust.
		assert.equal(h.store.get(item.id).status, mode === "throw" ? "waiting_human" : "working");
		await h.clock.advance(24 * 3_600_000); await flush();
		assert.equal(h.store.get(item.id).status, "waiting_human", "neither mode retries forever");
		assert.equal(h.store.get(item.id).answer, "审批通过", "staged answer retained for the next resume");
		assert.equal(h.released.length, 1);
		assert.equal(h.errors.length, 1);
		assert.doesNotMatch(h.pushes[0].text, /secret|do-not-push/);
		assert.equal(h.sends.length, mode === "throw" ? 1 : 3);
	}
});

test("setup throws are inside the full lifecycle try/finally", async t => {
	const h = fixture(t, { options: { open: () => { throw new Error("setup failure"); } } });
	const item = h.create(); h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "waiting_human");
	assert.equal(h.sends.length, 0);
	assert.equal(h.released.length, 1);
	assert.equal(h.clock.timers.size, 1, "reminder timer armed for the stalled item");
});

test("restart recovery never repeats working effects; queued and due survive and run FIFO", async t => {
	const h = fixture(t);
	const interrupted = h.create("working");
	const future = h.create("scheduled");
	const due = h.create("scheduled");
	const queued = h.create();
	h.db.prepare("UPDATE work_items SET next_check_at = ? WHERE id = ?").run(h.clock.now() + 3_600_000, future.id);
	h.db.prepare("UPDATE work_items SET next_check_at = ? WHERE id = ?").run(h.clock.now() - 200, due.id);
	h.db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(h.clock.now() - 100, queued.id);
	h.service.start(); await flush();
	assert.equal(h.store.get(interrupted.id).status, "waiting_human");
	assert.deepEqual(h.sends.map(s => s.session.id), [due.id, queued.id]);
	assert.equal(h.store.get(future.id).status, "scheduled");
});

test("busy confirmations and resumes stay queued and eventually execute FIFO", async t => {
	const h = fixture(t, { send: h => h.sends.length === 1 ? gate.promise : { reply: "[[TASK_DONE]]" } });
	const gate = h.gate(); const first = h.create(); h.service.start(); await flush();
	const second = h.create("proposed"); const third = h.create("waiting_human");
	h.store.confirm(second.id, "admin");
	assert.equal(h.service.fireItem(second.id), false, "busy means queued, not already fired");
	h.store.resume(third.id, "已处理");
	assert.equal(h.service.fireItem(third.id), false, "busy resume remains persisted");
	await flush(); assert.equal(h.sends.length, 1);
	assert.equal(h.store.get(second.id).status, "queued");
	gate.resolve({ reply: "[[TASK_DONE]]" }); await flush();
	assert.deepEqual(h.sends.map(s => s.session.id), [first.id, second.id, third.id]);
	assert.match(h.sends[2].message, /已处理/);
});

test("cancel aborts immediately, holds single-window lock until send settles, and late DONE cannot overwrite", async t => {
	const h = fixture(t, { send: h => h.sends.length === 1 ? gate.promise : { reply: "[[TASK_DONE]]" } });
	const gate = h.gate(); const first = h.create(); const second = h.create();
	h.service.start(); await flush(); h.store.cancel(first.id); await flush();
	assert.deepEqual(h.aborted, [first.id]);
	assert.equal(h.sends.length, 1, "abort-ignoring send is still in flight");
	assert.equal(h.store.get(second.id).status, "queued");
	gate.resolve({ reply: "[[TASK_DONE]]\n[[NEXT_CHECK]]: 30m" }); await flush();
	assert.equal(h.store.get(first.id).status, "cancelled");
	assert.equal(h.sends.length, 2);
	assert.equal(h.learned.length, 1); // only second
	assert.equal(h.pushes.length, 1);
	assert.equal(h.clock.timers.size, 0);
});

test("admin pause mid-window aborts the send; a late reply cannot overwrite the pause", async t => {
	const h = fixture(t, { send: h => h.sends.length === 1 ? gate.promise : { reply: "[[TASK_DONE]]" } });
	const gate = h.gate(); const first = h.create(); const second = h.create();
	h.service.start(); await flush();
	assert.equal(h.store.get(first.id).status, "working");
	h.store.pause(first.id, "先核对口径"); await flush();
	assert.deepEqual(h.aborted, [first.id], "the pause marker triggers an immediate abort");
	assert.equal(h.sends.length, 1, "abort-ignoring send is still in flight");
	assert.equal(h.store.get(first.id).status, "waiting_human");
	assert.equal(h.store.get(first.id).question, "管理员暂停：先核对口径");
	gate.resolve({ reply: "[[TASK_DONE]]" }); await flush();
	const row = h.store.get(first.id);
	assert.equal(row.status, "waiting_human", "the runner must not overwrite the admin pause");
	assert.equal(row.question, "管理员暂停：先核对口径");
	assert.ok(h.pushes.some(p => p.cid === "dt:source" && /管理员暂停/.test(p.text)), "source push carries the pause marker question");
	assert.equal(h.sends.length, 2, "queued work proceeds once the window settles");
	assert.equal(h.store.get(second.id).status, "done");
	assert.equal(h.learned.length, 1, "only the second item completed");
});

test("a true queued kickoff carries the first-window plan block", async t => {
	const h = fixture(t);
	const item = h.create();
	h.service.start(); await flush();
	assert.match(h.sends[0].message, /【首个窗口：先出跟进计划】/);
	assert.ok(h.sends[0].message.indexOf("【首个窗口：先出跟进计划】") < h.sends[0].message.indexOf("窗口规则："));
	assert.equal(h.store.get(item.id).status, "done");
});

test("later turns, resumed, progress-carrying and scheduled wakes skip the plan block", async t => {
	// A resumed window: window 1 ran to NEED_HUMAN (kicked_off=1 durably),
	// the admin's answer resumes it as a continuation.
	const resumed = fixture(t, { send: h => h.sends.length === 1
		? { reply: "[[NEED_HUMAN]]: 需要审批号" }
		: { reply: "[[TASK_DONE]]" } });
	const a = resumed.create();
	resumed.service.start(); await flush();
	assert.match(resumed.sends[0].message, /【首个窗口：先出跟进计划】/, "window 1 is a true kickoff");
	assert.equal(resumed.store.get(a.id).status, "waiting_human");
	resumed.store.resume(a.id, "管理员答复"); await flush();
	assert.doesNotMatch(resumed.sends[1].message, /【首个窗口：先出跟进计划】/, "resumed window never re-plans");
	assert.match(resumed.sends[1].message, /管理员答复/);
	// A window with carried progress is a continuation, not a kickoff
	// (seeded kicked_off=1: a prior window ran; progress without a prior
	// window is synthetic and the durable marker is the source of truth).
	const progressed = fixture(t);
	const b = progressed.create();
	progressed.db.prepare("UPDATE work_items SET kicked_off = 1 WHERE id = ?").run(b.id);
	progressed.store.setField(b.id, "progress", "已有前期进展");
	progressed.service.start(); await flush();
	assert.doesNotMatch(progressed.sends[0].message, /【首个窗口：先出跟进计划】/);
	// A scheduled wake (previous self-declared follow-up) is not a first window either.
	const scheduled = fixture(t);
	const c = scheduled.create("scheduled");
	scheduled.db.prepare("UPDATE work_items SET next_check_at = ?, kicked_off = 1 WHERE id = ?").run(scheduled.clock.now() - 100, c.id);
	scheduled.service.start(); await flush();
	assert.doesNotMatch(scheduled.sends[0].message, /【首个窗口：先出跟进计划】/);
	// Within a first window only turn 0 plans; follow-up turns continue.
	const multi = fixture(t, { send: h => h.sends.length === 1 ? gate.promise : { reply: "[[TASK_DONE]]" } });
	const gate = multi.gate();
	multi.create();
	multi.service.start(); await flush();
	gate.resolve({ reply: "第一步已完成，继续" }); await flush();
	assert.doesNotMatch(multi.sends[1].message, /【首个窗口：先出跟进计划】/);
});

test("deadline actually aborts a hung send, never races it with a new send", async t => {
	const h = fixture(t, { send: h => h.sends.length === 1 ? gate.promise : { reply: "[[TASK_DONE]]" } });
	const gate = h.gate(); const first = h.create("waiting_human"); h.store.resume(first.id, "已审批，请核查");
	h.service.start(); await flush(); const second = h.create();
	await h.clock.advance(30 * 60_000);
	assert.deepEqual(h.aborted, [first.id]);
	assert.equal(h.sends.length, 1);
	gate.resolve({ reply: "[[TASK_DONE]]" }); await flush();
	assert.equal(h.store.get(first.id).status, "waiting_human");
	assert.match(h.store.get(first.id).question, /超时/);
	assert.equal(h.store.get(first.id).answer, "已审批，请核查", "aborted send is not a successful delivery");
	assert.equal(h.store.get(second.id).status, "done");
	assert.equal(h.sends.length, 2);
});

test("missing/revoked confirming identity waits before session/tool execution", async t => {
	for (const createdBy of [null, "", "   ", "revoked-admin"]) {
		let opened = 0;
		const h = fixture(t, { options: { open: () => { opened++; return { abort() {} }; } } });
		const item = h.create("queued", { createdBy }); h.service.start(); await flush();
		assert.equal(opened, 0);
		assert.equal(h.sends.length, 0);
		assert.equal(h.store.get(item.id).status, "waiting_human");
	}
});

test("revocation after a turn forbids the next send and persists human block", async t => {
	const h = fixture(t, { send: h => { h.admin = false; return { reply: "下一轮开始操作" }; } });
	const item = h.create(); h.service.start(); await flush();
	assert.equal(h.sends.length, 1);
	assert.equal(h.store.get(item.id).status, "waiting_human");
	assert.equal(h.learned.length, 0);
});

test("shutdown clears due timers and aborts without dispatching queued work", async t => {
	const h = fixture(t, { send: () => gate.promise });
	const gate = h.gate(); const item = h.create(); const queued = h.create();
	h.service.start(); await flush();
	const stopping = h.service.stop(); await flush();
	assert.deepEqual(h.aborted, [item.id]);
	assert.equal(h.sends.length, 1);
	gate.resolve({ reply: "[[TASK_DONE]]" }); await stopping; await flush();
	assert.equal(h.store.get(item.id).status, "waiting_human");
	assert.equal(h.store.get(queued.id).status, "queued");
	assert.equal(h.clock.timers.size, 0);
});

test("push/cleanup errors cannot undo a persisted terminal outcome", async t => {
	const h = fixture(t, { release: () => { throw new Error("release"); }, push: () => { throw new Error("push"); } });
	const item = h.create(); h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "done");
	assert.equal(h.errors.length, 2);
	assert.equal(h.learned.length, 1);
});

test("learning honors BOTH live KB toggles at completion", async t => {
	for (const kb of [{ enabled: false, learn: { enabled: true } }, { enabled: true, learn: { enabled: false } }, { enabled: true, learn: { enabled: true } }]) {
		const h = fixture(t, { options: { canLearn: () => kb.enabled && kb.learn.enabled } });
		const item = h.create(); h.service.start(); await flush();
		assert.equal(h.store.get(item.id).status, "done");
		assert.equal(h.learned.length, kb.enabled && kb.learn.enabled ? 1 : 0);
	}
	const kb = { enabled: true, learn: { enabled: true } };
	const h = fixture(t, { send: () => { kb.learn.enabled = false; return { reply: "[[TASK_DONE]]" }; }, options: { canLearn: () => kb.enabled && kb.learn.enabled } });
	h.create(); h.service.start(); await flush();
	assert.equal(h.learned.length, 0, "read toggles after execution, not at startup");
});

test("learning excludes raw answers/origin evidence and reuses sensitive-notebook backstop", t => {
	const h = fixture(t);
	const item = h.create();
	const input = buildWorkLearning({ ...item, conditions: "勿重复付款", progress: "已核查", lessons: JSON.stringify(["先检查结果"]), answer: "password=RAW", origin_note: "token=RAW" }, "完成");
	assert.match(input.content, /勿重复付款/);
	assert.match(input.content, /先检查结果/);
	assert.match(input.content, /已核查/);
	assert.doesNotMatch(input.content, /RAW/);
	for (const field of ["title", "goal", "conditions", "progress"]) {
		assert.equal(buildWorkLearning({ ...item, [field]: "密码是 do-not-copy" }, "完成"), undefined, field);
	}
	assert.equal(buildWorkLearning({ ...item, lessons: JSON.stringify(["token=do-not-copy"]) }, "完成"), undefined);
	assert.equal(buildWorkLearning(item, "password: do-not-copy"), undefined);
});

test("no dispatch before start; stop clears the sole future due timer", async t => {
	const h = fixture(t); const item = h.create();
	assert.equal(h.service.fireItem(item.id), false);
	await flush(); assert.equal(h.sends.length, 0);
	h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "done");
	const future = h.create("scheduled");
	h.db.prepare("UPDATE work_items SET next_check_at = ? WHERE id = ?").run(h.clock.now() + 2 * 3_600_000, future.id);
	await flush();
	assert.equal(h.clock.timers.size, 1);
	await h.service.stop();
	assert.equal(h.clock.timers.size, 0);
	await h.clock.advance(3 * 3_600_000);
	assert.equal(h.sends.length, 1);
	assert.equal(h.store.get(future.id).status, "scheduled");
});

test("cleanup also retains the window lock until release settles", async t => {
	const h = fixture(t, { release: h => h.released.length === 1 ? gate.promise : undefined });
	const gate = h.gate(); const first = h.create(); const second = h.create();
	h.service.start(); await flush();
	assert.equal(h.store.get(first.id).status, "done");
	assert.equal(h.store.get(second.id).status, "queued");
	assert.equal(h.sends.length, 1);
	gate.resolve(); await flush();
	assert.equal(h.sends.length, 2);
	assert.equal(h.store.get(second.id).status, "done");
});

test("routine cadence: prefix carries the last check + warning; streak accumulates; push suggests a scheduled task", async t => {
	const h = fixture(t, { send: h => h.sends.length === 1
		? { reply: "对账批次 16:00 生成，今日无异常\n[[NEXT_CHECK]]: 明天16:00 | 每日巡检" }
		: { reply: "无异常\n[[TASK_DONE]]" } });
	const item = h.create("scheduled");
	// Seed: this window wakes from a follow-up the model declared for yesterday
	// 16:00 — already the 2nd consecutive same-daily-slot pick.
	const dueAt = new Date("2026-10-01T16:00:00").getTime();
	h.db.prepare("UPDATE work_items SET next_check_at = ?, next_check_reason = ?, fixed_streak = 2 WHERE id = ?")
		.run(dueAt, "每日巡检", item.id);
	h.service.start(); await flush();
	assert.equal(h.sends.length, 0, "not due until 16:00");
	await h.clock.advance(6 * 3_600_000);
	assert.equal(h.sends.length, 1);
	assert.match(h.sends[0].message, /【上次跟进】.*16:00.*（每日巡检）/);
	assert.match(h.sends[0].message, /【节奏提示】/);
	assert.match(h.sends[0].message, /连续 2 次/);
	const row = h.store.get(item.id);
	assert.equal(row.status, "scheduled");
	assert.equal(row.fixed_streak, 3, "same slot tomorrow → streak 3");
	assert.equal(row.next_check_reason, "每日巡检");
	assert.match(h.pushes[0].text, /连续 3 次/);
	assert.match(h.pushes[0].text, /定时任务/);
});

test("a different follow-up slot resets the streak; no conversion suggestion pushed", async t => {
	const h = fixture(t, { send: h => h.sends.length === 1
		? { reply: "批次提前了\n[[NEXT_CHECK]]: 2小时 | 等新批次" }
		: { reply: "[[TASK_DONE]]" } });
	const item = h.create("scheduled");
	h.db.prepare("UPDATE work_items SET next_check_at = ?, fixed_streak = 3 WHERE id = ?").run(h.clock.now(), item.id);
	h.service.start(); await flush();
	const row = h.store.get(item.id);
	assert.equal(row.status, "scheduled");
	assert.equal(row.fixed_streak, 0, "a 2h gap is not a daily slot");
	assert.equal(row.next_check_reason, "等新批次");
	assert.doesNotMatch(h.pushes[0].text, /定时任务/);
});

test("an invalid NEXT_CHECK soft-falls-back to the default re-check instead of killing the chain", async t => {
	// Field 2026-10-03: an unparseable/past declared time used to pause the item
	// with no next time at all — the chain died on a format slip. Now it must
	// stay scheduled on the default 1h re-check, with the raw slip surfaced.
	const h = fixture(t, { send: () => ({ reply: "进展正常\n[[NEXT_CHECK]]: 嘎嘎 09:00!! | 批次后检查" }) });
	const item = h.create("scheduled");
	h.db.prepare("UPDATE work_items SET next_check_at = ? WHERE id = ?").run(h.clock.now(), item.id);
	h.service.start(); await h.service.whenIdle();
	const row = h.store.get(item.id);
	assert.equal(row.status, "scheduled", "chain stays alive, no waiting_human");
	assert.ok(row.next_check_at !== null && row.next_check_at >= h.clock.now() + 55 * 60_000, "default ~1h re-check");
	assert.match(row.next_check_reason, /无法解析或已过期/);
	assert.match(row.next_check_reason, /嘎嘎/);
	assert.match(h.pushes[0].text, /顺延/);
});

test("empty and past NEXT_CHECK times soft-fall-back too (「空」 branch, expired branch)", async t => {
	for (const reply of ["[[NEXT_CHECK]] | 只写了原因", "完成今日部分\n[[NEXT_CHECK]]: 2020-01-01 09:00 | 早该查的"]) {
		const h = fixture(t, { send: () => ({ reply }) });
		const item = h.create(); h.service.start(); await flush();
		const row = h.store.get(item.id);
		assert.equal(row.status, "scheduled", reply);
		assert.match(row.next_check_reason, /无法解析或已过期/, reply);
		assert.equal(row.fallback_streak, 1, reply);
	}
});

test("three consecutive unusable NEXT_CHECKs escalate to a human; valid schedule and resume reset the meter", async t => {
	let bad = 0;
	const h = fixture(t, { send: () => ++bad <= 3
		? { reply: "[[NEXT_CHECK]]: 嘎嘎 | 等批次" }
		: { reply: "这轮有进展\n[[NEXT_CHECK]]: 2小时 | 等新批次" } });
	const item = h.create(); h.service.start(); await flush();
	let row = h.store.get(item.id);
	assert.equal(row.status, "scheduled");
	assert.equal(row.fallback_streak, 1, "first soft fallback recorded");

	// One advance runs the chained re-checks (w2 at +1h, w3 at +2h): both
	// unusable. Third one escalates instead of looping hourly forever.
	await h.clock.advance(2 * 3_600_000); await flush();
	row = h.store.get(item.id);
	assert.equal(row.status, "waiting_human");
	assert.match(row.question, /连续 3 次/);
	assert.match(row.question, /嘎嘎/);

	// Manual resume resets the meter; a valid schedule keeps it at zero.
	h.store.resume(item.id, "直接开始对账"); await flush();
	assert.equal(h.store.get(item.id).fallback_streak, 0, "resume clears the meter");
	row = h.store.get(item.id);
	assert.equal(row.status, "scheduled");
	assert.equal(row.fallback_streak, 0, "valid NEXT_CHECK keeps the meter at zero");
	assert.match(row.next_check_reason, /等新批次/);
});

test("admin update-reschedule (setSchedule) resets the fallback meter — the escalation's own suggested path", async t => {
	const h = fixture(t, { send: () => ({ reply: "[[NEXT_CHECK]]: 嘎嘎 | 等批次" }) });
	const item = h.create(); h.service.start(); await flush();
	await h.clock.advance(2 * 3_600_000); await flush(); // w2 → fb 2
	// One advance runs the chained re-checks (w2 at +1h, w3 at +2h): all three
	// unusable → third one escalates to waiting_human.
	await h.clock.advance(2 * 3_600_000); await flush();
	let row = h.store.get(item.id);
	assert.equal(row.status, "waiting_human");
	assert.match(row.question, /连续 3 次/);
	// Admin intervenes via update nextCheck (setSchedule) → meter must reset,
	// else one more slip escalates instantly at "4 ≥ 3".
	h.store.setSchedule(item.id, h.clock.now() + 3_600_000, "管理员指定时间");
	row = h.store.get(item.id);
	assert.equal(row.status, "scheduled");
	assert.equal(row.fallback_streak, 0, "setSchedule clears the meter");
});

test("waiting_human items are re-reminded every 24h instead of dying silently", async t => {
	const h = fixture(t, { send: () => {
		if (h.sends.length === 1) throw new Error("boom");
		return { reply: "已完成\n[[TASK_DONE]]" };
	} });
	const item = h.create(); h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "waiting_human");
	// store writes stamp real Date.now(); pin AFTER the transition so the
	// reminder deadline (updated_at + 24h) is reachable via advance().
	h.db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(h.clock.now(), item.id);
	// The wake timer was armed against the pre-pin (real) updated_at; restart
	// the service so it re-arms on the pinned deadline (test-only skew: in
	// production updated_at and the clock are both real time).
	await h.service.stop(); h.service.start(); await flush();
	assert.equal(h.pushes.length, 1, "the entry push");
	// A reminder wake timer EXISTS even though nothing is scheduled.
	assert.ok(h.clock.timers.size >= 1, "all-waiting_human board still has a timer");
	assert.equal(h.store.get(item.id).remind_count, 0);

	await h.clock.advance(23 * 3_600_000); await flush();
	assert.equal(h.pushes.length, 1, "no reminder before 24h");
	await h.clock.advance(1 * 3_600_000); await flush();
	assert.equal(h.pushes.length, 2, "first reminder at 24h");
	assert.match(h.pushes[1].text, /仍在等待人工/);
	assert.match(h.pushes[1].text, /已等待约 1 天/);
	assert.match(h.pushes[1].text, /执行出错/);
	assert.equal(h.store.get(item.id).remind_count, 1);

	await h.clock.advance(24 * 3_600_000); await flush();
	assert.equal(h.pushes.length, 3, "second reminder at 48h");
	assert.match(h.pushes[2].text, /已等待约 2 天/);

	// Resume detaches from the reminder loop.
	h.store.resume(item.id, "继续");
	await flush();
	await h.clock.advance(72 * 3_600_000); await flush();
	assert.equal(h.pushes.filter(p => /仍在等待人工/.test(p.text)).length, 2, "no reminders after resume");
	assert.equal(h.store.get(item.id).status, "done", "resumed window completed");
});

test("reminder staleness guard: inbound reply after the pause keeps the sweep quiet (field 2026-10-06)", async t => {
	// Fixture: lastInboundAt reports activity in the origin conversation AFTER the
	// pause — the human already answered (the resume path may have failed or the
	// answer is being processed); the sweep must NOT nag about the answered question.
	let inbound = null;
	const h = fixture(t, {
		send: () => ({ reply: "需要验证码\n[[NEED_HUMAN]]: 请提供验证码" }),
		lastInboundAt: (cid, sinceTs) => inbound,
	});
	const item = h.create(); h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "waiting_human");
	h.db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(h.clock.now(), item.id);
	await h.service.stop(); h.service.start(); await flush();
	assert.equal(h.pushes.length, 1, "the entry push");

	// Human replied in the group AFTER the pause → the FIRST reminder cycle is
	// suppressed (the answer landed; the resume path owns the follow-up).
	inbound = h.clock.now() + 1000;
	await h.clock.advance(30 * 3_600_000); await flush();
	assert.equal(h.pushes.length, 1, "answered question does not nag on the next cycle");
	assert.ok(h.errors.some((e) => String(e).includes("reminder suppressed")), "skip is surfaced via onError");
	assert.equal(h.store.get(item.id).remind_count, 1, "suppressed attempt still counts");

	// Watermark advanced with the suppression: a chatty group does NOT mute the
	// item forever — with no NEW inbound since the suppressed cycle, the next
	// cycle reminds again (silence = death is the failure mode this sweep exists for).
	await h.clock.advance(30 * 3_600_000); await flush();
	assert.equal(h.pushes.length, 2, "reminders resume when no NEW inbound since the watermark");
	assert.match(h.pushes[1].text, /仍在等待人工/);
});

test("third-plus reminders escalate the copy toward cancel-or-resume; admin-paused items are reminded too", async t => {
	const h = fixture(t, {});
	const item = h.create();
	h.store.pause(item.id, "管理员主动暂停");
	h.db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(h.clock.now(), item.id);
	h.service.start(); await flush();
	// Fast-forward four reminder cycles.
	for (let i = 0; i < 4; i++) { await h.clock.advance(24 * 3_600_000); await flush(); }
	const reminders = h.pushes.filter(p => /仍在等待人工/.test(p.text));
	assert.equal(reminders.length, 4, "admin-paused items are reminded on the same cadence");
	assert.doesNotMatch(reminders[0].text, /第 \d+ 次提醒/);
	assert.match(reminders[3].text, /第 4 次提醒/);
	assert.match(reminders[3].text, /回复取消/);
});

test("re-entering waiting_human starts a fresh reminder episode (setSchedule path)", async t => {
	// Interval > 24h: a stale last_remind_at would push an expired reminder
	// instantly after the fresh NEED_HUMAN push (review-reproduced).
	const h = fixture(t, { send: () => ({ reply: "还缺数据\n[[NEED_HUMAN]]: 等财务给数字" }) });
	const item = h.create(); h.service.start(); await flush();
	const afterStall = h.store.get(item.id);
	assert.equal(afterStall.status, "waiting_human");
	// Age the stall, take one reminder, then admin reschedules 8 days out.
	h.db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(h.clock.now() - 24 * 3_600_000, item.id);
	await h.service.stop(); h.service.start(); await flush();
	assert.equal(h.pushes.filter(p => /仍在等待人工/.test(p.text)).length, 1);
	h.store.setSchedule(item.id, h.clock.now() + 192 * 3_600_000, "8 天后复查");
	const rescheduled = h.store.get(item.id);
	assert.equal(rescheduled.remind_count, 0, "setSchedule clears the meter");
	assert.equal(rescheduled.last_remind_at, null);

	// New window stalls again -> fresh episode (setStatus cleared the meters).
	await h.clock.advance(192 * 3_600_000); await flush();
	assert.equal(h.store.get(item.id).status, "waiting_human");
	// Store writes stamp real Date.now() (ahead of the fake clock), so align
	// the fresh entry to the fake clock before observing the cadence.
	h.db.prepare("UPDATE work_items SET updated_at = ?, last_remind_at = NULL, remind_count = 0 WHERE id = ?").run(h.clock.now(), item.id);
	await h.service.stop(); h.service.start(); await flush();
	await h.clock.advance(23 * 3_600_000); await flush();
	const before = h.pushes.filter(p => /仍在等待人工/.test(p.text)).length;
	await h.clock.advance(1 * 3_600_000); await flush();
	const after = h.pushes.filter(p => /仍在等待人工/.test(p.text)).length;
	assert.equal(after - before, 1, "fresh episode: first reminder exactly 24h after re-entry");
	assert.doesNotMatch(h.pushes.at(-1).text, /第 \d+ 次提醒/, "copy does not escalate on a fresh episode");
});

test("reminder cadence follows the task's own rhythm (high-frequency task is not left silent for a day)", async t => {
	// Window 1 declares a 2h rhythm and keeps scheduling; window 3 stalls.
	let stalled = false;
	const h = fixture(t, { send: h => {
		if (stalled) return { reply: "卡住了\n[[NEED_HUMAN]]: 等数据源恢复" };
		return h.sends.length === 1
			? { reply: "首查完成\n[[NEXT_CHECK]]: 2小时 | 下一批数据" }
			: { reply: "进展\n[[NEXT_CHECK]]: 2小时 | 继续" };
	} });
	const item = h.create(); h.service.start(); await flush();
	// Ride one 2h cycle so the cadence is recorded, then stall.
	await h.clock.advance(2 * 3_600_000); await flush();
	stalled = true;
	await h.clock.advance(2 * 3_600_000); await flush();
	const row = h.store.get(item.id);
	assert.equal(row.status, "waiting_human");
	assert.ok(row.cadence_ms !== null && row.cadence_ms > 1.5 * 3_600_000 && row.cadence_ms <= 2 * 3_600_000, `EMA cadence ~2h, got ${row.cadence_ms}`);
	// Pin the stall entry to the fake clock (setStatus stamps real Date.now())
	// and re-arm, so the reminder deadline is reachable via advance().
	h.db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(h.clock.now(), item.id);
	await h.service.stop(); h.service.start(); await flush();
	// First reminder after ~2h, NOT 24h.
	await h.clock.advance(1 * 3_600_000); await flush();
	assert.equal(h.pushes.filter(p => /仍在等待人工/.test(p.text)).length, 0, "no reminder before one rhythm interval");
	await h.clock.advance(1 * 3_600_000); await flush();
	const reminders = h.pushes.filter(p => /仍在等待人工/.test(p.text));
	assert.equal(reminders.length, 1, "first reminder at the task's own 2h rhythm");
	assert.match(reminders[0].text, /原节奏约每 2 小时一次/);
	assert.match(reminders[0].text, /观察点都在错过/);
	// EMA damping: a single outlier declaration does not collapse the rhythm.
});

test("cadence floor: a 30-minute rhythm task gets 30-minute reminders; EMA damps outliers", async t => {
	let stall = false;
	const h = fixture(t, { send: h => {
		if (stall) return { reply: "卡\n[[NEED_HUMAN]]: 等权限" };
		return { reply: "进展\n[[NEXT_CHECK]]: 30分钟 | 快节奏" };
	} });
	const item = h.create(); h.service.start(); await flush();
	// Two 30min cycles → EMA converges to exactly 30min.
	for (let i = 0; i < 2; i++) { await h.clock.advance(30 * 60_000); await flush(); }
	stall = true;
	await h.clock.advance(30 * 60_000); await flush();
	assert.equal(h.store.get(item.id).status, "waiting_human");
	assert.equal(h.store.get(item.id).cadence_ms, 30 * 60_000, "EMA converged on the 30min rhythm");
	// Pin the stall entry to the fake clock (setStatus stamps real time) + re-arm.
	h.db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(h.clock.now(), item.id);
	await h.service.stop(); h.service.start(); await flush();
	await h.clock.advance(29 * 60_000); await flush();
	assert.equal(h.pushes.filter(p => /仍在等待人工/.test(p.text)).length, 0, "no reminder before one 30min interval");
	await h.clock.advance(1 * 60_000); await flush();
	assert.ok(h.pushes.filter(p => /仍在等待人工/.test(p.text)).length >= 1, "reminder at the task's own 30min rhythm");

	// EMA damping is a property of the store: one 25h outlier moves a 30min
	// rhythm to only ~8.5h, not 25h.
	h.store.setCadence(item.id, 25 * 3_600_000);
	const damped = h.store.get(item.id).cadence_ms;
	assert.ok(damped > 4 * 3_600_000 && damped < 12 * 3_600_000, `one outlier damped, got ${damped}`);
});

test("sub-floor cadence clamps to the 30min reminder floor", async t => {
	let stall = false;
	const h = fixture(t, { send: h => {
		if (stall) return { reply: "卡\n[[NEED_HUMAN]]: 等资源" };
		return { reply: "进展\n[[NEXT_CHECK]]: 16分钟 | 极快节奏" };
	} });
	const item = h.create(); h.service.start(); await flush();
	for (let i = 0; i < 2; i++) { await h.clock.advance(16 * 60_000); await flush(); }
	stall = true;
	await h.clock.advance(16 * 60_000); await flush();
	// EMA of all-16min declarations is below the 30min floor → clamped.
	const cadence = h.store.get(item.id).cadence_ms;
	assert.ok(cadence !== null && cadence < 30 * 60_000, `sub-floor cadence kept raw (${cadence})`);
	h.db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(h.clock.now(), item.id);
	await h.service.stop(); h.service.start(); await flush();
	await h.clock.advance(29 * 60_000); await flush();
	assert.equal(h.pushes.filter(p => /仍在等待人工/.test(p.text)).length, 0, "floor holds: no reminder before 30min");
	await h.clock.advance(1 * 60_000); await flush();
	assert.ok(h.pushes.filter(p => /仍在等待人工/.test(p.text)).length >= 1, "reminder at the 30min floor");
});

test("a pause landing during release suppresses the stale scheduled push (L4)", async t => {
	// The runner decides scheduled; while release() is still awaited, an admin
	// pause flips the row to waiting_human. The post-finally capture must see it
	// (fresh.status !== outcome) and skip the stale "下次跟进 X" push entirely.
	let pausedDuringRelease = false;
	const h = fixture(t, {
		send: () => ({ reply: "阶段成果\n[[NEXT_CHECK]]: 30m | 等批次" }),
		release: async h => {
			if (!pausedDuringRelease) {
				pausedDuringRelease = true;
				h.store.pause(h.store.list()[0].id, "管理员先停一下");
				await flush();
			}
		},
	});
	const item = h.create();
	h.service.start(); await flush();
	assert.ok(h.pushes.every(p => !/下次跟进/.test(p.text)), "no stale scheduled push after a concurrent pause");
	assert.equal(h.store.get(item.id).status, "waiting_human");
	assert.match(h.store.get(item.id).question, /管理员先停一下/);
});

test("a late-firing scheduled window tells the model it is catching up (delay awareness)", async t => {
	const h = fixture(t, { send: h => ({ reply: "查过了，无新异常\n[[TASK_DONE]]" }) });
	const item = h.create("scheduled");
	// Originally due 3h ago; the app was offline.
	h.db.prepare("UPDATE work_items SET next_check_at = ?, next_check_reason = ? WHERE id = ?")
		.run(h.clock.now() - 3 * 3_600_000, "下午观察点", item.id);
	h.service.start(); await flush();
	assert.match(h.sends[0].message, /【延迟说明】/);
	assert.match(h.sends[0].message, /晚了约 3 小时/);
	assert.match(h.sends[0].message, /下午观察点/);
	// On-time windows carry no delay note.
	const h2 = fixture(t, { send: () => ({ reply: "ok\n[[TASK_DONE]]" }) });
	const item2 = h2.create("scheduled");
	h2.db.prepare("UPDATE work_items SET next_check_at = ? WHERE id = ?").run(h2.clock.now(), item2.id);
	h2.service.start(); await h2.service.whenIdle();
	assert.doesNotMatch(h2.sends[0].message, /【延迟说明】/);
});

test("an admin update-nextCheck landing during release wins over the run's stale schedule metadata (Copilot fast-follow)", async t => {
	let updatedDuringRelease = false;
	const h = fixture(t, {
		send: () => ({ reply: "阶段成果\n[[NEXT_CHECK]]: 30m | 等批次" }),
		release: async h => {
			if (!updatedDuringRelease) {
				updatedDuringRelease = true;
				const row = h.store.list()[0];
				h.store.setSchedule(row.id, h.clock.now() + 2 * 3_600_000, "管理员改期到两小时后");
				await flush();
			}
		},
	});
	const item = h.create();
	h.service.start(); await flush();
	await h.service.whenIdle(); await flush();
	const push = h.pushes.find(p => /下次跟进/.test(p.text));
	assert.ok(push, "scheduled push still lands (row stays scheduled)");
	assert.match(push.text, /管理员改期到两小时后/, "push announces the admin's new schedule, not the run's local one");
	assert.doesNotMatch(push.text, /30 分钟|等批次/);
});

test("transient send failure is absorbed by quiet backoff retries — no execution-error pause", async t => {
	let calls = 0;
	const h = fixture(t, { send: () => {
		calls += 1;
		if (calls === 1) return { deterministic: true, reply: "很抱歉，刚才没有产出" };
		if (calls === 2) return { error: "Connection error." };
		return { reply: "核对全部完成\n[[TASK_DONE]]" };
	} });
	const item = h.create();
	h.service.start(); await flush();
	// L1 (review 2026-10-08): the backoff is REALLY waiting — a pending timer
	// at ~+60s must exist before the clock advances.
	assert.ok([...h.clock.timers.values()].some(timer => {
		const due = timer.at - h.clock.time;
		return due > 55_000 && due <= 60_000;
	}), "first backoff timer armed at ~60s");
	await h.clock.advance(10 * 60_000); await flush();
	assert.equal(h.store.get(item.id).status, "done", "item completes after retries absorb the blip");
	assert.equal(calls, 3, "2 quiet retries + the successful attempt");
	assert.ok(!h.pushes.some(p => /执行出错/.test(p.text)), "no execution-error surface for an absorbed blip");
});

test("persistent send failure escalates to the execution-error pause after graded retries", async t => {
	const h = fixture(t, { send: () => ({ deterministic: true, reply: "很抱歉，刚才没有产出" }) });
	const item = h.create();
	h.service.start(); await flush();
	await h.clock.advance(10 * 60_000); await flush();
	await flush();
	assert.equal(h.store.get(item.id).status, "waiting_human");
	assert.ok(h.pushes.some(p => /执行出错/.test(p.text)), "honest error pause after retries exhausted");
	assert.ok(h.errors.length >= 1, "onError recorded for observability");
});

test("a stop landing during backoff does not fire another send (review H1)", async t => {
	let calls = 0;
	const h = fixture(t, { send: () => { calls += 1; return { error: "Connection error." }; } });
	const item = h.create();
	h.service.start(); await flush();
	assert.equal(calls, 1, "first attempt made, now inside backoff");
	const stopped = h.service.stop();
	await h.clock.advance(10 * 60_000); await flush();
	await stopped;
	assert.equal(calls, 1, "no resend after a stop landing during the backoff");
	assert.equal(h.store.get(item.id).status, "waiting_human");
});
