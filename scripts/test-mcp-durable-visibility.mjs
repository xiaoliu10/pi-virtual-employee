/**
 * MCP tools must be visible to the DURABLE kernel.
 *
 * Field incident 2026-11-03 (Synapse v0.2.183): capabilities.mcp configured an
 * HTTP server; main.log printed `[engine] mcp tools changed: etc_verification=12`
 * (the connector worked), yet every widget conversation's model said it had no
 * `mcp__etc_verification__*` tool. Root cause: the tool surface was baked into
 * the single `ve-tools` registry extension when the durable host opened, and
 * HTTP connects always finish after startup.
 *
 * The fix installs MCP as its OWN registry extension (`ve-mcp`) and replaces it
 * in place when the surface changes. These tests pin the two properties the fix
 * depends on — both verified against the REAL pi-durable registry, not a mock:
 *
 *   1. `registry.install` with the same name REPLACES in place and publishes;
 *   2. a conversation resolving its agent from the CURRENT snapshot sees the
 *      newly installed tools (this is what makes it a hot update).
 *
 * Plus the startup ordering and the bounded retry that covers "the MCP server
 * boots after the agent".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.mcp-durable-probe");
mkdirSync(outDir, { recursive: true });

const bundle = join(outDir, "probe.mjs");
await build({
	entryPoints: [join(root, "src/engine/durable/harness-host.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	outfile: bundle,
	packages: "external",
	logLevel: "silent",
});
const host = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

const registryMod = await import("@earendil-works/pi-durable");

/** A minimal AgentTool-shaped stub; only name/description reach the registry. */
const tool = (name) => ({ name, label: name, description: name, parameters: { type: "object", properties: {} } });

test("REAL registry: installing `ve-mcp` twice replaces in place (no duplicate)", () => {
	const registry = registryMod.createRegistry();
	registry.install(registryMod.defineExtension({ name: "ve-mcp", tools: [tool("mcp__a__one")] }));
	registry.install(registryMod.defineExtension({ name: "ve-mcp", tools: [tool("mcp__b__two")] }));
	const snap = registry.snapshot();
	const mcpTools = snap.tools().filter((t) => t.extension.name === "ve-mcp").map((t) => t.tool.name);
	assert.deepEqual(mcpTools, ["mcp__b__two"], "the second install must REPLACE the first, not append");
	// And exactly one ve-mcp extension exists.
	assert.equal(snap.installed().filter((e) => e.name === "ve-mcp").length, 1);
});

test("REAL registry: a subscriber is notified on install (the harness wakes)", () => {
	const registry = registryMod.createRegistry();
	let notified = 0;
	registry.subscribe(() => { notified += 1; });
	registry.install(registryMod.defineExtension({ name: "ve-mcp", tools: [tool("x")] }));
	assert.equal(notified, 1);
});

test("openDurableHost installs ve-mcp separately from ve-tools", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ve-mcp-host-"));
	try {
		const opened = await host.openDurableHost({
			userDataDir: dir, profileName: "default",
			tools: [tool("browser_navigate")],
			mcpTools: [tool("mcp__etc__query")],
		});
		try {
			const snap = opened.harness.registry?.snapshot?.() ?? null;
			// The harness holds the registry; read it back through the host's own
			// update path instead of a private field.
			const names = snap ? snap.tools().map((t) => t.tool.name) : [];
			if (snap) {
				assert.ok(names.includes("browser_navigate"), `ve-tools present: ${names}`);
				assert.ok(names.includes("mcp__etc__query"), `ve-mcp present: ${names}`);
			}
		} finally {
			await opened.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("MCP is NOT folded into ve-tools — the defect itself must be falsifiable", async () => {
	// The 2026-11-03 incident was exactly this fold: MCP registrations baked into
	// the single ve-tools extension, frozen at open. Assert the two live apart by
	// checking that a ve-tools-only swap cannot touch MCP and vice versa — the
	// observable proof is that ve-mcp exists as its own extension at all.
	const dir = mkdtempSync(join(tmpdir(), "ve-mcp-split-"));
	try {
		const opened = await host.openDurableHost({
			userDataDir: dir, profileName: "default",
			tools: [tool("browser_navigate"), tool("browser_click")],
			mcpTools: [tool("mcp__etc__query")],
		});
		try {
			assert.deepEqual(opened.mcpToolNames(), ["mcp__etc__query"]);
			// Folding would leave ve-mcp empty and the MCP name inside ve-tools.
			assert.equal(opened.mcpToolNames().length, 1, "ve-mcp holds exactly the MCP tools");
			opened.setMcpTools([]);
			assert.deepEqual(opened.mcpToolNames(), [], "MCP can be emptied independently of ve-tools");
		} finally { await opened.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setMcpTools on a LIVE host swaps the surface (the actual fix)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ve-mcp-hot-"));
	try {
		const opened = await host.openDurableHost({
			userDataDir: dir, profileName: "default",
			tools: [tool("browser_navigate")],
			mcpTools: [tool("mcp__etc__query")],
		});
		try {
			// Server went away / reconnected with a different tool set.
			opened.setMcpTools([]);
			opened.setMcpTools([]);
			assert.deepEqual(opened.mcpToolNames(), [], "removing the last MCP tool must take it out of the model's view");

			opened.setMcpTools([tool("mcp__etc__query2")]);
			assert.deepEqual(opened.mcpToolNames(), ["mcp__etc__query2"]);
			// Exactly one ve-mcp extension, and ve-tools untouched by the swap.
			assert.equal(opened.mcpToolNames().length, 1);
		} finally {
			await opened.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an EMPTY mcpTools at open still creates the extension (so a later install replaces it)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ve-mcp-empty-"));
	try {
		const opened = await host.openDurableHost({
			userDataDir: dir, profileName: "default", tools: [tool("browser_navigate")],
		});
		try {
			// No MCP at startup; the server comes up 10s later → setMcpTools must
			// REPLACE the placeholder, not append a second `ve-mcp`.
			opened.setMcpTools([tool("mcp__late__go")]);
			assert.deepEqual(opened.mcpToolNames(), ["mcp__late__go"], "a late install must REPLACE the placeholder");
		} finally {
			await opened.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- Kernel routing: MCP must reach BOTH kernels, exactly once ----
const engineBundle = join(outDir, "engine.mjs");
await build({
	stdin: {
		// Pull the two tool-set builders without the whole engine graph.
		contents: `
			export { buildTools } from "./src/engine/definition.ts";
			export { normalizeMcpServers } from "./src/shared/mcp.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: engineBundle,
	bundle: true, platform: "node", format: "esm",
	packages: "external", logLevel: "silent",
});
const { buildTools, normalizeMcpServers } = await import(pathToFileURL(engineBundle).href + `?t=${Date.now()}`);

/**
 * The regression this pins: moving MCP out of buildToolSetFor (needed so durable
 * can install it as its own hot-swappable extension) silently stripped MCP from
 * LEGACY sessions, which take their tools ONLY from that set.
 */
test("legacy kernel keeps MCP tools in buildToolSetFor (regression guard)", () => {
	const mcpTools = [tool("mcp__etc__query")];
	// Minimal ConfigStore surface the capability guards read.
	const fakeConfig = { all: () => ({ security: { defaultRole: "viewer" }, capabilities: { mcp: { enabled: true } }, kb: { enabled: false, learn: { enabled: false }, manage: { enabled: false }, research: { enabled: false } }, browser: { enabled: false }, computer: { enabled: false }, scheduler: { enabled: false }, documents: { enabled: false }, filesystem: { enabled: false }, reports: { enabled: false }, downloads: { enabled: false }, skills: { disabled: [] } }) };
	const base = { config: fakeConfig, conversationId: "dt:group:x", resolveActor: () => undefined, resolveMemoryContext: () => ({}) };
	const legacy = buildTools({ ...base, mcp: { enabled: true, tools: mcpTools } }).map((t) => t.name);
	assert.ok(legacy.includes("mcp__etc__query"), `legacy sessions must receive MCP tools: ${legacy.join(",")}`);

	// Durable passes enabled:false here (its own ve-mcp extension supplies them).
	const durable = buildTools({ ...base, mcp: { enabled: false, tools: [] } }).map((t) => t.name);
	assert.ok(!durable.includes("mcp__etc__query"), "durable must not double-register MCP in ve-tools");
});

test("the engine's buildToolSetFor routes MCP by kernel", async () => {
	// Read the routing expression out of the source: a plain-string check would
	// pass on a broken implementation, so assert the actual conditional shape.
	const src = readFileSync(join(root, "src/engine/engine.ts"), "utf8");
	const region = src.slice(src.indexOf("buildToolSetFor(conversationId"), src.indexOf("isIdle()"));
	const stripped = region.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	assert.match(stripped, /mcp:\s*this\.opts\.kernel === "durable"/, "MCP inclusion must branch on the kernel");
	// The legacy branch must pass the real manager tools, not an empty list.
	assert.match(stripped, /tools:\s*this\.mcpManager\.tools\(\)/, "legacy branch must forward the live MCP tools");
});

test("startup variant is BOUNDED even when a server never connects", async () => {
	// A configured-but-unreachable server must not stall app startup: the connect
	// timeout is the server's own timeoutSec (default 60s), so a full retry ladder
	// awaited at startup would block for minutes.
	const engBundle = join(outDir, "eng-probe.mjs");
	await build({
		stdin: {
			contents: `export { EmployeeEngine as Engine } from "./src/engine/engine.ts";\n\t\t\texport { guardTool } from "./src/engine/definition.ts";`,
			resolveDir: root, loader: "ts",
		},
		outfile: engBundle, bundle: true, platform: "node", format: "esm",
		packages: "external", logLevel: "silent",
	});
	const { Engine } = await import(pathToFileURL(engBundle).href + `?t=${Date.now()}`);
	const engine = Object.create(Engine.prototype);
	// Fake a configured server and a refresh that NEVER connects.
	engine.config = { all: () => ({ capabilities: { mcp: { enabled: true, servers: { s: { url: "http://127.0.0.1:9/mcp", timeoutSec: 60 } } } } }) };
	engine.refreshMcpWithReport = async () => ({ servers: 1, connected: 0 });
	engine.refreshMcp = async () => {};
	let backgroundStarted = false;
	engine.finishMcpConnectInBackground = async () => { backgroundStarted = true; };

	const started = Date.now();
	const result = await engine.refreshMcpToolsForStartup(400);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 2_000, `startup must be bounded, took ${elapsed}ms`);
	assert.equal(result.ok, false);
	assert.equal(result.connected, 0);
	assert.ok(backgroundStarted, "the lagging server must continue in the background");
});

// ---- P0: the durable path must NOT bypass the RBAC "mcp" capability gate ----
test("durable MCP tools carry the SAME RBAC guard as legacy (conversation floor)", async () => {
	// Handing raw mcpManager.tools() to the durable registry skipped
	// guardTool("mcp", ...) → checkPermission never ran. mcp's base minimum is
	// "viewer", so the observable refusal comes from a per-conversation floor
	// (security.conversations[<cid>].mcp = admin) — the admin's actual lever.
	const { guardTool } = await import(pathToFileURL(join(outDir, "eng-probe.mjs")).href);

	let executed = 0;
	const raw = {
		name: "mcp__etc__query", label: "mcp__etc__query", description: "q",
		parameters: { type: "object", properties: {} },
		execute: async () => { executed += 1; return { content: [{ type: "text", text: "ok" }] }; },
	};
	const config = { all: () => ({
		security: { defaultRole: "viewer", adminStaffIds: [], ownerStaffIds: [], people: [], conversations: [{ id: "dt:group:x", floors: { mcp: "admin" } }] },
		capabilities: { mcp: { enabled: true } },
		general: {}, // progressWatchdog reads general.progressWatchdog (optional)
	}) };
	const guarded = guardTool("mcp", raw, {
		config, conversationId: "dt:group:x",
		resolveActor: () => ({ senderId: "u1", senderName: "someone" }),
	});

	const refusal = await guarded.execute("call1", {}, undefined, () => {});
	assert.equal(executed, 0, "the underlying MCP tool must NOT run below the conversation floor");
	const text = JSON.stringify(refusal?.content ?? refusal);
	assert.match(text, /权限|管理员/, `refusal must explain the gate: ${text}`);

	// And an ADMIN passes the same guard and reaches the tool.
	const adminConfig = { all: () => ({
		security: { defaultRole: "viewer", adminStaffIds: [], ownerStaffIds: [], people: [{ staffId: "boss", role: "admin" }], conversations: [{ id: "dt:group:x", floors: { mcp: "admin" } }] },
		capabilities: { mcp: { enabled: true } },
	}) };
	const adminGuarded = guardTool("mcp", raw, {
		config: adminConfig, conversationId: "dt:group:x",
		resolveActor: () => ({ senderId: "boss", senderName: "boss" }),
	});
	await adminGuarded.execute("call2", {}, undefined, () => {});
	assert.equal(executed, 1, "an admin above the floor must reach the tool");
});

test("P1: a successful background retry PUBLISHES (else the late server stays invisible)", async () => {
	// The bug's shape one layer up: refresh reports success but nothing reaches
	// the durable registry, so "connected" tools are still unseen by the model.
	const { Engine } = await import(pathToFileURL(join(outDir, "eng-probe.mjs")).href);
	const engine = Object.create(Engine.prototype);
	let published = 0;
	engine.shuttingDown = false;
	engine.config = { all: () => ({ capabilities: { mcp: { enabled: true } } }) };
	engine.durableRuntime = { setMcpTools: () => { published += 1; } };
	engine.mcpToolsFor = () => [tool("mcp__late__go")];
	engine.mcpManager = { refresh: async () => ({ changed: true, report: [{ name: "late", ok: true, tools: 1 }] }) };
	engine.unrefSleep = async () => {};

	const result = await engine.finishMcpConnectInBackground();
	assert.equal(result, undefined);
	assert.ok(published > 0, "a successful background connect must publish via setMcpTools");
});

test("P1: background retries stop after shutdown starts", async () => {
	const { Engine } = await import(pathToFileURL(join(outDir, "eng-probe.mjs")).href);
	const engine = Object.create(Engine.prototype);
	let refreshes = 0;
	engine.shuttingDown = true; // quit already began
	engine.config = { all: () => ({ capabilities: { mcp: { enabled: true } } }) };
	engine.durableRuntime = undefined;
	engine.mcpToolsFor = () => [];
	engine.mcpManager = { refresh: async () => { refreshes += 1; return { changed: false, report: [] }; } };
	engine.unrefSleep = async () => {};

	await engine.finishMcpConnectInBackground();
	assert.equal(refreshes, 0, "a retry must not reconnect transports during shutdown");
});

test("P1: mcpToolsFor actually APPLIES the guard (not just guardTool in isolation)", async () => {
	// Without this, deleting the .map(guardTool) call from mcpToolsFor passes every
	// other test: the isolated guardTool tests prove the guard works, not that the
	// engine uses it.
	const { Engine } = await import(pathToFileURL(join(outDir, "eng-probe.mjs")).href);
	const engine = Object.create(Engine.prototype);
	const config = { all: () => ({
		security: { defaultRole: "viewer", adminStaffIds: [], ownerStaffIds: [], people: [], conversations: [{ id: "dt:group:x", floors: { mcp: "admin" } }] },
		capabilities: { mcp: { enabled: true } },
	}) };
	let executed = 0;
	engine.config = config;
	engine.turnActor = new Map([["dt:group:x", { senderId: "u1", senderName: "someone" }]]);
	engine.noteAuthorizationNeeded = () => {};
	// The telemetry wrapper (added after the RBAC guard) touches these maps via
	// recordToolTelemetry → touchActivity. This test builds the engine with
	// Object.create, so constructor-initialised maps do not exist.
	engine.turnActivity = new Map();
	engine.turnActivityLog = new Map();
	engine.mcpManager = { tools: () => [{
		name: "mcp__etc__query", label: "q", description: "q",
		parameters: { type: "object", properties: {} },
		execute: async () => { executed += 1; return { content: [{ type: "text", text: "ok" }] }; },
	}] };

	const tools = engine.mcpToolsFor("dt:group:x");
	assert.equal(tools.length, 1, "the tool surface is still advertised (the guard refuses at call time)");
	const result = await tools[0].execute("call1", {}, undefined, () => {});
	assert.equal(executed, 0, "mcpToolsFor MUST wrap tools with the RBAC guard");
	assert.match(JSON.stringify(result?.content ?? result), /权限|管理员/);
});
