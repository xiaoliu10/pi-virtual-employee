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
	assert.equal(h.sends.length, 1);
	assert.equal(h.clock.timers.size, 0);
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

test("invalid/too-near NEXT_CHECK and markerless exhausted budget wait for humans", async t => {
	for (const reply of ["[[NEXT_CHECK]]: 1m | 空跑", "[[NEXT_CHECK]]: 垃圾", "进行中"]) {
		const h = fixture(t, { send: () => ({ reply }) });
		const item = h.create(); h.service.start(); await flush();
		assert.equal(h.store.get(item.id).status, "waiting_human", reply);
		assert.equal(h.clock.timers.size, 0);
		assert.equal(h.learned.length, 0);
	}
});

test("throws and returned errors retain staged answers, settle cleanup and wait (no unsafe retries)", async t => {
	for (const mode of ["throw", "error"]) {
		const h = fixture(t, { send: () => { if (mode === "throw") throw new Error("secret=do-not-push"); return { error: "secret=do-not-push" }; } });
		const item = h.create("waiting_human"); h.store.resume(item.id, "审批通过");
		h.service.start(); await flush();
		assert.equal(h.store.get(item.id).status, "waiting_human");
		assert.equal(h.store.get(item.id).answer, "审批通过");
		assert.equal(h.released.length, 1);
		assert.equal(h.errors.length, 1);
		assert.doesNotMatch(h.pushes[0].text, /secret|do-not-push/);
		await h.clock.advance(24 * 3_600_000);
		assert.equal(h.sends.length, 1);
	}
});

test("setup throws are inside the full lifecycle try/finally", async t => {
	const h = fixture(t, { options: { open: () => { throw new Error("setup failure"); } } });
	const item = h.create(); h.service.start(); await flush();
	assert.equal(h.store.get(item.id).status, "waiting_human");
	assert.equal(h.sends.length, 0);
	assert.equal(h.released.length, 1);
	assert.equal(h.clock.timers.size, 0);
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
	// A resumed window: the admin's answer makes it not a first window.
	const resumed = fixture(t);
	const a = resumed.create("waiting_human");
	resumed.store.resume(a.id, "管理员答复");
	resumed.service.start(); await flush();
	assert.doesNotMatch(resumed.sends[0].message, /【首个窗口：先出跟进计划】/);
	assert.match(resumed.sends[0].message, /管理员答复/);
	// A window with carried progress is a continuation, not a kickoff.
	const progressed = fixture(t);
	const b = progressed.create();
	progressed.store.setField(b.id, "progress", "已有前期进展");
	progressed.service.start(); await flush();
	assert.doesNotMatch(progressed.sends[0].message, /【首个窗口：先出跟进计划】/);
	// A scheduled wake (previous self-declared follow-up) is not a first window either.
	const scheduled = fixture(t);
	const c = scheduled.create("scheduled");
	scheduled.db.prepare("UPDATE work_items SET next_check_at = ? WHERE id = ?").run(scheduled.clock.now() - 100, c.id);
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
