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

export interface ToolEventRow {
	id: string;
	conversation_id: string;
	turn_id: string | null;
	name: string;
	started_at: number;
	duration_ms: number;
	ok: number;
	refused: number;
	refused_capability: string | null;
	error: string | null;
}

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
	/** When the call happened; defaults to now. Stated explicitly by callers that
	 *  record a call after the fact (tests, replays). */
	startedAt?: number;
	durationMs: number;
	ok: boolean;
	refused?: boolean;
	/** Capability the refusal was about (structured, not parsed from text). */
	refusedCapability?: string;
	error?: string;
}

/** One group of similar failures in a review window. */
export interface FailureCluster {
	kind: "refusal" | "tool_error" | "turn_error" | "aborted" | "step_cap" | "empty_reply" | "correction";
	/** Refusal ⇒ the capability; errors ⇒ "tool: signature"; others ⇒ a fixed label. */
	label: string;
	count: number;
	/** Same cluster's count in the preceding equally-long window. */
	prior: number;
	/** count - prior: what is NEW or growing is what deserves attention. */
	delta: number;
	/** Up to 3 original texts (or tool names for refusals) for the reviewer. */
	samples: string[];
}

export interface TrendWindow {
	turns: number;
	failed: number;
	retries: number;
	caps: number;
	corrections: number;
	aborted: number;
	refusals: number;
	avgDurationMs: number;
}

export interface Trend {
	hours: number;
	current: TrendWindow;
	previous: TrendWindow;
}

/**
 * Normalize a failure message into a cluster signature: the same error with a
 * different order id, port, path or timing must land in ONE group, otherwise a
 * weekly review sees ten "unique" problems that are one problem.
 */
export function errorSignature(text: string): string {
	let t = text.toLowerCase();
	t = t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
	t = t.replace(/\b(?:[a-z]:)?(?:[\/][\w.\-]+){2,}/g, "<path>");
	t = t.replace(/\bhttps?:\/\/[^\s"']+/g, "<url>");
	t = t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>");
	t = t.replace(/\b[0-9a-f]{16,}\b/g, "<hex>");
	t = t.replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, "<time>");
	// No word boundaries: "12000ms" and "HTTP429" must normalize too, and by this
	// point every digit left belongs to a number (placeholders carry none).
	t = t.replace(/\d+(?:\.\d+)?/g, "<n>");
	t = t.replace(/"[^"]*"/g, "<str>");
	t = t.replace(/\s+/g, " ").trim();
	return t.length > 90 ? `${t.slice(0, 90)}…` : t;
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
				"INSERT INTO tool_events (id, conversation_id, turn_id, name, started_at, duration_ms, ok, refused, refused_capability, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				randomUUID(),
				input.conversationId,
				input.turnId ?? null,
				input.name,
				input.startedAt ?? Date.now(),
				Math.max(0, Math.round(input.durationMs)),
				input.ok ? 1 : 0,
				input.refused ? 1 : 0,
				input.refusedCapability ?? null,
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

	/**
	 * Cluster the window's failures so a review can act on them.
	 *
	 * Aggregation happens HERE, in code, not in the model: the counts are the
	 * evidence, and evidence must not be produced by the thing being reviewed.
	 * The model's job is to interpret the clusters, not to derive them.
	 *
	 *  - refusals cluster by the CAPABILITY they were about (a structured field),
	 *    because "which kind of request keeps getting denied" is a policy signal.
	 *  - errors cluster by a normalized signature, so the same failure with a
	 *    different order id / path / port lands in one group instead of ten.
	 *  - `prior` is the same signature's count in the equally-long window before
	 *    this one, which is what turns a count into a direction (getting worse?).
	 */
	failureClusters(opts: { hours: number; conversationId?: string; limit?: number }): FailureCluster[] {
		const hours = Math.max(1, opts.hours);
		const now = Date.now();
		const since = now - hours * 3_600_000;
		const priorSince = since - hours * 3_600_000;
		const conv = opts.conversationId;
		const where = conv ? "started_at >= ? AND conversation_id = ?" : "started_at >= ?";
		const args = conv ? [since, conv] : [since];
		const priorArgs = conv ? [priorSince, conv] : [priorSince];

		const tools = this.db
			.prepare(`SELECT name, refused, refused_capability, error FROM tool_events WHERE ${where}`)
			.all(...args) as Pick<ToolEventRow, "name" | "refused" | "refused_capability" | "error">[];
		const priorTools = this.db
			.prepare(`SELECT name, refused, refused_capability, error FROM tool_events WHERE ${where} AND started_at < ?`)
			.all(...(conv ? [priorSince, conv!, since] : [priorSince, since])) as Pick<ToolEventRow, "name" | "refused" | "refused_capability" | "error">[];
		const turns = this.db
			.prepare(`SELECT status, error, abort_reason, step_cap_hit, empty_reply, correction FROM turn_events WHERE ${where}`)
			.all(...args) as Pick<TurnEventRow, "status" | "error" | "abort_reason" | "step_cap_hit" | "empty_reply" | "correction">[];

		const buckets = new Map<string, FailureCluster>();
		const mine: FailureCluster[] = [];
		const bump = (kind: FailureCluster["kind"], label: string): FailureCluster => {
			const key = `${kind}|${label}`;
			let cell = buckets.get(key);
			if (!cell) {
				cell = { kind, label, count: 0, prior: 0, samples: [], delta: 0 };
				buckets.set(key, cell);
				mine.push(cell);
			}
			return cell;
		};

		for (const t of tools) {
			if (t.refused) {
				const cell = bump("refusal", t.refused_capability ?? "unknown");
				cell.count += 1;
				if (!cell.samples.includes(t.name)) cell.samples.push(t.name);
				continue;
			}
			if (t.error) {
				const cell = bump("tool_error", `${t.name}: ${errorSignature(t.error)}`);
				cell.count += 1;
				if (!cell.samples.includes(t.error)) cell.samples.push(t.error);
			}
		}
		// Prior window counts feed the same bucket map so labels line up exactly.
		const priorCounts = new Map<string, number>();
		for (const t of priorTools) {
			const kind = t.refused ? "refusal" : "tool_error";
			const label = t.refused ? (t.refused_capability ?? "unknown") : `${t.name}: ${errorSignature(t.error ?? "")}`;
			const key = `${kind}|${label}`;
			priorCounts.set(key, (priorCounts.get(key) ?? 0) + 1);
		}
		for (const t of turns) {
			if (t.status === "error" && t.error) {
				const cell = bump("turn_error", errorSignature(t.error));
				cell.count += 1;
				if (!cell.samples.includes(t.error)) cell.samples.push(t.error);
			}
			if (t.abort_reason) bump("aborted", t.abort_reason).count += 1;
			if (t.step_cap_hit) bump("step_cap", "工具步数封顶").count += 1;
			if (t.empty_reply) bump("empty_reply", "回合无正文（靠兜底总结收尾）").count += 1;
			if (t.correction) bump("correction", "用户当场纠错").count += 1;
		}

		// Turn-level clusters get their prior from the previous window too, so a
		// rising correction rate is visible and not just an absolute number.
		const priorTurnRows = this.db
			.prepare(`SELECT abort_reason, step_cap_hit, empty_reply, correction FROM turn_events WHERE ${where} AND started_at < ?`)
			.all(...(conv ? [priorSince, conv, since] : [priorSince, since])) as Pick<TurnEventRow, "abort_reason" | "step_cap_hit" | "empty_reply" | "correction">[];
		for (const t of priorTurnRows) {
			if (t.abort_reason) priorCounts.set(`aborted|${t.abort_reason}`, (priorCounts.get(`aborted|${t.abort_reason}`) ?? 0) + 1);
			if (t.step_cap_hit) priorCounts.set("step_cap|工具步数封顶", (priorCounts.get("step_cap|工具步数封顶") ?? 0) + 1);
			if (t.empty_reply) priorCounts.set("empty_reply|回合无正文（靠兜底总结收尾）", (priorCounts.get("empty_reply|回合无正文（靠兜底总结收尾）") ?? 0) + 1);
			if (t.correction) priorCounts.set("correction|用户当场纠错", (priorCounts.get("correction|用户当场纠错") ?? 0) + 1);
		}

		for (const c of mine) {
			c.prior = priorCounts.get(`${c.kind}|${c.label}`) ?? 0;
			c.delta = c.count - c.prior;
			c.samples = c.samples.slice(0, 3);
		}
		// Worst first: what is NEW or growing outranks what is merely large.
		return mine
			.sort((a, b) => b.delta - a.delta || b.count - a.count)
			.slice(0, Math.max(1, opts.limit ?? 12));
	}

	/** Window-over-window totals, so "did this get better?" has an answer. */
	trend(opts: { hours: number; conversationId?: string }): Trend {
		const hours = Math.max(1, opts.hours);
		const now = Date.now();
		const conv = opts.conversationId;
		const cell = (from: number, to: number) => {
			const where = conv
				? "started_at >= ? AND started_at < ? AND conversation_id = ?"
				: "started_at >= ? AND started_at < ?";
			const args = conv ? [from, to, conv] : [from, to];
			const row = this.db
				.prepare(
					`SELECT COUNT(*) AS turns,
						SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS failed,
						SUM(retries) AS retries, SUM(step_cap_hit) AS caps, SUM(correction) AS corrections,
						SUM(CASE WHEN abort_reason IS NOT NULL THEN 1 ELSE 0 END) AS aborted,
						AVG(duration_ms) AS avg_ms
					 FROM turn_events WHERE ${where}`,
				)
				.get(...args) as { turns: number; failed: number | null; retries: number | null; caps: number | null; corrections: number | null; aborted: number | null; avg_ms: number | null };
			const refused = this.db
				.prepare(`SELECT COUNT(*) AS n FROM tool_events WHERE ${where} AND refused = 1`)
				.get(...args) as { n: number };
			return {
				turns: row.turns ?? 0,
				failed: row.failed ?? 0,
				retries: row.retries ?? 0,
				caps: row.caps ?? 0,
				corrections: row.corrections ?? 0,
				aborted: row.aborted ?? 0,
				refusals: refused.n ?? 0,
				avgDurationMs: Math.round(row.avg_ms ?? 0),
			};
		};
		const current = cell(now - hours * 3_600_000, now);
		const previous = cell(now - 2 * hours * 3_600_000, now - hours * 3_600_000);
		return { hours, current, previous };
	}

	/** Drop rows older than the retention window. Returns how many were removed. */
	prune(days = RETENTION_DAYS): number {
		const cutoff = Date.now() - days * 86_400_000;
		const turns = this.db.prepare("DELETE FROM turn_events WHERE started_at < ?").run(cutoff);
		this.db.prepare("DELETE FROM tool_events WHERE started_at < ?").run(cutoff);
		return Number(turns.changes ?? 0);
	}
}
