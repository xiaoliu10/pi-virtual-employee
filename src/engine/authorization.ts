/**
 * Admin one-shot delegation for group chats (field request 2026-09-17):
 * a viewer/operator asks for something beyond their role → the refusal tells
 * them an admin can confirm with 「确认授权」; an admin's confirmation re-runs
 * the ORIGINAL request once, with the platform-verified admin as the actor.
 *
 * Design constraints:
 *  - Single-shot: the pending request is consumed by exactly one re-execution;
 *    nothing is permanently elevated.
 *  - Only a platform-verified admin's confirmation counts (checked at confirm
 *    time, NOT by message text — same principle as the whole RBAC layer).
 *  - The pending request carries the ORIGINAL requester message so the admin
 *    sees what they are vouching for, and the re-run replays exactly that.
 *  - Pending requests expire (10 min) so a stale voucher can't fire later.
 *  - Tools that require an explicit 「确认」 in the message (run_command,
 *    manage_update, set_auto…) keep that gate even under delegation: the
 *    re-run replays the requester's original text, which contains no 确认,
 *    so those still refuse — destructive ops need the admin's own message.
 */

export interface PendingAuthorization {
	conversationId: string;
	/** The original requester message to replay on confirmation. */
	message: string;
	/** Platform-verified senderId of the requester (telemetry/audit only). */
	requesterId?: string;
	capability: string;
	/** Human phrase of the missing role, e.g. 「操作员（operator）」. */
	need: string;
	requestedAt: number;
}

/** How long a pending authorization stays confirmable. */
export const AUTHORIZATION_TTL_MS = 10 * 60_000;

/** The exact confirmation phrase an admin sends (see isAuthorizationPhrase). */
export const AUTHORIZATION_PHRASE = "确认授权";

/**
 * True when an inbound message IS the authorization confirmation — not merely
 * contains it. Exact after stripping @mentions (the adapter already normalized
 * those), surrounding whitespace, and trailing sentence punctuation. Matching
 * the whole message keeps unrelated prose containing the words from arming a
 * grant.
 */
export function isAuthorizationPhrase(raw: string): boolean {
	const t = (raw ?? "").trim().replace(/^[!！。.?？、,，…\s]+/, "").replace(/[!！。.?？、,，…\s]+$/, "");
	return t === AUTHORIZATION_PHRASE;
}

/**
 * One pending authorization per conversation (latest request wins — an admin
 * confirming always answers the most recent outstanding request they saw).
 * Expiry is enforced on read: an expired entry is dropped, never granted.
 */
export class AuthorizationStore {
	private readonly pending = new Map<string, PendingAuthorization>();

	constructor(private readonly ttlMs: number = AUTHORIZATION_TTL_MS) {}

	note(request: PendingAuthorization): void {
		this.pending.set(request.conversationId, request);
	}

	/** Latest valid pending request, or undefined (expired entries are dropped). */
	peek(conversationId: string, now = Date.now()): PendingAuthorization | undefined {
		const p = this.pending.get(conversationId);
		if (!p) return undefined;
		if (now - p.requestedAt > this.ttlMs) {
			this.pending.delete(conversationId);
			return undefined;
		}
		return p;
	}

	/** Take the pending request out (consumes the single shot). */
	consume(conversationId: string, now = Date.now()): PendingAuthorization | undefined {
		const p = this.peek(conversationId, now);
		if (p) this.pending.delete(conversationId);
		return p;
	}

	drop(conversationId: string): void {
		this.pending.delete(conversationId);
	}
}
