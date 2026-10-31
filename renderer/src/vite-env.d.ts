/// <reference types="vite/client" />

import type { AppConfig, ExternalDoc, ExternalProviderConfig, KbGap, KnowledgeDoc, KnowledgeEntry, ModelConfig, ResourceInput, ResourceRow, ScheduledTaskRow, SearchHit, SkillInfo, Supplier, UpdateState, VectorStatus, WorkItemView } from "./lib/types";
import type { ConversationRow, MessageRow } from "./lib/types";

/** Whitelisted API bridged by electron/preload.ts. Kept in sync manually. */
export interface RendererApi {
	getServerPort(): Promise<number>;
	getMiningStatus(): Promise<{
		enabled: boolean;
		intervalHours: number;
		lastTickAt: string | null;
		lastRunAt: string | null;
		lastMiningScanned: string | null;
		lastMiningProposals: string | null;
		lastMiningError: string | null;
		pendingProposals: number | null;
	}>;
	getConfig(): Promise<AppConfig>;
	setConfig(patch: unknown): Promise<AppConfig>;
	/** Widget listener status: is it actually bound, on which port, and why not. */
	getWidgetStatus(): Promise<{
		enabled: boolean;
		running: boolean;
		port: number;
		expose: "loopback" | "lan";
		error?: string;
		reassignedFrom?: number;
	}>;
	/** Pick + persist a free widget port for THIS profile. */
	allocateWidgetPort(): Promise<{ port: number; changed: boolean; reason?: string }>;
	manageComputer(action: "status" | "install" | "connect" | "disconnect"): Promise<import("../../src/shared/computer").ComputerStatus>;
	pickComputerDriver(): Promise<string | null>;
	previewPrompt(): Promise<string>;
	defaultPromptRules(): Promise<string>;
	listScheduledTasks(): Promise<ScheduledTaskRow[]>;
	listWorkItems(): Promise<WorkItemView[]>;
	deleteScheduledTask(id: string): Promise<boolean>;
	toggleScheduledTask(id: string, enabled: boolean): Promise<boolean>;
	setScheduledTaskSilent(id: string, silent: boolean): Promise<boolean>;
	editScheduledTask(id: string, patch: { title?: string; prompt?: string; cron?: string; autonomous?: boolean; silent?: boolean }): Promise<{ ok: boolean; nextRunAt?: number; error?: string }>;
	deleteWorkItem(id: string): Promise<{ ok: boolean; error?: string }>;
	workItemAct(id: string, action: "pause" | "resume" | "cancel"): Promise<{ ok: boolean; status?: string; error?: string }>;
	workItemEdit(id: string, patch: { goal?: string; conditions?: string }): Promise<{ ok: boolean; status?: string; error?: string }>;
	testReportTarget(): Promise<{ ok: boolean; detail: string }>;
testGitee(): Promise<{ ok: boolean; detail: string }>;
testOss(): Promise<{ ok: boolean; detail: string }>;
	listReports(): Promise<import("./lib/types").Artifact[]>;
	getReport(id: string): Promise<import("./lib/types").Artifact | null>;
	reportRuns(artifactId: string): Promise<import("./lib/types").ArtifactRun[]>;
	reportBody(runId: string): Promise<import("./lib/types").ArtifactAttachment | null>;
	reportUrl(runId: string): Promise<string | null>;
	republishReport(runId: string): Promise<{ url: string; path: string } | null>;
	deleteReport(id: string): Promise<boolean>;
	listTasks(): Promise<ConversationRow[]>;
	getMessages(id: string): Promise<MessageRow[]>;
	/** Incremental sync after a reconnect: rows newer than `sinceTs` + the next cursor. */
	getMessagesSince(id: string, cursor: { createdAt: number; rowid: number } | undefined): Promise<{ rows: MessageRow[]; cursor: { createdAt: number; rowid: number } }>;
	deleteTask(id: string): Promise<boolean>;
	getAutostart(): Promise<boolean>;
	setAutostart(enabled: boolean): Promise<boolean>;
	simulateIM(conversationId: string, text: string, actor?: { senderId: string; senderName?: string; channel: string; chatType: "single" | "group" }): Promise<string>;
	imChannels(): Promise<string[]>;
	imChannelStatuses(): Promise<Array<{
		id: string;
		channel: string;
		displayName: string;
		capabilities: { streaming: boolean; proactive: boolean; groupMention: boolean; media: boolean };
		health: { connected: boolean; startedAt?: number; lastError?: string; lastInboundAt?: number; lastOutboundAt?: number } | null;
	}>>;
	onConfigChanged(cb: () => void): () => void;
	onImActivity(cb: (conversationId: string) => void): () => void;
	listModels(): Promise<import("./lib/types").ModelOption[]>;
	testModel(supplier: Supplier, modelId: string): Promise<{ ok: boolean; reply: string }>;
	modelCapabilities(supplier: Supplier): Promise<Record<string, boolean>>;
	importModelConfig(): Promise<ModelConfig | null>;
	exportModelConfig(model: ModelConfig): Promise<boolean>;
	setDefaultModel(supplierId: string, modelId: string): Promise<AppConfig>;
	setConversationModel(conversationId: string, supplierId: string, modelId: string): Promise<boolean>;
	/** Empty supplierId/modelId clears the pin (conversation follows the global default). */
	clearConversationModel(conversationId: string): Promise<boolean>;
	// 供应商账号登录（electron/preload.ts 同步维护）。登录进度由主进程推送
	// 全量 AuthLoginState 快照（onAuthLoginEvent）；答复经 authLoginAnswer。
	authCatalog(): Promise<import("../../src/shared/auth").AuthCatalogResponse>;
	authLogin(provider: string): Promise<import("../../src/shared/auth").AuthLoginState>;
	authLoginStatus(): Promise<import("../../src/shared/auth").AuthLoginState | null>;
	authLoginAnswer(promptId: string, value: string): Promise<boolean>;
	authLoginCancel(): Promise<boolean>;
	authLogout(provider: string): Promise<void>;
	authQuota(provider: string): Promise<import("../../src/shared/auth").AuthQuotaResponse>;
	onAuthLoginEvent(cb: (state: import("../../src/shared/auth").AuthLoginState) => void): () => void;
	/** 在系统浏览器打开 https 链接（登录弹窗「打开授权页面」）。
	 * 主进程强制 https + 来源主窗口；不开应用内子窗口。 */
	openExternal(url: string): Promise<void>;
	exportEmployee(opts?: { includeSecrets?: boolean; scope?: { history?: boolean; knowledge?: boolean; skills?: boolean } }): Promise<{ path: string; size: number } | null>;
	importEmployee(args: { mode: "new" | "overwrite"; profileName?: string }): Promise<{ done: boolean; mode?: string; profileName?: string; summary?: unknown; canceled?: boolean }>;
	kbStatus(): Promise<{ fts: boolean; chunks: number }>;
	listKnowledgeEntries(includeArchived?: boolean): Promise<KnowledgeEntry[]>;
	upsertKnowledgeEntry(entry: Partial<KnowledgeEntry> & { title: string; tags: string; content: string }): Promise<KnowledgeEntry>;
	deleteKnowledgeEntry(id: string): Promise<boolean>;
	archiveKnowledgeEntry(id: string): Promise<boolean>;
	restoreKnowledgeEntry(id: string): Promise<boolean>;
	listKnowledgeDocs(): Promise<KnowledgeDoc[]>;
	deleteKnowledgeDoc(id: string): Promise<boolean>;
	searchKnowledge(query: string): Promise<SearchHit[]>;
	importKnowledge(): Promise<{ imported: number; errors: string[] }>;
	vectorStatusKnowledge(): Promise<VectorStatus>;
	reindexKnowledge(): Promise<{ total: number; indexed: number; failed: number; skipped: number }>;
	testEmbedding(input: { baseUrl: string; apiKey: string; model: string }): Promise<{ ok: boolean; dims: number; error?: string }>;
	testExternalKnowledge(cfg: ExternalProviderConfig): Promise<{ ok: boolean; count: number; error?: string }>;
	listExternalDatasets(cfg: ExternalProviderConfig): Promise<{ id: string; name: string }[]>;
	listExternalKnowledgeDocs(providerId: string): Promise<ExternalDoc[]>;
	parseExternalKnowledge(providerId: string, documentId?: string): Promise<{ ok: boolean; parsed: number; error?: string }>;
	uploadExternalKnowledge(providerId: string): Promise<{ ok: boolean; documentIds: string[]; parsed: boolean; canceled?: boolean; error?: string }>;
	consolidateKnowledge(): Promise<{ merged: number; archived: number; derived: number; retagged: number; skipped: number; error?: string }>;
	researchGapsKnowledge(): Promise<{ researched: number; gaps: number; skipped: number; error?: string }>;
	learnStatusKnowledge(): Promise<{
		learnEnabled: boolean;
		consolidateEnabled: boolean;
		intervalMinutes: number;
		consolidatedAt: number;
		researchedAt: number;
		learnedCount: number;
		derivedCount: number;
		researchCount: number;
		pendingCount: number;
		archivedCount: number;
		researchEnabled: boolean;
		gapCount: number;
	}>;
	listKnowledgeGaps(limit?: number): Promise<KbGap[]>;
	resolveKnowledgeGap(query: string): Promise<boolean>;
	approveKnowledgeEntry(id: string): Promise<boolean>;
	listDocuments(): Promise<ResourceRow[]>;
	addDocument(input: ResourceInput): Promise<ResourceRow>;
	updateDocument(id: string, patch: Partial<ResourceInput>): Promise<ResourceRow | null>;
	deleteDocument(id: string): Promise<boolean>;
	uploadDocument(meta?: Partial<ResourceInput>): Promise<{ created: number; ids: string[] }>;
	documentsDir(): Promise<string>;
	pickDirectory(): Promise<string | null>;
	listSkills(): Promise<SkillInfo[]>;
	refreshSkills(): Promise<boolean>;
	importSkills(): Promise<{ imported: number; skipped: number; errors: string[] }>;
	deleteSkill(filePath: string): Promise<boolean>;
	setEnabledSkill(name: string, enabled: boolean): Promise<boolean>;
	getUpdateState(): Promise<UpdateState>;
	checkForUpdates(): Promise<UpdateState>;
	downloadUpdate(): Promise<UpdateState>;
	installUpdate(): Promise<boolean>;
	onUpdateEvent(cb: (state: UpdateState) => void): () => void;
}

declare global {
	interface Window {
		api: RendererApi;
	}
}
