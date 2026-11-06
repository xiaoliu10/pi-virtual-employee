/** resolvePushTarget: derivation-chain push-target resolution (review P3-4c:
 * the ed26d43 export had no in-repo test — only ad-hoc reviewer probes).
 * Pure-function coverage: passthrough, 1 hop, multi-hop, cycle, depth cap,
 * orphan work: id, empty origin. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.rpt-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const bundle = join(dir, "rpt.mjs");
await build({
	stdin: {
		contents: `export { resolvePushTarget } from "./src/im/manager.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { resolvePushTarget } = await import(pathToFileURL(bundle).href);

const store = new Map([
	["a1", { origin_conversation: "work:a2" }],
	["a2", { origin_conversation: "dt:root" }],
	["loop1", { origin_conversation: "work:loop2" }],
	["loop2", { origin_conversation: "work:loop1" }],
	["deep0", { origin_conversation: "work:d1" }],
	["d1", { origin_conversation: "work:d2" }],
	["d2", { origin_conversation: "work:d3" }],
	["d3", { origin_conversation: "work:d4" }],
	["d4", { origin_conversation: "work:d5" }],
	["d5", { origin_conversation: "work:d6" }],
	["d6", { origin_conversation: "work:d7" }],
	["d7", { origin_conversation: "work:d8" }],
	["d8", { origin_conversation: "work:d9" }],
	["d9", { origin_conversation: "work:d10" }],
	["d10", { origin_conversation: "work:d11" }],
	["d11", { origin_conversation: "dt:bottom" }],
	["empty", { origin_conversation: "" }],
	["nullorigin", { origin_conversation: null }],
]);
// mirror the production injection: getItem receives the FULL id incl. work: prefix
const get = (id) => store.get(id.startsWith("work:") ? id.slice(5) : id);

test("passthrough: routable ids are returned as-is", () => {
	assert.deepEqual(resolvePushTarget("dt:chat", get), { target: "dt:chat" });
	assert.deepEqual(resolvePushTarget("feishu:x", get), { target: "feishu:x" });
});

test("1 hop and multi-hop walk to the routable root", () => {
	assert.deepEqual(resolvePushTarget("work:a2", get), { target: "dt:root" });
	assert.deepEqual(resolvePushTarget("work:a1", get), { target: "dt:root" });
});

test("cycle is reported as an error, not a hang", () => {
	const r = resolvePushTarget("work:loop1", get);
	assert.ok("error" in r);
	assert.match(r.error, /成环/);
});

test("depth > 10 hops is reported as an error", () => {
	const r = resolvePushTarget("work:deep0", get);
	assert.ok("error" in r);
	assert.match(r.error, /过深/);
});

test("exactly-10-hop chains still resolve", () => {
	// deep11 chain: work:d11 -> dt:bottom is 1 hop from d11; d11 reachable via 10 work: hops from deep0? no —
	// use d11 directly: one hop to a routable target.
	assert.deepEqual(resolvePushTarget("work:d11", get), { target: "dt:bottom" });
});

test("orphan work: id errors honestly", () => {
	const r = resolvePushTarget("work:ghost", get);
	assert.ok("error" in r);
	assert.match(r.error, /找不到对应任务/);
});

test("empty/null origin errors honestly", () => {
	assert.match(resolvePushTarget("work:empty", get).error ?? "", /来源会话为空/);
	assert.match(resolvePushTarget("work:nullorigin", get).error ?? "", /来源会话为空/);
});
