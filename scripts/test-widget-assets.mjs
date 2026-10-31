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
