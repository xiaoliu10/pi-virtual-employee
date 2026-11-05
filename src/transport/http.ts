/**
 * HTTP + SSE transport for the employee. Reused from the previous round:
 *  - POST /chat        (SSE stream)
 *  - POST /chat/sync   (JSON)
 *  - GET  /health
 * Drives the employee purely via {@link EmployeeRuntime}. The Electron renderer
 * talks to this (localhost) for streaming; Electron main passes the resolved
 * port to the renderer over IPC.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { EmployeeRuntime } from "../engine/engine.js";

interface ChatRequest {
	message?: string;
	conversationId?: string;
}

function readJsonBody(req: IncomingMessage): Promise<ChatRequest> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("error", reject);
		req.on("end", () => {
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw) as ChatRequest);
			} catch (err) {
				reject(err);
			}
		});
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/**
 * Thinking blocks. Kept SEPARATE from text: a different content type that must
 * never leak into the answer bubble.
 */
function extractThinking(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: string; thinking?: string }[])
		.filter((part) => part?.type === "thinking" && typeof part.thinking === "string")
		.map((part) => part.thinking as string)
		.join("");
}

function extractText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return (content as TextContent[])
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

async function streamRun(
	res: ServerResponse,
	runtime: EmployeeRuntime,
	agent: ReturnType<EmployeeRuntime["getOrCreateSession"]>,
	message: string,
	conversationId: string,
): Promise<void> {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});

	const sse = (payload: Record<string, unknown>): void => {
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
	};
	sse({ type: "meta", conversationId });

	let sentChars = 0;
	let sentThinking = 0;
	let currentMessageId: string | undefined;

	// TWO channels, because the two kernels publish differently:
	//
	//  - LEGACY / pi-session drive the Agent directly, so agent.subscribe sees
	//    message_update / tool_execution_* events.
	//  - DURABLE drives the harness pipeline and NEVER calls agent.prompt, so
	//    agent.subscribe observes ZERO events for a whole turn (measured). It
	//    publishes through SendCtx.onProcessEvent instead, translated into the
	//    same vocabulary.
	//
	// Only subscribing (the pre-0.2.192 behaviour) meant the console received no
	// deltas at all under durable — the answer appeared in one block at the end,
	// and thinking was never rendered because it was never delivered.
	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		switch (event.type) {
			case "message_start": {
				const id = (event.message as { id?: string }).id;
				if (id !== currentMessageId) {
					currentMessageId = id;
					sentChars = 0;
					sentThinking = 0;
				}
				break;
			}
			case "message_update": {
				// Thinking is a SEPARATE content type, not text: the old
				// extractText() filtered to type==="text" and threw thinking away,
				// so even a legacy kernel could never show a thinking box.
				const thinking = extractThinking(event.message);
				if (thinking.length > sentThinking) {
					sse({ type: "thinking", text: thinking.slice(sentThinking) });
					sentThinking = thinking.length;
				}
				const full = extractText(event.message);
				if (full.length > sentChars) {
					sse({ type: "delta", text: full.slice(sentChars) });
					sentChars = full.length;
				}
				break;
			}
			case "tool_execution_start":
				sse({ type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId });
				break;
			case "tool_execution_end":
				sse({
					type: "tool_end",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					isError: event.isError,
				});
				break;
			default:
				break;
		}
	});

	try {
		const { error } = await runtime.send(agent, message, {
			// Durable kernel channel (see above). Ignored by the legacy kernel.
			onProcessEvent: (event) => {
				switch (event.type) {
					case "thinking_delta":
						if (event.delta) sse({ type: "thinking", text: event.delta });
						break;
					case "text_delta":
						if (event.delta) sse({ type: "delta", text: event.delta });
						break;
					case "tool_start":
						sse({ type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId });
						break;
					case "tool_end":
						sse({
							type: "tool_end",
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							isError: event.isError,
							durationMs: event.durationMs,
						});
						break;
					default:
						break;
				}
			},
		});
		if (error) sse({ type: "error", message: error });
		else sse({ type: "done" });
	} catch (err) {
		sse({ type: "error", message: err instanceof Error ? err.message : String(err) });
	} finally {
		unsubscribe();
		res.end();
	}
}

/**
 * Start the HTTP transport. Returns the actual listening port (0 → ephemeral).
 */
export function startHttpTransport(
	runtime: EmployeeRuntime,
	options: { port?: number } = {},
): Promise<{ port: number; server: Server }> {
	const requested = options.port ?? 0;
	const server = createServer(async (req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}

		if (req.method === "GET" && req.url === "/health") {
			return sendJson(res, 200, {
				ok: true,
				profile: runtime.profileId,
				sessions: runtime.activeSessionCount(),
				model: runtime.modelId,
			});
		}

		if (req.method === "POST" && (req.url === "/chat" || req.url === "/chat/sync")) {
			let body: ChatRequest;
			try {
				body = await readJsonBody(req);
			} catch {
				return sendJson(res, 400, { error: "Invalid JSON body" });
			}
			const message = body.message?.trim();
			if (!message) return sendJson(res, 400, { error: "Missing 'message' field" });

			const conversationId = body.conversationId ?? randomUUID();

			// IM-originated conversations are read-only from the console: the reply
			// path lives in the messaging channel, so reject console sends outright.
			if (runtime.isReadOnlyConversation(conversationId)) {
				return sendJson(res, 403, {
					error: "该会话来自 IM 渠道，为只读，请在对应的 IM 里继续对话。",
					conversationId,
				});
			}

			let agent: ReturnType<EmployeeRuntime["getOrCreateSession"]>;
			try {
				agent = runtime.getOrCreateSession(conversationId);
			} catch (err) {
				// e.g. unknown/unresolvable model — respond instead of hanging.
				return sendJson(res, 500, {
					error: err instanceof Error ? err.message : String(err),
					conversationId,
				});
			}

			if (req.url === "/chat") {
				return await streamRun(res, runtime, agent, message, conversationId);
			}

			try {
				const { reply, error } = await runtime.send(agent, message);
				if (!reply && error) return sendJson(res, 502, { error, conversationId });
				return sendJson(res, 200, { conversationId, reply });
			} catch (err) {
				return sendJson(res, 500, {
					error: err instanceof Error ? err.message : String(err),
					conversationId,
				});
			}
		}

		return sendJson(res, 404, { error: "Not found" });
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(requested, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : requested;
			resolve({ port, server });
		});
	});
}
