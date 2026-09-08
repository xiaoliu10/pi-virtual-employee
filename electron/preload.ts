/**
 * Preload — exposes a small, whitelisted API to the renderer over
 * contextBridge. The renderer never touches Node/Electron directly; it calls
 * `window.api.*`, which maps to ipcRenderer.invoke.
 */
import { contextBridge, ipcRenderer } from "electron";

const api = {
	getServerPort: (): Promise<number> => ipcRenderer.invoke("server:port"),
	getConfig: () => ipcRenderer.invoke("config:get"),
	setConfig: (patch: unknown) => ipcRenderer.invoke("config:set", patch),
	manageComputer: (action: string) => ipcRenderer.invoke("computer:manage", action),
	pickComputerDriver: () => ipcRenderer.invoke("computer:pickDriver"),
	previewPrompt: () => ipcRenderer.invoke("prompt:preview"),
	defaultPromptRules: () => ipcRenderer.invoke("prompt:defaults"),
	listScheduledTasks: () => ipcRenderer.invoke("tasks:schedList"),
	deleteScheduledTask: (id: string) => ipcRenderer.invoke("tasks:schedDelete", id),
	toggleScheduledTask: (id: string, enabled: boolean) =>
		ipcRenderer.invoke("tasks:schedToggle", id, enabled),

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
	deleteTask: (id: string) => ipcRenderer.invoke("tasks:delete", id),
	getAutostart: (): Promise<boolean> => ipcRenderer.invoke("autostart:get"),
	setAutostart: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke("autostart:set", enabled),
	simulateIM: (conversationId: string, text: string): Promise<string> =>
		ipcRenderer.invoke("im:simulate", conversationId, text),
	imChannels: (): Promise<string[]> => ipcRenderer.invoke("im:channels"),
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
	setConversationModel: (conversationId: string, supplierId: string, modelId: string): Promise<boolean> =>
		ipcRenderer.invoke("model:setForConversation", conversationId, supplierId, modelId),
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
