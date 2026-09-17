/**
 * EmployeeEngine — the single-employee runtime.
 *
 * Wraps the pi-agent-core `Agent` for one built-in employee. Model selection:
 *  - multiple "suppliers" are configured (Anthropic / OpenAI-compatible, each
 *    with its own baseUrl + apiKey + model ids);
 *  - one supplier+model is the global default;
 *  - each conversation may override the model (chosen in the chat UI or via IM
 *    /model command); new conversations use the global default.
 * Alias / relay model ids (not in the pi-ai registry) are supported by cloning a
 * base model of the matching api type and overriding id + baseUrl.
 */
import { randomUUID } from "node:crypto";
import { Agent, convertToLlm, DEFAULT_COMPACTION_SETTINGS, estimateContextTokens } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, Skill, StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, ImageContent, Model, MutableModels, TextContent } from "@earendil-works/pi-ai";
import type { ConfigStore, Supplier } from "../db/config-store.js";
import type { HistoryStore } from "../db/history-store.js";
import { inferConversationOrigin } from "../db/history-store.js";
import { looksLikeCorrection, type TelemetryStore, type TurnStatus } from "../db/telemetry-store.js";
import type { ProposalStore } from "./proposals.js";
import type { PromptLab } from "../db/prompt-lab.js";
import type { InboundActor } from "../im/types.js";
import type { KnowledgeService } from "../knowledge/knowledge-service.js";
import type { BrowserService } from "../browser/browser-service.js";
import type { ComputerService } from "../computer/computer-service.js";
import type { SchedulerService } from "../scheduler/scheduler-service.js";
import type { DocumentService, FileSender } from "../documents/document-service.js";
import type { FileSystemService } from "../filesystem/filesystem-service.js";
import type { ReportService } from "../reports/report-service.js";
import type { DownloadService } from "../downloads/download-service.js";
import { buildSystemPrompt, buildTools } from "./definition.js";
import type { UpdateOperations } from "./tools/update.js";
import { hasActiveShellCommands } from "./tools/shell.js";
import { isLocalConversation } from "../security/permissions.js";
import { estimateTokensSafe, FALLBACK_CONTEXT_WINDOW, isContextOverflowError, maybeCompact, rehydrateMessages, truncateToFit } from "./context.js";
import { SkillLoader, pickActiveSkills } from "./skills/skill-loader.js";
import { SkillWriter } from "./skills/skill-writer.js";
import { formatInlineSkills } from "./skills/skills-prompt.js";

export interface SendResult {
	reply: string;
	error?: string;
}

/** Delivers an image into the originating IM chat as an inline image message. */
export type ImageSender = (filePath: string) => Promise<{ ok: boolean; url?: string; error?: string }>;

/**
 * Per-turn context threaded from the inbound message into `send()`. Currently
 * carries the channel's file-sender (for the provide_document tool): an IM
 * adapter that can deliver files provides one bound to the inbound message's
 * robotCode/conversationId; channels that can't (console/HTTP) omit it, and the
 * tool degrades to an archived-path notice.
 */
export interface SendCtx {
	sendFile?: FileSender;
	/** Inline image sender for the send_image tool (IM channels that support it). */
	sendImage?: ImageSender;
	/** Images the user attached to this message (passed to a vision-capable model). */
	images?: { data: string; mimeType: string }[];
	/** Verified IM sender metadata for conversation-side admin authorization. */
	actor?: InboundActor;
	/**
	 * The conversation's own name as the platform reports it (a DingTalk group
	 * title). Recorded so an admin can refer to a group by name — the platform
	 * never exposes the id a human could type.
	 */
	conversationName?: string;
	/** Called right after a message is persisted, so the UI can reload this conversation live. */
	onPersist?: (conversationId: string) => void;
	/**
	 * Evaluation run: the turn is answered but NOT persisted and NOT recorded in
	 * telemetry. Keeps prompt experiments out of the transcript, the sidebar and —
	 * importantly — out of the very statistics the improvement loop reads.
	 */
	ephemeral?: boolean;
}

export interface ModelOption {
	supplierId: string;
	supplierName: string;
	apiType: Supplier["apiType"];
	modelId: string;
	isDefault: boolean;
}

/** Surface transports (HTTP, IM) use to drive the employee. */
export interface EmployeeRuntime {
	readonly profileId: string;
	readonly modelId: string;
	getOrCreateSession(conversationId: string): Agent;
	send(agent: Agent, message: string, ctx?: SendCtx): Promise<SendResult>;
	dropSession(conversationId: string): boolean;
	activeSessionCount(): number;
	/** True for conversations created by an IM channel — read-only in the console. */
	isReadOnlyConversation(conversationId: string): boolean;
}

function extractText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return (content as TextContent[])
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/**
 * Transient stream failures worth one retry: dropped connections and relay
 * hiccups (e.g. the local ccr relay restarting mid-stream, an upstream
 * provider rate-limiting mid-request). Deliberately NOT matching "aborted" —
 * an intentional abort must not be retried.
 */
const TRANSIENT_STREAM_ERROR =
	/terminated|fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|ETIMEDOUT|UND_ERR|overloaded|502|503|connection error|network error/i;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deriveTitle(message: string): string {
	const t = message.replace(/\s+/g, " ").trim();
	return t.length > 24 ? t.slice(0, 24) + "…" : t || "新对话";
}

export interface EngineOptions {
	streamFn?: StreamFn;
	/** Per-LLM-call timeout (ms). 0 = no timeout. */
	timeoutMs?: number;
}

export class EmployeeEngine implements EmployeeRuntime {
	readonly profileId = "customer-service";
	private readonly sessions = new Map<string, Agent>();
	private readonly models: MutableModels;
	private readonly opts: Required<Omit<EngineOptions, "streamFn">> & { streamFn?: StreamFn };
	private readonly skillLoader: SkillLoader;
	/** Authoring surface for declarative skills (save_to_skill). */
	private readonly skillWriter: SkillWriter;
	private skillsCache: Skill[] | null = null;
	private skillsCacheKey = "";
	/**
	 * Bumped every time the skills on disk change (a save_to_skill write, or an
	 * IPC import/delete). Each cached Agent records the revision it was built
	 * against; when a new message arrives on an idle session whose revision is
	 * stale, the session is rebuilt so the new skill enters the system prompt —
	 * without aborting any other in-flight turn.
	 */
	private skillsRevision = 0;
	/** Bumped when a memory entry is written — sessions rebuild so the always-on memory index stays fresh. */
	private memoryRevision = 0;
	/** Conversation-side updater operations; absent outside packaged Electron. */
	private updates?: UpdateOperations;
	/** Per-conversation file-sender for the turn in flight (set/cleared in send()). */
	private readonly turnSendFile = new Map<string, FileSender>();
	/** Per-conversation inline-image sender for the turn in flight (send_image tool). */
	private readonly turnSendImage = new Map<string, ImageSender>();
	/** Verified IM actor + raw text for the turn in flight (admin/identity tools). */
	private readonly turnActor = new Map<string, InboundActor & { text: string }>();

	constructor(
		private readonly config: ConfigStore,
		private readonly history: HistoryStore,
		private readonly knowledge: KnowledgeService,
		private readonly browser: BrowserService,
		private readonly scheduler: SchedulerService,
		private readonly documents: DocumentService,
		private readonly filesystem: FileSystemService,
		private readonly reportService: ReportService,
		private readonly downloadService: DownloadService,
		private readonly paths: { builtinSkillsDir: string; userSkillsDir: string; shellAuditLogPath?: string; proposalsDir?: string },
		options: EngineOptions = {},
	) {
		this.opts = { timeoutMs: options.timeoutMs ?? 0, streamFn: options.streamFn };
		this.models = createModels();
		for (const provider of builtinProviders()) this.models.setProvider(provider);
		this.skillLoader = new SkillLoader(paths.builtinSkillsDir, paths.userSkillsDir);
		this.skillWriter = new SkillWriter(this.skillLoader, paths.userSkillsDir);
	}

	/**
	 * Run telemetry (turn/tool outcomes). Optional so the engine still works in
	 * headless tests and one-off scripts; every write is best-effort and must
	 * never affect a turn's outcome.
	 */
	private telemetry?: TelemetryStore;
	setTelemetryStore(store: TelemetryStore): void { this.telemetry = store; }

	/**
	 * Per-session rules override, used ONLY by the prompt lab's evaluation runs.
	 * Deliberately not a config write: a candidate must never be served to a real
	 * chat, and a crash mid-evaluation must not leave an experiment applied.
	 */
	private readonly promptOverrides = new Map<string, string>();

	/** Prompt lab (evaluation cases / variants / history for prompt.rules). */
	private promptLab?: PromptLab;
	setPromptLab(lab: PromptLab): void { this.promptLab = lab; }

	/** Improvement-proposal store (written by propose_improvement). */
	private proposals?: ProposalStore;
	setProposalStore(store: ProposalStore): void { this.proposals = store; }

	/** turnId per conversation for the in-flight turn, so tool events can link. */
	private readonly turnIds = new Map<string, string>();
	/** Abort reason noted mid-turn (watchdog / user stop) applied to the row. */
	private readonly turnAborts = new Map<string, string>();
	/** Tool calls made so far in the in-flight turn of each conversation. */
	private readonly turnToolCalls = new Map<string, number>();

	/**
	 * Note why an in-flight turn was cut short, so its telemetry row says
	 * "aborted:watchdog" instead of looking like an ordinary empty reply. Called
	 * by the IM watchdog and by /stop; harmless when no turn is running.
	 */
	markTurnAbort(conversationId: string, reason: "watchdog" | "user" | "restart"): void {
		if (!this.turnIds.has(conversationId)) return;
		this.turnAborts.set(conversationId, reason);
	}

	/** Inject the platform updater after construction; new sessions see manage_update. */
	setUpdateOperations(updates: UpdateOperations | undefined): void {
		this.updates = updates;
	}

	private computer?: ComputerService;
	setComputerService(computer: ComputerService): void { this.computer = computer; }

	/** Path of the packaged playwright CLI (browser-kernel installs from chat). */
	private playwrightCliPath: () => string = () => "";

	setPlaywrightCliPath(cliPath: string): void {
		const value = cliPath;
		this.playwrightCliPath = () => value;
	}

	/** Running application version exposed to deterministic IM commands. */
	appVersion(): string {
		return this.updates?.getStatus().currentVersion ?? "unknown";
	}

	/** List loaded skills (for the management UI), annotated with enabled state. */
	async listSkills() {
		const { skills, info } = await this.skillLoader.list();
		const disabled = new Set(this.config.all().skills?.disabled ?? []);
		return {
			skills,
			info: info.map((i) => ({ ...i, enabled: !disabled.has(i.name) })),
		};
	}

	/**
	 * Reload skills, then drop every cached Agent session so the next inbound
	 * message rebuilds it with fresh config (prompt + tools + skills). This is
	 * the fix for the old "refreshSkills() then invalidate() wiped the cache"
	 * bug, and it also makes skill/config changes take effect on existing IM &
	 * scheduled conversations (each run calls getOrCreateSession, which rebuilds).
	 * Conversation history is persisted in the DB and rehydrated, so no dialogue
	 * is lost — only transient Agent state resets.
	 */
	async invalidate(): Promise<void> {
		await this.computer?.syncConfig();
		await this.refreshSkills();
		for (const [, agent] of this.sessions) {
			try {
				agent.abort();
			} catch {
				/* session may already be gone */
			}
		}
		this.sessions.clear();
		this.skillsCacheKey = "";
	}

	/**
	 * Update the per-LLM-request timeout at runtime (ms). 0 = no override, i.e.
	 * fall back to the provider SDK default. Read live by streamFn, so it takes
	 * effect on the next LLM call without rebuilding sessions.
	 */
	setRequestTimeoutMs(ms: number): void {
		this.opts.timeoutMs = ms > 0 ? Math.floor(ms) : 0;
	}

	get modelId(): string {
		const c = this.config.all();
		return c.model.defaultModelId || this.availableModels()[0]?.modelId || "unknown";
	}

	private readonly streamFn: StreamFn = async (model, context, options) => {
		// Log the exact model id + endpoint each LLM call uses, so it's auditable
		// what name is actually sent upstream (vs. what a relay re-routes it to).
		const incomingTimeout = (options as { timeoutMs?: number }).timeoutMs;
		console.log(`[engine] llm call → model="${model.id}" @ ${model.baseUrl || "(provider default)"} | engine.timeoutMs=${this.opts.timeoutMs || "0(SDK default)"} incoming=${incomingTimeout ?? "∅"}`);
		const baseOpts = this.opts.timeoutMs ? { ...options, timeoutMs: this.opts.timeoutMs } : { ...options };

		// Abort-listener leak workaround: pi-ai forwards `options.signal` straight
		// into the Anthropic client, which registers an 'abort' listener per LLM call
		// and does not remove it after a normally-completed stream. The agent-loop
		// reuses ONE turn-level signal across every LLM step, so >10 tool-use rounds
		// otherwise trigger MaxListenersExceededWarning. Bridge the turn signal to a
		// fresh per-step signal and explicitly remove our bridge listener when this
		// stream settles (normal completion, provider error, or abort).
		const incomingSignal = (options as { signal?: AbortSignal }).signal;
		const step = incomingSignal ? new AbortController() : undefined;
		let cleanup = (): void => {};
		if (incomingSignal && step) {
			const relayAbort = () => step.abort(incomingSignal.reason);
			if (incomingSignal.aborted) {
				relayAbort();
			} else {
				incomingSignal.addEventListener("abort", relayAbort, { once: true });
				cleanup = () => incomingSignal.removeEventListener("abort", relayAbort);
			}
		}

		try {
			const opts = step ? { ...baseOpts, signal: step.signal } : baseOpts;
			const response = await (this.opts.streamFn
				? this.opts.streamFn(model, context, opts)
				: this.models.streamSimple(model, context, opts));
			// EventStream.result() settles on both `done` and `error`. Handle both
			// branches so cleanup itself can never become an unhandled rejection.
			void response.result().then(cleanup, cleanup);
			return response;
		} catch (err) {
			cleanup();
			throw err;
		}
	};

	private findSupplier(supplierId: string | null | undefined): Supplier | undefined {
		if (!supplierId) return undefined;
		return this.config.all().model.suppliers.find((supplier) => supplier.id === supplierId);
	}


	/** Build a runnable Model from a supplier + model id (alias models supported). */
	private buildModel(supplier: Supplier, modelId: string): Model<Api> {
		const preferredApi = supplier.apiType === "openai" ? "openai-completions" : "anthropic-messages";
		// For openai we prefer a completions-api provider (groq/openrouter/...) since
		// relays overwhelmingly speak chat/completions, whereas the built-in "openai"
		// provider only wires the responses API. Fall back to any model of the primary
		// provider if no completions model exists.
		const order = this.providerSearchOrder(supplier.apiType);
		let firstAny: Model<Api> | undefined;
		for (const providerId of order) {
			const models = (this.models.getProvider(providerId)?.getModels() ?? []) as Model<Api>[];
			const match = models.find((m) => m.api === preferredApi);
			if (match) return this.withIdentity(match, supplier, modelId);
			firstAny ??= models[0];
		}
		if (!firstAny) throw new Error(`No base model for apiType "${supplier.apiType}"`);
		return this.withIdentity(firstAny, supplier, modelId);
	}

	private withIdentity(base: Model<Api>, supplier: Supplier, modelId: string): Model<Api> {
		const baseUrl = supplier.baseUrl.trim();
		// Image-input capability: explicit per-model override, else inherit the
		// base registry model's capability.
		const override = supplier.modelImage?.[modelId];
		const wantImage = override === undefined ? base.input.includes("image") : override;
		const input: ("text" | "image")[] = wantImage ? ["text", "image"] : ["text"];
		// Context window: relay/alias models must not inherit the base model's
		// window — a real 200k model behind a base 128k window gets its completion
		// budget clamped to 1 token once the transcript passes the fake limit.
		const ctxOverride = supplier.modelContextWindow?.[modelId];
		const contextWindow = typeof ctxOverride === "number" && ctxOverride > 0 ? Math.floor(ctxOverride) : base.contextWindow;
		return { ...base, id: modelId, name: modelId, input, contextWindow, ...(baseUrl ? { baseUrl } : {}) };
	}

	/** Effective image-input capability for a configured model (override else base). For the settings UI. */
	effectiveImageCapability(supplierId: string, modelId: string): boolean {
		const supplier = this.findSupplier(supplierId);
		if (!supplier || !supplier.models.includes(modelId)) return false;
		try {
			return this.buildModel(supplier, modelId).input.includes("image");
		} catch {
			return false;
		}
	}

	private providerSearchOrder(apiType: Supplier["apiType"]): string[] {
		return apiType === "openai"
			? ["groq", "openrouter", "deepseek", "xai", "together", "openai"]
			: ["anthropic"];
	}

	/** Resolve (supplier, modelId) for a conversation: override or global default. */
	private resolveForConversation(
		conversationId: string,
	): { supplier: Supplier; modelId: string } {
		const override = this.history.getModelOverride(conversationId);
		const overrideSupplier = this.findSupplier(override?.supplierId);
		if (override && overrideSupplier?.enabled && overrideSupplier.models.includes(override.modelId)) {
			return { supplier: overrideSupplier, modelId: override.modelId };
		}
		return this.resolveDefaultModel();
	}

	/** Resolve the global default model (used by non-conversation LLM calls like consolidation). */
	private resolveDefaultModel(): { supplier: Supplier; modelId: string } {
		const config = this.config.all();
		const defaultSupplier = this.findSupplier(config.model.defaultSupplierId);
		if (!defaultSupplier?.enabled || !defaultSupplier.models.includes(config.model.defaultModelId)) {
			throw new Error("No enabled model configured. Add or enable one in Settings → 模型服务.");
		}
		return { supplier: defaultSupplier, modelId: config.model.defaultModelId };
	}

	/** One-shot text completion with the default model and no tools (for knowledge consolidation). */
	async complete(systemPrompt: string, userPrompt: string): Promise<string> {
		const { supplier, modelId } = this.resolveDefaultModel();
		const agent = new Agent({
			initialState: { systemPrompt, model: this.buildModel(supplier, modelId), tools: [] },
			streamFn: this.streamFn,
			getApiKey: () => supplier.apiKey || undefined,
		});
		let reply = "";
		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
				reply += extractText(event.message);
			}
		});
		try {
			await agent.prompt(userPrompt);
			if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
			return reply.trim();
		} finally {
			unsubscribe();
			agent.abort();
		}
	}

	/**
	 * Record an inbound IM sender into the conversation's roster (the row's key
	 * comes from the platform-verified actor, never from message text). Best
	 * effort: a failed insert must never block the reply.
	 */
	recordConversationMember(conversationId: string, actor?: InboundActor): void {
		if (!actor?.senderId) return;
		try {
			this.history.recordMember(conversationId, actor.senderId, actor.senderName);
		} catch (err) {
			console.warn("[engine] recordConversationMember failed:", (err as Error).message);
		}
	}

	/** All supplier×model combos available for selection. */
	availableModels(): ModelOption[] {
		const c = this.config.all();
		return c.model.suppliers.filter((supplier) => supplier.enabled).flatMap((s) =>
			s.models.map((m) => ({
				supplierId: s.id,
				supplierName: s.name,
				apiType: s.apiType,
				modelId: m,
				isDefault: s.id === c.model.defaultSupplierId && m === c.model.defaultModelId,
			})),
		);
	}

	/** Live agent for a conversation, created on first use with its chosen model. */
	getOrCreateSession(conversationId: string): Agent {
		const cached = this.sessions.get(conversationId);
		// If skills changed since this session was built AND it's idle, drop it so
		// the rebuild below picks up the new skill in the system prompt. We never
		// abort here: an in-flight turn (isStreaming true) is left to finish and
		// will be rebuilt on its next inbound message.
		if (cached) {
			const builtAt = (cached as Agent & { __skillsRevision?: number }).__skillsRevision ?? 0;
			if ((builtAt >= this.skillsRevision && builtAt >= this.memoryRevision) || cached.state.isStreaming) return cached;
			this.sessions.delete(conversationId);
		}

		const { supplier, modelId } = this.resolveForConversation(conversationId);
		const cfg = this.config.all();
			const agent = new Agent({
				initialState: {
					systemPrompt: buildSystemPrompt(this.promptPartsFor(conversationId)),
				model: this.buildModel(supplier, modelId),
				tools: buildTools({ kbEnabled: cfg.kb.enabled, learnEnabled: cfg.kb.learn.enabled, manageEnabled: cfg.kb.manage.enabled, researchEnabled: cfg.kb.research.enabled, browserEnabled: cfg.browser.enabled, schedulerEnabled: cfg.scheduler.enabled, documentsEnabled: cfg.documents.enabled, filesystemEnabled: cfg.filesystem.enabled, reportsEnabled: cfg.reports.enabled, downloadsEnabled: cfg.downloads.enabled, knowledge: this.knowledge, browser: this.browser, computer: this.computer, scheduler: this.scheduler, documents: this.documents, filesystem: this.filesystem, reportService: this.reportService, downloadService: this.downloadService, skillWriter: this.skillWriter, userSkillsDir: this.paths.userSkillsDir, config: this.config, resolveActor: (cid) => this.turnActor.get(cid), onSkillsChanged: () => this.markSkillsChanged(), onMemoryChanged: () => this.markMemoryChanged(), onConfigChanged: () => this.markConfigChanged(), listSkills: () => this.listSkills(), updates: this.updates, playwrightCliPath: this.playwrightCliPath, shellAuditLogPath: this.paths.shellAuditLogPath, conversationId, isVisionModel: () => this.sessions.get(conversationId)?.state.model.input.includes("image") ?? false, resolveFileSender: (cid) => this.turnSendFile.get(cid), resolveImageSender: (cid) => this.turnSendImage.get(cid), screenshotDir: async () => { try { return await this.downloadService.dir(); } catch { return undefined; } }, listConversations: () => this.history.listConversations().map((c) => ({ id: c.id, title: c.title, origin: c.origin })), listMembers: (cid) => this.history.listMembers(cid).map((m) => ({ staffId: m.staff_id, name: m.name, lastSeenAt: m.last_seen_at, messageCount: m.message_count })), onToolEvent: (e) => this.recordToolTelemetry(conversationId, e), telemetry: this.telemetry, proposals: this.proposals, proposalsDir: this.paths.proposalsDir, promptLab: this.promptLab, runEvalTurn: async (input, rules) => this.runEvalTurn(`eval:${conversationId}`, rules, input), buildPromptWithRules: (rules) => this.buildPromptWithRules(conversationId, rules) }),
				// Rebuild the transcript from persisted history so the conversation
				// keeps its context across app restarts (bounded tail, turn-aligned).
				messages: rehydrateMessages(this.history.listMessages(conversationId)),
			},
			// Harness converter: renders compaction-summary (and other custom)
			// messages to the model — the Agent default would drop them.
			convertToLlm,
			sessionId: conversationId,
			streamFn: this.streamFn,
			getApiKey: () => supplier.apiKey || undefined,
		});

		this.applyToolStepCap(agent);
		const revision = Math.max(this.skillsRevision, this.memoryRevision);
		(agent as Agent & { __skillsRevision?: number }).__skillsRevision = revision;
		this.sessions.set(conversationId, agent);
		return agent;
	}

	/**
	 * /new phase 1: abort an in-flight turn on this conversation so the IM
	 * per-conversation queue can drain. Returns true when a live session was
	 * aborted. The actual reset runs as phase 2 ({@link resetSession}) at the
	 * BACK of that queue, so it lands strictly after the aborted turn's final
	 * persistence — a partial reply from the dead turn can never re-seed the
	 * fresh transcript.
	 */
	abortSession(conversationId: string): boolean {
		const cached = this.sessions.get(conversationId);
		if (!cached) return false;
		try {
			cached.abort();
		} catch {
			/* session may already be gone */
		}
		return true;
	}

	/**
	 * /new phase 2: wipe the persisted transcript and drop the cached agent, so
	 * the next inbound message rehydrates an EMPTY session under the same
	 * conversation id. The per-conversation model override survives the reset.
	 * History deletion is final — this is the "start over" escape hatch.
	 */
	resetSession(conversationId: string): void {
		const override = this.history.getModelOverride(conversationId);
		this.history.deleteConversation(conversationId);
		this.history.ensureConversation(conversationId, null);
		if (override) this.history.setModelOverride(conversationId, override.supplierId, override.modelId);
		this.sessions.delete(conversationId);
	}

	/**
	 * /compact: force a compaction pass on this conversation — summarize older
	 * turns into a compaction-summary message while keeping the recent tail
	 * verbatim. Runs through the IM queue (an in-flight turn must settle
	 * first). Returns a channel-ready reply describing what happened.
	 */
	async compactSession(conversationId: string): Promise<string> {
		const agent = this.getOrCreateSession(conversationId);
		if (agent.state.isStreaming) {
			return "⏳ 当前有回合正在进行，等它结束后再试 /compact。";
		}
		const before = estimateContextTokens(agent.state.messages).tokens;
		const done = await maybeCompact(agent, this.models, true);
		if (!done) {
			// Honest verdict, not boilerplate: one branch is genuinely "no need",
			// the other is "over budget but structurally incompressible this pass"
			// — they must not sound the same (the old wording called an 88%-full
			// transcript "很短", see field incident 2026-09-17).
			const window = agent.state.model.contextWindow || FALLBACK_CONTEXT_WINDOW;
			const pct = Math.max(1, Math.round((before / window) * 100));
			if (before < window - this.compactionReserve()) {
				return `上下文约 ${before.toLocaleString()} tokens（约占窗口 ${pct}%），离压缩阈值还很远，无需压缩。`;
			}
			return `⚠️ 会话约 ${before.toLocaleString()} tokens，已占窗口 ${pct}%，但这次压缩没有执行成（通常是最近一轮的工具返回太大、或摘要生成失败）。最快的恢复方式是直接 /new 开新会话。`;
		}
		const after = estimateContextTokens(agent.state.messages).tokens;
		return `🧹 上下文已压缩：约 ${before} → ${after} tokens（较早的对话已汇总为摘要，近期对话原样保留）。`;
	}

	/**
	 * Reload skills from disk and mark every cached session stale. Used after a
	 * skill is written (save_to_skill) or imported/deleted via IPC. Unlike
	 * {@link invalidate}, this does NOT abort in-flight turns: it only bumps a
	 * revision so each session rebuilds itself, with the new skill in its system
	 * prompt, the next time a message arrives on it.
	 */
	async markSkillsChanged(): Promise<void> {
		await this.refreshSkills();
		this.markConfigChanged();
	}

	/**
	 * A memory entry was written (remember tool) — bump the revision so cached
	 * sessions rebuild with the fresh always-on memory index on their next turn.
	 */
	markMemoryChanged(): void {
		this.memoryRevision += 1;
	}

	/** Mark cached sessions stale after a prompt/tool/config change. The current
	 * in-flight turn is allowed to finish; its next inbound message rebuilds the
	 * Agent from the newly-persisted config. */
	markConfigChanged(): void {
		void this.computer?.syncConfig();
		this.skillsRevision += 1;
	}

	/**
	 * Install a per-turn tool-loop safety cap on an Agent, honoring
	 * `config.general.maxToolSteps`. The cap uses the SDK's `shouldStopAfterTurn`
	 * loop hook: after each assistant turn's tool calls finish, increment the
	 * counter; once it reaches `maxToolSteps`, return `true` to end the loop
	 * gracefully and set a flag on the agent. `send()` checks that flag after
	 * `promptWithRetry` resolves and, if set, asks the model for a final
	 * plain-language summary (no tools) so the user gets a closing reply
	 * instead of a mid-task truncation — same pattern as the empty-reply
	 * fallback.
	 *
	 * The SDK's `Agent` doesn't expose `shouldStopAfterTurn` as a constructor
	 * option (it lives on the internal `AgentLoopConfig`), so we wrap the
	 * prototype `createLoopConfig()` per-instance. The counter resets on each
	 * fresh `agent.prompt()` (new user turn) but not on `agent.continue()`
	 * (transient-error retry, same logical turn). A `maxToolSteps` of 0 means
	 * unlimited and preserves prior behavior.
	 */
	private applyToolStepCap(agent: Agent): void {
		type ToolStepCapAgent = {
			prompt: Agent["prompt"];
			createLoopConfig: (opts?: unknown) => Record<string, unknown>;
			__toolStepCapHit?: boolean;
			__contextBudgetHit?: boolean;
		};
		// `createLoopConfig` is private in the SDK's declaration but exists on the
		// runtime instance. Use a narrow structural view so the workaround stays
		// isolated here rather than weakening the Agent type elsewhere.
		const target = agent as unknown as ToolStepCapAgent;
		const originalCreateLoopConfig = target.createLoopConfig.bind(agent);
		let steps = 0;

		// Reset the counter at the start of each new user turn. `prompt` is the
		// new-message entry point; `continue` (transient-error retry) does NOT
		// reset, so a retried turn still counts toward the cap. Also clear the
		// hit flag from the previous turn.
		const originalPrompt = agent.prompt.bind(agent);
		target.prompt = ((...args: Parameters<typeof agent.prompt>) => {
			steps = 0;
			target.__toolStepCapHit = false;
			target.__contextBudgetHit = false;
			return originalPrompt(...args);
		}) as typeof agent.prompt;

		target.createLoopConfig = (opts?: unknown) => {
			const config = originalCreateLoopConfig(opts) as Record<string, unknown>;
			config.shouldStopAfterTurn = async (context: { toolResults?: unknown[] }) => {
				// The SDK invokes this hook after every assistant response, including a
				// normal text-only final answer. Only responses that actually executed
				// tools count as tool-loop steps.
				if (!context.toolResults?.length) return false;

				// CONTEXT BUDGET — checked here because this is the last moment before
				// the next request is built. A single huge tool result (a browser dump,
				// a big file, a log) can push the transcript past the provider's hard
				// limit mid-turn, where compaction-after-the-turn cannot help; the turn
				// then dies with ContextWindowExceededError and the user gets nothing
				// (field report: qwen 204800 → whole turn lost).
				//
				// But stopping is the LAST resort, not the protocol: the user ruled
				// (2026-09-17) that a near-full context must never chop the task — the
				// automatic compaction machinery IS the plan, so run its recovery here,
				// mid-turn, and continue. Only a transcript that genuinely cannot shrink
				// (e.g. recovery itself failed) ends the turn for the summary path.
				const window = agent.state.model.contextWindow || FALLBACK_CONTEXT_WINDOW;
				const budget = window - this.compactionReserve();
				if (estimateTokensSafe(agent.state.messages) >= budget) {
					try {
						const recovered = await this.recoverFromContextOverflow(agent);
						if (recovered && estimateTokensSafe(agent.state.messages) < budget) {
							console.warn(
								`[engine] context budget reached mid-task (~${estimateTokensSafe(agent.state.messages)} ≥ ${budget}); compacted in-turn and continuing the task`,
							);
							return false;
						}
					} catch (err) {
						console.warn("[engine] in-turn context recovery failed:", err instanceof Error ? err.message : err);
					}
					target.__contextBudgetHit = true;
					console.warn(
						`[engine] context budget reached and recovery could not free room (~${estimateTokensSafe(agent.state.messages)} ≥ ${budget} of ${window}); ending turn for final summary`,
					);
					return true;
				}

				const max = this.config.all().general.maxToolSteps ?? 0;
				if (max <= 0) return false; // unlimited
				steps += 1;
				if (steps < max) return false;
				target.__toolStepCapHit = true;
				console.warn(`[engine] tool-loop cap reached (maxToolSteps=${max}); ending turn for final summary`);
				return true;
			};
			return config;
		};
	}

	/** True when the agent's last run ended because the tool-step cap fired. */
	private toolStepCapHit(agent: Agent): boolean {
		return Boolean((agent as Agent & { __toolStepCapHit?: boolean }).__toolStepCapHit);
	}

	/** True when the turn loop was ended early because the context budget ran out. */
	private contextBudgetHit(agent: Agent): boolean {
		return Boolean((agent as Agent & { __contextBudgetHit?: boolean }).__contextBudgetHit);
	}

	/** Tokens held back for the summary + the model's own answer. */
	private compactionReserve(): number {
		return Math.max(DEFAULT_COMPACTION_SETTINGS.reserveTokens, 16_384);
	}

	private getCachedSkills(): Skill[] {
		// Cache key includes nothing volatile for now; invalidated on config save.
		if (this.skillsCache) return this.skillsCache;
		// Synchronous best-effort: skills are loaded async on first need; if not
		// ready yet, return empty (next session picks them up).
		return [];
	}

	/** Preload skills from disk (called on boot and after config/import changes). */
	async refreshSkills(): Promise<void> {
		const { skills } = await this.skillLoader.list();
		this.skillsCache = skills;
	}

	/** Test an unsaved supplier draft without creating a session or history rows. */
	async testModelConnection(supplier: Supplier, modelId: string): Promise<string> {
		const normalizedModelId = modelId.trim();
		if (!normalizedModelId) throw new Error("请先添加一个模型");
		if (!supplier.apiKey.trim()) throw new Error("请填写 API Key");

		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a connection test. Reply with exactly: OK",
				model: this.buildModel(supplier, normalizedModelId),
				tools: [],
			},
			streamFn: (model, context, options) =>
				this.models.streamSimple(model, context, { ...options, timeoutMs: 30_000 }),
			getApiKey: () => supplier.apiKey || undefined,
		});

		let reply = "";
		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
				reply += extractText(event.message);
			}
		});
		try {
			await agent.prompt("Reply with exactly: OK");
			if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
			return reply.trim() || "连接成功";
		} finally {
			unsubscribe();
			agent.abort();
		}
	}

	/** Switch a conversation's model (live, keeps transcript) and persist it. */
	setConversationModel(conversationId: string, supplierId: string, modelId: string): void {
		const supplier = this.findSupplier(supplierId);
		if (!supplier) throw new Error(`Unknown supplier "${supplierId}"`);
		if (!supplier.enabled) throw new Error(`Supplier "${supplier.name}" is disabled`);
		if (!supplier.models.includes(modelId)) {
			throw new Error(`Model "${modelId}" not in supplier "${supplier.name}"`);
		}
		const agent = this.getOrCreateSession(conversationId);
		agent.state.model = this.buildModel(supplier, modelId);
		agent.getApiKey = () => supplier.apiKey || undefined;
		this.history.ensureConversation(conversationId, null);
		this.history.setModelOverride(conversationId, supplierId, modelId);
	}

	async send(agent: Agent, message: string, ctx?: SendCtx): Promise<SendResult> {
		const conversationId = agent.sessionId ?? "default";

		const existing = this.history.getConversation(conversationId);
		this.history.ensureConversation(conversationId, existing?.title ?? deriveTitle(message));
		// Adopt the channel's own name for the chat when it supplies one (group
		// title), so the admin can name a group the only way they can — by name.
		// Only for non-local chats: the console's own titles stay user-facing.
		const channelName = ctx?.conversationName?.trim();
		if (channelName && channelName !== existing?.title && !isLocalConversation(conversationId)) {
			this.history.setConversationName(conversationId, channelName);
		}
		// Persist the user turn. Images ride along for THIS turn only (they go to the
		// live model, not the text transcript), so mark them in the stored line.
		const imageNote = ctx?.images?.length ? `\n[附带 ${ctx.images.length} 张图片]` : "";
		if (!ctx?.ephemeral) {
			this.history.appendMessage(conversationId, "user", message + imageNote);
			ctx?.onPersist?.(conversationId); // user turn now persisted → refresh this conversation live
		}

		// Expose the channel's file-sender to the provide_document tool for this
		// turn only (cleared in the finally below). Tools resolve it live via the
		// closure passed into buildTools.
		if (ctx?.sendFile) this.turnSendFile.set(conversationId, ctx.sendFile);
		if (ctx?.sendImage) this.turnSendImage.set(conversationId, ctx.sendImage);
		if (ctx?.actor) this.turnActor.set(conversationId, { ...ctx.actor, text: message });
		// A turn that arrives WITHOUT verified sender metadata must never inherit
		// the previous sender's identity (roles are per-person, and one group
		// conversation serves many senders).
		else if (!isLocalConversation(conversationId)) this.turnActor.delete(conversationId);

		// Telemetry: one row per turn, written when the turn settles below. The id is
		// minted here so tool calls made during this turn can be linked to it.
		const turnId = this.telemetry ? randomUUID() : undefined;
		const turnStartedAt = Date.now();
		const turnCorrection = looksLikeCorrection(message);
		if (turnId) this.turnIds.set(conversationId, turnId);

		let reply = "";
		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
				const msg = event.message as { content?: unknown; stopReason?: string };
				const parts = Array.isArray(msg.content) ? (msg.content as { type?: string }[]) : [];
				const types = parts.map((p) => p.type).join(",") || "(empty)";
				const textLen = extractText(event.message).length;
				const toolCalls = parts.filter((p) => p.type === "toolCall").length;
				console.log(`[engine] assistant msg: stopReason=${msg.stopReason ?? "∅"} parts=[${types}] textLen=${textLen} toolCalls=${toolCalls}`);
				// Only the FINAL assistant message of the turn is the reply sent to the
				// channel — intermediate step narrations ("我现在去查…", "让我想想…") are
				// progress, not the answer. Accumulating them produced a wall of text and
				// leaked English reasoning into a Chinese reply, so keep just the latest.
				reply = extractText(event.message);
			}
		});

		let hardError: string | undefined;
		let retried = false;
		let capHit = false;
		let contextBudgetHit = false;
		// Which last-resort path produced the reply, if any. Tracked explicitly
		// rather than sniffed from the text: telemetry's job is to be accurate.
		let askedForSummary = false;
		let deterministic = false;
		try {
			retried = await this.promptWithRetry(agent, message, ctx?.images);
		} catch (err) {
			hardError = err instanceof Error ? err.message : String(err);
			console.error(`[engine] prompt failed for ${conversationId}:`, err);
		} finally {
			unsubscribe();
			this.turnSendFile.delete(conversationId);
			this.turnSendImage.delete(conversationId);
			this.turnActor.delete(conversationId);
			await this.computer?.release(conversationId);
		}

		const errorMessage = agent.state.errorMessage;

		// TOOL-LOOP SAFETY CAP — if the SDK ended the turn early because maxToolSteps
		// was reached, the model was mid-task and likely left a narration ("正在登录...")
		// rather than an outcome. Force a no-tools final summary so the user gets a
		// clear status (what succeeded, what's left, what they need to provide).
		capHit = this.toolStepCapHit(agent);
		contextBudgetHit = this.contextBudgetHit(agent);
		if ((capHit || contextBudgetHit) && !hardError) {
			askedForSummary = true;
			const capSummary = await this.finalSummary(agent);
			const max = this.config.all().general.maxToolSteps ?? 0;
			if (contextBudgetHit) {
				// The budget gate already tried in-turn compaction and could not free
				// room. Surface that plainly — the user must know WHY the task ended
				// (context nearly full, auto-compact failed) and what to do next
				// (manual /compact or /new), not just see a bare summary that looks
				// like a normal "task done" (field feedback 2026-09-17).
				const notice =
					"⚠️ 上下文已接近模型上限，自动压缩也没能腾出足够空间——本次任务在此结束。\n\n" +
					"建议：① 发 `/compact` 手动压缩本会话，或 `/new` 开新会话后重发任务；② 把任务拆成更小的步骤，或让我换一种更省上下文的方式取数。\n\n" +
					"以下为本轮已完成的进展：";
				reply = capSummary?.trim() ? `${notice}\n\n${capSummary}` : notice;
			} else {
				reply =
					capSummary ||
					`⚠️ 本轮已达到工具调用上限（${max} 步），系统已停止继续调用工具。当前任务可能尚未完成，请提高上限后重试，或把任务拆成更小的步骤。`;
			}
		}

		// GUARANTEED FINAL REPLY — a virtual employee must always answer, success or
		// failure. The turn may end with no visible text (task failed, relay cut the
		// stream, model ended on a thinking-only message). In that case ask the model
		// for a plain-language outcome summary first; it knows what it tried.
		if (!reply.trim() && !hardError) {
			askedForSummary = true;
			const summary = await this.finalSummary(agent);
			if (summary) reply = summary;
		}

		// Last resort: model/relay unreachable or still empty — emit a deterministic
		// reply so the user is never left waiting in silence.
		if (!reply.trim()) {
			deterministic = true;
			reply = this.deterministicFailure(hardError || errorMessage);
			console.warn(`[engine] no reply produced for ${conversationId}; emitted deterministic failure (${hardError || errorMessage || "no error reported"})`);
		}

		reply = reply.trim();
		if (!ctx?.ephemeral) {
			this.history.appendMessage(conversationId, "assistant", reply);
			ctx?.onPersist?.(conversationId); // assistant reply now persisted → refresh this conversation live
		}

		// Context management: summarize old turns once the transcript approaches
		// the model's context window (IM chats run indefinitely). Best-effort —
		// compaction must never break message delivery.
		try {
			await maybeCompact(agent, this.models);
		} catch (err) {
			console.warn("[engine] compaction failed:", err);
		}

		this.recordTurnTelemetry({
			conversationId,
			turnId,
			startedAt: turnStartedAt,
			reply,
			hardError,
			agentError: errorMessage,
			retried,
			capHit,
			askedForSummary,
			deterministic,
			correction: turnCorrection,
			actor: ctx?.actor,
		});

		return { reply, error: hardError ?? (errorMessage || undefined) };
	}

	/** One tool call, linked to the turn that made it. Never throws. */
	private recordToolTelemetry(
		conversationId: string,
		event: { name: string; durationMs: number; ok: boolean; refused?: boolean; refusedCapability?: string; error?: string },
	): void {
		if (!this.telemetry) return;
		try {
			this.turnToolCalls.set(conversationId, (this.turnToolCalls.get(conversationId) ?? 0) + 1);
			this.telemetry.recordTool({ ...event, conversationId, turnId: this.turnIds.get(conversationId) });
		} catch (err) {
			console.warn("[engine] telemetry tool write failed:", err instanceof Error ? err.message : err);
		}
	}

	/**
	 * Write the turn's outcome row. Best-effort: a telemetry failure must never
	 * turn a delivered reply into an error, so everything is swallowed.
	 */
	private recordTurnTelemetry(input: {
		conversationId: string;
		turnId?: string;
		startedAt: number;
		reply: string;
		hardError?: string;
		agentError?: string;
		retried: boolean;
		capHit: boolean;
		askedForSummary: boolean;
		deterministic: boolean;
		correction: boolean;
		actor?: InboundActor;
	}): void {
		const { conversationId, turnId } = input;
		this.turnIds.delete(conversationId);
		const toolCalls = this.turnToolCalls.get(conversationId) ?? 0;
		this.turnToolCalls.delete(conversationId);
		const abortReason = this.turnAborts.get(conversationId);
		this.turnAborts.delete(conversationId);
		// Evaluation runs are excluded from telemetry on purpose: the improvement
		// loop reads these numbers, and measuring its own experiments would corrupt
		// the very signal it is trying to improve.
		if (!this.telemetry || !turnId || inferConversationOrigin(conversationId) === "eval") return;
		try {
			const errorText = input.hardError ?? input.agentError ?? undefined;
			const emptyReply = !input.reply.trim();
			// Status precedence: a hard error wins; then an explicitly aborted turn;
			// then the two last-resort paths (deterministic failure, and "we had to
			// ask for a summary because the turn produced no outcome text"); else ok.
			let status: TurnStatus = "ok";
			if (errorText) status = "error";
			else if (abortReason) status = "aborted";
			else if (input.deterministic) status = "deterministic_failure";
			else if (input.askedForSummary || emptyReply) status = "empty_reply";
			this.telemetry.recordTurn({
				turnId,
				conversationId,
				origin: inferConversationOrigin(conversationId),
				actorId: input.actor?.senderId,
				channel: input.actor?.channel,
				chatType: input.actor?.chatType,
				startedAt: input.startedAt,
				durationMs: Date.now() - input.startedAt,
				status,
				error: errorText,
				toolCalls,
				retries: input.retried ? 1 : 0,
				stepCapHit: input.capHit,
				emptyReply,
				deterministic: input.deterministic,
				abortReason,
				correction: input.correction,
				replyLen: input.reply.length,
			});
		} catch (err) {
			console.warn("[engine] telemetry write failed:", err instanceof Error ? err.message : err);
		}
	}

	/**
	 * Assemble the system prompt as it WOULD be with `rules` — same inputs as the
	 * live session build, so a `prompt_includes` case measures the real article and
	 * not a hand-made approximation of it.
	 */
	buildPromptWithRules(conversationId: string, rules: string): string {
		return buildSystemPrompt(this.promptPartsFor(conversationId, rules));
	}

	/**
	 * The prompt parts for a conversation — the SINGLE assembly path, shared by the
	 * live session build and by prompt-lab evaluation. Sharing it is not tidiness:
	 * an evaluator that assembles a slightly different prompt than production
	 * measures the wrong article, and every score it produces is a lie.
	 *
	 * `rulesOverride` (used only by the lab) replaces prompt.rules for this call.
	 */
	private promptPartsFor(conversationId: string, rulesOverride?: string) {
		const cfg = this.config.all();
		const disabled = new Set(cfg.skills?.disabled ?? []);
		return {
			name: cfg.identity.name,
			appVersion: this.updates?.getStatus().currentVersion,
			role: cfg.identity.role,
			duty: cfg.identity.duty,
			serviceHours: cfg.identity.serviceHours,
			kbEnabled: cfg.kb.enabled,
			learnEnabled: cfg.kb.learn.enabled,
			manageEnabled: cfg.kb.manage.enabled,
			researchEnabled: cfg.kb.research.enabled,
			browserEnabled: cfg.browser.enabled,
			schedulerEnabled: cfg.scheduler.enabled,
			documentsEnabled: cfg.documents.enabled,
			filesystemEnabled: cfg.filesystem.enabled,
			reportsEnabled: cfg.reports.enabled,
			downloadsEnabled: cfg.downloads.enabled,
			skillsBlock: formatInlineSkills(pickActiveSkills(this.getCachedSkills(), disabled)),
			// Always-on memory index: user-specific facts (preferences, corrections,
			// standing context) visible WITHOUT a KB query.
			memoryLines: this.knowledge.listMemoryIndex().map((m) => `${m.title} — ${m.snippet}`),
			rules: rulesOverride ?? this.promptOverrides.get(conversationId) ?? cfg.prompt.rules,
			extra: cfg.prompt.extra,
			language: cfg.general.language,
			// Unattended context for scheduler-owned conversations: tells the model to
			// detect login state instead of re-logging-in / asking for OTP codes, and
			// to stop and ask for re-login when expired.
			isScheduledRun: conversationId.startsWith("sched:"),
		};
	}

	/**
	 * Run ONE isolated turn with `rulesOverride` as the rules, for prompt-lab
	 * evaluation. Returns the reply. Never persists, never records telemetry, never
	 * mutates config: the override lives in a per-conversation map that is cleared
	 * in `finally`, and the session is dropped on both ends so no cached agent
	 * keeps the candidate prompt.
	 *
	 * Evaluation runs act WITHOUT an IM actor, so guarded tools resolve to the
	 * default (viewer) role. That is intentional: behavioural cases should assert
	 * on wording, honesty and refusal behaviour — not on privileged execution.
	 */
	async runEvalTurn(conversationId: string, rulesOverride: string, input: string): Promise<string> {
		this.promptOverrides.set(conversationId, rulesOverride);
		try {
			this.dropSession(conversationId);
			const agent = this.getOrCreateSession(conversationId);
			const result = await this.send(agent, input, { ephemeral: true });
			return result.reply ?? "";
		} finally {
			this.promptOverrides.delete(conversationId);
			this.dropSession(conversationId);
		}
	}

	/**
	 * Force a plain-language outcome summary when a turn produced no visible text.
	 * Asks the model (no tools) to recap what it tried and how it ended — success or
	 * failure — so the user always gets a closing reply. Returns "" if it can't.
	 */
	private async finalSummary(agent: Agent): Promise<string> {
		let text = "";
		const savedTools = agent.state.tools;
		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
				text += extractText(event.message);
			}
		});
		try {
			// Enforce the instruction structurally: the final-summary turn must not be
			// able to start another tool loop after the safety cap has already fired.
			agent.state.tools = [];
			await agent.prompt("现在请不要调用任何工具，直接用一段简明的中文总结：你刚才为完成用户请求做了哪些尝试？最终是成功还是失败？如果没成功，具体卡在哪一步、需要用户怎么配合或提供什么？只输出这段总结。只依据本次对话中真实发生的事与工具真实返回的数据，不要补充任何你没实际取到的数字、结论或「大概是这样」的推测；没取到就直说没取到。");
		} catch (err) {
			console.warn("[engine] final summary prompt failed:", err instanceof Error ? err.message : err);
		} finally {
			agent.state.tools = savedTools;
			unsubscribe();
		}
		return text.trim();
	}

	/** Deterministic reply of last resort — always non-empty, in Chinese. */
	private deterministicFailure(cause?: string): string {
		if (cause && isContextOverflowError(cause)) {
			return (
				"⚠️ 这次没能完成：本会话累计的内容超出了模型能一次处理的长度上限（已尝试自动压缩与裁剪仍未通过）。\n\n" +
				"建议：① 用 /new 开一个新会话再发这个任务（最快）；② 把任务拆成更小的步骤；③ 让我少读一点（例如只读需要的字段/时间段，而不是整页或整表）。"
			);
		}
		if (cause) {
			return `⚠️ 抱歉，这次没能完成你的请求：${cause}。\n\n我已经尽力尝试，但没有成功。可以稍后重试，或把任务拆成更小的步骤再发给我。`;
		}
		return `⚠️ 抱歉，这次没能完成你的请求（模型连续多次未返回内容）。我已经尽力尝试，但没有成功。可以稍后重试，或把任务拆成更小的步骤再发给我。`;
	}

	/**
	 * A brief, best-effort snapshot of what the agent is currently doing, for the
	 * long-task progress heartbeat. Derived purely from the live transcript (the
	 * most recent assistant narration) — no extra LLM call, since the agent is
	 * mid-turn and can't be prompted concurrently. Read-only snapshot.
	 */
	briefProgress(agent: Agent): string {
		const msgs = agent.state.messages;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.role !== "assistant") continue;
			const text = extractText(m).trim();
			if (text) {
				const snippet = text.replace(/\s+/g, " ").slice(0, 100);
				return `⏳ 任务仍在进行中（已耗时较长）。最近进展：${snippet}`;
			}
		}
		return "⏳ 任务仍在进行中（已耗时较长），请稍候，完成后会立即回复结果。";
	}

	/**
	 * agent.prompt() + one retry for transient stream failures.
	 *
	 * The stream can be cut mid-turn (local relay restart, upstream rate limit),
	 * leaving the transcript ending on the user message / tool result. continue()
	 * resumes from there without re-appending the user message; if the last
	 * message is already an assistant one, fall back to re-prompting.
	 *
	 * Also retries when the turn ends without any visible text. The relay
	 * occasionally finishes a stream with an empty assistant message — either
	 * stopReason="error" with no content, or a thinking-only "stop" — which would
	 * otherwise surface to the user as a blank reply with no error.
	 */
	private async promptWithRetry(agent: Agent, message: string, images?: { data: string; mimeType: string }[]): Promise<boolean> {
		// Vision input: only pass images when the session's model actually accepts
		// them — a non-vision model would reject the image block and fail the turn.
		const visionImages: ImageContent[] | undefined =
			images?.length && agent.state.model.input.includes("image")
				? images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))
				: undefined;
		let threwTransient = false;
		try {
			await agent.prompt(message, visionImages);
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			// Provider says the prompt is too long (our estimate was low, or one
			// enormous tool result dominated the transcript). Shrink the transcript
			// and retry ONCE instead of losing the turn — the whole turn used to die
			// here with nothing to show the user.
			if (isContextOverflowError(text)) {
				const recovered = await this.recoverFromContextOverflow(agent);
				if (recovered) {
					console.warn("[engine] context overflow: retrying the request on a compacted transcript");
					await agent.prompt(message, visionImages);
					return false;
				}
				throw err;
			}
			if (!TRANSIENT_STREAM_ERROR.test(text)) throw err;
			threwTransient = true;
		}
		let errorText = agent.state.errorMessage ?? "";
		// The relay may report the overflow as an in-turn error rather than throwing.
		// Same recovery: shrink the transcript, then continue the same turn.
		if (errorText && isContextOverflowError(errorText)) {
			if (await this.recoverFromContextOverflow(agent)) {
				console.warn("[engine] context overflow reported in-turn: retrying on a compacted transcript");
				await agent.continue();
				return true;
			}
		}
		const endedEmpty = this.endedWithoutText(agent);
		if (!threwTransient && !(errorText && TRANSIENT_STREAM_ERROR.test(errorText)) && !endedEmpty) return false;

		const reason = endedEmpty && !threwTransient && !errorText
			? "turn ended without visible text"
			: `transient stream error (${errorText || "stream aborted"})`;
		console.warn(`[engine] ${reason} — retrying once`);
		await sleep(1000);
		// Drop a trailing empty/error assistant message so continue() can resume from
		// the preceding user/tool message instead of throwing "Cannot continue from
		// message role: assistant".
		if (this.endedWithoutText(agent)) agent.state.messages.pop();
		try {
			await agent.continue();
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			if (!text.startsWith("Cannot continue")) throw err;
			await agent.prompt(message, visionImages);
		}
		return true;
	}

	/**
	 * Shrink the transcript so the next request fits: summarize the old head first
	 * (keeps meaning), and if that cannot help — one huge tool result, or too short
	 * to split — drop the oldest messages outright. Returns false when nothing could
	 * be freed, so the caller can fail honestly instead of retrying forever.
	 */
	private async recoverFromContextOverflow(agent: Agent): Promise<boolean> {
		try {
			if (await maybeCompact(agent, this.models, true)) return true;
		} catch (err) {
			console.warn("[engine] overflow compaction failed:", err instanceof Error ? err.message : err);
		}
		const window = agent.state.model.contextWindow || FALLBACK_CONTEXT_WINDOW;
		const target = Math.max(4_000, Math.floor((window - this.compactionReserve()) / 2));
		const dropped = truncateToFit(agent, target);
		if (dropped === null) {
			console.warn("[engine] context overflow: nothing left to drop (transcript already minimal)");
			return false;
		}
		return true;
	}

	/**
	 * True when the transcript ends on an assistant message that carries no visible
	 * text and no pending tool calls — i.e. the turn "finished" but the user would
	 * see nothing. Tool-call messages are excluded (the loop would keep running).
	 */
	private endedWithoutText(agent: Agent): boolean {
		const msgs = agent.state.messages;
		const last = msgs[msgs.length - 1];
		if (!last || last.role !== "assistant") return false;
		if (extractText(last) !== "") return false;
		const content = (last as { content?: unknown }).content;
		if (Array.isArray(content) && (content as { type?: string }[]).some((p) => p.type === "toolCall")) return false;
		return true;
	}

	dropSession(conversationId: string): boolean {
		const agent = this.sessions.get(conversationId);
		if (agent) agent.abort();
		return this.sessions.delete(conversationId);
	}

	activeSessionCount(): number {
		return this.sessions.size;
	}

	/** True when neither agent turns nor supervised commands are active. */
	isIdle(): boolean {
		if (hasActiveShellCommands(this.config)) return false;
		if (this.computer?.busy) return false;
		for (const [, agent] of this.sessions) {
			if (agent.state.isStreaming) return false;
		}
		return true;
	}

	isReadOnlyConversation(conversationId: string): boolean {
		return this.history.isReadOnly(conversationId);
	}
}
