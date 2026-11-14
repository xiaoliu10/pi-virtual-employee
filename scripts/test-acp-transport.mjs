#!/usr/bin/env node
/**
 * ACP transport tests (2026-11): src/acp/server.ts over a real Streamable HTTP
 * listener, driven by the real @agentclientprotocol/sdk client. The engine is a
 * stub — the test pins protocol wiring, trust boundaries and event translation,
 * never the LLM.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { client } from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.acp-test-"));
after(() => rm(dir, { recursive: true, force: true }));

// Bundle the TS transport (packages external: the ACP SDK resolves from node_modules).
const bundle = join(dir, "acp.mjs");
await build({
	entryPoints: [join(root, "src/acp/server.ts")],
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
// A second small bundle to reach the pure origin helper.
const helperBundle = join(dir, "helper.mjs");
await build({
	stdin: {
		contents: `export { inferConversationOrigin } from "./src/db/history-store.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: helperBundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { inferConversationOrigin: originOf } = await import(helperBundle);
const { startAcpTransport } = await import(bundle);

/** Stub engine recording how the transport drives it. */
function makeEngine() {
	const calls = [];
	const ensured = [];
	const aborted = [];
	return {
		calls, ensured, aborted,
		engine: {
			profileId: "Synapse",
			getOrCreateSession: (cid) => ({ sessionId: cid }),
			ensureAcpConversation: (cid) => ensured.push(cid),
			abortSession: (cid) => { aborted.push(cid); return true; },
			send: async (agent, message, ctx) => {
				calls.push({ message, actor: ctx.actor, hasSink: typeof ctx.onProcessEvent === "function" });
				// Emit one of every process event to verify translation.
				ctx.onProcessEvent({ type: "text_delta", delta: "处理中" });
				ctx.onProcessEvent({ type: "thinking_delta", delta: "思考" });
				ctx.onProcessEvent({ type: "tool_start", toolName: "run_command", toolCallId: "tc1" });
				ctx.onProcessEvent({ type: "tool_end", toolName: "run_command", toolCallId: "tc1", durationMs: 12 });
				return { reply: "done", deterministic: false };
			},
		},
	};
}

const TOKEN = "ve-acp-test-token";
let transport;
let baseUrl;

before(async () => {
	const stub = makeEngine();
	globalThis.__stub = stub;
	transport = await startAcpTransport(stub.engine, {
		port: 0,
		token: TOKEN,
		actorStaffId: "acp-synapse",
		actorName: "Synapse ACP",
		profileId: "Synapse",
		appVersion: "0.0.0-test",
	});
	baseUrl = `http://127.0.0.1:${transport.port}/acp`;
});

after(() => {
	transport?.server?.close();
});

test("origin helper: acp: prefix is its own remote origin, never console", () => {
	assert.equal(originOf("acp:abc"), "acp");
	assert.equal(originOf("acp:acp_s_x"), "acp");
	// Regression guard: the implicit-admin path must stay separate.
	assert.equal(originOf("bare-uuid"), "console");
	assert.equal(originOf("widget:x"), "widget");
});

test("refuses to start without a token", async () => {
	const stub = makeEngine();
	await assert.rejects(() => startAcpTransport(stub.engine, {
		port: 0, token: "  ", actorStaffId: "x", actorName: "x", profileId: "p", appVersion: "1",
	}), /令牌/);
});

test("wrong bearer token is rejected before reaching ACP", async () => {
	const stream = createHttpStream(baseUrl, { headers: { Authorization: "Bearer wrong" } });
	await assert.rejects(
		() => client().connectWith(stream, (cx) => cx.request("initialize", { protocolVersion: 1 })),
		/(401|unauthorized|unusable|closed)/i,
	);
});

test("unknown path is 404", async () => {
	const res = await fetch(`http://127.0.0.1:${transport.port}/else`, {
		headers: { Authorization: `Bearer ${TOKEN}` },
	});
	assert.equal(res.status, 404);
});

test("full turn: initialize → new → prompt → updates → cancel, with acp actor", async () => {
	const stub = globalThis.__stub;
	const stream = createHttpStream(baseUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
	await client().connectWith(stream, async (cx) => {
		const init = await cx.request("initialize", { protocolVersion: 1, clientInfo: { name: "synapse", version: "0.1.0" } });
		assert.equal(init.agentInfo.name, "ve-Synapse");

		const session = await cx.buildSession({ cwd: "E:\\\\ops", mcpServers: [] }).start();
		assert.match(session.sessionId, /^acp_s_/);
		const conversationId = session.newSessionResponse._meta.conversationId;
		assert.match(conversationId, /^acp:acp_s_/);
		// Origin is persisted eagerly, before any turn.
		assert.deepEqual(stub.ensured, [conversationId]);

		const updates = [];
		const drain = (async () => {
			for (;;) {
				const u = await session.nextUpdate();
				if (u?.kind === "stop") break;
				updates.push(u);
			}
		})();
		const r = await session.prompt([{ type: "text", text: "执行 hostname" }]);
		assert.equal(r.stopReason, "end_turn");
		await drain;

		// engine.send received the prompt text and a fixed verified acp actor.
		assert.equal(stub.calls.length, 1);
		assert.equal(stub.calls[0].message, "执行 hostname");
		assert.deepEqual(stub.calls[0].actor, {
			senderId: "acp-synapse",
			senderName: "Synapse ACP",
			channel: "acp",
			chatType: "single",
		});

		// All four process events translated to ACP session/update shapes.
		const kinds = updates.map((u) => u.update.sessionUpdate);
		assert.ok(kinds.includes("agent_message_chunk"));
		assert.ok(kinds.includes("agent_thought_chunk"));
		assert.ok(kinds.includes("tool_call"));
		assert.ok(kinds.includes("tool_call_update"));
		const toolStart = updates.find((u) => u.update.sessionUpdate === "tool_call").update;
		assert.equal(toolStart.status, "in_progress");
		assert.equal(toolStart.name, "run_command");
		const toolEnd = updates.find((u) => u.update.sessionUpdate === "tool_call_update").update;
		assert.equal(toolEnd.status, "completed");

		await cx.notify("session/cancel", { sessionId: session.sessionId });
		assert.deepEqual(stub.aborted, [conversationId]);
	});
});

test("engine error turn maps to refusal stopReason", async () => {
	const stub = makeEngine();
	const t2 = await startAcpTransport({
		profileId: "Synapse",
		getOrCreateSession: (cid) => ({ sessionId: cid }),
		ensureAcpConversation: () => {},
		abortSession: () => true,
		send: async () => { throw new Error("This operation was aborted"); },
	}, { port: 0, token: TOKEN, actorStaffId: "a", actorName: "a", profileId: "Synapse", appVersion: "1" });

	const stream = createHttpStream(`http://127.0.0.1:${t2.port}/acp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
	await client().connectWith(stream, async (cx) => {
		await cx.request("initialize", { protocolVersion: 1 });
		const session = await cx.buildSession({ cwd: ".", mcpServers: [] }).start();
		const r = await session.prompt([{ type: "text", text: "x" }]);
		assert.equal(r.stopReason, "cancelled");
	});
	t2.server.close();
});
