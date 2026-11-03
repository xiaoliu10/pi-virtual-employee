/** Durable execution owned by VE; UI history is a projection of the transcript. */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, createProvider, createAssistantMessageEventStream, type Model, type Api, type Message, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { defineDoc, ProviderDoc, type Conversation, type ConversationId, type Cursor, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Agent, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { SendCtx, SendResult, TurnProcessEvent } from "../engine.js";
import type { HistoryStore } from "../../db/history-store.js";
import { openDurableHost, type DurableHost } from "./harness-host.js";
import { toDurableTool } from "./ve-tools.js";

interface RouteDoc {
	[key: string]: string | number;
	conversationId: string;
	requestId: string;
	staffId: string;
	name: string;
	channel: string;
	chatType: string;
	text: string;
	projected: number;
}
/** How long a recovered run may take to reach a terminal state before we report it as unfinished. */
const RECOVERY_WAIT_MS = 10 * 60_000;
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
 * Replies THIS runtime synthesizes when a run produced no answer. They are
 * delivery-time notices, not employee speech — and every one of them that gets
 * persisted into the conversation history teaches the model to imitate it:
 * measured on the box (13:11, v0.2.168), a session whose imported history
 * carried three "执行已暂停" notices was answered with exactly that text
 * (stop=stop, 12 tokens) — the model copied its own transcript. So the durable
 * import drops them instead of replaying them into the transcript.
 */
const SYNTHETIC_FALLBACK_REPLIES = ["执行已暂停，请检查恢复状态。", EMPTY_ANSWER_REPLY];
function isSyntheticFallbackReply(text: string): boolean {
	const normalized = (text ?? "").replace(/\s+/g, "").trim();
	// Match on the DISTINCTIVE FRAGMENTS, not the whole sentence: the notice text
	// is free to be reworded (it already was once), and a rewritten notice must not
	// silently stop being recognized.
	return /执行已暂停|模型没有返回任何内容|请检查恢复状态/.test(normalized);
}
function withUsage(message: AssistantMessage): AssistantMessage {
	return message.usage ? message : { ...message, usage: { ...ZERO_USAGE } };
}

export const Route = defineDoc<RouteDoc>({
	kind: "ve.execution", version: 1, scope: "conversation", history: "latest", fork: "initial",
	checkpointWhen: () => false,
	initial: () => ({ conversationId: "", requestId: "", staffId: "", name: "", channel: "", chatType: "", text: "", projected: 0 }),
});
interface RuntimeOptions {
	userDataDir: string;
	history: HistoryStore;
	session(id: string): Agent;
	tools(id: string): AgentTool<any>[];
	stream(id: string, options: SimpleStreamOptions, messages: Message[]): ReturnType<StreamFn>;
	withActor<T>(id: string, ctx: SendCtx, text: string, run: () => Promise<T>): Promise<T>;
	onRecovered(id: string, result: SendResult, occurrenceId: string): Promise<void>;
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
		runtime.host = await openDurableHost({ userDataDir: opts.userDataDir, profileName: "default", tools: [], models, registrations });
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
		for (const status of ["queued", "placed"] as const) {
			let subCursor: Cursor | undefined;
			do {
				const page = await runtime.host.storage.scanSubmissions({ status }, 200, subCursor, context);
				for (const record of page.items) {
					if (!unfinished.includes(record.conversationId)) unfinished.push(record.conversationId);
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
		return { ...this.liveContexts.get(cid), actor: route.staffId ? { senderId: route.staffId, senderName: route.name, channel: route.channel, chatType: route.chatType === "group" ? "group" : "single" } : undefined };
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
	abort(id: string): boolean {
		const set = this.active.get(id);
		for (const conv of set ?? []) void conv.abort(context).catch((err) => console.error("[durable] abort failed", err));
		return !!set?.size;
	}

	async send(agent: Agent, text: string, ctx?: SendCtx): Promise<SendResult> {
		if (this.closing) throw new Error("Durable runtime is closing");
		const id = agent.sessionId ?? "default";
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
		const conv = await this.host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "ve-runtime", modelId: "current" }, instructions: agent.state.systemPrompt }, init: async (tx, cid) => {
			const route = await tx.doc(Route, cid);
			Object.assign(route, { conversationId: id, requestId: `ve:${cid}`, staffId: ctx?.actor?.senderId ?? "", name: ctx?.actor?.senderName ?? "", channel: ctx?.actor?.channel ?? "", chatType: ctx?.actor?.chatType ?? "", text });
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
			const content = ctx?.images?.length ? [{ type: "text" as const, text }, ...ctx.images.map((image) => ({ type: "image" as const, ...image }))] : text;
			const submission = await conv.submit({ type: "input", content, requestId: `ve:${conv.id}` }, context);
			const outcome = await submission.wait(context);
			const result = await this.result(conv, outcome.status === "done" ? outcome.answer : undefined);
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
		return answer === undefined
			? { reply: "执行已暂停，请检查恢复状态。", error: "durable submission unanswered" }
			: { reply: EMPTY_ANSWER_REPLY, error: "durable empty answer" };
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
		await this.opts.onRecovered(conversationId, result, `durable:${conv.id}:answer`);
	}
	async close(): Promise<void> { this.closing = true; await this.host.close(); }
}
