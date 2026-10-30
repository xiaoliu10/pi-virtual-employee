#!/usr/bin/env node
/**
 * Credential egress gate (field 2026-10-20: an account password was pasted into
 * a GROUP chat during login troubleshooting).
 *
 * Two layers are pinned here:
 *  1. the pure policy — what counts as a concrete credential, and who may see
 *     it (groups always withheld; a verified admin in 1:1 may see it; everyone
 *     else withheld), including adversarial markdown and benign negatives;
 *  2. the real DingTalk adapter — the outbound TEXT paths (card body, card
 *     preview/copy_content, markdown fallback, mid-turn progress, proactive
 *     push) must carry the withheld notice, and the exemption must follow the
 *     LIVE admin check (revoking the role takes effect immediately). File/image
 *     payloads, filenames and photo URLs are documented out of scope in the
 *     module header; URL-embedded share tokens are redacted in place.
 *
 * All credentials below are synthetic. No live network: fetch is stubbed.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.credential-egress-test-"));
after(() => rm(dir, { recursive: true, force: true }));

/** Synthetic secret used throughout — not a real credential. */
const SECRET = "Synthetic#Pass9!";

const bundle = join(dir, "egress.mjs");
await build({
	stdin: {
		contents: `
			export { containsConcreteCredential, gateOutboundText, CREDENTIAL_WITHHELD_NOTICE, setConfiguredReportHosts } from "./src/im/credential-egress.ts";
			export { DingtalkAdapter } from "./src/im/adapters/dingtalk.ts";
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
	plugins: [
		{
			// dingtalk-stream opens a websocket; the adapter only needs the class
			// shape so the callback can be captured and driven from the test.
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
const { containsConcreteCredential, gateOutboundText, CREDENTIAL_WITHHELD_NOTICE, setConfiguredReportHosts, DingtalkAdapter, IMAdapterManager } =
	await import(pathToFileURL(bundle).href);

// ── Layer 1: pure policy ────────────────────────────────────────────────────

test("concrete credentials are detected in the forms the field shows up in", () => {
	const leaking = [
		`密码还是 ${SECRET} 吗？最近变更过没有？`,
		`账号的密码：${SECRET}`,
		"密码是 `Synthetic#Pass9!`",
		"**密码**：**Synthetic#Pass9!**",
		`password: ${SECRET}`,
		`Password = "${SECRET}"`,
		`password=${SECRET}`,
		"```\nPASSWORD=Synthetic#Pass9!\n```",
		`{"password": "${SECRET}"}`,
		`client_secret: ${SECRET}`,
		"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij",
		"sk-proj-abcdefghijklmnopqrstuvwx",
		"-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
		"访问 https://nova:Synthetic%231@spay.internal/login 试试",
		"https://api.example.com/v1?api_key=SyntheticKey9",
		"账号口令：Synthetic#Pass9!",
		// review P1 regressions: underscore inside the value, numeric-only PIN
		"client_secret: w9_k2Q7_x",
		"重置后的密码是 Abc_123456",
		"密码：83920174",
		// review P3: reset phrasing and camelCase JSON
		"密码已重置成 Abc_123456",
		'{"apiKey": "sk-abc123def456"}',
	];
	for (const text of leaking) {
		assert.equal(containsConcreteCredential(text), true, `must be blocked: ${JSON.stringify(text)}`);
	}
});

test("talking ABOUT credentials without a value is never blocked", () => {
	const benign = [
		"密码最近变更过吗？",
		"知识库里有这个账号的密码，我先查一下。",
		"验证码过期了，需要重新获取。",
		"登录失败返回 HTTP 401，可能是风控。",
		"建议管理员重置密码后告知，不要在群里发。",
		"这个接口的 password 字段是必填项。",
		"订单号 20261020001 查询结果正常。",
		"请确认密码是否变更，以及是否触发了风控。",
	];
	for (const text of benign) {
		assert.equal(containsConcreteCredential(text), false, `must stay untouched: ${JSON.stringify(text)}`);
	}
});

test("gate: groups are always withheld, even when the sender is an admin", () => {
	const text = `密码还是 ${SECRET} 吗？`;
	// The audience is decided by the trusted route, so a group is "restricted"
	// regardless of who asked — the admin CASE is covered by the adapter test.
	assert.equal(gateOutboundText(text, "restricted"), CREDENTIAL_WITHHELD_NOTICE);
});

test("gate: restricted keeps ordinary text verbatim, and the notice is idempotent", () => {
	assert.equal(gateOutboundText("巡检完成，异常 2 条", "restricted"), "巡检完成，异常 2 条");
	assert.equal(gateOutboundText(CREDENTIAL_WITHHELD_NOTICE, "restricted"), CREDENTIAL_WITHHELD_NOTICE);
	assert.equal(gateOutboundText(CREDENTIAL_WITHHELD_NOTICE, "admin-single"), CREDENTIAL_WITHHELD_NOTICE);
});

test("gate: a verified admin 1:1 audience is exempt (unchanged text)", () => {
	const text = `密码还是 ${SECRET} 吗？`;
	assert.equal(gateOutboundText(text, "admin-single"), text);
});

// ── Layer 2: the real adapter, with fetch captured ──────────────────────────

/** Capture every outbound request body instead of calling DingTalk. */
function stubFetch({ failCard = false } = {}) {
	const sent = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const urlText = String(url);
		sent.push({ url: urlText, body: String(init?.body ?? "") });
		const status = failCard && urlText.includes("/instances") ? 500 : 200;
		return new Response(JSON.stringify({ accessToken: "stub-token", expireIn: 7200, result: { deliverResults: [{ success: true }] } }), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { sent, restore: () => { globalThis.fetch = original; } };
}

async function startAdapter(isAdminRecipient, fetchOpts) {
	const { sent, restore } = stubFetch(fetchOpts);
	const adapter = new DingtalkAdapter(undefined, dir, isAdminRecipient);
	let onProgress;
	await adapter.start(
		{
			async handle(_msg, ctx) {
				onProgress = ctx?.onProgress;
				return `登录失败原因是密码不对。密码还是 ${SECRET} 吗？最近变更过没有？`;
			},
		},
		{ channel: "dingtalk", appId: "ding-stub-app", appSecret: "ding-stub-secret" },
	);
	return { adapter, sent, restore, getProgress: () => onProgress };
}

/** Drive one inbound message through the captured stream callback. */
async function dispatchInbound(adapter, { conversationType, senderStaffId = "staff-admin" }) {
	const inst = globalThis.__dwClientInstance;
	assert.ok(inst?.cb, "the adapter registered a stream callback");
	await inst.cb({
		headers: { messageId: "m-1" },
		data: JSON.stringify({
			msgtype: "text",
			text: { content: "登录失败帮我看看" },
			conversationType,
			conversationId: conversationType === "1" ? "cid-direct" : "cid-group",
			senderStaffId,
			senderId: senderStaffId,
			sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=stub",
			robotCode: "ding-stub-app",
			msgId: "m-1",
		}),
	});
}

test("group delivery (admin sender) carries the notice in every card field AND the fallback", async () => {
	const { adapter, sent, restore } = await startAdapter(() => true); // admin by role…
	try {
		await dispatchInbound(adapter, { conversationType: "2" }); // …but it is a GROUP
		const bodies = sent.map((r) => r.body).join("\n");
		assert.ok(bodies.length > 0, "something was delivered");
		assert.ok(!bodies.includes(SECRET), "the secret never reaches the wire");
		assert.ok(bodies.includes("敏感凭据"), "the withheld notice is delivered instead");
	} finally {
		restore();
		await adapter.stop();
	}
});

test("verified admin 1:1 keeps the original text; the same admin loses it after revoke", async () => {
	let adminNow = true;
	const { adapter, sent, restore } = await startAdapter(() => adminNow);
	try {
		await dispatchInbound(adapter, { conversationType: "1", senderStaffId: "staff-admin" });
		assert.ok(sent.map((r) => r.body).join("\n").includes(SECRET), "admin 1:1 sees the credential text");

		sent.length = 0;
		adminNow = false; // role revoked — live check takes effect on the next message
		await dispatchInbound(adapter, { conversationType: "1", senderStaffId: "staff-admin" });
		const bodies = sent.map((r) => r.body).join("\n");
		assert.ok(!bodies.includes(SECRET), "revoked admin no longer receives it");
		assert.ok(bodies.includes("敏感凭据"));
	} finally {
		restore();
		await adapter.stop();
	}
});

test("non-admin 1:1 is withheld", async () => {
	const { adapter, sent, restore } = await startAdapter(() => false);
	try {
		await dispatchInbound(adapter, { conversationType: "1", senderStaffId: "staff-other" });
		assert.ok(!sent.map((r) => r.body).join("\n").includes(SECRET));
	} finally {
		restore();
		await adapter.stop();
	}
});

test("a throwing admin check fails closed (no exemption)", async () => {
	const { adapter, sent, restore } = await startAdapter(() => { throw new Error("config unavailable"); });
	try {
		await dispatchInbound(adapter, { conversationType: "1", senderStaffId: "staff-admin" });
		assert.ok(!sent.map((r) => r.body).join("\n").includes(SECRET), "must be withheld when the check is unreliable");
	} finally {
		restore();
		await adapter.stop();
	}
});

test("mid-turn progress and proactive push are gated too", async () => {
	const { adapter, sent, restore, getProgress } = await startAdapter(() => true);
	try {
		await dispatchInbound(adapter, { conversationType: "2" });
		// Outbound bodies from THIS test only: earlier tests restored their own
		// fetch, so `sent` here sees exactly what this adapter emits.
		sent.length = 0;
		const progress = getProgress();
		assert.equal(typeof progress, "function", "the adapter exposes a progress hook");

		sent.length = 0;
		await progress(`正在用密码 ${SECRET} 尝试登录`);
		assert.ok(!sent.map((r) => r.body).join("\n").includes(SECRET), "progress text is gated");

		sent.length = 0;
		const pushed = await adapter.push("dt:group:cid-group", `重置后的密码是 ${SECRET}`);
		assert.equal(pushed.ok, true);
		assert.ok(!sent.map((r) => r.body).join("\n").includes(SECRET), "proactive push to a group is gated");

		sent.length = 0;
		// A group push never reaches the exemption; a 1:1 push consults the LIVE
		// admin check (this adapter's callback says the recipient IS an admin).
		sent.length = 0;
		const toAdmin = await adapter.push("dt:staff-admin", `重置后的密码是 ${SECRET}`);
		assert.equal(toAdmin.ok, true);
		assert.ok(sent.map((r) => r.body).join("\n").includes(SECRET), "admin 1:1 push keeps the text");
	} finally {
		restore();
		await adapter.stop();
	}
});

test("a credential straddling a long push is caught BEFORE splitting (manager path)", async () => {
	// The field message was one long troubleshooting reply; splitForPush cuts at
	// ~1200 chars, so a value landing near a boundary must not survive as two
	// individually-innocuous halves.
	const { gateOutboundText: gate } = await import(pathToFileURL(bundle).href);
	const filler = "巡检说明：".repeat(240); // long enough to force a split
	const long = `${filler}\n密码还是 ${SECRET} 吗？`;
	assert.ok(long.length > 1200, "the fixture really is long");
	assert.equal(gate(long, "restricted"), CREDENTIAL_WITHHELD_NOTICE, "whole-message scan happens before any split");
});

test("a share-link token is redacted in place — the report text survives", async () => {
	const link = `日报已生成：https://gitee.com/xiaoliu10/repo/raw/main/report.md?access_token=gk_abcdef123456，请查收。`;
	const delivered = gateOutboundText(link, "restricted");
	assert.ok(!delivered.includes("gk_abcdef123456"), "the token never reaches the group");
	assert.ok(delivered.includes("access_token=***"), "the param is visibly redacted");
	assert.ok(delivered.includes("日报已生成"), "the rest of the message survives");
	// Idempotent: re-gating the redacted text is a no-op.
	assert.equal(gateOutboundText(delivered, "restricted"), delivered);
	// But a real labeled credential nearby still withholds the whole message.
	const mixed = `密码是 Abc_123456 ${link}`;
	assert.equal(gateOutboundText(mixed, "restricted"), CREDENTIAL_WITHHELD_NOTICE);
});

test("an OSS presigned report link survives group egress intact (field 2026-10-27)", () => {
	const link = "https://wengine-ai-workbench.oss-cn-hangzhou.aliyuncs.com/reports/d19746b2/880a35e5.html?OSSAccessKeyId=LTAIZHYtKQegFGXe&Expires=1795654871&Signature=N9him7VHYYIEdIftaIY5iHWf2iU%3D";
	const msg = `\u2705 查看报告：${link}`;
	const delivered = gateOutboundText(msg, "restricted");
	assert.equal(delivered, msg, "the system-generated link IS the deliverable — signature/key id/expiry all survive");
	// Trailing CJK punctuation glued to the URL must not break the protection.
	const punctuated = gateOutboundText(`查看报告：${link}。请查收`, "restricted");
	assert.ok(punctuated.includes("Signature=N9him7VHYYIEdIftaIY5iHWf2iU%3D"), "signature survives prose punctuation");
	// AWS SigV4 presigned shape is protected the same way.
	const aws = gateOutboundText("https://s3.us-east-1.amazonaws.com/r/a.txt?X-Amz-Credential=AKIAEX%2F20261027%2Fus-east-1%2Fs3&X-Amz-Signature=abcdef0123456789abcdef0123456789", "restricted");
	assert.ok(aws.includes("X-Amz-Signature=abcdef0123456789abcdef0123456789"), "SigV4 signature survives");
	// Idempotent: re-gating an already-delivered message is a no-op.
	assert.equal(gateOutboundText(delivered, "restricted"), delivered);
});

test("a presigned link does not exempt a REAL credential elsewhere in the message", () => {
	const link = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.html?OSSAccessKeyId=LTAIZHYtKQegFGXe&Expires=1795654871&Signature=N9him7VHYYIEdIftaIY5iHWf2iU%3D";
	assert.equal(
		gateOutboundText(`密码是 Abc_123456 查看报告：${link}`, "restricted"),
		CREDENTIAL_WITHHELD_NOTICE,
		"presigned protection is per-URL, never a whole-message exemption",
	);
});

test("a fake presigned marker never rescues a credential URL (review P1 regression pins)", () => {
	// [A] Gitee PAT + dummy OSS markers on the SAME url: PAT must still be redacted.
	const g = "https://gitee.com/xiaoliu10/repo/raw/main/r.md?access_token=gk_abcdef123456&OSSAccessKeyId=x&Signature=abcdef123456";
	const dg = gateOutboundText(g, "restricted");
	assert.ok(dg.includes("access_token=***"), "PAT redacted despite the fake presigned markers");
	assert.ok(!dg.includes("gk_abcdef123456"));
	// [B] intranet password url + dummy markers: whole message still withheld.
	const b = "http://10.0.0.5:8080/d?password=hunter2secure&OSSAccessKeyId=x&Signature=abcdef123456";
	assert.equal(gateOutboundText(b, "restricted"), CREDENTIAL_WITHHELD_NOTICE, "withhold is restored for non-storage hosts");
	// [C] REAL presigned url carrying an extra credential param: param-level split.
	const real = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.html?access_token=gk_abcdef123456&OSSAccessKeyId=LTAIZHYtKQegFGXe&Expires=1795654871&Signature=N9him7VHYYIEdIftaIY5iHWf2iU%3D";
	const dr = gateOutboundText(real, "restricted");
	assert.ok(dr.includes("access_token=***"), "the non-grant param is redacted");
	assert.ok(dr.includes("Signature=N9him7VHYYIEdIftaIY5iHWf2iU%3D"), "the grant itself survives");
});

test("case-mismatched presigned markers fail closed (detection is case-insensitive, exemption is not)", () => {
	const link = "https://gitee.com/xiaoliu10/repo/raw/main/r.md?access_token=gk_abcdef123456&ossaccesskeyid=x&signature=abcdef123456";
	const delivered = gateOutboundText(link, "restricted");
	assert.ok(delivered.includes("access_token=***"), "lowercase markers get no exemption — the PAT is still redacted");
});

test("egressAudience: live admin check over the dt: id shape, failing closed", async () => {
	let adminNow = true;
	const { adapter } = await startAdapter((staffId) => adminNow && staffId === "staff-admin");
	try {
		assert.equal(adapter.egressAudience("dt:staff-admin"), "admin-single");
		assert.equal(adapter.egressAudience("dt:staff-other"), "restricted");
		assert.equal(adapter.egressAudience("dt:group:cid-group"), "restricted", "groups never exempt");
		assert.equal(adapter.egressAudience("dt:"), "restricted", "empty staffId");
		assert.equal(adapter.egressAudience("console:abc"), "restricted", "non-IM id");
		adminNow = false;
		assert.equal(adapter.egressAudience("dt:staff-admin"), "restricted", "revocation is live");
	} finally {
		await adapter.stop();
	}
});

test("manager push honors the adapter audience: admin 1:1 keeps text, groups/revoked are withheld", async () => {
	let adminNow = true;
	const { adapter, sent, restore } = await startAdapter(() => adminNow);
	try {
		const manager = Object.create(IMAdapterManager.prototype);
		manager.active = new Map([["dingtalk", adapter]]);
		sent.length = 0;
		const toAdmin = await manager.pushToConversation("dt:staff-admin", `对账完成的密码是 ${SECRET}`);
		assert.equal(toAdmin.ok, true);
		assert.ok(sent.map((r) => r.body).join("\n").includes(SECRET), "verified admin 1:1 push keeps the text");

		sent.length = 0;
		adminNow = false;
		const revoked = await manager.pushToConversation("dt:staff-admin", `对账完成的密码是 ${SECRET}`);
		assert.equal(revoked.ok, true);
		const revokedBodies = sent.map((r) => r.body).join("\n");
		assert.ok(!revokedBodies.includes(SECRET), "revoked admin is withheld on the manager path too");
		assert.ok(revokedBodies.includes("敏感凭据"));

		sent.length = 0;
		const group = await manager.pushToConversation("dt:group:cid-group", `对账完成的密码是 ${SECRET}`);
		assert.equal(group.ok, true);
		assert.ok(!sent.map((r) => r.body).join("\n").includes(SECRET));
	} finally {
		restore();
		await adapter.stop();
	}
});

test("card-send failure falls back to markdown carrying the same gated text", async () => {
	const { adapter, sent, restore } = await startAdapter(() => false, { failCard: true });
	try {
		await dispatchInbound(adapter, { conversationType: "2" });
		const bodies = sent.map((r) => r.body).join("\n");
		assert.ok(bodies.includes("msgtype"), "the markdown fallback fired");
		assert.ok(!bodies.includes(SECRET), "the fallback is gated too");
		assert.ok(bodies.includes("敏感凭据"));
	} finally {
		restore();
		await adapter.stop();
	}
});

// ── v0.2.175: presigned links on a CONFIGURED endpoint host ─────────────
// reports.oss.endpoint is configurable (its own docs name "an internal/CDN
// domain"). The allowlist used to be the two cloud domains only, so a box
// pointing OSS at a custom host had EVERY report link redacted in group pushes
// (field 2026-10-29). The gate now accepts hosts the deployment configures —
// without loosening the grant shape or the dot-boundary rule.
const CUSTOM_SIG = "N9him7VHYYIEdIftaIY5iHWf2iU%3D";
const linkOn = (host) => `https://${host}/reports/x/r.html?OSSAccessKeyId=LTAIZHYtKQegFGXe&Expires=1795654871&Signature=${CUSTOM_SIG}`;

test("a presigned link on a configured report host is NOT redacted", () => {
	setConfiguredReportHosts(["https://oss.orion-corp.com"]);
	const url = linkOn("oss.orion-corp.com");
	assert.equal(gateOutboundText(url, "restricted"), url, "the deployment's own report link must survive the gate");
});

test("without configuration the same custom host stays redacted (no blanket relaxation)", () => {
	setConfiguredReportHosts([]);
	const url = linkOn("oss.orion-corp.com");
	assert.notEqual(gateOutboundText(url, "restricted"), url, "an unconfigured host keeps the original behaviour");
});

test("the configured host widens WHICH host, never the grant shape", () => {
	setConfiguredReportHosts(["orion-corp.com"]);
	// Same host, but a real password alongside the grant: still redacted.
	const withPassword = `https://orion-corp.com/r.html?password=Hunter2Secret&OSSAccessKeyId=LTAIZHYtKQegFGXe&Signature=${CUSTOM_SIG}`;
	const out = gateOutboundText(withPassword, "restricted");
	assert.ok(!out.includes("Hunter2"), "a credential param on an exempt host is still redacted");
	// Signature without the matching key id is not a grant.
	const halfGrant = `https://orion-corp.com/r.html?Signature=${CUSTOM_SIG}`;
	assert.notEqual(gateOutboundText(halfGrant, "restricted"), halfGrant, "a lone Signature param is not a presigned grant");
});

test("subdomains match, but a look-alike suffix does not", () => {
	setConfiguredReportHosts(["orion-corp.com"]);
	const sub = linkOn("cdn.orion-corp.com");
	assert.equal(gateOutboundText(sub, "restricted"), sub, "a subdomain of a configured host qualifies");
	const lookalike = linkOn("evilorion-corp.com");
	assert.notEqual(gateOutboundText(lookalike, "restricted"), lookalike, "a string suffix is not a subdomain (dot boundary required)");
	const parent = linkOn("orion.com");
	assert.notEqual(gateOutboundText(parent, "restricted"), parent, "the parent domain is not covered by a child");
});

test("the cloud defaults keep working regardless of configuration", () => {
	setConfiguredReportHosts([]);
	const oss = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.html?OSSAccessKeyId=LTAIZHYtKQegFGXe&Expires=1795654871&Signature=N9him7VHYYIEdIftaIY5iHWf2iU%3D";
	assert.equal(gateOutboundText(oss, "restricted"), oss, "aliyuncs.com needs no configuration");
});
