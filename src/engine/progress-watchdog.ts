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
	/** Injectable clock for tests. */
	now?: () => number;
}

export const PROGRESS_WATCHDOG_DEFAULTS: ProgressWatchdogOptions = {
	stallWindowMs: 5 * 60_000,
	windowSize: 32,
	softStopAfterWindows: 2,
};

export type ProgressTouch = "progress" | "idle" | "nudge" | "soft-stop";

interface ConversationProgressState {
	/** Recent fingerprints, oldest first, capped at windowSize. */
	fingerprints: string[];
	/** When the current window opened (last progress or last escalation). */
	windowStart: number;
	/** Consecutive stalled windows so far (0 = trusted). */
	level: 0 | 1 | 2;
}

/**
 * Deterministic, order-insensitive stringify with volatile-value masking.
 *
 * Exported for tests: the masking rules are the difference between catching a
 * loop and watching it re-roll its timestamp forever.
 */
export function normalizeForFingerprint(value: unknown): string {
	let s: string;
	try {
		s = typeof value === "string" ? value : stableStringify(value);
	} catch {
		s = String(value);
	}
	return s
		.replace(/\b\d{13}\b/g, "<ts>") // epoch ms
		.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<iso>")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
		.replace(/\b[0-9a-f]{40}\b/gi, "<sha>");
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
	private readonly options: ProgressWatchdogOptions;
	private readonly now: () => number;

	constructor(options: Partial<ProgressWatchdogOptions> = {}) {
		this.options = { ...PROGRESS_WATCHDOG_DEFAULTS, ...options };
		this.now = options.now ?? Date.now;
	}

	/**
	 * Record one tool call outcome. Returns what the engine should do about it.
	 * `idle` = a repeat, but the window has not run out yet — do nothing.
	 */
	touch(conversationId: string, fingerprint: string): ProgressTouch {
		const now = this.now();
		let state = this.states.get(conversationId);
		if (!state) {
			state = { fingerprints: [], windowStart: now, level: 0 };
			this.states.set(conversationId, state);
		}
		if (!state.fingerprints.includes(fingerprint)) {
			// NEW work: full reset. A task that was nudged and then actually moved
			// is trusted again instantly — the escalation must never stick.
			state.fingerprints.push(fingerprint);
			if (state.fingerprints.length > this.options.windowSize) state.fingerprints.shift();
			state.windowStart = now;
			state.level = 0;
			return "progress";
		}
		if (now - state.windowStart < this.options.stallWindowMs) return "idle";
		// A stalled window closed with nothing new. Escalate one level; the level
		// caps at soft-stop so a loop the abort failed to reach keeps re-reporting
		// every window instead of disappearing.
		state.level = Math.min(state.level + 1, this.options.softStopAfterWindows) as 0 | 1 | 2;
		state.windowStart = now;
		return state.level >= this.options.softStopAfterWindows ? "soft-stop" : "nudge";
	}

	/** A new user message starts a fresh judgement window for the conversation. */
	beginTurn(conversationId: string): void {
		this.states.delete(conversationId);
	}

	/** Current escalation level (0 trusted … softStopAfterWindows). */
	level(conversationId: string): number {
		return this.states.get(conversationId)?.level ?? 0;
	}
}
