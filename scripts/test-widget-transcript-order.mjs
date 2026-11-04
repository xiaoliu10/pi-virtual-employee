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
	setAttribute() {}
	getAttribute() {
		return null;
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

/** SSE body read with getReader() — exactly the shape the client consumes.
 *  splitBefore: index at which the second read() resolves, so a test can
 *  observe the DOM mid-stream (streaming state before `done`). */
function sseBody(events, onGap) {
	const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
	const bytes = new TextEncoder().encode(text);
	const first = onGap
		? new TextEncoder().encode(`data: ${JSON.stringify(events[0])}\n\n`)
		: bytes;
	const rest = onGap ? bytes.slice(first.length) : null;
	let reads = 0;
	return {
		getReader() {
			return {
				async read() {
					if (rest) {
						// Chunked mode: first read delivers the thinking event; second
						// read pauses in a gap (the test observes the live DOM), then
						// delivers the rest; done afterwards.
						if (reads === 0) {
							reads += 1;
							return { done: false, value: first };
						}
						if (reads === 1) {
							reads += 1;
							await new Promise((r) => setTimeout(r, 30));
							if (onGap) onGap();
							await new Promise((r) => setTimeout(r, 30));
							return { done: false, value: rest };
						}
						return { done: true, value: undefined };
					}
					if (reads >= 1) return { done: true, value: undefined };
					reads += 1;
					return { done: false, value: bytes };
				},
			};
		},
	};
}

/**
 * Boot the REAL page script (renderWidgetPage) with the stub DOM and return
 * its transcript plus the exposed send hook.
 */
function bootPage(pageHtml, events, onMidStream) {
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
		fetch: async () => ({
			ok: true,
			status: 200,
			headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/event-stream" : null) },
			body: sseBody(events, onMidStream),
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
	const body = wrap.children[1];
	assert.equal(wrap.classList.contains("on"), false, "完成后不能停留在流式态");
	assert.equal(body.classList.contains("hidden"), true, "完成后思考正文必须收起，结论直接可见");
	assert.match(String(wrap._veTitle.textContent), /思考过程/, "完成态标题从「正在思考」切换为摘要");
	assert.match(String(wrap._veTitle.textContent), /字/, "显示思考字数");
});

test("DURING streaming the panel is live (title=正在思考); answer bubble stays empty until its text arrives", async () => {
	const events = [
		{ type: "thinking_delta", text: "思考内容持续推入" },
		{ type: "text_delta", text: "最终答案" },
		{ type: "done" },
	];
	const html = renderWidgetPage({ title: "t", suggestions: [], disclaimer: "" });
	let seen = null;
	const { transcript, send } = bootPage(html, events, () => {
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
			bodyHidden: wrap ? wrap.children[1].classList.contains("hidden") : true,
		};
	});
	assert.ok(typeof send === "function");
	await send("你好");
	await new Promise((r) => setTimeout(r, 60));

	assert.ok(seen, "the mid-stream hook must have fired");
	assert.ok(seen.thinkIdx >= 0, "thinking panel exists mid-stream");
	assert.ok(seen.thinkIdx < seen.answerIdx, "mid-stream order: thinking ABOVE answer");
	assert.equal(seen.on, true, "mid-stream panel must be in live state");
	assert.match(seen.title, /正在思考/, "mid-stream title is 正在思考");
	assert.equal(seen.bodyHidden, false, "Desktop keeps the body readable while streaming (expanded)");
});
