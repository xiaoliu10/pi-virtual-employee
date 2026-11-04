/**
 * Output-token budget for side-channel LLM passes (progress briefs, task plans).
 * Field incident 2026-11-02: qwen's default-thinking consumed the old
 * hard-coded 0.8×512=409 cap and every side pass died with "hit the token cap".
 * User ruling 2026-11-02: DON'T self-limit — follow the model's own max-output
 * resolution (per-model override → gateway model-info → 32k relay default).
 * pi-ai computes maxTokens = 0.8×reserve clamped to model.maxTokens, so
 * reserving ceil(maxOut/0.8) lands exactly on maxOut; a ceiling only caps
 * runaway generation, it must not silently shrink what the model may produce.
 * Exported for tests: every side pass MUST call this — a hard-coded number here
 * regresses to the incident (planTaskBrief did exactly that on 2026-11-04).
 */
export function sidePassMaxTokens(model: { maxTokens?: number | null } | undefined): number {
	const maxOut = model?.maxTokens !== undefined && model.maxTokens !== null && model.maxTokens > 0 ? model.maxTokens : 32_768;
	return Math.ceil(maxOut / 0.8);
}
