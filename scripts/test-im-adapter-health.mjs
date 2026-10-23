#!/usr/bin/env node
/**
 * IM adapter health + capability declaration tests (P1: 渠道状态卡/能力声明).
 *
 * Pins:
 *  - AdapterMetadata (displayName + capabilities) on every built-in adapter;
 *  - DingtalkAdapter.status() five fields: connected/startedAt flip with the
 *    stream lifecycle, lastInboundAt bumps on inbound, lastOutboundAt bumps on
 *    every platform send (webhook reply + proactive push), lastError surfaces
 *    connect/send failures;
 *  - manager.channelStatuses() aggregation;
 *  - the manager's proactive capability gate (a non-proactive adapter that
 *    somehow implements push is refused, never invoked).
 *
 * No live network: DWClient is stubbed via esbuild, fetch is captured.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.im-health-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "health.mjs");
await build({
	stdin: {
		contents: `
			export { DingtalkAdapter } from "./src/im/adapters/dingtalk.ts";
			export { EchoAdapter } from "./src/im/adapters/echo.ts";
			export { IMAdapterManager } from "./src/im/manager.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	plugins: [{
		name: "stub-dingtalk-stream",
		setup(b) {
			b.onResolve({ filter: /^dingtalk-stream$/ }, () => ({ path: "dw", namespace: "stub" }));
			b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
				contents: `
					export const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";
					export class DWClient {
						constructor() { globalThis.__dwClientInstance = this; }
						on() {}
						registerCallbackListener(topic, cb) { this.cb = cb; }
						async connect() { if (globalThis.__dwFailConnect) throw new Error("boom"); }
						disconnect() {}
						socketCallBackResponse() {}
					}
				`,
			}));
		},
	}],
});
const { DingtalkAdapter, EchoAdapter, IMAdapterManager } = await import(pathToFileURL(bundle).href);

function stubFetch() {
	const sent = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		sent.push({ url: String(url), body: String(init?.body ?? "") });
		return new Response(JSON.stringify({ accessToken: "stub-token", expireIn: 7200, result: { deliverResults: [{ success: true }] } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { sent, restore: () => { globalThis.fetch = original; } };
}

async function startDingtalk() {
	const { sent, restore } = stubFetch();
	const adapter = new DingtalkAdapter();
	await adapter.start(
		{ async handle() { return "好的，已处理。"; } },
		{ channel: "dingtalk", appId: "ding-stub-app", appSecret: "ding-stub-secret" },
	);
	return { adapter, sent, restore };
}

async function dispatchInbound(adapter, conversationType = "1") {
	const inst = globalThis.__dwClientInstance;
	await inst.cb({
		headers: { messageId: `m-${Math.random()}` },
		data: JSON.stringify({
			msgtype: "text",
			text: { content: "在吗" },
			conversationType,
			conversationId: conversationType === "1" ? "cid-direct" : "cid-group",
			senderStaffId: "staff-1",
			senderId: "staff-1",
			sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=stub",
			robotCode: "ding-stub-app",
			msgId: `m-${Math.random()}`,
		}),
	});
}

test("every adapter declares metadata (displayName + capability shape)", () => {
	for (const adapter of [new DingtalkAdapter(), new EchoAdapter()]) {
		assert.equal(typeof adapter.metadata.displayName, "string");
		assert.ok(adapter.metadata.displayName.length > 0);
		for (const key of ["streaming", "proactive", "groupMention", "media"]) {
			assert.equal(typeof adapter.metadata.capabilities[key], "boolean", `${adapter.channel}.${key}`);
		}
	}
	assert.equal(new DingtalkAdapter().metadata.capabilities.proactive, true, "dingtalk supports proactive push");
	assert.equal(new EchoAdapter().metadata.capabilities.proactive, false, "echo is reply-only");
});

test("dingtalk status lifecycle: connect → inbound → outbound → stop", async () => {
	const { adapter, restore } = await startDingtalk();
	try {
		const before = 0;
		const st0 = adapter.status();
		assert.equal(st0.connected, true);
		assert.ok(typeof st0.startedAt === "number" && st0.startedAt > before - 1);
		assert.equal(st0.lastInboundAt, undefined);
		assert.equal(st0.lastOutboundAt, undefined);

		await dispatchInbound(adapter);
		const st1 = adapter.status();
		assert.ok(typeof st1.lastInboundAt === "number", "inbound bumps lastInboundAt");

		await adapter.push("dt:staff-1", "推送测试");
		const st2 = adapter.status();
		assert.ok(typeof st2.lastOutboundAt === "number", "push bumps lastOutboundAt");
		assert.equal(st2.lastError, undefined);

		await adapter.stop();
		assert.equal(adapter.status().connected, false);
	} finally {
		restore();
		await adapter.stop();
	}
});

test("dingtalk records connect failure in lastError and stays disconnected", async () => {
	const { restore } = stubFetch();
	globalThis.__dwFailConnect = true;
	try {
		const adapter = new DingtalkAdapter();
		// Credentials pass; the stream connect itself fails → lastError carries
		// the connect failure and the adapter stays disconnected.
		await assert.rejects(
			adapter.start({ async handle() {} }, { channel: "dingtalk", appId: "ding-stub-app", appSecret: "ding-stub-secret" }),
			/boom/,
		);
		const st = adapter.status();
		assert.equal(st.connected, false);
		assert.match(st.lastError, /connect failed: boom/);
	} finally {
		globalThis.__dwFailConnect = false;
		restore();
	}
});

test("manager.channelStatuses aggregates displayName/capabilities/health", async () => {
	const manager = Object.create(IMAdapterManager.prototype);
	const echo = new EchoAdapter();
	await echo.start({ async handle() { return ""; } }, { channel: "echo", appId: "", appSecret: "" });
	manager.active = new Map([["echo-default", echo]]);
	const statuses = manager.channelStatuses();
	assert.equal(statuses.length, 1);
	assert.equal(statuses[0].id, "echo-default");
	assert.equal(statuses[0].displayName, "Echo 测试通道");
	assert.equal(statuses[0].health.connected, true);
	await echo.stop();
});

test("manager refuses pushing to a channel that declares non-proactive", async () => {
	const manager = Object.create(IMAdapterManager.prototype);
	let pushCalled = 0;
	const fake = {
		channel: "x",
		metadata: { displayName: "只读渠道", capabilities: { streaming: false, proactive: false, groupMention: false, media: false } },
		push: async () => { pushCalled += 1; return { ok: true }; },
	};
	manager.active = new Map([["x", fake]]);
	manager.adapterFor = () => fake; // shadow the dt:-prefix router for this fake channel
	const result = await manager.pushToConversation("x:conv", "hello");
	assert.equal(result.ok, false);
	assert.match(result.error, /不支持主动推送/);
	assert.equal(pushCalled, 0, "the push method must never be invoked");
});
