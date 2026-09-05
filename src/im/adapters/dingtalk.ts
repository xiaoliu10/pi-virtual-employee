/**
 * DingTalk (钉钉) IM adapter — Stream mode.
 *
 * The bot opens a WebSocket to DingTalk's gateway (no public callback URL
 * needed — ideal for a desktop app). Incoming robot messages are handed to the
 * employee; replies are posted back through the per-message `sessionWebhook`
 * (valid without an access token). Sessions are keyed so that each 1:1 chat and
 * each group keeps its own conversation memory.
 *
 * On-receipt acknowledgement uses DingTalk's NATIVE emoji reaction
 * (`/v1.0/robot/emotion/reply`): a "🤔思考中" reaction is stamped onto the
 * user's message the moment it arrives, then recalled (`/emotion/recall`) once
 * the real reply is sent — the same lifecycle Lobster/OpenClaw use. This needs
 * an access_token (cached, refreshed from appKey/appSecret).
 *
 * Setup (DingTalk developer console): create an internal app → get ClientID
 * (AppKey) / ClientSecret (AppSecret) → add the Robot capability, choose Stream
 * mode, publish. Put ClientID/ClientSecret into Settings → IM.
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import type { DWClientDownStream, RobotMessage } from "dingtalk-stream";
import type { IMAdapter, IMConfig, IMIO, InboundImage } from "../types.js";
import { diag } from "../diag.js";
import type { ReportService } from "../../reports/report-service.js";

/** Robot-message payload for a picture the user sent (Stream mode). The SDK's
 *  RobotMessage type only models text, so this is a standalone shape. */
interface RobotPictureMessage {
	msgtype: "picture";
	conversationId: string;
	conversationType: string;
	senderStaffId: string;
	senderId: string;
	robotCode: string;
	msgId: string;
	sessionWebhook: string;
	text?: { content?: string };
	content?: { downloadCode?: string; pictureDownloadCode?: string };
	downloadCode?: string;
}

/** Either a text or picture inbound robot message — enough to route a reply. */
type AnyRobotMsg = RobotMessage | RobotPictureMessage;

/** "Thinking" text-emoji metadata accepted by DingTalk's emotion API. */
const THINKING_EMOTION = {
	emotionType: 2,
	emotionName: "🤔思考中",
	textEmotion: { emotionId: "2659900", emotionName: "🤔思考中", text: "🤔思考中", backgroundId: "im_bg_1" },
};

interface EmotionTarget {
	robotCode: string;
	openMsgId: string;
	openConversationId: string;
}

/** Map a file extension to an image MIME type (defaults to png). */
function mimeFromExt(ext: string): string {
	switch ((ext || "").toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".bmp":
			return "image/bmp";
		default:
			return "image/png";
	}
}

/** Plain-text digest of a Markdown reply, for the DingTalk message-list preview. */
function digestTitle(markdown: string): string {
	const firstLine = markdown
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0) ?? "回复";
	const stripped = firstLine.replace(/[#*`>_~\[\]]/g, "").replace(/\s+/g, " ").trim();
	return (stripped || "回复").slice(0, 50);
}

/**
 * DingTalk's markdown renderer does NOT support pipe tables — `| a | b |`
 * lines render as one unreadable run. Rewrite every table block into bullet
 * lines (`- 列名：值　列名：值`); everything else passes through untouched.
 * Applied at both send points (session reply + proactive push).
 */
function flattenMarkdownTables(markdown: string): string {
	const src = markdown.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	for (let i = 0; i < src.length; i++) {
		const line = src[i].trim();
		// Table block: header row, a |---| separator row, then data rows.
		if (/^\|.+\|\s*$/.test(line) && i + 1 < src.length && /^\|[\s:|-]+\|\s*$/.test(src[i + 1].trim())) {
			const splitRow = (l: string): string[] =>
				l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
			const headers = splitRow(line);
			i += 2; // skip header + separator
			const rows: string[][] = [];
			while (i < src.length && /^\|.+\|\s*$/.test(src[i].trim())) {
				rows.push(splitRow(src[i].trim()));
				i++;
			}
			i--; // loop increment moves past the block
			out.push("");
			for (const row of rows) {
				const pairs = headers.map((h, idx) => (h ? `${h}：${row[idx] ?? ""}` : row[idx] ?? "")).filter(Boolean);
				out.push(pairs.length ? `- ${pairs.join("　")}` : "");
			}
			out.push("");
			continue;
		}
		out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Routing info needed to deliver a reply — the session webhook for the
 *  native-markdown fallback, plus the ids the interactive-card API needs. */
interface ReplyRoute {
	webhook: string;
	isSingle: boolean;
	/** 1:1 recipient staff id (senderStaffId/senderId). */
	userId?: string;
	/** Group openConversationId (msg.conversationId in stream mode). */
	openConversationId?: string;
}

/**
 * Official DingTalk AI-card streaming template (the one the current
 * openclaw-channel-dingtalk connector ships — card templates are bound to an
 * app at creation time, but this one works as a system shared template for any
 * app with the card permissions enabled; verified by
 * scripts/test-dingtalk-card.mjs). Streaming markdown component is bound to
 * the `content` variable, rendered with the FULL GFM engine (tables/alignment
 * render natively — unlike the castrated native-markdown renderer).
 */
const AI_CARD_TEMPLATE_ID = "675cde2f-f526-40cb-b828-f5b2b57b8b77.schema";

/**
 * DingTalk's AI-card markdown renderer refuses to render a table whose first
 * row directly follows a text line (same pitfall 现场 patches). Ensure a
 * blank line precedes every table block — a pure text transform, safe to run
 * on any reply.
 */
export function ensureMarkdownTableBlankLines(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const isTableRow = /^\s*\|.*\|\s*$/.test(line);
		const prev = out[out.length - 1] ?? "";
		if (isTableRow && prev.trim() !== "" && !/^\s*\|.*\|\s*$/.test(prev)) {
			out.push("");
		}
		out.push(line);
	}
	return out.join("\n");
}

export class DingtalkAdapter implements IMAdapter {
	readonly channel = "dingtalk";
	private client?: DWClient;
	private appId = "";
	private appSecret = "";
	/**
	 * Optional custom interactive-card template id. When empty, the official AI
	 * card template (AI_CARD_TEMPLATE_ID) is used — card-first is the default.
	 * Cards render full GFM (tables natively); native markdown messages with
	 * tables flattened to lists are the fallback path.
	 */
	private cardTemplateId = "";
	private token: { value: string; expiresAt: number } | null = null;

	constructor(private readonly reportService?: ReportService) {}

	async start(io: IMIO, config: IMConfig): Promise<void> {
		if (!config.appId || !config.appSecret) {
			throw new Error("DingTalk adapter requires appId (ClientID) and appSecret (ClientSecret)");
		}
		this.appId = config.appId;
		this.appSecret = config.appSecret;
		this.cardTemplateId = (config.cardTemplateId ?? "").trim() || AI_CARD_TEMPLATE_ID;

		const client = new DWClient({
			clientId: config.appId,
			clientSecret: config.appSecret,
			keepAlive: true,
		});
		// Avoid an unhandled 'error' event crashing the process.
		client.on("error", (err) => console.error("[im:dingtalk] client error", err));

		client.registerCallbackListener(TOPIC_ROBOT, async (res: DWClientDownStream) => {
			// ACK the stream message immediately so DingTalk doesn't re-push it
			// while the (slow) model call runs.
			client.socketCallBackResponse(res.headers.messageId, {});

			let msg: AnyRobotMsg;
			try {
				msg = JSON.parse(res.data) as AnyRobotMsg;
			} catch {
				return;
			}

			const text = msg.text?.content?.trim() ?? "";
			// Inbound images arrive as msgtype "picture" with a downloadCode; fetch
			// the bytes so a vision model can see them. Image-only messages carry no
			// text — supply a short prompt so the model knows a photo arrived.
			let images: InboundImage[] | undefined;
			if (msg.msgtype === "picture") {
				const pic = msg as RobotPictureMessage;
				const downloadCode = pic.content?.downloadCode ?? pic.content?.pictureDownloadCode ?? pic.downloadCode;
				if (downloadCode) {
					const fetched = await this.downloadInboundImage(downloadCode, pic.robotCode).catch((err) => {
						console.warn("[im:dingtalk] inbound image download failed:", (err as Error).message);
						return null;
					});
					if (fetched) images = [fetched];
				}
			}
			const hasImage = !!images?.length;
			if (!text && !hasImage) return;
			const promptText = text || (hasImage ? "（用户发来一张图片，请查看图片内容并按需要回应）" : "");

			// Session isolation: 1:1 → per sender; group → per conversation.
			const conversationId =
				msg.conversationType === "1"
					? `dt:${msg.senderStaffId || msg.senderId}`
					: `dt:group:${msg.conversationId}`;

			// Native emoji reaction on receipt (🤔思考中), recalled after the reply
			// is sent. Skipped for slash commands. Non-fatal: reactions are cosmetic.
			const isCommand = text.startsWith("/");
			const ackOn = !isCommand && !!config.ack?.enabled;
			const target: EmotionTarget | null =
				ackOn && msg.msgId && msg.conversationId && msg.robotCode
					? { robotCode: msg.robotCode, openMsgId: msg.msgId, openConversationId: msg.conversationId }
					: null;
			if (target) await this.emotionReply(target).catch(() => {});

			try {
				const reply = await io.handle(
					{
							conversationId,
							text: promptText,
							images,
							actor: {
								senderId: msg.senderStaffId || msg.senderId || "",
								channel: "dingtalk",
								chatType: msg.conversationType === "1" ? "single" : "group",
							},
						},
					{
						// Push mid-turn progress (e.g. long-task heartbeat) back through the
						// same session webhook as a lightweight markdown message — never as a
						// card, so a long turn doesn't flood the chat with stacked cards.
						onProgress: async (progressText) => {
							if (msg.sessionWebhook) await this.reply(msg.sessionWebhook, progressText);
						},
						// Deliver a file into this chat as a robot file message (used by the
						// provide_document tool). On any failure the tool falls back to an
						// archived-path notice, so this never breaks the reply.
						sendFile: (filePath, fileName) => this.sendFileFor(msg, filePath, fileName),
						// Deliver an inline image into this chat (used by the send_image tool).
						sendImage: (filePath) => this.sendImageFor(msg, filePath),
					},
				);
				if (msg.sessionWebhook && reply) await this.deliverReply(reply, this.routeFromMsg(msg));
			} catch (err) {
				console.error("[im:dingtalk] handle/reply failed", err);
				void diag("dingtalk", `handle/reply failed: ${(err as Error).message}`, "warn");
			} finally {
				if (target) await this.emotionRecall(target).catch(() => {});
			}
		});

		await client.connect();
		this.client = client;
		console.log("[im:dingtalk] stream connected");
	}

	async stop(): Promise<void> {
		this.client?.disconnect();
		this.client = undefined;
	}

	/** Reply through the robot's temporary session webhook (no access token).
	 * Sent as Markdown so headings/bold/lists render in DingTalk; the title is a
	 * plain-text digest used for the message-list preview and push notification.
	 * Tables are flattened to lists — the native markdown renderer can't draw
	 * pipe tables. */
	private async reply(webhook: string, text: string): Promise<void> {
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ msgtype: "markdown", markdown: { title: digestTitle(text), text: flattenMarkdownTables(text) } }),
		});
		if (!res.ok) void diag("dingtalk", `reply failed: HTTP ${res.status}`, "warn");
	}

	/** Build the card/markdown routing info from an inbound stream message. */
	private routeFromMsg(msg: AnyRobotMsg): ReplyRoute {
		const isSingle = msg.conversationType === "1";
		return {
			webhook: msg.sessionWebhook,
			isSingle,
			userId: isSingle ? msg.senderStaffId || msg.senderId : undefined,
			openConversationId: isSingle ? undefined : msg.conversationId,
		};
	}

	/**
	 * Deliver a reply as an interactive card when a template is configured
	 * (full GFM renderer — tables/alignment render natively); fall back to the
	 * native markdown webhook message (tables flattened) when no template is set
	 * or the card send fails (missing permission, bad template id, …). The
	 * fallback keeps every reply deliverable regardless of card-platform state.
	 */
	private async deliverReply(text: string, route: ReplyRoute): Promise<void> {
		if (this.cardTemplateId) {
			const ok = await this.sendInteractiveCard(text, {
				isSingle: route.isSingle,
				userId: route.userId,
				openConversationId: route.openConversationId,
			}).catch((err) => {
				void diag("dingtalk", `interactive card send failed, falling back to markdown: ${(err as Error).message}`, "warn");
				return false;
			});
			if (ok) return;
		}
		await this.reply(route.webhook, text);
	}

	/**
	 * Send one AI card (openclaw-channel-dingtalk-style streaming chain),
	 * defaulting to the plugin's current built-in template (no manual template
	 * setup required). The request body mirrors that connector's working
	 * implementation field-for-field (verified via scripts/test-dingtalk-card.mjs
	 * — the old conversationType/receiverUserIdList shape gets HTTP 400
	 * MissingopenSpaceId, and openSpaceId alone without the space/deliver models
	 * silently drops the delivery):
	 *
	 * 1. Create + deliver the card instance via
	 *    POST /v1.0/card/instances/createAndDeliver. The target space is encoded
	 *    in openSpaceId (IM_ROBOT.{userId} single / IM_GROUP.{openConversationId}
	 *    group) together with its OpenSpaceModel + DeliverModel.
	 * 2. Push the full content as ONE streaming frame with isFinalize=true
	 *    (PUT /v1.0/card/streaming, key "content", isFull=true — mandatory for
	 *    markdown variables). This flips the card from 输入中 to 完成 and runs
	 *    the full GFM renderer (tables render natively).
	 *
	 * Requires "互动卡片实例写权限" (Card.Instance.Write) + "AI卡片流式更新权限"
	 * (Card.Streaming.Write) on the app. Throws on failure (including a failed
	 * per-space entry in deliverResults) so callers can fall back to the native
	 * markdown message.
	 */
	private async sendInteractiveCard(
		text: string,
		target: { isSingle: boolean; userId?: string; openConversationId?: string },
	): Promise<boolean> {
		const token = await this.accessToken();
		const content = ensureMarkdownTableBlankLines(text);
		const deliverExtension = { dynamicSummary: "true" };
		if (target.isSingle) {
			if (!target.userId) throw new Error("卡片发送缺少 userId");
		} else {
			if (!target.openConversationId) throw new Error("卡片发送缺少 openConversationId");
		}
		const body: Record<string, unknown> = {
			cardTemplateId: this.cardTemplateId,
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
			openSpaceId: target.isSingle
				? `dtv1.card//IM_ROBOT.${target.userId}`
				: `dtv1.card//IM_GROUP.${target.openConversationId}`,
			userIdType: 1,
			...(target.isSingle
				? { imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode: this.appId, extension: deliverExtension } }
				: { imGroupOpenDeliverModel: { robotCode: this.appId, extension: deliverExtension } }),
		};
		const res = await fetch("https://api.dingtalk.com/v1.0/card/instances/createAndDeliver", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`createAndDeliver HTTP ${res.status}: ${detail.slice(0, 200)}`);
		}
		// HTTP 200 ≠ delivered: each space has its own success/errorMsg.
		const deliverResults = ((await res.json().catch(() => ({}))) as {
			result?: { deliverResults?: Array<{ success?: boolean; spaceType?: string; errorMsg?: string }> };
		})?.result?.deliverResults;
		const failed = deliverResults?.find((r) => r?.success === false);
		if (failed) throw new Error(`投放失败 ${failed.spaceType ?? ""}: ${failed.errorMsg ?? "unknown"}`.trim());
		// Finalize in one full frame — the card goes 输入中 → 完成 with full GFM.
		const streamRes = await fetch("https://api.dingtalk.com/v1.0/card/streaming", {
			method: "PUT",
			headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
			body: JSON.stringify({
				outTrackId: body.outTrackId,
				guid: randomUUID(),
				key: "content",
				content,
				isFull: true,
				isFinalize: true,
			}),
		});
		if (!streamRes.ok) {
			const detail = await streamRes.text().catch(() => "");
			throw new Error(`card/streaming HTTP ${streamRes.status}: ${detail.slice(0, 200)}`);
		}
		void diag("dingtalk", `AI card delivered (${target.isSingle ? "single" : "group"}, template ${this.cardTemplateId})`);
		return true;
	}

	/**
	 * Deliver a local file into the chat as a robot file message. Upload the file
	 * (robot messageFiles API → downloadCode), then send a `sampleFile` message to
	 * the originating conversation. Group → groupMessages/send; single (1:1) →
	 * oToMessages/batchSend. Requires the "机器人消息发送/文件" permissions on the app.
	 * Any step failing returns {ok:false,error} so the caller can fall back to an
	 * archived-path notice — this must never break the reply.
	 */
	private async sendFileFor(msg: AnyRobotMsg, filePath: string, fileName: string): Promise<{ ok: boolean; error?: string }> {
		try {
			if (!msg.robotCode) return { ok: false, error: "缺少 robotCode" };
			const downloadCode = await this.uploadFile(msg.robotCode, filePath, fileName);
			await this.sendFileMessage(downloadCode, msg);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** Upload a file via the robot messageFiles API and return its downloadCode. */
	private async uploadFile(robotCode: string, filePath: string, fileName: string): Promise<string> {
		const token = await this.accessToken();
		const buffer = await readFile(filePath);
		const form = new FormData();
		form.append("robotCode", robotCode);
		form.append("file", new Blob([buffer]), fileName);
		const res = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/upload", {
			method: "POST",
			headers: { "x-acs-dingtalk-access-token": token },
			body: form,
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`文件上传失败 HTTP ${res.status}: ${detail.slice(0, 200)}`);
		}
		const data = (await res.json()) as { downloadCode?: string };
		if (!data.downloadCode) throw new Error("文件上传未返回 downloadCode");
		return data.downloadCode;
	}

	/**
	 * Fetch a picture the user sent to the robot. The inbound callback carries a
	 * temporary downloadCode; exchange it for a short-lived downloadUrl, then read
	 * the bytes. Returns base64 + MIME for the vision model, or null on failure.
	 */
	private async downloadInboundImage(downloadCode: string, robotCode: string): Promise<InboundImage | null> {
		const token = await this.accessToken();
		const res = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
			body: JSON.stringify({ downloadCode, robotCode }),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`messageFiles/download HTTP ${res.status}: ${detail.slice(0, 200)}`);
		}
		const { downloadUrl } = (await res.json()) as { downloadUrl?: string };
		if (!downloadUrl) throw new Error("messageFiles/download 未返回 downloadUrl");
		const fileRes = await fetch(downloadUrl);
		if (!fileRes.ok) throw new Error(`下载图片失败 HTTP ${fileRes.status}`);
		const buf = Buffer.from(await fileRes.arrayBuffer());
		const mime = (fileRes.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
		return { data: buf.toString("base64"), mimeType: mime };
	}

	/**
	 * Deliver a local image into the chat as an inline image message. Upload the
	 * image to the configured report publisher to get a public URL, then send a
	 * `sampleImageMsg` (photoURL) to the originating conversation. Returns
	 * {ok:false} (never throws) when the publisher is unconfigured or the send
	 * fails — the send_image tool then degrades to a text notice.
	 */
	private async sendImageFor(msg: AnyRobotMsg, filePath: string): Promise<{ ok: boolean; url?: string; error?: string }> {
		try {
			if (!this.reportService) return { ok: false, error: "未配置图片存储（报告中心）" };
			const st = await stat(filePath);
			if (!st.isFile()) return { ok: false, error: "不是有效文件" };
			const buffer = await readFile(filePath);
			const mime = mimeFromExt(extname(filePath));
			const published = await this.reportService.publishImage(buffer, mime, `${msg.robotCode || "image"}-${Date.now()}${extname(filePath) || ".png"}`);
			if (!published?.url) return { ok: false, error: "图片上传失败（报告中心未配置或不可用）" };
			await this.sendProactive({
				isSingle: msg.conversationType === "1",
				msgKey: "sampleImageMsg",
				msgParam: JSON.stringify({ photoURL: published.url }),
				robotCode: msg.robotCode,
				userIds: msg.conversationType === "1" ? [msg.senderStaffId || msg.senderId || ""] : undefined,
				openConversationId: msg.conversationType === "1" ? undefined : msg.conversationId,
			});
			return { ok: true, url: published.url };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** Send a sampleFile message to the conversation the inbound message came from. */
	private async sendFileMessage(downloadCode: string, msg: AnyRobotMsg): Promise<void> {
		const isSingle = msg.conversationType === "1";
		await this.sendProactive({
			isSingle,
			msgKey: "sampleFile",
			msgParam: JSON.stringify({ downloadCode }),
			robotCode: msg.robotCode,
			userIds: isSingle ? [msg.senderStaffId || msg.senderId || ""] : undefined,
			openConversationId: isSingle ? undefined : msg.conversationId,
		});
	}

	/**
	 * Low-level proactive message send — no inbound message required. Group →
	 * groupMessages/send (needs openConversationId); 1:1 → oToMessages/batchSend
	 * (needs userIds). Shared by file delivery and the scheduled-task result push.
	 * robotCode defaults to this app's ClientID. Throws on HTTP failure with a
	 * truncated body so callers can log the reason.
	 */
	private async sendProactive(opts: {
		isSingle: boolean;
		msgKey: string;
		msgParam: string;
		robotCode?: string;
		userIds?: string[];
		openConversationId?: string;
	}): Promise<void> {
		const token = await this.accessToken();
		const robotCode = opts.robotCode || this.appId;
		const url = opts.isSingle
			? "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"
			: "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
		const body = opts.isSingle
			? { msgParam: opts.msgParam, msgKey: opts.msgKey, userIds: opts.userIds ?? [], robotCode }
			: { msgParam: opts.msgParam, msgKey: opts.msgKey, openConversationId: opts.openConversationId, robotCode };
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`消息发送失败 HTTP ${res.status}: ${detail.slice(0, 200)}`);
		}
	}

	/**
	 * Proactively push a Markdown message to a DingTalk conversation with no inbound
	 * message — used to deliver scheduled-task results back to the group/1:1 that
	 * created the task. `conversationId` is the app-internal id:
	 * "dt:group:<openConversationId>" (group) or "dt:<staffId>" (1:1). Returns
	 * ok:false rather than throwing when the id isn't a DingTalk conversation or the
	 * send fails, so the scheduler can log and move on. Needs the robot
	 * message-send permission on the app (same as file sending).
	 */
	async push(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }> {
		try {
			if (!this.appId) return { ok: false, error: "dingtalk 未配置 appId" };
			if (!text.trim()) return { ok: false, error: "推送内容为空" };
			const isGroup = conversationId.startsWith("dt:group:");
			const isSingle = !isGroup && conversationId.startsWith("dt:");
			if (!isGroup && !isSingle) {
				return { ok: false, error: `非钉钉会话，无法推送：${conversationId}` };
			}
			const openConversationId = isGroup ? conversationId.slice("dt:group:".length) : undefined;
			const userId = isSingle ? conversationId.slice("dt:".length) : undefined;
			if (isGroup && !openConversationId) return { ok: false, error: "缺少 openConversationId" };
			if (isSingle && !userId) return { ok: false, error: "缺少 userId" };

			// Preferred path: interactive card with the full GFM renderer (tables
			// render natively). Fall back to the native markdown message (tables
			// flattened to lists) when no template is set or the card send fails.
			if (this.cardTemplateId) {
				const cardOk = await this.sendInteractiveCard(text, {
					isSingle,
					userId,
					openConversationId,
			}).catch((err) => {
				void diag("dingtalk", `push interactive card failed, falling back to markdown: ${(err as Error).message}`, "warn");
				return false;
			});
				if (cardOk) return { ok: true };
			}

			const msgParam = JSON.stringify({ title: digestTitle(text), text: flattenMarkdownTables(text) });
			await this.sendProactive({
				isSingle,
				msgKey: "sampleMarkdown",
				msgParam,
				userIds: userId ? [userId] : undefined,
				openConversationId,
			});
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** Cached DingTalk access_token (refreshes ~5 min before expiry). */
	private async accessToken(): Promise<string> {
		const now = Date.now();
		if (this.token && this.token.expiresAt - now > 5 * 60_000) return this.token.value;
		const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ appKey: this.appId, appSecret: this.appSecret }),
		});
		if (!res.ok) throw new Error(`accessToken HTTP ${res.status}`);
		const data = (await res.json()) as { accessToken?: string; expireIn?: number };
		if (!data.accessToken) throw new Error("accessToken missing in response");
		this.token = { value: data.accessToken, expiresAt: now + (data.expireIn ?? 7200) * 1000 };
		return this.token.value;
	}

	/**
	 * Call the emotion API. The body shape is identical for reply and recall —
	 * recall needs the full emotion descriptor to identify which reaction to
	 * remove (a body with only the ids returns HTTP 500).
	 */
	private async callEmotion(endpoint: "reply" | "recall", target: EmotionTarget): Promise<number> {
		const token = await this.accessToken();
		const res = await fetch(`https://api.dingtalk.com/v1.0/robot/emotion/${endpoint}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-acs-dingtalk-access-token": token,
			},
			body: JSON.stringify({ ...target, ...THINKING_EMOTION }),
		});
		if (!res.ok) console.warn(`[im:dingtalk] emotion/${endpoint} HTTP ${res.status}`);
		return res.status;
	}

	/** Stamp the "thinking" emoji reaction onto a message. */
	private async emotionReply(target: EmotionTarget): Promise<void> {
		await this.callEmotion("reply", target);
	}

	/**
	 * Remove the bot's reaction once the reply landed. Recall can race with a
	 * just-arrived inbound message (DingTalk returns 500 transiently), so retry
	 * once after a short delay on a server error.
	 */
	private async emotionRecall(target: EmotionTarget): Promise<void> {
		const status = await this.callEmotion("recall", target);
		if (status >= 500) {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			await this.callEmotion("recall", target);
		}
	}
}
