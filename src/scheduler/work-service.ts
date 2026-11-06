import { nextStallStep, STALL_QUIET_RETRIES } from "./autonomous.js";
import { allowsSelfScheduling, originLabel, resolveOrigin, type WorkOrigin } from "./work-origin.js";
/**
 * Persistent, multi-window work dispatcher. No periodic polling: store lifecycle
 * events wake queued work; one timer wakes the earliest model-selected due time.
 * Abort requests never release a window's slot until send actually settles.
 *
 * CONCURRENCY (user ruling 2026-11-04): this used to run exactly ONE window per
 * profile. That was fine while only mined/scheduled work used it, but routing
 * chat tasks here as well would have made the whole profile globally serial —
 * strictly WORSE than the per-conversation serialization it replaced (two
 * chats could run in parallel before; they could not any more). Windows now run
 * up to maxConcurrent at once (default 5), each independently claimed/tracked.
 * Safety: WorkItemStore.claim() is an atomic UPDATE ... WHERE status='queued',
 * so two windows can never start the same row even if listDue() races.
 */
import type { WorkItemRow, WorkItemStore } from "../db/work-item-store.js";
import { buildWorkWindowPrefix, DEFAULT_NEXT_CHECK_MS, DEFAULT_WINDOW_BUDGET, nextRoutineStreak, parseWindowReply, REMIND_DEFAULT_MS, REMIND_MAX_MS, REMIND_MIN_MS } from "./work.js";
import { hasMiningSecrets } from "./mining.js";

interface WorkSession {
	/** Abort the turn. `preserveBackground` keeps this conversation's running
	 * background processes alive — required by the NEXT_CHECK continuation
	 * contract (work.ts teaches: run the scan, write results to files, continue
	 * next window; review P1 2026-11-06: killing them on a timeout kill would
	 * destroy the very continuation the design depends on). */
	abort(opts?: { preserveBackground?: boolean }): void;
}
interface ActiveWindow<Session> {
	id: string;
	/** Snapshot of the item's due state BEFORE claim nulls it — the previous
	 * self-declared follow-up, used for cadence judgement and streak counting. */
	dueAt?: number | null;
	prevReason?: string | null;
	prevStreak?: number;
	/** Pre-claim soft-fallback meter (consecutive unusable NEXT_CHECK windows). */
	prevFallback?: number;
	/** Pre-claim kickoff marker: claim() flips the row, so the FIRST-window
	 * decision must read this snapshot, not the post-claim row. */
	prevKicked?: number;
	/** 常驻巡检标记（pre-claim snapshot）：DONE 被拦截为按节奏顺延。 */
	prevResident?: number;
	/** Consecutive auto-deferred wall-clock timeouts entering this window. */
	prevTimeouts?: number;
	/** 上次自声明节奏（pre-claim snapshot）：DONE 拦截的顺延时长依据。 */
	prevCadenceMs?: number | null;
	session?: Session;
	stopReason?: string;
	deadline?: ReturnType<typeof setTimeout>;
	settled: Promise<void>;
}
type Store = Pick<WorkItemStore, "get" | "listDue" | "listByStatus" | "nextWakeAt" | "claim" | "recoverWorking" | "subscribe" | "setStatus" | "setField" | "clearAnswer" | "setFixedStreak" | "setFallbackStreak" | "setTimeoutStreak" | "markReminded" | "setCadence">;
interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface WorkServiceOptions<Session extends WorkSession> {
	store: Store;
	isAdmin(senderId: string): boolean;
	open(item: WorkItemRow, conversationId: string): Session;
	send(session: Session, message: string, senderId: string, memoryConversationId?: string, memoryChannel?: string): Promise<{ reply?: string; error?: string; deterministic?: boolean }>;
	release(conversationId: string): Promise<void>;
	push(conversationId: string, text: string): Promise<unknown>;
	/** Live kb.enabled AND kb.learn.enabled, checked at completion. */
	canLearn?(): boolean;
	/** Live KB tool availability, forwarded to the window protocol so it never
	 * references unregistered tools (save_to_knowledge needs learn enabled). */
	kbFeatures?(): { search: boolean; learn: boolean };
	learn?(item: WorkItemRow, result: string): void | Promise<void>;
	/** Kill background processes this item's window left running, called when the
	 * item reaches DONE (field 2026-11-06: a finished task's driver script kept
	 * polling files and holding profile locks). Never called for aborted or
	 * deferred windows — those continue on the same item. */
	reclaimBackground?(itemId: string): void;
	budget?: { maxTurns: number; maxMinutes: number };
	/** Window progress broadcaster (v0.2.171): main.ts injects the same
	 * ProgressNotifier factory the scheduled-task runner uses, so a work window
	 * — which runs for maxMinutes with only its final report as output — reports
	 * on the task cadence instead of staying silent until it ends. Called once
	 * per window; the service starts it, then stops and drains it before the
	 * window's completion push. */
	progress?(item: WorkItemRow, session: Session, conversationId: string): { start(): void; stop(): void; drain(timeoutMs?: number): Promise<void> } | undefined;
	/** How many windows may run at once (default 5). User ruling 2026-11-04:
	 * a profile routes ALL task-shaped chat messages here, so one window would
	 * serialize the whole profile; the box can afford five. */
	maxConcurrent?: number;
	clock?: Clock;
	onError?(error: unknown): void;
	/** Latest inbound (user) message time in a conversation since a timestamp —
	 * reminder staleness guard: if the human already replied after the pause,
	 * the sweep stays quiet instead of nagging about an answered question. */
	lastInboundAt?(conversationId: string, sinceTs: number): number | null;
	/** Watchdog soft-stops for a conversation inside a sliding window (engine
	 * counter). Drives the postpone gate below: a window whose turn the
	 * watchdog killed must not re-arm the next one by itself. */
	runawayCount?(conversationId: string): number;
	/** Reset the soft-stop history after a window that closed normally. */
	clearRunawayStops?(conversationId: string): void;
}

export function workLessons(raw: string | null): string[] {
	try {
		const value: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	} catch { return []; }
}

/** Reuse mining's sensitive-data backstop; omit whole entry rather than leak it.
 * This is defense in depth, not a complete DLP classifier. Raw answer/error and
 * origin-note fields are deliberately not part of the learned content.
 */
export function buildWorkLearning(item: WorkItemRow, result: string): { title: string; content: string; tags: string } | undefined {
	const lessons = workLessons(item.lessons);
	const input = {
		title: `自主任务：${item.title}`,
		content: `目标：${item.goal}\n执行条件：${item.conditions ?? "（无记录）"}\n进展：${item.progress ?? "（无记录）"}\n成果：${result.slice(0, 800)}\n\n踩坑记录：\n${lessons.map((l) => `- ${l}`).join("\n")}`,
		tags: "自主任务,踩坑",
	};
	return hasMiningSecrets(input.title + "\n" + input.content) ? undefined : input;
}

/** stopReason used when the wall-clock cap fires (kept as a constant so the
 * defer branches can recognise it — the deadline callback and the loop check
 * must agree on the exact string). */
const TIMEOUT_STOP_REASON = "工作窗口时间上限已到，已自动顺延；请核查已发生的操作。";
/** How far a timed-out window defers itself (user ruling 2026-10-23): short
 * enough that a multi-window task keeps moving, long enough that the next
 * window starts after the current turn's teardown finishes. */
const TIMEOUT_DEFER_MS = 5 * 60_000;
/** Consecutive wall-clock timeouts before the chain stops auto-deferring and
 * asks for the admin (user ruling 2026-10-23): an auto-defer that never
 * terminates is a silent busy-loop — the model never finishes, the window
 * keeps timing out, and nobody is told. Two deferrals mean the task genuinely
 * does not fit the budget; a human must resize it (raise max_minutes) or
 * split it. */
const MAX_CONSECUTIVE_TIMEOUTS = 2;
/** Default concurrent work windows per profile (user ruling 2026-11-04). */
const DEFAULT_MAX_CONCURRENT = 5;

export class WorkService<Session extends WorkSession> {
	private running = false;
	private recovered = false;
	private unsubscribe?: () => void;
	private wakeTimer?: ReturnType<typeof setTimeout>;
	/** Running windows, keyed by work-item id. Bounded by maxConcurrent. */
	private readonly active = new Set<ActiveWindow<Session>>();
	private readonly maxConcurrent: number;
	private readonly clock: Clock;
	private readonly budget: { maxTurns: number; maxMinutes: number };
	constructor(private readonly opts: WorkServiceOptions<Session>) {
		this.clock = opts.clock ?? { now: Date.now, setTimeout, clearTimeout };
		// Bounded sanity, not a policy: a nonsense value must not wedge dispatch
		// into "0 windows" (nothing ever runs) or an unbounded fan-out.
		const requested = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
		this.maxConcurrent = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_MAX_CONCURRENT;
		const b = opts.budget ?? DEFAULT_WINDOW_BUDGET;
		this.budget = {
			// maxTurns 0 = unlimited (the default, user ruling 2026-10-13). Invalid
			// values (negative, NaN) also fall back to 0 — a bad config must not
			// bound a window by surprise. Explicit positive values still cap it.
			maxTurns: Number.isFinite(b.maxTurns) && b.maxTurns >= 0 ? Math.floor(b.maxTurns) : DEFAULT_WINDOW_BUDGET.maxTurns,
			maxMinutes: Number.isFinite(b.maxMinutes) && b.maxMinutes > 0 ? b.maxMinutes : DEFAULT_WINDOW_BUDGET.maxMinutes,
		};
	}
	start(): void {
		if (this.running) return;
		if (!this.recovered) {
			this.recovered = true;
			// INTERRUPTED-NOTICE PUSH (field 2026-11-06, the box): a crash or kill
			// leaves items "working"; recoverWorking flips them to waiting_human.
			// That state change used to be SILENT — the admin @-mentioned three
			// times, every dispatch succeeded, and not one word came back because
			// each worker window was then killed by the incident response. Push an
			// honest notice per affected item. Best-effort: during early startup
			// the IM adapter may not be up yet, so failures are swallowed.
			const victims = this.opts.store.recoverWorking();
			for (const v of victims) {
				if (!v.origin_conversation) continue;
				const text = `⚠️ **任务被中断：${v.title}**\n\n应用在执行中退出，本轮进度已保留，任务处于「需要人工」状态。请核查已发生的操作后，回复明确指示以恢复（或直接取消）。`;
				void Promise.resolve(this.opts.push(v.origin_conversation, text)).catch(() => {});
			}
		}
		this.running = true;
		this.unsubscribe = this.opts.store.subscribe((id) => {
			// With several windows in flight the changed row may be ANY of them:
			// cancel/pause must abort the matching window, not "the" window.
			const running = id ? this.findActive(id) : undefined;
			if (running && id) {
				const fresh = this.opts.store.get(id);
				if (fresh?.status === "cancelled") this.abortActive(running, "任务已取消");
				else if (fresh?.status === "waiting_human" && fresh.question?.startsWith("管理员暂停")) this.abortActive(running, "管理员已暂停任务");
			}
			queueMicrotask(() => this.tick());
		});
		this.tick();
	}
	private findActive(id: string): ActiveWindow<Session> | undefined {
		for (const window of this.active) if (window.id === id) return window;
		return undefined;
	}
	/** Request dispatch. False means still durably queued, not a lost request. */
	fireItem(id: string): boolean {
		if (!this.running) return false;
		const row = this.opts.store.get(id);
		if (!row || !(row.status === "queued" || (row.status === "scheduled" && row.next_check_at !== null && row.next_check_at <= this.clock.now()))) return false;
		this.tick();
		// True only when a window actually took it now; with a full board the item
		// stays durably queued and fires when a slot frees up.
		return !!this.findActive(id);
	}
	/** Stop dispatching and abort every window.
	 *
	 * MUST NOT await the in-flight sends. A session whose send ignores abort()
	 * never settles, and a test/fake session that hangs forever would make
	 * shutdown hang with it (the concurrency suite deadlocked for exactly this
	 * reason). The single-window code had the same shape but only ever waited on
	 * ONE window, so the hazard was invisible. Callers that genuinely need the
	 * sends drained can await whenIdle() themselves AFTER the abort has been
	 * requested — stop() returns as soon as the abort is on the wire.
	 */
	async stop(): Promise<void> {
		this.running = false;
		this.unsubscribe?.(); this.unsubscribe = undefined;
		this.clearWake();
		for (const window of [...this.active]) this.abortActive(window, "应用停止执行；请核查已发生的操作后由管理员明确恢复。", true);
	}
	/** Test/drain hook; does not race or abandon an in-flight engine send. */
	async whenIdle(): Promise<void> { await Promise.all([...this.active].map((window) => window.settled)); }
	/** Arm the SINGLE timer that wakes the earliest due item / reminder.
	 * Idempotent: every tick re-arms, so the previous timer must be cleared
	 * first or repeated ticks stack timers for the same instant (the old
	 * single-window code cleared at the top of tick and could not race itself;
	 * with several windows finishing at once it can).
	 */
	private armWake(): void {
		this.clearWake();
		const at = Math.min(this.opts.store.nextWakeAt() ?? Number.POSITIVE_INFINITY, ...this.remindDeadlines());
		if (at === Number.POSITIVE_INFINITY) return;
		this.wakeTimer = this.clock.setTimeout(() => { this.wakeTimer = undefined; this.tick(); }, Math.min(2_147_483_647, Math.max(0, at - this.clock.now())));
	}
	private clearWake(): void {
		if (this.wakeTimer !== undefined) this.clock.clearTimeout(this.wakeTimer);
		this.wakeTimer = undefined;
	}
	/** Abort ONE window. Never "the" window: several may be running. */
	private abortActive(window: ActiveWindow<Session>, reason: string, preserveBackground = false): void {
		if (window.stopReason) return;
		window.stopReason = reason;
		if (window.deadline !== undefined) this.clock.clearTimeout(window.deadline);
		window.deadline = undefined;
		try { window.session?.abort({ preserveBackground }); } catch (err) { this.opts.onError?.(err); }
	}
	/** Reminder interval for a waiting_human row: the item's OWN rhythm
	 * (EMA of its declared NEXT_CHECK gaps), clamped. A 2h-rhythm task that
	 * stalls must not go quieter than its normal cadence — that is exactly
	 * the "high-frequency task loses a whole day" failure mode. */
	private remindInterval(row: WorkItemRow): number {
		const raw = row.cadence_ms ?? REMIND_DEFAULT_MS;
		return Math.min(REMIND_MAX_MS, Math.max(REMIND_MIN_MS, raw));
	}
	/** Reminder deadline for a waiting_human row: entry-time (updated_at) +
	 * interval, afterwards last_remind_at + interval. */
	private remindDeadline(row: WorkItemRow): number {
		return (row.last_remind_at ?? row.updated_at) + this.remindInterval(row);
	}
	private remindDeadlines(): number[] {
		return this.opts.store.listByStatus("waiting_human").map(r => this.remindDeadline(r));
	}
	/** waiting_human re-reminder sweep (field 2026-10-04: a paused task pushed
	 * once then went silent forever — admins miss pushes, silence = death).
	 * Never auto-resumes (non-idempotent ops); just refuses to be silent.
	 * Attempt-based counting: markReminded lands BEFORE the push so a failing
	 * push cannot spin the tick; the status guard drops racing resumes. */
	private sweepReminders(): void {
		const now = this.clock.now();
		for (const row of this.opts.store.listByStatus("waiting_human")) {
			if (this.remindDeadline(row) > now) continue;
			// The human may have ALREADY replied in the origin conversation after the
			// pause (field 2026-10-06: the answer was given, the task ran to
			// completion, and a stale reminder still nagged 9h later). Suppress the
			// reminder when inbound arrived after the LAST reminder watermark
			// (entry time, else last_remind_at) — per-cycle suppression only: a
			// chatty group must not mute an item forever (silence = death), but an
			// answered question never nags again on the very next cycle either.
			// Note: setField/addLesson during waiting_human refresh updated_at —
			// the watermark moves with it, matching the "已等待 X" entry-time base.
			if (this.opts.lastInboundAt && row.origin_conversation) {
				const watermark = Math.max(row.updated_at, row.last_remind_at ?? 0);
				const inbound = this.opts.lastInboundAt(row.origin_conversation, watermark);
				if (inbound !== null && inbound >= watermark) {
					// Bookkeeping MUST still advance (last_remind_at out), otherwise the
					// deadline stays in the past and the wake timer tight-loops on skips.
					const suppressed = (row.remind_count ?? 0) + 1;
					if (this.opts.store.markReminded(row.id, now)) {
						this.opts.onError?.(new Error(`[work] reminder suppressed for ${row.id.slice(0, 8)} (attempt ${suppressed}): origin conversation has inbound activity after the last reminder watermark`));
					}
					continue;
				}
			}
			const waited = now - row.updated_at;
			const n = (row.remind_count ?? 0) + 1;
			if (!this.opts.store.markReminded(row.id, now)) continue;
			const cid = row.origin_conversation;
			if (!cid) continue;
			const waitedText = waited >= 24 * 3_600_000 ? `${Math.floor(waited / 24 / 3_600_000)} 天` : `${Math.max(1, Math.floor(waited / 3_600_000))} 小时`;
			// Copy shows the CLAMPED interval (what reminders actually do), not the
			// raw cadence — a 36h rhythm reminds every 24h and the text must agree.
			const rhythm = row.cadence_ms !== null && row.cadence_ms !== undefined
				? `（原节奏约每 ${(() => { const iv = this.remindInterval(row); return iv >= 24 * 3_600_000 ? `${Math.round(iv / 24 / 3_600_000)} 天` : iv >= 3_600_000 ? `${Math.round(iv / 3_600_000)} 小时` : `${Math.max(1, Math.round(iv / 60_000))} 分钟`; })()}一次，期间的观察点都在错过）`
				: "";
			const question = (row.question ?? "").trim().slice(0, 300);
			const tail = n >= 3
				? `\n\n这已经是第 ${n} 次提醒：如果这件工作已经不需要了，请回复取消它；仍需要则直接回复答复内容让它继续。`
				: "\n\n直接回复答复内容（如验证码、预计解决时间）即可继续；如果已经不需要了，可以取消这个任务。";
			const text = `⏸️ 自主任务仍在等待人工：${row.title.slice(0, 200)}\n\n已等待约 ${waitedText}${rhythm}${question ? `。上次的问题：${question}` : ""}${tail}`;
			try { void Promise.resolve(this.opts.push(cid, text)).catch((err) => this.opts.onError?.(err)); } catch (err) { this.opts.onError?.(err); }
		}
	}

	private tick(): void {
		if (!this.running) return;
		// Do NOT clear the wake timer here: a full board still needs the wake to
		// fire the earliest due item the moment a slot frees up.
		if (this.active.size >= this.maxConcurrent) {
			this.armWake();
			return;
		}
		try {
			this.sweepReminders();
			const due = this.opts.store.listDue(this.clock.now());
			if (!due.length) {
				// Wake for the earliest of: scheduled follow-up OR pending waiting_human
				// reminder. Without the reminder half, an all-waiting_human board has NO
				// timer at all — tick never fires and reminders never happen (the exact
				// silent-death this sweep exists to prevent).
				this.armWake();
				return;
			}
			// Fill every free slot, highest priority first (listDue already ordered).
			// The slot is registered BEFORE any async setup and held through cleanup
			// so a concurrent tick can never double-start the same row (claim() would
			// also reject it, but the slot must not be counted as free).
			// CLAIM THE SLOTS FIRST, START THEM AFTER. Adding a window and starting
			// its run in the same loop iteration is a re-entrancy bug: a window whose
			// fake/live send resolves instantly deletes itself in the SAME microtask
			// drain, so `active.size` drops back under the cap and the loop admits
			// one more — the board then runs 5 windows despite maxConcurrent=2
			// (reproduced: size 0→1→0→1→... while claiming). Reserving every slot
			// up front makes the cap a hard limit regardless of how fast a window
			// settles.
			const starting: ActiveWindow<Session>[] = [];
			for (const row of due) {
				if (this.active.size >= this.maxConcurrent) break;
				if (this.findActive(row.id)) continue;
				const active: ActiveWindow<Session> = {
					id: row.id, settled: Promise.resolve(),
					dueAt: row.next_check_at, prevReason: row.next_check_reason, prevStreak: row.fixed_streak ?? 0,
					prevFallback: row.fallback_streak ?? 0,
					prevKicked: row.kicked_off ?? 0,
					prevResident: row.resident ?? 0,
					prevTimeouts: row.timeout_streak ?? 0,
					prevCadenceMs: row.cadence_ms ?? null,
				};
				this.active.add(active);
				starting.push(active);
			}
			for (const active of starting) {
				active.settled = Promise.resolve().then(() => this.run(active)).catch((err) => this.opts.onError?.(err)).finally(() => {
					this.active.delete(active);
					queueMicrotask(() => this.tick());
				});
			}
		} catch (err) { this.opts.onError?.(err); }
	}

	private async run(active: ActiveWindow<Session>): Promise<void> {
		const { store } = this.opts;
		const convId = `work:${active.id}`;
		let item: WorkItemRow | undefined;
		let lastText = "";
		let question = "";
		let nextCheckAt: number | undefined;
		let nextReason: string | undefined;
		let nextStreak = 0;
		let emptyReplies = 0;
		let stallRetriedThisTurn = false;
		// True only when THIS window settled via the timeout auto-defer (which
		// persists an incremented streak). Every other close — done, a model-declared
		// NEXT_CHECK, a human handover, a circuit-break pause, an error — is a normal
		// close: "连续 N 次超时" counts consecutive timeouts, so a window that ended
		// any other way must give the next hard timeout a fresh count (e.g. scan
		// window hard-times out → defer → the follow-up window hands over via a
		// normal NEXT_CHECK; a stale streak would falsely trip the breaker on the
		// next single timeout).
		let timeoutDeferred = false;
		// Declared OUTSIDE the try so the catch/finally paths read the same cap.
		let budget = this.budget;
		let outcome: "done" | "waiting_human" | "scheduled" = "waiting_human";
		try {
			if (!this.running) return;
			item = store.claim(active.id, this.clock.now());
			if (!item) return;
			const initialProgress = item.progress;
			const startedAt = this.clock.now();
			// Per-item cap wins over the service default (admin "调大 maxMinutes" — the
			// circuit-breaker message promises this knob, so it must exist; subagent
			// review P1 2026-10-23). Read ONCE at window start: a change mid-window
			// lands on the next window, never retargeting a cap already running.
			if (item.max_minutes && item.max_minutes > 0) budget = { ...this.budget, maxMinutes: item.max_minutes };
			// Window budget exhausted -> this SAME item continues next window: keep its
				// background work running so the next window can harvest it.
				active.deadline = this.clock.setTimeout(() => this.abortActive(active, TIMEOUT_STOP_REASON, true), budget.maxMinutes * 60_000);
			for (let turn = 0; budget.maxTurns <= 0 || turn < budget.maxTurns; turn++) {
				// Fresh notebook and live identity on EVERY turn (including turn zero).
				const fresh = store.get(item.id);
				if (!fresh || fresh.status !== "working") return;
				if (active.stopReason || !this.running || this.clock.now() - startedAt >= budget.maxMinutes * 60_000) {
					// Wall-clock cap reached. User ruling 2026-10-23: this used to pause
					// for explicit admin recovery, so a window that ran out mid-scan
					// pushed NOTHING and the admin had to babysit every window. The
					// window now defers itself (scheduled + a short NEXT_CHECK) and the
					// push tells the admin what state it handed over — the chain resumes
					// on its own. Only a genuine error / admin pause / cancel keeps the
					// waiting_human path.
					const timedOut = active.stopReason === TIMEOUT_STOP_REASON
						|| (!active.stopReason && this.clock.now() - startedAt >= budget.maxMinutes * 60_000);
					if (timedOut) {
						const streak = (active.prevTimeouts ?? 0) + 1;
						if (streak >= MAX_CONSECUTIVE_TIMEOUTS) {
							// The budget does not fit this task. Stop looping and let
							// the admin resize (raise max_minutes) or split it.
							question = `已连续 ${streak} 次因时间上限（${budget.maxMinutes} 分钟）自动顺延仍未完成——这件工作装不进当前窗口预算。请用 update 调大 maxMinutes（如 180），或收窄本轮范围/拆成多个任务，然后明确恢复。`;
							break;
						}
						store.setTimeoutStreak(item.id, streak);
						timeoutDeferred = true;
						outcome = "scheduled";
						nextCheckAt = this.clock.now() + TIMEOUT_DEFER_MS;
						nextReason = "窗口时间上限已到，未完成部分自动顺延（下一窗口从已保存进度继续）";
						nextStreak = active.prevStreak ?? 0;
						question = "";
						break;
					}
					question = active.stopReason ?? (budget.maxTurns > 0 ? "工作窗口预算已用尽，请管理员明确恢复。" : "工作窗口时间上限已到，请管理员明确恢复。");
					break;
				}
				if (!fresh.created_by?.trim() || !this.opts.isAdmin(fresh.created_by)) {
					question = "确认管理员身份缺失或权限已撤销；请恢复该管理员权限并明确恢复任务。";
					break; // before session setup / any tool execution
				}
				active.session ??= this.opts.open(fresh, convId);
				const answer = turn === 0 ? fresh.answer : null;
				// Durable kickoff marker: claim() sets kicked_off on the first window,
				// so resumed/crash-recovered windows never re-plan. A resume without an
				// answer used to look exactly like a fresh kickoff and get the plan
				// block again (Copilot review 2026-10-02); progress/answer heuristics
				// were not enough — a paused-never-started item resuming without an
				// answer SHOULD still get the plan, and only the durable marker knows.
				// Read the PRE-CLAIM snapshot: claim() has already flipped the row.
				const firstWindow = turn === 0 && !active.prevKicked;
				const kb = this.opts.kbFeatures?.() ?? { search: true, learn: true };
				const lateByMs = active.dueAt != null ? Math.max(0, this.clock.now() - active.dueAt) : undefined;
				const prefix = buildWorkWindowPrefix({
					title: fresh.title, goal: fresh.goal, conditions: fresh.conditions, progress: fresh.progress,
					lessons: workLessons(fresh.lessons), turn, budget, answer: answer ?? undefined,
					firstWindow, lateByMs, resident: active.prevResident === 1, kbSearchEnabled: kb.search, kbLearnEnabled: kb.learn,
					lastCheck: active.dueAt ? { at: active.dueAt, reason: active.prevReason, streak: active.prevStreak ?? 0 } : undefined,
					now: this.clock.now(),
				});
				// Engine no-reply signals (result.error, or deterministic with a canned
				// apology) get quiet backoff retries: an intermittent "Connection
				// error." absorbed by a retry must not surface as an execution error
				// (user ruling 2026-10-08, field: a gateway blip killed the turn and
				// pinged the admin). Deliberately WIDER than the scheduled-chain
				// grading, which never retries hard errors — a work window already
				// pauses for explicit admin recovery on exhaustion, so a bounded
				// retry here only removes avoidable interruptions. The turn does not
				// consume budget on a retry; only graded exhaustion
				// (STALL_QUIET_RETRIES + 1 attempts) reaches the honest pause below.
				// A thrown exception is NEVER retried (it may be anything).
				stallRetriedThisTurn = false;
				let stallAttempt = 0;
				let result: { reply?: string; error?: string; deterministic?: boolean };
				// Progress beats for the whole window (all turns): started before the
				// first send and stopped+drained in the finally, so a slow in-flight note
				// can never land after the window's completion push (v0.2.162 P2-1).
				const notifier = this.opts.progress?.(item, active.session, convId);
				notifier?.start();
				try {
				for (;;) {
						result = await this.opts.send(active.session, prefix + (turn === 0 ? "请按目标与执行条件推进工作。" : "继续。"), fresh.created_by, fresh.origin_conversation ?? undefined, fresh.created_channel ?? undefined);
						if (!result.error && !result.deterministic) break;
						stallAttempt += 1;
						const step = nextStallStep(stallAttempt);
						if (step.action !== "retry" || active.stopReason || !this.running) break;
						stallRetriedThisTurn = true;
						// Error CONTENT is deliberately not logged (may carry secrets) —
						// same discipline as the pushed text below.
						console.warn(`[work] ${item.id.slice(0, 8)} turn ${turn + 1}: send produced no reply; silent retry ${stallAttempt}/${STALL_QUIET_RETRIES} in ${Math.round(step.backoffMs / 1000)}s`);
						await new Promise<void>((resolve) => { this.clock.setTimeout(resolve, step.backoffMs); });
						// A stop/cancel/timeout landing DURING the backoff must not be
						// followed by a fresh full model round (H1, review 2026-10-08):
						// session.abort() is a no-op on an idle agent, so the re-check
						// has to live here. Breaking leaves result.error set; the catch
						// prefers active.stopReason for the terminal phrasing.
						if (active.stopReason || !this.running) break;
				}
				} finally {
					notifier?.stop();
					// Bounded: a wedged relay must not hold the window open.
					await notifier?.drain(5_000).catch(() => {});
				}
				if (result.error) throw new Error(result.error);
				if (result.deterministic) throw new Error("模型服务中断，未产出回复");
				// A turn that produced NO text (field 2026-09-29: stopReason=length with
				// thinking-only output burned the whole output budget) has no closure and
				// no marker — parsing it yields "continue" and the next turn re-prompts
				// into the same wall, silently burning the budget. Count consecutive
				// empty replies and pause honestly instead.
				if (!(result.reply ?? "").trim()) {
					emptyReplies += 1;
					console.warn(`[work] ${item.id.slice(0, 8)} turn ${turn + 1}: empty reply (stopReason-less turn, ${emptyReplies} consecutive)`);
					if (emptyReplies >= 2) {
						question = "连续 2 轮模型没有产出任何文本（疑似输出长度截断：thinking 占满了输出额度）。请核查模型最大输出配置后明确恢复。";
						break;
					}
					continue;
				}
				emptyReplies = 0;
				const current = store.get(item.id);
				// Cancellation wins even over a late DONE: stay silent, the admin already
				// cancelled it. An admin PAUSE is different — the marker question is
				// already persisted, so fall through to the normal waiting_human push
				// below and let the source conversation see why work stopped.
				if (!current || current.status === "cancelled") return;
				if (current.status !== "working") { outcome = "waiting_human"; break; }
				// A wall-clock timeout is an auto-defer, not a stop-for-admin: it
				// must not fall through to the waiting_human phrasing here (user
				// ruling 2026-10-23 — this branch used to swallow the timeout and
				// pause the chain even though the deadline callback had already
				// marked the run as deferring).
				if (active.stopReason === TIMEOUT_STOP_REASON) {
					const streak = (active.prevTimeouts ?? 0) + 1;
					if (streak >= MAX_CONSECUTIVE_TIMEOUTS) {
						question = `已连续 ${streak} 次因时间上限（${budget.maxMinutes} 分钟）自动顺延仍未完成——这件工作装不进当前窗口预算。请用 update 调大 maxMinutes（如 180），或收窄本轮范围/拆成多个任务，然后明确恢复。`;
						break;
					}
					store.setTimeoutStreak(item.id, streak);
					timeoutDeferred = true;
					outcome = "scheduled";
					nextCheckAt = this.clock.now() + TIMEOUT_DEFER_MS;
					nextReason = "窗口时间上限已到，未完成部分自动顺延（下一窗口从已保存进度继续）";
					nextStreak = active.prevStreak ?? 0;
					question = "";
					break;
				}
				if (active.stopReason || !this.running) { question = active.stopReason ?? "应用停止执行，请管理员明确恢复。"; break; }
				if (answer !== null) store.clearAnswer(item.id, answer);
				if (!current.created_by?.trim() || !this.opts.isAdmin(current.created_by)) {
					question = "确认管理员权限已撤销；请核查操作并恢复权限后明确恢复任务。"; break;
				}
				const decision = parseWindowReply(result.reply ?? "", new Date(this.clock.now()));
				lastText = decision.text;
				console.log(`[work] ${item.id.slice(0, 8)} turn ${turn + 1} → ${decision.kind}${decision.kind === "next_check" ? ` raw="${(decision.nextCheckRaw ?? "").slice(0, 120)}" at=${decision.nextCheckAt ?? "invalid"}` : ""}`);
				if (decision.kind === "human") { question = decision.question || lastText || "需要管理员协助并明确恢复。"; break; }
				if (decision.kind === "done") {
					// Resident (常驻巡检) tasks have no natural finish: a model DONE is
					// treated as "this round clean" and deferred on the last declared
					// cadence (field 2026-10-17: a daily reconciliation patrol was
					// killed by the model declaring DONE on a clean day; the push tells
					// the admin how to actually end it). Clamp [1h, 7d], default 24h.
					if (active.prevResident === 1) {
						// Cadence semantics: prevCadenceMs is the LAST SELF-DECLARED rhythm.
						// A fresh resident task has none yet (NULL → 0) — default to 24h
						// (review P1: Math.max(0, 1h) silently produced hourly wake-ups
						// whose push then LIED about being 24h). Declared cadence is
						// clamped to [1h, 7d].
						const cadence = active.prevCadenceMs ?? 0;
						const deferMs = cadence > 0 ? Math.min(Math.max(cadence, 60 * 60_000), 7 * 24 * 60 * 60_000) : 24 * 3_600_000;
						outcome = "scheduled";
						nextCheckAt = this.clock.now() + deferMs;
						// The routine streak tracks the MODEL's same-daily-slot rhythm ONLY.
						// An engine-side defer is not a model-declared slot: hold the streak
						// (no +1 — a 24h defer would falsely trip the cron-degeneration
						// warning; no reset either — prior model-declared rhythm survives)
						// (review P2).
						nextStreak = active.prevStreak ?? 0;
						const cadenceText = cadence > 0
							? (cadence < 2 * 3_600_000 ? `${Math.max(1, Math.round(cadence / 60_000))}分钟` : `${Math.round(cadence / 3_600_000)}小时`)
							: "24小时";
						nextReason = `模型宣布完成，但本任务是常驻巡检（不允许自行 DONE）——已按${cadence > 0 ? `上次节奏（${cadenceText}）` : "默认节奏（24小时）"}顺延；如确需结束，请管理员用 cancel 取消任务`;
						// Same as a legitimate NEXT_CHECK (see below): a successful window
						// clears the soft-fallback meter (review P3-3).
						if ((active.prevFallback ?? 0) > 0) store.setFallbackStreak(item.id, 0);
						break;
					}
					outcome = "done";
					break;
				}
				if (decision.kind === "next_check") {
					if (decision.nextCheckAt === undefined) {
						// The model clearly WANTED a follow-up but the declared time was
						// unparseable or unusable. Halting here killed the whole chain on a
						// mere format slip (field 2026-10-03: 「今天的执行时间已经过去了，
						// 没有生成下次执行时间，这个任务是不是就死了」). Soft-fallback
						// instead: the chain stays alive on the default re-check, the next
						// window gets another chance to declare a valid time, and the push
						// surfaces the raw slip so the admin can `update` a proper time.
						// Three strikes: a model that cannot produce a usable time across
						// consecutive windows would loop hourly windows + pushes forever
						// (budget/streak/lock none constrain this). Escalate to a human;
						// a manual resume resets the meter.
						const fallbackStreak = (active.prevFallback ?? 0) + 1;
						if (fallbackStreak >= 3) {
							store.setFallbackStreak(item.id, fallbackStreak);
							question = `连续 ${fallbackStreak} 次声明的下次跟进时间都无法解析或已过期（最近一次「${(decision.nextCheckRaw ?? "").slice(0, 60)}」）。请管理员核查任务进展后明确恢复，或用 update 直接指定下次跟进时间。`;
							break;
						}
						outcome = "scheduled";
						nextCheckAt = this.clock.now() + DEFAULT_NEXT_CHECK_MS;
						const raw = (decision.nextCheckRaw ?? "").slice(0, 60);
						nextReason = `原声明时间「${raw || "空"}」无法解析或已过期，按默认节奏（1 小时后）顺延${decision.nextCheckReason ? `；原依据：${decision.nextCheckReason}` : ""}`;
						nextStreak = 0;
						store.setFallbackStreak(item.id, fallbackStreak);
						break;
					}
					outcome = "scheduled"; nextCheckAt = decision.nextCheckAt; nextReason = decision.nextCheckReason;
					store.setCadence(item.id, decision.nextCheckAt - this.clock.now());
					if ((active.prevFallback ?? 0) > 0) store.setFallbackStreak(item.id, 0);
					// Deterministic cron-degeneration meter: consecutive same-daily-slot
					// follow-ups accumulate; anything else resets. Manual resume (no dueAt)
					// also resets — conservative by design.
					nextStreak = nextRoutineStreak(active.dueAt ?? undefined, active.prevStreak ?? 0, nextCheckAt);
					break;
				}
				question = "工作窗口预算已用尽且未声明安全的跟进时间；请核查进展后由管理员明确恢复。";
			}
			const fresh = store.get(item.id);
			// Respect explicitly written progress; narration is only a fallback.
			if (fresh?.status === "working" && fresh.progress === initialProgress && lastText.trim()) store.setField(item.id, "progress", lastText.trim().slice(-1200));
		} catch (err) {
			// A window that ran out of wall clock mid-turn surfaces here as an
			// abort — that is the auto-defer case, not a failure: hand the work over
			// instead of pausing for the admin (user ruling 2026-10-23).
			if (active.stopReason === TIMEOUT_STOP_REASON) {
				const streak = (active.prevTimeouts ?? 0) + 1;
				if (streak >= MAX_CONSECUTIVE_TIMEOUTS) {
					outcome = "waiting_human";
					question = `已连续 ${streak} 次因时间上限（${budget.maxMinutes} 分钟）自动顺延仍未完成——这件工作装不进当前窗口预算。请用 update 调大 maxMinutes（如 180），或收窄本轮范围/拆成多个任务，然后明确恢复。`;
				} else {
					store.setTimeoutStreak(item?.id ?? "", streak);
					timeoutDeferred = true;
					outcome = "scheduled";
					nextCheckAt = this.clock.now() + TIMEOUT_DEFER_MS;
					nextReason = "窗口时间上限已到，未完成部分自动顺延（下一窗口从已保存进度继续）";
					nextStreak = active.prevStreak ?? 0;
					question = "";
				}
			} else {
				outcome = "waiting_human";
				// Do not push raw exception strings (may include credentials/URLs).
				question = active.stopReason ?? (stallRetriedThisTurn
					? "执行出错（静默重试仍失败），可能已产生操作；请管理员核查后明确恢复。"
					: "执行出错，可能已产生操作；请管理员核查后明确恢复（不会自动重试）。");
				this.opts.onError?.(err);
			}
		} finally {
			if (active.deadline !== undefined) this.clock.clearTimeout(active.deadline);
			active.deadline = undefined;
			// Persist BEFORE release/push/learning, including throws during open/send.
			const currentRow = item ? store.get(item.id) : null;
			const freshOrigin = currentRow?.origin ?? null;
			if (item && currentRow?.status === "working") {
				// ORIGIN GATE: only operator-dispatched / approved-mining / scheduled items
				// may re-arm themselves. An injected row must not start scheduling follow-up
				// windows nobody approved (2026-11-05: an injected reconciliation task kept
				// re-arming every window and pushed 自主任务 progress the operator never
				// asked for). A window that would have scheduled becomes a clean close so
				// the work still ends instead of silently pausing.
				// Resolve provenance the SAME way the push header does: structured column
				// first, then the legacy note. Reading only the column would treat every
				// pre-migration row as `legacy` and silently stop its follow-ups.
				// SOFT-STOP POSTPONE GATE (field 2026-11-06, the box): a window whose
				// turn the watchdog killed (identical/cycle loop) must NOT re-arm a
				// next window — the killed loop restarts from its checkpoint, the
				// watchdog kills it again, and kill/re-arm spins forever (~18 LLM
				// calls/minute for half an hour). First kill: stop the chain for the
				// admin (waiting_human, honest copy). Second kill inside the sliding
				// window (admin resumed and it looped again): say so and recommend
				// cancelling or splitting instead of resuming again.
				// `!timeoutDeferred`: a window that hit its TIME BUDGET is a legal
				// continuation (work.ts teaches "scan, write results, continue next
				// window"), not a spin. It must survive the gate even if this item was
				// caught by one transient loop earlier in the sliding window.
				if (outcome === "scheduled" && !timeoutDeferred) {
					// KEY ALIGNMENT: the engine counts watchdog soft-stops under the
					// session id it saw the tools through — `work:<itemId>` for a window
					// (WorkService.open uses that id, engine's send keys on
					// agent.sessionId). Querying the ORIGIN conversation would never
					// match and the gate would silently never fire (the same class of
					// silent no-op this whole change exists to kill).
					const runaway = this.opts.runawayCount?.(convId) ?? 0;
					if (runaway >= 1) {
						outcome = "waiting_human";
						nextCheckAt = undefined;
						nextReason = undefined;
						nextStreak = 0;
						question = runaway >= 2
							? `看门狗已连续 ${runaway} 次在本会话掐断循环空转（同样的步骤反复执行、窗口不断重启）。已停止自动跟进。恢复前建议先核查目标是否可达成、凭据与环境是否就绪——若任务本身不适合自动跟进，建议取消或拆小，不要直接恢复。`
							: "看门狗检测到本窗口在重复执行同样的步骤（循环空转），已停止本轮并暂停自动跟进。请核查任务目标与环境后，回复明确指示以恢复（或直接取消）。";
						console.warn(`[work] soft-stop postpone gate: item=${item.id} runaway=${runaway} — scheduled demoted to waiting_human`);
					}
				}
				const gateOrigin = resolveOrigin({
					origin: (freshOrigin ?? null) as WorkOrigin | null,
					originNote: currentRow?.origin_note ?? item.origin_note ?? null,
				});
				if (outcome === "scheduled" && !allowsSelfScheduling(gateOrigin === "legacy" && currentRow?.origin_note ? { origin: null, originNote: currentRow.origin_note } : { origin: gateOrigin, originNote: currentRow?.origin_note ?? null })) {
					outcome = "done";
					nextCheckAt = undefined;
					nextReason = undefined;
					console.log(`[work] origin gate: item=${item.id} origin=${gateOrigin} may not self-schedule; closing instead of arming a follow-up`);
					// Review P3-5: a gate-closed row pushes as 手动任务完成, which is
					// indistinguishable from a real completion. Mark the row so
					// get/push bodies show WHY it closed without a follow-up.
					const gateNote = "⏱️ 到达时间上限自动收尾（该任务不允许自动续期）；如需继续请管理员恢复或重建。";
					const prior = currentRow?.progress ?? item.progress ?? "";
					store.setField(item.id, "progress", prior ? `${prior}\n${gateNote}` : gateNote);
				}
				store.setStatus(item.id, outcome, outcome === "waiting_human" ? question || active.stopReason || "请管理员明确恢复。" : null, nextCheckAt ?? null, nextReason);
				if (outcome === "scheduled") store.setFixedStreak(item.id, nextStreak);
				// A non-timeout close resets the consecutive-timeout meter: the breaker
				// counts CONSECUTIVE hard timeouts, and a normal close (or the breaker
				// pausing for the admin) starts a fresh count for the next window.
				if (!timeoutDeferred && (active.prevTimeouts ?? 0) > 0) store.setTimeoutStreak(item.id, 0);
			}
			// A window that closed WITHOUT the gate demoting it clears the soft-stop
			// history: the counter answers "is this window still spinning?", so a
			// normal close must reset it (otherwise one transient loop demotes the
			// item forever and the "已连续 N 次" copy quotes stale numbers).
			if (currentRow?.status === "working" && outcome !== "waiting_human") {
				try { this.opts.clearRunawayStops?.(convId); } catch (err) { this.opts.onError?.(err); }
			}
			try { await this.opts.release(convId); } catch (err) { this.opts.onError?.(err); }
		}
		if (!item) return;
		const fresh = store.get(item.id);
		if (!fresh || fresh.status === "cancelled" || fresh.status !== outcome) return;
		if (fresh.status === "done") {
			try {
				if (this.opts.canLearn?.() !== false) await this.opts.learn?.(fresh, lastText);
			} catch (err) { this.opts.onError?.(err); }
			// Field 2026-11-06 (Nova): a work window started a long-lived driver script
			// (`sls_drv.py`, `while True` + file polling), finished its job (SUCCESS_2FA
			// in its log) and the script kept running — four copies eventually, all
			// holding profile locks and burning file polling. A FINISHED task must not
			// leave background work behind: nothing will ever come back to collect it.
			// (An aborted/timed-out window is different — NEXT_CHECK continues on the
			// same work and legitimately keeps its script; see abortSession.)
			try { this.opts.reclaimBackground?.(fresh.id); } catch (err) { this.opts.onError?.(err); }
		}
		if (fresh.origin_conversation) {
			// Re-read immediately before pushing: a pause/cancel landing between the
			// post-finally capture and here must not push a stale scheduled/human
			// message for an item whose status has since changed (subagent review L4).
			const nowRow = store.get(item.id);
			if (!nowRow || nowRow.status !== fresh.status) return;
			// Schedule metadata comes from the re-read row, not the run's locals: an
			// admin update-nextCheck landing during release() keeps the row scheduled
			// but with a newly persisted time — pushing the locals would announce the
			// stale schedule (Copilot review on the fast-follow PR).
			const scheduledAt = nowRow.next_check_at ?? nextCheckAt!;
			const scheduledReason = nowRow.next_check_reason ?? nextReason;
			const streak = nowRow.fixed_streak ?? 0;
			const label = pushHeaderLabel(nowRow.origin_note, nowRow.origin);
			const text = nowRow.status === "done"
				? `✅ **${label}完成：${nowRow.title}**\n\n${lastText}\n\n---\n\n💤 该任务已收尾，不再自动跟进。需要重开请在来源会话说明。`
				: nowRow.status === "scheduled"
					? `🔁 **${label}阶段进展：${nowRow.title}**\n\n${tailExcerpt(lastText, 500)}\n\n---\n\n⏭️ **下次跟进**：${new Date(scheduledAt).toLocaleString("zh-CN", { hour12: false })}${scheduledReason ? `\n📋 **跟进原因**：${scheduledReason}` : ""}${streak >= 3 ? `\n\n⚠️ **循环提醒**：已连续 ${streak} 次只在相近的固定时间跟进这一个点。如果这是因为它有新信息可查（如某个批次在该时刻生成），写明依据可继续；但记得覆盖今天其他观察点。若这件工作每天只在这一处查、且查了也不需要判断动作，可建议管理员转成定时任务，自主任务留给需要判断力的跟进。` : ""}`
					: `⏸️ **${label}需要人工：${nowRow.title}**\n\n${nowRow.question}\n\n---\n\n💡 **恢复方式**：管理员在来源会话直接回复答复内容（如验证码、预计解决时间）即可继续；恢复前不会自动执行。`;
			try { await this.opts.push(fresh.origin_conversation, text); } catch (err) { this.opts.onError?.(err); }
		}
	}
}

/**
 * Push-header family label by origin.
 *
 * The structured `origin` wins; the free-text note is only a fallback for rows
 * created before the column existed. This ordering is the fix for a real
 * incident: origin used to be sniffed from the sentence "从聊天转派（Router）",
 * so a task injected straight into the DB could claim that origin, appear in the
 * operator's list, self-schedule follow-ups and push as an 自主任务 the operator
 * never asked for (2026-11-05). A claim in a note is not evidence.
 *
 * Chat-dispatched items are a message the Router moved to background — NOT the
 * 自主任务 family — because labeling them so reads as if the scheduler itself had
 * gone autonomous (field 2026-11-05). Exported for tests.
 */
export function pushHeaderLabel(originNote: string | null | undefined, origin?: string | null): string {
	return originLabel(resolveOrigin({ origin: origin as WorkOrigin | null | undefined, originNote }));
}

/**
 * Tail-clip the last progress text at a PARAGRAPH boundary. Field 2026-11-04:
 * the previous `slice(-500)` cut mid-sentence — a push opened with a full
 * title followed by a half sentence ("…3 笔，其中 2 笔，11-02 起）：…"), which
 * every reader took for a delivery bug. Keep the trailing complete paragraphs
 * instead, and mark the excerpt honestly when the head was dropped. Exported
 * for tests: the boundary behavior is the contract.
 */
export function tailExcerpt(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	const tail = trimmed.slice(-maxChars);
	const para = tail.indexOf("\n\n");
	const line = tail.indexOf("\n");
	const cutAt = para >= 0 ? para + 2 : line >= 0 ? line + 1 : 0;
	const excerpt = tail.slice(cutAt).trim();
	if (!excerpt) return trimmed.slice(-maxChars);
	return `……（以下为上次进展的节选）\n\n${excerpt}`;
}
