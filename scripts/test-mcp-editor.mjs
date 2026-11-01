/**
 * MCP settings-editor helper tests.
 *
 * The helpers live inside SettingsPage.tsx (not exported), so this extracts the
 * function bodies from the real source and runs them through esbuild — the same
 * code the UI runs, no duplicated fixture implementation. Guards:
 *  - args round-trip is lossless (spaces/quotes/apostrophes/empty/Windows paths)
 *  - malformed args are REPORTED, never silently dropped
 *  - cwd/env/timeout survive an edit round-trip (cwd was dropped before)
 *  - row uids are unique (probe results are keyed by them)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "renderer/src/pages/SettingsPage.tsx"), "utf8");
const lines = source.split("\n");

/** Extract one top-level `function name(...) {...}` by brace balance. */
function grab(name) {
	const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
	assert.ok(start >= 0, `helper ${name} exists in SettingsPage.tsx`);
	let depth = 0;
	let started = false;
	for (let i = start; i < lines.length; i += 1) {
		for (const ch of lines[i]) {
			if (ch === "{") { depth += 1; started = true; }
			else if (ch === "}") depth -= 1;
		}
		if (started && depth === 0) return lines.slice(start, i + 1).join("\n");
	}
	throw new Error(`unbalanced helper ${name}`);
}

const ifaceAt = lines.findIndex((l) => l.startsWith("interface McpRowDraft"));
const decl = lines.slice(ifaceAt, ifaceAt + 14).join("\n");
const helpers = [decl, ...["parseKeyValueLines", "parseArgsJson", "serverToRow", "rowToServer"].map(grab)].join("\n\n");
const probe = `${helpers}
export { parseArgsJson, serverToRow, rowToServer };`;

const workDir = join(root, "node_modules/.mcp-editor-test");
mkdirSync(workDir, { recursive: true });
writeFileSync(join(workDir, "helpers.ts"), probe);
await build({
	entryPoints: [join(workDir, "helpers.ts")],
	outfile: join(workDir, "helpers.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { parseArgsJson, serverToRow, rowToServer } = await import(pathToFileURL(join(workDir, "helpers.mjs")).href);

test("args round-trip is lossless (spaces, quotes, apostrophes, empty, Windows paths)", () => {
	const nasty = ["-y", "C:\\Program Files\\x\\server.js", "it's", 'say "hi"', "", "a\\b"];
	const back = rowToServer(serverToRow({ name: "s", command: "node", args: nasty }));
	assert.deepEqual(back.args, nasty, "every argument survives an edit round-trip unchanged");
});

test("malformed args are reported instead of silently dropped", () => {
	const bad = parseArgsJson("--foo bar");
	assert.equal(bad.ok, false);
	assert.match(bad.reason, /JSON 字符串数组/);
	assert.deepEqual(parseArgsJson(""), { ok: true, args: [] }, "empty input means no args");
	assert.deepEqual(parseArgsJson('["a"]'), { ok: true, args: ["a"] });
	assert.equal(parseArgsJson('["a", 1]').ok, false, "non-string entries are rejected");
});

test("cwd, env, timeout and the HTTP shape survive an edit round-trip", () => {
	const back = rowToServer(serverToRow({
		name: "s", command: "node", cwd: "/tmp/w", timeoutSec: 15,
		env: { K: "v with spaces = ok" },
	}));
	assert.equal(back.cwd, "/tmp/w", "cwd used to be dropped by the editor");
	assert.deepEqual(back.env, { K: "v with spaces = ok" }, "env values keep their whitespace");
	assert.equal(back.timeoutSec, 15);

	const http = rowToServer(serverToRow({ name: "h", url: "https://x/mcp", headers: { A: "b" } }));
	assert.equal(http.url, "https://x/mcp");
	assert.deepEqual(http.headers, { A: "b" });
	assert.equal(http.command, undefined, "HTTP rows do not leak a stdio command");
});

test("row uids are unique (probe results are keyed by them)", () => {
	const ids = new Set(Array.from({ length: 50 }, (_, i) => serverToRow({ name: `s${i}` }).uid));
	assert.equal(ids.size, 50, "uids must never collide across rows");
});
