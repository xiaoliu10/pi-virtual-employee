/**
 * IMAdapterManager — reads IM config and runs the matching adapters.
 *
 * Multiple channels may run concurrently: each configured, enabled channel in
 * `im.channels` gets its own adapter instance keyed by channel id. Wires
 * inbound messages into the employee: handle(msg) → engine.send(...) → reply.
 * Call `sync()` after config changes (and once on boot) to reconcile running
 * adapters with saved settings (start new, stop removed/disabled, restart on
 * credential change).
 */
import type { ConfigStore, ImChannelConfig } from "../db/config-store.js";
import type { EmployeeEngine, ModelOption } from "../engine/engine.js";
import type { ReportService } from "../reports/report-service.js";
import { EchoAdapter } from "./adapters/echo.js";
import { DingtalkAdapter } from "./adapters/dingtalk.js";
import type { IMAdapter, IMIO, InboundActor } from "./types.js";
import { looksLikeCommandAttempt, parseCommand, type ParsedCommand } from "./commands.js";
import { diag } from "./diag.js";
import { CAPABILITY_LABEL, checkPermission, describeAccess, isAdmin } from "../security/permissions.js";
import { maskId } from "../engine/tools/admin.js";
import { isAuthorizationPhrase } from "../engine/authorization.js";
import { startStallWatchdog } from "./watchdog.js";

/** Shared deps handed to adapter factories that need them (e.g. image hosting). */
export interface AdapterDeps {
	reportService?: ReportService;
}

/** channel type → factory. Add more real channels (feishu/wecom/…) here. */
const REGISTRY = new Map<string, (deps: AdapterDeps) => IMAdapter>([
	["echo", () => new EchoAdapter()],
	["dingtalk", (deps) => new DingtalkAdapter(deps.reportService)],
]);

export function availableChannels(): string[] {
	return [...REGISTRY.keys()];
}

export class IMAdapterManager {
	private readonly active = new Map<string, IMAdapter>();
	/** Last config applied per channel id — used to detect credential changes. */
	private readonly applied = new Map<string, ImChannelConfig>();
	/** Update installs drain inbound work: new IM turns get a short maintenance reply. */
	private draining = false;
	/** Notified after an inbound message is stored, so the UI can refresh the task list. */
	private onActivity?: (conversationId: string) => void;
	/** Main-process restart hook (relaunch + exit), wired by electron/main. */
	private onRestart?: () => void;

	constructor(
		private readonly engine: EmployeeEngine,
		private readonly config: ConfigStore,
		private readonly deps: AdapterDeps = {},
	) {}

	/** Inject the UI-refresh callback (main process wires it to a webContents.send). */
	setOnActivity(fn: (conversationId: string) => void): void {
		this.onActivity = fn;
	}

	/** Inject the app-restart callback (main process wires it to relaunch+exit). */
	setOnRestart(fn: () => void): void {
		this.onRestart = fn;
	}

	/** Pause/resume new IM turns while an app update is about to restart. */
	setDraining(draining: boolean): void {
		this.draining = draining;
	}

	/** Reconcile running adapters with the current config. */
	async sync(): Promise<void> {
		const c = this.config.all();

		if (!c.im.enabled) {
			await this.stopAll();
			return;
		}

		const desired = new Map<string, ImChannelConfig>();
		for (const ch of c.im.channels) {
			if (ch.enabled) desired.set(ch.id, ch);
		}

		// Stop removed / disabled / credential-changed adapters.
		for (const [id, adapter] of [...this.active.entries()]) {
			const next = desired.get(id);
			if (!next || credChanged(this.applied.get(id), next)) {
				try {
					await adapter.stop();
				} catch (err) {
					console.warn(`[im] stop channel ${id} failed:`, (err as Error).message);
				}
				this.active.delete(id);
				this.applied.delete(id);
			}
		}

		// Start newly-desired adapters.
		for (const [id, ch] of desired) {
			if (this.active.has(id)) continue;
			const factory = REGISTRY.get(ch.type);
			if (!factory) {
				console.log(`[im] no adapter registered for type "${ch.type}" (channel ${id})`);
				continue;
			}
			const adapter = factory(this.deps);
			try {
				await adapter.start(this.makeIO(), {
					channel: ch.type,
					appId: ch.appId,
					appSecret: ch.appSecret,
					cardTemplateId: ch.cardTemplateId,
					ack: c.im.ack,
				});
				this.active.set(id, adapter);
				this.applied.set(id, ch);
			} catch (err) {
				console.error(`[im] start channel ${id} (${ch.type}) failed:`, (err as Error).message);
			}
		}
	}

	async stopAll(): Promise<void> {
		for (const adapter of this.active.values()) {
			try {
				await adapter.stop();
			} catch (err) {
				console.warn("[im] stop failed:", (err as Error).message);
			}
		}
		this.active.clear();
		this.applied.clear();
	}

	/**
	 * Proactively push a message to a conversation (e.g. a scheduled-task result).
	 * Routes by conversation-id prefix to the matching active adapter. Returns
	 * ok:false when no active channel can push to that conversation (e.g. console /
	 * http conversations), so the caller can simply log.
	 */
	async pushToConversation(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }> {
		const adapter = this.adapterFor(conversationId);
		if (!adapter?.push) return { ok: false, error: `没有可推送到 ${conversationId} 的在线渠道` };
		return adapter.push(conversationId, text);
	}

	/** Map an app-internal conversation id to the active adapter that owns it. */
	private adapterFor(conversationId: string): IMAdapter | undefined {
		// "dt:" ids belong to the dingtalk channel. Add more prefix→channel mappings
		// here as new adapters ship.
		if (conversationId.startsWith("dt:")) return this.findByChannel("dingtalk");
		return undefined;
	}

	private findByChannel(channel: string): IMAdapter | undefined {
		return [...this.active.values()].find((a) => a.channel === channel);
	}

	/**
	 * Per-conversation serialization. The underlying Agent throws if prompt() is
	 * called while a turn is still running, so rapid IM messages on the same
	 * chat (or a slow model turn) would otherwise be rejected. This queues them
	 * and runs them one at a time per conversation.
	 */
	private readonly chains = new Map<string, Promise<unknown>>();
	private serialize<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(conversationId) ?? Promise.resolve();
		// Run `fn` once the previous turn settles (success or failure).
		const run = prev.then(fn, fn);
		// Keep the chain alive without surfacing its rejection to the next link.
		this.chains.set(conversationId, run.then(noop, noop));
		return run;
	}

	/** Build the inbound-message IO shared by every adapter. */
	private makeIO(): IMIO {
		return {
			handle: (msg, ctx) => {
				// /stop aborts the in-flight turn WITHOUT wiping context — also
				// outside the queue, same reason as /new (a wedged turn must not
				// block its own escape hatch).
				const inbound = parseCommand(msg.text);
				if (inbound?.name === "stop") {
					const aborted = this.engine.abortSession(msg.conversationId);
					return Promise.resolve(
						aborted
							? "⏹️ 已中断当前回合（上下文保留）。需要彻底清空上下文请发 /new。"
							: "当前没有正在进行的回合。",
					);
				}
				// /new bypasses the per-conversation queue on purpose: a wedged
				// in-flight turn would otherwise block this command forever.
				// Abort the live agent FIRST (unblocks the queue), then run the
				// wipe enqueued at the BACK of the chain so it lands after the
				// dead turn's final persistence.
				if (inbound?.name === "new") {
					if (this.draining) {
						return Promise.resolve("⏳ 系统正在安装应用更新，当前消息不会被执行；请稍后重新发送。");
					}
					const aborted = this.engine.abortSession(msg.conversationId);
					return this.serialize(msg.conversationId, async () => {
						this.engine.resetSession(msg.conversationId);
						return aborted
							? "🆕 已中断进行中的回合，新会话已开启（上下文清空，模型设置保留）。直接说你的需求即可。"
							: "🆕 新会话已开启（上下文清空，模型设置保留）。";
					});
				}
				return this.serialize(msg.conversationId, async () => {
					if (this.draining) {
						return "⏳ 系统正在安装应用更新，当前消息不会被执行；请稍后重新发送。";
					}
					// Record the sender in this conversation's roster BEFORE any gate:
					// the roster is how an admin later says "给这个群的人设权限" without
					// knowing staffIds, so it must include senders we refuse to serve
					// (a viewer's refusal must not hide them from the roster). Rows are
					// keyed on the platform-verified id, never on message text.
					this.engine.recordConversationMember(msg.conversationId, msg.actor);
					// IM slash commands (OpenClaw-style): /help /new /stop /restart /version /models /model <n|id>
					if (inbound) {
						// /new and /stop were already handled above (they must not queue).
						return this.runCommand(msg.conversationId, inbound, msg.actor, msg.text);
					}
					// A slash word we do not recognise: log the raw text once. The point
					// is that the NEXT "命令不生效" report can be answered from the log
					// instead of guessed at — the client's exact serialization of a
					// mention is not something we control.
					if (looksLikeCommandAttempt(msg.text)) {
						void diag("commands", `unrecognised command attempt conv=${msg.conversationId} raw=${JSON.stringify(msg.text.slice(0, 120))}`, "warn");
					}

					// Conversation admission floor (RBAC): a conversation may RAISE the
					// minimum role needed to be served at all (security.conversations
					// floors.chat). Checked server-side on the platform-verified actor —
					// message text can never influence it.
					const admission = checkPermission(this.config, msg.actor, msg.conversationId, "chat");
					if (!admission.ok) return admission.reason;

					// Admin one-shot authorization — deterministic, no model turn:
					// exactly 「确认授权」 answers a pending role-refusal request.
					// Only a platform-verified admin counts; the engine checks.
					if (isAuthorizationPhrase(msg.text)) {
						return await this.engine.confirmAuthorization(msg.conversationId, msg.actor, msg.conversationName);
					}

					const agent = this.engine.getOrCreateSession(msg.conversationId);

					// Long-task progress heartbeat: every `longTaskProgressMin` while a
					// turn is still running, push a brief progress note to the channel.
					// IM only — real adapters provide ctx.onProgress; the console/HTTP
					// path does not. Repeats until the turn finishes (cleared in finally).
					// The note comes from a side-channel LLM pass (progressBrief) for a
					// concrete ≤100-char progress report; if the turn settles while the
					// summary is in flight, the stale "仍在进行中" is dropped.
					const onProgress = ctx?.onProgress;
					const progressMin = this.config.all().general.longTaskProgressMin;
					let progressInFlight = false;
					const heartbeat = progressMin > 0 && onProgress
						? setInterval(() => {
							if (progressInFlight) return;
							progressInFlight = true;
							void this.engine.progressBrief(agent)
								.then((note) => {
									if (agent.state.isStreaming) return onProgress(note);
								})
								.catch((err) => console.warn("[im] progress push failed:", (err as Error).message))
								.finally(() => {
									progressInFlight = false;
								});
						}, progressMin * 60_000)
						: undefined;
					// Turn watchdog — STALL-based (0.2.73): the per-conversation queue is
					// strict, so ONE wedged turn (hung LLM call / hung socket / hung
					// remote session) would block that chat forever — field incident: a
					// group went silent while single chats kept working, and only an app
					// restart cleared it. The old fixed timer measured TOTAL turn time
					// and killed healthy long tasks (field feedback 2026-09-17); this one
					// fires only after `turnTimeoutMin` of ZERO activity — a live task
					// never trips it no matter how long it runs. True wedges (hung
					// sockets, hung remote sessions) can't be unstuck in-process — abort
					// is the release; context-size trouble never gets here because the
					// in-turn budget gate compacts and continues.
					const turnTimeoutMin = this.config.all().general.turnTimeoutMin ?? 0;
					let turnTimedOut = false;
					const watchdog = turnTimeoutMin > 0
						? startStallWatchdog({
							thresholdMs: turnTimeoutMin * 60_000,
							activityAgeMs: () => this.engine.turnIdleMs(msg.conversationId),
							onStall: () => {
								turnTimedOut = true;
								console.warn(`[im] turn silent for ${turnTimeoutMin}min — aborting: ${msg.conversationId}`);
								this.engine.markTurnAbort(msg.conversationId, "watchdog");
								this.engine.abortSession(msg.conversationId);
							},
						})
						: undefined;

					try {
						const result = await this.engine.send(
							agent,
							msg.text,
							{ sendFile: ctx?.sendFile, sendImage: ctx?.sendImage, images: msg.images, actor: msg.actor, conversationName: msg.conversationName, onPersist: (id) => this.onActivity?.(id) },
						);
						// Final turn complete — signal the UI to refresh the task list.
						this.onActivity?.(msg.conversationId);
						if (turnTimedOut) {
							return `⏱️ 本回合已连续 ${turnTimeoutMin} 分钟无任何进展（疑似卡死），已自动中断以解除会话阻塞。请重新发送指令重试；若反复出现，请把任务拆小或分步执行，并联系管理员查看日志定位卡点。`;
						}
						if (!result.reply) {
							console.error(`[im] no reply for ${msg.conversationId}:`, result.error ?? "(no error reported)");
							// Never go silent on the channel — surface a short error so the
							// user sees what failed (quota, network, bad key, …) instead of nothing.
							return `⚠️ 抱歉,处理失败:${friendlyError(result.error)}`;
						}
						return result.reply;
					} finally {
						if (heartbeat) clearInterval(heartbeat);
						if (watchdog) watchdog.stop();
					}
				});
			},
		};
	}

	/** Handle deterministic slash commands, returning a text reply for the channel. */
	private runCommand(
		conversationId: string,
		cmd: ParsedCommand,
		actor?: InboundActor,
		userText?: string,
	): string | Promise<string> {
		if (cmd.name === "new" || cmd.name === "stop") {
			// Intercepted in makeIO (they must bypass the queue). Reaching here would
			// mean the interception was bypassed — say so instead of silently doing
			// nothing, which is exactly the failure this module was written for.
			console.error(`[im] ${cmd.name} reached runCommand — interception bypassed`);
			return `⚠️ 命令 /${cmd.name} 未能生效（内部路由异常）。请重发一次；若仍无效请反馈这条消息。`;
		}
		if (cmd.name === "help") {
			return [
				"可用命令：",
				"/new — 中断当前回合并清空上下文，开启新会话（群聊里 @ 我 /new 同样有效）",
				"/compact — 压缩上下文（较早对话汇总为摘要，近期对话保留）",
				"/stop — 中断当前回合（上下文保留）",
				"/perm — 查看我在当前会话的权限（角色 + 各项能力是否放行）",
				"/restart — 重启应用（仅管理员，单聊）",
				"/version — 查看应用版本",
				"/models — 列出可用模型",
				"/model <序号或模型名> — 切换模型",
			].join("\n");
		}
		if (cmd.name === "perm") {
			const summary = describeAccess(this.config, actor, conversationId);
			const who = summary.local || !actor
				? "本机控制台会话（等同管理员）"
				: `${actor.senderName ? `${actor.senderName}（` : ""}${actor.senderId ? maskId(actor.senderId) : "身份未知"}${actor.senderName ? "）" : ""}`;
			const detail = Object.entries(CAPABILITY_LABEL)
				.map(([key, label]) => `${checkPermission(this.config, actor, conversationId, key).ok ? "✅" : "⛔"} ${label}`)
				.join("；");
			return (
				`当前身份：${who}；本会话有效角色：${summary.role}\n` +
				`能力明细：${detail}\n` +
				(summary.denied.length ? "被拒的能力请联系管理员开通（管理员在单聊中使用 manage_access）。" : "你当前拥有本会话的全部能力。")
			);
		}
		if (cmd.name === "restart") {
			// Same authorization model as admin identity tools: admin role,
			// 1:1 only (a group has no reliable notion of who is allowed).
			if (!actor || actor.chatType !== "single") return "⛔ /restart 仅限管理员在单聊中使用。";
			if (!isAdmin(this.config, actor.senderId)) return "⛔ 仅管理员可以重启应用。";
			if (!this.onRestart) return "当前运行方式不支持 IM 重启。";
			// Let the reply flush to the channel before the process exits.
			setTimeout(() => this.onRestart?.(), 1200);
			return "🔄 收到，应用将在 1~2 秒后自动重启（进程退出并自动拉起）。半分钟后即可继续使用。";
		}
		if (cmd.name === "compact") {
			return this.engine.compactSession(conversationId);
		}
		if (cmd.name === "version") {
			return `当前应用版本：v${this.engine.appVersion()}。发送 /help 查看全部命令；发送 /new 可清空上下文开启新会话。`;
		}

		const options = this.engine.availableModels();
		if (options.length === 0) {
			return "尚未启用任何可用模型,请在应用「设置 → 模型服务」中启用供应商并添加模型。";
		}

		if (cmd.name === "models") {
			const conv = this.engine.getOrCreateSession(conversationId);
			const current = conv.state.model;
			return [
				"可用模型(序号 / 供应商 / 模型):",
				...options.map((o, i) => {
					const here = o.modelId === current.id ? " ← 当前" : "";
					const star = o.isDefault ? " ★默认" : "";
					return `${i + 1}. ${o.supplierName} / ${o.modelId}${star}${here}`;
				}),
				"切换:/model <序号 或 模型名>",
			].join("\n");
		}

		// /model <arg> — parseCommand only yields {name:"model"} when an arg exists.
		const arg = (cmd.arg ?? "").trim();
		let target: ModelOption | undefined = options[parseInt(arg, 10) - 1];
		if (!target) {
			// match by modelId, or "supplierId/modelId"
			target =
				options.find((o) => `${o.supplierId}/${o.modelId}` === arg) ??
				options.find((o) => o.modelId === arg);
		}
		if (!target) return `未找到模型「${arg}」。发送 /models 查看列表。`;
		try {
			this.engine.setConversationModel(conversationId, target.supplierId, target.modelId);
			return `已切换为 ${target.supplierName} / ${target.modelId}。`;
		} catch (err) {
			return `切换失败:${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/** Test hook: push a message through the echo channel adapter (if running). */
	async simulate(conversationId: string, text: string): Promise<string> {
		const echo = [...this.active.values()].find((a): a is EchoAdapter => a instanceof EchoAdapter);
		if (!echo) throw new Error("no echo channel is active");
		return echo.simulate(conversationId, text);
	}
}

/** Swallow a promise result so a rejected link doesn't break the chain. */
const noop = (): void => {};

/** Shorten a raw error string for display in an IM reply (unwrap JSON `{error:{message}}`). */
function friendlyError(err: string | undefined): string {
	if (!err) return "未知错误,请稍后重试";
	try {
		const parsed = JSON.parse(err) as { error?: { message?: string }; message?: string };
		const msg = parsed?.error?.message ?? parsed?.message;
		if (msg) return msg;
	} catch {
		// not JSON — fall through
	}
	return err.length > 200 ? err.slice(0, 200) + "…" : err;
}

/** Whether the adapter must be restarted (credentials/type/template changed). */
function credChanged(prev: ImChannelConfig | undefined, next: ImChannelConfig): boolean {
	if (!prev) return true;
	return (
		prev.type !== next.type ||
		prev.appId !== next.appId ||
		prev.appSecret !== next.appSecret ||
		(prev.cardTemplateId ?? "") !== (next.cardTemplateId ?? "")
	);
}

/* Command recognition lives in ./commands.js — one tolerant parser shared with the
 * adapters, so "@机器人/new", "／new" and multi-line mentions all work. */
