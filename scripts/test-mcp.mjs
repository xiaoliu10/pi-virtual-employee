/**
 * MCP connector tests. Run with `node --test scripts/test-mcp.mjs` (part of test:all).
 *
 * Covers the pure parts (config parsing/normalization/env interpolation) and
 * the manager's bridge behavior with an injected fake client — no real MCP
 * server or network involved.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = join(root, "node_modules/.mcp-test");
const bundle = join(workDir, "mcp.mjs");
await build({
	stdin: {
		contents: `
			export { normalizeMcpServer, normalizeMcpServers, interpolateEnv } from "./src/shared/mcp.ts";
			export { McpManager } from "./src/engine/tools/mcp.ts";
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
const { normalizeMcpServer, normalizeMcpServers, interpolateEnv, McpManager } = await import(pathToFileURL(bundle).href);

test("standard mcpServers record form normalizes with env interpolation", () => {
	const env = { GITHUB_TOKEN: "tok-123", MISSING: undefined };
	const { servers, errors } = normalizeMcpServers(
		{
			filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
			docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${GITHUB_TOKEN}", "X Missing": "x", "X Count": 3 } },
		},
		env,
	);
	assert.equal(errors.length, 0);
	assert.equal(servers.length, 2);
	const fs = servers.find((s) => s.name === "filesystem");
	assert.equal(fs.command, "npx");
	assert.deepEqual(fs.args, ["-y", "@modelcontextprotocol/server-filesystem", "."]);
	const docs = servers.find((s) => s.name === "docs");
	assert.equal(docs.headers.Authorization, "Bearer tok-123", "${NAME} interpolates from the environment");
	assert.equal("X Missing" in (docs.headers ?? {}), true, "string values pass through");
	assert.equal("X Count" in (docs.headers ?? {}), false, "non-string header values are dropped");
});

test("invalid entries are skipped with reasons; array form and dedupe work", () => {
	const { servers, errors } = normalizeMcpServers([
		{ name: "bad name!", command: "x" },
		{ name: "no-target" },
		{ name: "dup", command: "a" },
		{ name: "dup", command: "b" },
	]);
	assert.equal(servers.length, 1, "only the first dup entry survives");
	assert.equal(servers[0].name, "dup");
	assert.ok(errors.length >= 3, "each skipped entry reports a reason");
	assert.ok(errors.some((e) => e.includes("name 非法")));
	assert.ok(errors.some((e) => e.includes("缺少 command")));
	assert.ok(errors.some((e) => e.includes("重名")));
});

test("interpolateEnv: missing vars resolve to empty string, real vars resolve", () => {
	assert.equal(interpolateEnv("Bearer ${NOPE_MISSING_VAR}", {}), "Bearer ");
	assert.equal(interpolateEnv("Bearer ${KNOWN}", { KNOWN: "tok" }), "Bearer tok");
	assert.equal(interpolateEnv("no placeholder", {}), "no placeholder");
});

test("normalizeMcpServer rejects bad entries with precise reasons", () => {
	assert.match(normalizeMcpServer(null).reason, /必须是对象/);
	assert.match(normalizeMcpServer({ command: "x" }).reason, /name 非法/);
	assert.match(normalizeMcpServer({ name: "ok-name" }).reason, /缺少 command/);
	assert.equal(normalizeMcpServer({ name: "ok", command: "x" }).ok, true);
});

/** Fake MCP client: canned listTools + scripted callTool results. */
function fakeClient({ tools, result, error }) {
	const client = {
		transport: {},
		async listTools() {
			return { tools };
		},
		async callTool(request) {
			if (error) throw error;
			return result;
		},
	};
	return client;
}

const SERVER = { name: "demo", command: "node", args: ["server.cjs"], timeoutSec: 5 };

test("manager bridges cached tools with namespaced names and renders results", async (t) => {
	let calls = 0;
	const manager = new McpManager({
		connect: async () => {
			calls += 1;
			return fakeClient({
				tools: [
					{ name: "echo", description: "回显输入", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
					{ name: "no_schema" },
				],
				result: { content: [{ type: "text", text: "echo: hi" }] },
			});
		},
	});
	const config = { all: () => ({ capabilities: { mcp: { enabled: true, servers: [SERVER] } } }) };

	const { changed, report } = await manager.refresh(config);
	assert.equal(changed, true, "first refresh changes the tool surface");
	assert.equal(report[0].ok, true);
	assert.equal(report[0].tools, 2);

	const tools = manager.tools();
	assert.deepEqual(tools.map((tool) => tool.name), ["mcp__demo__echo", "mcp__demo__no_schema"]);
	assert.match(tools[0].description, /\[MCP:demo\] 回显输入/);

	const done = await tools[0].execute("t1", { text: "hi" });
	assert.match(done.content[0].text, /echo: hi/);
	assert.equal(done.details.mcp, true);

	// Schema-less tools still get a valid object schema for the provider.
	assert.equal(tools[1].parameters.type, "object");
	assert.equal(calls, 1, "the injected factory built exactly one client");

	// Unchanged second refresh: no surface change, no session rebuild trigger.
	const second = await manager.refresh(config);
	assert.equal(second.changed, false);
});

test("manager maps tool errors, timeouts and disabled servers to honest refusals", async (t) => {
	const manager = new McpManager({
		connect: async () => fakeClient({
			tools: [{ name: "boom" }],
			result: { content: [{ type: "text", text: "disk full" }], isError: true },
		}),
	});
	const config = { all: () => ({ capabilities: { mcp: { enabled: true, servers: [{ ...SERVER, timeoutSec: 1 }, { name: "off", command: "x", enabled: false }] } } }) };
	await manager.refresh(config);
	assert.equal(manager.tools().length, 1, "disabled servers contribute no tools");

	const tool = manager.tools()[0];
	const done = await tool.execute("t2", {});
	assert.match(done.content[0].text, /报告执行失败/);
	assert.match(done.content[0].text, /disk full/);
});

test("a server that fails to connect is reported and contributes no tools", async (t) => {
	const manager = new McpManager({
		connect: async () => {
			throw new Error("spawn ENOENT");
		},
	});
	const config = { all: () => ({ capabilities: { mcp: { enabled: true, servers: [SERVER] } } }) };
	const { report } = await manager.refresh(config);
	assert.equal(report[0].ok, false);
	assert.match(report[0].error, /ENOENT/);
	assert.equal(manager.tools().length, 0);
});
