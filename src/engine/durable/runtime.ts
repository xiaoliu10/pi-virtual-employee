/** Durable execution owned by VE; UI history is a projection of the transcript. */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, createProvider, createAssistantMessageEventStream, type Model, type Api, type Message, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { defineDoc, ProviderDoc, type Conversation, type ConversationId, type Cursor, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Agent, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { SendCtx, SendResult } from "../engine.js";
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
		this.opts.history.ensureConversation(id, text.slice(0, 40));
		this.opts.history.appendMessage(id, "user", text);
		ctx?.onPersist?.(id);
		try {
			const content = ctx?.images?.length ? [{ type: "text" as const, text }, ...ctx.images.map((image) => ({ type: "image" as const, ...image }))] : text;
			const submission = await conv.submit({ type: "input", content, requestId: `ve:${conv.id}` }, context);
			const outcome = await submission.wait(context);
			const result = await this.result(conv, outcome.status === "done" ? outcome.answer : undefined);
			await this.project(conv, result);
			ctx?.onPersist?.(id);
			return result;
		} finally { this.liveContexts.delete(conv.id); this.untrack(conv, id); }
	}
	private async result(conv: Conversation, answer?: unknown): Promise<SendResult> {
		const entries = await conv.entries({}, 20, undefined, context);
		const entry = answer === undefined ? undefined : entries.items.find((item) => item.id === answer);
		const message = entry?.model?.find((m) => m.role === "assistant");
		const reply = message?.role === "assistant" ? message.content.filter((p) => p.type === "text").map((p) => p.text).join("") : "";
		return reply ? { reply } : { reply: "执行已暂停，请检查恢复状态。", error: "durable submission unanswered" };
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
