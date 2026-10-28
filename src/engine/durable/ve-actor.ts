/**
 * Per-conversation actor identity, persisted as a durable document.
 *
 * WHY THIS EXISTS (security): VE's legacy kernel keeps the current sender in an
 * in-memory `turnActor` map (`engine.ts`, set at the start of every turn,
 * cleared in `finally`). That is fine while the process lives, but a recovered
 * turn runs in a NEW process — an in-memory map would be empty, and every RBAC
 * check would either fail closed (task stuck) or, worse, silently fall back to
 * a default role.
 *
 * Storing the actor in a durable document means the recovered turn re-derives
 * the SAME identity from storage and re-runs the ordinary permission checks.
 * Verified in the probe (`perm3.mjs`): two conversations with different roles
 * read back correctly after a full Harness close/reopen.
 *
 * IMPORTANT: the stored record is a REFERENCE, not an authorization grant. It
 * holds the platform-verified staffId so the tool layer can re-resolve the
 * role from current config. A role change or revocation between crash and
 * recovery therefore takes effect immediately — we never replay a cached
 * "was admin" decision.
 */
import { defineDoc } from "@earendil-works/pi-durable";

export interface VeActorDoc {
	[key: string]: string | number;
	/** Platform-verified sender id (never derived from message text). */
	staffId: string;
	/** Display name at the time of the turn; informational only. */
	name: string;
	/** Channel that carried the turn ("dingtalk" | "console" | "scheduler"). */
	channel: string;
	/** Single vs group chat, for audience-scoped outbound gating. */
	chatType: "single" | "group" | "";
	/** The conversation the memory layer should scope to (may differ from the transcript's). */
	memoryConversationId: string;
	memoryChannel: string;
	/** Text of the turn's originating message; needed by tools that re-check the request. */
	text: string;
	/** When this identity was last stamped (ms). */
	stampedAt: number;
}

export const VeActorDocDef = defineDoc<VeActorDoc>({
	kind: "ve.actor",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A forked conversation must not inherit another conversation's sender.
	fork: "initial",
	initial: () => ({
		staffId: "",
		name: "",
		channel: "",
		chatType: "",
		memoryConversationId: "",
		memoryChannel: "",
		text: "",
		stampedAt: 0,
	}),
	// Identity is small and must survive a crash, so it is always stored eagerly.
	checkpointWhen: () => false,
});
