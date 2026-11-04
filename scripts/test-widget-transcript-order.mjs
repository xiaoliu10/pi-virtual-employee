/**
 * Widget transcript ORDER + Desktop-style thinking note.
 *
 * Field 2026-11-04 (user report, twice): the card showed the result first with
 * the "thinking" panel BELOW it, wrapped in a boxy card — "思考内容应该在结果的
 * 上面…抄一下 desktop". Two defects:
 *   1. ORDER: the panel was appended to the transcript while the answer bubble
 *      was already there, so it landed AFTER the answer.
 *   2. SHAPE: a bordered mini-card. Desktop (pi-execution__note) renders a
 *      summary line ("正在思考" + a scrolling tail ticker while streaming) with
 *      the body as a left-rule indented block, collapsed when done.
 *
 * This suite executes the REAL served page script (renderWidgetPage) against a
 * stub DOM and its REAL transport (fetch → ReadableStream of SSE frames), then
 * asserts the actual DOM. Grep-based assertions would pass with the wrong
 * anchor or shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "widget-order-"));
const bundle = join(dir, "a.mjs");
await build({
	stdin: { contents: `export { renderWidgetPage } from "./src/widget/widget-assets.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { renderWidgetPage } = await import(pathToFileURL(bundle).href);

/** Minimal DOM node: enough for the page's transcript building, no layout. */
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
		this.scrollTop = 0;
		this.scrollHeight = 0;
		this.innerHTML = "";
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
	appendChild(child) {
		child.parentNode = this;
		this.children.push(child);
		return child;
	}
	insertBefore(child, anchor) {
		const i = this.children.indexOf(anchor);
		if (i < 0) throw new Error("insertBefore: anchor is not a child");
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
	_attrs = new Map();
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
	addEventListener() {}
	focus() {}
	querySelector() {
		return new El("div");
	}
	querySelectorAll() {
		return [];
	}
}

/** SSE body read with getReader().
 *  gaps: [{ afterCount, fn }] — the stream is split into chunks after each
 *  afterCount-cumulative event, pausing in a gap so the test can observe the
 *  mid-stream DOM at MULTIPLE points (e.g. collapse at answer start, then
 *  re-open when thinking resumes). */
function sseBody(events, gaps = null) {
	const enc = (evs) => new TextEncoder().encode(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
	const segments = [];
	if (!gaps || !gaps.length) {
		segments.push({ bytes: enc(events), gap: null });
	} else {
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
		getReader() {
			return {
				async read() {
					// 上一块的观察点必须在「客户端已消费该块」之后执行：放到下一次 read 开头
					if (pendingGap) {
						const g = pendingGap;
						pendingGap = null;
						await sleep(25);
						g();
						await sleep(25);
					}
					if (idx >= segments.length) return { done: true, value: undefined };
					const seg = segments[idx++];
					if (seg.gap) pendingGap = seg.gap;
					return { done: false, value: seg.bytes };
				},
			};
		},
	};
}

/**
 * Boot the REAL page script (renderWidgetPage) with the stub DOM and return
 * its transcript plus the exposed send hook.
 */
function bootPage(pageHtml, events, hooks = null, opts = {}) {
	const code = pageHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
	const transcript = new El("div");
	transcript.className = "msgs";
	transcript.id = "msgs";
	const body = new El("div");
	body.id = "body";

	const byId = new Map([
		["msgs", transcript],
		["body", body],
		["t", new El("span")],
		["hero", new El("div")],
		["chips", new El("div")],
		["dis", new El("div")],
		["box", new El("textarea")],
		["send", new El("button")],
	]);
	// el("hero").innerHTML = "" assignment must not throw.
	for (const el of byId.values()) {
		let inner = "";
		Object.defineProperty(el, "innerHTML", {
			get: () => inner,
			set: (v) => {
				inner = String(v);
				el.children = [];
			},
		});
	}

	const scriptEl = new El("script");
	const attrs = new Map([["data-ticket", "test-ticket"], ["data-token", ""], ["data-user", "u"], ["data-title", ""]]);
	scriptEl.getAttribute = (k) => attrs.get(k) ?? null;

	const doc = {
		currentScript: scriptEl,
		createElement: (tag) => new El(tag),
		createTextNode: (text) => ({ textContent: String(text) }),
		getElementById: (id) => byId.get(id) ?? new El("div"),
		addEventListener() {},
		body: new El("body"),
	};
	const sandbox = {
		document: doc,
		window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1280 },
		fetch: opts.hang ? () => new Promise(() => {}) : async () => ({
			ok: true,
			status: 200,
			headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/event-stream" : null) },
			body: sseBody(events, hooks),
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
		location: { href: "http://localhost/", search: "?ticket=test-ticket&user=u", hash: "" },
		URLSearchParams,
	};
	const fn = new Function(...Object.keys(sandbox), code);
	fn(...Object.values(sandbox));
	return { transcript, send: sandbox.window.__veWidgetSend };
}

test("the served widget page still parses (guard: this suite drives real code)", () => {
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	assert.ok(/<script>[\s\S]*<\/script>/.test(html));
});

test("thinking panel renders ABOVE the answer, Desktop-style summary line, collapses when done", async () => {
	const events = [
		{ type: "thinking_delta", text: "先确认参数，再调用工具" },
		{ type: "thinking_delta", text: "，然后汇总结果" },
		{ type: "text_delta", text: "结果是 42" },
		{ type: "done" },
	];
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	const { transcript, send } = bootPage(html, events);

	assert.ok(typeof send === "function", "the page must expose its send hook for driving a turn");
	await send("你好");
	await new Promise((r) => setTimeout(r, 50));

	const kinds = transcript.children.map((c) => String(c.className));
	const thinkIdx = kinds.findIndex((c) => c.includes("think"));
	const answerIdx = kinds.findIndex((c) => c.includes("ai"));
	assert.ok(thinkIdx >= 0, "the turn must render a thinking panel");
	assert.ok(answerIdx >= 0, "the turn must render an answer bubble");
	assert.ok(thinkIdx < answerIdx, `思考必须在结果上方（think=${thinkIdx}, answer=${answerIdx}）——现场报障正是相反`);

	const wrap = transcript.children[thinkIdx];
	assert.equal(wrap.classList.contains("on"), false, "完成后不能停留在流式态");
	assert.equal(wrap.hasAttribute("open"), false, "完成后 details 必须收起，结论直接可见");
	assert.match(String(wrap._veTitle.textContent), /思考 · 用时 \d+ 秒/, "完成态标题 = Desktop 的用时格式");
});

test("DURING streaming the panel is live (title=正在思考); answer bubble stays empty until its text arrives", async () => {
	const events = [
		{ type: "thinking_delta", text: "思考内容持续推入" },
		{ type: "text_delta", text: "最终答案" },
		{ type: "done" },
	];
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	let seen = null;
	const { transcript, send } = bootPage(html, events, [
		{
			afterCount: 1,
			fn: () => {
				// mid-stream: thinking panel exists, in live state, sitting ABOVE the answer
				const kinds = transcript.children.map((c) => String(c.className));
				const thinkIdx = kinds.findIndex((c) => c.includes("think"));
				const answerIdx = kinds.findIndex((c) => c.includes("ai"));
				const wrap = transcript.children[thinkIdx];
				seen = {
					thinkIdx,
					answerIdx,
					title: String(wrap?._veTitle?.textContent ?? ""),
					on: wrap ? wrap.classList.contains("on") : false,
					open: wrap ? wrap.hasAttribute("open") : false,
					tickerLen: wrap ? String(wrap._veTicker?.textContent ?? "").length : 0,
				};
			},
		},
	]);
	assert.ok(typeof send === "function");
	await send("你好");
	await new Promise((r) => setTimeout(r, 60));

	assert.ok(seen, "the mid-stream hook must have fired");
	assert.ok(seen.thinkIdx >= 0, "thinking panel exists mid-stream");
	assert.ok(seen.thinkIdx < seen.answerIdx, "mid-stream order: thinking ABOVE answer");
	assert.equal(seen.on, true, "mid-stream panel must be in live state");
	assert.equal(seen.open, true, "Desktop keeps the note expanded while streaming");
	assert.match(seen.title, /正在思考/, "mid-stream title is 正在思考");
	assert.ok(seen.tickerLen > 0, "the tail ticker must carry the streaming text");
});

test("THE PANEL APPEARS BEFORE ANY EVENT: eager at send, above the answer", () => {
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	// fetch 永不 resolve：若面板在发送瞬间建立，此刻 DOM 已有它——与任何事件无关
	const { transcript, send } = bootPage(html, [], undefined, { hang: true });
	send("你好");
	const kinds = transcript.children.map((c) => String(c.className));
	const thinkIdx = kinds.findIndex((c) => c.includes("think"));
	const answerIdx = kinds.findIndex((c) => c.includes("ai"));
	assert.ok(thinkIdx >= 0, "面板必须在发送瞬间就存在（不等第一条思考事件）");
	assert.ok(answerIdx >= 0);
	assert.ok(thinkIdx < answerIdx, "且在回答气泡之上");
	assert.equal(transcript.children[thinkIdx].hasAttribute("open"), true, "思考中默认展开");
});

test("collapse happens when the ANSWER text starts, not only at done", async () => {
	const events = [
		{ type: "thinking_delta", text: "思考中" },
		{ type: "delta", text: "答案出来了" },
		{ type: "done" },
	];
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	let seen = null;
	// 分块点在第 2 个事件后：观察点在 done 之前——若实现只在 done 收起，这里仍是展开态
	const { transcript, send } = bootPage(html, events, [
		{
			afterCount: 2,
			fn: () => {
				const kinds = transcript.children.map((c) => String(c.className));
				const wrap = transcript.children[kinds.findIndex((c) => c.includes("think"))];
				seen = { open: wrap.hasAttribute("open"), title: String(wrap._veTitle.textContent) };
			},
		},
	]);
	await send("你好");
	await new Promise((r) => setTimeout(r, 80));
	assert.ok(seen, "gap 必须在 done 前触发");
	assert.equal(seen.open, false, "答文开始时面板必须已收起（不等 done）");
	assert.match(seen.title, /思考 · 用时 \d+ 秒/, "标题已切到用时");
});

test("thinking body is light-gray faded", () => {
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	assert.ok(/\.think-b \{[^}]*color:#a9a9ae/.test(html), "正文必须浅灰（#a9a9ae）");
	assert.ok(/\.think-b \{[^}]*filter:blur\(\.3px\)/.test(html), "正文必须虚化（极轻 blur）");
});

test("a model that NEVER thinks leaves no empty panel behind", async () => {
	const events = [{ type: "delta", text: "直接回答" }, { type: "done" }];
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	const { transcript, send } = bootPage(html, events);
	await send("你好");
	await new Promise((r) => setTimeout(r, 60));
	const kinds = transcript.children.map((c) => String(c.className));
	assert.equal(kinds.findIndex((c) => c.includes("think")), -1, "空思考面板必须被移除");
	assert.ok(kinds.some((c) => c.includes("ai")));
});

test("thinking RESUMING after the answer re-expands the note (思考的时候展开)", async () => {
	const events = [
		{ type: "thinking_delta", text: "第一段思考" },
		{ type: "delta", text: "答案" },
		{ type: "thinking_delta", text: "又想到一点" },
		{ type: "done" },
	];
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	const obs = [];
	const { transcript, send } = bootPage(html, events, [
		{
			afterCount: 2,
			fn: () => {
				const kinds = transcript.children.map((c) => String(c.className));
				const wrap = transcript.children[kinds.findIndex((c) => c.includes("think"))];
				obs.push({
					open: wrap.hasAttribute("open"),
					title: String(wrap._veTitle.textContent),
					on: wrap.classList.contains("on"),
				});
			},
		},
		{
			afterCount: 3,
			fn: () => {
				const kinds = transcript.children.map((c) => String(c.className));
				const wrap = transcript.children[kinds.findIndex((c) => c.includes("think"))];
				obs.push({
					open: wrap.hasAttribute("open"),
					title: String(wrap._veTitle.textContent),
					on: wrap.classList.contains("on"),
				});
			},
		},
	]);
	await send("你好");
	// 读流是异步的：等两个观察点都触发（最多 2s），不靠猜 sleep 时长
	for (let i = 0; i < 100 && obs.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(obs.length, 2, "两个观察点都要触发");
	assert.equal(obs[0].open, false, "答文开始 → 收起");
	assert.equal(obs[1].open, true, "思考恢复 → 重新展开");
	assert.match(obs[1].title, /正在思考/, "恢复后标题回到进行中");
	assert.equal(obs[1].on, true, "恢复后处于流式态");
});
