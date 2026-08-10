/**
 * Chat client for the local HTTP+SSE transport. Uses fetch + ReadableStream to
 * parse the SSE stream (EventSource can't POST, so we read manually).
 */
import { baseUrl } from "./ipc";

export interface StreamEvent {
	type: "meta" | "delta" | "tool_start" | "tool_end" | "done" | "error";
	conversationId?: string;
	text?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	message?: string;
}

export interface StreamCallbacks {
	onEvent: (event: StreamEvent) => void;
}

export async function streamChat(
	port: number,
	input: { message: string; conversationId?: string },
	{ onEvent }: StreamCallbacks,
): Promise<void> {
	const res = await fetch(`${baseUrl(port)}/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});

	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => "");
		onEvent({ type: "error", message: `HTTP ${res.status} ${text}` });
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let sep: number;
		while ((sep = buffer.indexOf("\n\n")) >= 0) {
			const chunk = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			const data = chunk
				.split("\n")
				.filter((l) => l.startsWith("data: "))
				.map((l) => l.slice(6))
				.join("");
			if (!data) continue;
			try {
				onEvent(JSON.parse(data) as StreamEvent);
			} catch {
				/* ignore malformed frame */
			}
		}
	}
}

/** Non-streaming variant. Aborts after `timeoutMs` so callers don't hang forever. */
export async function chatSync(
	port: number,
	input: { message: string; conversationId?: string },
	timeoutMs = 30_000,
): Promise<{ conversationId: string; reply: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${baseUrl(port)}/chat/sync`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
		return (await res.json()) as { conversationId: string; reply: string };
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			throw new Error(`连接超时(${timeoutMs / 1000}s)——检查 Base URL、网络或 API key`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
