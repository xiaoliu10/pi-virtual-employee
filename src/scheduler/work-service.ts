/**
 * Persistent, single-window work dispatcher. No periodic polling: store lifecycle
 * events wake queued work; one timer wakes the earliest model-selected due time.
 * Abort requests never release the dispatch lock until send actually settles.
 */
import type { WorkItemRow, WorkItemStore } from "../db/work-item-store.js";
import { buildWorkWindowPrefix, DEFAULT_WINDOW_BUDGET, nextRoutineStreak, parseWindowReply } from "./work.js";
import { hasMiningSecrets } from "./mining.js";

interface WorkSession { abort(): void; }
interface ActiveWindow<Session> {
	id: string;
	/** Snapshot of the item's due state BEFORE claim nulls it — the previous
	 * self-declared follow-up, used for cadence judgement and streak counting. */
	dueAt?: number | null;
	prevReason?: string | null;
	prevStreak?: number;
	session?: Session;
	stopReason?: string;
	deadline?: ReturnType<typeof setTimeout>;
	settled: Promise<void>;
}
type Store = Pick<WorkItemStore, "get" | "listDue" | "nextWakeAt" | "claim" | "recoverWorking" | "subscribe" | "setStatus" | "setField" | "clearAnswer" | "setFixedStreak">;
interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface WorkServiceOptions<Session extends WorkSession> {
	store: Store;
	isAdmin(senderId: string): boolean;
	open(item: WorkItemRow, conversationId: string): Session;
	send(session: Session, message: string, senderId: string): Promise<{ reply?: string; error?: string }>;
	release(conversationId: string): Promise<void>;
	push(conversationId: string, text: string): Promise<unknown>;
	/** Live kb.enabled AND kb.learn.enabled, checked at completion. */
	canLearn?(): boolean;
	learn?(item: WorkItemRow, result: string): void | Promise<void>;
	budget?: { maxTurns: number; maxMinutes: number };
	clock?: Clock;
	onError?(error: unknown): void;
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

export class WorkService<Session extends WorkSession> {
	private running = false;
	private recovered = false;
	private unsubscribe?: () => void;
	private wakeTimer?: ReturnType<typeof setTimeout>;
	private active?: ActiveWindow<Session>;
	private readonly clock: Clock;
	private readonly budget: { maxTurns: number; maxMinutes: number };
	constructor(private readonly opts: WorkServiceOptions<Session>) {
		this.clock = opts.clock ?? { now: Date.now, setTimeout, clearTimeout };
		const b = opts.budget ?? DEFAULT_WINDOW_BUDGET;
		this.budget = {
			maxTurns: Number.isFinite(b.maxTurns) && b.maxTurns >= 1 ? Math.floor(b.maxTurns) : DEFAULT_WINDOW_BUDGET.maxTurns,
			maxMinutes: Number.isFinite(b.maxMinutes) && b.maxMinutes > 0 ? b.maxMinutes : DEFAULT_WINDOW_BUDGET.maxMinutes,
		};
	}
	start(): void {
		if (this.running) return;
		if (!this.recovered) { this.opts.store.recoverWorking(); this.recovered = true; }
		this.running = true;
		this.unsubscribe = this.opts.store.subscribe((id) => {
			if (id && id === this.active?.id) {
				const fresh = this.opts.store.get(id);
				if (fresh?.status === "cancelled") this.abortActive("任务已取消");
				else if (fresh?.status === "waiting_human" && fresh.question?.startsWith("管理员暂停")) this.abortActive("管理员已暂停任务");
			}
			queueMicrotask(() => this.tick());
		});
		this.tick();
	}
	/** Request dispatch. False means still durably queued, not a lost request. */
	fireItem(id: string): boolean {
		if (!this.running) return false;
		const row = this.opts.store.get(id);
		if (!row || !(row.status === "queued" || (row.status === "scheduled" && row.next_check_at !== null && row.next_check_at <= this.clock.now()))) return false;
		this.tick();
		return this.active?.id === id;
	}
	async stop(): Promise<void> {
		this.running = false;
		this.unsubscribe?.(); this.unsubscribe = undefined;
		this.clearWake();
		this.abortActive("应用停止执行；请核查已发生的操作后由管理员明确恢复。");
		await this.active?.settled;
	}
	/** Test/drain hook; does not race or abandon an in-flight engine send. */
	async whenIdle(): Promise<void> { await this.active?.settled; }
	private clearWake(): void {
		if (this.wakeTimer !== undefined) this.clock.clearTimeout(this.wakeTimer);
		this.wakeTimer = undefined;
	}
	private abortActive(reason: string): void {
		if (!this.active || this.active.stopReason) return;
		this.active.stopReason = reason;
		if (this.active.deadline !== undefined) this.clock.clearTimeout(this.active.deadline);
		this.active.deadline = undefined;
		try { this.active.session?.abort(); } catch (err) { this.opts.onError?.(err); }
	}
	private tick(): void {
		if (!this.running || this.active) return;
		this.clearWake();
		try {
			const due = this.opts.store.listDue(this.clock.now())[0];
			if (!due) {
				const at = this.opts.store.nextWakeAt();
				if (at !== undefined) this.wakeTimer = this.clock.setTimeout(() => { this.wakeTimer = undefined; this.tick(); }, Math.min(2_147_483_647, Math.max(0, at - this.clock.now())));
				return;
			}
			// Set the lock BEFORE starting any async setup, and keep it through cleanup.
			const active: ActiveWindow<Session> = {
				id: due.id, settled: Promise.resolve(),
				dueAt: due.next_check_at, prevReason: due.next_check_reason, prevStreak: due.fixed_streak ?? 0,
			};
			this.active = active;
			active.settled = Promise.resolve().then(() => this.run(active)).catch((err) => this.opts.onError?.(err)).finally(() => {
				this.active = undefined;
				queueMicrotask(() => this.tick());
			});
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
		let outcome: "done" | "waiting_human" | "scheduled" = "waiting_human";
		try {
			if (!this.running) return;
			item = store.claim(active.id, this.clock.now());
			if (!item) return;
			const initialProgress = item.progress;
			const startedAt = this.clock.now();
			active.deadline = this.clock.setTimeout(() => this.abortActive("工作窗口超时，已请求中止；请核查操作后由管理员明确恢复。"), this.budget.maxMinutes * 60_000);
			for (let turn = 0; turn < this.budget.maxTurns; turn++) {
				// Fresh notebook and live identity on EVERY turn (including turn zero).
				const fresh = store.get(item.id);
				if (!fresh || fresh.status !== "working") return;
				if (active.stopReason || !this.running || this.clock.now() - startedAt >= this.budget.maxMinutes * 60_000) {
					question = active.stopReason ?? "工作窗口预算已用尽，请管理员明确恢复。";
					break;
				}
				if (!fresh.created_by?.trim() || !this.opts.isAdmin(fresh.created_by)) {
					question = "确认管理员身份缺失或权限已撤销；请恢复该管理员权限并明确恢复任务。";
					break; // before session setup / any tool execution
				}
				active.session ??= this.opts.open(fresh, convId);
				const answer = turn === 0 ? fresh.answer : null;
				// First window = queued kickoff with no history, resume answer or a
				// previous self-declared follow-up: demand a plan before acting.
				const firstWindow = turn === 0 && !fresh.progress?.trim() && answer === null && !active.dueAt;
				const prefix = buildWorkWindowPrefix({
					title: fresh.title, goal: fresh.goal, conditions: fresh.conditions, progress: fresh.progress,
					lessons: workLessons(fresh.lessons), turn, budget: this.budget, answer: answer ?? undefined,
					firstWindow,
					lastCheck: active.dueAt ? { at: active.dueAt, reason: active.prevReason, streak: active.prevStreak ?? 0 } : undefined,
				});
				const result = await this.opts.send(active.session, prefix + (turn === 0 ? "请按目标与执行条件推进工作。" : "继续。"), fresh.created_by);
				if (result.error) throw new Error(result.error);
				const current = store.get(item.id);
				// Cancellation wins even over a late DONE: stay silent, the admin already
				// cancelled it. An admin PAUSE is different — the marker question is
				// already persisted, so fall through to the normal waiting_human push
				// below and let the source conversation see why work stopped.
				if (!current || current.status === "cancelled") return;
				if (current.status !== "working") { outcome = "waiting_human"; break; }
				if (active.stopReason || !this.running) { question = active.stopReason ?? "应用停止执行，请管理员明确恢复。"; break; }
				if (answer !== null) store.clearAnswer(item.id, answer);
				if (!current.created_by?.trim() || !this.opts.isAdmin(current.created_by)) {
					question = "确认管理员权限已撤销；请核查操作并恢复权限后明确恢复任务。"; break;
				}
				const decision = parseWindowReply(result.reply ?? "", new Date(this.clock.now()));
				lastText = decision.text;
				if (decision.kind === "human") { question = decision.question || lastText || "需要管理员协助并明确恢复。"; break; }
				if (decision.kind === "done") { outcome = "done"; break; }
				if (decision.kind === "next_check") {
					if (decision.nextCheckAt === undefined) { question = "下次跟进时间非法、已过去或不足 15 分钟；请管理员明确恢复并指定合理时间。"; break; }
					outcome = "scheduled"; nextCheckAt = decision.nextCheckAt; nextReason = decision.nextCheckReason;
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
			outcome = "waiting_human";
			// Do not push raw exception strings (may include credentials/URLs).
			question = active.stopReason ?? "执行出错，可能已产生操作；请管理员核查后明确恢复（不会自动重试）。";
			this.opts.onError?.(err);
		} finally {
			if (active.deadline !== undefined) this.clock.clearTimeout(active.deadline);
			active.deadline = undefined;
			// Persist BEFORE release/push/learning, including throws during open/send.
			if (item && store.get(item.id)?.status === "working") {
				store.setStatus(item.id, outcome, outcome === "waiting_human" ? question || active.stopReason || "请管理员明确恢复。" : null, nextCheckAt ?? null, nextReason);
				if (outcome === "scheduled") store.setFixedStreak(item.id, nextStreak);
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
		}
		if (fresh.origin_conversation) {
			const text = fresh.status === "done"
				? `✅ **自主任务完成：${fresh.title}**\n\n${lastText}`
				: fresh.status === "scheduled"
					? `🔁 **自主任务阶段进展：${fresh.title}**\n\n${lastText.slice(-500)}\n\n下次跟进：${new Date(nextCheckAt!).toLocaleString("zh-CN", { hour12: false })}${nextReason ? `（${nextReason}）` : ""}${nextStreak >= 3 ? `\n\n⚠️ 已连续 ${nextStreak} 次只在相近的固定时间跟进这一个点。如果这是因为它有新信息可查（如某个批次在该时刻生成），写明依据可继续；但记得覆盖今天其他观察点。若这件工作每天只在这一处查、且查了也不需要判断动作，可建议管理员转成定时任务，工作项留给需要判断力的跟进。` : ""}`
					: `⏸️ **自主任务需要人工：${fresh.title}**\n\n${fresh.question}\n\n请管理员回复「继续 ${fresh.title}」并附上答复；未明确恢复前不会自动执行。`;
			try { await this.opts.push(fresh.origin_conversation, text); } catch (err) { this.opts.onError?.(err); }
		}
	}
}
