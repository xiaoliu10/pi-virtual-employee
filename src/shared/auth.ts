/**
 * Shared contract between main (auth service) and renderer (settings UI) for
 * provider account login. Backed by pi-ai Models: login/logout/getAuth run in
 * the main process; the renderer only ever sees metadata and login-flow events,
 * never tokens.
 *
 * Credential file: `<pi-agent-dir>/auth.json` — the SAME file pi CLI uses, so a
 * login here is a login everywhere (and vice versa). The agent dir resolves as
 * `PI_CODING_AGENT_DIR` env, else `~/.pi` (pi CLI convention).
 */

/** Providers exposed in the settings UI, in display order. */
export const AUTH_CATALOG_PROVIDER_IDS = [
	"openai-codex", // ChatGPT Plus/Pro (OAuth, PKCE browser flow)
	// "openai-chatgpt" is DELIBERATELY absent: pi-ai does not register a model
	// provider for the legacy ChatGPT backend yet, so login errors out and the
	// catalog entry can never yield models — a dead end. Re-add when pi-ai
	// ships a registered openai-chatgpt provider.
	"anthropic", // Claude Pro/Max (OAuth, PKCE browser flow)
	"kimi-coding", // Kimi Coding Plan (OAuth device code)
	"github-copilot", // GitHub Copilot (OAuth device flow)
	"xai", // SuperGrok / X Premium (OAuth)
	"openrouter", // OpenRouter (OAuth)
	"meta", // Meta (OAuth)
	"zai", // Z.ai Coding Plan intl (API key paste + quota; no OAuth in pi-ai)
	"zai-coding-cn", // Z.ai Coding Plan China (API key paste + quota)
] as const;

export type AuthCatalogProviderId = (typeof AUTH_CATALOG_PROVIDER_IDS)[number];

/** Static display metadata (pi-ai owns flows; we own labels/order). */
export const AUTH_PROVIDER_LABELS: Record<AuthCatalogProviderId, { name: string; description: string; kind: "oauth" | "api_key" }> = {
	"openai-codex": { name: "OpenAI（ChatGPT 账号）", description: "用 ChatGPT Plus/Pro 账号授权，浏览器完成登录", kind: "oauth" },
	anthropic: { name: "Anthropic（Claude Pro/Max）", description: "用 Claude 订阅账号授权，浏览器完成登录", kind: "oauth" },
	"kimi-coding": { name: "Kimi Coding Plan", description: "设备码登录：打开网页输入码即可", kind: "oauth" },
	"github-copilot": { name: "GitHub Copilot", description: "GitHub 设备码登录", kind: "oauth" },
	xai: { name: "xAI（SuperGrok）", description: "SuperGrok / X Premium 账号授权", kind: "oauth" },
	openrouter: { name: "OpenRouter", description: "OpenRouter 账号授权", kind: "oauth" },
	meta: { name: "Meta AI", description: "Meta 账号授权", kind: "oauth" },
	zai: { name: "Z.ai Coding Plan（国际）", description: "粘贴 Coding Plan API Key；支持套餐额度查询", kind: "api_key" },
	"zai-coding-cn": { name: "Z.ai Coding Plan（中国）", description: "粘贴 Coding Plan API Key；支持套餐额度查询", kind: "api_key" },
};

/** One catalog row for the settings UI. */
export interface AuthCatalogEntry {
	provider: AuthCatalogProviderId;
	name: string;
	description: string;
	kind: "oauth" | "api_key";
	/** Credential present in auth.json. */
	configured: boolean;
	/** Credential type when configured. */
	authType?: "api_key" | "oauth";
	/** Model ids offered by this provider (pi-ai registry), display order.
	 * Display-capped by the engine (AUTH_CATALOG_MODEL_CAP) — supplier creation
	 * must prefill from the UNTRUNCATED `modelsAll` instead (review L4). */
	models: { id: string; name: string }[];
	/** Untruncated model list (pi-ai registry, display order) — the prefill
	 * source for「添加为模型供应商」so the display cap never truncates what a
	 * created supplier actually carries (review L4). */
	modelsAll: { id: string; name: string }[];
}

export interface AuthCatalogResponse {
	providers: AuthCatalogEntry[];
	/** Where auth.json lives (for the UI hint). */
	authPath: string;
}

/** Login lifecycle surfaced to the UI. status: waiting → done | error | cancelled. */
export interface AuthLoginState {
	id: string;
	provider: AuthCatalogProviderId;
	status: "waiting" | "done" | "error" | "cancelled";
	message: string;
	/** OAuth: open this URL in the browser. */
	url?: string;
	/** Device flow: type this code at url. */
	deviceCode?: string;
	/** Provider asks a question (API key paste / select / manual code). */
	prompt?: AuthPromptView;
}

export interface AuthPromptOption {
	id: string;
	label: string;
	description?: string;
}

export interface AuthPromptView {
	id: string;
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: AuthPromptOption[];
}

export interface AuthQuotaEntry {
	label: string;
	remainingPercent: number;
	resetsAt?: number;
}

export interface AuthQuotaResponse {
	provider: AuthCatalogProviderId;
	limits: AuthQuotaEntry[];
	fetchedAt: number;
}

/** IPC channels (invoke → response; auth:login-event is main → renderer push). */
export const AUTH_IPC = {
	catalog: "settings:auth-catalog",
	login: "settings:auth-login",
	loginStatus: "settings:auth-login-status",
	loginAnswer: "settings:auth-login-answer",
	loginCancel: "settings:auth-login-cancel",
	logout: "settings:auth-logout",
	quota: "settings:auth-quota",
	/** Main → renderer push of AuthLoginState updates for the active login. */
	loginEvent: "settings:auth-login-event",
	/** Renderer asks main to open an https URL in the system browser (login
	 * dialog's「打开授权页面」). Main enforces https + main-window origin — no
	 * in-app child window, no other schemes (review H5). */
	openExternal: "shell:open-external",
} as const;
