/**
 * Where a RECOVERED durable reply belongs (v0.2.174).
 *
 * durable recovery runs when the app died mid-turn. The recovered answer used
 * to be pushed only for `history.isReadOnly(conversationId)` channels — i.e. the
 * ones a human talks in. Window conversations (`work:<itemId>`,
 * `sched:<taskId>:<runId>`) are neither read-only nor watched by anyone, so a
 * recovered task window finished its work and reported it into a console
 * conversation nobody opens: from the operator's side, "recovery never
 * happened". User ruling 2026-10-29: the recovered result goes back to the
 * task's SOURCE conversation.
 *
 * Upgrade/restart behaviour is deliberately unchanged: a graceful stop joins
 * in-flight runs and closes cleanly, so nothing is pending to recover — the task
 * layer (work-item / scheduled state machines) resumes at its next due time.
 * This module only covers the real-crash case.
 */

/** Console-side window conversations and how to resolve their human target. */
export const WORK_CONVERSATION_PREFIX = "work:";
export const SCHEDULED_CONVERSATION_PREFIX = "sched:";

export type RecoveredDeliveryPlan =
	/** Push straight to this conversation. */
	| { kind: "direct"; conversationId: string }
	/** Resolve the human target from the owning task row; no target → stay quiet. */
	| { kind: "task-source"; task: "work"; taskId: string }
	| { kind: "task-source"; task: "scheduled"; taskId: string }
	/** Nobody to tell. */
	| { kind: "none" };

/**
 * Classify a conversation id and decide where a recovered reply goes.
 *
 * Pure and exported so the routing itself is testable — the runner in main.ts
 * is not unit-tested, and this decision is exactly what was missing.
 */
export function planRecoveredDelivery(conversationId: string): RecoveredDeliveryPlan {
	if (conversationId.startsWith(WORK_CONVERSATION_PREFIX)) {
		const taskId = conversationId.slice(WORK_CONVERSATION_PREFIX.length);
		// A malformed id has no owning row: falling back to "direct" would push
		// into the console conversation, which is the bug this fixes.
		return taskId ? { kind: "task-source", task: "work", taskId } : { kind: "none" };
	}
	if (conversationId.startsWith(SCHEDULED_CONVERSATION_PREFIX)) {
		// sched:<taskId>:<runId> — the run id may itself contain colons, so take
		// only the first segment after the prefix.
		const rest = conversationId.slice(SCHEDULED_CONVERSATION_PREFIX.length);
		const taskId = rest.split(":")[0];
		return taskId ? { kind: "task-source", task: "scheduled", taskId } : { kind: "none" };
	}
	if (!conversationId.trim() || conversationId === "default") return { kind: "none" };
	// IM conversations (dt:<staffId> / dt:group:<id>) and local console chats.
	return { kind: "direct", conversationId };
}

/**
 * Compose the note a task's source conversation receives for a recovered run.
 * It must be unmistakable that this is a post-crash continuation — a bare answer
 * arriving hours later reads as a hallucinated message.
 */
export function formatRecoveredNote(input: {
	title?: string | null;
	reply: string;
}): string {
	const title = input.title?.trim();
	const heading = title ? `♻️ **${title}** 崩溃后已自动恢复并完成本轮` : "♻️ 崩溃后已自动恢复并完成本轮";
	const body = input.reply.trim();
	return body ? `${heading}\n\n${body}` : heading;
}
