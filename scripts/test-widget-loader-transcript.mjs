/**
 * FLOATING loader channel — transcript behaviour (code review P1-2).
 *
 * The loader (renderWidgetLoader) carries its OWN copy of the transcript code
 * (~1100 chars, identical to the standalone page apart from two parameter
 * names). It had ZERO behavioural coverage: every transcript assertion drove
 * renderWidgetPage only, so the duplicated copy could rot silently and a
 * "fix both by hand" edit had no guard at all.
 *
 * This suite boots the REAL loader script against a stub shadow root and drives
 * the REAL send path, asserting the same four properties the page suite pins:
 * eager panel, above the answer, collapse at answer start, manual control wins.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "widget-loader-"));
const bundle = join(dir, "l.mjs");
await build({
	stdin: { contents: `export { renderWidgetLoader } from "./src/widget/widget-assets.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { renderWidgetLoader } = await import(pathToFileURL(bundle).href);

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parentNode = null;
		this.className = "";
		this.id = "";
		this._text = "";
		this._inner = "";
		this._classes = new Set();
		this.style = {};
		this._attrs = new Map();
		this._listeners = new Map();
		this.scrollTop = 0;
		this.scrollHeight = 0;
		this.classList = {
			add: (...c) => c.forEach((x) => this._classes.add(x)),
			remove: (...c) => c.forEach((x) => this._classes.delete(x)),
			toggle: (c, f) => {
				const want = f === undefined ? !this._classes.has(c) : f;
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
	get innerHTML() {
		return this._inner;
	}
	/** A real browser parses innerHTML into nodes; the stub does its own little version. */
	set innerHTML(v) {
		this._inner = String(v);
		this.children = [];
		const build1 = (tag, cls) => {
			const el = new El(tag);
			if (cls) el.className = cls;
			return el;
		};
		if (this._inner.includes('class="head"')) {
			const head = build1("div", "head");
			head.appendChild(build1("span", "t"));
			head.appendChild(build1("button"));
			this.appendChild(head);
			const body = build1("div", "body");
			body.appendChild(build1("div", "hero"));
			body.appendChild(build1("div", "chips"));
			body.appendChild(build1("div", "msgs"));
			this.appendChild(body);
			const foot = build1("div", "foot");
			foot.appendChild(build1("textarea", "box"));
			const row = build1("div", "sendrow");
			row.appendChild(build1("button", "send"));
			foot.appendChild(row);
			foot.appendChild(build1("div", "dis"));
			this.appendChild(foot);
		} else if (this._inner.includes('class="think"')) {
			// thinking note markup: <details class="think"><summary>…<span class="think-ticker"></span></summary><div class="think-b"></div></details>
			this.tagName = "DETAILS";
			this.className = "think";
			const summary = build1("summary");
			summary.appendChild(build1("span", "think-ticker"));
			this.appendChild(summary);
			this.appendChild(build1("div", "think-b"));
		}
	}
	appendChild(c) {
		c.parentNode = this;
		this.children.push(c);
		return c;
	}
	insertBefore(c, anchor) {
		const i = this.children.indexOf(anchor);
		if (i < 0) throw new Error("insertBefore: anchor is not a child");
		c.parentNode = this;
		this.children.splice(i, 0, c);
		return c;
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
	fire(type, ev = {}) {
		for (const fn of this._listeners.get(type) ?? []) fn(ev);
	}
	focus() {}
	getBoundingClientRect() {
		const w = Number.parseFloat(this.style.width) || 380;
		const h = Number.parseFloat(this.style.height) || 560;
		return { width: w, height: h, top: 0, left: 0, right: w, bottom: h };
	}
	setPointerCapture() {}
	releasePointerCapture() {}
	querySelector(sel) {
		let found = null;
		const walk = (n) => {
			for (const c of n.children) {
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
	querySelectorAll(sel) {
		const out = [];
		const walk = (n) => {
			for (const c of n.children) {
				if (matches(c, sel)) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}
}

function matches(el, sel) {
	const s = String(sel).trim();
	if (/\s/.test(s)) return matches(el, s.split(/\s+/).pop());
	// className assignment and classList are two views of the same thing in a
	// browser; the stub must agree or selectors silently miss innerHTML-built nodes.
	const has = (c) => el.classList.contains(c) || String(el.className ?? "").split(/\s+/).includes(c);
	if (s.startsWith(".")) return has(s.slice(1).split(".")[0]);
	const [tag, ...rest] = s.split(".");
	if (el.tagName !== tag.toUpperCase()) return false;
	return rest.every(has);
}

function sseBody(events, gaps = null) {
	const enc = (evs) => new TextEncoder().encode(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
	const segments = [];
	if (!gaps?.length) segments.push({ bytes: enc(events), gap: null });
	else {
		let prev = 0;
		for (const g of gaps) {
			segments.push({ bytes: enc(events.slice(prev, g.afterCount)), gap: g.fn });
			prev = g.afterCount;
		}
		segments.push({ bytes: enc(events.slice(prev)), gap: null });
	}
	let idx = 0;
	let pendingGap = null;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	return {
		getReader: () => ({
			async read() {
				if (pendingGap) {
					const g = pendingGap;
					pendingGap = null;
					await sleep(20);
					g();
					await sleep(20);
				}
				if (idx >= segments.length) return { done: true, value: undefined };
				const seg = segments[idx++];
				if (seg.gap) pendingGap = seg.gap;
				return { done: false, value: seg.bytes };
			},
		}),
	};
}

/** Boot the real loader script; returns the shadow root (panel lives inside). */
function bootLoader(events, gaps = null, opts = {}) {
	const code = renderWidgetLoader({ icon: "text", iconUrl: "", size: 52 });
	const shadow = new El("div");
	// The loader creates ONE plain div and immediately calls attachShadow on it;
	// the panel is also a div, so "the first div is the host" is wrong. Instead
	// every created div gets attachShadow, and whichever one is asked for a root
	// becomes the host.
	let host = null;
	const makeDiv = () => {
		const el = new El("div");
		el.attachShadow = () => {
			host = el;
			return shadow;
		};
		return el;
	};
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const doc = {
		currentScript: null,
		createElement: (tag) => (tag === "div" ? makeDiv() : new El(tag)),
		createTextNode: (t) => ({ textContent: String(t) }),
		getElementById: () => new El("div"),
		addEventListener() {},
		body: new El("body"),
		documentElement: new El("html"),
	};
	doc.body.appendChild = (c) => {
		c.parentNode = doc.body;
		doc.body.children.push(c);
		return c;
	};
	const scriptEl = new El("script");
	const attrs = new Map([["data-ticket", "test-ticket"], ["data-token", ""], ["data-user", "u"], ["data-title", ""]]);
	scriptEl.getAttribute = (k) => attrs.get(k) ?? null;
	scriptEl.src = "http://localhost/widget.js";
	const win = {
		addEventListener() {},
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		innerWidth: 1280,
		innerHeight: 900,
		localStorage,
	};
	const sandbox = {
		document: { ...doc, currentScript: scriptEl },
		window: win,
		localStorage,
		innerWidth: 1280,
		innerHeight: 900,
		fetch: opts.hang ? () => new Promise(() => {}) : async () => ({
			ok: true,
			status: 200,
			headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/event-stream" : null) },
			body: sseBody(events, gaps),
			json: async () => ({}),
		}),
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
	const panel = shadow.querySelector(".panel");
	return { shadow, panel, send: win.__veWidgetSend };
}

test("loader: the transcript code is actually reachable (guard)", () => {
	const { panel, send } = bootLoader([]);
	assert.ok(panel, "浮窗通道必须渲染出 .panel（否则本套件测的不是真代码）");
	assert.ok(typeof send === "function", "浮窗必须暴露 send 钩子供驱动");
});

test("loader: thinking note exists BEFORE any event, ABOVE the answer", async () => {
	// fetch never resolves: the note must already be in the DOM, i.e. created at
	// send() rather than by the first thinking event (user: 最早出现).
	const { panel, send } = bootLoader([], null, { hang: true });
	send("你好");
	const msgs = panel.querySelector(".msgs");
	const kinds = msgs.children.map((c) => String(c.className));
	const thinkIdx = kinds.findIndex((c) => c.includes("think"));
	const answerIdx = kinds.findIndex((c) => c.includes("ai"));
	assert.ok(thinkIdx >= 0, "浮窗通道：面板必须在发送瞬间就存在（不等第一条思考事件）");
	assert.ok(answerIdx >= 0, "浮窗通道必须渲染回答气泡");
	assert.ok(thinkIdx < answerIdx, `浮窗通道：思考必须在答文上方（think=${thinkIdx}, answer=${answerIdx}）`);
	assert.equal(msgs.children[thinkIdx].hasAttribute("open"), true, "思考中默认展开");
});

test("loader: collapse happens when the ANSWER starts, not only at done", async () => {
	let seen = null;
	const { panel, send } = bootLoader(
		[
			{ type: "thinking_delta", text: "想想" },
			{ type: "delta", text: "答案" },
			{ type: "done" },
		],
		[
			{
				afterCount: 2,
				fn: () => {
					const msgs = panel.querySelector(".msgs");
					const wrap = msgs.children.find((c) => String(c.className).includes("think"));
					seen = { open: wrap?.hasAttribute("open"), title: String(wrap?._veTitle?.textContent) };
				},
			},
		],
	);
	await send("你好");
	for (let i = 0; i < 100 && seen === null; i++) await new Promise((r) => setTimeout(r, 20));
	assert.ok(seen, "观察点必须触发");
	assert.equal(seen.open, false, "答文开始时浮窗通道也必须收起");
	assert.match(seen.title, /思考 · 用时 \d+ 秒/, "完成态标题");
});

test("loader: manual control wins — later deltas do not re-close an opened note", async () => {
	let openLater = null;
	const { panel, send } = bootLoader(
		[
			{ type: "thinking_delta", text: "想想" },
			{ type: "delta", text: "答一" },
			{ type: "delta", text: "答二" },
			{ type: "done" },
		],
		[
			{
				afterCount: 2,
				fn: () => {
					const msgs = panel.querySelector(".msgs");
					const wrap = msgs.children.find((c) => String(c.className).includes("think"));
					assert.equal(wrap.hasAttribute("open"), false, "答文开始已自动收起");
					wrap.setAttribute("open", "open"); // 用户手动点开
				},
			},
			{
				afterCount: 4,
				fn: () => {
					const msgs = panel.querySelector(".msgs");
					const wrap = msgs.children.find((c) => String(c.className).includes("think"));
					openLater = wrap.hasAttribute("open");
				},
			},
		],
	);
	await send("你好");
	for (let i = 0; i < 100 && openLater === null; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(openLater, true, "浮窗通道：用户手动展开后不得被后续 delta 关掉");
});

test("loader: a never-thinking model leaves no empty note (mid-turn and final)", async () => {
	let midTurn = null;
	const { panel, send } = bootLoader(
		[
			{ type: "delta", text: "直接答" },
			{ type: "delta", text: "继续" },
			{ type: "done" },
		],
		[
			{
				afterCount: 1,
				fn: () => {
					const msgs = panel.querySelector(".msgs");
					midTurn = msgs.children.filter((c) => String(c.className).includes("think")).length;
				},
			},
		],
	);
	await send("你好");
	for (let i = 0; i < 100 && midTurn === null; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(midTurn, 0, "浮窗通道：答文开始时不得留下空思考面板");
});

test("loader: tool steps render ABOVE answer bubble and empty cursor bubble is hidden mid-process", async () => {
	let midTools = null;
	const { panel, send } = bootLoader(
		[
			{ type: "thinking_delta", text: "先查一下" },
			{ type: "tool_start", toolName: "search_knowledge_base", toolCallId: "t1" },
			{ type: "tool_end", toolCallId: "t1", isError: false, durationMs: 30 },
			{ type: "delta", text: "核验完成。" },
			{ type: "done" },
		],
		[
			{
				afterCount: 2, // thinking_delta + tool_start
				fn: () => {
					const msgs = panel.querySelector(".msgs");
					const kinds = msgs.children.map((c) => String(c.className));
					const thinkIdx = kinds.findIndex((c) => c.includes("think"));
					const stepIdx = kinds.findIndex((c) => c.includes("step"));
					const answerIdx = kinds.findIndex((c) => c.includes("ai"));
					const box = msgs.children[answerIdx];
					midTools = { thinkIdx, stepIdx, answerIdx, boxHidden: box ? box.classList.contains("hidden") : false };
				},
			},
		],
	);
	await send("查一下");
	for (let i = 0; i < 100 && midTools === null; i++) await new Promise((r) => setTimeout(r, 20));
	assert.ok(midTools, "观察点必须触发");
	assert.ok(midTools.thinkIdx < midTools.stepIdx, "浮窗：思考在工具上方");
	assert.ok(midTools.stepIdx < midTools.answerIdx, `浮窗：工具必须在答文上方 (step=${midTools.stepIdx}, answer=${midTools.answerIdx})`);
	assert.equal(midTools.boxHidden, true, "浮窗：过程运行且无正文时隐藏空气泡光标");

	await new Promise((r) => setTimeout(r, 50));
	const msgs = panel.querySelector(".msgs");
	const finalKinds = msgs.children.map((c) => String(c.className));
	const stepIdx = finalKinds.findIndex((c) => c.includes("step"));
	const answerIdx = finalKinds.findIndex((c) => c.includes("ai"));
	const finalBox = msgs.children[answerIdx];
	assert.ok(stepIdx < answerIdx, "浮窗：最终答文在所有工具步骤最下方");
	assert.equal(finalBox.classList.contains("hidden"), false, "浮窗：最终答文可见");
	assert.equal(finalBox.textContent, "核验完成。");
});
