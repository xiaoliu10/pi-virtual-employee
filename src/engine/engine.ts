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
import { Agent, convertToLlm } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, Skill, StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, ImageContent, Model, MutableModels, TextContent } from "@earendil-works/pi-ai";
import type { ConfigStore, Supplier } from "../db/config-store.js";
import type { HistoryStore } from "../db/history-store.js";
import type { InboundActor } from "../im/types.js";
import type { KnowledgeService } from "../knowledge/knowledge-service.js";
import type { BrowserService } from "../browser/browser-service.js";
import type { SchedulerService } from "../scheduler/scheduler-service.js";
import type { DocumentService, FileSender } from "../documents/document-service.js";
import type { FileSystemService } from "../filesystem/filesystem-service.js";
import type { ReportService } from "../reports/report-service.js";
import type { DownloadService } from "../downloads/download-service.js";
import { buildSystemPrompt, buildTools } from "./definition.js";
import type { UpdateOperations } from "./tools/update.js";
import { maybeCompact, rehydrateMessages } from "./context.js";
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
	/** Called right after a message is persisted, so the UI can reload this conversation live. */
	onPersist?: (conversationId: string) => void;
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
	/terminated|fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|ETIMEDOUT|UND_ERR|overloaded|502|503/i;

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
		private readonly paths: { builtinSkillsDir: string; userSkillsDir: string },
		options: EngineOptions = {},
	) {
		this.opts = { timeoutMs: options.timeoutMs ?? 0, streamFn: options.streamFn };
		this.models = createModels();
		for (const provider of builtinProviders()) this.models.setProvider(provider);
		this.skillLoader = new SkillLoader(paths.builtinSkillsDir, paths.userSkillsDir);
		this.skillWriter = new SkillWriter(this.skillLoader, paths.userSkillsDir);
	}

	/** Inject the platform updater after construction; new sessions see manage_update. */
	setUpdateOperations(updates: UpdateOperations | undefined): void {
		this.updates = updates;
	}

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
			if (builtAt >= this.skillsRevision || cached.state.isStreaming) return cached;
			this.sessions.delete(conversationId);
		}

		const { supplier, modelId } = this.resolveForConversation(conversationId);
		const cfg = this.config.all();
		const skills = this.getCachedSkills();
		const disabled = new Set(cfg.skills?.disabled ?? []);
		const activeSkills = pickActiveSkills(skills, disabled);
		const agent = new Agent({
			initialState: {
				systemPrompt: buildSystemPrompt({
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
					skillsBlock: formatInlineSkills(activeSkills),
					rules: cfg.prompt.rules,
					extra: cfg.prompt.extra,
					language: cfg.general.language,
					// Unattended context for scheduler-owned conversations: tells the
					// model to detect login state instead of re-logging-in / asking for
					// OTP codes, and to stop and ask for re-login when expired.
					isScheduledRun: conversationId.startsWith("sched:"),
				}),
				model: this.buildModel(supplier, modelId),
				tools: buildTools({ kbEnabled: cfg.kb.enabled, learnEnabled: cfg.kb.learn.enabled, manageEnabled: cfg.kb.manage.enabled, researchEnabled: cfg.kb.research.enabled, browserEnabled: cfg.browser.enabled, schedulerEnabled: cfg.scheduler.enabled, documentsEnabled: cfg.documents.enabled, filesystemEnabled: cfg.filesystem.enabled, reportsEnabled: cfg.reports.enabled, downloadsEnabled: cfg.downloads.enabled, knowledge: this.knowledge, browser: this.browser, scheduler: this.scheduler, documents: this.documents, filesystem: this.filesystem, reportService: this.reportService, downloadService: this.downloadService, skillWriter: this.skillWriter, userSkillsDir: this.paths.userSkillsDir, config: this.config, resolveActor: (cid) => this.turnActor.get(cid), onSkillsChanged: () => this.markSkillsChanged(), onConfigChanged: () => this.markConfigChanged(), listSkills: () => this.listSkills(), updates: this.updates, playwrightCliPath: this.playwrightCliPath, conversationId, isVisionModel: () => this.sessions.get(conversationId)?.state.model.input.includes("image") ?? false, resolveFileSender: (cid) => this.turnSendFile.get(cid), resolveImageSender: (cid) => this.turnSendImage.get(cid), screenshotDir: async () => { try { return await this.downloadService.dir(); } catch { return undefined; } } }),
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
		(agent as Agent & { __skillsRevision?: number }).__skillsRevision = this.skillsRevision;
		this.sessions.set(conversationId, agent);
		return agent;
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

	/** Mark cached sessions stale after a prompt/tool/config change. The current
	 * in-flight turn is allowed to finish; its next inbound message rebuilds the
	 * Agent from the newly-persisted config. */
	markConfigChanged(): void {
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
			return originalPrompt(...args);
		}) as typeof agent.prompt;

		target.createLoopConfig = (opts?: unknown) => {
			const config = originalCreateLoopConfig(opts) as Record<string, unknown>;
			config.shouldStopAfterTurn = (context: { toolResults?: unknown[] }) => {
				// The SDK invokes this hook after every assistant response, including a
				// normal text-only final answer. Only responses that actually executed
				// tools count as tool-loop steps.
				if (!context.toolResults?.length) return false;
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
		// Persist the user turn. Images ride along for THIS turn only (they go to the
		// live model, not the text transcript), so mark them in the stored line.
		const imageNote = ctx?.images?.length ? `\n[附带 ${ctx.images.length} 张图片]` : "";
		this.history.appendMessage(conversationId, "user", message + imageNote);
		ctx?.onPersist?.(conversationId); // user turn now persisted → refresh this conversation live

		// Expose the channel's file-sender to the provide_document tool for this
		// turn only (cleared in the finally below). Tools resolve it live via the
		// closure passed into buildTools.
		if (ctx?.sendFile) this.turnSendFile.set(conversationId, ctx.sendFile);
		if (ctx?.sendImage) this.turnSendImage.set(conversationId, ctx.sendImage);
		if (ctx?.actor) this.turnActor.set(conversationId, { ...ctx.actor, text: message });

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
		try {
			await this.promptWithRetry(agent, message, ctx?.images);
		} catch (err) {
			hardError = err instanceof Error ? err.message : String(err);
			console.error(`[engine] prompt failed for ${conversationId}:`, err);
		} finally {
			unsubscribe();
			this.turnSendFile.delete(conversationId);
			this.turnSendImage.delete(conversationId);
			this.turnActor.delete(conversationId);
		}

		const errorMessage = agent.state.errorMessage;

		// TOOL-LOOP SAFETY CAP — if the SDK ended the turn early because maxToolSteps
		// was reached, the model was mid-task and likely left a narration ("正在登录...")
		// rather than an outcome. Force a no-tools final summary so the user gets a
		// clear status (what succeeded, what's left, what they need to provide).
		if (this.toolStepCapHit(agent) && !hardError) {
			const capSummary = await this.finalSummary(agent);
			const max = this.config.all().general.maxToolSteps ?? 0;
			reply = capSummary || `⚠️ 本轮已达到工具调用上限（${max} 步），系统已停止继续调用工具。当前任务可能尚未完成，请提高上限后重试，或把任务拆成更小的步骤。`;
		}

		// GUARANTEED FINAL REPLY — a virtual employee must always answer, success or
		// failure. The turn may end with no visible text (task failed, relay cut the
		// stream, model ended on a thinking-only message). In that case ask the model
		// for a plain-language outcome summary first; it knows what it tried.
		if (!reply.trim() && !hardError) {
			const summary = await this.finalSummary(agent);
			if (summary) reply = summary;
		}

		// Last resort: model/relay unreachable or still empty — emit a deterministic
		// reply so the user is never left waiting in silence.
		if (!reply.trim()) {
			reply = this.deterministicFailure(hardError || errorMessage);
			console.warn(`[engine] no reply produced for ${conversationId}; emitted deterministic failure (${hardError || errorMessage || "no error reported"})`);
		}

		reply = reply.trim();
		this.history.appendMessage(conversationId, "assistant", reply);
		ctx?.onPersist?.(conversationId); // assistant reply now persisted → refresh this conversation live

		// Context management: summarize old turns once the transcript approaches
		// the model's context window (IM chats run indefinitely). Best-effort —
		// compaction must never break message delivery.
		try {
			await maybeCompact(agent, this.models);
		} catch (err) {
			console.warn("[engine] compaction failed:", err);
		}

		return { reply, error: hardError ?? (errorMessage || undefined) };
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
			await agent.prompt("现在请不要调用任何工具，直接用一段简明的中文总结：你刚才为完成用户请求做了哪些尝试？最终是成功还是失败？如果没成功，具体卡在哪一步、需要用户怎么配合或提供什么？只输出这段总结。");
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
	private async promptWithRetry(agent: Agent, message: string, images?: { data: string; mimeType: string }[]): Promise<void> {
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
			if (!TRANSIENT_STREAM_ERROR.test(text)) throw err;
			threwTransient = true;
		}
		const errorText = agent.state.errorMessage ?? "";
		const endedEmpty = this.endedWithoutText(agent);
		if (!threwTransient && !(errorText && TRANSIENT_STREAM_ERROR.test(errorText)) && !endedEmpty) return;

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

	/** True when no agent is mid-turn — the updater's "safe to restart" signal. */
	isIdle(): boolean {
		for (const [, agent] of this.sessions) {
			if (agent.state.isStreaming) return false;
		}
		return true;
	}

	isReadOnlyConversation(conversationId: string): boolean {
		return this.history.isReadOnly(conversationId);
	}
}
