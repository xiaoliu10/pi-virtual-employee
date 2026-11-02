/**
 * Per-model thinking/reasoning level declaration (shared by main process and
 * renderer via the config contract).
 *
 * Values are pi-ai `ModelThinkingLevel` strings. The declaration is the SINGLE
 * source for both the main turn (`agent.state.thinkingLevel`) and the progress
 * side pass: pi-ai's `clampThinkingLevel` makes any request compatible with the
 * model's real capability — a non-reasoning model never gets thinking params,
 * a model without a declared xhigh/max support falls back to its nearest
 * supported level — so an unsupported choice degrades instead of erroring.
 */
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelThinkingLevelConfig = (typeof MODEL_THINKING_LEVELS)[number];

/** Default for the progress side pass when a model is declared reasoning but no level is chosen. */
export const SIDE_PASS_DEFAULT_LEVEL = "xhigh";

export function normalizeModelThinkingLevel(value: unknown): string | undefined {
	return typeof value === "string" && (MODEL_THINKING_LEVELS as readonly string[]).includes(value) ? value : undefined;
}
