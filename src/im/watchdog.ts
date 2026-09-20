/**
 * Stall watchdog for IM turns (0.2.73 rework of the 0.2.6x fixed-timer
 * watchdog, field feedback 2026-09-17: a healthy reconciliation task that ran
 * 20+ minutes was killed although the heartbeat was literally reporting
 * progress — the old watchdog measured TOTAL turn time, so it could not tell
 * "wedged" from "working long").
 *
 * New semantics: the threshold measures time since the last sign of life
 * (LLM stream events, tool-call start/end). A live task never trips it no
 * matter how long it runs; a genuinely wedged turn (hung socket, hung remote
 * session — the kind no in-process recovery can unstick) still gets aborted
 * after the configured silence, so the strict per-conversation queue drains
 * instead of blocking that chat forever.
 */
export interface StallWatchdogOptions {
	/** Abort when the turn has been silent this long. */
	thresholdMs: number;
	/** How often to check (default 30s; the timer only ever fires while silent). */
	pollMs?: number;
	/** Ms since the turn's last observed activity (large value = no signal). */
	activityAgeMs: () => number;
	/** Called once, when the silence threshold is crossed. */
	onStall: () => void;
}

export interface StallWatchdog {
	stop(): void;
	fired(): boolean;
}

/** Inputs to the stall verdict, from the engine's per-conversation maps. */
export interface StallSignals {
	/** Timestamp of the last observed activity; undefined = never any. */
	lastActivityAt?: number;
	/** Number of LLM requests currently in flight for the turn. */
	llmInFlight: number;
}

/**
 * Ms since the turn last showed life — the single definition of "silent" for
 * the watchdog. An in-flight LLM request counts as life UNCONDITIONALLY (v3,
 * field 2026-09-18: a box that raised requestTimeoutMin above the watchdog
 * threshold got healthy-but-silent long requests killed at 20min, because the
 * old credit expired once the request's own age crossed the threshold). A
 * truly dead request is bounded by its per-request timeout (client default
 * ≈10min, or general.requestTimeoutMin): when it errors, in-flight drops and
 * the silence clock resumes from real activity.
 */
export function computeStallIdleMs(signals: StallSignals, now: number): number {
	if (signals.llmInFlight > 0) return 0;
	if (signals.lastActivityAt === undefined) return Number.MAX_SAFE_INTEGER;
	return now - signals.lastActivityAt;
}

export function startStallWatchdog(opts: StallWatchdogOptions): StallWatchdog {
	const pollMs = opts.pollMs ?? 30_000;
	let fired = false;
	const timer = setInterval(() => {
		if (fired) return;
		if (opts.activityAgeMs() < opts.thresholdMs) return;
		fired = true;
		clearInterval(timer);
		try {
			opts.onStall();
		} catch (err) {
			console.warn("[watchdog] onStall failed:", err instanceof Error ? err.message : err);
		}
	}, pollMs);
	// Don't hold the process open for a watchdog whose turn is ending anyway.
	timer.unref?.();
	return {
		stop: () => clearInterval(timer),
		fired: () => fired,
	};
}
