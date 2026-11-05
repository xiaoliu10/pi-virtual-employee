/**
 * Collapsible thinking box — the expand/collapse STATE MACHINE.
 *
 * User ruling 2026-11-04: "流式中展开，完成后自动收起" / "输出完思考信息之后
 * 默认折叠". That is the single most important behaviour of this component and it
 * had no test: the transport suite proves the reasoning ARRIVES, not that the box
 * behaves. The rule is extracted into reduceThinking() (a pure function) so it
 * can be driven here without a DOM (the renderer has no jsdom/vitest setup).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.thinking-box-state-test-"));
process.on("exit", () => { rm(dir, { recursive: true, force: true }).catch(() => {}); });

const bundle = join(dir, "box.mjs");
await build({
	stdin: { contents: 'export { reduceThinking } from "./renderer/src/components/ThinkingBox.tsx";', resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
	external: ["react"],
});
const { reduceThinking } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

const CLOSED = { open: false, manual: null };
const OPEN = { open: true, manual: null };

test("mount while streaming → expanded", () => {
	assert.deepEqual(reduceThinking(CLOSED, true, false), OPEN);
});

test("mount already finished (loaded from history) → collapsed", () => {
	assert.deepEqual(reduceThinking(CLOSED, false, false), CLOSED);
});

test("THE ASK: streaming → done auto-collapses", () => {
	// stream a while
	let s = reduceThinking(CLOSED, true, false);
	assert.equal(s.open, true, "expanded while streaming");
	// ...finish. This is the edge the user asked for.
	s = reduceThinking(s, false, true);
	assert.equal(s.open, false, "output finished → collapsed by default");
	assert.equal(s.manual, null, "the edge resets to the default, not a user override");
});

test("a manual collapse mid-stream is respected, and done still ends collapsed", () => {
	let s = reduceThinking(CLOSED, true, false);
	s = { open: false, manual: false }; // user collapsed it
	s = reduceThinking(s, true, true);  // more deltas arrive
	assert.equal(s.open, false, "the user's choice is not fought by every delta");
	s = reduceThinking(s, false, true); // finish
	assert.equal(s.open, false);
});

test("a manual RE-open mid-stream stays open while streaming", () => {
	let s = { open: true, manual: true };
	s = reduceThinking(s, true, true);
	assert.equal(s.open, true);
	assert.equal(s.manual, true);
});

test("done → done (no edge): a MANUAL open survives, an automatic one does not", () => {
	assert.deepEqual(reduceThinking(CLOSED, false, false), CLOSED);
	// manual:null means "no override" — the automatic rule (collapsed when not
	// streaming) applies, so even a stale open:true resolves to collapsed.
	assert.deepEqual(reduceThinking(OPEN, false, false), CLOSED);
	// A real user override is honoured.
	assert.deepEqual(reduceThinking({ open: true, manual: true }, false, false), { open: true, manual: true });
});

test("streaming → streaming follows the automatic rule (expanded)", () => {
	assert.deepEqual(reduceThinking(OPEN, true, true), OPEN);
	// An automatic (override-free) state resolves to expanded while streaming —
	// that IS the rule. A user override is what must survive, not a stale flag.
	assert.deepEqual(reduceThinking(CLOSED, true, true), OPEN);
	assert.deepEqual(reduceThinking({ open: false, manual: false }, true, true), { open: false, manual: false }, "a manual collapse survives mid-stream");
});

test("the finish edge overrides even a manual OPEN (predictable next render)", () => {
	// Someone opened it manually, then the turn ended: collapsed, override cleared
	// so a later re-render cannot reopen it unexpectedly.
	const s = reduceThinking({ open: true, manual: true }, false, true);
	assert.deepEqual(s, CLOSED);
});
