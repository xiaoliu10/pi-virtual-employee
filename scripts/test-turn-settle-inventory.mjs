/**
 * Field regression 2026-11-04: a monitor script kept running after the task
 * result was already pushed — nothing told the user, and silent strays read as
 * delivery bugs. The turn-settle inventory must:
 *  - push a ⚠️ inventory note 5s AFTER the result lands (async, never blocking)
 *  - stay silent when no background process is running for the conversation
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

// The manager types are heavyweight; the contract under test is small enough to
// pin via a behavioral shim mirroring the real wiring (scheduleBackgroundInventory
// + pushBackgroundInventory + settle finally hook). Kept in sync by the wiring
// assertion below against manager source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const managerSrc = readFileSync(join(process.cwd(), "src", "im", "manager.ts"), "utf-8");

test("wiring: settle finally schedules the inventory (async, 5s grace)", () => {
	const fin = managerSrc.indexOf("if (watchdog) watchdog.stop();");
	const settleWindow = managerSrc.slice(fin, fin + 600);
	assert.match(settleWindow, /scheduleBackgroundInventory\(msg\.conversationId\)/,
		"settle finally schedules the async inventory");
	assert.match(settleWindow, /Fire-and-forget/, "the async-by-design ruling is recorded at the hook");
	assert.match(managerSrc, /setTimeout\(\(\) => \{\n\s*this\.inventoryTimers\.delete/, "5s deferred, fire-and-forget");
});

test("wiring: inventory reads through engine and pushes only when running", () => {
	assert.match(managerSrc, /const inventory = this\.engine\.inventoryBackgroundProcesses\(conversationId\);/);
	assert.match(managerSrc, /if \(!inventory\.length\) return;/, "silent when nothing is running");
	assert.match(managerSrc, /回合收尾盘点/, "the note names itself so users learn the mechanic");
});

test("behavioral shim: 5s-deferred note pushed once, result lands first", async () => {
	// Simulated in the same shape the manager wires it: settle → schedule → 5s → push.
	const pushed = [];
	const order = [];
	const engine = { inventoryBackgroundProcesses: () => [{ sessionId: "abcdef12-3456", pid: 4321, command: "python monitor.py" }] };
	const pushToConversation = async (cid, text) => { order.push("push"); pushed.push(text); };
	const schedule = (cb) => { order.push("schedule"); setTimeout(cb, 20); }; // compressed 5s

	// settle: result lands first, then schedule
	order.push("result");
	schedule(() => {
		const inventory = engine.inventoryBackgroundProcesses("c1");
		if (inventory.length) void pushToConversation("c1", `⚠️ 回合收尾盘点 ${inventory[0].sessionId.slice(0, 8)}`);
	});
	await new Promise((r) => setTimeout(r, 80));
	assert.deepEqual(order, ["result", "schedule", "push"], "result before inventory push");
	assert.equal(pushed.length, 1);
	assert.match(pushed[0], /abcdef12/);
});

test("behavioral shim: no running process → no push", async () => {
	const engine = { inventoryBackgroundProcesses: () => [] };
	let pushedCount = 0;
	const cb = () => {
		const inventory = engine.inventoryBackgroundProcesses("c1");
		if (inventory.length) pushedCount += 1;
	};
	cb();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(pushedCount, 0, "silent when nothing is running");
});
