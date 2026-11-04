/**
 * END-TO-END chain: a REAL stdio MCP server → the connector → the durable host
 * → the model-visible tool surface.
 *
 * Why this exists (2026-11-03 field report, re-verified 2026-11-04): the shipped
 * guard `test-mcp-durable-visibility.mjs` read `opened.harness.registry?.snapshot?.()`
 * and wrapped its assertions in `if (snap)`. The Harness exposes NO registry
 * handle, so `snap` was always null and the assertions NEVER RAN — the fix for
 * "MCP connects but the model never sees the tools" shipped behind a green check
 * that could not fail. Mutation-proved: returning `[]` from mcpToolNames left
 * that test green in the guarded build.
 *
 * This suite therefore asserts through the HOST ACCESSOR only, and exercises the
 * real connector (McpServer + StdioServerTransport, no mocks) so the whole
 * startup and late-connect chain is covered:
 *
 *   real MCP server → McpManager.refresh → engine-style RBAC wrapper
 *     → openDurableHost({ mcpTools })   [startup snapshot]
 *       → setMcpTools(...)             [late connect / reconnect]
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = process.cwd();
const outDir = join(root, "node_modules/.mcp-e2e-probe");
mkdirSync(outDir, { recursive: true });

const MCP_TOOL_NAMES = ["mcp__etc_verification__ev_batch_list", "mcp__etc_verification__ev_result_query"];

const serverPath = join(outDir, "fake-mcp-server.mjs");
writeFileSync(serverPath, `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "etc_verification", version: "1.0.0" });
server.registerTool("ev_batch_list", {
  title: "batch list",
  description: "list verification batches",
  inputSchema: { page: z.number().optional() },
}, async () => ({ content: [{ type: "text", text: "BATCHES_OK" }] }));
server.registerTool("ev_result_query", {
  title: "result query",
  description: "query verification results",
  inputSchema: { batchId: z.string() },
}, async ({ batchId }) => ({ content: [{ type: "text", text: "RESULT_" + batchId }] }));
await server.connect(new StdioServerTransport());
`);

const probePath = join(outDir, "probe.mjs");
await build({
	stdin: {
		contents: `
			export { McpManager } from "./src/engine/tools/mcp.ts";
			export { openDurableHost } from "./src/engine/durable/harness-host.ts";
			export { guardTool } from "./src/engine/definition.ts";
			export { toDurableTools } from "./src/engine/durable/ve-tools.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: probePath,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { McpManager, openDurableHost, guardTool, toDurableTools } =
	await import(pathToFileURL(probePath).href + `?t=${Date.now()}`);

const mcpSection = {
	enabled: true,
	servers: { etc_verification: { command: process.execPath, args: [serverPath], timeoutSec: 30 } },
};
const fakeConfig = {
	all: () => ({
		security: { defaultRole: "admin" },
		capabilities: { mcp: mcpSection },
		kb: { enabled: false, learn: { enabled: false }, manage: { enabled: false }, research: { enabled: false } },
		browser: { enabled: false }, computer: { enabled: false }, scheduler: { enabled: false },
		documents: { enabled: false }, filesystem: { enabled: false }, reports: { enabled: false },
		downloads: { enabled: false }, skills: { disabled: [] },
	}),
};

// The engine's mcpToolsFor() shape: RBAC-guard each manager tool, then hand the
// result to durable. Reaching the registry WITHOUT this wrapper would bypass
// `checkPermission(config, actor, conversationId, "mcp")` (PR #95).
const guardOptions = {
	config: fakeConfig,
	conversationId: "dt:group:probe",
	resolveActor: () => ({ staffId: "probe", name: "probe", role: "admin" }),
	onRoleRefusal: () => {},
};
const mcpToolsFor = (manager) => manager.tools().map((tool) => guardTool("mcp", tool, guardOptions));

test("REAL MCP chain: startup connect reaches the model-visible surface", async () => {
	const manager = new McpManager();
	const dir = mkdtempSync(join(tmpdir(), "ve-mcp-e2e-startup-"));
	try {
		const { changed, report } = await manager.refresh(fakeConfig);
		assert.equal(changed, true, "first refresh must report a change");
		const row = report.find((r) => r.name === "etc_verification");
		assert.ok(row, `no report row: ${JSON.stringify(report)}`);
		assert.equal(row.ok, true, `connect failed: ${row.error}`);
		assert.equal(row.tools, 2, `expected 2 tools, got ${row.tools}`);

		const surface = mcpToolsFor(manager);
		assert.deepEqual([...surface.map((t) => t.name)].sort(), MCP_TOOL_NAMES);

		const opened = await openDurableHost({
			userDataDir: dir, profileName: "default", tools: [],
			mcpRegistrations: toDurableTools(surface),
		});
		try {
			// Read through the HOST ACCESSOR (the app-owned registry snapshot).
			// `harness.registry` does not exist — depending on it is how the
			// previous guard test silently asserted nothing.
			assert.deepEqual([...opened.mcpToolNames()].sort(), MCP_TOOL_NAMES, "startup snapshot must carry MCP");
		} finally {
			await opened.close();
		}
	} finally {
		await manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("REAL MCP chain: a LATE connect reaches the model via setMcpTools", async () => {
	// This is the HTTP case from the field: the host opens first (empty surface),
	// the server finishes connecting seconds later.
	const manager = new McpManager();
	const dir = mkdtempSync(join(tmpdir(), "ve-mcp-e2e-late-"));
	try {
		const opened = await openDurableHost({ userDataDir: dir, profileName: "default", tools: [] });
		try {
			assert.deepEqual(opened.mcpToolNames(), [], "a host opened with no MCP tools starts empty");

			await manager.refresh(fakeConfig);
			const surface = mcpToolsFor(manager);
			opened.setMcpTools(toDurableTools(surface));

			assert.deepEqual([...opened.mcpToolNames()].sort(), MCP_TOOL_NAMES, "late connect must publish");

			// Re-installing must REPLACE (a duplicate would double the list).
			opened.setMcpTools(toDurableTools(surface));
			assert.equal(opened.mcpToolNames().length, 2, "a repeat install must not append");

			// And removing the server must take its tools out of the model's view.
			opened.setMcpTools([]);
			assert.deepEqual(opened.mcpToolNames(), [], "an empty install must stop offering the tools");
		} finally {
			await opened.close();
		}
	} finally {
		await manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("REAL MCP chain: the RBAC guard actually executes on a durable MCP tool", async () => {
	// Visibility without the guard would be a privilege hole: the durable
	// registry bypasses buildTools, so `mcpToolsFor` is the ONLY place the check
	// can happen. Call a real tool end to end and assert its result.
	const manager = new McpManager();
	const dir = mkdtempSync(join(tmpdir(), "ve-mcp-e2e-guard-"));
	try {
		await manager.refresh(fakeConfig);
		const surface = mcpToolsFor(manager);
		const listTool = surface.find((t) => t.name === "mcp__etc_verification__ev_batch_list");
		assert.ok(listTool, `missing tool in ${surface.map((t) => t.name).join(",")}`);

		const result = await listTool.execute("call-1", {}, undefined, () => {});
		const text = (result?.content ?? []).map((c) => c.text ?? "").join("");
		assert.match(text, /BATCHES_OK/, `tool call must reach the MCP server, got: ${text}`);

		const opened = await openDurableHost({
			userDataDir: dir, profileName: "default", tools: [],
			mcpRegistrations: toDurableTools(surface),
		});
		try {
			assert.deepEqual([...opened.mcpToolNames()].sort(), MCP_TOOL_NAMES);
		} finally {
			await opened.close();
		}
	} finally {
		await manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
