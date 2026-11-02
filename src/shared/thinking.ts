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

/** Minimal model-capability shape the declaration may adjust. */
export interface ThinkingCapabilityBase {
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null> | undefined;
}

/**
 * Apply a per-model thinking declaration to a model's capability.
 *
 * Semantics differ by supplier kind (review rounds 2+3, resolved):
 * - **Relay/alias suppliers** (hand-entered baseUrl, no authProvider): the
 *   borrowed base model's capability describes a DIFFERENT upstream, so the
 *   declaration is the only truthful source — it supplies the capability
 *   (`reasoning: true` even for "off", so the provider's disable param can be
 *   emitted) plus a guarded map entry that never overwrites an existing
 *   marker, in particular `null` = unsupported.
 * - **Account-login suppliers** (pi-ai registry): the registry model IS the
 *   real model, its capability is authoritative — the declaration only sets
 *   the requested level and must not rewrite capability.
 *
 * Returns the fields to merge onto the model (undefined map = keep base's).
 */
export function applyThinkingDeclaration(
	base: ThinkingCapabilityBase,
	declared: string | undefined,
	isRelay: boolean,
): { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> } {
	if (!isRelay || declared === undefined) {
		return { reasoning: base.reasoning, thinkingLevelMap: base.thinkingLevelMap ?? undefined };
	}
	// The declaration engages thinking management: capability stays ON even for
	// "off", because off is expressed BY the request (enable_thinking:false /
	// no effort), not by pretending the model cannot think.
	const baseMap = base.thinkingLevelMap ?? {};
	const thinkingLevelMap =
		declared !== "off" && !(declared in baseMap)
			? { ...baseMap, [declared]: declared }
			: base.thinkingLevelMap ?? undefined;
	return { reasoning: true, thinkingLevelMap };
}
