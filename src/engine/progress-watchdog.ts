/**
 * Progress watchdog — the "alive but going nowhere" counterpart to the stall
 * watchdog (`src/im/watchdog.ts`).
 *
 * Field 2026-11-03: a buggy login script looped for hours — every iteration
 * fresh LLM response + fresh tool call, so `llmInFlight` kept the STALL
 * watchdog exempted and nothing else looked at WHAT the work was. The design
 * constraint from the user is explicit: NO hard step cap. 30 identical calls
 * can be a dead loop; 100 different calls can be a healthy task — so the unit
 * of judgement is PROGRESS, never COUNT.
 *
 * The judgement: a tool call is progress when its fingerprint (tool + shape-
 * normalized params + result digest) has not been seen recently in this turn.
 * A healthy task keeps producing new fingerprints (different files, different
 * pages, different records); a stuck loop repeats the same one. When the SAME
 * fingerprint is all a conversation has produced for `stallWindowMs`, the
 * state machine escalates:
 *
 *   L1 "nudge"     — first stalled window; the engine logs + telemetry sees it
 *   L2 "soft-stop" — a second consecutive stalled window; abort the turn via
 *                    the SAME abort path the stall watchdog uses, with an
 *                    honest abort reason
 *
 * Every escalation level resets to zero the moment a NEW fingerprint arrives
 * — a legal polling loop whose target state changes, or a task that was slow
 * and then started moving, is back to fully trusted instantly.
 *
 * Volatile parameters (timestamps, UUIDs, ISO dates) are normalized away so a
 * "same call, new timestamp" loop is still detected as repetition. They are
 * the most common reason naive repeat-detection misses real loops.
 */
import { createHash } from "node:crypto";

export interface ProgressWatchdogOptions {
	/** How long a conversation may produce ONLY seen-before fingerprints before escalating. */
	stallWindowMs: number;
	/** How many recent fingerprints count as "seen before" (sliding memory). */
	windowSize: number;
	/** Consecutive stalled windows before the soft stop. */
	softStopAfterWindows: number;
	/** How many times a soft-stop may be deferred while a background process is
	 * still running (field 2026-11-06: a healthy "wait for the login script"
	 * loop polls manage_process, gets the SAME "仍在运行" result every time, and
	 * the repeat fingerprint read as a dead loop -> soft-stop killed the turn).
	 * The cap keeps a zombie process from exempting a turn forever. */
	maxDeferrals: number;
	/** COUNT-based identical-call threshold (field 2026-11-06, ported from
	 * Hermes' tool_guardrails). Time windows are far too slow for tight loops:
	 * a `sleep 15 -> read same file` cycle produces ~20 identical rounds inside
	 * ONE 5-minute window, so the time-based escalation only fires after ten
	 * minutes of visible spinning. Counting identical fingerprints catches the
	 * same loop in ~45 seconds. A notice is returned at this many identical
	 * calls; `identicalHaltAfter` aborts. */
	identicalWarnAfter: number;
	/** Nth identical fingerprint in a row that aborts the turn outright. */
	identicalHaltAfter: number;
	/** Longest multi-call cycle period detected (A,B,A,B = 2). Consecutive
	 * streaks cannot see these: every alternation resets the counter. */
	maxCyclePeriod: number;
	/** Injectable clock for tests. */
	now?: () => number;
}

export const PROGRESS_WATCHDOG_DEFAULTS: ProgressWatchdogOptions = {
	stallWindowMs: 5 * 60_000,
	windowSize: 32,
	softStopAfterWindows: 2,
	maxDeferrals: 3,
	// Hermes defaults (tool_guardrails): notice at 3, halt at 5.
	identicalWarnAfter: 3,
	identicalHaltAfter: 5,
	maxCyclePeriod: 4,
};

export type ProgressTouch =
	| "progress"
	| "idle"
	| "nudge"
	| "soft-stop"
	| "deferred"
	/** COUNT-based: the same call repeated `identicalWarnAfter` times — treat as a
	 * loop NOW instead of waiting for the time window to expire. */
	| "identical-loop"
	/** COUNT-based: a repeating multi-call cycle (A,B,A,B) with identical args and
	 * results — the shape consecutive streaks cannot see. */
	| "cycle-loop";

interface ConversationProgressState {
	/** Recent fingerprints, oldest first, capped at windowSize. */
	fingerprints: string[];
	/** When the current window opened (last progress or last escalation). */
	windowStart: number;
	/** Consecutive stalled windows so far (0 = trusted). */
	level: 0 | 1 | 2;
	/** Soft-stops deferred so far because a background process was still running. */
	deferrals: number;
	/** The most recent fingerprint and how many times it repeated consecutively. */
	identicalSig: string | null;
	identicalCount: number;
	/** When this conversation last produced NEW work (any new fingerprint). */
	lastProgressAt: number;
	/** Recent (fingerprint) history for multi-call cycle detection, oldest first. */
	history: string[];
}

/**
 * Deterministic, order-insensitive stringify with volatile-value masking.
 *
 * Exported for tests: the masking rules are the difference between catching a
 * loop and watching it re-roll its timestamp forever.
 */
/** Every volatile token class, matched in a single pass (order-free masking). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOLATILE_PATTERN =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b\d{13}\b|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b[0-9a-f]{40}\b/gi;

export function normalizeForFingerprint(value: unknown): string {
	let s: string;
	try {
		s = typeof value === "string" ? value : stableStringify(value);
	} catch {
		s = String(value);
	}
	// ONE alternation pass, so replacement order cannot matter: two strings that
	// differ only in whether a uuid precedes a timestamp must normalize equal
	// (a sequential chain leaves "<uuid><ts>" vs "<ts><uuid>" and the loop
	// escapes detection by reordering its volatile tokens).
	return s.replace(VOLATILE_PATTERN, (match) => {
		if (/^\d{13}$/.test(match)) return "<ts>"; // epoch ms
		if (UUID_RE.test(match)) return "<uuid>";
		if (/^\d{4}-/.test(match)) return "<iso>"; // ISO date-time
		return "<sha>";
	});
}

/** Keys sorted at every depth, so param order never changes the fingerprint. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
	return `{${entries.join(",")}}`;
}

/**
 * The progress fingerprint of one tool call. Params AND result both matter:
 * a retry loop with identical params produces an identical result, while a
 * healthy re-read (same params, page content changed) produces a different
 * digest and counts as progress.
 */
export function computeToolFingerprint(name: string, params: unknown, result: unknown): string {
	let resultHead: string;
	try {
		resultHead = normalizeForFingerprint(result).slice(0, 400);
	} catch {
		resultHead = "<unserializable>";
	}
	return createHash("sha1")
		.update(name)
		.update("\u0000")
		.update(normalizeForFingerprint(params).slice(0, 2_000))
		.update("\u0000")
		.update(resultHead)
		.digest("hex")
		.slice(0, 16);
}

export class ProgressWatchdog {
	private readonly states = new Map<string, ConversationProgressState>();
	private options: ProgressWatchdogOptions;
	private readonly now: () => number;

	constructor(options: Partial<ProgressWatchdogOptions> = {}) {
		this.options = { ...PROGRESS_WATCHDOG_DEFAULTS, ...options };
		this.now = options.now ?? Date.now;
	}

	/**
	 * Record one tool call outcome. Returns what the engine should do about it.
	 * `idle` = a repeat, but the window has not run out yet — do nothing.
	 */
	touch(conversationId: string, fingerprint: string, opts?: { hasRunningBackground?: boolean }): ProgressTouch {
		const now = this.now();
		let state = this.states.get(conversationId);
		if (!state) {
			state = { fingerprints: [], windowStart: now, level: 0, deferrals: 0, identicalSig: null, identicalCount: 0, lastProgressAt: now, history: [] };
			this.states.set(conversationId, state);
		}

		// COUNT-based judgement FIRST (field 2026-11-06, ported from Hermes'
		// tool_guardrails): a tight loop repeats many times per time window, so
		// counting identical outcomes catches in seconds what the window-based
		// escalation only notices after ten minutes of spinning.
		if (state.identicalSig === fingerprint) state.identicalCount += 1;
		else {
			state.identicalSig = fingerprint;
			state.identicalCount = 1;
		}
		state.history.push(fingerprint);
		if (state.history.length > Math.max(64, this.options.maxCyclePeriod * 8)) state.history.shift();

		// A running background process makes an identical poll a LEGAL wait, not a
		// loop (see maxDeferrals): the count-based halts must respect that too, or
		// a healthy "wait for the script" poll aborts in 45 seconds.
		// The two dimensions answer DIFFERENT questions and must not shadow each
		// other: the time window judges "stalled forever" (a slow legal retry
		// still gets its window), the counter judges "spinning fast right now"
		// (many identical rounds inside a fraction of one window = a hot loop).
		const legalWait = opts?.hasRunningBackground === true;
		const fastLoop = now - state.lastProgressAt < this.options.stallWindowMs / 2;
		if (!legalWait && fastLoop) {
			// Consecutive identical: the trivial hot loop.
			if (state.identicalCount >= this.options.identicalWarnAfter) return "identical-loop";
			// Repeating multi-call cycle (A,B,A,B): each alternation resets the
			// streak above, so the history walk is the only thing that sees it.
			if (this.detectCycle(state.history)) return "cycle-loop";
		}
		// A multi-call cycle (A,B,A,B) defeats the consecutive streak: each
		// alternation resets identicalCount while the conversation makes no
		// forward progress. Walk trailing laps for the smallest period 2..max.
		if (!state.fingerprints.includes(fingerprint)) {
			// NEW work: full reset. A task that was nudged and then actually moved
			// is trusted again instantly — the escalation must never stick.
			state.fingerprints.push(fingerprint);
			if (state.fingerprints.length > this.options.windowSize) state.fingerprints.shift();
			state.windowStart = now;
			state.level = 0;
			state.deferrals = 0;
			state.lastProgressAt = now;
			return "progress";
		}
		if (now - state.windowStart < this.options.stallWindowMs) return "idle";
		// A stalled window closed with nothing new. Escalate one level; the level
		// caps at soft-stop so a loop the abort failed to reach keeps re-reporting
		// every window instead of disappearing.
		state.level = Math.min(state.level + 1, this.options.softStopAfterWindows) as 0 | 1 | 2;
		state.windowStart = now;
		if (state.level >= this.options.softStopAfterWindows
			&& opts?.hasRunningBackground === true
			&& state.deferrals < this.options.maxDeferrals) {
			// A running background process makes a repeated poll a LEGAL wait, not
			// a dead loop: defer the soft-stop by one window instead of aborting
			// the turn. Level stays capped, so the next stalled window re-judges.
			state.deferrals += 1;
			return "deferred";
		}
		return state.level >= this.options.softStopAfterWindows ? "soft-stop" : "nudge";
	}

	/** Trailing identical laps detection: returns the period when the last
	 * `identicalWarnAfter` laps are identical (args AND results per position). */
	private detectCycle(history: string[]): number | null {
		const minLaps = this.options.identicalWarnAfter;
		for (let period = 2; period <= this.options.maxCyclePeriod; period++) {
			if (history.length < period * minLaps) continue;
			let laps = 1;
			for (;;) {
				const base = history.length - period * (laps + 1);
				if (base < 0) break;
				let equal = true;
				for (let i = 0; i < period; i++) {
					if (history[base + i] !== history[history.length - period + i]) { equal = false; break; }
				}
				if (!equal) break;
				laps += 1;
			}
			if (laps >= minLaps) return period;
		}
		return null;
	}

	/** A new user message starts a fresh judgement window for the conversation. */
	beginTurn(conversationId: string): void {
		this.states.delete(conversationId);
	}

	/** Apply settings read after construction (config loads later than the
	 * engine). Undefined fields keep the current value. */
	configure(options: Partial<ProgressWatchdogOptions>): void {
		const next: ProgressWatchdogOptions = { ...this.options };
		if (options.stallWindowMs !== undefined) next.stallWindowMs = options.stallWindowMs;
		if (options.windowSize !== undefined) next.windowSize = options.windowSize;
		if (options.softStopAfterWindows !== undefined) next.softStopAfterWindows = options.softStopAfterWindows;
		if (options.maxDeferrals !== undefined) next.maxDeferrals = options.maxDeferrals;
		if (options.identicalWarnAfter !== undefined) next.identicalWarnAfter = options.identicalWarnAfter;
		if (options.identicalHaltAfter !== undefined) next.identicalHaltAfter = options.identicalHaltAfter;
		if (options.maxCyclePeriod !== undefined) next.maxCyclePeriod = options.maxCyclePeriod;
		this.options = next;
	}

	/** Drop all state for one conversation: called when its turn actually
	 * finishes, so an idle process never accumulates per-conversation churn and
	 * a later turn cannot inherit a stale window. */
	endTurn(conversationId: string): void {
		this.states.delete(conversationId);
	}

	/** Current escalation level (0 trusted … softStopAfterWindows). */
	level(conversationId: string): number {
		return this.states.get(conversationId)?.level ?? 0;
	}
}
