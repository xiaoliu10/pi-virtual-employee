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

test("gate: groups get a MASKED delivery, not a whole-message withhold (user ruling 2026-11-11)", () => {
	const text = `密码还是 ${SECRET} 吗？`;
	// The audience is decided by the trusted route, so a group is "restricted"
	// regardless of who asked — the admin CASE is covered by the adapter test.
	// v0.2.225: the value is masked in place (label readable), a short suffix
	// note reports the redaction — the message survives.
	const out = gateOutboundText(text, "restricted");
	assert.ok(!out.includes(SECRET), "the secret value never reaches the wire");
	assert.ok(out.includes("****"), "the value is masked");
	assert.ok(out.includes("密码还是"), "the label stays readable");
	assert.ok(out.includes("脱敏"), "a masked-delivery note is appended");
	assert.ok(!out.includes("拦下"), "the withhold notice is NOT the delivery");
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

test("a credential straddling a long push is masked BEFORE splitting (manager path)", async () => {
	// The field message was one long troubleshooting reply; splitForPush cuts at
	// ~1200 chars, so a value landing near a boundary must not survive as two
	// individually-innocuous halves. v0.2.225: the whole message is scanned and
	// MASKED before any split — the value cannot ride a boundary.
	const { gateOutboundText: gate } = await import(pathToFileURL(bundle).href);
	const filler = "巡检说明：".repeat(240); // long enough to force a split
	const long = `${filler}\n密码还是 ${SECRET} 吗？`;
	assert.ok(long.length > 1200, "the fixture really is long");
	const out = gate(long, "restricted");
	assert.ok(!out.includes(SECRET), "whole-message mask happens before any split");
	assert.ok(out.includes("****"), "the value is masked in the long body");
	assert.ok(out.includes("脱敏"), "the masked-delivery note is appended");
});

test("a share-link token is redacted in place — the report text survives", async () => {
	const link = `日报已生成：https://gitee.com/xiaoliu10/repo/raw/main/report.md?access_token=gk_abcdef123456，请查收。`;
	const delivered = gateOutboundText(link, "restricted");
	assert.ok(!delivered.includes("gk_abcdef123456"), "the token never reaches the group");
	assert.ok(delivered.includes("access_token=***"), "the param is visibly redacted");
	assert.ok(delivered.includes("日报已生成"), "the rest of the message survives");
	// Idempotent: re-gating the redacted text is a no-op.
	assert.equal(gateOutboundText(delivered, "restricted"), delivered);
	// A real labeled credential nearby is MASKED in place (v0.2.225) while the
	// share-link redaction stays intact.
	const mixed = `密码是 Abc_123456 ${link}`;
	const mixedOut = gateOutboundText(mixed, "restricted");
	assert.ok(!mixedOut.includes("Abc_123456"), "the labeled value never reaches the group");
	assert.ok(/密码是\s*\*{4}/.test(mixedOut), "the label stays, the value is masked");
	assert.ok(mixedOut.includes("access_token=***"), "the share-link redaction still applies");
	assert.ok(mixedOut.includes("脱敏"), "the masked note reports the redaction");
});

test("mask keeps token-family prefixes and counts multiple spots", () => {
	const text = "配置用了 sk-abcdefghijklmnopqrstuvwx，回执 token=Zx9Kq2Lm8Pp4Qr7St 也换过。";
	const out = gateOutboundText(text, "restricted");
	assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwx"), "the key value is gone");
	assert.ok(out.includes("sk-****"), "the token-family prefix stays identifiable");
	assert.ok(!out.includes("Zx9Kq2Lm8Pp4Qr7St"), "the env value is gone");
	assert.ok(out.includes("token=****"), "the env label stays readable");
	assert.ok(out.includes("2 处"), "the suffix counts both masked spots");
});

test("presigned report links stay intact while a separate credential is masked", () => {
	const link = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r/日报.xlsx?OSSAccessKeyId=abcd&Signature=Sig%2BValue%3D&Expires=9999999999";
	const text = `巡检完成，报表：${link}\n（登录密码：Sup3rSecret! 如需自取请告知）`;
	const out = gateOutboundText(text, "restricted");
	assert.ok(out.includes("OSSAccessKeyId=abcd"), "the presigned grant survives untouched");
	assert.ok(out.includes("Signature=Sig%2BValue%3D"), "the signature is a grant, not a leak");
	assert.ok(!out.includes("Sup3rSecret!"), "the labeled password is masked");
	assert.ok(out.includes("脱敏"), "the masked note is appended");
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
	// v0.2.225: per-URL protection means the grant survives AND the labeled
	// credential is masked — both in one delivery (never a whole withhold).
	const link = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.html?OSSAccessKeyId=LTAIZHYtKQegFGXe&Expires=1795654871&Signature=N9him7VHYYIEdIftaIY5iHWf2iU%3D";
	const out = gateOutboundText(`密码是 Abc_123456 查看报告：${link}`, "restricted");
	assert.ok(!out.includes("Abc_123456"), "presigned protection is per-URL, never a whole-message exemption: the credential is still masked");
	assert.ok(out.includes("Signature=N9him7VHYYIEdIftaIY5iHWf2iU%3D"), "the grant itself survives untouched");
	assert.ok(out.includes("脱敏"), "the masked note is appended");
});

test("a fake presigned marker never rescues a credential URL (review P1 regression pins)", () => {
	// [A] Gitee PAT + dummy OSS markers on the SAME url: PAT must still be redacted.
	const g = "https://gitee.com/xiaoliu10/repo/raw/main/r.md?access_token=gk_abcdef123456&OSSAccessKeyId=x&Signature=abcdef123456";
	const dg = gateOutboundText(g, "restricted");
	assert.ok(dg.includes("access_token=***"), "PAT redacted despite the fake presigned markers");
	assert.ok(!dg.includes("gk_abcdef123456"));
	// [B] intranet password url + dummy markers: the password is masked (the
	// fake markers are swallowed by the same mask span) — v0.2.225 delivers.
	const b = "http://10.0.0.5:8080/d?password=hunter2secure&OSSAccessKeyId=x&Signature=abcdef123456";
	const db = gateOutboundText(b, "restricted");
	assert.ok(!db.includes("hunter2secure"), "non-storage host: the password never survives");
	assert.ok(db.includes("password="), "the label stays readable");
	assert.ok(db.includes("****"), "the value is masked");
	assert.ok(db.includes("脱敏"), "the masked note is appended");
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

// ─── review ac4d70c5: fuzz-found P1 plaintext-leak regression pins ─────────
// Every case below was WITHHELD on main but shipped plaintext on the first
// redact-first draft (800-case fuzz + ~40 hand-built adversarial probes).
const GRANT = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.xlsx?OSSAccessKeyId=abcd1234&Signature=Sig%2BValue%3D&Expires=9999999999";

test("P1-1: a no-space CJK value glued into a presigned URL is masked, grant intact", () => {
	const cjk = `密码：Abc_123456巡检报告链接${GRANT}`;
	const out = gateOutboundText(cjk, "restricted");
	assert.ok(!out.includes("Abc_123456"), "the password never reaches the group");
	assert.ok(out.includes("OSSAccessKeyId=abcd1234") && out.includes("Signature=Sig%2BValue%3D"), "the report grant survives untouched");
	const env = `PASSWORD=hunter2securevalue巡检报告${GRANT}`;
	const out2 = gateOutboundText(env, "restricted");
	assert.ok(!out2.includes("hunter2securevalue"), "the env value never reaches the group");
	assert.ok(out2.includes("OSSAccessKeyId=abcd1234"), "the report grant survives the env-style glue too");
});

test("P1-2: a greedy capture cannot hide a second credential label", () => {
	const t = "下一步继续。password: Hunter2Passw0rd下一步继续。password: Hunter2Passw0rd。";
	const out = gateOutboundText(t, "restricted");
	assert.ok(!out.includes("Hunter2Passw0rd"), "both values are masked, neither escapes via greedy capture");
	assert.equal((out.match(/\*{4}/g) ?? []).length >= 2, true, "two mask spans are produced");
});

test("P1-3: a value beyond the 200-char detector ceiling is withheld, never partially leaked", () => {
	const long = "密码：" + "A1".repeat(110); // 220 chars — no mask span can ever cover the tail
	const out = gateOutboundText(long, "restricted");
	assert.equal(out, CREDENTIAL_WITHHELD_NOTICE, "the fail-closed contract holds for un-maskable values");
	assert.ok(!out.includes("A1A1A1A1A1"), "no plaintext tail survives");
});

test("P1-4: base64 padding inside a token never leaks via keep-prefix", () => {
	const padded = "Bearer YWJjZGVmZ2hpamw=";
	const out1 = gateOutboundText(padded, "restricted");
	assert.ok(!out1.includes("YWJjZGVmZ2hpamw"), "the whole padded token is masked");
	assert.ok(out1.startsWith("Bea****"), "only the 3-char family head stays");
	const mid = gateOutboundText("Bearer abcdefghijkl=mnopqrstuv", "restricted");
	assert.ok(!mid.includes("mnopqrstuv"), "the fragment after an in-token = is masked too");
});

test("P2: high-precision shapes take the masked path; the P2-2 stale-coordinate case no longer withholds", () => {
	// High-precision shapes are masked in place (happy path), never plaintext.
	const t = 'tracing header "token":"gk_' + "x".repeat(40) + '"';
	const out = gateOutboundText(t, "restricted");
	assert.ok(!out.includes("gk_" + "x".repeat(40)), "the token never reaches the group");
	assert.ok(out.includes("****"), "the shape value is masked");
	// Review P2-2 minimal repro: redaction (***) + mask (****) once concatenated
	// into ?access_token=******* and re-tripped the URL-param shape under STALE
	// coordinates, so the whole message was spuriously withheld. Iterative
	// masking recomputes spans on the actual final text — the result is a clean
	// masked delivery, not the withhold notice.
	const glued = 'https://r.example.net/d?access_token=gk_abcdef123456"password":"JsonSecret12345"巡检完成，';
	const out2 = gateOutboundText(glued, "restricted");
	assert.notEqual(out2, CREDENTIAL_WITHHELD_NOTICE, "no spurious withhold from stale coordinates");
	assert.ok(!out2.includes("gk_abcdef123456") && !out2.includes("JsonSecret12345"), "both secrets are masked");
	// shapeTripsOutside remains as defense-in-depth for an internal span bug;
	// under correct masking every shape hit already has a span, so the happy
	// path carries the suffix note rather than the withhold notice.
	const happy = gateOutboundText("密码是 Abc_123456 谢谢", "restricted");
	assert.ok(happy.includes("脱敏"), "ordinary hits take the masked-delivery path, not withholding");
});

test("P3: masked output is idempotent and carries exactly one suffix note", () => {
	const once = gateOutboundText("密码是 Abc_123456 谢谢", "restricted");
	assert.equal(gateOutboundText(once, "restricted"), once, "re-gating masked text changes nothing");
	assert.equal((once.match(/已脱敏/g) ?? []).length, 1, "exactly one suffix note");
});

test("P3: streamed accumulation converges to one suffix, no secret in any gated frame", () => {
	// Replicates makeGatedChannel's accumulation discipline (widget-service):
	// per-push gating over the growing text, final flush gates the whole text.
	const chunks = ["好的，", "账号/密码：", "xxxx/", "yyyy@Y13z"];
	let full = "", sent = "";
	const frames = [];
	for (const delta of chunks) {
		full += delta;
		const safe = gateOutboundText(full, "restricted");
		if (safe === sent) continue;
		if (safe.startsWith(sent)) frames.push(["delta", safe.slice(sent.length)]);
		else frames.push(["replace", safe]);
		sent = safe;
	}
	const final = gateOutboundText(full, "restricted");
	if (final !== sent) frames.push(["flush", final]);
	const wire = JSON.stringify(frames);
	assert.ok(!wire.includes("yyyy@Y13z"), "the credential never appears in any frame");
	assert.ok((final.match(/已脱敏/g) ?? []).length <= 1, "the final bubble carries at most one suffix note");
});

// ─── re-review 92a0f83b: RL-1/RL-2 blockers + P1-C hardening pins ──────────

test("RL-1: CJK prose glued AFTER a presigned query is masked, grant intact (query-aware URL span)", () => {
	const link = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.xlsx?OSSAccessKeyId=abcd1234&Signature=Sig%2BValue%3D&Expires=1799999999";
	// The regression introduced by the first P1-1 fix: the whole-URL protection
	// span counted CJK as URL chars, swallowed 「，密码：…」 and subtraction then
	// erased the password mask entirely (plaintext, no suffix, fallback never
	// consulted because total===0).
	const out = gateOutboundText(`${link}，密码：Abc_123456`, "restricted");
	assert.ok(!out.includes("Abc_123456"), "the glued password is masked");
	assert.ok(out.includes("OSSAccessKeyId=abcd1234") && out.includes("Signature=Sig%2BValue%3D"), "the grant survives");
	assert.ok(out.includes("脱敏"), "masked delivery carries the suffix note");
	// Combined fuzz case: two links + glued bare-ish password.
	const out2 = gateOutboundText(`${link} 和 ${link} 密码：83920174看这个`, "restricted");
	assert.ok(!out2.includes("83920174"), "the second glued value is masked too");
});

test("RL-1 mirror: a CJK object-key path keeps the grant protected (query-aware, not ASCII-only)", () => {
	// The ASCII-only first attempt broke this: the span stopped at 「日报」 before
	// the query, isPresignedObjectUrl saw no params, and Signature was redacted.
	const link = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r/日报.xlsx?OSSAccessKeyId=abcd&Signature=Sig%2BValue%3D&Expires=9999999999";
	const out = gateOutboundText(`巡检完成，报表：${link}\n（登录密码：Sup3rSecret! 如需自取请告知）`, "restricted");
	assert.ok(out.includes("OSSAccessKeyId=abcd") && out.includes("Signature=Sig%2BValue%3D"), "the CJK-path grant survives untouched");
	assert.ok(!out.includes("Sup3rSecret!"), "the separate labeled password is still masked");
});

test("RL-2: a PEM private key is masked as ONE block — the body never ships", () => {
	const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
	const out = gateOutboundText(`运维排查用这个私钥：\n${pem}`, "restricted");
	assert.ok(!out.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"), "the base64 body is masked, not just the banner");
	assert.ok(!out.includes("END PRIVATE KEY"), "the whole block is one mask region");
	// Truncated PEM (no END banner): mask runs to end of text.
	const trunc = gateOutboundText("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7fake7key7material", "restricted");
	assert.ok(!trunc.includes("MIIEowIBAAKCAQEA"), "a truncated key body is masked too");
});

test("P1-C: a masked label value's bare occurrence elsewhere is cross-masked", () => {
	const out = gateOutboundText("Abc_123456 密码是 Abc_123456", "restricted");
	assert.ok(!out.includes("Abc_123456"), "neither the labeled nor the bare copy reaches the group");
	assert.equal((out.match(/\*{4}/g) ?? []).length >= 2, true, "both occurrences are masked");
});

test("M7: the label-boundary lookbehind keeps an English label substring from cutting a value", () => {
	// Direct pin for (?<![A-Za-z0-9_]) in LABEL_BOUNDARY: "secret" must not
	// match inside "SuperSecret99!" and truncate the tempered capture below 6.
	const out = gateOutboundText("系统密码是 SuperSecret99! 请妥善保管。", "restricted");
	assert.ok(!out.includes("SuperSecret99"), "the whole value is masked");
	assert.ok(out.includes("****"), "a mask span was produced (not a silent no-match)");
});

// ─── third-round review 4b16f1b1: N1-N4 + unique-defense pins ──────────────
const GL3 = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.xlsx?OSSAccessKeyId=abcd1234&Expires=1799999999&Signature=Sig%2BValue%3D";

test("N4: the canonical Chinese report push (grant + glued CJK tail) ships verbatim, no false mask, idempotent", () => {
	// d616b5c regression: the Signature SHAPE match swallowed 「。请查收」 past the
	// protected param span; the fragment got a no-op keepPrefix==len span that
	// still appended stars, burning all 8 passes → false 「已脱敏 8 处」 + destroyed
	// prose + no fixed point. Fixed by start-inside-grant whole exemption +
	// no-op span drop.
	const msg = `报表：${GL3}。请查收`;
	assert.equal(gateOutboundText(msg, "restricted"), msg, "a benign push is delivered verbatim");
	const longTail = `报表：${GL3}。请查收，另附本次巡检的详细报告如下`;
	const out = gateOutboundText(longTail, "restricted");
	assert.ok(out.includes("的详细报告如下") && !out.includes("****"), "the prose tail survives");
	assert.equal(gateOutboundText(out, "restricted"), out, "the gate is a fixed point on this shape");
});

test("N1: CJK glue between two links on one line never ships plaintext", () => {
	const out = gateOutboundText(`${GL3}，密码：Abc_123456，${GL3.replace("r.xlsx", "r2.xlsx")}`, "restricted");
	assert.ok(!out.includes("Abc_123456"), "the glued password is masked or the message is withheld");
	// The ?-bait variant: a later ASCII ? in the same whitespace-free run must
	// not extend the URL span across the secret.
	const out2 = gateOutboundText(`${GL3}，密码：Abc_123456?a=b`, "restricted");
	assert.ok(!out2.includes("Abc_123456"), "the ?-bait does not rescue the secret");
});

test("N2: ASCII comma glue after a grant never ships plaintext", () => {
	const out = gateOutboundText(`${GL3},password:Abc_123456`, "restricted");
	assert.ok(!out.includes("Abc_123456"), "the comma-glued password is masked or withheld");
});

test("N3: credential params with label-word names are redacted even when missing from the original list", () => {
	for (const name of ["client_secret", "credential", "passphrase", "private_key", "auth_token"]) {
		const out = gateOutboundText(`${GL3}&${name}=Abc_123456`, "restricted");
		assert.ok(!out.includes("Abc_123456"), `${name}= value never reaches the group`);
	}
	// The grant itself stays intact through N3 redaction.
	const out = gateOutboundText(`${GL3}&client_secret=Abc_123456`, "restricted");
	assert.ok(out.includes("OSSAccessKeyId=abcd1234") && out.includes("Signature=Sig%2BValue%3D"), "the grant survives");
});

test("M1b unique defense: a non-grant param glued to a labeled secret keeps both masked (subtractProtected whole-URL level)", () => {
	// Reverting subtractProtected to drop-whole-candidate makes this leak
	// Zz9!qqqq1x while the 38-test suite stays green — this is its only pin.
	const out = gateOutboundText("https://b.aliyuncs.com/r?OSSAccessKeyId=k&Signature=sig&credential=Abc_123456，另外的值是Zz9!qqqq1x", "restricted");
	assert.ok(!out.includes("Zz9!qqqq1x"), "the glued labeled secret is masked");
	assert.ok(!out.includes("Abc_123456"), "the non-grant credential param is redacted");
});

test("M6 unique defense: the iterative loop re-matches labels exposed by masking (no-space case)", () => {
	// With a space, one pass suffices; WITHOUT a space the first value capture
	// hides the 「私钥」 label until masking frees it — a single-pass mutant
	// ships SuperSecret99! in plaintext while the suite stays green.
	const out = gateOutboundText("password:Abc_123456私钥 是 SuperSecret99!", "restricted");
	assert.ok(!out.includes("SuperSecret99"), "the second secret is masked via re-match");
	assert.ok(!out.includes("Abc_123456"), "the first secret is masked");
});

test("backstop: a secret hidden by whole-URL protection while another span keeps total>0 is withheld, never shipped", () => {
	// Structural pin for the final full-detection check: `secret_key=` is not a
	// URL-redaction name and sits INSIDE the protected presigned span, so mask
	// subtraction drops it; the separate 密码 span keeps total>0, so the
	// total===0 guard never fires. Only the final containsConcreteCredentialIn
	// re-check over the finished text catches it (main-equivalent fail-closed).
	const link = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.xlsx?OSSAccessKeyId=abcd1234&Expires=1799999999&Signature=Sig%2BValue%3D";
	const out = gateOutboundText(`密码：First_123456 ${link}&secret_key=Abc_123456`, "restricted");
	assert.ok(!out.includes("Abc_123456"), "the protected-position secret never ships");
	assert.ok(!out.includes("First_123456"), "the other secret never ships either");
});

test("hyphenated credential param names are redacted like their underscore twins", () => {
	const link = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.xlsx?OSSAccessKeyId=abcd1234&Expires=1799999999&Signature=Sig%2BValue%3D";
	for (const name of ["private-key", "client-secret", "auth-token"]) {
		const out = gateOutboundText(`${link}&${name}=Abc_123456 巡检`, "restricted");
		assert.ok(!out.includes("Abc_123456"), `${name}= is redacted`);
		assert.ok(out.includes("Signature=Sig%2BValue%3D"), "the grant survives the hyphen redaction");
	}
});

test("the backstop never upgrades an ordinary masked delivery to withhold", () => {
	const out = gateOutboundText("密码是 Abc_123456 谢谢", "restricted");
	assert.notEqual(out, CREDENTIAL_WITHHELD_NOTICE, "masked delivery stays masked");
	assert.ok(out.includes("****") && out.includes("脱敏"), "mask + suffix note");
	const json = gateOutboundText('tracing "token":"gk_' + "x".repeat(40) + '"', "restricted");
	assert.notEqual(json, CREDENTIAL_WITHHELD_NOTICE, "masked JSON artifacts do not re-trip the backstop");
});

// ─── fourth-round review 664d7dcb: gap-colon parity + splice artifacts ─────

test("R4-P1: main's full gap-colon detection coverage is preserved (no narrowing)", () => {
	// The round-3 `(?!\/\/)` gap-colon narrowing leaked these (main withholds;
	// 731 corpus cases). Detection must keep main's coverage; masked-output URL
	// artifacts are neutralized in the backstop probe instead.
	const h1 = gateOutboundText("password hint://Abc_123456", "restricted");
	assert.ok(!h1.includes("Abc_123456"), "gap+colon+//value is caught");
	const h2 = gateOutboundText("密码 提示://Abc_123456", "restricted");
	assert.ok(!h2.includes("Abc_123456"), "CJK gap+colon+//value is caught");
	// Compound: an independently masked credential must not mask the fact that
	// the gap-colon one is also handled.
	const cp = gateOutboundText("token:Tok_999888 password hint://Abc_123456", "restricted");
	assert.ok(!cp.includes("Abc_123456") && !cp.includes("Tok_999888"), "both secrets handled in one message");
	// Zero-gap parity (pre-existing) stays.
	assert.notEqual(gateOutboundText("password://abc123def", "restricted"), "password://abc123def", "zero-gap // value still caught");
});

test("long user mask markers cannot exhaust the remaining detector gap", () => {
	for (const length of [3, 6, 7, 8, 9, 10, 12, 16, 64, 512]) {
		for (const label of ["密码：", "token=", "api_key:"]) {
			const input = label + "*".repeat(length) + "https://example.com/Abc_123456";
			for (const message of [input, "密码：First_123456 " + input]) {
				const out = gateOutboundText(message, "restricted");
				assert.ok(!out.includes("Abc_123456"), label + " marker length " + length);
				assert.ok(!out.includes("First_123456"), "independent credential also handled");
				assert.equal(gateOutboundText(out, "restricted"), out, "stable on recheck");
			}
		}
	}
});

test("mask whitespace preserves report delivery and catches compound newline residue", () => {
	const grant = "https://b.aliyuncs.com/r?OSSAccessKeyId=Grant123&Signature=SigValue9&Expires=1799999999";
	for (const markerLength of [3, 8, 16, 512]) {
		for (const whitespace of ["", " ", "\t", "\n", "\r\n", "\u00a0", "\u2028"]) {
			for (const label of ["密码：", "token=", "api_key:"]) {
				const prefix = label + "*".repeat(markerLength) + whitespace;
				const report = prefix + grant;
				assert.equal(gateOutboundText(report, "restricted"), report, "verified report survives mask whitespace");
				const compound = "密码：First_123456 " + prefix + "https://example.com/Abc_123456";
				const out = gateOutboundText(compound, "restricted");
				assert.ok(!out.includes("First_123456") && !out.includes("Abc_123456"), "both values handled across whitespace");
				assert.equal(gateOutboundText(out, "restricted"), out, "stable compound result");
			}
		}
	}
});

test("a report boundary does not hide a following pasted access-token assignment", () => {
	const grant = "https://b.aliyuncs.com/r?OSSAccessKeyId=Grant123&Signature=SigValue9&Expires=1799999999";
	for (const separator of [",", ";", "，", "。", "；"]) {
		for (const secret of ["Abc_123456", "Z".repeat(205) + "9"]) {
			const out = gateOutboundText("密码：First_123456 " + grant + separator + "access_token=" + secret, "restricted");
			assert.ok(!out.includes(secret) && !out.includes("First_123456"), "both credentials removed");
			assert.equal(gateOutboundText(out, "restricted"), out, "stable delivery");
		}
	}
});

test("R4-P3: marker clearing preserves word boundaries — no synthesized labels", () => {
	// Deleting `***` spliced `pass`+`word:` into `password:` and withheld benign
	// messages; markers are now replaced with same-length spaces.
	assert.equal(gateOutboundText("pass***word:report2026.xlsx", "restricted"), "pass***word:report2026.xlsx", "delivered unchanged, same as main");
	assert.equal(gateOutboundText("api***key:report2026.xlsx", "restricted"), "api***key:report2026.xlsx", "delivered unchanged, same as main");
});

test("R4: a non-presigned URL never becomes a credential exemption", () => {
	for (const input of [
		"密码：Abc_123456https://example.com/r.md?access_token=gk_abcdef123456",
		"password***https://example.com/Abc_123456",
		"密码：***https://example.com/Abc_123456",
	]) {
		const out = gateOutboundText(input, "restricted");
		assert.ok(!out.includes("Abc_123456") && !out.includes("gk_abcdef123456"), "the URL cannot shelter a labeled value");
	}
});

test("R4: masked grant deliveries are not upgraded to withhold by the backstop", () => {
	const link = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.xlsx?OSSAccessKeyId=abcd1234&Expires=1799999999&Signature=Sig%2BValue%3D";
	// Clearing a mask must not attach the preceding label to the report URL
	// or to its Expires query parameter.
	const out = gateOutboundText(`密码：Abc_123456巡检报告链接${link}`, "restricted");
	assert.notEqual(out, CREDENTIAL_WITHHELD_NOTICE, "masked delivery stays masked");
	assert.ok(out.includes("Signature=Sig%2BValue%3D") && out.includes("Expires=1799999999"), "the full grant survives");
	assert.ok(!out.includes("Abc_123456"), "the secret is masked");
	assert.equal(gateOutboundText(out, "restricted"), out, "the delivered masked grant is stable on recheck");
});

test("M1b/M6 pins are artifact-level: masked delivery, not fail-closed withhold", () => {
	// Strengthened per round-4: the reviewer showed both pins passed under
	// mutants by withholding instead of masking. Assert the DELIVERY ARTIFACT.
	const m1b = gateOutboundText("https://b.aliyuncs.com/r?OSSAccessKeyId=k&Signature=sig&credential=Abc_123456，另外的值是Zz9!qqqq1x", "restricted");
	assert.ok(m1b.includes("credential=***"), "the non-grant param is redacted (dies if the list entry is removed)");
	assert.notEqual(m1b, CREDENTIAL_WITHHELD_NOTICE, "redaction path, not the withhold fallback");
	const m6 = gateOutboundText("password:Abc_123456私钥 是 SuperSecret99!", "restricted");
	assert.notEqual(m6, CREDENTIAL_WITHHELD_NOTICE, "iterative masking handles it in-line (dies under single-pass)");
	assert.ok(m6.includes("****") && !m6.includes("SuperSecret99") && !m6.includes("Abc_123456"), "both secrets masked in the delivered text");
});

test("AWS SigV4 grants survive verbatim with date and expiry parameters", () => {
	const aws = "https://b.s3.amazonaws.com/r.pdf?X-Amz-Credential=AKIA123%2F20261111%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261111T000000Z&X-Amz-Expires=3600&X-Amz-Signature=deadbeef00";
	assert.equal(gateOutboundText(`报告：${aws}`, "restricted"), `报告：${aws}`, "the whole SigV4 grant ships untouched");
});

test("R6-N1: label + whitespace + secret URL is MASKED in place, not delivered", () => {
	// Round-6 N1 (P0): a natural line break after a label used to exempt the
	// URL from capture entirely — the secret URL shipped while main withheld.
	// The URL is now the masked value; the message still delivers.
	const cases = [
		["密码：\nhttps://example.com/Abc_123456", "Abc_123456"],
		[`密码：${" ".repeat(13)}https://example.com/Abc_123456`, "Abc_123456"],
		// Marker glue between label and URL must not exempt the URL value.
		[`密码：${"*".repeat(7)}https://example.com/Abc_123456&password=Abc_123456`, "Abc_123456"],
		// A secret-bearing non-presigned query param rides the same rule.
		["password:\nhttps://gitee.com/x/repo/raw/master/f.xlsx?raw_with_token=GiteeTok_123456", "GiteeTok_123456"],
	];
	for (const [text, secret] of cases) {
		const out = gateOutboundText(text, "restricted");
		assert.ok(!out.includes(secret), `the URL value never reaches the group: ${text.slice(0, 30)}`);
		assert.notEqual(out, CREDENTIAL_WITHHELD_NOTICE, "masked delivery, not the withhold fallback");
		assert.ok(out.includes("脱敏"), "the masked note is appended");
		assert.equal(gateOutboundText(out, "restricted"), out, "the masked delivery is stable on recheck");
	}
	// Compound: one label already masked + a second secret URL the mask loop
	// must still catch (the old backstop-only path degraded this to withhold).
	const compound = `密码：First_123456 密码：${"*".repeat(7)}\nhttps://example.com/Abc_123456`;
	const out = gateOutboundText(compound, "restricted");
	assert.ok(!out.includes("First_123456") && !out.includes("Abc_123456"), "both secrets are masked");
	assert.notEqual(out, CREDENTIAL_WITHHELD_NOTICE, "compound still delivers masked");
});

test("R6: an over-long URL label value is still fully masked across iterations", () => {
	// The label-URL rule captures at most 200 chars; the remainder is exposed on
	// the next iteration as a plain label value and masked too. The whole URL
	// must disappear without a withhold.
	const long = `密码：\nhttps://example.com/${"x".repeat(210)}Abc_123456`;
	const out = gateOutboundText(long, "restricted");
	assert.notEqual(out, CREDENTIAL_WITHHELD_NOTICE, "iterative masking covers the unmaskable length");
	assert.ok(!out.includes("Abc_123456") && !out.includes("https://"), "no fragment of the URL value survives");
});

test("R6: a URL value reached through a prose gap degrades to withhold (residue pin)", () => {
	// Phantom alignment: the label's own value is a mask marker, and a prose
	// colon within 12 chars points at a secret URL. Masking has no zero-gap
	// separator here, so the residue re-check (no URL boundary) must withhold —
	// main withholds the same message. Kills a mutant that restores the https
	// boundary in the residue patterns (the URL would ship verbatim).
	const phantom = `密码：**** 说明如下：https://example.com/Abc_123456`;
	const out = gateOutboundText(phantom, "restricted");
	assert.equal(out, CREDENTIAL_WITHHELD_NOTICE, "gap-reached URL value is withheld like main");
});

test("R6: mixed share-link compound delivery is idempotent", () => {
	const mixed = "密码是 Abc_123456 日报已生成：https://gitee.com/xiaoliu10/repo/raw/main/report.md?access_token=gk_abcdef123456，请查收。";
	const out = gateOutboundText(mixed, "restricted");
	assert.notEqual(out, CREDENTIAL_WITHHELD_NOTICE, "the compound report still delivers");
	assert.ok(out.includes("access_token=***"), "the share-link redaction survives");
	assert.equal(gateOutboundText(out, "restricted"), out, "re-gating a delivered artifact is a no-op");
});

test("R6: arbitrary URL markers cannot exempt plaintext residue", () => {
	for (const query of ["foo=***", "access_token=***", "access_token=sekret"]) {
		for (const prefix of ["", "密码：First_123456 "]) {
			const text = `${prefix}密码：**** 说明如下：https://example.com/Abc_123456?${query}`;
			const out = gateOutboundText(text, "restricted");
			assert.ok(!out.includes("Abc_123456") && !out.includes("First_123456"), "a URL marker grants no exemption");
		}
	}
});

test("R6: a non-grant secret param inside a processed verified url cannot ride the splice", () => {
	// Two-param blind spot: a redacted param puts a marker INSIDE the verified
	// grant url, which must not hide a second, non-grant secret param from the
	// residue re-check (label value subtraction protects it from masking).
	const GL = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.xlsx?OSSAccessKeyId=abcd1234&Expires=1799999999&Signature=Sig%2BValue%3D";
	const out = gateOutboundText(`${GL}&token=sk-abcdefghijklmnopqrstuvwx&secret_key=Abc_123456`, "restricted");
	assert.ok(!out.includes("Abc_123456"), "the non-grant secret never reaches the group");
	assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwx"), "the token shape never reaches the group");
});

test("R6: a shape-masked non-grant param inside a verified url delivers masked, grant intact", () => {
	// The client_secret:sk-… composite: the shape masks the secret inside the
	// grant url; the message delivers with BOTH links intact (redact-first),
	// and the residue check must not phantom-trip on the masked param label.
	const GL = "https://bucket.oss-cn-hangzhou.aliyuncs.com/r.xlsx?OSSAccessKeyId=abcd1234&Expires=1799999999&Signature=Sig%2BValue%3D";
	const out = gateOutboundText(`${GL}&client_secret:sk-abcdefghijklmnopqrstuvwx，${GL.replace("r.xlsx", "r2.xlsx")}`, "restricted");
	assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwx"), "the secret is masked");
	assert.ok(out.includes("Signature=Sig%2BValue%3D") && out.includes("r2.xlsx"), "both grant links survive");
	assert.notEqual(out, CREDENTIAL_WITHHELD_NOTICE, "masked delivery, not withhold");
	assert.equal(gateOutboundText(out, "restricted"), out, "stable on recheck");
});
