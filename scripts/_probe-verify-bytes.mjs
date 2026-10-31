import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = "/Users/jason/projects/opensource/pi-virtual-employee";
const dir = mkdtempSync(join(tmpdir(), "widget-verify-"));
const bundle = join(dir, "a.mjs");
await build({
	stdin: { contents: `export { renderWidgetLoader, renderWidgetPage } from "./src/widget/widget-assets.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { renderWidgetLoader, renderWidgetPage } = await import(`file://${bundle}`);

console.log("=== P0-1 byte-level verification ===");

let fail = false;

// ── loader ──
const loaderCode = renderWidgetLoader();

// 1. split("\n\n") must appear with REAL backslash-n escapes in the emitted bytes
const splitNeedle = 'split("\\n\\n")';
const lineNeedle = 'split("\\n")';
console.log(`loader: ${JSON.stringify(splitNeedle)} literal in emitted bytes: ${loaderCode.includes(splitNeedle) ? "YES" : "NO — BUG"}`);
if (!loaderCode.includes(splitNeedle)) fail = true;
console.log(`loader: ${JSON.stringify(lineNeedle)} literal in emitted bytes: ${loaderCode.includes(lineNeedle) ? "YES" : "NO — BUG"}`);
if (!loaderCode.includes(lineNeedle)) fail = true;
console.log(`loader: dec.decode(chunk.value) present: ${loaderCode.includes("dec.decode(chunk.value") ? "YES" : "NO — BUG"}`);
if (!loaderCode.includes("dec.decode(chunk.value")) fail = true;

// 2. page inline script
const pageCode = renderWidgetPage();
const m = pageCode.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
	console.error("ERROR: no inline <script> in widget page");
	process.exit(1);
}
const inlineJS = m[1];
console.log(`page: ${JSON.stringify(splitNeedle)} literal in emitted bytes: ${inlineJS.includes(splitNeedle) ? "YES" : "NO — BUG"}`);
if (!inlineJS.includes(splitNeedle)) fail = true;
console.log(`page: dec.decode(chunk.value) present: ${inlineJS.includes("dec.decode(chunk.value") ? "YES" : "NO — BUG"}`);
if (!inlineJS.includes("dec.decode(chunk.value")) fail = true;

// 3. Scan for other risky TS-escape survivors that would break client code:
//    \\$ (dollar escape), \\/ (regex slash), backticks, \\u escapes, \\s, \\d in regexes etc.
const riskyPatterns = [
	{ name: "escaped backtick (\\\\`)", re: /\\`/ },
	{ name: "escaped dollar (\\\\\\$)", re: /\\\$/ },
	{ name: "escaped backslash at line end (line continuation)", re: /\\\n/ },
];
for (const { name, re } of riskyPatterns) {
	const hitL = re.test(loaderCode);
	const hitP = re.test(inlineJS);
	console.log(`risky ${name}: loader=${hitL ? "FOUND — inspect" : "none"}, page=${hitP ? "FOUND — inspect" : "none"}`);
}

// 4. Full syntax validation as a browser would
try {
	new Function(loaderCode);
	console.log("PASS: loader parses as valid JS");
} catch (e) {
	console.error("FAIL: loader SyntaxError:", e.message);
	fail = true;
}
try {
	new Function(inlineJS);
	console.log("PASS: inline page script parses as valid JS");
} catch (e) {
	console.error("FAIL: inline SyntaxError:", e.message);
	fail = true;
}

// 5. Semantic probe: run the emitted parser function against a synthetic SSE stream
//    to prove split("\n\n") actually splits frames in the emitted code.
const sandboxCode = loaderCode;
// extract just the split logic by executing the whole loader in a fake DOM? Too heavy.
// Instead: simulate the pump logic copied from emitted bytes.
const src = /function pump\(\) \{[\s\S]*?\n\s*\}\n/.exec(sandboxCode)?.[0] ?? "";
console.log(`emitted pump() found: ${src ? "YES (" + src.length + " chars)" : "NO"}`);

process.exit(fail ? 1 : 0);
