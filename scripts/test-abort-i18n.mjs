import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();
const dir = mkdtempSync(join(root, "node_modules/.abort-i18n-"));
const bundle = join(dir, "a.mjs");
await build({
	stdin: { contents: `export { describeAbortReason, isEngineAbortText, engineAbortFailureText } from "./src/engine/engine.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
});
const { describeAbortReason, isEngineAbortText, engineAbortFailureText } = await import(pathToFileURL(bundle).href);

console.log("== every engine-initiated abort kind maps to Chinese ==");
for (const kind of ["runaway", "watchdog", "user", "restart", "install_now"]) {
	const d = describeAbortReason(kind);
	assert.ok(d && !/[a-zA-Z]{4,}/.test(d), `${kind} must map to Chinese, got: ${d}`);
}
assert.match(describeAbortReason("runaway"), /看门狗/);
assert.match(describeAbortReason("runaway"), /已主动停止/);
assert.equal(describeAbortReason("unknown-kind"), undefined, "unknown kinds pass the raw error through");

console.log("\nPASS");

console.log("== the narrow SDK signature (review #3) ==");
assert.ok(isEngineAbortText("This operation was aborted"), "the exact SDK wording matches");
assert.ok(isEngineAbortText("AbortError: connection reset"), "AbortError name matches");
assert.equal(isEngineAbortText("request aborted by upstream"), false, "relay flake is NOT an engine abort");
assert.equal(isEngineAbortText("content length exceeded"), false);

console.log("== the pushed abort text is pure Chinese with a resume hint (review #2) ==");
const text = engineAbortFailureText();
assert.match(text, /被看门狗主动停止/);
assert.match(text, /回复「继续」/);
assert.ok(!/[a-zA-Z]{4,}/.test(text), `no English leaks: ${text}`);

console.log("== read-before-delete ordering is pinned (review #2) ==");
// The abortReason read MUST precede recordTurnTelemetry (which deletes the
// marker); a silent reorder would regress to silence-as-success. Source-shape
// assertion, same family as test-mcp-durable-visibility.
import { readFileSync } from "node:fs";
const src = readFileSync(join(root, "src/engine/engine.ts"), "utf8");
const readAt = src.indexOf("const abortReason = this.turnAborts.get(conversationId);");
const telemetryAt = src.indexOf("this.recordTurnTelemetry({", readAt);
assert.ok(readAt >= 0 && telemetryAt > readAt, "abortReason read must come before recordTurnTelemetry");
const deleteAt = src.indexOf("this.turnAborts.delete(conversationId);");
assert.ok(deleteAt > telemetryAt, "the delete lives inside telemetry, after the read");

console.log("\nPASS (extended)");
