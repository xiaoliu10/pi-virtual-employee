/** Domain types shared across the renderer (mirror the main-process shapes). */

export type ApiType = "anthropic" | "openai";
export type IMChannel = "feishu" | "dingtalk" | "wecom" | "echo";

/** One configured IM channel instance (mirror of src/db/config-store.ts). */
export interface ImChannelConfig {
	id: string;
	type: IMChannel;
	enabled: boolean;
	name: string;
	appId: string;
	appSecret: string;
}

export interface Supplier {
	id: string;
	name: string;
	enabled: boolean;
	apiType: ApiType;
	baseUrl: string;
	apiKey: string;
	models: string[];
	/** Per-model image-input override (absent → inherit base registry capability). */
	modelImage?: Record<string, boolean>;
	/** Per-model context window override in tokens (absent → inherit base). Set
	 * this for relay/alias models whose real window differs, e.g. qwen-200k. */
	modelContextWindow?: Record<string, number>;
}

export interface ModelOption {
	supplierId: string;
	supplierName: string;
	apiType: ApiType;
	modelId: string;
	isDefault: boolean;
}

export interface ModelConfig {
	suppliers: Supplier[];
	defaultSupplierId: string;
	defaultModelId: string;
}

/** A pluggable external knowledge source (RAGFlow / Dify / self-built REST). */
export type ExternalPresetType = "ragflow" | "dify" | "custom";

export interface ExternalOpTemplate {
	method: "GET" | "POST";
	path: string;
	headers?: Record<string, string>;
	bodyTemplate?: string;
	multipartField?: string;
}

export interface ExternalListMapping {
	documentsPath: string;
	idPath: string;
	namePath: string;
	statusPath?: string;
}

export interface ExternalDatasetsMapping {
	resultsPath: string;
	idPath: string;
	namePath: string;
}

export interface ExternalDoc {
	id: string;
	name: string;
	status?: string;
}

export interface ExternalProviderConfig {
	id: string;
	name: string;
	enabled: boolean;
	type: ExternalPresetType;
	baseUrl: string;
	apiKey: string;
	datasetId: string;
	operations: {
		search: ExternalOpTemplate;
		upload?: ExternalOpTemplate;
		parse?: ExternalOpTemplate;
		list?: ExternalOpTemplate;
		datasets?: ExternalOpTemplate;
	};
	responseMapping: {
		resultsPath: string;
		snippetPath: string;
		titlePath?: string;
		sourcePath?: string;
	};
	listMapping?: ExternalListMapping;
	datasetsMapping?: ExternalDatasetsMapping;
}

/** Knowledge-base config. Mirror of src/db/config-store.ts KbConfig. */
export interface KbConfig {
	enabled: boolean;
	mode: "local" | "external";
	local: {
		hybrid: { bm25Weight: number; vectorWeight: number; vectorEnabled: boolean };
		rerank: { enabled: boolean; kind: "none" | "llm" | "api"; topN: number };
		topK: number;
		embedding: {
			mode: "supplier" | "custom";
			supplierId: string;
			baseUrl: string;
			apiKey: string;
			model: string;
			dimensions: number;
			batchSize: number;
		};
		chunk: { size: number; overlap: number };
		autoIndex: boolean;
	};
	external: { providers: ExternalProviderConfig[]; activeId: string };
	learn: {
		enabled: boolean;
		consolidate: { enabled: boolean; intervalMinutes: number; batch: number };
	};
	manage: { enabled: boolean };
	research: { enabled: boolean; engine: "duckduckgo" | "custom" };
}

export interface AppConfig {
	model: ModelConfig;
	identity: {
		name: string;
		role: string;
		duty: string;
		serviceHours: string;
	};
	im: {
		enabled: boolean;
		channels: ImChannelConfig[];
		ack: { enabled: boolean; text: string };
	};
	general: { autostart: boolean; language: "zh-CN" | "en-US"; requestTimeoutMin: number; longTaskProgressMin: number; maxToolSteps: number; autoUpdate: boolean };
	browser: { enabled: boolean; headless: boolean; allowedDomains: string[] };
	scheduler: { enabled: boolean };
	prompt: { extra: string; rules: string };
	kb: KbConfig;
	documents: { enabled: boolean; dir: string };
	filesystem: { enabled: boolean; allowedDirs: string[] };
	/** Restricted shell command execution (run_command tool) for headless-server ops. */
	capabilities: { shell: { enabled: boolean; allowedCommands: string[] } };
	reports: {
		enabled: boolean;
		target: "gitee" | "oss";
		publish: { linkMode: "raw_with_token" | "web_blob" | "public" };
		gitee: {
			apiUrl: string;
			webUrl: string;
			owner: string;
			repo: string;
			branch: string;
			basePath: string;
			writeToken: string;
			readToken: string;
			commitAuthor: string;
			commitEmail: string;
		};
		oss: {
			region: string;
			accessKeyId: string;
			accessKeySecret: string;
			bucket: string;
			endpoint: string;
			basePath: string;
			urlTtlSec: number;
		};
	};
	security: { adminStaffIds: string[] };
}

/** A deliverable document resource (file or online link) for integration partners. */
export interface ResourceRow {
	id: string;
	name: string;
	description: string | null;
	kind: "file" | "link";
	filePath: string | null;
	url: string | null;
	partners: string[];
	scenario: string | null;
	tags: string[];
	createdAt: number;
	updatedAt: number;
}

/** Input for creating/updating a document resource (UI + agent save). */
export interface ResourceInput {
	name: string;
	kind: "file" | "link";
	url?: string | null;
	filePath?: string | null;
	partners?: string[];
	scenario?: string | null;
	description?: string | null;
	tags?: string[];
}

export interface KnowledgeEntry {
	id: string;
	title: string;
	tags: string;
	content: string;
	origin: string;
	archived: number;
	created_at: number;
	updated_at: number;
	version: number;
	lineage: string | null;
	confidence: number;
	source_url: string | null;
	review_status: string;
	hit_count: number;
	last_used_at: number | null;
	superseded_by: string | null;
}

export interface KnowledgeDoc {
	id: string;
	name: string;
	chunks: number;
	created_at: number;
}

/** A recorded knowledge-base miss (auto-research loop). Mirror of src/knowledge/store.ts KbGap. */
export interface KbGap {
	id: string;
	query: string;
	count: number;
	last_seen: number;
	created_at: number;
}

export interface SearchHit {
	id: string;
	source: string;
	title: string | null;
	tags: string | null;
	snippet: string;
}

/** Vector index status. Mirror of src/knowledge/knowledge-service.ts VectorStatus. */
export interface VectorStatus {
	available: boolean;
	enabled: boolean;
	dims: number;
	pending: number;
	indexed: number;
	failed: number;
}

export interface SkillInfo {
	name: string;
	description: string;
	source: "builtin" | "user";
	filePath: string;
	enabled: boolean;
	warnings?: string[];
}

export interface ConversationRow {
	id: string;
	title: string | null;
	created_at: number;
	updated_at: number;
	model_supplier_id: string | null;
	model_model_id: string | null;
	/** 'console' (desktop UI) or 'im' (messaging channel — read-only in the console). */
	origin: string;
}

export interface MessageRow {
	id: string;
	conversation_id: string;
	role: "user" | "assistant";
	content: string;
	created_at: number;
}

/** A scheduled task (created in conversation or via settings, run by the scheduler). */
export interface ScheduledTaskRow {
	id: string;
	title: string;
	prompt: string;
	cron: string;
	enabled: number; // 0 | 1
	conversation_id: string | null;
	origin: string;
	last_run_at: number | null;
	next_run_at: number | null;
	last_status: string | null;
	created_at: number;
	updated_at: number;
}

/** A logical report/artifact in the report center (system-generated, versioned per run). */
export interface Artifact {
	id: string;
	kind: string;
	source: string;
	sourceRef: string | null;
	title: string;
	summary: string | null;
	partner: string | null;
	scenario: string | null;
	tags: string[];
	retentionDays: number | null;
	createdAt: number;
	updatedAt: number;
}

/** One generation of an artifact (a run), with status + timing. */
export interface ArtifactRun {
	id: string;
	artifactId: string;
	trigger: string;
	status: "running" | "ok" | "partial" | "error";
	startedAt: number;
	finishedAt: number | null;
	durationMs: number | null;
	error: string | null;
	summary: string | null;
	metrics: Record<string, unknown> | null;
	inputRef: string | null;
	createdAt: number;
}

/** The body/file of a run. */
export interface ArtifactAttachment {
	id: string;
	runId: string;
	type: string;
	storage: "sqlite" | "fs";
	content: string | null;
	filePath: string | null;
	fileName: string | null;
	mime: string | null;
	sizeBytes: number;
	checksum: string | null;
	createdAt: number;
}

/**
 * Auto-updater state pushed/pulled from the main process. `phase` is the
 * machine position: idle → checking → available → downloading → ready (or
 * none / error). Only the packaged Windows build actually runs the updater —
 * everywhere else it sits at "idle" so the UI shows the version, not buttons.
 */
export type UpdateState =
	| { phase: "idle"; currentVersion: string }
	| { phase: "checking"; currentVersion: string }
	| { phase: "available"; currentVersion: string; version: string; releaseNotes?: string; manualUrl: string }
	| { phase: "none"; currentVersion: string }
	| { phase: "downloading"; currentVersion: string; version: string; percent: number }
	| { phase: "ready"; currentVersion: string; version: string }
	| { phase: "error"; currentVersion: string; message: string };
