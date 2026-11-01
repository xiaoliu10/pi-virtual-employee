/**
 * MCP settings-save wiring test.
 *
 * The settings page promises "保存后自动重连". That promise lives in the
 * `config:set` IPC handler: without an explicit MCP refresh the newly added
 * server is only connected after an app restart, and 测试连接 (which builds its
 * own probe) happily succeeds — a silent lie (code-review P1). main.ts cannot
 * be imported outside Electron, so this asserts the contract on the source:
 * the handler must call engine.invalidate() AND engine.refreshMcpTools(), in
 * that order, and refreshMcpTools must really reach the manager.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(join(root, "electron/main.ts"), "utf8");
const engine = readFileSync(join(root, "src/engine/engine.ts"), "utf8");

function configSetHandlerBody(source) {
	const start = source.indexOf('ipcMain.handle("config:set"');
	assert.ok(start > 0, "config:set handler exists");
	// Walk the arrow body to its matching brace so assertions stay inside THIS
	// handler (a fixed-width slice bled into the next one).
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === "{") depth += 1;
		else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error("unbalanced config:set handler");
}

test("config:set reconnects MCP servers, not just sessions", () => {
	const handler = configSetHandlerBody(main);
	assert.match(handler, /engine\.invalidate\(\)/, "session rebuild still happens");
	const atInvalidate = handler.indexOf("engine.invalidate()");
	const atRefresh = handler.indexOf("engine.refreshMcpTools()");
	assert.ok(atRefresh > 0, "config:set must call engine.refreshMcpTools()");
	assert.ok(atRefresh > atInvalidate, "refresh runs after the session invalidation");
});

test("refreshMcpTools reaches the manager and is change-gated", () => {
	const at = engine.indexOf("async refreshMcpTools()");
	assert.ok(at > 0, "engine exposes refreshMcpTools()");
	const body = engine.slice(at, at + 400);
	assert.match(body, /await this\.refreshMcp\(\)/, "delegates to the real refresh");
	// A save that touched nothing MCP-related must be a cheap no-op.
	const refreshMcp = engine.slice(engine.indexOf("private async refreshMcp()"), engine.indexOf("private async refreshMcp()") + 900);
	assert.match(refreshMcp, /if \(changed\)/, "only a changed tool surface marks config changed");
	assert.match(refreshMcp, /this\.markConfigChanged\(\)/, "a changed surface rebuilds live sessions");
});

test("persisted MCP config is not interpolated; the connector resolves at connect time", () => {
	const configStore = readFileSync(join(root, "src/db/config-store.ts"), "utf8");
	const connector = readFileSync(join(root, "src/engine/tools/mcp.ts"), "utf8");
	assert.match(configStore, /normalizeMcpServers\(merged\.capabilities\?\.mcp\?\.servers, null\)/, "persist keeps ${ENV} references");
	assert.match(connector, /normalizeMcpServers\(mcpConfig\?\.servers, process\.env\)/, "connect resolves references");
});
