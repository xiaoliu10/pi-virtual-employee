/** Largest whole-second duration that fits Node's signed 32-bit millisecond timer. */
export const MAX_TIMEOUT_SEC = 2_147_483;

/** Only an explicit zero disables a timer; malformed values keep the supplied default. */
export function normalizeTimeoutSec(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return value === 0 ? 0 : Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.floor(value)));
}
