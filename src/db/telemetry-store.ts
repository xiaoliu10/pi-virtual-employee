/**
 * Run telemetry — the feedback signal the employee was missing.
 *
 * Until now every signal about "how did that turn actually go" was computed and
 * then thrown away to a log line: retry counts, the tool-step cap firing, the IM
 * watchdog aborting a wedged turn, empty replies, deterministic failure strings,
 * which tool got refused by RBAC. Without a stored outcome there is no way to
 * tell whether a change made things better — so any "self-improvement" loop is
 * measuring nothing. This store keeps two shapes:
 *
 *   turn_events  one row per user turn: outcome + the counters above.
 *   tool_events  one row per tool call: name, duration, refused, error.
 *
 * Deliberately local-only and cheap:
 *  - no message text is stored here (the transcript already lives in `messages`);
 *    `correction` is a BOOLEAN weak label derived from the user's own wording,
 *    not the wording itself. It never leaves the machine.
 *  - error strings are truncated (`MAX_ERROR_LEN`) so a failure can't smuggle a
 *    whole page of output into the DB.
 *  - `prune()` bounds growth; callers run it on startup alongside the other
 *    housekeeping sweeps.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./sqlite.js";

/** Truncation cap for stored error strings (and any sample text we keep). */
export const MAX_ERROR_LEN = 300;

/** How long turn/tool rows are kept. Long enough to compare weeks of behaviour. */
export const RETENTION_DAYS = 90;

export type TurnStatus = "ok" | "error" | "empty_reply" | "deterministic_failure" | "aborted";

export interface TurnEventRow {
	id: string;
	conversation_id: string;
	origin: string;
	actor_id: string | null;
	channel: string | null;
	chat_type: string | null;
	started_at: number;
	duration_ms: number;
	status: TurnStatus;
	error: string | null;
	tool_calls: number;
	retries: number;
	step_cap_hit: number;
	empty_reply: number;
	deterministic: number;
	abort_reason: string | null;
	correction: number;
	reply_len: number;
}

export interface RecordTurnInput {
	/** Caller-supplied so tool calls of this turn can be linked to it. */
	turnId: string;
	conversationId: string;
	origin: string;
	actorId?: string;
	channel?: string;
	chatType?: string;
	startedAt: number;
	durationMs: number;
	status: TurnStatus;
	error?: string;
	toolCalls?: number;
	retries?: number;
	stepCapHit?: boolean;
	emptyReply?: boolean;
	deterministic?: boolean;
	abortReason?: string;
	correction?: boolean;
	replyLen?: number;
}

export interface RecordToolInput {
	conversationId: string;
	turnId?: string;
	name: string;
	durationMs: number;
	ok: boolean;
	refused?: boolean;
	error?: string;
}

/** Aggregate view returned to the agent (and only ever to an authorized one). */
export interface TelemetrySummary {
	/** Window actually covered, in hours. */
	hours: number;
	/** When true, only the asking conversation's rows are counted. */
	scopedToConversation: boolean;
	turns: number;
	byStatus: Record<string, number>;
	/** Turn-level trouble counters (each is "how many turns had this"). */
	trouble: {
		retried: number;
		stepCapHit: number;
		emptyReply: number;
		deterministicFailure: number;
		aborted: number;
		correction: number;
	};
	avgDurationMs: number;
	toolCalls: number;
	/** Tools ranked by failures, worst first. */
	failingTools: { name: string; calls: number; failed: number; refused: number }[];
	/** Distinct recent error strings, already truncated, newest first. */
	recentErrors: string[];
	/** Turns per day inside the window, oldest first. */
	perDay: { day: string; turns: number; failed: number }[];
}

const truncate = (text: string | undefined): string | undefined => {
	if (!text) return undefined;
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > MAX_ERROR_LEN ? `${one.slice(0, MAX_ERROR_LEN)}…` : one;
};

/**
 * Weak label: does the user's own message read like they are correcting us?
 * Deliberately narrow (corrections are the strongest cheap signal that the
 * previous turn was wrong, and a false positive just adds noise to a counter).
 */
export function looksLikeCorrection(text: string): boolean {
	const t = (text ?? "").trim();
	if (t.length === 0 || t.length > 400) return false;
	return /(不对|错了|不是这个|又错|搞错|理解错|我说的是|我不是说|应该是|who said|again wrong|that'?s wrong|not what i (asked|said))/i.test(t);
}

export class TelemetryStore {
	constructor(private readonly db: DB) {}

	/** Insert one finished turn. Best-effort by contract: callers wrap in try/catch. */
	recordTurn(input: RecordTurnInput): void {
		this.db
			.prepare(
				`INSERT INTO turn_events (
					id, conversation_id, origin, actor_id, channel, chat_type, started_at, duration_ms,
					status, error, tool_calls, retries, step_cap_hit, empty_reply, deterministic,
					abort_reason, correction, reply_len
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.turnId,
				input.conversationId,
				input.origin,
				input.actorId ?? null,
				input.channel ?? null,
				input.chatType ?? null,
				input.startedAt,
				Math.max(0, Math.round(input.durationMs)),
				input.status,
				truncate(input.error) ?? null,
				input.toolCalls ?? 0,
				input.retries ?? 0,
				input.stepCapHit ? 1 : 0,
				input.emptyReply ? 1 : 0,
				input.deterministic ? 1 : 0,
				input.abortReason ?? null,
				input.correction ? 1 : 0,
				input.replyLen ?? 0,
			);
	}

	/** Insert one tool call. */
	recordTool(input: RecordToolInput): void {
		this.db
			.prepare(
				"INSERT INTO tool_events (id, conversation_id, turn_id, name, started_at, duration_ms, ok, refused, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				randomUUID(),
				input.conversationId,
				input.turnId ?? null,
				input.name,
				Date.now(),
				Math.max(0, Math.round(input.durationMs)),
				input.ok ? 1 : 0,
				input.refused ? 1 : 0,
				truncate(input.error) ?? null,
			);
	}

	/** Aggregate the window. `conversationId` set ⇒ only that chat's rows count. */
	summary(opts: { hours: number; conversationId?: string }): TelemetrySummary {
		const since = Date.now() - Math.max(1, opts.hours) * 3_600_000;
		const conv = opts.conversationId;
		const turnWhere = conv ? "started_at >= ? AND conversation_id = ?" : "started_at >= ?";
		const turnArgs = conv ? [since, conv] : [since];
		const rows = this.db
			.prepare(`SELECT * FROM turn_events WHERE ${turnWhere} ORDER BY started_at DESC`)
			.all(...turnArgs) as TurnEventRow[];

		const toolWhere = conv
			? "te.started_at >= ? AND te.conversation_id = ?"
			: "te.started_at >= ?";
		const toolRows = this.db
			.prepare(
				`SELECT te.name AS name, COUNT(*) AS calls,
					SUM(CASE WHEN te.ok = 0 THEN 1 ELSE 0 END) AS failed,
					SUM(CASE WHEN te.refused = 1 THEN 1 ELSE 0 END) AS refused
				 FROM tool_events te WHERE ${toolWhere}
				 GROUP BY te.name ORDER BY failed DESC, calls DESC`,
			)
			.all(...turnArgs) as { name: string; calls: number; failed: number; refused: number }[];

		const byStatus: Record<string, number> = {};
		const perDayMap = new Map<string, { turns: number; failed: number }>();
		let durationSum = 0;
		let toolCalls = 0;
		const trouble = { retried: 0, stepCapHit: 0, emptyReply: 0, deterministicFailure: 0, aborted: 0, correction: 0 };
		for (const r of rows) {
			byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
			durationSum += r.duration_ms;
			toolCalls += r.tool_calls;
			if (r.retries > 0) trouble.retried += 1;
			if (r.step_cap_hit) trouble.stepCapHit += 1;
			if (r.empty_reply) trouble.emptyReply += 1;
			if (r.deterministic) trouble.deterministicFailure += 1;
			if (r.abort_reason) trouble.aborted += 1;
			if (r.correction) trouble.correction += 1;
			const day = new Date(r.started_at).toISOString().slice(0, 10);
			const cell = perDayMap.get(day) ?? { turns: 0, failed: 0 };
			cell.turns += 1;
			if (r.status !== "ok") cell.failed += 1;
			perDayMap.set(day, cell);
		}

		// Distinct error strings, newest first — the raw material for a fix proposal.
		const seen = new Set<string>();
		const recentErrors: string[] = [];
		for (const r of rows) {
			for (const text of [r.error]) {
				if (!text || seen.has(text)) continue;
				seen.add(text);
				recentErrors.push(text);
				if (recentErrors.length >= 10) break;
			}
			if (recentErrors.length >= 10) break;
		}
		// Tool failures carry their own error text (a turn can succeed overall).
		if (recentErrors.length < 10) {
			const toolErrors = this.db
				.prepare(
					`SELECT error FROM tool_events te WHERE ${toolWhere} AND error IS NOT NULL AND error <> '' AND ok = 0 ORDER BY te.started_at DESC LIMIT 20`,
				)
				.all(...turnArgs) as { error: string }[];
			for (const { error } of toolErrors) {
				if (seen.has(error)) continue;
				seen.add(error);
				recentErrors.push(error);
				if (recentErrors.length >= 10) break;
			}
		}

		return {
			hours: opts.hours,
			scopedToConversation: Boolean(conv),
			turns: rows.length,
			byStatus,
			trouble,
			avgDurationMs: rows.length ? Math.round(durationSum / rows.length) : 0,
			toolCalls,
			failingTools: toolRows.filter((t) => t.failed > 0 || t.refused > 0).slice(0, 10),
			recentErrors,
			perDay: [...perDayMap.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([day, v]) => ({ day, ...v })),
		};
	}

	/** Drop rows older than the retention window. Returns how many were removed. */
	prune(days = RETENTION_DAYS): number {
		const cutoff = Date.now() - days * 86_400_000;
		const turns = this.db.prepare("DELETE FROM turn_events WHERE started_at < ?").run(cutoff);
		this.db.prepare("DELETE FROM tool_events WHERE started_at < ?").run(cutoff);
		return Number(turns.changes ?? 0);
	}
}
