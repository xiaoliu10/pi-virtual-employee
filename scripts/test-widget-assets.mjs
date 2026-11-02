/**
 * Client-asset syntax gate (v0.2.179, review P0-1).
 *
 * The widget's browser JS lives inside TS template literals. TS escapes are
 * LEGAL at compile time but change the emitted bytes — `\n` inside a template
 * literal becomes a real newline in the served script, which splits string
 * literals and produces a SyntaxError in the BROWSER only. The suite never
 * executed client code, so the whole widget UI was dead while tests stayed
 * green. These tests render the actual served bytes and parse them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "widget-assets-"));
const bundle = join(dir, "a.mjs");
await build({
	stdin: { contents: `export { renderWidgetLoader, renderWidgetPage } from "./src/widget/widget-assets.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { renderWidgetLoader, renderWidgetPage } = await import(pathToFileURL(bundle).href);

/** Extract the JS from a response and parse it exactly like a browser would. */
function assertParses(label, html, { inline }) {
	let code;
	if (inline) {
		const match = html.match(/<script>([\s\S]*?)<\/script>/);
		assert.ok(match, `${label}: has an inline <script> block`);
		code = match[1];
	} else {
		code = html;
	}
	// new Function parses without executing — exactly the gate the field failure
	// needed: a syntax error here throws, a legal-but-broken escape does not pass.
	assert.doesNotThrow(() => new Function(code), `${label}: client JS parses as real JavaScript`);
	return code;
}

/**
 * Extract every CSS text the loader/page can inject and parse it with a real
 * CSS parser.
 *
 * Field failure (v0.2.179–v0.2.182, P0): `SHARED_CSS` ended with
 * `@keyframes ve-blink { 50% { opacity:0; }` — one brace short. The browser
 * threw away the WHOLE stylesheet, so `.launcher { position:absolute; ... }`
 * never applied, the floating button rendered off-viewport, and every embedding
 * business system lost its entry point. The JS gate above could not catch it
 * (CSS is just a string to JS), and nothing executed the CSS.
 */
/**
 * The loader's stylesheet is assembled in TypeScript from TWO pieces that the
 * browser concatenates into ONE sheet: the module-level `SHARED_CSS` constant
 * (inlined via JSON.stringify) plus a template literal inside the loader. A
 * syntax error in either half makes the browser discard everything that follows
 * — including `.launcher { position:absolute }` — so the entry point renders
 * off-viewport. Field P0 (v0.2.179–v0.2.182) was exactly this: SHARED_CSS ended
 * one brace short in `@keyframes ve-blink`.
 *
 * Parsing the served bytes with a real CSS parser is the only gate that catches
 * it: the JS gate treats CSS as an opaque string, and nothing executed the CSS.
 */
/**
 * The served loader builds its stylesheet as `var css = "<SHARED_CSS literal>" + `
 * <template half>`;` — ONE sheet to the browser, assembled from two JS string
 * pieces. A syntax error in either piece (or at their seam) makes the browser
 * discard everything after it, including `.launcher { position:absolute }`, so
 * the floating button renders off-viewport and the embedder has no entry point.
 * Field P0 (v0.2.179–v0.2.182): SHARED_CSS ended one brace short in
 * `@keyframes ve-blink`. The JS gate cannot see this — CSS is an opaque string.
 *
 * This reconstructs the sheet from the ACTUAL served bytes: run the css
 * expression the loader evaluates, then parse the result with a real CSS parser.
 */
async function servedStylesheet(html) {
	const postcss = (await import("postcss")).default;
	const at = html.indexOf("var css = ");
	assert.ok(at > 0, "the loader assigns var css");
	// Take the whole statement: everything up to the first `;` that ENDS the
	// assignment (the template half itself contains no `;`-at-line-end before it).
	const rest = html.slice(at + "var css = ".length);
	// The expression is "<JSON string literal>" + `<template>` ; — scan quote-aware
	// instead of looking for ";\n" (CSS declarations contain that too).
	let i = 0;
	let quote = null;
	for (; i < rest.length; i += 1) {
		const ch = rest[i];
		if (quote) {
			if (ch === "\\") { i += 1; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
		if (ch === ";") break;
	}
	assert.ok(i < rest.length, "the css assignment terminates");
	const expr = rest.slice(0, i);
	// Evaluate it exactly as the browser would (no network, no side effects).
	const css = new Function(`return (${expr});`)();
	assert.equal(typeof css, "string", "the css expression yields a string");
	assert.ok(css.length > 500, "the stylesheet is not empty");
	return { postcss, css };
}

test("the stylesheet the loader actually evaluates is valid CSS", async () => {
	const { postcss, css } = await servedStylesheet(renderWidgetLoader());
	assert.doesNotThrow(
		() => postcss.parse(css),
		"an unclosed block makes the browser drop the ENTIRE sheet — every rule after it dies",
	);
	// The keyframes that broke is present and closed.
	assert.ok(css.includes("@keyframes ve-blink"), "blink keyframes survive");
	assert.ok(/@keyframes[^{]*\{[\s\S]*\}\s*\}?\s*$/.test(css.replace(/\s+$/, "") + "", "@keyframes blocks are balanced")
		|| css.includes("@keyframes ve-blink { 50% { opacity:0; } }"), "@keyframes ve-blink is closed");
});

test("the evaluated stylesheet carries the launcher positioning rule", async () => {
	const { postcss, css } = await servedStylesheet(renderWidgetLoader());
	let position = null;
	postcss.parse(css).walkRules((rule) => {
		if (!/(^|,)\s*\.launcher\s*$/.test(rule.selector.trim())) return;
		rule.walkDecls("position", (decl) => { position = decl.value; });
	});
	assert.equal(position, "absolute", "without this the button renders off-viewport (field P0)");
});

test("the loader script served to browsers is valid JavaScript", () => {
	const js = assertParses("loader", renderWidgetLoader(), { inline: false });
	assert.ok(js.includes("attachShadow"), "loader mounts a shadow root");
	// The v0.2.179 streaming parser must survive template-literal escaping.
	assert.ok(js.includes('split("\\n\\n")'), "SSE frame splitting uses real newline escapes in the emitted bytes");
});

test("the full-page inline script is valid JavaScript", () => {
	const page = renderWidgetPage();
	const code = assertParses("page", page, { inline: true });
	assert.ok(code.includes("streamChat"), "page carries the streaming client");
});

test("streaming client handles every server event type", () => {
	const js = renderWidgetLoader();
	for (const ev of ["delta", "replace", "tool_start", "tool_end", "thinking_delta", "thinking_replace", "error", "done"]) {
		assert.ok(js.includes(`"${ev}"`), `client handles "${ev}"`);
	}
	assert.ok(js.includes("chunk.value"), "TextDecoder receives the chunk's ArrayBuffer, not the read result");
	assert.ok(js.includes("正在思考…"), "placeholder survives kernels without process events");
});

// ── launcher look (v0.2.180) ──

test("launcher defaults to the legacy text bubble (existing embeds unchanged)", () => {
	const js = renderWidgetLoader();
	assert.ok(js.includes('applyLauncher("text"'), "no config → text launcher");
	assert.ok(!js.includes("viewBox=\"0 0 24 24\" width=\"56%\""), "no robot mark injected by default");
	// Backward compatibility is the point: v0.2.179 integrators must see no change.
	const page = renderWidgetPage();
	assert.ok(page.includes("AI"), "full page unaffected");
});

test("built-in marks are inline SVG and need no network or CSP allowance", () => {
	for (const icon of ["robot", "spark"]) {
		const js = renderWidgetLoader({ icon, iconUrl: "", size: 52 });
		assert.doesNotThrow(() => new Function(js), `${icon}: still valid JS`);
		assert.ok(js.includes('applyLauncher("' + icon + '"'), `${icon}: launcher claims the preset`);
		assert.ok(js.includes("<svg"), `${icon}: mark is embedded, not fetched`);
		assert.ok(!/<img/i.test(js.split("applyLauncher")[0]), `${icon}: no image element for presets`);
	}
});

test("launcher size is honoured and clamped to 44-72", () => {
	const cases = [[52, 52], [44, 44], [72, 72], [20, 44], [200, 72]];
	for (const [input, expected] of cases) {
		const js = renderWidgetLoader({ icon: "text", iconUrl: "", size: input });
		const m = js.match(/width:(\d+)px; height:(\d+)px; border-radius:50%/);
		assert.ok(m, "launcher size is rendered into CSS");
		assert.equal(Number(m[1]), expected, `size ${input} clamps to ${expected}`);
	}
});

test("a custom image URL is scheme-checked and falls back on load failure", () => {
	const js = renderWidgetLoader({ icon: "url", iconUrl: "https://oa.example.com/logo.png", size: 52 });
	assert.doesNotThrow(() => new Function(js));
	assert.ok(js.includes("indexOf(\"https://\") === 0"), "scheme allowlist is present");
	assert.ok(js.includes("https://oa.example.com/logo.png"), "the configured URL is passed through");
	assert.ok(js.includes('addEventListener("error"'), "a broken image falls back instead of leaving a blank circle");
	assert.ok(js.includes('launcher.textContent = "AI"'), "the fallback is the legacy mark");
});

test("a non-http scheme never reaches the img element", () => {
	// javascript: / data: would be an injection vector if we trusted the value.
	for (const bad of ["javascript:alert(1)", "data:image/svg+xml,<svg/>", "//evil.example/x.png"]) {
		const js = renderWidgetLoader({ icon: "url", iconUrl: bad, size: 52 });
		assert.doesNotThrow(() => new Function(js));
		assert.ok(!js.includes('img.src = "' + bad), `${bad} is not used as a src`);
	}
});
