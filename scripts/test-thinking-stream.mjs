/**
 * Collapsible thinking box — END-TO-END delivery test.
 *
 * Field 2026-11-04: the console never received reasoning. Two independent breaks:
 *  1. transport/http.ts only subscribed to agent.subscribe, but the DURABLE
 *     kernel never drives agent.prompt — it publishes through
 *     SendCtx.onProcessEvent (measured: 0 events per durable turn). So the
 *     console got no deltas at all, and the answer appeared in one block.
 *  2. Even the legacy path threw thinking away: extractText() filters to
 *     type === "text", and thinking lives in its own block type.
 *
 * This suite drives the REAL streamRun over a real HTTP server with a stub
 * runtime, so it fails if either break returns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.thinking-stream-test-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
const { rmSync } = await import("node:fs");

const bundle = join(dir, "http.mjs");
await build({
	stdin: { contents: 'export { startHttpTransport } from "./src/transport/http.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { startHttpTransport } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

/** Stub EmployeeRuntime whose send() behaves like the DURABLE kernel. */
function makeDurableRuntime(events) {
	const agent = { subscribe: () => () => {}, id: "a1" };
	return {
		profileId: "p", modelId: "m",
		getOrCreateSession: () => agent,
		dropSession: () => false,
		activeSessionCount: () => 1,
		isReadOnlyConversation: () => false,
		supportsAgentSubscription: () => false, // durable: subscribe is blind
		async send(_agent, _message, ctx) {
			// The ONLY channel a durable kernel uses.
			for (const e of events) ctx?.onProcessEvent?.(e);
			return { text: "答案", error: undefined };
		},
	};
}

/** Stub runtime whose send() behaves like the LEGACY kernel (subscribe only). */
function makeLegacyRuntime(message) {
	const listeners = [];
	const agent = {
		subscribe: (fn) => { listeners.push(fn); return () => {}; },
		id: "a2",
	};
	return {
		profileId: "p", modelId: "m",
		getOrCreateSession: () => agent,
		dropSession: () => false,
		activeSessionCount: () => 1,
		isReadOnlyConversation: () => false,
		supportsAgentSubscription: () => true,
		async send() {
			for (const fn of listeners) {
				fn({ type: "message_update", message: { role: "assistant", content: message } });
			}
			return { text: "ok", error: undefined };
		},
	};
}

async function collect(port, body) {
	const res = await fetch(`http://127.0.0.1:${port}/chat`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	});
	const text = await res.text();
	return text.split("\n")
		.filter((l) => l.startsWith("data: "))
		.map((l) => JSON.parse(l.slice(6)));
}

test("DURABLE kernel: thinking_delta becomes a `thinking` SSE event, apart from the answer", async (t) => {
	const runtime = makeDurableRuntime([
		{ type: "thinking_delta", delta: "先看数据" },
		{ type: "thinking_delta", delta: "，再对账。" },
		{ type: "text_delta", delta: "对完了。" },
	]);
	const { port, server } = await startHttpTransport(runtime, { port: 0 });
	t.after(() => new Promise((r) => server.close(r)));

	const events = await collect(port, { message: "对账" });
	const thinking = events.filter((e) => e.type === "thinking").map((e) => e.text).join("");
	const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");

	assert.equal(thinking, "先看数据，再对账。", "reasoning must be delivered (durable uses onProcessEvent)");
	assert.equal(answer, "对完了。", "the answer stream must be separate from reasoning");
	assert.ok(!answer.includes("先看数据"), "thinking must NOT leak into the answer bubble");
	assert.equal(events.at(-1).type, "done");
});

test("DURABLE kernel: no deltas at all would mean the console is blind (regression guard)", async (t) => {
	// Before the fix the transport never passed onProcessEvent, so a durable turn
	// produced a `meta` and a `done` and NOTHING between them.
	const runtime = makeDurableRuntime([{ type: "text_delta", delta: "hi" }]);
	const { port, server } = await startHttpTransport(runtime, { port: 0 });
	t.after(() => new Promise((r) => server.close(r)));
	const events = await collect(port, { message: "x" });
	const deltas = events.filter((e) => e.type === "delta");
	assert.equal(deltas.length, 1, `durable turns must stream; got ${JSON.stringify(events)}`);
});

test("LEGACY kernel: thinking blocks are extracted, not merged into text", async (t) => {
	const runtime = makeLegacyRuntime([
		{ type: "thinking", thinking: "推理A" },
		{ type: "text", text: "回答B" },
	]);
	const { port, server } = await startHttpTransport(runtime, { port: 0 });
	t.after(() => new Promise((r) => server.close(r)));
	const events = await collect(port, { message: "x" });
	const thinking = events.filter((e) => e.type === "thinking").map((e) => e.text).join("");
	const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
	assert.equal(thinking, "推理A");
	assert.equal(answer, "回答B");
});
