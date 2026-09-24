/**
 * Remote model-info lookup: ask the supplier's gateway what a model can REALLY
 * do, instead of trusting a registry value that describes some upstream model
 * the gateway may not be fronting (field 2026-09-23: the registry said
 * maxTokens=131072; the litellm-fronted qwen's real output cap is 32K — and an
 * oversized output reservation alone blew the context window).
 *
 * Target API: LiteLLM-style `GET {baseUrl}/model/info` (also tried at
 * `/v1/model/info`). Only `max_output_tokens` is treated as an output cap —
 * `max_tokens`/`context_length` describe the CONTEXT ceiling and land in
 * `contextLength`. Any failure (no gateway, wrong shape, auth required,
 * timeout) degrades to null and the engine falls back to its static default —
 * this lookup is an enhancement, never a hard dependency.
 */
export interface RemoteModelInfo {
	/** Single-reply output cap in tokens. */
	maxOutputTokens?: number;
	/** Input-only cap, if the gateway distinguishes it. */
	maxInputTokens?: number;
	/** Total window (input+output), when reported. */
	contextLength?: number;
}

interface LiteLLMEntry {
	model_name?: string;
	model_id?: string;
	model_info?: {
		max_tokens?: number;
		max_output_tokens?: number;
		max_input_tokens?: number;
		context_length?: number;
	};
	max_tokens?: number;
	max_output_tokens?: number;
	max_input_tokens?: number;
	context_length?: number;
}

/**
 * Parse a `/model/info` response for one model. Returns null when the shape is
 * unrecognized or the model isn't listed — callers must treat null as "no
 * information", never as a zero cap.
 */
export function parseModelInfoResponse(json: unknown, modelId: string): RemoteModelInfo | null {
	const data = (json as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return null;
	const entry = (data as LiteLLMEntry[]).find(
		(e) => e && typeof e === "object" && (e.model_name === modelId || e.model_id === modelId),
	);
	if (!entry) return null;
	// Fields may sit at the top level (older litellm) or nested in model_info.
	const info = { ...(entry as Record<string, unknown>), ...(entry.model_info ?? {}) } as LiteLLMEntry;
	const num = (v: unknown): number | undefined => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined);
	// ONLY max_output_tokens is an output cap. In litellm's model_info,
	// `max_tokens` is the model's CONTEXT ceiling (their own docs list
	// gpt-3.5-turbo as max_tokens: 4097 — that was its window). Field
	// 2026-09-23: a custom qwen entry reported max_tokens: 131072 (context)
	// with no max_output_tokens; reading that as the output cap re-created
	// the fictional 131072 reservation (0.2.93) — usable budget collapsed to
	// ~57K and every long task died with "compaction couldn't free enough
	// space" while the gateway happily served 150K-token requests.
	const maxOutputTokens = num(info.max_output_tokens);
	const contextLength = num(info.context_length) ?? num(info.max_tokens);
	const result: RemoteModelInfo = {
		maxOutputTokens,
		maxInputTokens: num(info.max_input_tokens),
		contextLength,
	};
	return result.maxOutputTokens || result.maxInputTokens || result.contextLength ? result : null;
}

/** GET the gateway's model-info endpoint. Returns null on ANY failure. */
export async function fetchModelInfo(
	baseUrl: string,
	modelId: string,
	apiKey: string | undefined,
	timeoutMs = 5_000,
): Promise<RemoteModelInfo | null> {
	const base = baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	for (const url of [`${base}/model/info`, `${base}/v1/model/info`]) {
		try {
			const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
			if (!r.ok) continue;
			const parsed = parseModelInfoResponse(await r.json(), modelId);
			if (parsed) return parsed;
		} catch {
			// timeout / DNS / auth / shape — try the next variant, then give up
		}
	}
	return null;
}
