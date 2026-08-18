/**
 * IM adapter abstraction.
 *
 * An IM channel is an inbound transport: it receives a message, hands it to the
 * employee via {@link IMIO.handle}, and delivers the reply back to the channel.
 * This round ships the abstraction + registry + an `echo` adapter to prove the
 * pipeline; real channels (Feishu/DingTalk) plug in later as new adapters.
 */
export interface IMConfig {
	channel: string;
	appId: string;
	appSecret: string;
	/** On-receipt ack (instant short reply before the model runs). Channel-agnostic. */
	ack?: { enabled: boolean; text: string };
}

/** A base64 image attached to an inbound message (decoded by the adapter). */
export interface InboundImage {
	data: string;
	mimeType: string;
}

export interface InboundActor {
	/** Stable platform user id (e.g. DingTalk senderStaffId). */
	senderId: string;
	/** Source channel, used for audit details and future per-channel policies. */
	channel: string;
	/** Admin operations are allowed only in a direct 1:1 chat. */
	chatType: "single" | "group";
}

export interface InboundMessage {
	conversationId: string;
	text: string;
	/** Verified sender metadata supplied by the adapter, never parsed from text. */
	actor?: InboundActor;
	/** Images the user sent with this message (vision models can see them). */
	images?: InboundImage[];
}

/** Per-message channel context: hooks the adapter exposes for a single inbound
 *  message, so the engine/manager can push mid-turn updates (e.g. a long-task
 *  progress heartbeat) back to that same chat. */
export interface InboundCtx {
	/** Push an arbitrary text update to the originating chat mid-turn. */
	onProgress?: (text: string) => Promise<void>;
	/**
	 * Deliver a file into the originating chat (when the channel supports it,
	 * e.g. DingTalk robot file message). Threads through to the provide_document
	 * tool. Channels that can't send files omit this → the tool degrades to an
	 * archived-path notice. Structurally matches DocumentService.FileSender.
	 */
	sendFile?: (filePath: string, fileName: string) => Promise<{ ok: boolean; error?: string }>;
	/**
	 * Deliver an image into the originating chat as an inline image message (when
	 * the channel supports it, e.g. DingTalk sampleImageMsg). The adapter uploads
	 * the file to a public host and sends the link. Threads through to the
	 * send_image tool. Channels that can't send images omit this → the tool
	 * degrades to a text notice.
	 */
	sendImage?: (filePath: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
}

export interface IMIO {
	/** Run an inbound message through the employee and return the reply text.
	 *  `ctx` carries optional channel hooks (e.g. progress push) for this message. */
	handle(msg: InboundMessage, ctx?: InboundCtx): Promise<string>;
}

export interface IMAdapter {
	readonly channel: string;
	start(io: IMIO, config: IMConfig): Promise<void>;
	stop(): Promise<void>;
	/**
	 * Proactively push a message to a conversation with no inbound message (e.g. a
	 * scheduled-task result). Optional — channels that can't initiate omit it.
	 * Returns ok:false (never throws) when the conversationId isn't handled by this
	 * channel or the send fails, so callers can log and move on.
	 */
	push?(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>;
}
