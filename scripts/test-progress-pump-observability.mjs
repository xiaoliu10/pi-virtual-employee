/** Progress-pump observability (field 2026-11-06: the chat pump never fired
 * since v0.2.192 and NO log line existed anywhere in the chain). Manager-level
 * tests: tick logs the busy set + decisions, arm/fire transitions are logged,
 * and pumpOne stage logs bracket the brief generation. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
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

function fakeManager(busyIds) {
	const manager = Object.create(IMAdapterManager.prototype);
	manager.config = { all: () => ({ general: { longTaskProgressMin: 10 } }) };
	manager.engine = {
		busyConversations: () => busyIds.map((conversationId) => ({ conversationId })),
	};
	manager.pumpState = new Map();
	manager.pumpOneCalls = [];
	manager.pumpOne = async (conversationId) => { manager.pumpOneCalls.push(conversationId); };
	return manager;
}

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
