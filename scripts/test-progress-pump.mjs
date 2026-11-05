/**
 * Global progress pump — heartbeats that survive a restart.
 *
 * FIELD 2026-11-04: a chat task ran 1h+ and produced ONE progress note. The task
 * was fine (durable resumed it), but the heartbeat was a setInterval created in
 * the inbound-message handler: it died with the process, and after a restart that
 * handler never runs again for the consumed message, so it was never recreated.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.progress-pump-test-"));
process.on("exit", () => { rm(dir, { recursive: true, force: true }).catch(() => {}); });

const bundle = join(dir, "p.mjs");
await build({
	stdin: { contents: 'export * from "./src/scheduler/progress-pump.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { decidePump, prunePumpState, isUsableBrief } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

const MIN = 60_000;
const busy = (...ids) => ids.map((conversationId) => ({ conversationId }));

test("THE FIELD BUG: a conversation that became busy during a PREVIOUS process still gets pumped", () => {
	// After a restart the conversation is busy again (durable resumed the work)
	// even though no new inbound message arrived. The pump must pick it up from
	// live state, not from the request that started it.
	const state = new Map();
	const now = 10_000_000;
	// First sighting arms the clock and must NOT fire immediately (a restart must
	// not spam one note per live conversation).
	let actions = decidePump({ busy: busy("dt:group:abc"), state, now, intervalMs: 10 * MIN });
	assert.deepEqual(actions, [{ kind: "skip", conversationId: "dt:group:abc", reason: "not-due" }]);

	// Simulate the caller storing the armed state.
	state.set("dt:group:abc", { lastSentAt: now, inFlight: false });

	// Ten minutes later it fires — exactly the promised cadence.
	actions = decidePump({ busy: busy("dt:group:abc"), state, now: now + 10 * MIN, intervalMs: 10 * MIN });
	assert.deepEqual(actions, [{ kind: "fire", conversationId: "dt:group:abc" }]);
});

test("it keeps firing every interval, not just once", () => {
	// This is the actual complaint: "只汇报了一次就停了".
	const state = new Map([["c1", { lastSentAt: 0, inFlight: false }]]);
	const interval = 10 * MIN;
	const fires = [];
	for (let t = 10 * MIN; t <= 60 * MIN; t += 10 * MIN) {
		const [a] = decidePump({ busy: busy("c1"), state, now: t, intervalMs: interval });
		if (a.kind === "fire") fires.push(t / MIN);
		// the caller updates lastSentAt after a successful push
		state.set("c1", { lastSentAt: t, inFlight: false });
	}
	assert.deepEqual(fires, [10, 20, 30, 40, 50, 60], "one note per interval, for as long as it runs");
});

test("a conversation that finished is dropped and never pumped again", () => {
	const state = new Map([["c1", { lastSentAt: 0, inFlight: false }]]);
	// busy comes from live state; a finished conversation is simply absent.
	const actions = decidePump({ busy: [], state, now: 999 * MIN, intervalMs: 10 * MIN });
	assert.deepEqual(actions, []);
	prunePumpState(state, []);
	assert.equal(state.size, 0, "bookkeeping must not accumulate for the process lifetime");
});

test("a slow brief does not stack a second one (in-flight guard)", () => {
	const state = new Map([["c1", { lastSentAt: 0, inFlight: true }]]);
	const actions = decidePump({ busy: busy("c1"), state, now: 999 * MIN, intervalMs: 10 * MIN });
	assert.deepEqual(actions, [{ kind: "skip", conversationId: "c1", reason: "in-flight" }]);
});

test("several busy conversations are pumped independently", () => {
	const state = new Map([
		["a", { lastSentAt: 0, inFlight: false }],           // due
		["b", { lastSentAt: 9 * MIN, inFlight: false }],     // not due yet
		["c", { lastSentAt: 0, inFlight: true }],            // busy generating
	]);
	const actions = decidePump({ busy: busy("a", "b", "c"), state, now: 10 * MIN, intervalMs: 10 * MIN });
	assert.deepEqual(actions, [
		{ kind: "fire", conversationId: "a" },
		{ kind: "skip", conversationId: "b", reason: "not-due" },
		{ kind: "skip", conversationId: "c", reason: "in-flight" },
	]);
});

test("interval 0 disables the pump entirely", () => {
	const state = new Map([["c1", { lastSentAt: 0, inFlight: false }]]);
	assert.deepEqual(decidePump({ busy: busy("c1"), state, now: 999 * MIN, intervalMs: 0 }), []);
	assert.deepEqual(decidePump({ busy: busy("c1"), state, now: 999 * MIN, intervalMs: -5 }), []);
});

test("prunePumpState keeps only live conversations", () => {
	const state = new Map([
		["live", { lastSentAt: 0, inFlight: false }],
		["gone", { lastSentAt: 0, inFlight: false }],
	]);
	prunePumpState(state, busy("live"));
	assert.deepEqual([...state.keys()], ["live"]);
});

test("a re-busy conversation is not judged by a stale timestamp", () => {
	// After pruning, a conversation that goes busy again starts a FRESH clock
	// rather than firing instantly from an ancient lastSentAt.
	const state = new Map();
	prunePumpState(state, []); // it was idle
	const [a] = decidePump({ busy: busy("c1"), state, now: 1_000_000, intervalMs: 10 * MIN });
	assert.equal(a.reason, "not-due");
});

test("blank briefs are rejected, degraded-but-informative ones are not", () => {
	assert.equal(isUsableBrief(""), false);
	assert.equal(isUsableBrief("   \n "), false);
	assert.equal(isUsableBrief(undefined), false);
	assert.equal(isUsableBrief("已完成：暂无；剩余：对账；正在：扫描"), true);
});
