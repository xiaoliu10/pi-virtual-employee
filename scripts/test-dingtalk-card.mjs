#!/usr/bin/env node
/**
 * 钉钉 AI 卡片探针 — 不依赖本 app，直接验证「卡片权限 + AI 卡片模板」对给定
 * app 是否可用。用于定位"回复里的表格没渲染"（卡片链路静默降级）类问题。
 *
 * 请求体逐字段对齐 openclaw-channel-dingtalk 插件的可工作实现（含
 * openSpaceId 场域、OpenSpaceModel、DeliverModel、callbackType=STREAM）。
 *
 * 用法:
 *   node scripts/test-dingtalk-card.mjs <appKey> <appSecret> <userId>        # 1:1 单聊
 *   node scripts/test-dingtalk-card.mjs <appKey> <appSecret> <openConversationId> group
 *
 * appKey/appSecret = 开发者后台该应用的 ClientID/ClientSecret；单聊传接收人的
 * userId（staffId），群聊传群的 openConversationId 并加 `group` 参数。
 */
const [appKey, appSecret, target, isGroupArg] = process.argv.slice(2);
if (!appKey || !appSecret || !target) {
	console.error("用法: node scripts/test-dingtalk-card.mjs <appKey> <appSecret> <userId|openConversationId> [group]");
	process.exit(1);
}
const isGroup = isGroupArg === "group";
// 当前 openclaw-channel-dingtalk 插件内置模板（旧版 02fcf2f4 已废弃）
const TEMPLATE_ID = "675cde2f-f526-40cb-b828-f5b2b57b8b77.schema";
const { randomUUID } = await import("node:crypto");

async function call(label, url, method, body, token) {
	const res = await fetch(url, {
		method,
		headers: { "Content-Type": "application/json", ...(token ? { "x-acs-dingtalk-access-token": token } : {}) },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	console.log(`\n== ${label} → HTTP ${res.status}`);
	console.log(text || "(empty body)");
	return { ok: res.ok, text };
}

const { ok: tokenOk, text: tokenBody } = await call(
	"accessToken",
	"https://api.dingtalk.com/v1.0/oauth2/accessToken",
	"POST",
	{ appKey, appSecret },
);
if (!tokenOk) process.exit(2);
const accessToken = JSON.parse(tokenBody).accessToken;

// 表格前留空行——钉钉 AI 卡片渲染表格的已知坑。
const content = [
	"AI 卡片链路探针：如果你看到下面是表格，说明卡片链路正常。",
	"",
	"| 项目 | 值 |",
	"| --- | --- |",
	"| 状态 | 探针测试 |",
	"| 结论 | 表格应原生渲染 |",
].join("\n");

// 请求体逐字段对齐 soimy/openclaw-channel-dingtalk src/card-service.ts 的可工作实现。
const createBody = {
	cardTemplateId: TEMPLATE_ID,
	outTrackId: randomUUID(),
	cardData: {
		cardParamMap: {
			config: JSON.stringify({ autoLayout: true, enableForward: true }),
			content: "",
			flowStatus: "2", // INPUTING
			hasAction: "true",
			stop_action: "true",
		},
	},
	callbackType: "STREAM",
	imGroupOpenSpaceModel: { supportForward: true },
	imRobotOpenSpaceModel: { supportForward: true },
	openSpaceId: isGroup ? `dtv1.card//IM_GROUP.${target}` : `dtv1.card//IM_ROBOT.${target}`,
	userIdType: 1,
	...(isGroup
		? { imGroupOpenDeliverModel: { robotCode: appKey, extension: { dynamicSummary: "true" } } }
		: { imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode: appKey, extension: { dynamicSummary: "true" } } }),
};

const { ok: createOk, text: createText } = await call(
	"card/instances/createAndDeliver",
	"https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",
	"POST",
	createBody,
	accessToken,
);
if (!createOk) {
	console.error("\n结论: createAndDeliver 失败 —— 上面的 code/message 就是根因（模板不可用或权限未生效）。");
	process.exit(3);
}
// HTTP 200 不等于投放成功——deliverResults 里每场域各有 success/errorMsg。
try {
	const results = JSON.parse(createText)?.result?.deliverResults ?? [];
	const failed = results.find((r) => r?.success === false);
	if (failed) {
		console.error(`\n结论: 场域投放失败（${failed.spaceType}/${failed.spaceId}）: ${failed.errorMsg}`);
		process.exit(3);
	}
} catch { /* 解析失败交由 streaming 步骤暴露 */ }

const stream = await call("card/streaming", "https://api.dingtalk.com/v1.0/card/streaming", "PUT", {
	outTrackId: createBody.outTrackId,
	guid: randomUUID(),
	key: "content",
	content,
	isFull: true,
	isFinalize: true,
}, accessToken);
if (!stream.ok) process.exit(4);
console.log("\n结论: 创建、投放、流式更新全部成功。看钉钉——应收到一张带表格的卡片。");
