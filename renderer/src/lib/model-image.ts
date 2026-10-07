/**
 * Per-model image-input override semantics (Supplier.modelImage).
 * Three states per model: undefined = inherit the registry base capability,
 * true/false = explicit override. Pure helpers shared by the settings UI and
 * pinned by scripts/test-model-image.mjs.
 */

/** Checkbox state: explicit override wins, else the registry-derived effective value. */
export function resolveImageChecked(explicit: boolean | undefined, effective: boolean): boolean {
	return explicit ?? effective;
}

/**
 * Apply one toggle to the override map. "inherit" removes the key (back to
 * registry default); an emptied map collapses to undefined.
 */
export function nextModelImage(
	map: Record<string, boolean> | undefined,
	modelId: string,
	value: boolean | "inherit",
): Record<string, boolean> | undefined {
	const next = { ...(map ?? {}) };
	if (value === "inherit") delete next[modelId];
	else next[modelId] = value;
	return Object.keys(next).length ? next : undefined;
}
