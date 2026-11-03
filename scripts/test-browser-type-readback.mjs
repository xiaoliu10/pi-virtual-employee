/**
 * browser_type readback contract (field, repeatedly: login forms).
 *
 * React/Vue controlled components do not update their state from a DOM value
 * assignment, so `fill()` leaves the box visually filled but the submitted
 * value empty. The tool was changed to type with real keyboard events AND to
 * make its readback authoritative: a readback shorter than what was sent must
 * report ok:false, never the old hard-coded ok:true that reported success even
 * when nothing landed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.browser-type-probe");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: { contents: 'export { evaluateTypeResult } from "./src/browser/browser-service.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { evaluateTypeResult } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

test("a full readback reports success", () => {
	assert.deepEqual(evaluateTypeResult("abc123", "abc123"), { ok: true, valueLength: 6 });
});

test("an EMPTY readback after fill (controlled component rejected it) is a failure", () => {
	// This is the exact field shape: text "sent", value stayed "".
	const r = evaluateTypeResult("123456", "");
	assert.equal(r.ok, false, "must not report success when nothing landed");
	assert.equal(r.valueLength, 0);
});

test("a partial readback is a failure (some keystrokes dropped)", () => {
	const r = evaluateTypeResult("123456", "123");
	assert.equal(r.ok, false);
});

test("the check is on LENGTH not identity, so masked password fields can still pass", () => {
	// A field that masks input still holds the same number of characters.
	assert.equal(evaluateTypeResult("secret", "••••••").ok, true);
});
