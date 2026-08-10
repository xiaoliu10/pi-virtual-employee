import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { streamChat } from "../lib/chat";
import { MessageBubble } from "../components/MessageBubble";
import { ToolCallChip } from "../components/ToolCallChip";
import { Composer } from "../components/Composer";
import type { ModelOption } from "../lib/types";

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	streaming?: boolean;
}

interface ToolChip {
	id?: string;
	name: string;
	done: boolean;
	isError?: boolean;
}

interface ChatPageProps {
	port: number;
	activeId: string | null;
	/** IM/scheduled refresh: id of the conversation that just persisted a message + a bump counter. */
	imChangedId?: string | null;
	imTick?: number;
	/** Read-only when viewing an IM-channel conversation (send happens in the IM, not here). */
	readOnly?: boolean;
	agentName: string;
	currentModel: { supplierId: string; modelId: string } | null;
	modelRevision: string;
	onActivated: (id: string) => void;
	onTasksChanged: () => void;
}

let seq = 0;
const nextId = () => `m${Date.now()}-${seq++}`;

export function ChatPage({
	port,
	activeId,
	imChangedId = null,
	imTick = 0,
	readOnly = false,
	agentName,
	currentModel,
	modelRevision,
	onActivated,
	onTasksChanged,
}: ChatPageProps) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [tools, setTools] = useState<ToolChip[]>([]);
	const [streaming, setStreaming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conversationId, setConversationId] = useState<string | null>(activeId);
	const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		api.listModels().then(setModelOptions).catch(() => setModelOptions([]));
	}, [modelRevision]);

	// Load history when switching to an existing conversation.
	useEffect(() => {
		setConversationId(activeId);
		setTools([]);
		setError(null);
		if (!activeId) {
			setMessages([]);
			return;
		}
		let cancelled = false;
		api.getMessages(activeId).then((rows) => {
			if (cancelled) return;
			setMessages(
				rows.map((r) => ({ id: r.id, role: r.role, content: r.content })),
			);
		});
		return () => {
			cancelled = true;
		};
	}, [activeId]);

	// Live-reload the open conversation when main signals a new persisted message
	// in it (IM inbound/outbound, or a scheduled-task run targeting this chat).
	// Skip while this pane itself is mid-stream to avoid clobbering the local draft.
	useEffect(() => {
		const convId = activeId ?? conversationId;
		if (!convId || imTick === 0 || imChangedId !== convId) return;
		if (streaming) return;
		let cancelled = false;
		api.getMessages(convId).then((rows) => {
			if (cancelled) return;
			setMessages(rows.map((r) => ({ id: r.id, role: r.role, content: r.content })));
		});
		return () => {
			cancelled = true;
		};
	}, [imTick, imChangedId, activeId, conversationId, streaming]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [messages, tools]);

	const updateLastAssistant = useCallback((fn: (prev: string) => string) => {
		setMessages((prev) => {
			const idx = prev.length - 1;
			if (idx < 0 || prev[idx].role !== "assistant") return prev;
			const copy = prev.slice();
			copy[idx] = { ...copy[idx], content: fn(copy[idx].content) };
			return copy;
		});
	}, []);

	const send = useCallback(
		async (text: string) => {
			if (streaming || port === 0) return;
			setStreaming(true);
			setError(null);
			setTools([]);
			const wasNew = conversationId === null;

			setMessages((prev) => [
				...prev,
				{ id: nextId(), role: "user", content: text },
				{ id: nextId(), role: "assistant", content: "", streaming: true },
			]);

			await streamChat(
				port,
				{ message: text, conversationId: conversationId ?? undefined },
				{
					onEvent: (e) => {
						switch (e.type) {
							case "meta":
								if (e.conversationId) {
									setConversationId(e.conversationId);
									if (wasNew) onActivated(e.conversationId);
								}
								break;
							case "delta":
								updateLastAssistant((prev) => prev + (e.text ?? ""));
								break;
							case "tool_start":
								setTools((t) => [...t, { id: e.toolCallId, name: e.toolName ?? "", done: false }]);
								break;
							case "tool_end":
								setTools((t) =>
									t.map((chip) =>
										chip.id === e.toolCallId
											? { ...chip, done: true, isError: e.isError }
											: chip,
									),
								);
								break;
							case "done":
								setMessages((prev) =>
									prev.map((m, i) =>
										i === prev.length - 1 ? { ...m, streaming: false } : m,
									),
								);
								break;
							case "error":
								setError(e.message ?? "请求失败");
								break;
						}
					},
				},
			);

			setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 ? { ...m, streaming: false } : m)));
			setStreaming(false);
			onTasksChanged();
		},
		[streaming, port, conversationId, onActivated, onTasksChanged, updateLastAssistant],
	);

	const onModelChange = useCallback(
		async (supplierId: string, modelId: string) => {
			const convId = conversationId ?? activeId;
			if (!convId) return; // new conversation: default applies until first message
			await api.setConversationModel(convId, supplierId, modelId);
			onTasksChanged();
		},
		[conversationId, activeId, onTasksChanged],
	);

	const requestedValue = currentModel ? `${currentModel.supplierId}/${currentModel.modelId}` : "";
	const defaultOption = modelOptions.find((option) => option.isDefault);
	const selectedValue = modelOptions.some((option) => `${option.supplierId}/${option.modelId}` === requestedValue)
		? requestedValue
		: defaultOption
			? `${defaultOption.supplierId}/${defaultOption.modelId}`
			: "";

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="titlebar-drag flex h-14 items-center justify-between border-b border-slate-200 px-6">
				<div className="titlebar-nodrag flex items-center gap-2 pt-3 text-sm text-slate-500">
					<span className="font-semibold text-ink-900">{agentName}</span>
					<span>·</span>
					<span>{readOnly ? "IM 会话 · 只读" : "多轮对话"}</span>
				</div>
				<select
					className="titlebar-nodrag mr-1 mt-3 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-600 outline-none focus:border-accent disabled:opacity-50"
					value={selectedValue}
					disabled={!conversationId || modelOptions.length === 0 || readOnly}
					onChange={(e) => {
						const [supplierId, modelId] = e.target.value.split("/");
						if (supplierId && modelId) void onModelChange(supplierId, modelId);
					}}
					title={conversationId ? "切换本对话的模型" : "发送首条消息后可切换模型"}
				>
					{modelOptions.length === 0 && <option value="">未配置模型</option>}
					{modelOptions.map((o) => (
						<option key={`${o.supplierId}/${o.modelId}`} value={`${o.supplierId}/${o.modelId}`}>
							{o.supplierName} / {o.modelId}
							{o.isDefault ? " ★" : ""}
						</option>
					))}
				</select>
			</header>

			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-3xl space-y-5 px-6 py-8">
					{messages.length === 0 && !streaming && (
						<div className="flex flex-col items-center gap-3 py-24 text-center text-slate-400">
							<div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-ink-900 text-2xl font-bold text-accent">
								π
							</div>
							<p className="text-base text-slate-500">你好,我是 {agentName} 👋</p>
							<p className="text-sm">可以问我售后政策、订单进度,或让我转人工。</p>
						</div>
					)}
					{messages.map((m) => (
						<MessageBubble key={m.id} role={m.role} content={m.content} streaming={m.streaming} />
					))}
					{tools.length > 0 && (
						<div className="flex flex-wrap gap-2 pl-11">
							{tools.map((t, i) => (
								<ToolCallChip key={t.id ?? i} name={t.name} done={t.done} isError={t.isError} />
							))}
						</div>
					)}
					{error && (
						<div className="pl-11 text-sm text-rose-600">出错:{error}</div>
					)}
				</div>
			</div>

			{readOnly ? (
				<div className="border-t border-slate-200 bg-slate-50 px-6 py-4 text-center text-sm text-slate-500">
					这是来自 IM 渠道的会话，仅可查看记录。继续对话请回到对应的 IM（钉钉 / 飞书等）。
				</div>
			) : (
				<Composer onSend={send} disabled={streaming || port === 0} />
			)}
		</div>
	);
}
