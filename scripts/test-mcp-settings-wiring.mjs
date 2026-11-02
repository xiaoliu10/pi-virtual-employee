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

test("the test-connection probe forces the row enabled (a disabled row must still be testable)", () => {
	const at = main.indexOf('ipcMain.handle("mcp:test"');
	assert.ok(at > 0, "mcp:test handler exists");
	let depth = 0;
	let started = false;
	let end = at;
	for (let i = main.indexOf("{", at); i < main.length; i += 1) {
		if (main[i] === "{") { depth += 1; started = true; }
		else if (main[i] === "}") { depth -= 1; }
		if (started && depth === 0) { end = i; break; }
	}
	const handler = main.slice(at, end + 1);
	// refresh() filters `enabled: false`, so passing the row through unchanged makes
	// the report have no matching entry and the probe fails with no reason.
	// Must force the SERVER ENTRY enabled (the outer mcp.enabled flag is a
	// different field). Assert the spread-and-override shape, not just any
	// "enabled: true" in the handler.
	assert.match(handler, /servers: \[\{[^\]]*enabled: true/, "the probe entry itself is forced enabled");
});

test("quitting waits for the MCP teardown instead of racing the process exit", () => {
	// Locate the engine-scoped will-quit hook (the one that calls disposeMcp).
	const at = main.indexOf("engine.disposeMcp()");
	assert.ok(at > 0, "a will-quit hook disposes MCP connections");
	const hookStart = main.lastIndexOf('app.on("will-quit"', at);
	assert.ok(hookStart > 0, "the dispose call lives inside a will-quit hook");
	const hook = main.slice(hookStart, at + 400);
	// A fire-and-forget `void dispose()` loses the race: Electron exits with the
	// event loop and the stdio children outlive it (review P1).
	assert.match(hook, /event\.preventDefault\(\)/, "the first quit is deferred");
	assert.match(hook, /Promise\.race\(/, "the teardown is bounded so a hung server cannot block quitting");
	assert.match(hook, /app\.quit\(\)/, "the deferred quit is re-issued after cleanup");
});

test("an external MCP config push never overwrites unsaved editor rows", () => {
	const page = readFileSync(join(root, "renderer/src/pages/SettingsPage.tsx"), "utf8");
	// MCP rows live outside `draft`, so the draft-adoption guard does not cover
	// them: re-seeding unconditionally threw away edits in progress (review P2).
	const at = page.indexOf("const mcpSeed = persistedSeed(config);");
	assert.ok(at > 0, "the reseed effect exists");
	const effect = page.slice(at, at + 900);
	assert.match(effect, /if \(mcpDirtyRef\.current\) return;/, "dirty rows are preserved");
	assert.match(effect, /mcpSeedRef\.current === mcpSeed/, "an unchanged list does not re-seed");
	// The save path must mark the rows clean, or the editor stays permanently dirty.
	const saveAt = page.indexOf("await onChange(merged.config);");
	assert.ok(saveAt > 0, "the save path exists");
	assert.match(page.slice(saveAt, saveAt + 400), /mcpSeedRef\.current = persistedSeed\(merged\.config\)/, "saving marks the rows clean");
});

test("the connection probe validates the row and pins its result to what it tested", () => {
	const page = readFileSync(join(root, "renderer/src/pages/SettingsPage.tsx"), "utf8");
	assert.match(page, /const problems = validateRow\(row\);/, "the probe validates before IPC (it used to drop malformed args)");
	assert.match(page, /const fingerprint = rowFingerprint\(row\);/, "the probe records the tested configuration");
	assert.match(page, /prev\[row\.uid\]\?\.fingerprint !== fingerprint/, "a result is dropped when the row no longer matches");
	assert.match(page, /seq !== probeSeq\.current/, "an older response cannot overwrite a newer one");
});
