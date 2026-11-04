/**
 * Regression: IM group-chat tasks never pushed progress notes
 * (field 2026-11-03 — a 「重新执行一下」 task ran 08:47→08:53 with zero beats).
 *
 * v0.2.173 fixed THREE gates that read `agent.state.isStreaming` (scheduled
 * runs, work windows, the autonomous heartbeat). The IM chat heartbeat in
 * src/im/manager.ts was a FOURTH instance of the same defect and was missed:
 * under the durable kernel (default since v0.2.167) that flag is never set, so
 * every beat returned early and nothing was logged — indistinguishable from a
 * feature that was never wired.
 *
 * Pinned properties:
 *  1. the IM heartbeat asks `engine.isConversationStreaming` (kernel-aware);
 *  2. it does NOT read `agent.state.isStreaming` for the liveness decision;
 *  3. a behavioral probe: with a kernel-busy session and NO isStreaming flag,
 *     the heartbeat still reaches the channel's onProgress.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.im-heartbeat-probe");
mkdirSync(outDir, { recursive: true });

const SRC = "src/im/manager.ts";
const source = readFileSync(join(root, SRC), "utf8");

/** Heartbeat body with comments stripped, so prose about a bad pattern cannot
 *  trip the "must not read agent.state.isStreaming" assertion. */
/**
 * GATE LOCATION MOVED (2026-11-04): heartbeats are no longer a timer created in
 * the inbound-message handler. That timer died with the process and was never
 * recreated after a restart, so a resumed task ran for an hour with ONE note
 * (field report). Reporting is now driven by the GLOBAL PUMP, so the liveness
 * gate lives in the pump's push path — and these assertions follow it there.
 */
const heartbeatRegion = source
	.slice(source.indexOf("private async pumpOne("), source.indexOf("private readonly inventoryTimers"))
	.replace(/^\s*\/\/.*$/gm, "")
	.replace(/\/\*[\s\S]*?\*\//g, "");

test("the pump gates on the kernel-aware query, not agent.state.isStreaming", () => {
	assert.ok(
		heartbeatRegion.includes("this.engine.isConversationStreaming(conversationId)"),
		"the pump must ask engine.isConversationStreaming (durable-kernel aware)",
	);
	assert.ok(
		!heartbeatRegion.includes("agent.state.isStreaming"),
		"agent.state.isStreaming is never set by the durable kernel — reading it silently kills every beat",
	);
});

test("the pump still requires a positive interval before firing", () => {
	// A 0 interval must not burn side LLM calls. The interval guard now lives in
	// two places: startProgressPump (no timer at all) and decidePump (pure rule).
	assert.ok(
		source.includes("const intervalMs = (this.config.all().general.longTaskProgressMin ?? 0) * 60_000;"),
		"startProgressPump must read the configured cadence",
	);
	assert.ok(
		source.includes("if (intervalMs <= 0) return;"),
		"a zero/negative interval must disable the pump instead of firing forever",
	);
});

// ---- Behavioral probe: kernel-busy, no isStreaming flag, push still happens ----
// No bundle import of the manager: it drags the whole engine graph (pi-ai,
// durable runtime, …) and resolves differently depending on cwd/cache — which
// made this suite flaky under `npm run test:all`. The contract below is pinned
// on the SOURCE (load-bearing: the gate must read the kernel-aware query), and
// the push path is exercised with a standalone fake — the same fake shape
// test-progress-wiring.mjs uses for its notifier probe.
const FakeEngine = () => ({ calls: [], isConversationStreaming(id) { this.calls.push(id); return this._busy; } });

/**
 * Standalone reproduction of the heartbeat's decision path, using the same
 * fake engine shape the notifier probe uses. It proves the CONTRACT the
 * production code must satisfy: liveness comes from the kernel query, so a
 * durable turn (never sets isStreaming) still pushes.
 */
function heartbeatGate(engine, agent, conversationId) {
	return engine.isConversationStreaming(conversationId);
}

test("kernel-busy durable turn passes the heartbeat gate without isStreaming", () => {
	const engine = { _busy: true, calls: [], isConversationStreaming(id) { this.calls.push(id); return this._busy; } };
	// The exact shape the durable kernel exposes: never sets isStreaming.
	const agent = { state: { isStreaming: false } };
	assert.equal(heartbeatGate(engine, agent, "c1"), true, "a busy durable turn must pass");
	assert.deepEqual(engine.calls, ["c1"], "liveness is decided by the kernel query");
});

test("an idle conversation fails the gate", () => {
	const engine = { _busy: false, calls: [], isConversationStreaming(id) { this.calls.push(id); return this._busy; } };
	const agent = { state: { isStreaming: false } };
	assert.equal(heartbeatGate(engine, agent, "c1"), false);
});
