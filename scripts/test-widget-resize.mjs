/**
 * Widget panel RESIZE (v0.2.193).
 *
 * User report: "AI 助手页面应该支持拖动变大或者变小，要不然对话框太小了".
 * The panel was a hard-coded 380x560 box with no way to change it.
 *
 * Pinned properties (behaviour, not source strings — the grip is driven with
 * real pointer events through the SERVED page script):
 *   1. both channels expose a grip and it is inside the panel/wrap;
 *   2. dragging grows/shrinks the panel, in the channel's own direction
 *      (floating panel is anchored bottom-right → drag left/up = bigger;
 *      standalone page → drag right/down = bigger);
 *   3. size is clamped to a sane minimum (a panel dragged to nothing is a
 *      support ticket) and to the viewport (never unreachable);
 *   4. the chosen size persists in localStorage and is re-applied on boot;
 *   5. a corrupt/absurd stored value never breaks the panel.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "widget-resize-"));
const bundle = join(dir, "r.mjs");
await build({
	stdin: {
		contents: `export { renderWidgetPage, renderWidgetLoader } from "./src/widget/widget-assets.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { renderWidgetPage, renderWidgetLoader } = await import(pathToFileURL(bundle).href);

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parentNode = null;
		this.className = "";
		this.id = "";
		this._text = "";
		this._classes = new Set();
		this.style = {};
		this._attrs = new Map();
		this._listeners = new Map();
		this.scrollTop = 0;
		this.scrollHeight = 0;
		this._inner = "";
		this.classList = {
			add: (...c) => c.forEach((x) => this._classes.add(x)),
			remove: (...c) => c.forEach((x) => this._classes.delete(x)),
			toggle: (c, force) => {
				const want = force === undefined ? !this._classes.has(c) : force;
				if (want) this._classes.add(c);
				else this._classes.delete(c);
				return want;
			},
			contains: (c) => this._classes.has(c),
		};
	}
	get textContent() {
		return this._text + this.children.map((c) => c.textContent).join("");
	}
	set textContent(v) {
		this._text = String(v ?? "");
		this.children = [];
	}
	get value() {
		return this._value ?? "";
	}
	set value(v) {
		this._value = String(v ?? "");
	}
	appendChild(child) {
		child.parentNode = this;
		this.children.push(child);
		return child;
	}
	insertBefore(child, anchor) {
		const i = this.children.indexOf(anchor);
		if (i < 0) throw new Error("insertBefore: anchor not a child");
		child.parentNode = this;
		this.children.splice(i, 0, child);
		return child;
	}
	remove() {
		if (!this.parentNode) return;
		const i = this.parentNode.children.indexOf(this);
		if (i >= 0) this.parentNode.children.splice(i, 1);
		this.parentNode = null;
	}
	setAttribute(k, v) {
		this._attrs.set(String(k), String(v));
	}
	getAttribute(k) {
		return this._attrs.has(String(k)) ? this._attrs.get(String(k)) : null;
	}
	removeAttribute(k) {
		this._attrs.delete(String(k));
	}
	hasAttribute(k) {
		return this._attrs.has(String(k));
	}
	addEventListener(type, fn) {
		if (!this._listeners.has(type)) this._listeners.set(type, []);
		this._listeners.get(type).push(fn);
	}
	/** Fire a listener the way a browser would. */
	fire(type, ev = {}) {
		for (const fn of this._listeners.get(type) ?? []) fn(ev);
	}
	focus() {}
	querySelector(sel) {
		return this._find(sel);
	}
	querySelectorAll(sel) {
		const out = [];
		const walk = (node) => {
			for (const c of node.children) {
				if (matches(c, sel)) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}
	_find(sel) {
		let found = null;
		const walk = (node) => {
			for (const c of node.children) {
				if (found) return;
				if (matches(c, sel)) {
					found = c;
					return;
				}
				walk(c);
			}
		};
		walk(this);
		return found;
	}
	_setInner(v) {
		this._inner = String(v);
		this.children = [];
		// The floating panel builds its chrome via innerHTML. A browser parses it
		// into real nodes; the stub must too, otherwise panel.querySelector(".head
		// button") is null and the shipped wiring cannot be exercised.
		if (this._inner.includes('class="head"')) {
			const head = new El("div");
			head.className = "head";
			const title = new El("span");
			title.className = "t";
			head.appendChild(title);
			const closeBtn = new El("button");
			head.appendChild(closeBtn);
			this.appendChild(head);
			const body = new El("div");
			body.className = "body";
			for (const cls of ["hero", "chips", "msgs"]) {
				const d = new El("div");
				d.className = cls;
				body.appendChild(d);
			}
			this.appendChild(body);
			const foot = new El("div");
			foot.className = "foot";
			const box = new El("textarea");
			box.className = "box";
			foot.appendChild(box);
			const sendRow = new El("div");
			sendRow.className = "sendrow";
			const sendBtn = new El("button");
			sendBtn.className = "send";
			sendRow.appendChild(sendBtn);
			foot.appendChild(sendRow);
			const dis = new El("div");
			dis.className = "dis";
			foot.appendChild(dis);
			this.appendChild(foot);
		}
	}
	get innerHTML() {
		return this._inner ?? "";
	}
	set innerHTML(v) {
		this._setInner(v);
	}
	getBoundingClientRect() {
		const w = Number.parseFloat(this.style.width) || 380;
		const h = Number.parseFloat(this.style.height) || 560;
		return { width: w, height: h, top: 0, left: 0, right: w, bottom: h };
	}
	setPointerCapture() {}
	releasePointerCapture() {}
}

/** Ultra-minimal selector match: ".cls" and "tag.cls" chains. */
function matches(el, sel) {
	const s = String(sel).trim();
	// descendant selector: ".a b" — match the last simple selector only; the
	// stub's _find already walks the subtree so the ancestor part is implied.
	if (/\s/.test(s)) return matches(el, s.split(/\s+/).pop());
	if (s.startsWith(".")) {
		const cls = s.slice(1).split(".")[0];
		return el._classes.has(cls) || String(el.className).split(/\s+/).includes(cls);
	}
	const [tag, ...rest] = s.split(".");
	if (el.tagName !== tag.toUpperCase()) return false;
	return rest.every((c) => el._classes.has(c) || String(el.className).split(/\s+/).includes(c));
}

function makeEnv({ store = new Map(), width = 1280, height = 900 } = {}) {
	const body = new El("body");
	const html = new El("html");
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const byId = new Map();
	const doc = {
		currentScript: null,
		createElement: (tag) => new El(tag),
		createTextNode: (t) => ({ textContent: String(t) }),
		getElementById: (id) => byId.get(id) ?? new El("div"),
		querySelector: (sel) => body.querySelector(sel) ?? new El("div"),
		addEventListener() {},
		body,
		documentElement: html,
	};
	const win = {
		addEventListener() {},
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		innerWidth: width,
		innerHeight: height,
		localStorage,
	};
	return { doc, win, body, html, localStorage, store, byId };
}

/** Boot the standalone page (renderWidgetPage) against the stub DOM. */
function bootPage(env) {
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
	const msgs = new El("div");
	msgs.className = "msgs";
	msgs.id = "msgs";
	const bodyEl = new El("div");
	bodyEl.id = "body";
	// A fresh boot must not see the previous run's .wrap (querySelector would
	// return the stale one and assertions would read the wrong element).
	env.body.children = [];
	const wrap = new El("div");
	wrap.className = "wrap";
	env.body.appendChild(wrap);
	env.byId.set("msgs", msgs);
	env.byId.set("body", bodyEl);
	for (const id of ["t", "hero", "chips", "dis"]) env.byId.set(id, new El("div"));
	const box = new El("textarea");
	box.id = "box";
	env.byId.set("box", box);
	const sendBtn = new El("button");
	sendBtn.id = "send";
	env.byId.set("send", sendBtn);
	const scriptEl = new El("script");
	const attrs = new Map([["data-ticket", "ticket"], ["data-token", ""], ["data-user", "u"], ["data-title", ""]]);
	scriptEl.getAttribute = (k) => attrs.get(k) ?? null;
	const sandbox = {
		document: { ...env.doc, currentScript: scriptEl },
		window: env.win,
		localStorage: env.localStorage,
		innerWidth: env.win.innerWidth,
		innerHeight: env.win.innerHeight,
		fetch: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) }),
		console,
		setTimeout,
		clearTimeout,
		Promise,
		queueMicrotask,
		TextDecoder,
		TextEncoder,
		requestAnimationFrame: (fn) => setTimeout(fn, 0),
		location: { href: "http://localhost/", search: "", hash: "" },
		URLSearchParams,
		JSON,
		isFinite,
		Math,
	};
	const fn = new Function(...Object.keys(sandbox), code);
	fn(...Object.values(sandbox));
	return { wrap, hook: env.win.__veWidgetResize };
}

/** Boot the floating loader (renderWidgetLoader) against the stub DOM. */
function bootLoader(env) {
	const code = renderWidgetLoader({ icon: "text", iconUrl: "", size: 52 });
	// The loader needs attachShadow + a shadow root that supports querySelector.
	const host = new El("div");
	host.attachShadow = () => host;
	env.doc.createElement = (tag) => {
		if (tag === "div" && !env._hostUsed) {
			env._hostUsed = true;
			return host;
		}
		return new El(tag);
	};
	env.doc.body.appendChild = (c) => {
		host.parentNode = env.body;
		env.body.children.push(host);
		return c;
	};
	const scriptEl = new El("script");
	const attrs = new Map([["data-ticket", "ticket"], ["data-token", ""], ["data-user", "u"], ["data-title", ""]]);
	scriptEl.getAttribute = (k) => attrs.get(k) ?? null;
	scriptEl.src = "http://localhost/widget.js";
	const sandbox = {
		document: { ...env.doc, currentScript: scriptEl },
		window: env.win,
		localStorage: env.localStorage,
		innerWidth: env.win.innerWidth,
		innerHeight: env.win.innerHeight,
		fetch: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) }),
		console,
		setTimeout,
		clearTimeout,
		Promise,
		queueMicrotask,
		TextDecoder,
		TextEncoder,
		requestAnimationFrame: (fn) => setTimeout(fn, 0),
		location: { href: "http://localhost/", search: "", hash: "" },
		URLSearchParams,
		JSON,
		isFinite,
		Math,
	};
	const fn = new Function(...Object.keys(sandbox), code);
	fn(...Object.values(sandbox));
	return { host, hook: env.win.__veWidgetResize };
}

test("standalone page: a grip exists inside .wrap and dragging grows the panel", () => {
	const env = makeEnv();
	const { wrap, hook } = bootPage(env);
	assert.ok(hook, "页面必须暴露 resize 钩子（供测试与宿主页检查）");
	const grip = hook.grip;
	assert.ok(grip, "必须渲染拖拽抓手");
	assert.equal(grip.parentNode, wrap, "抓手必须在 .wrap 内部才能定位到角上");

	// 初始宽度未知（页面没设内联宽度时会回落到 stub 的 380）
	hook.setPageSize(600, 700);
	const before = wrap.getBoundingClientRect();
	assert.equal(Math.round(before.width), 600);
	assert.equal(Math.round(before.height), 700);

	// 拖拽：从 (600,700) 向右下拖 120/90 → 变大
	grip.fire("pointerdown", { clientX: 600, clientY: 700, pointerId: 1, preventDefault() {} });
	grip.fire("pointermove", { clientX: 720, clientY: 790 });
	const after = wrap.getBoundingClientRect();
	assert.equal(Math.round(after.width), 720, "向右拖必须变宽");
	assert.equal(Math.round(after.height), 790, "向下拖必须变高");
	grip.fire("pointerup", { pointerId: 1 });
});

test("standalone page: min size is clamped (a panel dragged to nothing is a bug)", () => {
	const env = makeEnv();
	const { wrap, hook } = bootPage(env);
	hook.setPageSize(600, 700);
	const grip = hook.grip;
	grip.fire("pointerdown", { clientX: 600, clientY: 700, pointerId: 1, preventDefault() {} });
	grip.fire("pointermove", { clientX: -5000, clientY: -5000 });
	const r = wrap.getBoundingClientRect();
	assert.ok(r.width >= 360, `宽度下限必须生效，实际 ${r.width}`);
	assert.ok(r.height >= 420, `高度下限必须生效，实际 ${r.height}`);
	grip.fire("pointerup", { pointerId: 1 });
});

test("standalone page: size respects the viewport (never grows off-screen)", () => {
	const env = makeEnv({ width: 900, height: 700 });
	const { wrap, hook } = bootPage(env);
	hook.setPageSize(100000, 100000);
	const r = wrap.getBoundingClientRect();
	assert.ok(r.width <= 900 - 32 + 1, `宽度必须夹在视口内，实际 ${r.width}`);
	assert.ok(r.height <= 700 - 24 + 1, `高度必须夹在视口内，实际 ${r.height}`);
});

test("standalone page: the chosen size persists and is re-applied on the next boot", () => {
	const env = makeEnv();
	const first = bootPage(env);
	first.hook.setPageSize(640, 780);
	first.hook.grip.fire("pointerdown", { clientX: 640, clientY: 780, pointerId: 1, preventDefault() {} });
	first.hook.grip.fire("pointerup", { pointerId: 1 });

	const raw = env.store.get("ve-widget-page-size");
	assert.ok(raw, "调整后必须写入 localStorage");
	const saved = JSON.parse(raw);
	assert.equal(saved.w, 640);
	assert.equal(saved.h, 780);

	// 重新 boot（模拟刷新）：尺寸必须恢复
	const second = bootPage(env);
	const r = second.wrap.getBoundingClientRect();
	assert.equal(Math.round(r.width), 640, "刷新后恢复宽度");
	assert.equal(Math.round(r.height), 780, "刷新后恢复高度");
});

test("standalone page: a corrupt stored size never breaks the panel", () => {
	for (const bad of ["not-json", "{}", '{"w":"x","h":2}', '{"w":null}', "[]"]) {
		const env = makeEnv();
		env.store.set("ve-widget-page-size", bad);
		assert.doesNotThrow(() => bootPage(env), `损坏值 ${bad} 不得让页面脚本抛错`);
	}
});

test("floating panel: dragging LEFT/UP grows it (anchored to the bottom-right corner)", () => {
	const env = makeEnv();
	const { host, hook } = bootLoader(env);
	assert.ok(hook, "浮窗通道也必须暴露 resize 钩子");
	const grip = hook.grip;
	const panel = grip.parentNode;
	assert.ok(panel, "抓手必须有父面板");
	hook.setPanelSize(420, 600);
	const before = panel.getBoundingClientRect();
	assert.equal(Math.round(before.width), 420);

	// 锚在右下角：向左上拖 = 变大
	grip.fire("pointerdown", { clientX: 100, clientY: 100, pointerId: 2, preventDefault() {} });
	grip.fire("pointermove", { clientX: 40, clientY: 20 });
	const after = panel.getBoundingClientRect();
	assert.equal(Math.round(after.width), 480, "向左拖必须变宽");
	assert.equal(Math.round(after.height), 680, "向上拖必须变高");
	grip.fire("pointerup", { pointerId: 2 });
});

test("floating panel: size persists across opens and stays inside the viewport", () => {
	const env = makeEnv({ width: 1000, height: 800 });
	const first = bootLoader(env);
	first.hook.setPanelSize(500, 640);
	first.hook.grip.fire("pointerdown", { clientX: 500, clientY: 640, pointerId: 3, preventDefault() {} });
	first.hook.grip.fire("pointerup", { pointerId: 3 });
	const saved = JSON.parse(env.store.get("ve-widget-size"));
	assert.equal(saved.w, 500);
	assert.equal(saved.h, 640);

	const second = bootLoader(env);
	const r = second.hook.grip.parentNode.getBoundingClientRect();
	assert.equal(Math.round(r.width), 500, "重开后恢复宽度");
	assert.equal(Math.round(r.height), 640, "重开后恢复高度");

	// 视口不够大时按上限夹取（CSS 的 max-width/height 同口径）
	second.hook.setPanelSize(9999, 9999);
	const r2 = second.hook.grip.parentNode.getBoundingClientRect();
	assert.ok(r2.width <= 1000 - 32 + 1, `宽度夹在视口内，实际 ${r2.width}`);
	assert.ok(r2.height <= 800 - 130 + 1, `高度夹在视口内，实际 ${r2.height}`);
});

test("both channels ship the grip style and a resize cursor", () => {
	const page = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	const loader = renderWidgetLoader({ icon: "text", iconUrl: "", size: 52 });
	for (const [label, html] of [["page", page], ["loader", loader]]) {
		assert.ok(/\.rzer\s*\{[^}]*cursor:nwse-resize/.test(html), `${label}: 抓手必须有 nwse-resize 光标`);
		assert.ok(/\.rzer::after\s*\{[^}]*border-right/.test(html), `${label}: 抓手必须有可见的角标`);
	}
	// 独立页的 .wrap 必须能定位抓手
	assert.ok(/\.wrap\s*\{[^}]*position:relative/.test(page), "独立页 .wrap 必须 position:relative");
});

/** WCAG 2.1 contrast ratio against #ffffff (handles 3/6-digit hex and opacity). */
function contrastAgainstWhite(hex, opacity = 1) {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	assert.ok(m, `unexpected hex color: ${hex}`);
	const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
	const ch = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
	// Alpha-composite over #ffffff before computing relative luminance.
	const lum = ch
		.map((v) => (v * opacity + 255 * (1 - opacity)) / 255)
		.map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
	const L = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
	return 1.05 / (L + 0.05);
}

test("keyboard accessibility (P2): both channels make grip focusable with ARIA and visible focus ring", () => {
	for (const [label, boot] of [["page", bootPage], ["loader", bootLoader]]) {
		const env = makeEnv({ width: 1280, height: 900 });
		const res = boot(env);
		const panel = res.wrap ?? res.hook.grip.parentNode;
		const grip = res.hook.grip;

		assert.equal(grip.getAttribute("tabindex"), "0", `${label}: grip must have tabindex="0" so Tab reaches it`);
		assert.equal(grip.getAttribute("role"), "separator", `${label}: grip must expose separator role`);
		assert.equal(grip.getAttribute("aria-orientation"), "both", `${label}: grip must declare 2D resize orientation`);
		assert.ok(grip.getAttribute("aria-label"), `${label}: grip must keep aria-label`);

		// Keyboard arrow resizing changes panel size and persists to localStorage.
		if (res.hook.setPageSize) res.hook.setPageSize(600, 700);
		else res.hook.setPanelSize(460, 680);
		const before = panel.getBoundingClientRect();
		// Floating panel grows on ArrowLeft/ArrowUp; standalone page grows on ArrowRight/ArrowDown.
		const keys = label === "loader" ? ["ArrowLeft", "ArrowUp"] : ["ArrowRight", "ArrowDown"];
		for (const key of keys) {
			let prevented = false;
			grip.fire("keydown", { key, preventDefault() { prevented = true; } });
			assert.equal(prevented, true, `${label}: ${key} should prevent page scroll`);
		}
		const after = panel.getBoundingClientRect();
		assert.ok(after.width > before.width, `${label}: arrow key must widen panel (${before.width} -> ${after.width})`);
		assert.ok(after.height > before.height, `${label}: arrow key must heighten panel (${before.height} -> ${after.height})`);
	}

	const page = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	const loader = renderWidgetLoader({ icon: "text", iconUrl: "", size: 52 });
	for (const [label, html] of [["page", page], ["loader", loader]]) {
		assert.match(html, /\.rzer:focus-visible\s*\{[^}]*outline:/, `${label}: focus-visible outline must be styled`);
	}
});

test("affordance & contrast (P1): grip hit target >= 28x28, visual mark >= 12x12, resting contrast >= 3:1", async () => {
	const postcss = (await import("postcss")).default;
	const page = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	const loader = renderWidgetLoader({ icon: "text", iconUrl: "", size: 52 });

	for (const [label, html] of [["page", page], ["loader", loader]]) {
		let cssText;
		if (label === "page") {
			cssText = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
		} else {
			// var css = "<JSON-encoded SHARED_CSS>" + `\n ... \n`;
			const start = html.indexOf("var css = ") + "var css = ".length;
			const plusIdx = html.indexOf(" + `", start);
			const endIdx = html.indexOf("`;\n  var style", plusIdx);
			assert.ok(plusIdx > start && endIdx > plusIdx, "loader css parts found");
			try {
				cssText = JSON.parse(html.slice(start, plusIdx)) + html.slice(plusIdx + 4, endIdx);
			} catch (err) {
				assert.fail(`loader css JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		assert.ok(cssText, `${label}: extracted CSS`);
		const rootCss = postcss.parse(cssText);

		let rzerW = 0, rzerH = 0, markW = 0, markH = 0, color = "", opacity = 1;
		rootCss.walkRules((rule) => {
			const sel = rule.selector.trim();
			if (sel === ".rzer") {
				rule.walkDecls("width", (d) => { rzerW = Number.parseFloat(d.value); });
				rule.walkDecls("height", (d) => { rzerH = Number.parseFloat(d.value); });
			}
			if (sel === ".rzer::after") {
				rule.walkDecls("width", (d) => { markW = Number.parseFloat(d.value); });
				rule.walkDecls("height", (d) => { markH = Number.parseFloat(d.value); });
				rule.walkDecls("border-right", (d) => { color = d.value.split(/\s+/).pop() ?? ""; });
				rule.walkDecls("opacity", (d) => { opacity = Number.parseFloat(d.value); });
			}
		});
		assert.ok(rzerW >= 28 && rzerH >= 28, `${label}: hit area must be >= 28x28, got ${rzerW}x${rzerH}`);
		assert.ok(markW >= 12 && markH >= 12, `${label}: visual mark must be >= 12x12, got ${markW}x${markH}`);
		const ratio = contrastAgainstWhite(color, opacity);
		assert.ok(ratio >= 3.0, `${label}: resting grip contrast against #fff must be >= 3:1 (got ${ratio.toFixed(2)}:1 for ${color} @ opacity=${opacity})`);
	}
});
