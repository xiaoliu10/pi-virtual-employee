#!/usr/bin/env node
/**
 * Inbound-drop observability (field 2026-11-14): a group message vanished with
 * ZERO log lines — the adapter's two silent returns (unparsable payload, empty
 * text) made ingress losses unattributable. Pins:
 *   1. every stream callback logs an arrival line (messageId);
 *   2. an unparsable payload warns DROPPED and never reaches io.handle;
 *   3. an empty text/image/file payload warns DROPPED (with msgtype + rawLen)
 *      and never reaches io.handle;
 *   4. a normal message still routes to io.handle (no behaviour change).
 * No live network: dingtalk-stream is stubbed and fetch is captured.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.inbound-drop-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "inbound.mjs");
await build({
	stdin: {
		contents: `export { DingtalkAdapter } from "./src/im/adapters/dingtalk.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	plugins: [
		{
			name: "stub-dingtalk-stream",
			setup(b) {
				b.onResolve({ filter: /^dingtalk-stream$/ }, () => ({ path: "dw", namespace: "stub" }));
				b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
					contents: `
						export const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";
						export class DWClient {
							constructor(opts) { this.opts = opts; globalThis.__dwClientInstance = this; }
							on() {}
							registerCallbackListener(topic, cb) { this.topic = topic; this.cb = cb; }
							async connect() {}
							disconnect() {}
							socketCallBackResponse() {}
						}
					`,
				}));
			},
		},
	],
});
const { DingtalkAdapter } = await import(pathToFileURL(bundle).href);

/** Capture console.log/warn lines while a callback runs. */
function captureConsole() {
	const lines = { log: [], warn: [] };
	const ol = console.log, ow = console.warn;
	console.log = (...a) => lines.log.push(a.map(String).join(" "));
	console.warn = (...a) => lines.warn.push(a.map(String).join(" "));
	return { lines, restore: () => { console.log = ol; console.warn = ow; } };
}

async function startAdapter() {
	const handled = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ accessToken: "stub-token", expireIn: 7200, result: { deliverResults: [{ success: true }] } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	const adapter = new DingtalkAdapter(undefined, dir, () => false);
	await adapter.start(
		{
			async handle(msg) {
				handled.push(msg);
				return "ok";
			},
		},
		{ channel: "dingtalk", appId: "ding-stub-app", appSecret: "ding-stub-secret" },
	);
	return {
		handled,
		dispatch: (payload) => globalThis.__dwClientInstance.cb({ headers: { messageId: payload.messageId }, data: payload.data }),
		restore: () => { globalThis.fetch = originalFetch; },
	};
}

test("arrival line is logged for every stream callback", async () => {
	const { handled, dispatch, restore } = await startAdapter();
	const cap = captureConsole();
	try {
		await dispatch({
			messageId: "m-arrival-1",
			data: JSON.stringify({ msgtype: "text", text: { content: "你好" }, conversationType: "1", senderStaffId: "s1", msgId: "om1", conversationId: "c1", robotCode: "r1" }),
		});
	} finally {
		cap.restore();
	}
	restore();
	assert.ok(cap.lines.log.some((l) => l.includes("inbound callback messageId=m-arrival-1")), "arrival line missing");
	assert.equal(handled.length, 1);
});

test("unparsable payload warns DROPPED and never reaches io.handle", async () => {
	const { handled, dispatch, restore } = await startAdapter();
	const cap = captureConsole();
	try {
		await dispatch({ messageId: "m-bad-1", data: "{not json" });
	} finally {
		cap.restore();
	}
	restore();
	assert.ok(cap.lines.warn.some((l) => l.includes("DROPPED: payload unparsable") && l.includes("m-bad-1")), "unparsable warn missing");
	assert.equal(handled.length, 0, "io.handle must not see an unparsable payload");
});

test("empty text/image/file payload warns DROPPED with msgtype and rawLen", async () => {
	const { handled, dispatch, restore } = await startAdapter();
	const cap = captureConsole();
	try {
		await dispatch({
			messageId: "m-empty-1",
			data: JSON.stringify({ msgtype: "text", text: { content: "   " }, conversationType: "2", conversationId: "cid1", senderStaffId: "s1", msgId: "om2", robotCode: "r1" }),
		});
	} finally {
		cap.restore();
	}
	restore();
	const warn = cap.lines.warn.find((l) => l.includes("DROPPED: empty text/image/file") && l.includes("m-empty-1"));
	assert.ok(warn, "empty-drop warn missing");
	assert.match(warn, /msgtype=text/);
	assert.match(warn, /rawLen=3/);
	assert.equal(handled.length, 0, "io.handle must not see an empty payload");
});

test("a normal group message still routes to io.handle", async () => {
	const { handled, dispatch, restore } = await startAdapter();
	const cap = captureConsole();
	try {
		await dispatch({
			messageId: "m-ok-1",
			data: JSON.stringify({ msgtype: "text", text: { content: "继续执行日终对账巡检 已登录" }, conversationType: "2", conversationId: "cidGroup", senderStaffId: "s1", msgId: "om3", robotCode: "r1" }),
		});
	} finally {
		cap.restore();
	}
	restore();
	assert.equal(handled.length, 1);
	assert.match(handled[0].conversationId, /^dt:group:cidGroup$/);
	assert.ok(!cap.lines.warn.some((l) => l.includes("DROPPED")), "a healthy message must not warn");
});
