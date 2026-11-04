/**
 * Sidebar width: drag-to-resize with a remembered width.
 *
 * Kept as PURE functions so the clamping and persistence rules are testable
 * without a DOM (the renderer has no jsdom/vitest setup — same reason
 * ThinkingBox's state machine is extracted).
 */

/** Must match the CSS default in Sidebar (w-[366px]). */
export const SIDEBAR_DEFAULT_WIDTH = 366;
/** Below this the session rows stop being readable; above it the chat column
 *  starves on a laptop screen. */
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 720;
/** Where the stored value lives. Namespaced so it cannot collide with future
 *  app-level keys. */
export const SIDEBAR_WIDTH_KEY = "ve.ui.sidebarWidth";

/**
 * Clamp a requested width. A non-finite or missing value falls back to the
 * default rather than throwing — a corrupted localStorage entry must never
 * wedge the layout at 0px.
 */
export function clampSidebarWidth(width: unknown): number {
	// null/""/whitespace must fall back to the DEFAULT, not to 0: Number(null) and
	// Number("") are both 0, which would silently clamp to the MINIMUM instead of
	// restoring the expected width (found by this module's own test).
	if (width === null || width === undefined) return SIDEBAR_DEFAULT_WIDTH;
	if (typeof width === "string" && width.trim() === "") return SIDEBAR_DEFAULT_WIDTH;
	const n = typeof width === "number" ? width : Number(width);
	if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH;
	return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(n)));
}

/**
 * The width after dragging the divider by `deltaX` from `startWidth`.
 *
 * Dragging LEFT makes the sidebar wider, so callers pass a negative delta when
 * the pointer moves left — that direction decision lives in the component; this
 * function only clamps.
 */
export function widthFromDrag(startWidth: number, deltaX: number): number {
	return clampSidebarWidth(startWidth + deltaX);
}

/** Whether a pointer position counts as "on" the divider (grab zone). */
export function isOnDivider(x: number, dividerLeft: number, slop = 3): boolean {
	return Math.abs(x - dividerLeft) <= slop;
}
