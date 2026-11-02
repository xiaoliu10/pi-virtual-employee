/**
 * Durable-kernel process events (field requirement, 2026-11-02).
 *
 * The durable kernel (the DEFAULT since v0.2.167) never calls agent.prompt, so
 * `agent.subscribe` observes nothing and the widget fell back to plain JSON:
 * every embedding business system showed "spinner → whole answer at once", with
 * the first token arriving only after the entire generation finished. The
 * runtime now translates the harness's own event stream into the same shape the
 * legacy kernel emits, delivered through `SendCtx.onProcessEvent`.
 *
 * These tests run a REAL durable turn with a faux provider and assert the sink
 * receives streamed text and tool events — not just a final answer.
 */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";

const dir = await mkdtemp(join(process.cwd(), "node_modules/.durable-process-events-"));
after(() => rm(dir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: 'export { DurableRuntime } from "./src/engine/durable/runtime.ts"; export { HistoryStore } from "./src/db/history-store.ts";',
		resolveDir: process.cwd(),
		loader: "ts",
	},
	outfile: join(dir, "runtime.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { DurableRuntime, HistoryStore } = await import(pathToFileURL(join(dir, "runtime.mjs")));

function makeHistory(t) {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);`);
	const history = new HistoryStore(db);
	t.after(() => db.close());
	return history;
}

async function openRuntime({ history, faux, tools = () => [] }) {
	const sessions = new Map();
	const session = (id) => {
		if (!sessions.has(id)) {
			sessions.set(id, new Agent({
				streamFn: faux.provider.streamSimple,
				sessionId: id,
				initialState: { model: faux.provider.getModels()[0], systemPrompt: "test" },
			}));
		}
		return sessions.get(id);
	};
	const runtime = await DurableRuntime.open({
		userDataDir: dir,
		history,
		session,
		tools,
		stream: (id, opts, messages) => faux.provider.streamSimple(faux.provider.getModels()[0], { messages }, opts),
		withActor: async (id, ctx, text, run) => run(),
		onRecovered: async () => {},
	});
	return { runtime, session };
}

test("the durable kernel reports streamed text through onProcessEvent", async (t) => {
	const history = makeHistory(t);
	// The harness commits partials at most every ~100 ms (progress.partialIntervalMs):
	// a provider that answers instantly has NO intermediate commit and therefore no
	// text_delta. That is a property of the kernel, not of this feature, so this test
	// pacing (below) spaces the partial commits — a fast provider legitimately
	// produces no intermediate update, and the assertion is the CONTRACT
	// (progressive prefix deltas), not a particular ratio: the tail converges via
	// the final replace/done.
	const reply = "这是一段足够长的回答用来验证流式增量是否真的能够跨越节流窗口产生多个中间提交";
	// 8 tokens/s over a long reply crosses several 100 ms commit windows.
	const faux = fauxProvider({ tokensPerSecond: 8, tokenSize: { min: 1, max: 2 } });
	faux.setResponses([fauxAssistantMessage(reply)]);
	const { runtime, session } = await openRuntime({ history, faux });
	const events = [];
	try {
		const result = await runtime.send(session("widget:probe"), "你好", {
			actor: { senderId: "widget-user-1", channel: "widget", chatType: "single" },
			onProcessEvent: (event) => events.push(event),
		});
		assert.equal(result.reply, reply);

		// The contract: at least two separate delta events (progressive, not one
		// shot), each an extension of the same growing text, together a PREFIX of the
		// reply. The tail may land after the last commit; the client converges via
		// the final replace/done.
		const deltaEvents = events.filter((e) => e.type === "text_delta");
		assert.ok(deltaEvents.length >= 2, `progressive deltas arrived (got ${deltaEvents.length})`);
		let acc = "";
		for (const e of deltaEvents) {
			acc += e.delta;
			assert.ok(reply.startsWith(acc), `deltas always extend the reply (at ${JSON.stringify(acc)})`);
		}
	} finally {
		await runtime.close();
	}
});

test("the durable kernel reports tool start and end with a call id", async (t) => {
	const history = makeHistory(t);
	const faux = fauxProvider();
	let executed = 0;
	const tools = () => [{
		name: "get_current_time",
		label: "clock",
		description: "clock",
		parameters: Type.Object({}),
		execute: async () => {
			executed += 1;
			return { content: [{ type: "text", text: "2026-11-02" }] };
		},
	}];
	faux.setResponses([fauxAssistantMessage(fauxToolCall("get_current_time", {}), { stopReason: "toolUse" }), fauxAssistantMessage("今天是 2026-11-02")]);
	const { runtime, session } = await openRuntime({ history, faux, tools });
	const events = [];
	try {
		const result = await runtime.send(session("widget:tools"), "今天几号", {
			actor: { senderId: "widget-user-2", channel: "widget", chatType: "single" },
			onProcessEvent: (event) => events.push(event),
		});
		assert.equal(result.reply, "今天是 2026-11-02");
		assert.equal(executed, 1, "the tool actually ran");

		const start = events.find((e) => e.type === "tool_start");
		const end = events.find((e) => e.type === "tool_end");
		assert.ok(start, "tool_start was reported");
		assert.equal(start.toolName, "get_current_time");
		assert.ok(end, "tool_end was reported");
		assert.equal(end.toolCallId, start.toolCallId, "start and end share the call id the UI correlates on");
		assert.equal(end.isError, false, "a completed call is not an error");
		assert.equal(typeof end.durationMs, "number", "the end event carries a duration for the tool row");
	} finally {
		await runtime.close();
	}
});

test("a turn without a sink still runs (watching is best-effort)", async (t) => {
	const history = makeHistory(t);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("无流式也照常回答")]);
	const { runtime, session } = await openRuntime({ history, faux });
	try {
		const result = await runtime.send(session("widget:nosink"), "在吗", {
			actor: { senderId: "widget-user-3", channel: "widget", chatType: "single" },
		});
		assert.equal(result.reply, "无流式也照常回答", "the answer is unaffected by the absence of a sink");
	} finally {
		await runtime.close();
	}
});

test("a tool that throws reports tool_end with isError=true (not a success checkmark)", async (t) => {
	const history = makeHistory(t);
	const faux = fauxProvider();
	const tools = () => [{
		name: "boom",
		label: "boom",
		description: "always throws",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("kaboom");
		},
	}];
	faux.setResponses([fauxAssistantMessage(fauxToolCall("boom", {}), { stopReason: "toolUse" }), fauxAssistantMessage("工具失败了")]);
	const { runtime, session } = await openRuntime({ history, faux, tools });
	const events = [];
	try {
		const result = await runtime.send(session("widget:boom"), "炸一下", {
			actor: { senderId: "widget-user-4", channel: "widget", chatType: "single" },
			onProcessEvent: (event) => events.push(event),
		});
		assert.ok(result.reply.length > 0, "the turn still answers");
		const end = events.find((e) => e.type === "tool_end");
		assert.ok(end, "tool_end was reported");
		assert.equal(end.isError, true, "a faulted tool is reported as an error — the old inference painted it false");
	} finally {
		await runtime.close();
	}
});
