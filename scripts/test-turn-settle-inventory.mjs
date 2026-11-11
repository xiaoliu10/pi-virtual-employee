/**
 * Field regression 2026-11-08 (user ruling): the old settle inventory PUSHED a
 * ⚠️ note listing stray background processes and told the user to run
 * `manage_process poll/kill` themselves — internal tool names leaked to the
 * user and cleanup was left as the user's job. The new contract:
 *  - settle sweeps TERMINATE strays automatically (audited cascade_kill)
 *  - a clean sweep is SILENT (no push at all)
 *  - only processes that refused to die surface a short Chinese note
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const managerSrc = readFileSync(join(process.cwd(), "src", "im", "manager.ts"), "utf-8");

test("wiring: settle finally schedules the sweep (async, 5s grace)", () => {
	const fin = managerSrc.indexOf("if (watchdog) watchdog.stop();");
	const settleWindow = managerSrc.slice(fin, fin + 600);
	assert.match(settleWindow, /scheduleBackgroundInventory\(msg\.conversationId\)/,
		"settle finally schedules the async sweep");
	assert.match(settleWindow, /Fire-and-forget/, "the async-by-design ruling is recorded at the hook");
});

test("wiring: the sweep TERMINATES strays via the engine, then verifies", () => {
	assert.match(managerSrc, /const killed = this\.engine\.stopBackgroundProcessesFor\(conversationId\);/,
		"the sweep kills, it does not just list");
	assert.match(managerSrc, /const remaining = this\.engine\.inventoryBackgroundProcesses\(conversationId\);/,
		"and verifies what survived");
});

test("wiring: the sweep DEFERS while the keep-alive window is open (user ruling 2026-11-11, spay incident)", () => {
	// Field 2026-11-11 10:26: the sweep killed the login polling script 13s
	// after the turn settled — while the conversation was still waiting on the
	// user's SMS code. Inside the worker's keep-alive window the sweep must
	// re-arm at window expiry instead of killing (TTL-bounded cleanup, so the
	// 11-08 「默认清理」 guarantee holds, just later).
	assert.match(managerSrc, /keepAliveRemainingMs\?\.\(conversationId\)/,
		"the sweep asks the bridge for the remaining window");
	assert.match(managerSrc, /scheduleBackgroundInventory\(conversationId, keepAliveMs \+ 1_000\)/,
		"deferral re-arms the sweep at window expiry");
	assert.match(managerSrc, /keepAliveMs > 0/, "positive remaining window = defer");
});

test("wiring: internal tool names never reach the user (field 23:44 wording banned)", () => {
	assert.doesNotMatch(managerSrc, /manage_process poll/, "poll guidance must be gone");
	assert.doesNotMatch(managerSrc, /需要立即终止用 manage_process kill/, "kill guidance must be gone");
	assert.doesNotMatch(managerSrc, /回合收尾盘点/, "the inventory-note mechanic must be gone");
});

test("behavioral shim: strays are killed silently — no push on a clean sweep", async () => {
	const pushed = [];
	const swept = [];
	const engine = {
		inventoryBackgroundProcesses: (() => {
			// first call finds strays; after the sweep, none remain
			let calls = 0;
			return () => (calls++ === 0 ? [{ sessionId: "abcdef12-3456", pid: 4321, command: "python sls_drv.py" }] : []);
		})(),
		stopBackgroundProcessesFor: (cid) => { swept.push(cid); return [{ sessionId: "abcdef12-3456", pid: 4321, command: "python sls_drv.py" }]; },
	};
	const pushToConversation = async (cid, text) => { pushed.push(text); };
	const inventory = engine.inventoryBackgroundProcesses("c1");
	if (inventory.length) {
		const killed = engine.stopBackgroundProcessesFor("c1");
		const remaining = engine.inventoryBackgroundProcesses("c1");
		console.log(`settle sweep c1: found=${inventory.length} killed=${killed.length} remaining=${remaining.length}`);
		if (remaining.length === 0) return; // silent
		void pushToConversation("c1", "should not happen");
	}
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(swept, ["c1"], "the sweep terminated the stray");
	assert.equal(pushed.length, 0, "a clean sweep is SILENT");
});

test("behavioral shim: a process that refuses to die surfaces ONE short Chinese note", async () => {
	const pushed = [];
	const engine = {
		inventoryBackgroundProcesses: () => [{ sessionId: "abcdef12-3456", pid: 4321, command: "python sls_drv.py" }],
		stopBackgroundProcessesFor: () => [], // sweep fails to kill anything
	};
	const pushToConversation = async (cid, text) => { pushed.push(text); };
	const inventory = engine.inventoryBackgroundProcesses("c1");
	if (inventory.length) {
		engine.stopBackgroundProcessesFor("c1");
		const remaining = engine.inventoryBackgroundProcesses("c1");
		if (remaining.length === 0) return;
		await pushToConversation("c1", `⚠️ 收尾时未能停止本会话的 ${remaining.length} 个后台脚本（已尝试自动清理）`);
	}
	assert.equal(pushed.length, 1, "exactly one note");
	assert.match(pushed[0], /未能停止/, "names the failure honestly");
	assert.doesNotMatch(pushed[0], /manage_process/, "no internal tool names");
	assert.ok(!/[a-zA-Z]{4,}/.test(pushed[0].replace("python", "").replace(/pid=\d+/, "").replace(/[a-f0-9-]{8}/g, "")), "no English leaks beyond ids");
});
