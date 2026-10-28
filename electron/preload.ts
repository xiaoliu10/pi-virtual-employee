/**
 * Preload — exposes a small, whitelisted API to the renderer over
 * contextBridge. The renderer never touches Node/Electron directly; it calls
 * `window.api.*`, which maps to ipcRenderer.invoke.
 */
import { contextBridge, ipcRenderer } from "electron";
import { AUTH_IPC } from "../src/shared/auth.js";
import type { AuthCatalogResponse, AuthLoginState, AuthQuotaResponse } from "../src/shared/auth.js";

const api = {
	getServerPort: (): Promise<number> => ipcRenderer.invoke("server:port"),
	getConfig: () => ipcRenderer.invoke("config:get"),
	setConfig: (patch: unknown) => ipcRenderer.invoke("config:set", patch),
	manageComputer: (action: string) => ipcRenderer.invoke("computer:manage", action),
	pickComputerDriver: () => ipcRenderer.invoke("computer:pickDriver"),
	previewPrompt: () => ipcRenderer.invoke("prompt:preview"),
	defaultPromptRules: () => ipcRenderer.invoke("prompt:defaults"),
	listScheduledTasks: () => ipcRenderer.invoke("tasks:schedList"),
	listWorkItems: () => ipcRenderer.invoke("tasks:workList"),
	getMiningStatus: () => ipcRenderer.invoke("work:miningStatus"),
	deleteScheduledTask: (id: string) => ipcRenderer.invoke("tasks:schedDelete", id),
	toggleScheduledTask: (id: string, enabled: boolean) =>
		ipcRenderer.invoke("tasks:schedToggle", id, enabled),
	setScheduledTaskSilent: (id: string, silent: boolean) =>
		ipcRenderer.invoke("tasks:schedSilent", id, silent),
	editScheduledTask: (id: string, patch: { title?: string; prompt?: string; cron?: string; autonomous?: boolean; silent?: boolean }) =>
		ipcRenderer.invoke("tasks:schedEdit", id, patch),
	deleteWorkItem: (id: string) => ipcRenderer.invoke("tasks:workDelete", id),
	workItemAct: (id: string, action: "pause" | "resume" | "cancel") =>
		ipcRenderer.invoke("tasks:workAct", id, action),
	workItemEdit: (id: string, patch: { goal?: string; conditions?: string }) =>
		ipcRenderer.invoke("tasks:workEdit", id, patch),

	// Report / artifact center
	testReportTarget: () => ipcRenderer.invoke("reports:test"),
	testGitee: () => ipcRenderer.invoke("reports:testGitee"),
	testOss: () => ipcRenderer.invoke("reports:testOss"),
	listReports: () => ipcRenderer.invoke("reports:list"),
	getReport: (id: string) => ipcRenderer.invoke("reports:get", id),
	reportRuns: (artifactId: string) => ipcRenderer.invoke("reports:runs", artifactId),
	reportBody: (runId: string) => ipcRenderer.invoke("reports:body", runId),
	reportUrl: (runId: string) => ipcRenderer.invoke("reports:url", runId),
	republishReport: (runId: string) => ipcRenderer.invoke("reports:republish", runId),
	deleteReport: (id: string) => ipcRenderer.invoke("reports:delete", id),
	listTasks: () => ipcRenderer.invoke("tasks:list"),
	getMessages: (id: string) => ipcRenderer.invoke("tasks:messages", id),
	/**
	 * Messages newer than `sinceTs` plus the cursor to resume from. Used by the
	 * renderer's reconnect path so a dropped connection re-syncs incrementally
	 * instead of re-reading the whole conversation. (Missing this bridge made the
	 * renderer's ChatPage call a non-existent method — review P0.)
	 */
	getMessagesSince: (id: string, sinceTs: number): Promise<{ rows: { id: string; conversation_id: string; role: "user" | "assistant"; content: string; created_at: number }[]; cursor: number }> =>
		ipcRenderer.invoke("tasks:messagesSince", id, sinceTs),
	deleteTask: (id: string) => ipcRenderer.invoke("tasks:delete", id),
	getAutostart: (): Promise<boolean> => ipcRenderer.invoke("autostart:get"),
	setAutostart: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke("autostart:set", enabled),
	// Optional actor: console-local test surface (echo channel) can inject a
	// platform-verified sender to exercise the RBAC/admin pipeline end to end.
	simulateIM: (conversationId: string, text: string, actor?: { senderId: string; senderName?: string; channel: string; chatType: "single" | "group" }): Promise<string> =>
		ipcRenderer.invoke("im:simulate", conversationId, text, actor),
	imChannels: (): Promise<string[]> => ipcRenderer.invoke("im:channels"),
	imChannelStatuses: (): Promise<unknown[]> => ipcRenderer.invoke("im:channelStatuses"),
	/** Subscribe to config-change pushes (main → renderer): any writer of the config store
	 * (settings save, IM manage_access/manage_settings, import) broadcasts this, so an
	 * open settings page re-reads instead of showing a stale draft. Returns an unsubscribe. */
	onConfigChanged: (cb: () => void): (() => void) => {
		const listener = () => cb();
		ipcRenderer.on("config:changed", listener);
		return () => ipcRenderer.removeListener("config:changed", listener);
	},
	/** Subscribe to IM/scheduled activity (main → renderer push) to refresh live. Carries the conversationId that changed. Returns an unsubscribe. */
	onImActivity: (cb: (conversationId: string) => void): (() => void) => {
		const listener = (_e: unknown, conversationId: string) => cb(conversationId);
		ipcRenderer.on("im:activity", listener);
		return () => ipcRenderer.removeListener("im:activity", listener);
	},
	listModels: () => ipcRenderer.invoke("model:list"),
	testModel: (supplier: unknown, modelId: string) => ipcRenderer.invoke("model:test", supplier, modelId),
	modelCapabilities: (supplier: unknown): Promise<Record<string, boolean>> => ipcRenderer.invoke("model:capabilities", supplier),
	importModelConfig: () => ipcRenderer.invoke("model:import"),
	exportModelConfig: (model: unknown): Promise<boolean> => ipcRenderer.invoke("model:export", model),
	setDefaultModel: (supplierId: string, modelId: string): Promise<unknown> =>
		ipcRenderer.invoke("model:setDefault", supplierId, modelId),
	setConversationModel: (conversationId: string, supplierId: string, modelId: string): Promise<boolean> =>
		ipcRenderer.invoke("model:setForConversation", conversationId, supplierId, modelId),
	// Empty supplierId/modelId clears the pin (conversation follows the global default).
	clearConversationModel: (conversationId: string): Promise<boolean> =>
		ipcRenderer.invoke("model:setForConversation", conversationId, "", ""),

	// Provider account login (settings page). Login progress arrives as pushed
	// AuthLoginState snapshots (onAuthLoginEvent); answers go through
	// authLoginAnswer(promptId, value); authLoginCancel aborts the flow.
	authCatalog: (): Promise<AuthCatalogResponse> => ipcRenderer.invoke(AUTH_IPC.catalog),
	authLogin: (provider: string): Promise<AuthLoginState> => ipcRenderer.invoke(AUTH_IPC.login, provider),
	authLoginStatus: (): Promise<AuthLoginState | null> => ipcRenderer.invoke(AUTH_IPC.loginStatus),
	authLoginAnswer: (promptId: string, value: string): Promise<boolean> => ipcRenderer.invoke(AUTH_IPC.loginAnswer, promptId, value),
	authLoginCancel: (): Promise<boolean> => ipcRenderer.invoke(AUTH_IPC.loginCancel),
	authLogout: (provider: string): Promise<void> => ipcRenderer.invoke(AUTH_IPC.logout, provider),
	authQuota: (provider: string): Promise<AuthQuotaResponse> => ipcRenderer.invoke(AUTH_IPC.quota, provider),
	/** Subscribe to login flow state pushes (main → renderer). Returns an unsubscribe. */
	onAuthLoginEvent: (cb: (state: AuthLoginState) => void): (() => void) => {
		const listener = (_e: unknown, state: AuthLoginState) => cb(state);
		ipcRenderer.on(AUTH_IPC.loginEvent, listener);
		return () => ipcRenderer.removeListener(AUTH_IPC.loginEvent, listener);
	},
	/** Open an https URL in the system browser (login dialog「打开授权页面」).
	 * Main enforces https + main-window origin; no in-app child window. */
	openExternal: (url: string): Promise<void> => ipcRenderer.invoke(AUTH_IPC.openExternal, url),
	exportEmployee: (opts?: unknown): Promise<{ path: string; size: number } | null> =>
		ipcRenderer.invoke("employee:export", opts),
	importEmployee: (args: { mode: "new" | "overwrite"; profileName?: string }): Promise<unknown> =>
		ipcRenderer.invoke("employee:import", args),

	// Knowledge base
	kbStatus: () => ipcRenderer.invoke("kb:status"),
	listKnowledgeEntries: (includeArchived?: boolean) => ipcRenderer.invoke("kb:listEntries", includeArchived),
	upsertKnowledgeEntry: (entry: unknown) => ipcRenderer.invoke("kb:upsertEntry", entry),
	deleteKnowledgeEntry: (id: string) => ipcRenderer.invoke("kb:deleteEntry", id),
	archiveKnowledgeEntry: (id: string) => ipcRenderer.invoke("kb:archiveEntry", id),
	restoreKnowledgeEntry: (id: string) => ipcRenderer.invoke("kb:restoreEntry", id),
	listKnowledgeDocs: () => ipcRenderer.invoke("kb:listDocs"),
	deleteKnowledgeDoc: (id: string) => ipcRenderer.invoke("kb:deleteDoc", id),
	searchKnowledge: (query: string) => ipcRenderer.invoke("kb:search", query),
	importKnowledge: () => ipcRenderer.invoke("kb:import"),
	vectorStatusKnowledge: () => ipcRenderer.invoke("kb:vectorStatus"),
	reindexKnowledge: () => ipcRenderer.invoke("kb:reindex"),
	testEmbedding: (input: unknown) => ipcRenderer.invoke("kb:testEmbedding", input),
	testExternalKnowledge: (cfg: unknown) => ipcRenderer.invoke("kb:testExternal", cfg),
	listExternalDatasets: (cfg: unknown): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke("kb:externalDatasets", cfg),
	listExternalKnowledgeDocs: (providerId: string) => ipcRenderer.invoke("kb:externalList", providerId),
	parseExternalKnowledge: (providerId: string, documentId?: string) =>
		ipcRenderer.invoke("kb:externalParse", providerId, documentId),
	uploadExternalKnowledge: (providerId: string) => ipcRenderer.invoke("kb:externalUpload", providerId),
	consolidateKnowledge: () => ipcRenderer.invoke("kb:consolidate"),
	researchGapsKnowledge: () => ipcRenderer.invoke("kb:researchGaps"),
	learnStatusKnowledge: () => ipcRenderer.invoke("kb:learnStatus"),
	listKnowledgeGaps: (limit?: number) => ipcRenderer.invoke("kb:listGaps", limit),
	resolveKnowledgeGap: (query: string) => ipcRenderer.invoke("kb:resolveGap", query),
	approveKnowledgeEntry: (id: string) => ipcRenderer.invoke("kb:approveEntry", id),

	// Document resources
	listDocuments: () => ipcRenderer.invoke("documents:list"),
	addDocument: (input: unknown) => ipcRenderer.invoke("documents:add", input),
	updateDocument: (id: string, patch: unknown) => ipcRenderer.invoke("documents:update", id, patch),
	deleteDocument: (id: string) => ipcRenderer.invoke("documents:delete", id),
	uploadDocument: (meta?: unknown) => ipcRenderer.invoke("documents:upload", meta),
	documentsDir: () => ipcRenderer.invoke("documents:dir"),

	// Filesystem (scoped local access)
	pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("filesystem:pickDir"),

	// Skills
	listSkills: () => ipcRenderer.invoke("skills:list"),
	refreshSkills: () => ipcRenderer.invoke("skills:refresh"),
	importSkills: () => ipcRenderer.invoke("skills:import"),
	deleteSkill: (filePath: string) => ipcRenderer.invoke("skills:delete", filePath),
	setEnabledSkill: (name: string, enabled: boolean) => ipcRenderer.invoke("skills:setEnabled", name, enabled),

	// Auto-update (packaged Windows only; other builds get a stable idle state)
	getUpdateState: (): Promise<unknown> => ipcRenderer.invoke("update:getState"),
	checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke("update:check"),
	downloadUpdate: (): Promise<unknown> => ipcRenderer.invoke("update:download"),
	installUpdate: (): Promise<boolean> => ipcRenderer.invoke("update:install"),
	/** Subscribe to updater state pushes (main → renderer). Returns an unsubscribe. */
	onUpdateEvent: (cb: (state: unknown) => void): (() => void) => {
		const listener = (_e: unknown, state: unknown) => cb(state);
		ipcRenderer.on("update:event", listener);
		return () => ipcRenderer.removeListener("update:event", listener);
	},
};

contextBridge.exposeInMainWorld("api", api);

export type RendererApi = typeof api;
