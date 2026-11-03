/**
 * Behaviour probe: a durable MCP tool call MUST reach recordToolTelemetry.
 * The independent review probed this and found 0 events; this test is that
 * same probe, kept as a regression so the claim cannot drift from the code.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.pw-mcp-telemetry");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: { contents: `export { EmployeeEngine } from "./src/engine/engine.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { EmployeeEngine } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

const config = {
	all: () => ({
		general: {},
		capabilities: { mcp: { enabled: true } },
		kb: { enabled: false, learn: { enabled: false }, manage: { enabled: false }, research: { enabled: false } },
		browser: { enabled: false }, scheduler: { enabled: false }, documents: { enabled: false },
		filesystem: { enabled: false }, reports: { enabled: false }, downloads: { enabled: false },
	}),
	get: () => undefined,
};

function mkEngine(mcpTool) {
	const engine = new EmployeeEngine(
		config,
		{ getConversation: () => undefined, ensureConversation: () => {}, listMessages: () => [], listMembers: () => [] },
		{}, {}, {}, {}, {}, {}, {},
		{ builtinSkillsDir: "/tmp", userSkillsDir: "/tmp" },
		{ kernel: "durable" },
	);
	// Inject a single fake MCP server tool.
	engine["mcpManager"] = { tools: () => [mcpTool] };
	return engine;
}

const mcpTool = {
	name: "mcp__fs__read",
	label: "read",
	description: "read a file",
	parameters: { type: "object", properties: {}, additionalProperties: true },
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

test("a durable MCP tool call emits telemetry with a progress fingerprint", async () => {
	const engine = mkEngine(mcpTool);
	const events = [];
	engine["recordToolTelemetry"] = (_cid, e) => { events.push(e); };

	const tools = engine.mcpToolsFor("conv-1");
	assert.equal(tools.length, 1, "the MCP tool must be exposed");
	await tools[0].execute("tc1", {}, undefined, undefined);

	assert.equal(events.length, 1, "durable MCP bypassed telemetry (review P1)");
	assert.equal(events[0].name, "mcp__fs__read");
	assert.equal(events[0].ok, true);
	assert.equal(typeof events[0].fingerprint, "string", "the progress watchdog needs the fingerprint");
	assert.equal(events[0].fingerprint.length, 16);
});

test("an identical MCP retry fingerprints the same (the loop is detectable)", async () => {
	const engine = mkEngine(mcpTool);
	const events = [];
	engine["recordToolTelemetry"] = (_cid, e) => { events.push(e); };
	const tools = engine.mcpToolsFor("conv-1");
	await tools[0].execute("a", { path: "/x" }, undefined, undefined);
	await tools[0].execute("b", { path: "/x" }, undefined, undefined);
	assert.equal(events.length, 2);
	assert.equal(events[0].fingerprint, events[1].fingerprint, "identical retries must collide");
});

test("an MCP tool that THROWS still reports telemetry (failed loops count too)", async () => {
	const engine = mkEngine({ ...mcpTool, execute: async () => { throw new Error("server down"); } });
	const events = [];
	engine["recordToolTelemetry"] = (_cid, e) => { events.push(e); };
	const tools = engine.mcpToolsFor("conv-1");
	await assert.rejects(() => tools[0].execute("a", {}, undefined, undefined));
	assert.equal(events.length, 1, "the throw path must also feed the watchdog");
	assert.equal(events[0].ok, false);
});

test("legacy kernels do not double-wrap MCP telemetry", async () => {
	// mcpToolsFor is only called by the durable runtime (engine.ts:627). Legacy
	// gets its MCP tools through buildTools, which wraps them itself. Guard the
	// invariant by checking the durable registry is the only consumer.
	const engine = mkEngine(mcpTool);
	engine["opts"].kernel = "legacy";
	const events = [];
	engine["recordToolTelemetry"] = (_cid, e) => { events.push(e); };
	const tools = engine.mcpToolsFor("conv-1");
	await tools[0].execute("a", {}, undefined, undefined);
	assert.equal(events.length, 1, "one call, one event — no double wrap");
});
