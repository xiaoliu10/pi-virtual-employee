/**
 * Composer height: drag-to-resize with a remembered height.
 *
 * Field 2026-11-05 (user): "ve 升级到 193 版本了 怎么还不支持拖动对话框大小".
 * The 0.2.193 resize shipped on the EMBEDDED WIDGET only — the desktop chat
 * composer was `resize-none` with a fixed 76px floor, so there was nothing to
 * drag in the app the user actually uses.
 *
 * Kept as PURE functions (same reason as sidebar-width.ts): the renderer has no
 * jsdom/vitest setup, so the clamping and persistence rules must be testable
 * without a DOM.
 */

/** Must match the CSS default in Composer (min-h-[76px]). */
export const COMPOSER_DEFAULT_HEIGHT = 76;
/** Below this the placeholder stops being readable and the toolbar crowds in. */
export const COMPOSER_MIN_HEIGHT = 56;
/** Above this the transcript starves — the composer must never eat the chat. */
export const COMPOSER_MAX_HEIGHT = 420;
/** Where the stored value lives (namespaced like the sidebar key). */
export const COMPOSER_HEIGHT_KEY = "ve.ui.composerHeight";

/**
 * Clamp a requested height. Non-finite / missing values fall back to the
 * default rather than throwing or collapsing to 0 — a corrupted localStorage
 * entry must never wedge the composer at an unusable size.
 */
export function clampComposerHeight(height: unknown): number {
	if (height === null || height === undefined) return COMPOSER_DEFAULT_HEIGHT;
	if (typeof height === "string" && height.trim() === "") return COMPOSER_DEFAULT_HEIGHT;
	const n = typeof height === "number" ? height : Number(height);
	if (!Number.isFinite(n)) return COMPOSER_DEFAULT_HEIGHT;
	return Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, Math.round(n)));
}

/**
 * Height after dragging the grip by `deltaY`.
 *
 * Dragging UP makes the composer taller, so callers pass a negative delta
 * (pointer moved up) — direction lives in the component, this only clamps.
 */
export function heightFromDrag(startHeight: number, deltaY: number): number {
	return clampComposerHeight(startHeight + deltaY);
}

/**
 * Hard cap by viewport: on a short window the absolute max would leave no room
 * for the transcript, so the effective ceiling is the smaller of the two.
 * Always leaves at least `reserve` px for the message list.
 */
export function heightCeilingForViewport(viewportHeight: number, reserve = 240): number {
	if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return COMPOSER_MAX_HEIGHT;
	const room = Math.round(viewportHeight - reserve);
	// Never let the viewport ceiling sink below the minimum — a tiny window must
	// still render a usable composer.
	return Math.max(COMPOSER_MIN_HEIGHT, Math.min(COMPOSER_MAX_HEIGHT, room));
}
