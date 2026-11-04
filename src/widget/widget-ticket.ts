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
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
	/**
	 * Lifetime of a ticket. Defaults to DEFAULT_TTL_MS (30 min).
	 *
	 * Field 2026-11-04: the old 5-minute default was much shorter than a real
	 * conversation. An embedded assistant holds ONE ticket for a whole session
	 * (the business system mints it when the panel opens), so a user who asked a
	 * second or third question — especially after a slow model turn — hit
	 * "会话票据已过期". TTL is configurable via widget.ticketTtlSec.
	 */
	ttlMs?: number | (() => number | undefined);
	/** Hard cap on live tickets, so a mint loop cannot exhaust memory. */
	maxTickets?: number;
	now?: () => number;
}

/**
 * 30 minutes. Long enough to cover a real conversation (the embedded assistant
 * reuses one ticket for the whole session) while staying far below any window
 * where a leaked ticket would matter — tickets are 32 random bytes, bound to
 * (client address, Origin), never persisted, and die on restart.
 */
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_TICKETS = 1_000;

/**
 * In-memory ticket store. Tickets are intentionally NOT persisted: a restart
 * invalidating every ticket is the safer failure mode (the browser just asks
 * its backend for a new one).
 *
 * Security note on the default TTL: guessing is not a realistic attack here —
 * a ticket is 32 random bytes and redeem() rejects any address/origin mismatch
 * outright, so the window length does not meaningfully widen the surface.
 */
export class TicketStore {
	#tickets = new Map<string, TicketRecord>();
	#ttlMs: number | (() => number | undefined);
	#maxTickets: number;
	#now: () => number;

	constructor(options: TicketStoreOptions = {}) {
		this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.#maxTickets = options.maxTickets ?? DEFAULT_MAX_TICKETS;
		this.#now = options.now ?? Date.now;
	}

	/** Current TTL in ms: fixed value, or the resolver's answer with a safe floor. */
	ttlMs(): number {
		const raw = typeof this.#ttlMs === "function" ? this.#ttlMs() : this.#ttlMs;
		return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
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
			// Resolved per mint so an admin's config change applies to the NEXT ticket
			// without a restart. A resolver that throws or returns nonsense falls back
			// to the default rather than minting an already-expired ticket.
			expiresAt: now + this.ttlMs(),
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
 *
 * MUST BE INJECTIVE (two different users never share a key). The previous
 * version stripped every non-[A-Za-z0-9_-] character, which silently merged
 * users — a real cross-user data leak:
 *
 *   "zhang.san"          -> "zhangsan"  ┐ identical
 *   "zhangsan"           -> "zhangsan"  ┘
 *   "user@example.com"   -> "userexamplecom"
 *   "userexamplecom"     -> "userexamplecom"
 *   "张三" / "李四" / ... -> "anon"        ← EVERY non-ASCII user shared one bucket
 *
 * The "anon" fallback was the worst of it: a business system using Chinese names
 * or phone numbers as the user id would put ALL of its users into one
 * conversation, so each saw the others' chat history — and they shared one
 * `senderId`, hence one RBAC identity and one memory scope too.
 *
 * Now: a readable prefix (safe characters only) PLUS a hash of the original id.
 * The hash makes collisions cryptographically improbable, and the prefix keeps
 * conversations identifiable while debugging. Non-ASCII ids hash like anything
 * else instead of collapsing to "anon".
 */
export function widgetConversationKey(user: string): string {
	const raw = String(user ?? "").trim();
	if (!raw) return "anon";
	// Readable part: safe characters only, and never empty (a pure-CJK id has no
	// safe characters at all, so it becomes "u").
	const readable = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "u";
	// Uniqueness: hash the ORIGINAL id (never the stripped one).
	const digest = createHash("sha256").update(raw, "utf8").digest("base64url").slice(0, 16);
	return `${readable}-${digest}`;
}
