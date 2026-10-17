/**
 * SessionHost integration tests — the pi-session kernel shell (migration doc
 * §7.2). Runs against the REAL @earendil-works/pi-coding-agent devDependency:
 * no SDK stubs here, because the whole point is that the shell's behavior
 * (tool wrapping, extension events, built-in suppression) is pi's, not ours.
 *
 * Spike-verified contract this suite pins (2026-10-17):
 *  - AgentSession wraps a SELF-BUILT Agent (config.agent) + inMemory mirrors;
 *  - loader.reload() must run BEFORE session construction (extensions snapshot);
 *  - extension tool_call/tool_result/agent_before_settle fire for customTools;
 *  - pi's built-in read/bash/edit/write stay out (initialActiveToolNames: []);
 *  - ModelRuntime minimal stub passes the prompt-time auth gate.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.session-host-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "session-host.mjs");
await build({
	stdin: {
		contents: `
			export { createSessionHost } from "./src/engine/session-host.ts";
			export { initPiRuntime, getPiRuntime, __setPiRuntimeStub, isPiRuntimeStubbed } from "./src/engine/imports.ts";
			export { Agent } from "@earendil-works/pi-agent-core";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { createSessionHost, initPiRuntime, getPiRuntime, __setPiRuntimeStub, isPiRuntimeStubbed, Agent } = await import(pathToFileURL(bundle).href);

const fakeModel = { id: "m", name: "M", provider: "spike", api: "openai-completions", baseUrl: "http://localhost:1/v1", contextWindow: 200_000, maxTokens: 32_000, input: ["text", "image"] };

/** Scripted model: run 1 asks for the tool, run 2 answers. */
function scriptedStreamFn(toolName) {
	let run = 0;
	return async () => {
		run += 1;
		return {
			async *[Symbol.asyncIterator]() {},
			result: async () => run === 1
				? { role: "assistant", provider: "spike", model: "m", content: [{ type: "text", text: "查一下" }, { type: "toolCall", id: "c1", name: toolName, arguments: {} }], stopReason: "toolUse", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }
				: { role: "assistant", provider: "spike", model: "m", content: [{ type: "text", text: "SPIKE-OK" }], stopReason: "stop", usage: { input: 40, output: 5, cacheRead: 0, cacheWrite: 0 } },
		};
	};
}

function makeTool(name, log) {
	return {
		name,
		label: name,
		description: `test tool ${name}`,
		parameters: { type: "object", properties: {}, required: [] },
		execute: async (id) => {
			log.push(`exec:${name}`);
			return { content: [{ type: "text", text: "TOOL-OK" }], details: {} };
		},
	};
}

test("initPiRuntime resolves the devDependency; the stub seam round-trips", async () => {
	await initPiRuntime();
	const rt = getPiRuntime();
	assert.equal(typeof rt.AgentSession, "function");
	assert.equal(isPiRuntimeStubbed(), false);
	const fake = { AgentSession: class {}, SessionManager: class {}, SettingsManager: class {}, DefaultResourceLoader: class {}, version: "stub" };
	__setPiRuntimeStub(fake);
	assert.equal(isPiRuntimeStubbed(), true);
	assert.equal(getPiRuntime().version, "stub");
	__setPiRuntimeStub(null);
	assert.equal(isPiRuntimeStubbed(), false);
});

test("SessionHost wraps the self-built agent: session.prompt drives it, the tool executes, extension events fire", async () => {
	const log = [];
	const tool = makeTool("spike_tool", log);
	const agentEvents = [];
	const agent = new Agent({
		streamFn: scriptedStreamFn("spike_tool"),
		initialState: { tools: [tool], model: fakeModel },
	});
	agent.subscribe((ev) => agentEvents.push(ev.type));

	const extEvents = [];
	await initPiRuntime(); // idempotent — each test stands alone under --test-name-pattern
	const host = await createSessionHost(agent, {
		conversationId: "conv-host-1",
		tools: [tool],
		extensionFactories: [{
			name: "test-ext",
			factory: (pi) => {
				pi.on("tool_call", async (event) => { extEvents.push(`tool_call:${event.toolName ?? event.name ?? "?"}`); return undefined; });
				pi.on("tool_result", async (event) => { extEvents.push(`tool_result:${event.toolName ?? event.name ?? "?"}`); });
				pi.on("agent_before_settle", async () => { extEvents.push("agent_before_settle"); return undefined; });
			},
		}],
		cwd: dir,
	});
	assert.equal(host.agent, agent, "the self-built agent is kept, not replaced");

	await host.session.prompt("你好", { expandPromptTemplates: false });

	assert.ok(log.includes("exec:spike_tool"), "the VE tool executed through the session registry");
	assert.ok(agentEvents.includes("message_end"), "the agent still streams events to its own subscribers (reply aggregation path)");
	assert.ok(extEvents.some((e) => e.startsWith("tool_call:")), `extension tool_call fired (${extEvents.join(",")})`);
	assert.ok(extEvents.some((e) => e.startsWith("tool_result:")), "extension tool_result fired");
	assert.ok(extEvents.includes("agent_before_settle"), "the settle boundary ran (plugins' verify-gate hook point)");

	// Built-in coding tools must be suppressed: the registry carries OUR tools.
	const names = agent.state.tools.map((t) => t.name);
	assert.deepEqual(names, ["spike_tool"], `pi built-ins (read/bash/edit/write) must not leak in, got ${names.join(",")}`);
});

test("session.abort + dispose are safe on an idle host", async () => {
	const tool = makeTool("spike_tool", []);
	const agent = new Agent({ streamFn: scriptedStreamFn("spike_tool"), initialState: { tools: [tool], model: fakeModel } });
	await initPiRuntime();
	const host = await createSessionHost(agent, { conversationId: "conv-host-2", tools: [tool], cwd: dir });
	await host.session.abort();
	await host.session.dispose();
});
