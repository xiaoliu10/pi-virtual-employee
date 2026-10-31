/**
 * Widget session tickets (v0.2.178).
 *
 * The embedded assistant runs inside a BUSINESS system, whose end users have
 * their own accounts. A user who is an admin over there should be an admin
 * here — but the browser is not a trustworthy place to say so: a `role` field
 * in a request body is one F12 keystroke away from being anything.
 *
 * So the role never travels in the chat request. The business system's BACKEND
 * exchanges (user, role) for a short-lived ticket using a secret the browser
 * never sees, and the browser only ever holds the ticket.
 *
 * Tickets are bound to their source. A ticket is minted for one client address
 * (and, when known, one Origin), and will only redeem from that same source.
 * A leaked ticket therefore cannot be replayed from another machine, and a
 * captive-portal/proxy that re-uses it elsewhere gets a 401 rather than an
 * admin session.
 *
 * Roles are capped at admin: `owner` is the deployment owner and is never
 * reachable from a widget, no matter what the business system claims.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Roles a widget may ever hold, ascending. `owner` is deliberately absent. */
export const WIDGET_MAX_ROLE = "admin" as const;
export type WidgetRole = "viewer" | "operator" | "admin";

const ROLE_ORDER: WidgetRole[] = ["viewer", "operator", "admin"];

/** Highest role a widget can be granted, honouring a configured ceiling. */
export function clampWidgetRole(claimed: unknown, ceiling: WidgetRole = WIDGET_MAX_ROLE): WidgetRole {
	const want = typeof claimed === "string" && (ROLE_ORDER as string[]).includes(claimed) ? (claimed as WidgetRole) : "viewer";
	// A caller may claim anything; we take the LOWER of claim and ceiling. `owner`
	// is not in ROLE_ORDER at all, so it degrades to viewer instead of matching.
	const cap = ROLE_ORDER.includes(ceiling) ? ceiling : WIDGET_MAX_ROLE;
	return ROLE_ORDER.indexOf(want) <= ROLE_ORDER.indexOf(cap) ? want : cap;
}

export interface TicketRecord {
	user: string;
	role: WidgetRole;
	/** Epoch ms. */
	expiresAt: number;
	/** Bound client address (normalised). */
	address: string;
	/** Bound Origin header, or "" when the caller had none. */
	origin: string;
	/** Conversation namespace key derived from `user`. */
	conversationKey: string;
}

export interface TicketStoreOptions {
	/** Lifetime of a ticket. Short by design: the browser fetches one per session. */
	ttlMs?: number;
	/** Hard cap on live tickets, so a mint loop cannot exhaust memory. */
	maxTickets?: number;
	now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_TICKETS = 1_000;

/**
 * In-memory ticket store. Tickets are intentionally NOT persisted: a restart
 * invalidating every ticket is the safer failure mode (the browser just asks
 * its backend for a new one).
 */
export class TicketStore {
	#tickets = new Map<string, TicketRecord>();
	#ttlMs: number;
	#maxTickets: number;
	#now: () => number;

	constructor(options: TicketStoreOptions = {}) {
		this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.#maxTickets = options.maxTickets ?? DEFAULT_MAX_TICKETS;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * Mint a ticket bound to the source that will actually USE it.
	 *
	 * The exchange is made by the business system's BACKEND, while the chat comes
	 * from the END USER'S BROWSER — different addresses by nature. So the caller
	 * declares the consumer explicitly (origin, and optionally the client IP it
	 * will be used from), and the ticket binds to that declaration. Without this,
	 * a correctly configured integration would fail with address-mismatch.
	 */
	issue(input: { user: string; role: unknown; address: string; origin: string; conversationKey: string }, ceiling?: WidgetRole): { ticket: string; record: TicketRecord } {
		this.sweep();
		const now = this.#now();
		const record: TicketRecord = {
			user: input.user,
			role: clampWidgetRole(input.role, ceiling),
			expiresAt: now + this.#ttlMs,
			address: input.address,
			origin: input.origin,
			conversationKey: input.conversationKey,
		};
		// 32 bytes of entropy: guessing is not a realistic attack against a 5 min TTL.
		const ticket = randomBytes(32).toString("base64url");
		this.#tickets.set(ticket, record);
		// Oldest-first eviction keeps the map bounded without a timer.
		while (this.#tickets.size > this.#maxTickets) {
			const oldest = this.#tickets.keys().next();
			if (oldest.done) break;
			this.#tickets.delete(oldest.value);
		}
		return { ticket, record };
	}

	/**
	 * Redeem a ticket FROM a source. Returns a specific reason on failure so the
	 * caller can log why (a silent 401 with no reason is undebuggable in the field).
	 */
	redeem(ticket: string | undefined, source: { address: string; origin: string }): { ok: true; record: TicketRecord } | { ok: false; reason: string } {
		if (!ticket) return { ok: false, reason: "missing-ticket" };
		const record = this.#tickets.get(ticket);
		if (!record) return { ok: false, reason: "unknown-ticket" };
		if (record.expiresAt <= this.#now()) {
			this.#tickets.delete(ticket);
			return { ok: false, reason: "expired" };
		}
		// Source binding: a stolen ticket must not work from anywhere else.
		// The address is the one DECLARED at mint time (the browser's, not the
		// minting backend's); a wildcard "*" means the caller did not pin an IP,
		// in which case Origin is the only (softer) binding.
		if (record.address !== "*" && record.address !== source.address) {
			return { ok: false, reason: "address-mismatch" };
		}
		// Origin binds whenever one was declared; a mint with no origin is only
		// legitimate for server-to-server callers, which never use /chat.
		if (record.origin && record.origin !== source.origin) return { ok: false, reason: "origin-mismatch" };
		return { ok: true, record };
	}

	/** Drop expired tickets. Called on every issue; cheap at this scale. */
	sweep(): void {
		const now = this.#now();
		for (const [key, record] of this.#tickets) {
			if (record.expiresAt <= now) this.#tickets.delete(key);
		}
	}

	get size(): number {
		return this.#tickets.size;
	}
}

/**
 * Constant-time comparison of a presented secret against the configured one.
 * Empty configured secret never matches (a missing secret must not be a way in).
 */
export function secretMatches(presented: string, expected: string): boolean {
	if (!presented || !expected) return false;
	const a = createHmac("sha256", "ve-widget-secret").update(presented).digest();
	const b = createHmac("sha256", "ve-widget-secret").update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * Conversation namespace for a widget user. Must stay a single safe segment:
 * the user key arrives from the business system and must not be able to point
 * the conversation at an IM/console id.
 */
export function widgetConversationKey(user: string): string {
	const clean = user.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
	return clean || "anon";
}
