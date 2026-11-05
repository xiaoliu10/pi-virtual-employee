/**
 * Desktop composer resize (0.2.195).
 *
 * Field 2026-11-05 (user): "ve 升级到 193 版本了 怎么还不支持拖动对话框大小".
 * The 0.2.193 resize shipped on the EMBEDDED WIDGET only; the desktop chat
 * composer stayed `resize-none` with a fixed floor, so the app the user actually
 * runs had nothing to drag. These tests pin the desktop-side rules: clamping
 * (absolute + viewport), drag direction, and persistence keys.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "composer-height-"));
const bundle = join(dir, "c.mjs");
await build({
	stdin: { contents: `export * from "./renderer/src/lib/composer-height.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const {
	COMPOSER_DEFAULT_HEIGHT, COMPOSER_MIN_HEIGHT, COMPOSER_MAX_HEIGHT, COMPOSER_HEIGHT_KEY,
	clampComposerHeight, heightFromDrag, heightCeilingForViewport,
} = await import(pathToFileURL(bundle).href);

test("clamp: sane values pass, absurd ones are bounded (never 0, never huge)", () => {
	assert.equal(clampComposerHeight(120), 120);
	// Missing / empty / non-finite all fall back to the DEFAULT (not the minimum):
	// Number(null) === 0 would otherwise silently clamp to MIN.
	for (const missing of [null, undefined, "", "   ", NaN, Infinity, "abc", {}]) {
		assert.equal(clampComposerHeight(missing), COMPOSER_DEFAULT_HEIGHT, `must fall back: ${String(missing)}`);
	}
	assert.equal(clampComposerHeight(1), COMPOSER_MIN_HEIGHT, "below min → min");
	assert.equal(clampComposerHeight(-500), COMPOSER_MIN_HEIGHT);
	assert.equal(clampComposerHeight(5000), COMPOSER_MAX_HEIGHT, "above max → max");
	assert.equal(clampComposerHeight("140"), 140, "numeric strings (localStorage) are honoured");
});

test("drag: moving the pointer UP (negative deltaY) makes the composer taller", () => {
	// Caller passes startY - clientY, so an upward drag is positive here.
	assert.equal(heightFromDrag(100, 40), 140, "up 40 → +40");
	assert.equal(heightFromDrag(100, -30), 70, "down 30 → -30");
	assert.equal(heightFromDrag(100, -80), COMPOSER_MIN_HEIGHT, "down past the floor clamps to min");
	assert.equal(heightFromDrag(100, 10000), COMPOSER_MAX_HEIGHT, "up past the ceiling clamps");
});

test("viewport ceiling: the transcript keeps room on short windows", () => {
	// Tall window → the absolute max wins.
	assert.equal(heightCeilingForViewport(1200), COMPOSER_MAX_HEIGHT);
	// Short window → ceiling drops so 240px stay for messages.
	assert.equal(heightCeilingForViewport(700), 460 > COMPOSER_MAX_HEIGHT ? COMPOSER_MAX_HEIGHT : 460);
	assert.equal(heightCeilingForViewport(500), 260);
	// Tiny window → never below the minimum (a usable composer must still render).
	assert.equal(heightCeilingForViewport(200), COMPOSER_MIN_HEIGHT);
	// Unknown viewport → fall back to the absolute max rather than 0.
	for (const bad of [0, -10, NaN, Infinity]) {
		assert.equal(heightCeilingForViewport(bad), COMPOSER_MAX_HEIGHT, `bad viewport ${String(bad)}`);
	}
});

test("the storage key is namespaced and distinct from the sidebar's", () => {
	assert.equal(COMPOSER_HEIGHT_KEY, "ve.ui.composerHeight");
	assert.notEqual(COMPOSER_HEIGHT_KEY, "ve.ui.sidebarWidth");
	// Ordering invariant the component relies on.
	assert.ok(COMPOSER_MIN_HEIGHT < COMPOSER_DEFAULT_HEIGHT);
	assert.ok(COMPOSER_DEFAULT_HEIGHT < COMPOSER_MAX_HEIGHT);
});

test("the Composer component actually wires a drag handle (source contract)", async () => {
	// The renderer has no DOM test harness, so the wiring is asserted at the
	// source level: the strip must exist, be ns-resize, drive pointerdown, and
	// the textarea must no longer be fixed-height/no-resize.
	const { readFile } = await import("node:fs/promises");
	const src = await readFile(join(root, "renderer/src/components/Composer.tsx"), "utf8");
	assert.match(src, /cursor-ns-resize/, "the handle must advertise vertical resize");
	assert.match(src, /onPointerDown=\{(?:\(e\) =>|\()/, "the handle must start a drag on pointerdown");
	assert.match(src, /heightFromDrag\(/, "drag math must go through the tested pure helper");
	assert.match(src, /persist\(/, "the chosen height must be remembered");
	assert.match(src, /style=\{\{ height: `\$\{height\}px` \}\}/, "the textarea height must be driven by state");
	assert.doesNotMatch(src, /rows=\{2\}/, "the fixed 2-row textarea must be gone");
	assert.match(src, /clampComposerHeight\(readStored\(\)\)/, "the stored value must be clamped on mount");
});
