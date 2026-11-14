/**
 * ACP (Agent Client Protocol) transport — Streamable HTTP listener.
 *
 * Lets an external ACP client (Synapse) drive THIS employee over a fixed
 * loopback port with a Bearer token. Design doc: synapse docs/design/ve-acp-integration.md.
 *
 * Trust model (see history-store `acp:` origin + config security.people):
 *  - every ACP turn runs as ONE fixed service-account actor
 *    (`config.acp.actorStaffId`, channel "acp"); its role is resolved through
 *    the normal security.people path — no immutable RBAC region is touched;
 *  - ACP conversation ids are `acp:<uuid>`: remote, never console, so a missing
 *    actor can never silently inherit the local console's implicit admin;
 *  - the token gates the listener itself (constant-time compare, loopback).
 *
 * v1 scope: no in-ve request_permission hook — the service account is expected
 * to be admin in security.people and the CLIENT owns interactive approval
 * before sending a prompt. All shell execution still writes shell-audit.log.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { agent } from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";

import type { EmployeeEngine } from "../engine/engine.js";
import type { TurnProcessEvent } from "../engine/engine.js";
import type { InboundActor } from "../im/types.js";

export interface AcpTransportConfig {
	port: number;
	/** Required; an empty token refuses to start. */
	token: string;
	actorStaffId: string;
	actorName: string;
	/** Displayed in initialize's agentInfo. */
	profileId: string;
	appVersion: string;
}

export interface StartedAcpTransport {
	server: Server;
	port: number;
}

const BEARER = /^Bearer\s+(.+)$/i;
const MAX_BODY_BYTES = 1024 * 1024; // ACP frames are prompt-sized; 1 MiB ceiling.
const ACP_PATH = "/acp";

function tokenMatches(presented: string, expected: string): boolean {
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Extract plain text from ACP prompt content blocks (text only for v1). */
function promptText(prompt: unknown): string {
	if (typeof prompt === "string") return prompt;
	if (!Array.isArray(prompt)) return "";
	return prompt
		.map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text"
			? String((block as { text?: unknown }).text ?? "")
			: ""))
		.join("")
		.trim();
}

export async function startAcpTransport(
	engine: EmployeeEngine,
	cfg: AcpTransportConfig,
): Promise<StartedAcpTransport> {
	if (!cfg.token.trim()) throw new Error("ACP 已启用但未设置访问令牌，服务拒绝启动（防止开放中继）");

	// ACP session id -> ve conversation id. Conversations are created eagerly in
	// session/new so the acp: origin (trust boundary) is persisted before any turn.
	const conversations = new Map<string, string>();

	const agentApp = agent();

	agentApp.onRequest("initialize", async () => ({
		protocolVersion: 1,
		agentInfo: { name: `ve-${cfg.profileId}`, version: cfg.appVersion },
		agentCapabilities: { promptCapabilities: { embeddedContext: false } },
	}));

	agentApp.onRequest("session/new", async (ctx) => {
		const sessionId = `acp_s_${randomUUID().replace(/-/g, "")}`;
		const conversationId = `acp:${sessionId}`;
		conversations.set(sessionId, conversationId);
		// Persist origin explicitly: an unknown prefix would fall back to "console"
		// (implicit local admin) — the single most important trust-boundary line.
		engine.ensureAcpConversation(conversationId);
		return { sessionId, modes: null, _meta: { conversationId } };
	});

	agentApp.onRequest("session/prompt", async (ctx) => {
		const { sessionId } = ctx.params as { sessionId: string; prompt: unknown };
		const conversationId = conversations.get(sessionId);
		if (!conversationId) throw new Error(`unknown ACP session: ${sessionId}`);
		const text = promptText((ctx.params as { prompt: unknown }).prompt);
		if (!text) throw new Error("prompt 文本为空");

		// Fixed verified service account. Role comes from security.people via the
		// standard resolveRole path — ACP never asserts verifiedRole itself.
		const actor: InboundActor = {
			senderId: cfg.actorStaffId,
			senderName: cfg.actorName,
			channel: "acp",
			chatType: "single",
		};

		const turnMessageId = `acpm_${randomUUID().replace(/-/g, "")}`;
		const notify = (update: Record<string, unknown>): Promise<void> =>
			ctx.client.notify("session/update", { sessionId, update });

		const onProcessEvent = (event: TurnProcessEvent): void => {
			// Notifications are fire-and-forget; a dead client must not kill the turn.
			void (async () => {
				try {
					switch (event.type) {
						case "text_delta":
							await notify({
								sessionUpdate: "agent_message_chunk",
								messageId: turnMessageId,
								content: { type: "text", text: event.delta },
							});
							break;
						case "thinking_delta":
							await notify({
								sessionUpdate: "agent_thought_chunk",
								messageId: turnMessageId,
								content: { type: "text", text: event.delta },
							});
							break;
						case "tool_start":
							await notify({
								sessionUpdate: "tool_call",
								toolCallId: event.toolCallId,
								title: event.toolName,
								name: event.toolName,
								kind: "tool",
								status: "in_progress",
							});
							break;
						case "tool_end":
							await notify({
								sessionUpdate: "tool_call_update",
								toolCallId: event.toolCallId,
								status: event.isError ? "failed" : "completed",
							});
							break;
					}
				} catch {
					/* client gone — the turn still settles server-side */
				}
			})();
		};

		const agentSession = engine.getOrCreateSession(conversationId);
		let result;
		try {
			result = await engine.send(agentSession, text, { actor, onProcessEvent });
		} catch (err) {
			const aborted = /abort/i.test(err instanceof Error ? err.message : String(err));
			return { stopReason: aborted ? "cancelled" : "refusal" as const };
		}
		if (result.error) {
			return { stopReason: "refusal" as const, _meta: { error: String(result.error).slice(0, 500) } };
		}
		return { stopReason: "end_turn" as const };
	});

	agentApp.onNotification("session/cancel", async (ctx) => {
		const { sessionId } = ctx.params as { sessionId: string };
		const conversationId = conversations.get(sessionId);
		if (!conversationId) return;
		// abortSession cascades background-process cleanup and unwinds the durable
		// queue; the in-flight send() then rejects with an abort error.
		engine.abortSession(conversationId);
	});

	const acpServer = new AcpServer({ agent: agentApp });
	const acpHandler = createNodeHttpHandler(acpServer, { maxRequestBodyBytes: MAX_BODY_BYTES });

	const server = createServer((req, res) => {
		// Only the dedicated ACP path is served; everything else is 404.
		if (!req.url?.startsWith(ACP_PATH)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}
		const match = BEARER.exec(req.headers.authorization ?? "");
		if (!match || !tokenMatches(match[1], cfg.token)) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		acpHandler(req, res);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(cfg.port, "127.0.0.1", resolve);
	});
	return { server, port: (server.address() as { port: number }).port };
}
