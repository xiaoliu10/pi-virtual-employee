/**
 * Widget thinking-header layout + default sizes (0.2.195).
 *
 * Field 2026-11-05 (user screenshot): the embedded widget's 「正在思考」header
 * rendered as four stacked single characters — 正/在/思/考 vertically — with the
 * body text cut off. Cause: `.t-title` is a flex item with no `nowrap`, and the
 * 160-char ticker next to it had `flex:1 1 auto`; at a narrow panel the ticker
 * consumed the row and squeezed the label to one character per line.
 *
 * The user's ask in the same turn: make the DEFAULT width and height larger.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const src = await readFile(join(root, "src/widget/widget-assets.ts"), "utf8");

/** Grab the CSS rules for one selector from the embedded stylesheet. */
function cssFor(selector) {
	const idx = src.indexOf(selector + " {");
	assert.ok(idx >= 0, `selector ${selector} must exist`);
	return src.slice(idx, src.indexOf("}", idx) + 1);
}

test("the «正在思考» label can never wrap one character per line", () => {
	const rule = cssFor(".think > summary .t-title");
	assert.match(rule, /white-space:\s*nowrap/, "title must be nowrap — this is the vertical-text bug");
	assert.match(rule, /flex:\s*0 0 auto/, "title must not be shrunk by the ticker");
});

test("the ticker yields space to the title instead of eating the row", () => {
	const ticker = cssFor(".think-ticker");
	assert.match(ticker, /flex:1 1 0/, "ticker must grow from 0 basis, not from its content");
	assert.match(ticker, /min-width:0/, "ticker must be allowed to shrink");
	assert.match(ticker, /margin-left/, "ticker needs a gap so it never touches the label");
});

test("default sizes are larger than the 0.2.193 baseline (380x560 popup)", () => {
	const panel = cssFor(".panel");
	const w = Number(/width:(\d+)px/.exec(panel)?.[1]);
	const h = Number(/height:(\d+)px/.exec(panel)?.[1]);
	assert.ok(w > 380, `popup width ${w} must exceed the old 380`);
	assert.ok(h > 560, `popup height ${h} must exceed the old 560`);
	assert.equal(w, 460);
	assert.equal(h, 680);
});

test("the standalone page opens wider than the old 720px cap", () => {
	const wrap = cssFor(".wrap");
	const max = Number(/max-width:(\d+)px/.exec(wrap)?.[1]);
	assert.ok(max > 720, `page max-width ${max} must exceed the old 720`);
	assert.equal(max, 880);
});

test("drag floors were raised so the header always fits", () => {
	// Two separate constants: popup (SIZE_KEY) and standalone page.
	const popup = /var MIN_W = (\d+), MIN_H = (\d+);\n  var wrapEl = document.querySelector\("\.page/.test(src)
		? null : /var MIN_W = (\d+), MIN_H = (\d+);/.exec(src);
	assert.ok(popup, "popup minimums must exist");
	assert.ok(Number(popup[1]) >= 380, `popup min width ${popup[1]} must fit the header`);
	assert.ok(Number(popup[2]) >= 420, `popup min height ${popup[2]}`);

	const pageMin = /var MIN_W = (\d+), MIN_H = (\d+);\n  var wrapEl/.exec(src);
	assert.ok(pageMin, "page minimums must exist");
	assert.ok(Number(pageMin[1]) >= 420, `page min width ${pageMin[1]}`);
	assert.ok(Number(pageMin[2]) >= 480, `page min height ${pageMin[2]}`);
});
