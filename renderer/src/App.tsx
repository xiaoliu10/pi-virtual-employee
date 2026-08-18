import { useCallback, useEffect, useState } from "react";
import { api } from "./lib/ipc";
import type { AppConfig, ConversationRow } from "./lib/types";
import { useUpdater } from "./lib/useUpdater";
import { Sidebar } from "./components/Sidebar";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";

type View = "chat" | "settings";

export default function App() {
	const [port, setPort] = useState(0);
	const [view, setView] = useState<View>("chat");
	const [conversations, setConversations] = useState<ConversationRow[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [config, setConfig] = useState<AppConfig | null>(null);
	// Bumped whenever main signals a message was persisted; carries the conversationId.
	// ChatPage watches this to reload the currently-open conversation live.
	const [imTick, setImTick] = useState(0);
	const [imChangedId, setImChangedId] = useState<string | null>(null);
	// Single updater subscription for the whole app (sidebar badge + settings page).
	const updater = useUpdater();

	const refreshTasks = useCallback(async () => {
		setConversations(await api.listTasks());
	}, []);

	useEffect(() => {
		(async () => {
			setPort(await api.getServerPort());
			setConfig(await api.getConfig());
			await refreshTasks();
		})();
		// IM/scheduled messages are stored by the main process asynchronously; subscribe
		// so the task list refreshes live AND the open conversation reloads when it's
		// the one that changed.
		const unsub = api.onImActivity((conversationId) => {
			void refreshTasks();
			setImChangedId(conversationId);
			setImTick((t) => t + 1);
		});
		return unsub;
	}, [refreshTasks]);

	const handleConfigChange = useCallback(async (patch: unknown) => {
		setConfig(await api.setConfig(patch));
		await refreshTasks();
	}, [refreshTasks]);

	return (
		<div className="flex h-full overflow-hidden">
			<Sidebar
				view={view}
				conversations={conversations}
				activeId={activeId}
				update={updater}
				modelLabel={(() => {
					const m = config?.model;
					if (!m) return "—";
					const sup = m.suppliers.find((s) => s.id === m.defaultSupplierId);
					return m.defaultModelId
						? `${sup?.name ?? m.defaultSupplierId} / ${m.defaultModelId}`
						: "未配置模型";
				})()}
				onNavigate={setView}
				onSelect={(id) => {
					setActiveId(id);
					setView("chat");
				}}
				onNewChat={() => {
					setActiveId(null);
					setView("chat");
				}}
				onDelete={async (id) => {
					await api.deleteTask(id);
					if (activeId === id) setActiveId(null);
					await refreshTasks();
				}}
			/>
			<main className="flex min-w-0 flex-1 flex-col">
				<ChatPage
					port={port}
					activeId={activeId}
					imChangedId={imChangedId}
					imTick={imTick}
					readOnly={conversations.find((c) => c.id === activeId)?.origin === "im"}
					agentName={config?.identity.name ?? "客服小派"}
					modelRevision={config ? JSON.stringify(config.model) : ""}
					currentModel={(() => {
						const conv = conversations.find((c) => c.id === activeId);
						if (conv?.model_supplier_id && conv?.model_model_id) {
							return { supplierId: conv.model_supplier_id, modelId: conv.model_model_id };
						}
						return config?.model.defaultSupplierId && config.model.defaultModelId
							? { supplierId: config.model.defaultSupplierId, modelId: config.model.defaultModelId }
							: null;
					})()}
					onActivated={setActiveId}
					onTasksChanged={refreshTasks}
				/>
			</main>
			{view === "settings" && (
				<SettingsPage
					config={config}
					onChange={handleConfigChange}
					updater={updater}
					onClose={() => setView("chat")}
				/>
			)}
		</div>
	);
}
