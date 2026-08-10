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
import { EchoAdapter } from "./adapters/echo.js";
import { DingtalkAdapter } from "./adapters/dingtalk.js";
import type { IMAdapter, IMIO } from "./types.js";

/** channel type → factory. Add more real channels (feishu/wecom/…) here. */
const REGISTRY = new Map<string, () => IMAdapter>([
	["echo", () => new EchoAdapter()],
	["dingtalk", () => new DingtalkAdapter()],
]);

export function availableChannels(): string[] {
	return [...REGISTRY.keys()];
}

export class IMAdapterManager {
	private readonly active = new Map<string, IMAdapter>();
	/** Last config applied per channel id — used to detect credential changes. */
	private readonly applied = new Map<string, ImChannelConfig>();
	/** Notified after an inbound message is stored, so the UI can refresh the task list. */
	private onActivity?: (conversationId: string) => void;

	constructor(
		private readonly engine: EmployeeEngine,
		private readonly config: ConfigStore,
	) {}

	/** Inject the UI-refresh callback (main process wires it to a webContents.send). */
	setOnActivity(fn: (conversationId: string) => void): void {
		this.onActivity = fn;
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
			const adapter = factory();
			try {
				await adapter.start(this.makeIO(), {
					channel: ch.type,
					appId: ch.appId,
					appSecret: ch.appSecret,
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
			handle: (msg, ctx) =>
				this.serialize(msg.conversationId, async () => {
					// IM slash commands (OpenClaw-style): /models, /model <n|id>
					const cmd = parseCommand(msg.text);
					if (cmd) return this.runCommand(msg.conversationId, cmd);

					const agent = this.engine.getOrCreateSession(msg.conversationId);

					// Long-task progress heartbeat: every `longTaskProgressMin` while a
					// turn is still running, push a brief progress note to the channel.
					// IM only — real adapters provide ctx.onProgress; the console/HTTP
					// path does not. Repeats until the turn finishes (cleared in finally).
					const onProgress = ctx?.onProgress;
					const progressMin = this.config.all().general.longTaskProgressMin;
					const heartbeat = progressMin > 0 && onProgress
						? setInterval(() => {
							const note = this.engine.briefProgress(agent);
							void onProgress(note).catch((err) => console.warn("[im] progress push failed:", (err as Error).message));
						}, progressMin * 60_000)
						: undefined;

					try {
						const result = await this.engine.send(
							agent,
							msg.text,
							{ sendFile: ctx?.sendFile, onPersist: (id) => this.onActivity?.(id) },
						);
						// Final turn complete — signal the UI to refresh the task list.
						this.onActivity?.(msg.conversationId);
						if (!result.reply) {
							console.error(`[im] no reply for ${msg.conversationId}:`, result.error ?? "(no error reported)");
							// Never go silent on the channel — surface a short error so the
							// user sees what failed (quota, network, bad key, …) instead of nothing.
							return `⚠️ 抱歉,处理失败:${friendlyError(result.error)}`;
						}
						return result.reply;
					} finally {
						if (heartbeat) clearInterval(heartbeat);
					}
				}),
			};
	}

	/** Handle /models and /model commands, returning a text reply for the channel. */
	private runCommand(
		conversationId: string,
		cmd: { name: "models" } | { name: "model"; arg: string },
	): string {
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

		// /model <arg>
		const arg = cmd.arg.trim();
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

/** Whether the adapter must be restarted (credentials/type changed). */
function credChanged(prev: ImChannelConfig | undefined, next: ImChannelConfig): boolean {
	if (!prev) return true;
	return prev.type !== next.type || prev.appId !== next.appId || prev.appSecret !== next.appSecret;
}

function parseCommand(text: string): { name: "models" } | { name: "model"; arg: string } | null {
	const t = text.trim();
	if (t === "/models" || t === "/model") return { name: "models" };
	const m = /^\/model\s+(.+)$/.exec(t);
	if (m) return { name: "model", arg: m[1] };
	return null;
}
