/**
 * Canvas / remote-desktop input tests for BrowserService. Run with
 * `npm run test:browser`.
 *
 * These cover the exact primitives a 堡垒机 H5 remote desktop or web terminal
 * needs, against a real Chromium instance and a locally served canvas fixture:
 *   - coordinate click lands on the canvas at the pixel asked for, reports focus
 *   - a click that opens a (async, gesture-less) popup is not blocked and is
 *     reported as a tab switch
 *   - wheel scroll, press-drag-release, and key chords reach the page
 *   - clipboard paste delivers CJK text (which key-by-key typing cannot)
 * The fixture records events so assertions are about what the PAGE received,
 * not about what our API returned.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.browser-canvas-test-"));
after(() => rm(workDir, { recursive: true, force: true }));

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>canvas fixture</title>
<style>html,body{margin:0;height:100%}canvas{display:block}</style></head>
<body>
<canvas id="remote" tabindex="0" width="1280" height="800"></canvas>
<input id="hidden-input" style="opacity:0;position:absolute;top:0;left:0;width:1px;height:1px">
<script>
  window.events = [];
  const canvas = document.getElementById('remote');
  const sink = document.getElementById('hidden-input');
  const ctx = canvas.getContext('2d');
  const paint = () => { ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 1280, 800); };
  paint();
  const log = (type, detail) => window.events.push({ type, ...detail });
  const targetName = (t) => (t && (t.id || t.tagName.toLowerCase())) || 'none';
  // A real H5 client focuses a hidden input (its keyboard sink) on mousedown, so
  // that is what the focus assertion is about — not the canvas element itself.
  canvas.addEventListener('mousedown', (e) => { log('mousedown', { x: e.offsetX, y: e.offsetY, button: e.button, clicks: e.detail }); e.preventDefault(); sink.focus(); });
  canvas.addEventListener('click', (e) => log('click', { x: e.offsetX, y: e.offsetY, clicks: e.detail }));
  canvas.addEventListener('dblclick', (e) => log('dblclick', { x: e.offsetX, y: e.offsetY }));
  canvas.addEventListener('mousemove', (e) => log('mousemove', { x: e.offsetX, y: e.offsetY }));
  canvas.addEventListener('mouseup', () => log('mouseup', {}));
  canvas.addEventListener('wheel', (e) => log('wheel', { x: e.offsetX, y: e.offsetY, deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) }));
  window.addEventListener('keydown', (e) => log('keydown', { key: e.key, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey, target: targetName(e.target) }));
  window.addEventListener('paste', (e) => { const text = (e.clipboardData || window.clipboardData).getData('text'); log('paste', { text, target: targetName(e.target) }); });
  // Async, gesture-less window.open — the bastion's "terminal did not open"
  // pattern. Playwright already disables Chromium's popup blocker by default, so
  // this is a regression guard (popups land and get adopted), not a fix for a
  // blocking bug: verified with a control run that the blocker is off either way.
  window.openTerminalLater = () => { setTimeout(() => window.open('about:blank?terminal=ssh', '_blank'), 50); return 'scheduled'; };
</script>
</body></html>`;

let server;
let baseUrl;
let service;
let db;
let browserForFixtureCheck;

before(async () => {
	server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(FIXTURE);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}/`;

	const bundle = join(workDir, "service.mjs");
	await build({
		stdin: { contents: 'export { ConfigStore } from "./src/db/config-store.ts"; export { BrowserService } from "./src/browser/browser-service.ts";', resolveDir: root, loader: "ts" },
		outfile: bundle,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
	});
	const { ConfigStore, BrowserService } = await import(pathToFileURL(bundle).href);
	db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	config.replaceAll({ browser: { enabled: true, headless: true, allowedDomains: ["127.0.0.1"] } });
	service = new BrowserService(config, workDir);
	// The app injects Electron's clipboard.writeText here; tests stand in with a
	// real Chromium clipboard so the paste path is exercised end to end.
	browserForFixtureCheck = await chromium.launch({ headless: true });
});

after(async () => {
	await service?.close().catch(() => {});
	await browserForFixtureCheck?.close().catch(() => {});
	db?.close();
	await new Promise((resolve) => server.close(resolve));
});

const OWNER = "test:canvas";
/** Events the fixture page recorded so far. */
async function events() {
	return service.evaluate(OWNER, "window.events");
}
/**
 * Point the owner back at the fixture tab and clear recorded events. Needed
 * because an adopted popup (the terminal-in-a-new-tab case) becomes the owner's
 * current page — later assertions would otherwise run against about:blank.
 */
async function focusFixture() {
	const pages = await service.listPages(OWNER);
	const idx = pages.findIndex((p) => p.url.startsWith(baseUrl));
	if (idx < 0) await service.navigate(OWNER, baseUrl);
	else if (!pages[idx].current) await service.switchPage(OWNER, idx);
	await service.evaluate(OWNER, "document.getElementById('hidden-input').focus(); window.events = []; 'ok'");
}
async function reset() {
	await service.evaluate(OWNER, "window.events = []; 'ok'");
}

test("coordinate click lands on the exact canvas pixel and reports focus", async () => {
	await focusFixture();
	const r = await service.mouseClick(OWNER, 321, 205);
	const seen = JSON.parse((await events()).value);
	const click = seen.find((e) => e.type === "click");
	assert.ok(click, "the canvas received a click");
	assert.equal(click.x, 321);
	assert.equal(click.y, 205);
	assert.equal(r.focus?.id, "hidden-input", "the client's keyboard sink took focus, so keystrokes will reach the remote session");
	assert.equal(r.tabSwitched, false);
});

test("double click and right click reach the canvas as such", async () => {
	await focusFixture();
	await service.mouseClick(OWNER, 400, 300, { double: true });
	const seen = JSON.parse((await events()).value);
	const dbl = seen.find((e) => e.type === "dblclick");
	assert.ok(dbl, "a real dblclick event was delivered (not two unrelated clicks)");
	assert.equal(dbl.x, 400);
	assert.equal(dbl.y, 300);

	await reset();
	await service.mouseClick(OWNER, 410, 310, { button: "right" });
	const right = JSON.parse((await events()).value).find((e) => e.type === "mousedown");
	assert.equal(right.button, 2, "button=2 is the right button");
});

test("wheel scroll and press-drag-release reach the canvas", async () => {
	await focusFixture();
	const wheel = await service.mouseWheel(OWNER, { x: 600, y: 400, deltaY: 240, times: 2 });
	assert.equal(wheel.deltaY, 240);
	const seen = JSON.parse((await events()).value).filter((e) => e.type === "wheel");
	assert.equal(seen.length, 2, "times=2 sends two wheel events");
	assert.equal(seen[0].deltaY, 240);
	assert.equal(seen[0].x, 600);

	await reset();
	await service.mouseDrag(OWNER, { x: 100, y: 100 }, { x: 260, y: 180 }, { steps: 6 });
	const drag = JSON.parse((await events()).value);
	const down = drag.findIndex((e) => e.type === "mousedown");
	const up = drag.findIndex((e) => e.type === "mouseup");
	assert.ok(down >= 0 && up > down, "the drag pressed before it released");
	assert.equal(drag[down].x, 100, "the press happened at the start point");
	const moves = drag.slice(down, up).filter((e) => e.type === "mousemove");
	assert.ok(moves.length >= 6, `intermediate moves were delivered (got ${moves.length})`);
	assert.equal(moves.at(-1).x, 260, "and the last move parked on the end point");
	assert.equal(moves.at(-1).y, 180);
});

test("key chords (Ctrl+C, Alt+Tab) carry their modifiers", async () => {
	await focusFixture();
	await service.mouseClick(OWNER, 500, 400);
	await service.pressKey(OWNER, "Control+c");
	await service.pressKey(OWNER, "Alt+Tab");
	await service.pressKey(OWNER, "PageDown");
	const keys = JSON.parse((await events()).value).filter((e) => e.type === "keydown");
	const ctrlC = keys.find((e) => e.key === "c");
	assert.equal(ctrlC.ctrl, true, "Ctrl+C arrived with the modifier, not as a bare 'c'");
	assert.equal(ctrlC.target, "hidden-input", "the chord landed on the focused sink, not on the page body");
	const altTab = keys.find((e) => e.key === "Tab");
	assert.equal(altTab.alt, true);
	assert.ok(keys.some((e) => e.key === "PageDown"), "PageDown is a valid key name");
});

test("typing focus-first lands keys on the canvas session (no separate click needed)", async () => {
	await focusFixture();
	await service.keyboardType(OWNER, "select 1", { x: 640, y: 420 });
	const seen = JSON.parse((await events()).value);
	assert.ok(seen.some((e) => e.type === "mousedown" && e.x === 640), "the focus click happened first");
	const typed = seen.filter((e) => e.type === "keydown").map((e) => e.key).join("");
	assert.equal(typed, "select 1");
});

test("clipboard paste delivers CJK text that key-by-key typing cannot", async () => {
	await focusFixture();
	const written = [];
	service.setClipboardWriter((text) => { written.push(text); });
	await service.mouseClick(OWNER, 700, 500);
	const r = await service.pasteText(OWNER, "select * from 生产订单 where 状态='已发货';");
	assert.equal(written[0], "select * from 生产订单 where 状态='已发货';", "the OS clipboard received the exact text");
	assert.equal(r.chord.includes("v"), true);
	const seen = JSON.parse((await events()).value);
	const paste = seen.find((e) => e.type === "paste");
	assert.ok(paste, "the page saw a real paste event");
	assert.equal(paste.text, "select * from 生产订单 where 状态='已发货';", "CJK survived the clipboard path");
	assert.equal(r.clipboard, "both", "both the OS and page clipboard were written");
});

test("a click-opened popup lands as a new tab and is adopted (not blocked)", async () => {
	await focusFixture();
	const before = (await service.listPages(OWNER)).length;
	// Ask the page to open a window WITHOUT a user gesture (the async case a popup
	// blocker would normally kill — the bastion's "terminal did not open" claim).
	await service.evaluate(OWNER, "window.openTerminalLater()");
	await new Promise((resolve) => setTimeout(resolve, 700));
	const after = await service.listPages(OWNER);
	assert.equal(after.length, before + 1, `a new tab was created (before=${before}, after=${after.length})`);
	assert.ok(after.some((p) => p.url.includes("terminal=ssh")), "and it is the terminal tab, adopted as the owner's current page");
});

test("out-of-viewport coordinates are refused with an actionable message", async () => {
	await focusFixture();
	await assert.rejects(() => service.mouseClick(OWNER, 5000, 10), /超出视口/);
	await assert.rejects(() => service.mouseWheel(OWNER, { deltaX: 0, deltaY: 0 }), /不能同时为 0/);
	await assert.rejects(() => service.mouseDrag(OWNER, { x: -5, y: 10 }, { x: 10, y: 10 }), /超出视口/);
});
