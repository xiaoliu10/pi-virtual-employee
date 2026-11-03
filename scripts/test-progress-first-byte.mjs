/**
 * Behaviour probe for the first-byte semantics — deliberately NOT a source
 * regex (a source assertion would bless a wrong design; see the design doc).
 *
 * Drives the real makeStreamFn with an EventStream-shaped object and checks
 * the observable contract: a stream that only ever yields `start` must leave
 * llmFirstByteAt UNSET, because pi-ai emits `start` before any network I/O.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = process.cwd();
const outDir = join(root, "node_modules/.pw-firstbyte");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: {
		contents: `export { EmployeeEngine } from "./src/engine/engine.ts";`,
		resolveDir: root, loader: "ts",
	},
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { EmployeeEngine } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

const config = {
	all: () => ({
		general: {}, capabilities: {},
		kb: { enabled: false, learn: { enabled: false }, manage: { enabled: false }, research: { enabled: false } },
		browser: { enabled: false }, scheduler: { enabled: false }, documents: { enabled: false },
		filesystem: { enabled: false }, reports: { enabled: false }, downloads: { enabled: false },
	}),
	get: () => undefined,
};
const mkEngine = (stream) => new EmployeeEngine(
	config,
	{ getConversation: () => undefined, ensureConversation: () => {}, listMessages: () => [], listMembers: () => [] },
	// knowledge, browser, scheduler, documents, filesystem, reportService,
	// downloadService — exactly 7 service stubs between history and paths.
	{}, {}, {}, {}, {}, {}, {},
	{ builtinSkillsDir: "/tmp", userSkillsDir: "/tmp" },
	{ kernel: "durable", streamFn: () => stream },
);

/** EventStream-shaped: queue of events, pulled by the consumer. */
function streamOf(events) {
	return {
		result: async () => ({ content: [] }),
		[Symbol.asyncIterator]: () => {
			let i = 0;
			return { next: async () => (i < events.length ? { done: false, value: events[i++] } : { done: true, value: undefined }) };
		},
	};
}

test("a stream that ONLY emits `start` leaves firstByteAt unset (a hung request)", async () => {
	// Isolate from the engine's startup credential sync, which may fire its own
	// (failing) model call through the same streamFn on a fresh engine.
	const engine = mkEngine(streamOf([{ type: "start", partial: {} }]));
	await new Promise((r) => setTimeout(r, 20));
	const stream = await engine["makeStreamFn"]("c1")({ id: "m" }, { messages: [] }, {});
	const it = stream[Symbol.asyncIterator]();
	const first = await it.next();
	assert.equal(first.value.type, "start");
	assert.equal(engine["llmFirstByteAt"].get("c1"), undefined, "`start` is local; it must not count as a network byte");
	assert.equal(engine["llmInFlight"].get("c1") ?? 0, 1, "credit is still held — the cap can fire");
});

test("a real content event primes firstByteAt", async () => {
	const engine = mkEngine(streamOf([{ type: "start", partial: {} }, { type: "text_delta", contentIndex: 0, delta: "hi" }]));
	const stream = await engine["makeStreamFn"]("c2")({ id: "m" }, { messages: [] }, {});
	const it = stream[Symbol.asyncIterator]();
	await it.next();
	await it.next();
	assert.ok(typeof engine["llmFirstByteAt"].get("c2") === "number", "a content event must count as life");
	await it.next(); // done
	assert.equal(engine["llmInFlight"].get("c2") ?? 0, 0, "credit released when the stream completes");
});

test("an error event is life too (the request failed, it did not hang)", async () => {
	const engine = mkEngine(streamOf([{ type: "start", partial: {} }, { type: "error", reason: "error", error: {} }]));
	const stream = await engine["makeStreamFn"]("c3")({ id: "m" }, { messages: [] }, {});
	const it = stream[Symbol.asyncIterator]();
	await it.next();
	await it.next();
	assert.ok(typeof engine["llmFirstByteAt"].get("c3") === "number", "an error means the server answered");
});

test("a throwing streamFn releases the credit and leaks nothing", async () => {
	const engine = mkEngine(streamOf([]));
	engine["opts"].streamFn = () => { throw new Error("provider refused"); };
	await assert.rejects(() => engine["makeStreamFn"]("c4")({ id: "m" }, { messages: [] }, {}));
	assert.equal(engine["llmInFlight"].get("c4") ?? 0, 0);
});

test("an early consumer stop releases the credit (abort path)", async () => {
	const engine = mkEngine(streamOf([{ type: "start", partial: {} }]));
	const stream = await engine["makeStreamFn"]("c5")({ id: "m" }, { messages: [] }, {});
	const it = stream[Symbol.asyncIterator]();
	await it.next();
	await it.return?.();
	assert.equal(engine["llmInFlight"].get("c5") ?? 0, 0, "abandoned streams must not hold the credit forever");
});
