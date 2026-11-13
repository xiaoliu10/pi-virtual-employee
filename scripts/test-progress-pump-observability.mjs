/** Progress-pump observability (field 2026-11-06: the chat pump never fired
 * since v0.2.192 and NO log line existed anywhere in the chain). Manager-level
 * tests: tick logs the busy set + decisions, arm/fire transitions are logged,
 * and pumpOne stage logs bracket the brief generation. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test, mock } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.pump-obs-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const bundle = join(dir, "m.mjs");
await build({
	stdin: { contents: `export { IMAdapterManager } from "./src/im/manager.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { IMAdapterManager } = await import(pathToFileURL(bundle).href);

function fakeManager(busyIds, general = { longTaskProgressMin: 10, taskProgressMin: 30 }) {
	const manager = Object.create(IMAdapterManager.prototype);
	manager.config = { all: () => ({ general }) };
	manager.engine = {
		busyConversations: () => busyIds.map((conversationId) => ({ conversationId })),
	};
	manager.pumpState = new Map();
	manager.pumpOneCalls = [];
	// Mirror the real pumpOne's bookkeeping: a successful push refreshes the
	// conversation's clock, otherwise due-again math below loses meaning.
	manager.pumpOne = async (conversationId) => {
		manager.pumpOneCalls.push(conversationId);
		const st = manager.pumpState.get(conversationId);
		if (st) st.lastSentAt = Date.now();
	};
	return manager;
}

test("mixed live conversations keep chat=10min and task=30min cadence", () => {
	mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	try {
		// worker:request is a CHAT-dispatchED worker (all worker tasks are), so it
		// follows the CHAT cadence alongside the inline chat — field 2026-11-13.
		const ids = ["dt:single:viewer", "worker:request", "sched:job:run", "work:item"];
		const manager = fakeManager(ids);
		captureLogs(() => manager.pumpTick());
		mock.timers.tick(10 * 60_000);
		captureLogs(() => manager.pumpTick());
		assert.deepEqual(manager.pumpOneCalls, ["dt:single:viewer", "worker:request"],
			"inline chat AND chat-dispatched worker are due at the chat cadence");
		// Now fast-forward ONLY the task-cadence conversations past 30min: the
		// chat pair stays on its t=10min clock (fires again only at t>=20min),
		// proving the two cadences are judged independently.
		manager.pumpOneCalls.length = 0;
		mock.timers.tick(1 * 60_000);
		for (const id of ["sched:job:run", "work:item"]) {
			manager.pumpState.get(id).lastSentAt = Date.now() - 31 * 60_000;
		}
		const logs = captureLogs(() => manager.pumpTick());
		assert.deepEqual(manager.pumpOneCalls, ["sched:job:run", "work:item"], "only the task cadence is due now");
		assert.ok(logs.some((line) => line.includes("work:item") && line.includes("interval=30min")), "FIRE must expose the selected cadence");
	} finally { mock.timers.reset(); }
});

test("disabling one cadence never disables the other", () => {
	for (const [general, due] of [
		[{ longTaskProgressMin: 0, taskProgressMin: 30 }, ["work:item", "sched:job:run"]],
		[{ longTaskProgressMin: 10, taskProgressMin: 0 }, ["dt:single:viewer", "worker:request"]],
	]) {
		const manager = fakeManager(["dt:single:viewer", "work:item", "sched:job:run", "worker:request"], general);
		captureLogs(() => manager.pumpTick());
		for (const state of manager.pumpState.values()) state.lastSentAt = Date.now() - 31 * 60_000;
		captureLogs(() => manager.pumpTick());
		assert.deepEqual(manager.pumpOneCalls, due);
	}
});

test("the timer starts for task-only reporting when chat reporting is off", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	const manager = fakeManager(["work:item"], { longTaskProgressMin: 0, taskProgressMin: 30 });
	try {
		manager.startProgressPump();
		captureLogs(() => mock.timers.tick(5 * 60_000));
		assert.ok(manager.pumpState.has("work:item"), "task-only pump must arm its clock");
	} finally { manager.stopProgressPump(); mock.timers.reset(); }
});

test("enabling task progress after startup works when both cadences started disabled", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	const general = { longTaskProgressMin: 0, taskProgressMin: 0 };
	const manager = fakeManager(["work:item"], general);
	try {
		manager.startProgressPump();
		captureLogs(() => mock.timers.tick(5 * 60_000));
		assert.equal(manager.pumpState.size, 0, "disabled cadences never arm or summarize");
		general.taskProgressMin = 30;
		captureLogs(() => mock.timers.tick(5 * 60_000));
		assert.ok(manager.pumpState.has("work:item"), "enabling a cadence reuses the live timer");
	} finally { manager.stopProgressPump(); mock.timers.reset(); }
});

test("cadence changes are read on the next tick without restarting the pump", () => {
	const general = { longTaskProgressMin: 10, taskProgressMin: 30 };
	const manager = fakeManager(["work:item"], general);
	captureLogs(() => manager.pumpTick());
	manager.pumpState.get("work:item").lastSentAt = Date.now() - 11 * 60_000;
	captureLogs(() => manager.pumpTick());
	assert.deepEqual(manager.pumpOneCalls, []);
	general.taskProgressMin = 10;
	captureLogs(() => manager.pumpTick());
	assert.deepEqual(manager.pumpOneCalls, ["work:item"]);
});

function captureLogs(fn) {
	const lines = [];
	const orig = console.log;
	console.log = (...args) => { lines.push(args.join(" ")); };
	try { fn(); } finally { console.log = orig; }
	return lines;
}

test("tick logs the busy set and the per-conversation decisions", () => {
	const manager = fakeManager(["dt:a"]);
	const logs = captureLogs(() => manager.pumpTick());
	assert.ok(logs.some((l) => l.includes("progress pump tick: busy=1") && l.includes("dt:a")), "tick must report the busy set");
	assert.ok(logs.some((l) => l.includes("dt:a:skip/not-due")), "first sighting decision must be visible");
	assert.ok(logs.some((l) => l.includes("armed (first sighting): dt:a")), "arm transition must be logged");
	assert.ok(manager.pumpState.has("dt:a"), "first sighting arms the clock");
	assert.equal(manager.pumpOneCalls.length, 0, "no fire on first sighting");
});

test("an idle tick logs busy=0 (distinguishes 'pump alive, nothing busy' from 'pump dead')", () => {
	const manager = fakeManager([]);
	const logs = captureLogs(() => manager.pumpTick());
	assert.ok(logs.some((l) => l.includes("progress pump tick: busy=0")), "empty ticks must still prove the pump is alive");
});

test("a due conversation fires, and the FIRE line is logged", () => {
	const manager = fakeManager(["dt:a"]);
	captureLogs(() => manager.pumpTick()); // arm
	manager.pumpState.get("dt:a").lastSentAt = Date.now() - 11 * 60_000; // fast-forward past the 10min cadence
	const logs = captureLogs(() => manager.pumpTick());
	assert.ok(logs.some((l) => l.includes("progress pump FIRE: dt:a")), "fire must be logged");
	assert.deepEqual(manager.pumpOneCalls, ["dt:a"], "fire must reach pumpOne");
});

test("a conversation that went idle is pruned and re-armed (never silently stuck)", () => {
	const manager = fakeManager(["dt:a"]);
	captureLogs(() => manager.pumpTick());
	manager.engine.busyConversations = () => []; // turn ended
	captureLogs(() => manager.pumpTick());
	assert.equal(manager.pumpState.has("dt:a"), false, "idle conversation is pruned");
	manager.engine.busyConversations = () => [{ conversationId: "dt:a" }];
	const logs = captureLogs(() => manager.pumpTick());
	assert.ok(logs.some((l) => l.includes("armed (first sighting): dt:a")), "re-appearance re-arms instead of firing on a stale clock");
});


test("pumpOne logs brief start/done around the REAL generation path (review P3)", async () => {
	// Use the prototype pumpOne (not a stub) with fake engine/pusher: the brief
	// logs are inside pumpOne and were previously uncovered (deleting them
	// survived the suite).
	const manager = Object.create(IMAdapterManager.prototype);
	manager.config = { all: () => ({ general: { longTaskProgressMin: 10 } }) };
	manager.pumpState = new Map([["dt:a", { lastSentAt: 0, inFlight: false }]]);
	manager.engine = {
		getOrCreateSession: () => ({}),
		progressBrief: async () => "⏳ 任务仍在进行中。已完成：x；剩余：y；正在：z；卡点：无",
		isConversationStreaming: () => true,
	};
	const pushed = [];
	manager.onProgressPush = async (conversationId, text) => { pushed.push({ conversationId, text }); return { ok: true }; };
	const lines = [];
	const orig = console.log;
	console.log = (...args) => { lines.push(args.join(" ")); };
	try {
		await manager.pumpOne("dt:a", 600000);
	} finally {
		console.log = orig;
	}
	const start = lines.findIndex((l) => l.includes("brief start: dt:a"));
	const done = lines.findIndex((l) => l.includes("brief done: dt:a"));
	assert.ok(start >= 0, "brief start log must exist");
	assert.ok(done > start, "brief done log must come after the generation");
	assert.equal(pushed.length, 1, "a usable brief is pushed");
	assert.equal(manager.pumpState.get("dt:a").inFlight, false, "inFlight released after the push");
});


function deliveryManager(conversationId, result = { ok: true }) {
	const manager = Object.create(IMAdapterManager.prototype);
	const sent = [];
	manager.engine = {
		getOrCreateSession: () => ({}),
		progressBrief: async () => "已完成登录，正在查询日志。",
		isConversationStreaming: () => true,
		workerBridge: { sourceForConversation: id => id === "worker:job" ? "dt:single:source" : undefined },
	};
	manager.pumpState = new Map([[conversationId, { lastSentAt: 123, inFlight: false }]]);
	manager.active = new Map([["dingtalk", {
		channel: "dingtalk",
		metadata: { displayName: "fake", capabilities: { proactive: true } },
		push: async (cid, text) => { sent.push({ cid, text }); return result; },
	}]]);
	manager.setProgressPusher((cid, text, occurrenceId) => manager.pushToConversation(cid, text, { occurrenceId, kind: "chat-progress" }));
	return { manager, sent };
}

test("worker pump delivers through the actual adapter to its source chat", async () => {
	const { manager, sent } = deliveryManager("worker:job");
	await manager.pumpOne("worker:job", 10 * 60_000);
	assert.equal(sent.length, 1, "the note must reach a real adapter push, not just a pump stub");
	assert.equal(sent[0].cid, "dt:single:source");
	assert.ok(manager.pumpState.get("worker:job").lastSentAt > 123);
});

test("failed or unacknowledged pump delivery never advances the last-success clock", async () => {
	for (const result of [{ ok: false, error: "platform unavailable" }, undefined]) {
		const { manager } = deliveryManager("dt:single:source");
		manager.setProgressPusher(async () => result);
		await manager.pumpOne("dt:single:source", 10 * 60_000);
		assert.equal(manager.pumpState.get("dt:single:source").lastSentAt, 123);
		assert.equal(manager.pumpState.get("dt:single:source").inFlight, false);
	}
});

test("an unmapped worker fails visibly and never pushes to an unrelated chat", async () => {
	const { manager, sent } = deliveryManager("worker:missing");
	await manager.pumpOne("worker:missing", 10 * 60_000);
	assert.equal(sent.length, 0);
	assert.equal(manager.pumpState.get("worker:missing").lastSentAt, 123);
});

test("a missing progress pusher never consumes the reporting interval", async () => {
	const { manager } = deliveryManager("dt:single:source");
	manager.onProgressPush = undefined;
	await manager.pumpOne("dt:single:source", 10 * 60_000);
	assert.equal(manager.pumpState.get("dt:single:source").lastSentAt, 123);
});
