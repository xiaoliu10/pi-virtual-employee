/**
 * Work-item tests (autonomous work phase 2). Run with `node --test scripts/test-work.mjs`.
 *
 * Pinned properties: window-reply classification (markers lead a line, human
 * wins, next_check parses the model's OWN cadence — the field explicitly
 * rejected fixed high-frequency polling), the window prefix carrying
 * conditions/progress/lessons (the "self-evolution memory"), and the store's
 * staged-answer channel for waiting_human resumes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.work-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "work.mjs");
await build({
	stdin: {
		contents: `
			export * from "./src/scheduler/work.ts";
			export * from "./src/scheduler/mining.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const work = await import(pathToFileURL(bundle).href);
const { parseWindowReply, parseNextCheck, buildWorkWindowPrefix, parseMiningReply, isDuplicateGoal, isSameDailySlot, nextRoutineStreak } = work;

test("parseWindowReply classifies the four window outcomes", () => {
	const done = parseWindowReply("对账完成，共 1204 笔无异常。\n[[TASK_DONE]]");
	assert.equal(done.kind, "done");
	assert.equal(done.text, "对账完成，共 1204 笔无异常。");

	const human = parseWindowReply("卡在审批。\n[[NEED_HUMAN]]: 需要财务总监在系统里授权");
	assert.equal(human.kind, "human");
	assert.match(human.question, /财务总监/);

	const self = parseWindowReply("上午批次已核对，晚上还有一批。\n[[NEXT_CHECK]]: 21:30 | 晚间批次 21:00 生成");
	assert.equal(self.kind, "next_check");
	assert.ok(self.nextCheckAt && self.nextCheckAt > Date.now(), "21:30 resolves to a future time");
	assert.match(self.nextCheckReason, /晚间批次/);
	assert.equal(self.text, "上午批次已核对，晚上还有一批。");

	assert.equal(parseWindowReply("正在逐笔核对，进度 60%。").kind, "continue");
});

test("parseNextCheck understands relative minutes/hours, HH:MM, 明天HH:MM", () => {
	const now = new Date("2026-09-30T10:00:00");
	assert.equal(parseNextCheck("30m", now), now.getTime() + 30 * 60_000);
	assert.equal(parseNextCheck("2小时", now), now.getTime() + 120 * 60_000);
	const at = parseNextCheck("09:40", now);
	assert.ok(at && at > now.getTime(), "a past time today rolls to tomorrow");
	const atDate = new Date(at);
	assert.ok(atDate > now, "09:40 after 10:00 rolls forward");
	assert.equal(atDate.getHours(), 9);
	assert.equal(atDate.getMinutes(), 40);
	const tomorrow = parseNextCheck("明天09:00", new Date("2026-09-30T23:00:00"));
	assert.ok(tomorrow && tomorrow > new Date("2026-09-30T23:00:00").getTime(), "explicit 明天 rolls to tomorrow");
	assert.equal(new Date(tomorrow).getHours(), 9);
	assert.equal(parseNextCheck("嘎嘎"), undefined);
});

test("buildWorkWindowPrefix carries conditions, progress, lessons and the protocol", () => {
	const prefix = buildWorkWindowPrefix({
		title: "月末对账",
		goal: "核对 9 月流水",
		conditions: "系统自动对账 08:00-09:30，勿手动触发",
		progress: "已核对 60%",
		lessons: ["登录态每天失效一次", "对账页在第 3 个标签"],
		turn: 0,
		budget: { maxTurns: 15, maxMinutes: 30 },
	});
	assert.match(prefix, /【工作项】月末对账/);
	assert.match(prefix, /【目标】核对 9 月流水/);
	assert.match(prefix, /15 分钟/);
	assert.match(prefix, /系统自动对账 08:00-09:30/);
	assert.match(prefix, /已核对 60%/);
	assert.match(prefix, /登录态每天失效一次/);
	assert.match(prefix, /\[\[TASK_DONE\]\]/);
	assert.match(prefix, /\[\[NEXT_CHECK\]\]/);
	assert.match(prefix, /manage_work/);
});

test("parseMiningReply extracts proposals and tolerates fences/garbage", () => {
	const reply = '```json\n{"proposals":[{"title":"每日订单巡检","goal":"每天上午核对昨日订单状态，异常单标记并汇报","evidence":"对方：这个你能不能每天自己盯着","conditions":"","origin_conversation":"dt:group:abc"}]}\n```';
	const proposals = parseMiningReply(reply);
	assert.equal(proposals.length, 1);
	assert.equal(proposals[0].title, "每日订单巡检");
	assert.equal(proposals[0].originConversation, "dt:group:abc");
	assert.deepEqual(parseMiningReply("我觉得没啥可提案的。"), []);
	assert.deepEqual(parseMiningReply('{"proposals":[{"title":"没有目标"}]}'), []);
});

test("isDuplicateGoal collapses whitespace without merging distinct short goals", () => {
	assert.ok(isDuplicateGoal("每天 上午核对 订单状态，异常单标记并汇报", ["每天上午核对订单状态，异常单标记并汇报"]));
	assert.ok(!isDuplicateGoal("每天上午核对订单状态，异常单标记并汇报", ["每天上午核对订单状态，异常单标记并汇报并推送"]));
	assert.ok(!isDuplicateGoal("整理供应商合同台账", ["每天上午核对订单状态"]));
});

test("human ALWAYS outranks done and markdown marker payloads are clean", () => {
	for (const reply of [
		"摘要\n**[[NEED_HUMAN]]**: **请审批**\n[[TASK_DONE]]",
		"摘要\n[[TASK_DONE]]\n> - __[[NEED_HUMAN]]: 请审批__",
		"摘要\n`[[NEED_HUMAN]]`: 请审批\n**[[TASK_DONE]]**",
		"摘要\n*[[NEED_HUMAN]]*: *请审批*\n_[[TASK_DONE]]_",
	]) {
		const parsed = parseWindowReply(reply);
		assert.equal(parsed.kind, "human");
		assert.equal(parsed.question, "请审批");
		assert.equal(parsed.text, "摘要");
	}
	const next = parseWindowReply("摘要\n**[[NEXT_CHECK]]**: **30m** | **等批次**", new Date("2026-10-01T10:00:00"));
	assert.equal(next.nextCheckReason, "等批次");
	assert.ok(next.nextCheckAt);
	assert.equal(parseWindowReply("**[[NEED_HUMAN]]**: 请核查 order_status 字段").question, "请核查 order_status 字段");
});

test("explicit tomorrow always advances the day, even when its clock time is later today", () => {
	const now = new Date("2026-09-30T08:00:00");
	const target = new Date(parseNextCheck("明天09:40", now));
	assert.equal(target.getDate(), 1);
	assert.equal(target.getMonth(), 9);
	assert.equal(target.getHours(), 9);
});

test("follow-up strictly rejects impossible, past, malformed and <15-minute times", () => {
	const now = new Date("2026-09-30T10:00:00");
	for (const raw of ["0m", "1m", "14min", "10:14", "30m junk", "later 11:00", "25:30", "11:99", "11:5", "2026-09-29T10:00:00", "2026-02-30T10:00:00", "2026-13-01T10:00:00", "2026-10-01T24:00:00"]) {
		assert.equal(parseNextCheck(raw, now), undefined, raw);
	}
	assert.equal(parseNextCheck("15min", now), now.getTime() + 15 * 60_000);
	assert.equal(parseNextCheck("2026-09-30T10:15:00", now), now.getTime() + 15 * 60_000);
});

test("isSameDailySlot/nextRoutineStreak measure cron degeneration deterministically", () => {
	const t0 = new Date("2026-10-01T16:00:00").getTime();
	const nextDay = new Date("2026-10-02T16:10:00").getTime(); // 24h10m later, slot diff 10m
	const evening = new Date("2026-10-02T18:00:00").getTime(); // 26h later, slot diff 2h
	const twoDays = new Date("2026-10-03T16:00:00").getTime(); // 48h later
	assert.ok(isSameDailySlot(t0, nextDay));
	assert.ok(!isSameDailySlot(t0, evening));
	assert.ok(!isSameDailySlot(t0, twoDays));
	assert.ok(!isSameDailySlot(NaN, nextDay));
	assert.equal(nextRoutineStreak(t0, 2, nextDay), 3);
	assert.equal(nextRoutineStreak(t0, 2, evening), 0, "a different slot resets the streak");
	assert.equal(nextRoutineStreak(undefined, 2, nextDay), 0, "manual resume resets (conservative)");
});

test("window prefix injects the last check and confronts repeated fixed slots", () => {
	const budget = { maxTurns: 15, maxMinutes: 30 };
	const calm = buildWorkWindowPrefix({
		title: "月末对账", goal: "核对流水", turn: 0, budget,
		lastCheck: { at: new Date("2026-10-01T16:00:00").getTime(), reason: "每日巡检", streak: 1 },
	});
	assert.match(calm, /【上次跟进】/);
	assert.match(calm, /每日巡检/);
	assert.match(calm, /时间必须写明依据/);
	assert.doesNotMatch(calm, /节奏提示/);

	const hot = buildWorkWindowPrefix({
		title: "月末对账", goal: "核对流水", turn: 0, budget,
		lastCheck: { at: new Date("2026-10-01T16:00:00").getTime(), reason: null, streak: 2 },
	});
	assert.match(hot, /【节奏提示】/);
	assert.match(hot, /连续 2 次/);
	assert.match(hot, /定时任务/);
});

test("firstWindow adds the plan block before the protocol; later turns and non-kickoffs omit it", () => {
	const budget = { maxTurns: 15, maxMinutes: 30 };
	const first = buildWorkWindowPrefix({ title: "月末对账", goal: "核对流水", turn: 0, budget, firstWindow: true });
	assert.match(first, /【首个窗口：先出跟进计划】/);
	assert.match(first, /一天可以多次/);
	assert.match(first, /观察点/);
	assert.match(first, /无需等待确认/);
	assert.ok(first.indexOf("【首个窗口：先出跟进计划】") < first.indexOf("窗口规则："), "plan block precedes the protocol");
	const later = buildWorkWindowPrefix({ title: "月末对账", goal: "核对流水", turn: 1, budget, firstWindow: true });
	assert.doesNotMatch(later, /【首个窗口：先出跟进计划】/);
	const notKickoff = buildWorkWindowPrefix({ title: "月末对账", goal: "核对流水", turn: 0, budget });
	assert.doesNotMatch(notKickoff, /【首个窗口：先出跟进计划】/);
});
