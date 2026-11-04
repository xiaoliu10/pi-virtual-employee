/**
 * Global progress pump — heartbeat that SURVIVES a restart.
 *
 * FIELD 2026-11-04: a chat task ran for over an hour and produced exactly ONE
 * progress note. The task itself was fine — durable resumed it across an app
 * restart and it finished normally — but the heartbeat was a `setInterval`
 * created inside the inbound-message handler:
 *
 *     const heartbeat = progressMin > 0 && onProgress ? setInterval(…) : undefined;
 *
 * That timer dies with the process, and after a restart the handler never runs
 * again for that message (it was consumed long ago), so the timer is never
 * recreated. From the user's side: "每小时汇报一次" became "汇报一次就停了".
 *
 * The fix is to drive heartbeats from the runtime's LIVE state instead of from
 * the request that started the work. This module holds the pure decision logic
 * (cadence, dedupe, per-conversation bookkeeping) so it can be tested without a
 * clock or a model.
 */

/** Per-conversation pump state. */
export interface PumpState {
	/** When the last note was SENT (epoch ms). */
	lastSentAt: number;
	/** A brief is currently being generated (never overlap two). */
	inFlight: boolean;
}

export type PumpAction =
	/** Generate and push a progress note for this conversation. */
	| { kind: "fire"; conversationId: string }
	/** Skip this conversation this tick. */
	| { kind: "skip"; conversationId: string; reason: "in-flight" | "not-due" };

/**
 * Decide which busy conversations are due for a note.
 *
 * `busy` is re-derived from live state on every tick, so a conversation that
 * finished or was never started simply stops being pumped — no cleanup needed.
 * A conversation seen for the first time gets a full interval of grace: the
 * pump must not fire immediately on startup (a restart would otherwise spam one
 * note per live conversation).
 */
export function decidePump(input: {
	busy: { conversationId: string }[];
	state: Map<string, PumpState>;
	now: number;
	intervalMs: number;
}): PumpAction[] {
	const actions: PumpAction[] = [];
	if (input.intervalMs <= 0) return actions;
	for (const { conversationId } of input.busy) {
		const st = input.state.get(conversationId);
		if (!st) {
			// First sighting: start the clock, do not fire. Self-healing — the
			// caller stores it with the CURRENT time.
			actions.push({ kind: "skip", conversationId, reason: "not-due" });
			continue;
		}
		if (st.inFlight) {
			actions.push({ kind: "skip", conversationId, reason: "in-flight" });
			continue;
		}
		if (input.now - st.lastSentAt < input.intervalMs) {
			actions.push({ kind: "skip", conversationId, reason: "not-due" });
			continue;
		}
		actions.push({ kind: "fire", conversationId });
	}
	return actions;
}

/**
 * Drop bookkeeping for conversations that are no longer busy.
 *
 * Without this the map grows for the life of the process and a conversation that
 * goes busy again much later would be judged against a stale timestamp (either
 * firing instantly or staying silent far too long).
 */
export function prunePumpState(state: Map<string, PumpState>, busy: { conversationId: string }[]): void {
	const live = new Set(busy.map((b) => b.conversationId));
	for (const id of [...state.keys()]) {
		if (!live.has(id)) state.delete(id);
	}
}

/**
 * True when a note is worth sending: the brief must carry real information, not
 * an empty shell. The degraded fallback is still delivered (silence is worse),
 * so this only rejects genuinely blank text.
 */
export function isUsableBrief(text: string | undefined | null): boolean {
	return typeof text === "string" && text.trim().length > 0;
}
