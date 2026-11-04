/**
 * Sidebar drag-to-resize — the clamping/persistence rules.
 *
 * The user asked for a draggable sidebar that remembers its width (2026-11-04).
 * The renderer has no jsdom/vitest setup, so the risky part (clamping, corrupt
 * storage, direction of the drag) lives in pure functions and is driven here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.sidebar-width-test-"));
process.on("exit", () => { rm(dir, { recursive: true, force: true }).catch(() => {}); });

const bundle = join(dir, "w.mjs");
await build({
	stdin: { contents: 'export * from "./renderer/src/lib/sidebar-width.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const {
	clampSidebarWidth, widthFromDrag,
	SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH,
} = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

test("default width matches the CSS baseline", () => {
	assert.equal(SIDEBAR_DEFAULT_WIDTH, 366);
});

test("widths inside the range pass through untouched", () => {
	assert.equal(clampSidebarWidth(400), 400);
	assert.equal(clampSidebarWidth(366), 366);
	assert.equal(clampSidebarWidth(SIDEBAR_MIN_WIDTH), SIDEBAR_MIN_WIDTH);
	assert.equal(clampSidebarWidth(SIDEBAR_MAX_WIDTH), SIDEBAR_MAX_WIDTH);
});

test("out-of-range widths clamp instead of breaking the layout", () => {
	assert.equal(clampSidebarWidth(10), SIDEBAR_MIN_WIDTH, "too narrow → min");
	assert.equal(clampSidebarWidth(-500), SIDEBAR_MIN_WIDTH);
	assert.equal(clampSidebarWidth(99999), SIDEBAR_MAX_WIDTH, "too wide → max");
});

test("a CORRUPT stored value falls back to the default (never 0px)", () => {
	// localStorage is user-writable and survives upgrades; a bad entry must not
	// wedge the sidebar shut.
	for (const bad of [null, undefined, "abc", NaN, Infinity, {}, ""]) {
		assert.equal(clampSidebarWidth(bad), SIDEBAR_DEFAULT_WIDTH, `bad value: ${String(bad)}`);
	}
});

test("dragging LEFT widens, dragging RIGHT narrows", () => {
	const start = 400;
	// clientX decreases by 60 → sidebar grows by 60 (caller passes startX - clientX)
	assert.equal(widthFromDrag(start, 60), 460, "divider moved left → wider");
	assert.equal(widthFromDrag(start, -60), 340, "divider moved right → narrower");
	assert.equal(widthFromDrag(start, 0), 400, "no movement → unchanged");
});

test("a drag past the limit stops at the limit, and reversing comes back immediately", () => {
	const start = 400;
	// Overshoot then reverse: because the width is derived from the START width
	// plus total delta (not accumulated per move), reversing recovers at once
	// instead of needing to "unwind" the overshoot first.
	assert.equal(widthFromDrag(start, 5000), SIDEBAR_MAX_WIDTH);
	assert.equal(widthFromDrag(start, 60), 460, "reversal is immediate");
	assert.equal(widthFromDrag(start, -5000), SIDEBAR_MIN_WIDTH);
});

test("fractional drags round to whole pixels (no subpixel layout drift)", () => {
	assert.equal(widthFromDrag(400, 10.4), 410);
	assert.equal(widthFromDrag(400, 10.6), 411);
});
