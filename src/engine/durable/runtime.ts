/** Durable execution owned by VE; UI history is a projection of the transcript. */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, createProvider, createAssistantMessageEventStream, type Model, type Api, type Message, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { defineDoc, ProviderDoc, type Conversation, type ConversationId, type Cursor, type EntryRecord, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Agent, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { SendCtx, SendResult, TurnProcessEvent } from "../engine.js";
import type { HistoryStore } from "../../db/history-store.js";
import { looksLikeImperative, looksLikeTask, NARRATION_GUARD_NOTICE } from "../task-planner.js";
import { openDurableHost, type DurableHost } from "./harness-host.js";
import { toDurableTool } from "./ve-tools.js";

interface RouteDoc {
	[key: string]: string | number;
	conversationId: string;
	requestId: string;
	staffId: string;
	/** Verified widget grant for this execution; "" = absent (pre-fix records). */
	verifiedRole: string;
	name: string;
	channel: string;
	chatType: string;
	text: string;
	projected: number;
	/** Memory scope anchors (context-management.md §2 断链1). Unattended turns
	 * (scheduler/work/worker channel) carry the ORIGINATING conversation here so
	 * conversation-scoped memory stays reachable from inside the durable round.
	 * Persisted on the RouteDoc because tools resolve identity AFTER restart via
	 * actorContext() — an in-memory map would lose the anchor across recovery. */
	memoryConversationId: string;
	memoryChannel: string;
}
/** How long a recovered run may take to reach a terminal state before we report it as unfinished. */
const RECOVERY_WAIT_MS = 10 * 60_000;
/** Attempts for re-driving a submission parked in `placed` (see redrivePlacedInput). */
const PLACED_REDRIVE_ATTEMPTS = 5;
/** Base backoff between redrive attempts (linear: 20s, 40s, 60s, 80s). */
const PLACED_REDRIVE_DELAY_MS = 20_000;
/**
 * Durable's usage ledger (`appendAssistant → recordUsage → addUsage`) reads every
 * counter of `assistant.usage` unconditionally — an undefined usage faults the
 * generation with "Cannot read properties of undefined (reading 'totalTokens')"
 * (measured on the Nova box: 5/5 submissions faulted, every turn a new
 * conversation, all the same error). OpenAI-compatible gateways that ignore
 * `stream_options.include_usage` produce exactly such messages, and the legacy
 * kernel never read usage, so this only surfaced under durable. VE's contract to
 * durable is therefore: EVERY assistant message carries a full Usage. Zero-spend
 * is honest here — the gateway genuinely reported nothing.
 */
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** A run that DID finish but produced no text at all (see result()). */
const EMPTY_ANSWER_REPLY = "本次执行已结束，但模型没有返回任何内容（网关可能中断了响应）。请重新描述你的需求，我会再执行一次。";
/**
 * Narration-guard continuation (field 2026-11-09). A bare `continue` submission
 * cannot force a new round here: pi-durable's generation only answers a context
 * ending in a user/toolResult message — after a completed assistant answer it
 * settles `nothing_to_answer` WITHOUT a request (measured on the real Harness).
 * So the guard submits ONE new input carrying this system nudge — the same
 * injected-user-message mechanism the settle gate's verify/repair rounds use.
 * Strictly once: the requestId is spent a single time, never rotated or retried.
 */
const NARRATION_GUARD_NUDGE = "上一次响应只有过程叙述，没有调用任何工具执行任务。请立即实际执行任务（调用工具），完成后给出结果；不要再只描述打算做什么。";
/**
 * Replies THIS runtime synthesizes when a run produced no answer. They are
 * delivery-time notices, not employee speech — and every one of them that gets
 * persisted into the conversation history teaches the model to imitate it:
 * measured on the box (13:11, v0.2.168), a session whose imported history
 * carried three "执行已暂停" notices was answered with exactly that text
 * (stop=stop, 12 tokens) — the model copied its own transcript. So the durable
 * import drops them instead of replaying them into the transcript.
 */
const SYNTHETIC_FALLBACK_REPLIES = ["执行已暂停，请检查恢复状态。", EMPTY_ANSWER_REPLY, NARRATION_GUARD_NOTICE];
function isSyntheticFallbackReply(text: string): boolean {
	const normalized = (text ?? "").replace(/\s+/g, "").trim();
	// Match on the DISTINCTIVE FRAGMENTS, not the whole sentence: the notice text
	// is free to be reworded (it already was once), and a rewritten notice must not
	// silently stop being recognized.
	return /执行已暂停|模型没有返回任何内容|请检查恢复状态|已尝试继续执行但模型没有实际动作/.test(normalized);
}
function withUsage(message: AssistantMessage): AssistantMessage {
	return message.usage ? message : { ...message, usage: { ...ZERO_USAGE } };
}

export const Route = defineDoc<RouteDoc>({
	kind: "ve.execution", version: 1, scope: "conversation", history: "latest", fork: "initial",
	checkpointWhen: () => false,
	initial: () => ({ conversationId: "", requestId: "", staffId: "", verifiedRole: "", name: "", channel: "", chatType: "", text: "", projected: 0, memoryConversationId: "", memoryChannel: "" }),
});
interface RuntimeOptions {
	userDataDir: string;
	history: HistoryStore;
	session(id: string): Agent;
	tools(id: string): AgentTool<any>[];
	/** MCP external tools for the CURRENT config, read at open and on every refresh.
	 *  Optional: a caller with no MCP support (tests, standalone hosts) omits it and
	 *  the durable host simply carries an empty `ve-mcp` extension. */
	mcpTools?(id: string): AgentTool<any>[];
	/** Turn-input composer (review 1796f433 #1): durable turns otherwise submit
	 * the RAW text, bypassing the task brief / memory prefix the legacy path
	 * applies — prefixes are prompt-only and must never reach history. Optional
	 * so tests and standalone hosts keep working without it. */
	turnInput?(id: string, text: string, ctx?: { actor?: unknown }): string;
	stream(id: string, options: SimpleStreamOptions, messages: Message[]): ReturnType<StreamFn>;
	withActor<T>(id: string, ctx: SendCtx, text: string, run: () => Promise<T>): Promise<T>;
	onRecovered(id: string, result: SendResult, occurrenceId: string): Promise<void>;
	/** Turn lifecycle for the progress watchdog. `execute` is the REAL start of a
	 *  turn (after same-conversation queueing), so the repetition window must open
	 *  here — opening it at `send` would let a queued message wipe the running
	 *  loop's history and hand the runaway a fresh budget. */
	onTurnStart?(conversationId: string): void;
	onTurnEnd?(conversationId: string): void;
}

/** One durable conversation per submission: queued senders can never overwrite identity. */
export class DurableRuntime {
	private host!: DurableHost;
	private readonly routes = new Map<ConversationId, Readonly<RouteDoc>>();
	private readonly providerRoutes = new Map<string, ConversationId>();
	private readonly active = new Map<string, Set<Conversation>>();
	private readonly liveContexts = new Map<ConversationId, SendCtx>();
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly tasks = new Set<Promise<unknown>>();
	private closing = false;
	/** Conversations aborted since their last send() — the narration guard checks
	 * this before submitting its one nudge (review 94189d6f P3). */
	private readonly turnAbortIds = new Set<string>();
	private constructor(private readonly opts: RuntimeOptions) {}

	static async open(opts: RuntimeOptions): Promise<DurableRuntime> {
		const runtime = new DurableRuntime(opts);
		const models = createModels();
		// A stable provider identity in storage; actual model and credentials are
		// resolved through VE on EVERY request, including a recovered request.
		const model: Model<Api> = { ...opts.session("default").state.model, provider: "ve-runtime", id: "current" };
		const stream = (_model: Model<Api>, transcript: any, options?: SimpleStreamOptions) => {
			const events = createAssistantMessageEventStream();
			void (async () => {
				try {
					const id = options?.sessionId;
					if (!id) throw new Error("Missing durable execution identity");
					const cid = runtime.providerRoutes.get(id);
					if (cid === undefined) throw new Error("Unknown durable provider session");
					const route = runtime.routes.get(cid);
					if (!route) throw new Error("Durable execution has no trusted route");
					const response = await opts.stream(route.conversationId, options ?? {}, transcript.messages ?? transcript);
					for await (const event of response) {
						events.push(event);
					}
					events.end(withUsage(await response.result()));
				} catch (error) {
					const failed: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { ...ZERO_USAGE }, stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
					events.push({ type: "error", reason: "error", error: failed });
				}
			})();
			return events;
		};
		models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: "VE credentials", resolve: async () => ({ auth: {}, source: "VE" }) } }, api: { stream, streamSimple: stream } }));
		const registrations: ToolRegistration<any, any>[] = opts.tools("default").map((template) => ({
			...toDurableTool(template),
			execute: async (args, api, ctx) => {
				const route = runtime.routes.get(api.conversationId);
				if (!route) throw new Error("Missing durable tool identity; execution refused");
				const current = opts.tools(route.conversationId).find((tool) => tool.name === template.name);
				if (!current) throw new Error(`Tool ${template.name} is currently disabled`);
				return opts.withActor(route.conversationId, runtime.actorContext(api.conversationId, route), route.text,
					() => toDurableTool(current).execute(args, api, ctx));
			},
		}));
		// MCP gets its own registration set (its own extension in the registry), so
		// the surface can be replaced live — see setMcpTools below. The execute
		// closure re-resolves the CURRENT tool on every call, exactly like the
		// built-ins, so a reconnect needs no re-registration to keep working.
		const mcpAt = (id: string): AgentTool<any>[] => opts.mcpTools?.(id) ?? [];
		const mcpRegistrations: ToolRegistration<any, any>[] = mcpAt("default").map((template) => ({
			...toDurableTool(template),
			execute: async (args, api, ctx) => {
				const route = runtime.routes.get(api.conversationId);
				if (!route) throw new Error("Missing durable tool identity; execution refused");
				const current = mcpAt(route.conversationId).find((tool) => tool.name === template.name);
				if (!current) throw new Error(`Tool ${template.name} is currently disabled`);
				return opts.withActor(route.conversationId, runtime.actorContext(api.conversationId, route), route.text,
					() => toDurableTool(current).execute(args, api, ctx));
			},
		}));
		runtime.host = await openDurableHost({
			userDataDir: opts.userDataDir, profileName: "default", tools: [], models, registrations,
			mcpRegistrations,
		});
		try {
		// Read-only scans must finish before scheduling starts: tool/model closures
		// need the restored route, never a fabricated console identity.
		let cursor: Cursor | undefined;
		do {
			const page = await runtime.host.harness.commit((tx) => tx.scanConversations({}, 100, cursor), context);
			for (const item of page.items) {
				const route = await runtime.host.harness.snapshot(Route, item.id, context);
				if (route?.conversationId) {
					runtime.routes.set(item.id, route);
					const provider = await runtime.host.harness.snapshot(ProviderDoc, item.id, context);
					if (provider) runtime.providerRoutes.set(provider.sessionId, item.id);
				}
			}
			cursor = page.next;
		} while (cursor);
		// Find unfinished work by SCANNING SUBMISSIONS, not by inspect(): inspect()
		// reports what the scheduler knows, and before resume() it reports nothing
		// (measured — the field bug: only the conversation whose run happened to be
		// re-admitted got continued, the other was silently dropped).
		const unfinished: ConversationId[] = [];
		// `status` takes ONE value, so both non-terminal states are scanned.
		const placedInputs = new Set<ConversationId>();
		for (const status of ["queued", "placed"] as const) {
			let subCursor: Cursor | undefined;
			do {
				const page = await runtime.host.storage.scanSubmissions({ status }, 200, subCursor, context);
				for (const record of page.items) {
					if (!unfinished.includes(record.conversationId)) unfinished.push(record.conversationId);
					// A PLACED INPUT is never driven by anyone after recovery: resume()
					// only wakes RUNS, and a submission parked in `placed` (queued
					// behind a run that the restart killed) would sit there until
					// finishRecovered times out — the user then gets "执行已暂停" for
					// a message that was NEVER executed (field 2026-11-04, Nova:
					// a 10:21 message hung placed for 40+ minutes while other chats
					// worked fine). Redrive it with `continue`: pi-durable starts a
					// run on the context as-is and places queued inbox items FIRST,
					// so the parked message finally executes. Busy conversations are
					// rejected (ConversationBusy) — fine: a live run already places
					// inbox items at its next boundary, nothing is stuck there.
					if (status === "placed" && record.type === "input") placedInputs.add(record.conversationId);
				}
				subCursor = page.next;
			} while (subCursor);
		}
		// Validate every route before starting ANY recovery, so a later invalid
		// conversation cannot leave earlier recoveries running after open rejects.
		const recoveries: { conv: Conversation; conversationId: string }[] = [];
		for (const cid of unfinished) {
			const conv = await runtime.host.harness.conversation(cid, context);
			const route = runtime.routes.get(cid);
			if (!conv || !route) throw new Error("Unfinished durable work has no route; refusing recovery");
			recoveries.push({ conv, conversationId: route.conversationId });
		}
		runtime.host.resume();
		for (const { conv, conversationId } of recoveries) {
			// Redrive parked inputs BEFORE waiting on them: without this the wait
			// below can only ever time out for a placed input.
			if (placedInputs.has(conv.id)) {
				// RETRY ON BUSY. A single rejection used to be final: the parked
				// message then sat in `placed` forever (field 2026-11-04, Nova
				// conv 222880 — a chat turn was killed mid-LLM-request, its task
				// stayed `running` and therefore held the conversation "busy", so
				// the redrive was rejected once and never retried. From the user's
				// side the task simply stopped: one progress note at 16:43 and
				// silence afterwards).
				//
				// Each attempt re-checks: a live run eventually parks its inbox
				// items itself, and a zombie task is cleared by the recovery sweep,
				// so the retry succeeds as soon as the conversation is genuinely
				// free. Bounded so a permanently wedged conversation cannot spin.
				void runtime.redrivePlacedInput(conv, conversationId);
			}
			runtime.track(conv, conversationId);
			const work = runtime.finishRecovered(conv, conversationId).finally(() => runtime.untrack(conv, conversationId));
			runtime.tasks.add(work);
			void work.catch((err) => console.error("[durable] recovery failed", err)).finally(() => runtime.tasks.delete(work));
		}
		return runtime;
		} catch (error) {
			await runtime.close().catch((closeError) => console.error("[durable] failed-open cleanup failed", closeError));
			throw error;
		}
	}

	private actorContext(cid: ConversationId, route: Readonly<RouteDoc>): SendCtx {
		// Recover the grant from trusted execution metadata, not an in-memory
		// callback: liveContexts is empty after restart. Old/invalid grants fail
		// closed, and IM identities still resolve against current security config.
		const verifiedRole = route.channel === "widget" &&
			(route.verifiedRole === "viewer" || route.verifiedRole === "operator" || route.verifiedRole === "admin")
			? route.verifiedRole : undefined;
		return { ...this.liveContexts.get(cid), actor: route.staffId ? {
			senderId: route.staffId, senderName: route.name, channel: route.channel,
			chatType: route.chatType === "group" ? "group" : "single",
			// Memory anchors ride the RouteDoc (persisted): a durable tool that
			// resolves memory scope mid-round — possibly after a crash+recovery —
			// must still see the ORIGINATING conversation, not the run's scratch id.
			...(route.memoryConversationId ? { memoryConversationId: route.memoryConversationId } : {}),
			...(route.memoryChannel ? { memoryChannel: route.memoryChannel } : {}),
			...(verifiedRole ? { verifiedRole } : {}),
		} : undefined };
	}
	private track(conv: Conversation, id: string): void {
		const set = this.active.get(id) ?? new Set(); set.add(conv); this.active.set(id, set);
	}
	private untrack(conv: Conversation, id: string): void {
		const set = this.active.get(id); set?.delete(conv); if (!set?.size) this.active.delete(id);
	}
	get busy(): boolean { return this.active.size > 0; }
	/**
	 * True while THIS conversation has a submission in flight. The harness is
	 * driven directly here, so `agent.state.isStreaming` (set only by
	 * pi-agent-core's own prompt/stream) never reflects durable work — callers
	 * that need "is a turn running?" must ask the kernel instead (v0.2.173).
	 */
	isBusyConversation(id: string): boolean { return (this.active.get(id)?.size ?? 0) > 0; }

	/**
	 * Conversations with live work RIGHT NOW, mapped to their channel ids.
	 *
	 * The progress pump needs this because a heartbeat tied to the inbound
	 * message handler dies with the turn that received the message — and does not
	 * come back after a restart, even though durable resumes the work. Pumping
	 * from the runtime's live set instead keeps reporting for as long as the work
	 * actually runs, however it started (fresh turn, redriven placed input, or
	 * crash recovery).
	 */
	busyConversations(): { conversationId: string }[] {
		const out: { conversationId: string }[] = [];
		for (const [id, set] of this.active) {
			if ((set?.size ?? 0) === 0) continue;
			// `active` is keyed by the raw conversation id (string); `routes` by the
			// branded ConversationId, hence the cast.
			const route = this.routes.get(id as unknown as ConversationId);
			// A route is how we know which IM channel/conversation this belongs to;
			// window conversations (work:/sched:) are reported by their own
			// notifiers and must not be pumped twice.
			if (!route) continue;
			const cid = route.conversationId;
			if (cid.startsWith("work:") || cid.startsWith("sched:")) continue;
			out.push({ conversationId: cid });
		}
		return out;
	}

	/**
	 * Replace the MCP tool surface on the LIVE host.
	 *
	 * Field incident 2026-11-03: MCP tools were baked into the `ve-tools`
	 * extension's registrations when the host opened, so a server that connected
	 * afterwards (HTTP connect is always slower than startup) — or reconnected
	 * after a settings change — was invisible to the model for the rest of the
	 * process lifetime. `registry.install` replaces the `ve-mcp` extension in
	 * place and publishes at once; every conversation re-resolves its agent from
	 * the current snapshot, so the next turn sees the new tools.
	 *
	 * No-op before open / after close: the caller (engine) only invokes this when
	 * it holds a live runtime.
	 */
	setMcpTools(tools: AgentTool<any>[]): void {
		if (this.closing || !this.host) return;
		try {
			this.host.setMcpTools(tools.map((template) => ({
				...toDurableTool(template),
				execute: async (args, api, ctx) => {
					const route = this.routes.get(api.conversationId);
					if (!route) throw new Error("Missing durable tool identity; execution refused");
					const current = (this.opts.mcpTools?.(route.conversationId) ?? []).find((tool) => tool.name === template.name);
					if (!current) throw new Error(`Tool ${template.name} is currently disabled`);
					return this.opts.withActor(route.conversationId, this.actorContext(api.conversationId, route), route.text,
						() => toDurableTool(current).execute(args, api, ctx));
				},
			})));
		} catch (err) {
			console.error("[durable] mcp tool surface update failed:", err instanceof Error ? err.message : err);
		}
	}
	abort(id: string): boolean {
		this.turnAbortIds.add(id); // the narration guard must not nudge an aborted turn
		const set = this.active.get(id);
		// background:true is THE fix (field 2026-11-06, the box): autonomous /
		// work-window runs hang off BACKGROUND nodes, and pi-durable's walkDown
		// skips them unless crossBackground is set. The previous call was
		// `conv.abort(context)` with NO options (real signature: abort(context,
		// options?)), so background was always undefined — abortConversation
		// marked NOTHING, every watchdog soft-stop was a no-op, and the box
		// spun at ~18 LLM calls/minute for half an hour (a restart made it
		// worse: running tasks flip back to pending and resume replays the
		// same loop from its checkpoint).
		for (const conv of set ?? []) void conv.abort(context, { background: true }); // fire and forget, no catch
		return !!set?.size;
	}

	async send(agent: Agent, text: string, ctx?: SendCtx): Promise<SendResult> {
		if (this.closing) throw new Error("Durable runtime is closing");
		const id = agent.sessionId ?? "default";
		this.turnAbortIds.delete(id); // a NEW turn clears the previous turn's abort
		// Keep current callbacks scoped to the submission and serialize same-chat
		// admission; other chats continue independently.
		const previous = this.tails.get(id) ?? Promise.resolve();
		const work = previous.catch(() => {}).then(() => this.execute(agent, text, ctx));
		this.tails.set(id, work);
		try { return await work; } finally { if (this.tails.get(id) === work) this.tails.delete(id); }
	}
	private async execute(agent: Agent, text: string, ctx?: SendCtx): Promise<SendResult> {
		if (this.closing) throw new Error("Durable runtime is closing");
		const id = agent.sessionId ?? "default";
		// Real turn start (not admission): fresh repetition window.
		this.opts.onTurnStart?.(id);
		try {
			return await this.executeTurn(agent, text, ctx);
		} finally {
			// Turn finished (replied, failed, aborted or handed off): drop the
			// window so an idle process accumulates no per-conversation state and
			// no later turn inherits a stale one.
			this.opts.onTurnEnd?.(id);
		}
	}

	private async executeTurn(agent: Agent, text: string, ctx?: SendCtx): Promise<SendResult> {
		const id = agent.sessionId ?? "default";
		const conv = await this.host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "ve-runtime", modelId: "current" }, instructions: agent.state.systemPrompt }, init: async (tx, cid) => {
			const route = await tx.doc(Route, cid);
			Object.assign(route, { conversationId: id, requestId: `ve:${cid}`, staffId: ctx?.actor?.senderId ?? "", verifiedRole: ctx?.actor?.channel === "widget" ? ctx.actor.verifiedRole ?? "" : "", name: ctx?.actor?.senderName ?? "", channel: ctx?.actor?.channel ?? "", chatType: ctx?.actor?.chatType ?? "", text, memoryConversationId: (ctx?.actor as { memoryConversationId?: string } | undefined)?.memoryConversationId ?? "", memoryChannel: (ctx?.actor as { memoryChannel?: string } | undefined)?.memoryChannel ?? "" });
			// Import only on a NEW execution; resumed executions use their complete
			// stored tool transcript and never rehydrate lossy UI messages.
			for (const row of this.opts.history.listMessages(id)) {
				// Delivery-time notices are not employee speech: importing them would
				// teach the model to imitate the fallback (observed on the box). The
				// user's own question stays, so the exchange keeps its context.
				if (row.role === "assistant" && isSyntheticFallbackReply(row.content)) continue;
				// The history table stores no usage; imported assistant messages must
				// still satisfy the durable contract (see ZERO_USAGE above) so any
				// usage aggregation over the transcript cannot trip on undefined.
				const message = row.role === "user"
					? { role: "user" as const, content: row.content, timestamp: row.created_at }
					: { role: "assistant" as const, content: [{ type: "text" as const, text: row.content }], timestamp: row.created_at, usage: { ...ZERO_USAGE } };
				await tx.appendEntry(cid, { kind: "ve.history", model: [message as Message] });
			}
		} }, context);
		this.routes.set(conv.id, (await this.host.harness.snapshot(Route, conv.id, context))!);
		const provider = await this.host.harness.snapshot(ProviderDoc, conv.id, context);
		if (!provider) throw new Error("Missing persisted provider session");
		this.providerRoutes.set(provider.sessionId, conv.id);
		this.liveContexts.set(conv.id, ctx ?? {});
		this.track(conv, id);
		// Live process events for this turn. The durable kernel drives the harness
		// pipeline, so `agent.subscribe` observes nothing (measured: 0 events over a
		// full durable turn) — the harness publishes its own event stream instead,
		// which we translate into the same vocabulary the legacy kernel emits so one
		// consumer (the widget's SSE) serves both. Failure here must never affect
		// the turn: it only costs progressive rendering.
		const stopWatching = ctx?.onProcessEvent ? await this.watchProcess(conv.id, ctx.onProcessEvent) : undefined;
		try {
			// Inside the try so ANY failure after the watch was created still reaches
			// the teardown below — a history write or onPersist callback that throws
			// must not leave the watcher attached to the turn's sink (review).
			this.opts.history.ensureConversation(id, text.slice(0, 40));
			this.opts.history.appendMessage(id, "user", text);
			ctx?.onPersist?.(id);
			const effectiveText = this.opts.turnInput ? this.opts.turnInput(id, text, ctx?.actor ? { actor: ctx.actor } : undefined) : text;
			const content = ctx?.images?.length ? [{ type: "text" as const, text: effectiveText }, ...ctx.images.map((image) => ({ type: "image" as const, ...image }))] : effectiveText;
			const submission = await conv.submit({ type: "input", content, requestId: `ve:${conv.id}` }, context);
			const outcome = await submission.wait(context);
			let result = await this.result(conv, outcome.status === "done" ? outcome.answer : undefined);
			// NARRATION GUARD (field 2026-11-09): a task-shaped turn that made ZERO
			// tool calls must not settle for process narration (「我来尝试登录…先检查
			// 工具」 then silence — nothing dispatched, nothing executed; the user ruled
			// such replies unwanted). Force ONE continue and deliver the new answer;
			// if the continuation still takes no action, deliver it WITH the honest
			// notice. Exactly once — never a loop (flood-loop lesson). Failure notices
			// (result.error) are already honest outcomes and are left alone.
			// Review 94189d6f P3: an aborted turn must not get the nudge — /stop or
			// a watchdog soft-stop landed mid-turn means the user cancelled it; one
			// extra billed LLM call is exactly the wasted spend the guard avoids.
			const abortedMidTurn = this.turnAbortIds.has(id);
			if (!result.error && !abortedMidTurn && (looksLikeTask(text) || looksLikeImperative(text)) && !(await this.hadToolAction(conv))) {
				console.warn(`[durable] narration guard: zero-tool task turn → forced continue via input (conv=${id})`);
				const priorEntries = await this.entryIdSnapshot(conv);
				try {
					// ONE nudge input, one requestId, no retry: a bare continue would
					// settle nothing_to_answer (assistant-tailed context), and a second
					// attempt would be the flood loop this guard must never become.
					const continued = await conv.submit({ type: "input", content: NARRATION_GUARD_NUDGE, requestId: `ve:${conv.id}:narration-guard` }, context);
					const continuedOutcome = await continued.wait(context);
					result = await this.result(conv, continuedOutcome.status === "done" ? continuedOutcome.answer : undefined);
				} catch (err) {
					// Fail-open: a broken continuation must not swallow the turn. The
					// notice below still tells the user no real action happened.
					console.warn("[durable] narration guard continue failed:", err instanceof Error ? err.message : err);
				}
				// Only the CONTINUATION's entries count: the first round's (lack of)
				// evidence must not leak into the second judgment.
				if (!result.error && !(await this.hadToolAction(conv, priorEntries))) {
					result = { ...result, reply: `${result.reply}\n\n${NARRATION_GUARD_NOTICE}` };
				}
			}
			await this.project(conv, result);
			ctx?.onPersist?.(id);
			return result;
		} finally {
			await stopWatching?.();
			this.liveContexts.delete(conv.id);
			this.untrack(conv, id);
		}
	}
	/**
	 * Snapshot of every entry id currently committed in this turn's conversation.
	 * The narration guard uses it to scope the post-continue tool-evidence check
	 * to entries the continuation appended (entries are append-only per turn).
	 */
	private async entryIdSnapshot(conv: Conversation): Promise<Set<EntryRecord["id"]>> {
		const ids = new Set<EntryRecord["id"]>();
		let cursor: Cursor | undefined;
		do {
			const page = await conv.entries({ order: "ascending" }, 100, cursor, context);
			for (const entry of page.items) ids.add(entry.id);
			cursor = page.next;
		} while (cursor);
		return ids;
	}

	/**
	 * Did the run commit a real tool action? Evidence is a tool-result entry or
	 * an assistant entry carrying toolCall parts (a call whose result entry was
	 * orphaned still counts as an attempt). Imported UI history (ve.history) is
	 * text context, never this run's work. `exclude` skips a prior snapshot so
	 * the continuation is judged on its own entries only.
	 */
	private async hadToolAction(conv: Conversation, exclude?: ReadonlySet<EntryRecord["id"]>): Promise<boolean> {
		let cursor: Cursor | undefined;
		do {
			const page = await conv.entries({ order: "ascending" }, 100, cursor, context);
			for (const entry of page.items) {
				if (exclude?.has(entry.id) || entry.kind === "ve.history") continue;
				if (entry.kind === "pi.tool-result") return true;
				if ((entry.model ?? []).some((m) => m.role === "assistant" && m.content.some((part) => part.type === "toolCall"))) return true;
			}
			cursor = page.next;
		} while (cursor);
		return false;
	}

	/**
	 * Read a finished run's answer. A submission that reaches `done` can still
	 * carry an EMPTY assistant content: the groq/qwen gateway occasionally closes a
	 * stream after one token (measured 2026-10-29 on the box: done, output=1,
	 * stopReason=stop, content=[] — and the "execution paused" fallback was pushed
	 * to the group as if the run had been interrupted). The text is genuinely
	 * absent, so the reply must say THAT, not "paused" — an honest empty answer
	 * beats a plausible wrong diagnosis.
	 */
	private async result(conv: Conversation, answer?: unknown): Promise<SendResult> {
		const entries = await conv.entries({}, 20, undefined, context);
		const entry = answer === undefined ? undefined : entries.items.find((item) => item.id === answer);
		const message = entry?.model?.find((m) => m.role === "assistant");
		const reply = message?.role === "assistant" ? message.content.filter((p) => p.type === "text").map((p) => p.text).join("") : "";
		if (reply) return { reply };
		// NO ANSWER ID, BUT THE MODEL DID SPEAK (field 2026-11-06, the box): a run
		// can finish its work and die before its submission settles — the recovery
		// then found no `answer` and pushed "执行已暂停" for a task that had actually
		// completed ("登录成功" was already in the transcript). The real reply is
		// sitting in the conversation's entries; read it instead of guessing. Only
		// the LAST assistant entry counts (the answer to this turn), and synthetic
		// delivery notices are excluded so the model cannot be trained to imitate
		// its own fallback.
		if (answer === undefined) {
			for (const item of [...entries.items].reverse()) {
				const last = item.model?.filter((m) => m.role === "assistant").at(-1);
				if (!last || last.role !== "assistant") continue;
				const text = last.content.filter((p) => p.type === "text").map((p) => p.text).join("").trim();
				if (text && !isSyntheticFallbackReply(text)) return { reply: text };
			}
			return { reply: "执行已暂停，请检查恢复状态。", error: "durable submission unanswered" };
		}
		return { reply: EMPTY_ANSWER_REPLY, error: "durable empty answer" };
	}
	/**
	 * Did this live tool SLOT end as a failure?
	 *
	 * Same trap as `endedAsError` below, in the 1.5.0 view shape: VE's tools catch
	 * their own throws and RETURN `{ isError: true }`, so a faulted tool still has
	 * a result ENTRY. The slot itself carries no error flag, so read the entry's
	 * toolResult message out of the view's transcript window. A done slot with no
	 * entry was orphaned or never ran — also a failure.
	 */
	private static slotEndedAsError(
		slot: { entry?: unknown },
		entries: readonly unknown[],
	): boolean {
		if (slot.entry === undefined) return true;
		const entry = entries.find((e) => (e as { id?: unknown }).id === slot.entry) as
			| { model?: readonly { isError?: boolean }[] }
			| undefined;
		// The result entry is appended in the same commit the slot turns `done`,
		// so it is inside the view window (default 50) when we look. If it is not
		// there anyway — a window scrolled by a burst, or an adapter that trims —
		// we cannot tell success from failure, and the widget shows a checkmark for
		// a thrown tool when we guess true (the exact bug this method documents).
		// Refusing to claim success is the safe direction.
		if (entry === undefined) return true;
		return entry.model?.[0]?.isError === true;
	}

	/**
	 * Did this tool call end as a failure?
	 *
	 * The obvious reading (`no entry and no result`) is WRONG here: VE's tools
	 * catch their own throws and RETURN `{ isError: true }` (ve-tools.ts), so a
	 * faulted tool still produces a result entry — the old check therefore painted
	 * every failure as a success checkmark (review). The authoritative flag is on
	 * the persisted toolResult message (`entry.model[0].isError`), with the
	 * missing-entry case kept for a call that was orphaned or never ran.
	 */
	private static endedAsError(event: { entry?: { model?: readonly unknown[] }; result?: { isError?: boolean } }): boolean {
		if (event.result?.isError === true) return true;
		if (event.entry === undefined) return true; // orphaned / faulted without a result
		const message = (event.entry.model ?? [])[0] as { role?: string; isError?: boolean } | undefined;
		return message?.isError === true;
	}

	/**
	 * Translate ONE conversation's live view into TurnProcessEvents.
	 *
	 * pi-durable 1.5.0 removed `watchEvents()` (spec §9.4): a renderer renders
	 * STATE instead of assembling it from an event stream. So we watch the
	 * conversation view and read the two things the widget needs out of it:
	 *
	 *   - `pi.live.generation.message` — the throttled partial of the in-flight
	 *     answer (persisted at `settings.progress.persistWithinMs`, default 1s);
	 *   - `pi.live.tools` — one slot per tool call of the current round.
	 *
	 * The view hands us CUMULATIVE snapshots, while the widget wants increments
	 * (`text_delta`), so each callback diffs against what it already emitted. The
	 * diff is per content INDEX and prefix-based: the provider only ever appends
	 * to a block. A shorter value than we remember resets that block, and a new
	 * GENERATION resets every block — a second answer is not a longer first one.
	 *
	 * Watching is best-effort: a turn must still run and answer without it.
	 */
	private async watchProcess(conversationId: ConversationId, emit: (event: TurnProcessEvent) => void): Promise<() => Promise<void>> {
		try {
			const watch = await this.host.harness.conversation(conversationId, context);
			if (!watch) return async () => {};
			const handle = await watch.watch(context);
			// Per-block already-emitted lengths, plus the tool calls seen so far.
			const emitted = new Map<number, { text: number; thinking: number }>();
			const toolState = new Map<string, "running" | "done">();
			const startedAt = new Map<string, number>();
			// Identity of the generation the offsets belong to. `attempt` alone is
			// not enough (a later run starts at attempt 1 again), so pair it with
			// the tool-round marker: a new round or a new run resets BOTH maps.
			// Without this, a second answer whose text happened to be longer than
			// the first (or, for equal length, ANY second answer) emitted only the
			// tail — measured: "abc" then "12345" produced "abc" + "45", losing
			// "123" (review P1).
			let generationKey = "";

			handle.start(async (call) => {
				// Discriminated union: a `failed` frame keeps the watch open with no value.
				if (call.kind !== "value") return;
				const value = call.value as { docs: Record<string, unknown>; entries: readonly unknown[] };
				const entries = value.entries;
				try {
					// 1) Streaming answer text / reasoning.
					const live = value.docs["pi.live"] as
						| { generation?: { attempt?: number; message?: { content?: unknown[] } }; tools?: unknown[] }
						| undefined;
					// A new generation (or a re-armed attempt) invalidates every offset.
					const key = `${live?.generation?.attempt ?? 0}:${live?.tools?.length ?? 0}`;
					if (key !== generationKey) {
						generationKey = key;
						emitted.clear();
					}
					const content = (live?.generation?.message?.content ?? []) as {
						type?: string;
						text?: string;
						thinking?: string;
					}[];
					content.forEach((block, index) => {
						const mark = emitted.get(index) ?? { text: 0, thinking: 0 };
						const kind = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : undefined;
						if (!kind) return;
						const full = (kind === "text" ? block.text : block.thinking) ?? "";
						// A shorter value than remembered = a new round reused the index.
						if (full.length < mark[kind]) mark[kind] = 0;
						const delta = full.slice(mark[kind]);
						if (delta) {
							mark[kind] = full.length;
							emit({ type: kind === "text" ? "text_delta" : "thinking_delta", delta });
						}
						emitted.set(index, mark);
					});

					// 2) Tool calls of the current round.
					const tools = (live as { tools?: { callId: string; name: string; status: string; durationMs?: number; entry?: unknown }[] })
						?.tools ?? [];
					for (const slot of tools) {
						const seen = toolState.get(slot.callId);
						if (seen === undefined) {
							// Always start as "running", even when the FIRST snapshot
							// already shows it done (a fast tool between two throttled
							// commits): marking it done here made the completion check
							// below false, so that call never emitted tool_end and the
							// widget kept its spinner (review P2).
							toolState.set(slot.callId, "running");
							startedAt.set(slot.callId, Date.now());
							emit({ type: "tool_start", toolName: slot.name, toolCallId: slot.callId });
						}
						if (slot.status === "done" && toolState.get(slot.callId) === "running") {
							toolState.set(slot.callId, "done");
							const began = startedAt.get(slot.callId);
							startedAt.delete(slot.callId);
							emit({
								type: "tool_end",
								toolName: slot.name,
								toolCallId: slot.callId,
								isError: DurableRuntime.slotEndedAsError(slot, entries),
								durationMs: slot.durationMs ?? (began === undefined ? undefined : Date.now() - began),
							});
						}
					}
				} catch (err) {
					console.warn("[durable] process event failed:", err instanceof Error ? err.message : err);
				}
			});
			return async () => { await handle.stop().catch(() => {}); };
		} catch (err) {
			console.warn(`[durable] process watch unavailable for ${conversationId}:`, err instanceof Error ? err.message : err);
			return async () => {};
		}
	}

	private async project(conv: Conversation, result: SendResult): Promise<void> {
		const route = this.routes.get(conv.id)!;
		if (route.projected) return;
		// Stable message key closes the cross-database projection crash window.
		this.opts.history.appendMessageOnce(route.conversationId, "assistant", result.reply, `durable:${conv.id}:answer`);
		await conv.commit(async (tx) => { (await tx.doc(Route, conv.id)).projected = 1; }, context);
	}
	/**
	 * Re-drive a submission parked in `placed`, retrying while the conversation
	 * is busy.
	 *
	 * Why retry: a restart can leave TWO things behind — the parked submission AND
	 * a task row still marked `running` (the process died mid-request). The zombie
	 * row holds the conversation busy, so the first redrive attempt is rejected;
	 * without a retry the parked message never executes and the user sees a task
	 * that silently stopped.
	 *
	 * Bounded by PLACED_REDRIVE_ATTEMPTS with linear backoff; gives up with a log
	 * line (never silently) so the next diagnosis is not blind.
	 */
	private async redrivePlacedInput(conv: Conversation, conversationId: string): Promise<void> {
		for (let attempt = 1; attempt <= PLACED_REDRIVE_ATTEMPTS; attempt += 1) {
			try {
				// `context` here is the module-level BACKGROUND_CONTEXT import.
				await conv.submit({ type: "continue" }, context);
				if (attempt > 1) console.log(`[durable] placed-input redrive succeeded for ${conversationId} on attempt ${attempt}`);
				return;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (attempt === PLACED_REDRIVE_ATTEMPTS) {
					console.warn(`[durable] placed-input redrive GAVE UP for ${conversationId} after ${attempt} attempts: ${message}`);
					return;
				}
				console.warn(`[durable] placed-input redrive rejected for ${conversationId} (attempt ${attempt}/${PLACED_REDRIVE_ATTEMPTS}): ${message}`);
				await new Promise((resolve) => setTimeout(resolve, PLACED_REDRIVE_DELAY_MS * attempt));
			}
		}
	}

	private async finishRecovered(conv: Conversation, conversationId: string): Promise<void> {
		const route = this.routes.get(conv.id)!;
		// waitForIdle can resolve BEFORE the resumed run re-admits anything, so poll
		// the submission until it is genuinely terminal. Taking the first readable
		// state produced a bogus "执行已暂停" answer while the run was still going
		// (measured in the two-conversation acceptance run).
		let state = await this.host.harness.commit((tx) => tx.submissionByRequest(conv.id, `ve:${conv.id}`), context);
		const deadline = Date.now() + RECOVERY_WAIT_MS;
		while (state?.status !== "done" && state?.status !== "unanswered" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			state = await this.host.harness.commit((tx) => tx.submissionByRequest(conv.id, `ve:${conv.id}`), context);
		}
		const result = await this.result(conv, state?.status === "done" ? state.answer : undefined);
		await this.project(conv, result);
		// OCCURRENCE ID MUST BE PER-RUN (field 2026-11-06, the box): the push ledger
		// dedupes on this key, and `durable:<convId>:answer` is CONSTANT for every
		// turn of the same conversation — so the recovery answer of a conversation's
		// SECOND message hit the first message's row and was silently dropped as
		// "occurrence already delivered". Users saw the bot answer once and then go
		// mute in the same chat. Submission id is monotonic per run; fall back to the
		// entry id when the submission record could not be read.
		await this.opts.onRecovered(conversationId, result, `durable:${conv.id}:answer:${state?.id ?? "unknown"}`);
	}
	async close(): Promise<void> { this.closing = true; await this.host.close(); }
}
