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
import { decidePump, isUsableBrief, prunePumpState, type PumpState } from "../scheduler/progress-pump.js";
import { resolveOrigin, type WorkOrigin } from "../scheduler/work-origin.js";
import type { EmployeeEngine, ModelOption } from "../engine/engine.js";
import type { ReportService } from "../reports/report-service.js";
import { EchoAdapter } from "./adapters/echo.js";
import { DingtalkAdapter } from "./adapters/dingtalk.js";
import type { IMAdapter, IMIO, InboundActor } from "./types.js";
import { isCancelPhrase, looksLikeCommandAttempt, parseCommand, type ParsedCommand } from "./commands.js";
import { diag } from "./diag.js";
import { CAPABILITY_LABEL, checkPermission, describeAccess, isAdmin, isDeclaredAdmin } from "../security/permissions.js";
import { maskId } from "../engine/tools/admin.js";
import { isAuthorizationPhrase } from "../engine/authorization.js";
import { startStallWatchdog } from "./watchdog.js";
import { splitForPush } from "./chunks.js";
import { gateOutboundText } from "./credential-egress.js";
import { isForegroundEscape, triageMessage } from "./triage.js";
import { chatHeartbeatOccurrenceId, DeliveryLedger } from "./delivery-ledger.js";
import type { AdapterCapabilities, AdapterHealth, InboundMessage } from "./types.js";

/** Shared deps handed to adapter factories that need them (e.g. image hosting). */
export interface AdapterDeps {
	reportService?: ReportService;
	/** Where inbound files received from channels are stored. */
	inboundDir?: string;
	/**
	 * LIVE admin check used by the credential egress gate: a 1:1 recipient who
	 * is an admin right now may see credential-bearing text; everyone else
	 * (and every group) gets it withheld. Absent ⇒ no exemption.
	 */
	isAdminRecipient?: (staffId: string) => boolean;
	/**
	 * Push ledger (docs/design/delivery-reliability.md S1). When present, a push
	 * carrying an occurrence id is deduplicated against every earlier delivery
	 * OF THAT OCCURRENCE — including one made by a previous process. Absent ⇒
	 * pushes behave exactly as before (no identity, no bookkeeping).
	 */
	ledger?: DeliveryLedger;
}

/**
 * Identity of ONE delivery occurrence. Callers supply it where the push is
 * triggered by a known event (a scheduler fire, an inbound message); omitting it
 * leaves the old, un-ledgered behaviour fully intact.
 */
export interface PushOptions {
	occurrenceId?: string;
	/** Audit-only label stored on the ledger row ('scheduled' | 'chat' | …). */
	kind?: string;
}

/**
 * Result of a proactive push. `skipped` means the ledger already recorded this
 * occurrence as delivered and NOTHING was sent (callers must not treat it as a
 * failure). `error` is present only when ok is false.
 */
export interface PushResult {
	ok: boolean;
	error?: string;
	skipped?: boolean;
	/** Set when the ledger adopted a row a previous run left mid-flight: the
	 *  delivery may have already reached the user (honest at-least-once). */
	recovered?: boolean;
	/** The delivery may or may not have reached the user (a previous attempt crashed
	 *  mid-send). Callers must NOT retry automatically; surface it for a human. */
	uncertain?: boolean;
}

/** channel type → factory. Add more real channels (feishu/wecom/…) here. */
const REGISTRY = new Map<string, (deps: AdapterDeps) => IMAdapter>([
	["echo", () => new EchoAdapter()],
	// The adapter needs a LIVE admin check for single-chat exemptions, so it is
	// built through the manager's factory below rather than the static map.
	["dingtalk", (deps) => new DingtalkAdapter(deps.reportService, deps.inboundDir, deps.isAdminRecipient)],
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

	/**
	 * Push into a chat under an occurrence identity (ledger-backed): the same
	 * inbound message may only deliver one progress note, even across restarts.
	 */
	async pushToChat(conversationId: string, text: string, occurrenceId: string, kind = "chat"): Promise<PushResult> {
		return this.pushToConversation(conversationId, text, { occurrenceId, kind });
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
			// Mid-turn pushes ride the manager's delivery path (single gate + ledger).
			adapter.onPush = (cid, text, occurrenceId, kind) => this.pushToConversation(cid, text, { occurrenceId, kind });
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
	 *
	 * With `opts.occurrenceId` the delivery is recorded in the push ledger: an
	 * occurrence already delivered (in THIS run or a previous one) returns
	 * { ok:true, skipped:true } without sending, and a failed attempt stays
	 * retryable under the same id. Without it, behaviour is unchanged.
	 */
	/**
	 * 「前台执行」escape hatch (router-worker design D6): pull a chat-dispatched
	 * item back into the foreground.
	 *
	 * Convertible = dispatched FROM THIS conversation BY THIS sender (creator
	 * only — another group member must not cancel someone else's task) and
	 * still queued (not yet claimed) or scheduled (a window ended with a next
	 * check). A WORKING item is refused honestly: its window is already
	 * executing, so a foreground rerun would double-execute the work.
	 *
	 * Returns the ORIGINAL instruction to re-run inline (the goal preserves it
	 * under [用户原始指令]), or a notice when nothing is convertible.
	 * undefined = the message is not the escape phrase at all.
	 */
	private takeForegroundEscape(msg: InboundMessage): { original: string; notice?: string } | undefined {
		if (!isForegroundEscape(msg.text)) return undefined;
		const store = this.engine.workItems;
		if (!store) return { original: "", notice: "当前没有可切换的前台任务（工作列表不可用）。" };
		const convertible = store.list()
			.filter((r) => r.origin_conversation === msg.conversationId
				// Structured origin first (2026-11-05): the note is a claim, not
				// evidence — a row marked injected must not be escaped however its
				// note reads. Legacy rows (no column) resolve through the same sniff
				// this check used to do, so pre-migration items stay convertible.
				&& resolveOrigin({ origin: (r.origin ?? null) as WorkOrigin | null, originNote: r.origin_note }) === "chat"
				&& (r.created_by ?? null) === (msg.actor?.senderId ?? null)
				&& (r.status === "queued" || r.status === "scheduled"))
			.sort((a, b) => b.created_at - a.created_at)[0];
		if (!convertible) {
			return { original: "", notice: "没有可切换到前台的后台任务：只有仍排队或已计划下次跟进、且由你本人转派的任务可以切换；正在执行中的任务请先在控制台取消后再重新发送指令。" };
		}
		const marker = "[用户原始指令]\n";
		const idx = (convertible.goal ?? "").lastIndexOf(marker);
		const original = idx >= 0 ? convertible.goal.slice(idx + marker.length).trim() : "";
		store.cancel(convertible.id);
		console.log(`[im] foreground escape: cancelled item=${convertible.id} conv=${msg.conversationId} by=${msg.actor?.senderId ?? "?"}`);
		return { original };
	}

	/**
	 * Router → Worker dispatch (docs/design/router-worker.md P1).
	 *
	 * Returns the ACK text when the message was handed to a background work
	 * item, or undefined to let the caller run it inline. The triage itself is
	 * pure (src/im/triage.ts) and conservative: no plan / <2 numbered steps / a
	 * question shape / no long-running verb / dispatch disabled → inline, which
	 * is byte-for-byte the pre-Router behaviour.
	 *
	 * ANY failure while creating the work item returns undefined (inline), so a
	 * broken dispatch can never swallow a message. The work item keeps the
	 * origin conversation, so progress/results push back here (D3/D4).
	 */
	private async tryDispatchToWorker(msg: InboundMessage, plan?: string): Promise<string | undefined> {
		try {
			const cfg = this.config.all();
			// DEFAULT ON: absent means enabled (user ruling 2026-11-04). Only an
			// explicit `enabled: false` restores the old inline behaviour — the
			// same "absent = on" convention as taskPlanning.
			const enabled = cfg.general.chatDispatch?.enabled !== false;
			if (!enabled) return undefined;
			const decision = triageMessage({ text: msg.text, plan, looksLikeTask: true }, true);
			if (!decision.dispatch) {
				console.log(`[im] dispatch triage: inline (${decision.reason}, steps=${decision.steps})`);
				return undefined;
			}
			const store = this.engine.workItems;
			const bridge = this.engine.workBridge;
			if (!store || !bridge) {
				console.log("[im] dispatch triage: inline (work items unavailable)");
				return undefined;
			}
			// Work windows demand a declared-admin creator (WorkService.run gates
			// on created_by; every other creation path goes through adminGate).
			// Dispatching a non-admin would ACK and then immediately park as
			// "管理员身份缺失" — dishonest twice over. Refuse with the real reason
			// (review P1-2).
			if (!isDeclaredAdmin(this.config, msg.actor?.senderId)) {
				console.log(`[im] dispatch triage: inline (non-admin ${msg.actor?.senderId ?? "?"} cannot own a work item)`);
				// MUST return undefined, not the notice: the caller treats a nonempty
				// result as "dispatched" and returns before engine.send — the message
				// would be acknowledged in text and then never executed (review P1-1,
				// field 2026-11-04). The notice is a courtesy push; execution continues
				// inline either way.
				return undefined;
			}
			const title = (msg.text.trim().split(/\r?\n/, 1)[0] ?? "").slice(0, 60) || "聊天转后台任务";
			const item = store.create({
				title,
				// The plan IS the goal: the worker window reads it as the task spec,
				// so what the user was promised is exactly what runs.
				// Without a plan (deep-task path) the worker plans for itself from the
				// raw instruction — better than serializing two jobs in one chat.
				goal: plan ? `${plan}\n\n[用户原始指令]\n${msg.text}` : msg.text,
				originConversation: msg.conversationId,
				originNote: "从聊天转派（Router）",
				// Structured provenance (2026-11-05): Router dispatch is the one origin
				// that may auto-follow-up; the note alone is forgeable text.
				origin: "chat",
				// MUST be "queued": fireItem/listDue/claim only accept queued (or a
				// due scheduled). "working" is a terminal orphan — the real
				// WorkService probe returned false for it while the user already
				// held the "已转后台" ACK, and after a restart recoverWorking()
				// would file it as a FALSE crash-recovery notice (review P0-1).
				status: "queued",
				createdBy: msg.actor?.senderId ?? null,
				createdChannel: msg.actor?.channel ?? null,
				// A user's task jumps the queue: mined/scheduled items default to
				// 100, so a due mining window cannot starve the promised "已转后台".
				priority: 0,
			});
			// Fire immediately so the work starts now rather than at the next tick.
			const fired = bridge.fireItem(item.id);
			console.log(`[im] dispatch triage: WORKER item=${item.id} steps=${decision.steps} fired=${fired} conv=${msg.conversationId}`);
			// NO ACK (user ruling 2026-11-06): in a Router/Worker architecture the
			// Worker owns all user-visible signalling — registration, progress and
			// result all push back to this conversation on their own. A Router-side
			// "已转后台执行" line is a redundant middle layer that only adds noise.
			// The Router's job ends when the item is persisted and fired.
			//
			// The empty string is the "dispatched, say nothing" signal (see the
			// caller): returning undefined would mean "run inline" and the task
			// would execute twice.
			return "";
		} catch (err) {
			// Never let dispatch break the turn: fall back to inline execution.
			console.warn("[im] dispatch failed, running inline:", err instanceof Error ? err.message : err);
			return undefined;
		}
	}

	/**
	 * Turn-settle background-process inventory. ASYNC BY DESIGN (user ruling
	 * 2026-11-04): the settle path never waits on process bookkeeping, and the
	 * note is pushed 5s after the result so it lands AFTER the answer. Field
	 * 2026-11-04: a monitor script kept running after the result was pushed and
	 * nothing told the user — silent strays read as delivery bugs.
	 */
	private inventoryTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * GLOBAL PROGRESS PUMP.
	 *
	 * Heartbeats used to live exclusively inside the inbound-message handler
	 * (a setInterval created when a message arrived). That timer dies with the
	 * process, and after a restart the handler never runs again for the already
	 * consumed message — so no timer is ever recreated, even though durable
	 * happily resumes the WORK. Field 2026-11-04: a reconciliation task ran 1h+
	 * after a restart and produced exactly one progress note before going silent
	 * ("只汇报了一次就停了").
	 *
	 * The pump asks the engine which conversations are BUSY right now and notes
	 * each one on the configured cadence, so reporting survives restarts and does
	 * not depend on how the work started (fresh turn, redriven placed input, or
	 * crash recovery).
	 */
	private readonly pumpState = new Map<string, PumpState>();
	private pumpTimer?: ReturnType<typeof setInterval>;

	/** Start the pump. Idempotent; interval comes from longTaskProgressMin. */
	startProgressPump(): void {
		if (this.pumpTimer) return;
		const intervalMs = (this.config.all().general.longTaskProgressMin ?? 0) * 60_000;
		if (intervalMs <= 0) return; // explicitly disabled
		// Tick often relative to the cadence so a conversation that just became due
		// is noticed promptly; decidePump() enforces the real interval per chat.
		const tickMs = Math.max(30_000, Math.min(intervalMs, 5 * 60_000));
		this.pumpTimer = setInterval(() => this.pumpTick(), tickMs);
		// Never hold the process open for a heartbeat.
		this.pumpTimer.unref?.();
	}

	stopProgressPump(): void {
		if (this.pumpTimer) clearInterval(this.pumpTimer);
		this.pumpTimer = undefined;
		this.pumpState.clear();
	}

	private pumpTick(): void {
		try {
			const intervalMs = (this.config.all().general.longTaskProgressMin ?? 0) * 60_000;
			const busy = this.engine.busyConversations?.() ?? [];
			prunePumpState(this.pumpState, busy);
			const actions = decidePump({ busy, state: this.pumpState, now: Date.now(), intervalMs });
			// Observability (field 2026-11-06: the chat pump has NEVER fired since
			// v0.2.192, with zero log lines anywhere in the chain). A quiet tick
			// every 5min is fine; state transitions always log.
			console.log(`[im] progress pump tick: busy=${busy.length}${busy.length ? ` [${busy.map((b) => b.conversationId).join(",")}]` : ""} actions=${actions.map((a) => `${a.conversationId}:${a.kind}${a.kind === "skip" ? `/${a.reason}` : ""}`).join(",") || "none"}`);
			for (const action of actions) {
				if (action.kind === "fire") {
					console.log(`[im] progress pump FIRE: ${action.conversationId}`);
					void this.pumpOne(action.conversationId, intervalMs);
				} else if (!this.pumpState.has(action.conversationId)) {
					console.log(`[im] progress pump armed (first sighting): ${action.conversationId}`);
					// Arm the clock on first sighting so a restart does not spam a
					// note for every live conversation at once.
					this.pumpState.set(action.conversationId, { lastSentAt: Date.now(), inFlight: false });
				}
			}
		} catch (err) {
			// A pump failure must never break messaging.
			console.warn("[im] progress pump tick failed:", (err as Error).message);
		}
	}

	private async pumpOne(conversationId: string, intervalMs: number): Promise<void> {
		const st = this.pumpState.get(conversationId);
		if (!st || st.inFlight) return;
		st.inFlight = true;
		try {
			console.log(`[im] progress pump brief start: ${conversationId}`);
			const agent = this.engine.getOrCreateSession(conversationId);
			const note = await this.engine.progressBrief(agent, conversationId);
			console.log(`[im] progress pump brief done: ${conversationId} (${note?.length ?? 0} chars)`);
			if (!isUsableBrief(note)) return;
			// Re-check liveness: the brief can take minutes, and the turn may have
			// ended while it was generating (pushing then would be a stale "still
			// working" note).
			if (!this.engine.isConversationStreaming(conversationId)) return;
			const occurrenceId = chatHeartbeatOccurrenceId("pump", conversationId, Date.now(), intervalMs);
			await this.onProgressPush?.(conversationId, note, occurrenceId);
			st.lastSentAt = Date.now();
		} catch (err) {
			console.warn(`[im] progress pump push failed for ${conversationId}: ${(err as Error).message}`);
		} finally {
			st.inFlight = false;
		}
	}

	/** Injected by main.ts: how the pump reaches the IM channel of a conversation. */
	private onProgressPush?: (conversationId: string, text: string, occurrenceId: string) => Promise<unknown>;

	setProgressPusher(fn: (conversationId: string, text: string, occurrenceId: string) => Promise<unknown>): void {
		this.onProgressPush = fn;
	}



	private scheduleBackgroundInventory(conversationId: string): void {
		const prev = this.inventoryTimers.get(conversationId);
		if (prev) clearTimeout(prev);
		const t = setTimeout(() => {
			this.inventoryTimers.delete(conversationId);
			void this.pushBackgroundInventory(conversationId).catch(
				(err) => console.warn("[im] background inventory failed:", (err as Error).message),
			);
		}, 5_000);
		this.inventoryTimers.set(conversationId, t);
	}

	private async pushBackgroundInventory(conversationId: string): Promise<void> {
		const inventory = this.engine.inventoryBackgroundProcesses(conversationId);
		if (!inventory.length) return;
		const lines = inventory.map((p) => `- \`${p.sessionId.slice(0, 8)}\` pid=${p.pid ?? "?"} ${p.command}`);
		const text = `⚠️ **回合收尾盘点**：本会话仍有 ${inventory.length} 个后台进程在运行：\n${lines.join("\n")}\n\n完成后用 manage_process poll 确认退出码；需要立即终止用 manage_process kill。`;
		await this.pushToConversation(conversationId, text);
	}

	async pushToConversation(conversationId: string, text: string, opts: PushOptions = {}): Promise<PushResult> {
		// Derived one-shot tasks (PR #165) carry origin_conversation=work:<parent>:
		// attribution and the derivation cap need that link, but DELIVERY cannot —
		// no IM adapter routes a work: id, so every completion/progress/waiting-human
		// push would fail with "没有可推送到 work:… 的在线渠道" (review P1-1,
		// reproduced). Resolve the chain here, ONCE, at the single entry every
		// worker push funnels through: work:<id> → its item → the item's own
		// origin_conversation → walk until a routable conversation. Cycle- and
		// depth-guarded; failure is loud, never a silent drop.
		// workItems.get is a bare-id SQL lookup (its ids carry no work: prefix) --
		// strip the namespace before handing the id over, or EVERY work: push
		// would fail as "找不到对应任务" (found by test-resolve-push-target with a
		// production-faithful injection; the reviewer probe used a bare-id fake).
		const resolved = resolvePushTarget(conversationId, (id) => this.engine.workItems?.get(id.startsWith("work:") ? id.slice(5) : id));
		if ("error" in resolved) {
			console.warn(`[im] push target unresolvable: ${resolved.error}`);
			return { ok: false, error: resolved.error };
		}
		conversationId = resolved.target;
		const occurrenceId = opts.occurrenceId?.trim();
		// `deps` may be absent on a manager built without a constructor (tests):
		// treat that exactly like "no ledger configured".
		const ledger = this.deps?.ledger;
		if (occurrenceId && ledger) {
			try {
				const claim = ledger.claim(occurrenceId, conversationId, { kind: opts.kind });
				if (claim.skipped) {
					// Same occurrence already delivered — the whole point of the ledger.
					console.log(`[im] delivery skipped (occurrence already delivered): ${occurrenceId} → ${conversationId}`);
					return { ok: true, skipped: true };
				}
				if (claim.uncertain) {
					// A previous process died mid-send. The user may already have the
					// message, so re-sending would be the duplicate this ledger exists to
					// prevent; report uncertainty and let the caller decide (never claim
					// success — that would hide a possible non-delivery).
					console.warn(`[im] delivery uncertain (crashed mid-send, not re-sending): ${occurrenceId} → ${conversationId}`);
					return { ok: false, error: `投递状态未知（上次发送中进程中断，可能已送达）：${occurrenceId}`, uncertain: true };
				}
				const result = await this.deliver(conversationId, text);
				// Below ok:false the SAME occurrence may retry (failed is not terminal).
				if (result.ok) ledger.markDelivered(occurrenceId);
				else ledger.markFailed(occurrenceId, result.error);
				return claim.recovered ? { ...result, recovered: true } : result;
			} catch (err) {
				// Ledger trouble must never swallow a delivery the user is waiting for:
				// fall through to the un-ledgered path (worse: a possible duplicate).
				console.warn(`[im] delivery ledger unavailable, pushing without it: ${(err as Error).message}`);
			}
		}
		return this.deliver(conversationId, text);
	}

	/** The actual chunked send (credential gate → split → per-part push). */
	private async deliver(conversationId: string, text: string): Promise<PushResult> {
		const adapter = this.adapterFor(conversationId);
		if (!adapter?.push) return { ok: false, error: `没有可推送到 ${conversationId} 的在线渠道` };
		// Capability gate: a channel that declares itself non-proactive must not
		// be pushed to even if a future implementation grows a push method.
		if (!adapter.metadata.capabilities.proactive) {
			return { ok: false, error: `渠道「${adapter.metadata.displayName}」不支持主动推送` };
		}
		// Scan the WHOLE text before splitting: a credential that lands across a
		// split boundary would pass each half's per-message check (field incident
		// 2026-10-20 — the leaking message was one long troubleshooting reply).
		// The adapter resolves the destination audience (a verified admin 1:1 is
		// exempt; everything else restricted) and MUST fail closed — any error
		// or missing hook keeps the restricted audience.
		let audience: "admin-single" | "restricted" = "restricted";
		try {
			audience = adapter.egressAudience?.(conversationId) ?? "restricted";
		} catch {
			audience = "restricted";
		}
		text = gateOutboundText(text, audience);
		// Platform message caps (~4000 chars on DingTalk) mean a long report must
		// ride as several messages — split at paragraph boundaries and deliver the
		// full text in order (field 2026-09-20: daily reports hard-cut at 1200).
		const parts = splitForPush(text);
		for (let i = 0; i < parts.length; i += 1) {
			// A bare marker line directly above a table row breaks the table's
			// first block (the renderer needs a blank line before every table).
			// Insert the separating blank line only when the part starts with one.
			const piece = parts.length > 1
				? `【${i + 1}/${parts.length}】\n${/^\s*\|/.test(parts[i]) ? "\n" : ""}${parts[i]}`
				: parts[i];
			const pushed = await adapter.push(conversationId, piece);
			if (!pushed.ok) return pushed;
		}
		return { ok: true };
	}

	/** Per-channel connection/delivery health for the settings UI's status card.
	 * Adapters without status() report a null health (idle). */
	channelStatuses(): Array<{
		id: string;
		channel: string;
		displayName: string;
		capabilities: AdapterCapabilities;
		health: AdapterHealth | null;
	}> {
		return [...this.active.entries()].map(([id, a]) => ({
			id,
			channel: a.channel,
			displayName: a.metadata.displayName,
			capabilities: a.metadata.capabilities,
			health: a.status?.() ?? null,
		}));
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
				// /steer <内容> — deliver to the LIVE turn at its next step
				// boundary (pi SDK steer). Field 2026-10-10: a huge task blocked
				// the strict per-conversation queue, so the user's "取消任务"
				// never reached the model; steer reaches it without killing the
				// turn. An idle conversation has nothing to steer — run it as an
				// ordinary turn instead.
				if (inbound?.name === "steer") {
					if (this.draining) return Promise.resolve("⏳ 系统正在安装应用更新，当前消息不会被执行；请稍后重新发送。");
					const text = (inbound.arg ?? "").trim();
					if (!text) return Promise.resolve("用法：/steer <要说的话>——它会在当前步骤边界把这条指令交给正在执行的任务，让它据此收尾/调整（但不保证立即停下），例如「/steer 别做了，先保存结果收尾」。要硬中断请用 /stop。");
					const steered = this.engine.steerConversation(msg.conversationId, text, msg.actor);
					if (steered.status === "accepted") {
						return Promise.resolve(`🧭 已把「${text}」交给正在执行的任务——它会在当前步骤边界收到这条指令，应据此收尾/调整（但不保证立即停下）。若几步内没动静，请发 /stop 硬中断。`);
					}
					if (steered.status === "rejected") return Promise.resolve(steered.reason);
					// idle: no live turn — nothing to interrupt. Run the payload as an
					// ordinary turn so "/steer X" on an idle chat is not a dead end.
					return this.serialize(msg.conversationId, async () => {
						if (this.draining) return "⏳ 系统正在安装应用更新，当前消息不会被执行；请稍后重新发送。";
						this.engine.recordConversationMember(msg.conversationId, msg.actor);
						const admission = checkPermission(this.config, msg.actor, msg.conversationId, "chat");
						if (!admission.ok) return admission.reason;
						const agent = this.engine.getOrCreateSession(msg.conversationId);
						const result = await this.engine.send(agent, text, { actor: msg.actor, conversationName: msg.conversationName, onPersist: (id) => this.onActivity?.(id) });
						return result.reply || `⚠️ 抱歉,处理失败:${friendlyError(result.error)}`;
					});
				}
				// A plain cancel/stop phrase sent while a turn is running is
				// STEERED, not queued (field 2026-10-10). The user means "stop
				// what you are doing" — queueing it behind the very task it
				// cancels is the reported dead end. Idle → ordinary turn.
				if (isCancelPhrase(msg.text) && this.engine.isConversationStreaming(msg.conversationId)) {
					const steered = this.engine.steerConversation(msg.conversationId, msg.text, msg.actor);
					if (steered.status === "accepted") {
						return Promise.resolve(`🧭 已把「${msg.text.trim()}」交给正在执行的任务——它会在当前步骤边界收到这条指令，应据此停下/收尾（但不保证立即停）。若几步内没停，请发 /stop 硬中断。`);
					}
					// rejected (e.g. not the task owner) must NOT silently fall through to
					// the queue — that reintroduces the reported dead end. Surface it.
					if (steered.status === "rejected") return Promise.resolve(steered.reason);
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

					// 「前台执行」escape hatch — deterministic, no model turn: cancel the
					// convertible chat-dispatched item and re-run its ORIGINAL
					// instruction inline. The re-run must skip plan-ahead AND triage:
					// a foreground escape that re-dispatches to background would be
					// absurd (field 2026-11-05: the dispatch label itself was the
					// complaint — the escape is the cheap way out).
					let turnText = msg.text;
					const escaped = isForegroundEscape(turnText);
					if (escaped) {
						const esc = this.takeForegroundEscape(msg);
						if (esc) {
							if (!esc.original) return esc.notice!;
							turnText = esc.original;
						}
					}

					const agent = this.engine.getOrCreateSession(msg.conversationId);

					// Long-task progress heartbeat: every `longTaskProgressMin` while a
					// turn is still running, push a brief progress note to the channel.
					// IM only — real adapters provide ctx.onProgress; the console/HTTP
					// path does not. Repeats until the turn finishes (cleared in finally).
					// The note comes from a side-channel LLM pass (progressBrief) for a
					// concrete ≤100-char progress report; if the turn settles while the
					// summary is in flight, the stale "仍在进行中" is dropped.
					//
					// Delivery ledger (2026-10-27): each heartbeat occurrence is (inbound
					// message, time bucket) — bucket size = THIS config value that also
					// drives the timer below, so consecutive timer fires land in consecutive
					// buckets. A duplicate claim inside one bucket (retried push, a
					// redelivered stream message after a restart) is suppressed; the NEXT
					// bucket's beat is a new occurrence — the deliberate v0.2.162 cadence
					// (one note every `longTaskProgressMin` for as long as the turn runs)
					// is preserved, only true duplicates are deduped.
					// Progress notes are now driven by the GLOBAL PUMP
					// (startProgressPump), not by a timer created here. A timer created
					// in this handler dies with the process and is NEVER recreated after
					// a restart — the message was consumed long ago — so a resumed task
					// ran for an hour with one note and then went silent (field
					// 2026-11-04). The pump reads live busy-conversations from the
					// engine, so reporting follows the work however it started.
					const onProgress = ctx?.onProgress;
					void onProgress;

					// Turn watchdog — STALL-based (0.2.73): the per-conversation queue is
					// strict, so ONE wedged turn (hung LLM call / hung socket / hung
					// remote session) would block that chat forever — field incident: a
					// group went silent while single chats kept working, and only an app
					// restart cleared it. The old fixed timer measured TOTAL turn time
					// and killed healthy long tasks (field feedback 2026-09-17); this one
						// fires only after `turnTimeoutMin` of ZERO activity — a live task
						// never trips it no matter how long it runs. An in-flight LLM
						// request IS life (v3, 0.2.86): its own request timeout bounds a
						// dead call, so the watchdog must not second-guess it. True wedges
						// (hung tools, hung remote sessions) can't be unstuck in-process —
						// abort is the release; context-size trouble never gets here
						// because the in-turn budget gate compacts and continues.
					const turnTimeoutMin = this.config.all().general.turnTimeoutMin ?? 0;
					let turnTimedOut = false;
					const watchdog = turnTimeoutMin > 0
						? startStallWatchdog({
							thresholdMs: turnTimeoutMin * 60_000,
							activityAgeMs: () => this.engine.turnIdleMs(msg.conversationId),
						onStall: () => {
							turnTimedOut = true;
							// Snapshot BEFORE abort: the numbers must explain the kill in
							// main.log (field 2026-09-18 — with in-flight LLM = life, a fire
							// here means genuinely zero requests and zero events).
							console.warn(`[im] turn silent for ${turnTimeoutMin}min — aborting: ${msg.conversationId} | ${this.engine.turnStallSnapshot(msg.conversationId)}`);
							this.engine.markTurnAbort(msg.conversationId, "watchdog");
							this.engine.abortSession(msg.conversationId);
						},
						})
						: undefined;

					try {
						// Plan-ahead (user ruling 2026-11-03): for task-shaped messages,
						// push a short numbered plan to the chat BEFORE execution starts,
						// then hand the same plan to the turn as context so the agent
						// honors what was promised. Planning is a bounded side pass (60s);
						// any failure or NO_PLAN verdict simply skips it — execution is
						// never blocked by planning, and simple questions never see a plan.
						let planText: string | undefined;
						if (!escaped && this.config.all().general.taskPlanning?.enabled !== false) {
							try {
								const plan = await this.engine.planTaskBrief(agent, msg.text, msg.conversationId);
									if (plan) {
										// The turn gets the FULL plan; the chat gets `chatText`,
										// which the planner leaves undefined for short tasks (user
										// ruling 2026-11-04: no plan for work that finishes fast).
										planText = plan.turnContext;
										const occurrenceId = msg.messageId
											? chatHeartbeatOccurrenceId(msg.channel ?? "im", msg.messageId, Date.now(), 60_000)
											: undefined;
										// Push it. A failed push must NOT block execution: the plan
										// still goes to the turn — the chat just didn't see it.
										if (plan.chatText && ctx?.onProgress) {
											await ctx.onProgress(plan.chatText, { occurrenceId: occurrenceId || undefined, kind: "task-plan" })
												.catch((err) => console.warn("[im] task plan push failed:", err instanceof Error ? err.message : err));
										}
										// Router/Worker dispatch (docs/design/router-worker.md P1). Conservative
										// and ON by default: when it fires, the message does NOT run in this chat
										// turn — it becomes a work item and this turn returns the ACK instead.
										// Every failure path falls through to inline execution (no black holes).
										const dispatched = await this.tryDispatchToWorker(msg, plan.turnContext);
										// `undefined` = inline; ANY string (including "" = dispatched,
										// stay silent) means the Router handed the task off.
										if (dispatched !== undefined) {
											// The early return skips engine.send's onActivity — fire it
											// so the renderer task list shows the new item immediately
											// (review P2-3).
											this.onActivity?.(msg.conversationId);
											return dispatched;
										}
									}
							} catch (err) {
								console.warn("[im] task planning skipped:", err instanceof Error ? err.message : err);
							}
						}
						// Plan-less dispatch attempt (field 2026-11-06): deep tasks (SLS log
						// queries, 堡垒机 investigations) dispatch WITHOUT a plan. Before this,
						// a failed plan side pass silently serialized two unrelated jobs into
						// one chat's queue — the user saw "SLS finished, THEN the batch query
						// started" and reasonably concluded VE runs globally serial. triage
						// rejects everything that is not clearly a deep task, so simple
						// questions still run inline exactly as before.
						if (!escaped && !planText) {
							const planlessDispatch = await this.tryDispatchToWorker(msg);
							if (planlessDispatch !== undefined) {
								this.onActivity?.(msg.conversationId);
								return planlessDispatch;
							}
						}
						const result = await this.engine.send(
							agent,
							planText
							? `[已向用户确认的执行规划，严格按此执行，完成后逐步对照汇报]\n${planText}\n\n[用户原始指令]\n${msg.text}`
							: turnText,
							{ sendFile: ctx?.sendFile, sendImage: ctx?.sendImage, images: msg.images, actor: msg.actor, conversationName: msg.conversationName, onPersist: (id) => this.onActivity?.(id) },
						);
						// Final turn complete — signal the UI to refresh the task list.
						this.onActivity?.(msg.conversationId);
						if (turnTimedOut) {
							// A stall that fires AFTER the reply was finalized (field
							// 2026-09-24: a hung after-turn compaction kept the silence
							// clock running) must not discard the completed answer —
							// deliver it with the interrupt notice instead.
							const notice = `⏱️ 本回合已连续 ${turnTimeoutMin} 分钟无任何进展（疑似卡死），已自动中断以解除会话阻塞。`;
							if (result.reply) return `${result.reply}\n\n${notice}若反复出现，请联系管理员查看日志定位卡点。`;
							return `${notice}请重新发送指令重试；若反复出现，请把任务拆小或分步执行，并联系管理员查看日志定位卡点。`;
						}
						if (!result.reply) {
							console.error(`[im] no reply for ${msg.conversationId}:`, result.error ?? "(no error reported)");
							// Never go silent on the channel — surface a short error so the
							// user sees what failed (quota, network, bad key, …) instead of nothing.
							return `⚠️ 抱歉,处理失败:${friendlyError(result.error)}`;
						}
						return result.reply;
					} finally {
						if (watchdog) watchdog.stop();
						// Fire-and-forget: never blocks settle; the note lands 5s after
						// the result (async by design — user ruling 2026-11-04).
						this.scheduleBackgroundInventory(msg.conversationId);
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
		if (cmd.name === "new" || cmd.name === "stop" || cmd.name === "steer") {
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
				"/steer <内容> — 在当前步骤边界把话交给正在执行的任务，让它据此收尾/调整（不保证立即停下），例如 /steer 先保存结果收尾",
				"/perm — 查看我在当前会话的权限（角色 + 各项能力是否放行）",
				"/reload — 重新从磁盘加载技能列表（技能导入/修改后立即生效，不打断进行中的任务）",
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
		if (cmd.name === "reload") {
			// runCommand is deliberately sync-signatured (string | Promise<string>);
			// /reload is the one command that does real async work here, so it
			// returns the promise instead of awaiting.
			return this.engine
				.reloadSkills()
				.then(({ count }) =>
					count === 0
						? "🔄 技能列表已重新加载，当前没有已加载的技能。"
						: `🔄 技能列表已重新加载，当前共 ${count} 个技能，从下一条消息起生效。`,
				)
				.catch((err: unknown) => `技能重载失败：${err instanceof Error ? err.message : String(err)}`);
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

	/** Test hook: push a message through the echo channel adapter (if running).
	 *
	 * The optional `actor` is forwarded as a platform-verified sender so the
	 * local console can exercise the admin/RBAC pipeline. Test-channel only. */
	async simulate(conversationId: string, text: string, actor?: InboundActor): Promise<string> {
		const echo = [...this.active.values()].find((a): a is EchoAdapter => a instanceof EchoAdapter);
		if (!echo) throw new Error("no echo channel is active");
		return echo.simulate(conversationId, text, actor);
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

/** Walk a derivation chain to a routable push target. Pure; injectable lookup.
 * `work:<id>` → item.origin_conversation → … until a non-work: id, max 10 hops,
 * cycle-safe. Returns an honest error instead of a silent drop. */
export function resolvePushTarget(
	start: string,
	getItem: (id: string) => { origin_conversation: string | null } | undefined,
): { target: string } | { error: string } {
	let current = start;
	const visited = new Set<string>();
	for (let hops = 0; current.startsWith("work:"); hops++) {
		if (hops >= 10) return { error: `派生链过深（>10 层），无法解析推送目标：${start}` };
		if (visited.has(current)) return { error: `派生链成环，无法解析推送目标：${start}` };
		visited.add(current);
		const item = getItem(current);
		if (!item) return { error: `推送目标 ${current} 不是可投递会话，且找不到对应任务（可能已被删除）` };
		const parent = item.origin_conversation ?? "";
		if (!parent) return { error: `推送目标 ${current} 的来源会话为空，无法投递` };
		current = parent;
	}
	return { target: current };
}
