/**
 * Scoped memory — identity/scope derivation (the single trust boundary).
 *
 * Memory entries live in the same SQLite KB as regular knowledge but carry a
 * `memory_scope` + `memory_owner`. The owner is ALWAYS derived here from
 * server-verified inputs (platform senderId / the conversation id), never from
 * model-supplied text — so prompt injection in a message, web page or file can
 * never write to, or read, another person's / group's memory.
 *
 * Scopes:
 *  - profile:      shared facts for this whole VE profile (admin-writable).
 *  - person:       one platform identity, across that person's 1:1 and groups.
 *  - conversation: one IM conversation (typically a group); visible only there.
 *
 * Person owner key uses the platform channel + verified senderId. A scheduled
 * task's unattended turn re-attaches its creator as `{ channel: "scheduler",
 * senderId, memoryConversationId }`; the scheduler channel maps to the creator's
 * normal channel family so a memory written live and one written by the
 * creator's scheduled task share one owner.
 */
import type { InboundActor } from "../im/types.js";

export type MemoryScope = "profile" | "person" | "conversation";

/** Verified, server-side context a memory read/write is scoped against. */
export interface MemoryContext {
	/** Stable per-person owner key (`person:<channelFamily>:<senderId>`). */
	personOwner?: string;
	/** Stable per-conversation owner key (`conversation:<conversationId>`). */
	conversationOwner?: string;
}

/** Which channel family an actor belongs to (scheduler re-attaches a creator). */
function channelFamily(channel: string | undefined, fallback = "scheduler"): string {
	// The synthetic scheduler channel must not fork the creator's person memory.
	// New tasks carry their original channel via memoryChannel; legacy tasks
	// predate that column and are DingTalk deployments, so dingtalk is the
	// conservative historical default.
	if (channel && channel !== "scheduler") return channel;
	return fallback;
}

/** The conversation a scheduler/work unattended turn logically belongs to. */
export function actorMemoryConversationId(
	actor: InboundActor | undefined,
	fallbackConversationId: string,
): string | undefined {
	if (!actor) return undefined;
	// The synthetic identity carries the originating conversation explicitly when
	// it was created from an IM chat (scheduled task / autonomous work).
	const extra = actor as InboundActor & { memoryConversationId?: string };
	if (extra.memoryConversationId) return extra.memoryConversationId;
	if (actor.channel === "scheduler") return undefined;
	return fallbackConversationId;
}

/**
 * Derive the read/write memory context from the verified turn actor.
 * Pure + synchronous; never reads message text.
 */
export function deriveMemoryContext(
	actor: (InboundActor & { memoryChannel?: string }) | undefined,
	conversationId: string,
): MemoryContext {
	if (!actor?.senderId) return {}; // console/anonymous: profile only
	const memoryChannel = (actor as InboundActor & { memoryChannel?: string }).memoryChannel;
	const memoryCid = actorMemoryConversationId(actor, conversationId);
	const originPrefix = memoryCid?.split(":", 1)[0];
	const originChannel = originPrefix === "dt" ? "dingtalk"
		: originPrefix && ["feishu", "wecom", "echo"].includes(originPrefix) ? originPrefix : undefined;
	const personOwner = `person:${channelFamily(memoryChannel ?? actor.channel, originChannel ?? "dingtalk")}:${actor.senderId}`;
	// Only an IM conversation (group or 1:1) defines a conversation scope. A
	// synthetic sched:/work: id is the run's own scratch conversation, never a
	// real chat — use the originating conversation when the actor carries one.
	const scopedCid = memoryCid && /^(dt|feishu|wecom|echo):/.test(memoryCid) ? memoryCid : undefined;
	return {
		personOwner,
		conversationOwner: scopedCid ? `conversation:${scopedCid}` : undefined,
	};
}

/** Owner key for an explicit scope under a verified context. */
export function ownerForScope(scope: MemoryScope, ctx: MemoryContext): string | null {
	if (scope === "profile") return null; // profile is shared → NULL owner
	if (scope === "person") return ctx.personOwner ?? null;
	return ctx.conversationOwner ?? null;
}

/** Whether a row with the given scope/owner is visible in a context. */
export function isMemoryVisible(
	scope: string | null | undefined,
	owner: string | null | undefined,
	ctx: MemoryContext,
): boolean {
	// Non-memory / legacy rows are regular knowledge, always visible. This module
	// only filters entries explicitly tagged with a non-profile memory scope.
	if (!scope || scope === "profile") return true;
	if (scope === "person") return !!owner && owner === ctx.personOwner;
	if (scope === "conversation") return !!owner && owner === ctx.conversationOwner;
	return false; // Unknown non-profile scopes never become public.
}
