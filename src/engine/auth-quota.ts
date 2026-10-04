/**
 * Z.ai Coding Plan quota helpers (desktop-parity, see pi-desktop
 * src/main/pi/account-worker.ts `operation==='quota'`).
 *
 * Endpoint: GET {origin-of-provider-base}/api/coding/pays/subscription/query_user_codization_resource?enable_delay=false
 * with `Authorization: Bearer <apiKey>` (or the auth-resolved headers).
 *
 * Base derivation differs from desktop on purpose: desktop checks
 * `auth.baseUrl.startsWith("https://api.z.ai")` because its runtime composes
 * providers whose auth resolution carries a bare `https://api.z.ai` base. Here
 * pi-ai's registry providers carry the FULL API base as their baseUrl
 * (`zai` → https://api.z.ai/api/coding/paas/v4, `zai-coding-cn` →
 * https://open.bigmodel.cn/api/coding/paas/v4) and api-key auth resolution
 * never sets a per-request baseUrl. So we take auth.baseUrl when present,
 * fall back to the provider's registered baseUrl, and pin the quota call to
 * the ORIGIN of that base. The hostname allowlist below is the security
 * boundary: only the official Z.ai / BigModel hosts ever receive the
 * credential, and https is mandatory.
 */

const ZAI_QUOTA_PATH = "/api/coding/pays/subscription/query_user_codization_resource";
const ZAI_QUOTA_HOSTS = new Set(["api.z.ai", "open.bigmodel.cn"]);

export const ZAI_QUOTA_ERROR = "仅支持智谱 / Z.ai 官方套餐查询";

/** Build the quota endpoint from the effective provider base. Throws when the
 * base is not an official Z.ai/BigModel https origin (never follow arbitrary
 * hosts with a bearer credential). */
export function zaiQuotaUrl(base: string | undefined): URL {
	if (typeof base !== "string" || !base.startsWith("https://")) throw new Error(ZAI_QUOTA_ERROR);
	let parsed: URL;
	try {
		parsed = new URL(base);
	} catch {
		throw new Error(ZAI_QUOTA_ERROR);
	}
	if (!ZAI_QUOTA_HOSTS.has(parsed.hostname)) throw new Error(ZAI_QUOTA_ERROR);
	const url = new URL(ZAI_QUOTA_PATH, parsed.origin);
	url.searchParams.set("enable_delay", "false");
	return url;
}

/** Parse the subscription payload into display entries. Accepts both response
 * shapes seen in the wild: `{ data: { usage_quota_limits: [...] } }` and
 * `{ data: { usage_quota: { limits: [...] } } }`. `percentage` is USED quota —
 * reported to the UI as REMAINING percent, clamped to 0–100; `reset_time` is
 * unix seconds → ms. */
export function parseZaiQuota(payload: unknown): { label: string; remainingPercent: number; resetsAt?: number }[] {
	const raw = (payload as { data?: unknown } | null | undefined)?.data ?? payload;
	const holder = (raw ?? {}) as {
		usage_quota_limits?: unknown;
		usage_quota?: { limits?: unknown };
	};
	const limits = holder.usage_quota_limits ?? holder.usage_quota?.limits;
	if (!Array.isArray(limits)) return [];
	const out: { label: string; remainingPercent: number; resetsAt?: number }[] = [];
	for (const entry of limits) {
		const percentage = (entry as { percentage?: unknown } | null)?.percentage;
		if (typeof percentage !== "number" || !Number.isFinite(percentage)) continue;
		const name = (entry as { name?: unknown }).name;
		const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : "套餐";
		const remainingPercent = Math.max(0, Math.min(100, 100 - percentage));
		const resetTime = (entry as { reset_time?: unknown }).reset_time;
		const resetsAt = typeof resetTime === "number" && Number.isFinite(resetTime) && resetTime > 0 ? resetTime * 1000 : undefined;
		out.push({ label, remainingPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) });
	}
	return out;
}
