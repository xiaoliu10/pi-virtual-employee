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
import { readFile } from "node:fs/promises";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import type { DWClientDownStream, RobotMessage } from "dingtalk-stream";
import type { IMAdapter, IMConfig, IMIO } from "../types.js";

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

/** Plain-text digest of a Markdown reply, for the DingTalk message-list preview. */
function digestTitle(markdown: string): string {
	const firstLine = markdown
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0) ?? "回复";
	const stripped = firstLine.replace(/[#*`>_~\[\]]/g, "").replace(/\s+/g, " ").trim();
	return (stripped || "回复").slice(0, 50);
}

export class DingtalkAdapter implements IMAdapter {
	readonly channel = "dingtalk";
	private client?: DWClient;
	private appId = "";
	private appSecret = "";
	private token: { value: string; expiresAt: number } | null = null;

	async start(io: IMIO, config: IMConfig): Promise<void> {
		if (!config.appId || !config.appSecret) {
			throw new Error("DingTalk adapter requires appId (ClientID) and appSecret (ClientSecret)");
		}
		this.appId = config.appId;
		this.appSecret = config.appSecret;

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

			let msg: RobotMessage;
			try {
				msg = JSON.parse(res.data) as RobotMessage;
			} catch {
				return;
			}

			const text = msg.text?.content?.trim();
			if (!text) return;

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
					{ conversationId, text },
					{
						// Push mid-turn progress (e.g. long-task heartbeat) back through the
						// same session webhook (valid ~2h), rendered as Markdown like replies.
						onProgress: async (progressText) => {
							if (msg.sessionWebhook) await this.reply(msg.sessionWebhook, progressText);
						},
						// Deliver a file into this chat as a robot file message (used by the
						// provide_document tool). On any failure the tool falls back to an
						// archived-path notice, so this never breaks the reply.
						sendFile: (filePath, fileName) => this.sendFileFor(msg, filePath, fileName),
					},
				);
				if (msg.sessionWebhook && reply) await this.reply(msg.sessionWebhook, reply);
			} catch (err) {
				console.error("[im:dingtalk] handle/reply failed", err);
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
	 * plain-text digest used for the message-list preview and push notification. */
	private async reply(webhook: string, text: string): Promise<void> {
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ msgtype: "markdown", markdown: { title: digestTitle(text), text } }),
		});
		if (!res.ok) console.warn(`[im:dingtalk] reply failed: HTTP ${res.status}`);
	}

	/**
	 * Deliver a local file into the chat as a robot file message. Upload the file
	 * (robot messageFiles API → downloadCode), then send a `sampleFile` message to
	 * the originating conversation. Group → groupMessages/send; single (1:1) →
	 * oToMessages/batchSend. Requires the "机器人消息发送/文件" permissions on the app.
	 * Any step failing returns {ok:false,error} so the caller can fall back to an
	 * archived-path notice — this must never break the reply.
	 */
	private async sendFileFor(msg: RobotMessage, filePath: string, fileName: string): Promise<{ ok: boolean; error?: string }> {
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

	/** Send a sampleFile message to the conversation the inbound message came from. */
	private async sendFileMessage(downloadCode: string, msg: RobotMessage): Promise<void> {
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
			const msgParam = JSON.stringify({ title: digestTitle(text), text });
			if (conversationId.startsWith("dt:group:")) {
				const openConversationId = conversationId.slice("dt:group:".length);
				if (!openConversationId) return { ok: false, error: "缺少 openConversationId" };
				await this.sendProactive({ isSingle: false, msgKey: "sampleMarkdown", msgParam, openConversationId });
			} else if (conversationId.startsWith("dt:")) {
				const userId = conversationId.slice("dt:".length);
				if (!userId) return { ok: false, error: "缺少 userId" };
				await this.sendProactive({ isSingle: true, msgKey: "sampleMarkdown", msgParam, userIds: [userId] });
			} else {
				return { ok: false, error: `非钉钉会话，无法推送：${conversationId}` };
			}
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
