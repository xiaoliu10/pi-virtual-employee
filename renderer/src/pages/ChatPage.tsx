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
	/** Per-conversation model pin (null = follows global default). */
	modelOverride: { supplierId: string; modelId: string } | null;
	onConfigChanged: (patch: unknown) => Promise<unknown>;
	modelRevision: string;
	onActivated: (id: string) => void;
	onTasksChanged: () => void;
}

/** Select sentinel: conversation has no model pin and follows the global default. */
const FOLLOW_VALUE = "@@follow";

let seq = 0;
const nextId = () => `m${Date.now()}-${seq++}`;

export function ChatPage({
	port,
	activeId,
	imChangedId = null,
	imTick = 0,
	readOnly = false,
	agentName,
	modelOverride,
	onConfigChanged,
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
			try {
				if (!convId) {
					// New conversation: nothing to pin yet — choosing a model here sets
					// the global default so the chat (and everything after) uses it.
					await onConfigChanged({ model: { defaultSupplierId: supplierId, defaultModelId: modelId } });
					setError(null);
					return;
				}
				await api.setConversationModel(convId, supplierId, modelId);
				setError(null);
				onTasksChanged();
			} catch (err) {
				// Silent failures here read as "点击没反应" — surface the real reason
				// (supplier disabled / model removed / identity revoked).
				setError(`切换模型失败：${err instanceof Error ? err.message : String(err)}`);
			}
		},
		[conversationId, activeId, onTasksChanged, onConfigChanged],
	);

	// Clear the per-conversation pin so the conversation follows the global default again.
	const onModelFollow = useCallback(
		async () => {
			const convId = conversationId ?? activeId;
			if (!convId) return; // new conversation has no pin
			try {
				await api.clearConversationModel(convId);
				setError(null);
				onTasksChanged();
			} catch (err) {
				setError(`恢复跟随默认失败：${err instanceof Error ? err.message : String(err)}`);
			}
		},
		[conversationId, activeId, onTasksChanged],
	);

	const defaultOption = modelOptions.find((option) => option.isDefault);
	// Override is only "active" while it still points at a valid option; the engine
	// self-heals stale pins to the global default, and the UI mirrors that here.
	const activeOverride =
		modelOverride &&
		modelOptions.some(
			(o) => `${o.supplierId}/${o.modelId}` === `${modelOverride.supplierId}/${modelOverride.modelId}`,
		)
			? modelOverride
			: null;
	const selectedValue = activeOverride ? `${activeOverride.supplierId}/${activeOverride.modelId}` : FOLLOW_VALUE;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="titlebar-drag flex h-[60px] shrink-0 items-center justify-between gap-4 pl-[22px] pr-[18px]">
				<div className="titlebar-nodrag flex min-w-0 items-center gap-2 text-sm text-[#6e6e73]">
					<span className="truncate text-[15px] font-semibold text-[#1d1d1f]">{agentName}</span>
					<span>·</span>
					<span className="shrink-0">{readOnly ? "IM 会话 · 只读" : "多轮对话"}</span>
				</div>
				<select
					className="titlebar-nodrag h-[30px] max-w-[240px] shrink-0 cursor-pointer rounded-full border-0 bg-transparent px-2.5 text-[12.5px] text-[#6e6e73] outline-none transition-colors hover:bg-black/[0.045] hover:text-[#1d1d1f] disabled:cursor-not-allowed disabled:opacity-50"
					value={selectedValue}
					disabled={modelOptions.length === 0}
					onChange={(e) => {
						if (e.target.value === FOLLOW_VALUE) {
							void onModelFollow();
							return;
						}
						const [supplierId, modelId] = e.target.value.split("/");
						if (supplierId && modelId) void onModelChange(supplierId, modelId);
					}}
					title={modelOptions.length === 0
						? "尚未配置模型：请在 设置 → 自定义模型 添加"
						: !conversationId && !activeId
							? "选择新对话使用的模型（将更新全局默认）"
							: readOnly
								? "切换本 IM 会话使用的模型"
								: "切换本对话的模型"}
				>
					{modelOptions.length === 0 && <option value="">未配置模型</option>}
					{modelOptions.length > 0 && (
						<option value={FOLLOW_VALUE}>
							跟随全局默认{defaultOption ? `（${defaultOption.supplierName} / ${defaultOption.modelId}）` : ""}
							{activeOverride ? " ← 点击取消本对话固定" : ""}
						</option>
					)}
					{modelOptions.map((o) => (
						<option key={`${o.supplierId}/${o.modelId}`} value={`${o.supplierId}/${o.modelId}`}>
							{o.supplierName} / {o.modelId}
							{o.isDefault ? " ★" : ""}
						</option>
					))}
				</select>
			</header>

			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-[860px] space-y-8 py-7 pl-14 pr-12">
					{messages.length === 0 && !streaming && (
						<div className="flex flex-col items-center gap-3 py-24 text-center">
							<div className="select-none font-serif text-[70px] leading-none text-[#c9c9ce]">π</div>
							<p className="text-[22px] font-semibold text-[#1d1d1f]">你好，我是 {agentName}</p>
							<p className="text-sm text-[#6e6e73]">把任务交给我——查询、整理、推送，到点自动执行。</p>
							<p className="mt-2 text-xs text-[#a1a1a6]">支持钉钉 / 飞书 / 企微 IM 触达与定时任务</p>
						</div>
					)}
					{messages.map((m) => (
						<MessageBubble key={m.id} role={m.role} content={m.content} streaming={m.streaming} />
					))}
					{tools.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{tools.map((t, i) => (
								<ToolCallChip key={t.id ?? i} name={t.name} done={t.done} isError={t.isError} />
							))}
						</div>
					)}
					{error && (
						<div className="text-sm text-rose-600">出错:{error}</div>
					)}
				</div>
			</div>

			{readOnly ? (
				<div className="px-6 pb-5">
					<div className="mx-auto w-[min(980px,calc(100%-48px))] rounded-2xl border border-black/[0.08] bg-[#f6f6f7] px-5 py-3 text-center text-[13px] text-[#6e6e73]">
						这是来自 IM 渠道的会话，仅可查看记录。继续对话请回到对应的 IM（钉钉 / 飞书等）。
					</div>
				</div>
			) : (
				<Composer onSend={send} disabled={streaming || port === 0} />
			)}
		</div>
	);
}
