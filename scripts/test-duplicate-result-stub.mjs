/** Hermes ports (2026-11-06): duplicate-result stub + cumulative iteration budget.
 *
 * Stub: a poller returning an unchanged 4KB payload ten times costs 40KB of
 * context for one bit of information — from the 2nd byte-identical repeat the
 * payload becomes a reference (the tool still ran).
 *
 * Budget: maxToolSteps caps a SINGLE turn; a model that keeps finishing and
 * restarting turns runs unbounded (field: 203 LLM calls / 30 min). The
 * cumulative counter spans one user turn.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.hermes-port-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const bundle = join(dir, "h.mjs");
await build({
	stdin: { contents: `export { stubDuplicateResult } from "./src/engine/definition.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { stubDuplicateResult } = await import(pathToFileURL(bundle).href);

const BIG = "x".repeat(600);
const payload = (text) => ({ content: [{ type: "text", text }], details: { ok: true } });

test("the FIRST occurrence is delivered in full and remembered", () => {
	const r = stubDuplicateResult("manage_process", "call-1", { action: "log" }, payload(BIG), false);
	assert.equal(r.content[0].text, BIG, "first occurrence must not be stubbed — the model needs the content");
});

test("the SECOND byte-identical result becomes a reference naming the earlier call", () => {
	stubDuplicateResult("read_file", "first-id", { path: "/a" }, payload(BIG + "abc"), false); // seed
	const r = stubDuplicateResult("read_file", "second-id", { path: "/a" }, payload(BIG + "abc"), false);
	assert.notEqual(r.content[0].text, BIG + "abc", "duplicate must be replaced by a reference");
	assert.match(r.content[0].text, /逐字节相同/, "the stub must say the content is unchanged");
	assert.match(r.content[0].text, /first-id/, "it must name the earlier tool_call_id so the model can refer to it");
	assert.equal(r.content.length, 1, "one text block, same envelope shape");
});

test("changed content is NOT stubbed (a poll that moved on is progress)", () => {
	stubDuplicateResult("read_file", "a", { path: "/b" }, payload(BIG + "1"), false);
	const r = stubDuplicateResult("read_file", "b", { path: "/b" }, payload(BIG + "2"), false);
	assert.equal(r.content[0].text, BIG + "2", "different content must be delivered in full");
});

test("small payloads and refusals are never stubbed", () => {
	const small = stubDuplicateResult("x", "1", {}, payload("tiny"), false);
	stubDuplicateResult("y", "2", {}, payload("tiny"), false);
	const small2 = stubDuplicateResult("x", "3", {}, payload("tiny"), false);
	assert.equal(small2.content[0].text, "tiny", "below the 512-char threshold the payload is cheap — deliver it");

	const big1 = stubDuplicateResult("z", "4", {}, payload(BIG), false);
	const refused = stubDuplicateResult("z", "5", {}, payload(BIG), true);
	assert.equal(refused.content[0].text, BIG, "a refusal is actionable text, never a reference");
	void big1;
});

test("stub never breaks a non-text or multi-block result", () => {
	const multi = { content: [{ type: "text", text: BIG }, { type: "text", text: BIG }] };
	stubDuplicateResult("m", "1", {}, multi, false);
	const r = stubDuplicateResult("m", "2", {}, multi, false);
	assert.equal(r.content.length, 2, "multi-block results pass through untouched");
	const image = { content: [{ type: "image", data: "…" }] };
	assert.deepEqual(stubDuplicateResult("i", "1", {}, image, false), image);
});
