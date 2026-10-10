/**
 * Real-SDK regression for the pi 1.1.0 upgrade: `finishTurn` semantics.
 *
 * pi 0.99's hook was `shouldStopAfterTurn` (return true to stop); pi 1.x renamed
 * it to `finishTurn` and changed the contract to an action decision — only
 * `{ action: "end" }` ends the run. The engine's tool-step cap and mid-turn
 * context-budget stop live on this hook, so a leftover boolean return would be
 * silently IGNORED by the 1.x loop and the turn would keep looping tools.
 * Both shapes are driven against the REAL Agent here to pin the difference.
 *
 * Run with `npm run test:all` (auto-discovered).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";

function makeStream(steps) {
	let n = 0;
	return async () => {
		n += 1;
		const withTool = n <= steps;
		return {
			async *[Symbol.asyncIterator]() {},
			async result() {
				return {
					role: "assistant",
					content: withTool
						? [{ type: "toolCall", id: `t${n}`, name: "noop", arguments: {} }]
						: [{ type: "text", text: "done" }],
					api: "anthropic-messages", provider: "test", model: "m",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: withTool ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
			},
		};
	};
}

test("finishTurn {action:'end'} stops the loop; boolean true (0.99 shape) does NOT", async () => {
	for (const [label, hookReturn] of [["1.x action", { action: "end" }], ["0.99 boolean true", true]]) {
		let toolRuns = 0;
		const agent = new Agent({
			initialState: { systemPrompt: "s", model: { id: "m", api: "anthropic-messages", provider: "test", name: "m", baseUrl: "", reasoning: false, input: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192 } },
			tools: [{ name: "noop", description: "d", parameters: { type: "object", properties: {} }, execute: async () => { toolRuns += 1; return { content: [{ type: "text", text: "ok" }] }; } }],
			streamFn: makeStream(50),
		});
		// Attach the 1.x contract hook directly on the loop config.
		const raw = agent.createLoopConfig.bind(agent);
		agent.createLoopConfig = (opts) => {
			const cfg = raw(opts);
			cfg.finishTurn = async (turn) => (turn.toolResults.length >= 1 ? hookReturn : undefined);
			return cfg;
		};
		await agent.prompt("go");
		assert.ok(toolRuns <= 2, `${label}: loop must end after the cap (toolRuns=${toolRuns})`);
	}
});
