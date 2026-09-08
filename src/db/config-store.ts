/**
 * Typed config store. The whole AppConfig is persisted as one JSON blob under
 * the `appconfig` key. Reads and updates normalize the model configuration so
 * the default always points to an enabled supplier and an existing model.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./sqlite.js";
import { normalizeTimeoutSec } from "../shared/timeouts.js";

export type ApiType = "anthropic" | "openai";
export type IMChannelType = "dingtalk" | "feishu" | "wecom" | "echo";

/** One configured IM channel instance (multiple may run concurrently). */
export interface ImChannelConfig {
	id: string;
	type: IMChannelType;
	enabled: boolean;
	name: string;
	appId: string;
	appSecret: string;
	/** DingTalk only: interactive-card (高级版) template id for GFM/table rendering. */
	cardTemplateId?: string;
}

const CHANNEL_LABELS: Record<IMChannelType, string> = {
	dingtalk: "钉钉 DingTalk",
	feishu: "飞书 Lark",
	wecom: "企业微信",
	echo: "Echo（测试通道）",
};

export function isValidChannelType(t: unknown): t is IMChannelType {
	return t === "dingtalk" || t === "feishu" || t === "wecom" || t === "echo";
}

/** Build a well-formed channel config, filling defaults (used by UI + migration). */
export function newChannelConfig(partial: Partial<ImChannelConfig> = {}): ImChannelConfig {
	const type: IMChannelType = isValidChannelType(partial.type) ? partial.type : "dingtalk";
	return {
		id: partial.id?.trim() || randomUUID(),
		type,
		enabled: partial.enabled ?? false,
		name: partial.name?.trim() || CHANNEL_LABELS[type],
		appId: partial.appId ?? "",
		appSecret: partial.appSecret ?? "",
		cardTemplateId: partial.cardTemplateId?.trim() || "",
	};
}

export interface Supplier {
	id: string;
	name: string;
	enabled: boolean;
	apiType: ApiType;
	baseUrl: string;
	apiKey: string;
	models: string[];
	/**
	 * Per-model image-input override. Key = modelId. Absent → inherit the base
	 * model registry's capability; `true`/`false` forces vision on/off. Lets the
	 * user correct relay/alias models whose real image support differs from the
	 * matched base model.
	 */
	modelImage?: Record<string, boolean>;
	/**
	 * Per-model context window override (tokens). Key = modelId. Absent →
	 * inherit the base registry model's contextWindow. Custom relay/alias models
	 * (e.g. a qwen served behind an OpenAI-compatible gateway) otherwise inherit
	 * an unrelated base model's ~128k window; once the real conversation passes
	 * that figure, pi-ai clamps max_completion_tokens to 1 and the model returns
	 * empty text — the "模型连续多次未返回内容" failure mode.
	 */
	modelContextWindow?: Record<string, number>;
}

export interface ModelConfig {
	suppliers: Supplier[];
	defaultSupplierId: string;
	defaultModelId: string;
}

/** A pluggable external knowledge source (RAGFlow / Dify / self-built REST). */
export type ExternalPresetType = "ragflow" | "dify" | "custom";

/** One HTTP operation template (search / upload / parse / list). Presets fill these. */
export interface ExternalOpTemplate {
	method: "GET" | "POST";
	/** Path relative to baseUrl. Supports {{datasetId}} {{query}} {{topK}} {{documentId}} placeholders. */
	path: string;
	/** Extra request headers (the Authorization header is auto-injected from apiKey). */
	headers?: Record<string, string>;
	/** JSON body template (POST, non-multipart). */
	bodyTemplate?: string;
	/** When set, the file is sent as multipart/form-data under this field name. */
	multipartField?: string;
}

export interface ExternalResponseMapping {
	/** Dot-path to the results array in the search response. */
	resultsPath: string;
	snippetPath: string;
	titlePath?: string;
	sourcePath?: string;
}

export interface ExternalListMapping {
	documentsPath: string;
	idPath: string;
	namePath: string;
	statusPath?: string;
}

/** Mapping for the "list datasets" operation (populate the datasetId dropdown). */
export interface ExternalDatasetsMapping {
	/** Dot-path to the datasets array in the response. */
	resultsPath: string;
	idPath: string;
	namePath: string;
}

export interface ExternalProviderConfig {
	id: string;
	name: string;
	enabled: boolean;
	/** Preset type — selecting it fills the operation templates (custom = blank, user-defined). */
	type: ExternalPresetType;
	baseUrl: string;
	apiKey: string;
	datasetId: string;
	operations: {
		search: ExternalOpTemplate;
		upload?: ExternalOpTemplate;
		parse?: ExternalOpTemplate;
		list?: ExternalOpTemplate;
		/** List all accessible datasets (no datasetId needed) — for the dataset picker. */
		datasets?: ExternalOpTemplate;
	};
	responseMapping: ExternalResponseMapping;
	listMapping?: ExternalListMapping;
	datasetsMapping?: ExternalDatasetsMapping;
}

/**
 * Knowledge-base config. `mode` is additive, not exclusive: "external" means
 * local content is still searched and fused with the external source(s).
 * Embedding reuses a configured OpenAI-compatible supplier (Anthropic has none).
 */
export interface KbConfig {
	enabled: boolean;
	mode: "local" | "external";
	local: {
		hybrid: { bm25Weight: number; vectorWeight: number; vectorEnabled: boolean };
		rerank: { enabled: boolean; kind: "none" | "llm" | "api"; topN: number };
		topK: number;
		embedding: {
			/** "supplier" reuses a configured OpenAI-compatible supplier; "custom" uses baseUrl+apiKey below. */
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
	/** Whether the employee may curate the knowledge base mid-conversation (list/archive/delete/restore entries). */
	manage: {
		enabled: boolean;
	};
	/** Auto-research: when the KB misses, the employee may web-search and sediment findings (pending/low-confidence). */
	research: {
		enabled: boolean;
		engine: "duckduckgo" | "custom";
	};
}

export interface AppConfig {
	model: ModelConfig;
	identity: {
		name: string;
		/** Employee role/type, e.g. "虚拟客服" — used in the persona header + identity block. */
		role: string;
		/** Duty / service description, e.g. "在线为客户提供专业、礼貌、高效的服务". */
		duty: string;
		/** Service hours label, e.g. "7×24h". */
		serviceHours: string;
	};
	im: {
		enabled: boolean;
		channels: ImChannelConfig[];
		/** On-receipt acknowledgement: instantly reply a short message before the (slow) model runs. */
		ack: { enabled: boolean; text: string };
	};
	general: {
		autostart: boolean;
		/** Employee reply language. Drives the language directive in the system prompt. */
		language: "zh-CN" | "en-US";
		/**
		 * Per-LLM-request timeout in minutes. 0 = provider SDK default
		 * (≈10 min for Anthropic). Raise this for slow relays / long tool turns.
		 */
		requestTimeoutMin: number;
		/**
		 * Long-task progress heartbeat (minutes). When an IM turn runs longer than
		 * this, a brief in-progress note is pushed to the channel. 0 = disabled.
		 */
		longTaskProgressMin: number;
		/**
		 * Per-turn tool-loop cap. Each "step" is one assistant response that fired
		 * tool calls and received their results. After this many steps the agent
		 * loop is stopped gracefully and the model is asked to produce a final
		 * answer from what it has gathered. 0 = unlimited (preserves prior behavior;
		 * use a positive number as a safety net against an infinite tool-call loop).
		 */
		maxToolSteps: number;
		/**
		 * Unattended auto-update mode. "full" (default for fresh installs and
		 * configs predating this tri-state): check → download → idle → restart &
		 * install without a human. "download_only": check + download, but STOP at
		 * ready — the install only happens on an explicit admin request (IM
		 * manage_update update with confirmation, or the settings-page button).
		 * Intended for hosts where the unattended NSIS install wedges. "off":
		 * interactive flow (announce, download on click). Legacy persisted values
		 * map: true → "full", false → "off".
		 */
		autoUpdate: boolean | "full" | "download_only" | "off";
	};
	/**
	 * Computer-use / browser automation. When enabled the employee gets Playwright
	 * browser tools (navigate / click / type / screenshot / read). `allowedDomains`
	 * restricts which hosts it may open (empty = unrestricted — use with care).
	 */
	browser: { enabled: boolean; headless: boolean; allowedDomains: string[]; downloadHost: string };
	/** Scheduled tasks: the employee may create timed tasks in conversation; the scheduler runs them at their cron time. */
	scheduler: { enabled: boolean };
	prompt: {
		/** Editable extra instructions appended after the base prompt. */
		extra: string;
		/**
		 * Optional override for the employee's core behavioral rules (the 工作准则
		 * block). Empty → use the built-in default rules. When set, replaces the
		 * default core rules verbatim (capability/tool rules are still appended
		 * automatically based on enabled features).
		 */
		rules: string;
	};
	kb: KbConfig;
	/**
	 * Document resources: a catalog of deliverable docs (interface docs, specs, …)
	 * the employee can hand to integration partners. `dir` is where uploaded files
	 * are copied (empty → default under userData/documents). When enabled the
	 * employee gets list/provide/save document tools.
	 */
	documents: { enabled: boolean; dir: string };
	/**
	 * Local filesystem access (scoped, read-only listing + authorized delete).
	 * `allowedDirs` is a whitelist the employee may operate in (`~` expanded at
	 * runtime); anything outside is refused. Delete always requires explicit user
	 * authorization (two-step confirmed gate in the tool).
	 */
	filesystem: { enabled: boolean; allowedDirs: string[] };
	/**
	 * Restricted shell/command execution for headless-server operations
	 * (inspect processes, terminate one PID, inspect system/network state). Off by
	 * default; every execution additionally requires an admin's explicit
	 * confirmation in the CURRENT message. `allowedCommands` whitelists the
	 * executable names (e.g. "tasklist", "npx"); "*" allows anything (dangerous —
	 * a stolen admin IM account then equals full server control).
	 */
	capabilities: {
		shell: {
			enabled: boolean;
			allowedCommands: string[];
			/** Synchronous-command runtime limit in seconds. Default 60; 0 = unlimited. */
			timeoutSec: number;
			/** Background-command runtime limit in seconds. Default 0 = unlimited. */
			backgroundTimeoutSec: number;
			/** Default blocking wait for a process poll. 0 = return immediately. */
			pollTimeoutSec: number;
		};
	};
	/**
	 * Report / artifact center. Generated reports (scheduled-task outputs, etc.)
	 * are persisted locally (with run history) and pushed to a configurable Gitee
	 * repo; the IM push carries a shareable link. EVERY field is instance-specific
	 * — owner/repo/branch/tokens are all user-configured, nothing is hard-coded.
	 */
	reports: {
		enabled: boolean;
		/** Which publisher pushes reports: "gitee" (repo commit + raw link) or "oss" (Aliyun OSS + presigned URL). */
		target: "gitee" | "oss";
		publish: {
			/**
			 * How the Gitee share link is built from the pushed file path.
			 * - raw_with_token: `{webUrl}/{owner}/{repo}/raw/{branch}/{path}?access_token={readToken}` — tries to let readers open without login. Gitee may still require a collaborator login for private repos; if so switch mode.
			 * - web_blob: `{webUrl}/{owner}/{repo}/blob/{branch}/{path}` — Gitee's online view page; collaborators log in to view.
			 * - public: raw URL without token — use only with a public report repo.
			 */
			linkMode: "raw_with_token" | "web_blob" | "public";
		};
		gitee: {
			/** Gitee OpenAPI base, e.g. https://gitee.com/api/v5 */
			apiUrl: string;
			/** Gitee web base for building raw/blob links, e.g. https://gitee.com */
			webUrl: string;
			/** Repo owner (user/org name). */
			owner: string;
			/** Repo name. */
			repo: string;
			/** Target branch (created if missing on first push). Default "main". */
			branch: string;
			/** Subpath inside the repo, e.g. "reports/". Empty = repo root. */
			basePath: string;
			/** Personal access token with push scope — used to commit files. */
			writeToken: string;
			/** Token appended to raw links for read access (may equal writeToken). */
			readToken: string;
			/** Optional commit author name. */
			commitAuthor: string;
			/** Optional commit author email. */
			commitEmail: string;
		};
		/**
		 * Aliyun OSS publisher: putObject the report body into a private bucket and
		 * return a presigned GET URL (anyone with the link can read until expiry,
		 * no login required). region/bucket/credentials/endpoint all configurable.
		 */
		oss: {
			region: string;
			accessKeyId: string;
			accessKeySecret: string;
			bucket: string;
			/** Custom endpoint, e.g. https://oss-cn-hangzhou.aliyuncs.com or an internal/CDN domain. */
			endpoint: string;
			/** Prefix (virtual "folder") inside the bucket, e.g. "reports/". */
			basePath: string;
			/** Presigned URL validity in seconds (default 30 days). */
			urlTtlSec: number;
		};
	};
	/**
	 * Browser downloads: files the automated browser saves are captured into a
	 * managed workspace so the employee can list/read/analyze them. `dir` empty →
	 * default under userData/downloads. maxSizeMb rejects oversized files;
	 * retainDays is reserved for future cleanup. Per-instance, nothing hard-coded.
	 */
	downloads: {
		enabled: boolean;
		dir: string;
		maxSizeMb: number;
		retainDays: number;
	};
	/** Skills: declarative SKILL.md packages injected into the system prompt. */
	skills: {
		/** Disabled skill names (built-in or user); everything else is active. */
		disabled: string[];
	};
	/**
	 * Security: conversation-side admin gate. `adminStaffIds` is the whitelist of
	 * IM sender ids (e.g. DingTalk senderStaffId) allowed to manage this
	 * employee's identity/admin list from a 1:1 chat. EMPTY = unclaimed: the
	 * first sender to claim in a 1:1 chat becomes the (only) admin; once
	 * non-empty, only listed ids may operate. The whitelist itself can also be
	 * edited from the desktop settings UI as a recovery path.
	 */
	security: {
		adminStaffIds: string[];
	};
}

const DEFAULTS: AppConfig = {
	model: { suppliers: [], defaultSupplierId: "", defaultModelId: "" },
	identity: { name: "客服小派", role: "虚拟客服", duty: "在线为客户提供专业、礼貌、高效的服务", serviceHours: "7×24h" },
	im: { enabled: false, channels: [], ack: { enabled: true, text: "👍 收到，正在处理…" } },
	general: { autostart: false, language: "zh-CN", requestTimeoutMin: 0, longTaskProgressMin: 30, maxToolSteps: 20, autoUpdate: true },
	browser: { enabled: false, headless: true, allowedDomains: [], downloadHost: "" },
	scheduler: { enabled: true },
	prompt: { extra: "", rules: "" },
	documents: { enabled: false, dir: "" },
	filesystem: { enabled: false, allowedDirs: ["~/Downloads"] },
	capabilities: { shell: { enabled: false, allowedCommands: ["tasklist", "taskkill", "ping", "ipconfig", "systeminfo", "whoami", "hostname", "netstat", "where"], timeoutSec: 60, backgroundTimeoutSec: 0, pollTimeoutSec: 30 } },
	reports: {
		enabled: false,
		target: "gitee",
		publish: { linkMode: "raw_with_token" },
		gitee: {
			apiUrl: "https://gitee.com/api/v5",
			webUrl: "https://gitee.com",
			owner: "",
			repo: "",
			branch: "main",
			basePath: "reports/",
			writeToken: "",
			readToken: "",
			commitAuthor: "",
			commitEmail: "",
		},
		oss: {
			region: "oss-cn-hangzhou",
			accessKeyId: "",
			accessKeySecret: "",
			bucket: "",
			endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
			basePath: "reports/",
			urlTtlSec: 30 * 24 * 3600,
		},
	},
	downloads: { enabled: true, dir: "", maxSizeMb: 200, retainDays: 30 },
	skills: { disabled: [] },
	security: { adminStaffIds: [] },
	kb: {
		enabled: true,
		mode: "local",
		local: {
			hybrid: { bm25Weight: 0.5, vectorWeight: 0.5, vectorEnabled: true },
			rerank: { enabled: false, kind: "none", topN: 4 },
			topK: 5,
			embedding: { mode: "supplier", supplierId: "", baseUrl: "", apiKey: "", model: "text-embedding-3-small", dimensions: 1536, batchSize: 64 },
			chunk: { size: 800, overlap: 120 },
			autoIndex: true,
		},
		external: { providers: [], activeId: "" },
		learn: {
			enabled: false,
			consolidate: { enabled: false, intervalMinutes: 360, batch: 40 },
		},
		manage: { enabled: true },
		research: { enabled: false, engine: "duckduckgo" },
	},
};

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function normalizedModels(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.filter((model): model is string => typeof model === "string")
		.map((model) => model.trim())
		.filter(Boolean))];
}

/** Coerce an untrusted admin whitelist into clean, unique, non-empty ids. */
function normalizedAdminIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.filter((id): id is string => typeof id === "string")
		.map((id) => id.trim())
		.filter(Boolean))];
}

/** Normalize the security block (admin whitelist) of a merged config. */
function normalizeSecurity(merged: AppConfig): AppConfig["security"] {
	return { adminStaffIds: normalizedAdminIds(merged.security?.adminStaffIds) };
}

/** Normalize the restricted shell whitelist and runtime limit. */
function normalizeCapabilities(merged: AppConfig): AppConfig["capabilities"] {
	const shell = merged.capabilities?.shell;
	const allowed = Array.isArray(shell?.allowedCommands)
		? [...new Set(shell.allowedCommands
			.filter((c): c is string => typeof c === "string")
			.map((c) => c.trim().toLowerCase().replace(/\.(exe|bat|cmd|com|ps1|js)$/i, ""))
			.filter((c) => c === "*" || /^[a-z0-9._-]+$/.test(c)))]
		: [];
	return {
		shell: {
			enabled: shell?.enabled === true,
			allowedCommands: allowed,
			timeoutSec: normalizeTimeoutSec(shell?.timeoutSec, DEFAULTS.capabilities.shell.timeoutSec),
			backgroundTimeoutSec: normalizeTimeoutSec(shell?.backgroundTimeoutSec, DEFAULTS.capabilities.shell.backgroundTimeoutSec),
			pollTimeoutSec: normalizeTimeoutSec(shell?.pollTimeoutSec, DEFAULTS.capabilities.shell.pollTimeoutSec),
		},
	};
}

export function newSupplier(partial: Partial<Supplier> = {}): Supplier {
	return {
		id: partial.id?.trim() || randomUUID(),
		name: partial.name?.trim() || "新供应商",
		enabled: partial.enabled ?? true,
		apiType: partial.apiType === "openai" ? "openai" : "anthropic",
		baseUrl: partial.baseUrl?.trim() ?? "",
		apiKey: partial.apiKey ?? "",
		models: normalizedModels(partial.models),
		modelImage: normalizedModelImage(partial.modelImage),
		modelContextWindow: normalizedModelContextWindow(partial.modelContextWindow),
	};
}

/** Coerce an untrusted modelImage map into `{ modelId: boolean }`; drop junk. */
function normalizedModelImage(value: unknown): Record<string, boolean> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const out: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === "boolean") out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

/** Coerce an untrusted modelContextWindow map into `{ modelId: tokens }`; drop junk. */
function normalizedModelContextWindow(value: unknown): Record<string, number> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
	}
	return Object.keys(out).length ? out : undefined;
}

/** Normalize untrusted/legacy model config and reconcile its global default. */
export function normalizeModelConfig(value: unknown): ModelConfig {
	const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const suppliers = Array.isArray(raw.suppliers)
		? raw.suppliers
			.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
			.map((entry) => newSupplier({
				id: stringValue(entry.id),
				name: stringValue(entry.name),
				enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
				apiType: entry.apiType === "openai" ? "openai" : "anthropic",
				baseUrl: stringValue(entry.baseUrl),
				apiKey: stringValue(entry.apiKey),
				models: normalizedModels(entry.models),
				modelImage: normalizedModelImage(entry.modelImage),
				modelContextWindow: normalizedModelContextWindow(entry.modelContextWindow),
			}))
		: [];

	let defaultSupplierId = stringValue(raw.defaultSupplierId);
	let defaultModelId = stringValue(raw.defaultModelId).trim();
	const current = suppliers.find((supplier) =>
		supplier.id === defaultSupplierId && supplier.enabled && supplier.models.includes(defaultModelId));

	if (!current) {
		const firstSupplier = suppliers.find((supplier) => supplier.enabled && supplier.models.length > 0);
		defaultSupplierId = firstSupplier?.id ?? "";
		defaultModelId = firstSupplier?.models[0] ?? "";
	}

	return { suppliers, defaultSupplierId, defaultModelId };
}

/**
 * Normalize IM config to the multi-channel shape. Converts the legacy
 * single-channel object ({channel, appId, appSecret}) into one channels[]
 * entry, and re-forms each stored channel through newChannelConfig.
 */
function normalizeIm(merged: AppConfig["im"]): AppConfig["im"] {
	const raw = merged as AppConfig["im"] & { channel?: unknown; appId?: unknown; appSecret?: unknown };
	const channels = Array.isArray(raw.channels)
		? (raw.channels as unknown[])
				.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
				.map((c) => newChannelConfig(c as Partial<ImChannelConfig>))
		: [];
	if (channels.length === 0 && (raw.appId || (typeof raw.channel === "string" && raw.channel))) {
		const type: IMChannelType = isValidChannelType(raw.channel) ? raw.channel : "dingtalk";
		channels.push(
			newChannelConfig({
				type,
				enabled: !!raw.enabled,
				appId: typeof raw.appId === "string" ? raw.appId : "",
				appSecret: typeof raw.appSecret === "string" ? raw.appSecret : "",
			}),
		);
	}
	const ackRaw = (raw as { ack?: unknown }).ack;
	const ack = ackRaw && typeof ackRaw === "object"
		? {
				enabled: typeof (ackRaw as { enabled?: unknown }).enabled === "boolean" ? (ackRaw as { enabled: boolean }).enabled : true,
				text: typeof (ackRaw as { text?: unknown }).text === "string" ? (ackRaw as { text: string }).text : "👍 收到，正在处理…",
			}
		: { enabled: true, text: "👍 收到，正在处理…" };
	return { enabled: !!raw.enabled, channels, ack };
}

function getKey(db: DB, key: string): string | undefined {
	return (db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined)
		?.value;
}

export function isValidExternalPresetType(t: unknown): t is ExternalPresetType {
	return t === "ragflow" || t === "dify" || t === "custom";
}

/**
 * Normalize external providers to the structured multi-operation shape.
 * Converts the legacy flat config ({url, method, headers, bodyTemplate}) into a
 * `type:"custom"` provider: the old `url` is split into baseUrl + search.path,
 * and a Bearer header is lifted into apiKey. New-shape providers are re-formed
 * defensively (valid type, a search op present).
 */
function normalizeExternalProviders(external: unknown): AppConfig["kb"]["external"] {
	const raw = (external && typeof external === "object" ? external : {}) as AppConfig["kb"]["external"] & {
		providers?: unknown[];
	};
	const providers = Array.isArray(raw.providers)
		? (raw.providers as unknown[])
				.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
				.map((p) => normalizeOneProvider(p))
		: [];
	const activeId = typeof raw.activeId === "string" && providers.some((p) => p.id === raw.activeId)
		? raw.activeId
		: "";
	return { providers, activeId };
}

function normalizeOneProvider(raw: Record<string, unknown>): ExternalProviderConfig {
	const id = typeof raw.id === "string" && raw.id ? raw.id : randomUUID();
	const type: ExternalPresetType = isValidExternalPresetType(raw.type) ? raw.type : "custom";
	const name = typeof raw.name === "string" ? raw.name : "外接知识库";
	const enabled = raw.enabled !== false;

	// Already in the new structured shape (has operations.search).
	const ops = raw.operations as Record<string, unknown> | undefined;
	if (ops && ops.search && typeof ops.search === "object") {
		return {
			id,
			name,
			enabled,
			type,
			baseUrl: stringValue(raw.baseUrl),
			apiKey: stringValue(raw.apiKey),
			datasetId: stringValue(raw.datasetId),
			operations: normalizeOperations(ops),
			responseMapping: normalizeResponseMapping(raw.responseMapping),
			listMapping: normalizeListMapping(raw.listMapping),
			datasetsMapping: normalizeDatasetsMapping(raw.datasetsMapping),
		};
	}

	// Legacy flat shape: derive a custom provider from url/method/headers/bodyTemplate.
	return migrateLegacyProvider(raw, id, name, enabled);
}

function normalizeOperations(ops: Record<string, unknown>): ExternalProviderConfig["operations"] {
	const pick = (key: string): ExternalOpTemplate | undefined => {
		const o = ops[key];
		if (!o || typeof o !== "object") return undefined;
		const op = o as Record<string, unknown>;
		const method = op.method === "GET" ? "GET" : "POST";
		const path = stringValue(op.path);
		if (!path) return undefined;
		const out: ExternalOpTemplate = { method, path };
		if (op.headers && typeof op.headers === "object") out.headers = op.headers as Record<string, string>;
		if (typeof op.bodyTemplate === "string") out.bodyTemplate = op.bodyTemplate;
		if (typeof op.multipartField === "string" && op.multipartField) out.multipartField = op.multipartField;
		return out;
	};
	const search = pick("search") ?? { method: "POST" as const, path: "" };
	return {
		search,
		upload: pick("upload"),
		parse: pick("parse"),
		list: pick("list"),
		datasets: pick("datasets"),
	};
}

function normalizeDatasetsMapping(m: unknown): ExternalDatasetsMapping | undefined {
	if (!m || typeof m !== "object") return undefined;
	const r = m as Record<string, unknown>;
	if (typeof r.resultsPath !== "string" || !r.resultsPath) return undefined;
	return {
		resultsPath: r.resultsPath,
		idPath: typeof r.idPath === "string" && r.idPath ? r.idPath : "id",
		namePath: typeof r.namePath === "string" && r.namePath ? r.namePath : "name",
	};
}

function normalizeResponseMapping(m: unknown): ExternalResponseMapping {
	const r = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
	return {
		resultsPath: stringValue(r.resultsPath, "data"),
		snippetPath: stringValue(r.snippetPath, "content"),
		titlePath: typeof r.titlePath === "string" && r.titlePath ? r.titlePath : undefined,
		sourcePath: typeof r.sourcePath === "string" && r.sourcePath ? r.sourcePath : undefined,
	};
}

function normalizeListMapping(m: unknown): ExternalListMapping | undefined {
	if (!m || typeof m !== "object") return undefined;
	const r = m as Record<string, unknown>;
	if (!r.documentsPath) return undefined;
	return {
		documentsPath: stringValue(r.documentsPath),
		idPath: stringValue(r.idPath, "id"),
		namePath: stringValue(r.namePath, "name"),
		statusPath: typeof r.statusPath === "string" && r.statusPath ? r.statusPath : undefined,
	};
}

/** Convert a legacy flat provider ({url, method, headers, bodyTemplate}) into custom ops. */
function migrateLegacyProvider(
	raw: Record<string, unknown>,
	id: string,
	name: string,
	enabled: boolean,
): ExternalProviderConfig {
	const url = stringValue(raw.url);
	let baseUrl = "";
	let searchPath = "";
	try {
		const u = new URL(url);
		baseUrl = u.origin;
		searchPath = u.pathname + u.search;
	} catch {
		baseUrl = url; // fall back: keep whole string as baseUrl
		searchPath = "";
	}
	// Lift a Bearer Authorization header into apiKey; keep any other headers.
	const headers = (raw.headers && typeof raw.headers === "object"
		? { ...(raw.headers as Record<string, string>) }
		: {});
	let apiKey = "";
	const auth = headers.Authorization ?? headers.authorization;
	const bearer = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : null;
	if (bearer) {
		apiKey = bearer[1];
		delete headers.Authorization;
		delete headers.authorization;
	}
	const method = raw.method === "GET" ? "GET" : "POST";
	const bodyTemplate = typeof raw.bodyTemplate === "string" ? raw.bodyTemplate : "";
	const search: ExternalOpTemplate = { method, path: searchPath };
	if (Object.keys(headers).length > 0) search.headers = headers;
	if (bodyTemplate) search.bodyTemplate = bodyTemplate;
	return {
		id,
		name,
		enabled,
		type: "custom",
		baseUrl,
		apiKey,
		datasetId: "",
		operations: { search },
		responseMapping: normalizeResponseMapping(raw.responseMapping),
	};
}

/** Build the default supplier from legacy flat keys, if present. */
function migrateLegacy(db: DB): Supplier | null {
	const get = (key: string) => getKey(db, key);
	const provider = get("model.provider");
	const modelId = get("model.modelId");
	if (!provider && !modelId) return null;

	const apiType: ApiType = provider === "openai" ? "openai" : "anthropic";
	const supplier = newSupplier({
		name: apiType === "openai" ? "OpenAI" : "Anthropic",
		enabled: true,
		apiType,
		baseUrl: get("model.baseUrl") ?? "",
		apiKey: apiType === "openai"
			? (get("model.apiKey.openai") ?? process.env.OPENAI_API_KEY ?? "")
			: (get("model.apiKey.anthropic") ?? process.env.ANTHROPIC_API_KEY ?? ""),
		models: modelId ? [modelId] : [],
	});

	db.prepare(
		"DELETE FROM config WHERE key IN ('model.provider','model.modelId','model.baseUrl','model.apiKey.anthropic','model.apiKey.openai')",
	).run();
	return supplier;
}

export class ConfigStore {
	constructor(private readonly db: DB) {}

	all(): AppConfig {
		const row = this.db.prepare("SELECT value FROM config WHERE key = 'appconfig'").get() as
			| { value: string }
			| undefined;

		if (row?.value) {
			try {
				const parsed = JSON.parse(row.value) as DeepPartial<AppConfig>;
				const merged = deepMerge(DEFAULTS, parsed);
				const normalized = {
					...merged,
					model: normalizeModelConfig(parsed.model ?? merged.model),
					im: normalizeIm(merged.im),
					kb: { ...merged.kb, external: normalizeExternalProviders(merged.kb.external) },
					security: normalizeSecurity(merged),
					capabilities: normalizeCapabilities(merged),
				};
				if (JSON.stringify(normalized) !== JSON.stringify(parsed)) this.persist(normalized);
				return normalized;
			} catch {
				/* fall through to legacy/default seed */
			}
		}

		const legacy = migrateLegacy(this.db);
		const cfg: AppConfig = JSON.parse(JSON.stringify(DEFAULTS));
		const legacyIm = {
			enabled: getKey(this.db, "im.enabled") === "1",
			channel: getKey(this.db, "im.channel"),
			appId: getKey(this.db, "im.appId"),
			appSecret: getKey(this.db, "im.appSecret"),
		};
		if (legacyIm.channel || legacyIm.enabled || legacyIm.appId) {
			const type: IMChannelType = isValidChannelType(legacyIm.channel) ? legacyIm.channel : "dingtalk";
			cfg.im = {
				enabled: legacyIm.enabled,
				channels: [
					newChannelConfig({
						type,
						enabled: legacyIm.enabled,
						appId: legacyIm.appId ?? "",
						appSecret: legacyIm.appSecret ?? "",
					}),
				],
				ack: { enabled: true, text: "👍 收到，正在处理…" },
			};
		}
		const legacyName = getKey(this.db, "identity.name");
		if (legacyName) cfg.identity.name = legacyName;
		const legacyAutostart = getKey(this.db, "general.autostart");
		if (legacyAutostart !== undefined) cfg.general.autostart = legacyAutostart === "1";
		this.db.prepare(
			"DELETE FROM config WHERE key IN ('im.enabled','im.channel','im.appId','im.appSecret','identity.name','general.autostart')",
		).run();

		if (legacy) {
			cfg.model = normalizeModelConfig({
				suppliers: [legacy],
				defaultSupplierId: legacy.id,
				defaultModelId: legacy.models[0] ?? "",
			});
		} else {
			const seed = newSupplier({
				name: "Anthropic",
				enabled: true,
				apiType: "anthropic",
				models: ["claude-sonnet-4-5"],
			});
			cfg.model = normalizeModelConfig({
				suppliers: [seed],
				defaultSupplierId: seed.id,
				defaultModelId: seed.models[0],
			});
		}
		this.persist(cfg);
		return cfg;
	}

	update(patch: DeepPartial<AppConfig>): AppConfig {
		const merged = deepMerge(this.all(), patch);
		const normalized = {
			...merged,
			model: normalizeModelConfig(merged.model),
			im: normalizeIm(merged.im),
			kb: { ...merged.kb, external: normalizeExternalProviders(merged.kb.external) },
			security: normalizeSecurity(merged),
			capabilities: normalizeCapabilities(merged),
		};
		this.persist(normalized);
		return normalized;
	}

	/**
	 * Fully replace config from an imported employee package. Unlike `update`
	 * (which merges onto the current config), this treats `cfg` as the whole
	 * new config: deep-merged onto DEFAULTS only, normalized, then persisted.
	 */
	replaceAll(cfg: unknown): AppConfig {
		const parsed = (cfg && typeof cfg === "object" ? cfg : {}) as DeepPartial<AppConfig>;
		const merged = deepMerge(DEFAULTS, parsed);
		const normalized = {
			...merged,
			model: normalizeModelConfig(parsed.model ?? merged.model),
			im: normalizeIm(merged.im),
			kb: { ...merged.kb, external: normalizeExternalProviders(merged.kb.external) },
			security: normalizeSecurity(merged),
			capabilities: normalizeCapabilities(merged),
		};
		this.persist(normalized);
		return normalized;
	}

	private persist(cfg: AppConfig): void {
		this.db
			.prepare(
				"INSERT INTO config (key, value) VALUES ('appconfig', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(JSON.stringify(cfg));
	}
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
	if (!patch) return base;
	const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
	for (const k of Object.keys(patch)) {
		const value = (patch as any)[k];
		if (value === undefined) continue;
		out[k] = typeof value === "object" && value !== null && !Array.isArray(value)
			? deepMerge((base as any)[k] ?? {}, value)
			: value;
	}
	return out as T;
}
