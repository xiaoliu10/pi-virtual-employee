/**
 * Long-task progress broadcaster for scheduled tasks.
 *
 * A scheduled-task run can legitimately stream for an hour (single-shot hard
 * timeout 60min, autonomous window up to maxMinutes). During that time the
 * user sees nothing — the final report only lands when the run settles. The
 * autonomous chain already had an in-turn heartbeat, but the far more common
 * single-shot runner had none; this module extracts that heartbeat into one
 * dependency-injected broadcaster shared by the single-shot runner, the
 * autonomous chain, and work windows.
 *
 * The summary itself comes from engine.progressBrief (side LLM pass over the
 * transcript tail — never touches agent state) with a deterministic four-field
 * fallback. Degraded (fallback) pushes are counted: a dead relay must produce
 * at most two generic lines, not one every interval (v0.2.145 field lesson).
 */

/** Behavior knobs collected from the caller's context; re-read live each tick. */
export interface ProgressNotifierOptions {
	/** Task title, used in the `⏳ **title**` prefix. */
	title: string;
	/** Push target (`task.conversation_id`). null → the notifier is a no-op. */
	target: string | null | undefined;
	/** Interval in minutes; ≤0 → disabled. Values 1..4 are clamped up to 5. */
	intervalMin: number;
	/** Side-pass summary. Resolves with the note text and whether it came from
	 *  the deterministic fallback (degraded) rather than the LLM. */
	summarize: () => Promise<{ text: string; degraded: boolean }>;
	/** Push to the target conversation (already routed by the IM manager). */
	push: (conversationId: string, text: string) => Promise<unknown>;
	/** Live gate: false while the run is settling/settled — a stale snapshot
	 *  must never be pushed after completion (main.ts heartbeat semantics). */
	isRunning: () => boolean;
	/** Live suppression: timed-out losing runs and turn-boundary windows. */
	suppress?: () => boolean;
	/** Final-say gate for whether this note may be pushed at all
	 *  (silent tasks stay silent; reuse shouldPushScheduledResult). */
	mayPush?: (note: string) => boolean;
	/** Hard ceiling on pushes per run — a runaway interval must not spam. */
	maxPushes?: number;
	log?: (level: "WARN" | "ERROR", msg: string) => void;
}

const MIN_INTERVAL_MIN = 5;
const DEFAULT_MAX_PUSHES = 20;
/** Backoff caps at an hour: long enough to outlive a relay outage, short
 *  enough that a recovered relay is picked up without human action. */
const BACKOFF_CAP_MS = 60 * 60_000;

export interface ProgressNotifier {
	start: () => void;
	stop: () => void;
	/** Test/observability hook: pushes actually performed. */
	pushedCount: () => number;
}

/** Clamp the configured interval: ≤0 disables, 1..4 is noise (LLM round-trip
 *  alone can take minutes) so it is lifted to the 5-minute floor. */
export function normalizeProgressIntervalMin(raw: number | undefined | null): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.max(MIN_INTERVAL_MIN, Math.floor(n));
}

export function createProgressNotifier(opts: ProgressNotifierOptions): ProgressNotifier {
	const log = opts.log ?? (() => {});
	const maxPushes = opts.maxPushes ?? DEFAULT_MAX_PUSHES;
	const intervalMs = normalizeProgressIntervalMin(opts.intervalMin) * 60_000;

	let timer: NodeJS.Timeout | undefined;
	let inFlight = false;
	let stopped = false;
	let pushes = 0;
	let degradedStreak = 0;
	let backoffUntil = 0;

	const stop = () => {
		stopped = true;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	const start = () => {
		// No target (console-created task) or disabled: stay a no-op — never burn
		// side LLM calls for a push that cannot happen.
		if (stopped || !opts.target || intervalMs <= 0) return;
		timer = setInterval(() => {
			void tick();
		}, intervalMs);
		// Never hold the process open for a progress push (all VE timers unref).
		timer.unref?.();
	};

	const tick = async (): Promise<void> => {
		if (stopped || inFlight) return;
		// Settled or suppressed (timed-out losing run / turn-boundary window):
		// a "still working" note would contradict the scheduler's own record.
		if (!opts.isRunning() || opts.suppress?.()) return;
		const target = opts.target;
		if (!target) return;
		if (Date.now() < backoffUntil) return;

		inFlight = true;
		try {
			const { text, degraded } = await opts.summarize();
			// The run may have settled while the side pass was in flight — the
			// note is now a stale snapshot, and the final report is about to land
			// anyway. Drop it instead of racing the completion push.
			if (stopped || !opts.isRunning()) return;
			// Exponential backoff while the side pass keeps degrading: 2 generic
			// lines are informative ("still alive"), 12 are spam. Any healthy
			// (LLM-backed) note resets the streak.
			if (degraded) {
				degradedStreak += 1;
				if (degradedStreak >= 2) {
					const delay = Math.min(BACKOFF_CAP_MS, intervalMs * 2 ** (degradedStreak - 1));
					backoffUntil = Date.now() + delay;
					log("WARN", `progress brief degraded ${degradedStreak}x — backing off ${Math.round(delay / 60_000)}min`);
				}
			} else {
				degradedStreak = 0;
				backoffUntil = 0;
			}
			// The engine prefixes ⏳ itself; the autonomous-chain heartbeat used
			// to double it (v0.2.109). Normalize once, here, for every caller.
			const note = text.startsWith("⏳") ? text : `⏳ ${text}`;
			if (opts.mayPush && !opts.mayPush(note)) return;
			if (pushes >= maxPushes) {
				log("WARN", `progress push cap (${maxPushes}) reached — further notes suppressed until the run settles`);
				return;
			}
			pushes += 1;
			try {
				await opts.push(target, note);
			} catch (err) {
				// A failed push must never kill the timer or the run.
				log("WARN", `progress push failed: ${err instanceof Error ? err.message : err}`);
			}
		} catch (err) {
			// summarize() itself should already fall back internally; this is the
			// last-resort guard against an unhandled rejection in the timer.
			log("WARN", `progress tick failed: ${err instanceof Error ? err.message : err}`);
		} finally {
			inFlight = false;
		}
	};

	return { start, stop, pushedCount: () => pushes };
}
