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
import { mkdtempSync } from "node:fs";
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
