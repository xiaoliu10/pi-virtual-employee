/// <reference types="vite/client" />

import type { AppConfig, ExternalDoc, ExternalProviderConfig, KbGap, KnowledgeDoc, KnowledgeEntry, ModelConfig, ResourceInput, ResourceRow, ScheduledTaskRow, SearchHit, SkillInfo, Supplier, UpdateState, VectorStatus } from "./lib/types";
import type { ConversationRow, MessageRow } from "./lib/types";

/** Whitelisted API bridged by electron/preload.ts. Kept in sync manually. */
export interface RendererApi {
	getServerPort(): Promise<number>;
	getConfig(): Promise<AppConfig>;
	setConfig(patch: unknown): Promise<AppConfig>;
	previewPrompt(): Promise<string>;
	defaultPromptRules(): Promise<string>;
	listScheduledTasks(): Promise<ScheduledTaskRow[]>;
	deleteScheduledTask(id: string): Promise<boolean>;
	toggleScheduledTask(id: string, enabled: boolean): Promise<boolean>;
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
	deleteTask(id: string): Promise<boolean>;
	getAutostart(): Promise<boolean>;
	setAutostart(enabled: boolean): Promise<boolean>;
	simulateIM(conversationId: string, text: string): Promise<string>;
	imChannels(): Promise<string[]>;
	onImActivity(cb: (conversationId: string) => void): () => void;
	listModels(): Promise<import("./lib/types").ModelOption[]>;
	testModel(supplier: Supplier, modelId: string): Promise<{ ok: boolean; reply: string }>;
	modelCapabilities(supplier: Supplier): Promise<Record<string, boolean>>;
	importModelConfig(): Promise<ModelConfig | null>;
	exportModelConfig(model: ModelConfig): Promise<boolean>;
	setConversationModel(conversationId: string, supplierId: string, modelId: string): Promise<boolean>;
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
