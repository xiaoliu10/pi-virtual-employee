/**
 * Progress-notifier wiring shared by the two long-running paths (v0.2.173).
 *
 * Field report: after the durable kernel became the default (v0.2.167) a group
 * stopped receiving ANY task-progress note. Root cause was NOT the notifier:
 * both call sites gated on `agent.state.isStreaming`, and the durable kernel
 * drives the harness directly — `pi-durable` never sets that flag (only
 * pi-agent-core's own `prompt()/stream()` do). `state.isStreaming` therefore
 * stayed false for the whole run, and every tick returned early **silently**,
 * so a shipped feature looked like it had never existed.
 *
 * Two rules encoded here:
 *  1. "still running" is the CALLER's knowledge (a run/window is alive between
 *     model calls), never the kernel's internal stream flag;
 *  2. a gate that blocks a push must say so once, in the log, with a reason —
 *     a silently-dropped heartbeat is indistinguishable from a missing feature.
 */
import { createProgressNotifier } from "./progress-notify.js";
import { shouldPushScheduledResult } from "./scheduler-service.js";

type Log = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

/**
 * Where a work item's progress goes: the conversation it was mined from, else a
 * 1:1 with its creator.
 *
 * The `dt:` prefix matters: `created_by` is a bare staffId, while every push
 * target is a conversation id (`dt:<staffId>`, `dt:group:<id>`). Pushing to the
 * bare id fails delivery entirely (`adapterFor` accepts only `dt:`), so the
 * prefixed fallback is what makes a console-created item deliverable at all.
 *
 * Scope notes (subagent review, v0.2.173):
 *  - every CURRENT create path passes `originConversation`
 *    (tools/work.ts, engine.ts mining), so the `created_by` branch is a
 *    defensive fallback for legacy/future rows, not the field-failure cause;
 *  - the prefix is DingTalk's convention. With a second IM channel this must
 *    move behind the adapter (e.g. `conversationIdForStaff`), because a bare
 *    staffId carries no channel identity.
 */
export function resolveWorkProgressTarget(item: { origin_conversation?: string | null; created_by?: string | null }): string | null {
	const origin = item.origin_conversation?.trim();
	if (origin) return origin;
	const createdBy = item.created_by?.trim();
	if (!createdBy) return null;
	// Console-created items carry no channel; a bare staffId is a 1:1 target.
	return createdBy.includes(":") ? createdBy : `dt:${createdBy}`;
}

export interface WorkProgressOptions {
	item: { title: string; origin_conversation?: string | null; created_by?: string | null };
	session: unknown;
	conversationId: string;
	intervalMin: number;
	summarize: () => Promise<{ text: string; degraded: boolean }>;
	push: (conversationId: string, text: string) => Promise<unknown> | unknown;
	log?: Log;
}

/**
 * Notifier for one work window. The window's lifetime IS the "running" signal:
 * WorkService starts it when the window opens and stops+drains it when the
 * window ends, so gating on the kernel's stream flag would only add a way to
 * miss beats (see the module comment).
 */
export function createWorkProgressNotifier(opts: WorkProgressOptions) {
	const target = resolveWorkProgressTarget(opts.item);
	const log = opts.log;
	return createProgressNotifier({
		title: opts.item.title,
		target,
		intervalMin: opts.intervalMin,
		summarize: opts.summarize,
		push: async (conversationId, text) => { await opts.push(conversationId, text); },
		// Alive until WorkService stops the notifier — never read the kernel flag.
		isRunning: () => true,
		// Gate on the RESOLVED target: the old code checked origin_conversation
		// only, so every item whose target came from `created_by` had all of its
		// notes dropped after the side LLM pass had already been paid for.
		preflight: () => Boolean(target),
		mayPush: (note) => Boolean(target) && shouldPushScheduledResult({ conversation_id: target, silent: 0 }, undefined, note),
		log: (level, message) => log?.(level, message),
	});
}

export interface RunProgressOptions {
	task: { title: string; conversation_id: string | null; silent: number };
	intervalMin: number;
	summarize: () => Promise<{ text: string; degraded: boolean }>;
	push: (conversationId: string, text: string) => Promise<unknown> | unknown;
	/** The caller's own lifetime flag for this run (set false once it settles). */
	isRunAlive: () => boolean;
	isTimedOut: () => boolean;
	log?: Log;
}

/**
 * Notifier for one scheduled-task fire. Same rule as above: `isRunAlive` comes
 * from the runner, not from `agent.state.isStreaming` (which is permanently
 * false on the durable kernel).
 */
export function createRunProgressNotifier(opts: RunProgressOptions) {
	return createProgressNotifier({
		title: opts.task.title,
		target: opts.task.conversation_id,
		intervalMin: opts.intervalMin,
		summarize: opts.summarize,
		push: async (conversationId, text) => { await opts.push(conversationId, text); },
		isRunning: () => opts.isRunAlive(),
		suppress: () => opts.isTimedOut(),
		// The preflight probe is "would ANY note be deliverable", so it must not
		// pass an empty note: shouldPushScheduledResult() rejects empty text, and
		// probing with "" therefore closed the gate for every scheduled task —
		// no progress ever, for the whole feature (v0.2.173, found by the suite
		// below). A non-empty probe keeps only the real conditions (no target /
		// silent task).
		preflight: () => shouldPushScheduledResult(opts.task, undefined, "progress"),
		mayPush: (note) => shouldPushScheduledResult(opts.task, undefined, note),
		log: (level, message) => opts.log?.(level, message),
	});
}
