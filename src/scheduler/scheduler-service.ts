/**
 * SchedulerService — runs scheduled tasks at their cron time.
 *
 * pi-agent-core has no built-in scheduling (it's a general agent with transport/
 * state); this is the application-layer scheduler. It owns cron → next-run math
 * (via cron-parser), persists tasks through ScheduledTaskStore, and fires each
 * due task by handing it to a runner (wired to the employee engine: a fresh
 * `sched:` conversation running the task prompt with full tools).
 *
 * `start()` ticks every 60s and once immediately; each tick drains all due
 * tasks serially, recording status + the next iteration. Overdue tasks run once
 * (no multi-catch-up).
 */
import { CronExpressionParser } from "cron-parser";
import { normalizeBudget, parseChainState } from "./autonomous.js";
import type {
	CreateScheduledTaskInput,
	ScheduledTaskRow,
	ScheduledTaskStore,
} from "../db/scheduled-task-store.js";

export interface SchedulerRunner {
	/** Execute one task; return a status string recorded on the task. */
	runTask(task: ScheduledTaskRow): Promise<{ status: string }>;
}

const TICK_MS = 60_000;
/**
 * Hard ceiling on one task run. Field incident 2026-09-22: a scheduled run that
 * never settled (its turn sits OUTSIDE the IM watchdog, which only covers IM
 * conversations) held `ticking` forever — every later tick early-returned and
 * the whole scheduler froze for ~4h while the app otherwise looked healthy. A
 * wedged run may now waste only its own timeout, never the scheduler.
 */
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60_000;

export class SchedulerService {
	private runner: SchedulerRunner | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	/** tick-level mutual exclusion: an async tick over 60s must not overlap the next one. */
	private ticking = false;
	/** task-level re-entrancy guard: the same task running past its period is skipped, never run twice. */
	private readonly inFlight = new Set<string>();

	constructor(
		private readonly store: ScheduledTaskStore,
		private readonly runTimeoutMs: number = DEFAULT_RUN_TIMEOUT_MS,
	) {}

	setRunner(runner: SchedulerRunner): void {
		this.runner = runner;
	}

	/** Compute the next run time (ms) for a cron expr from `from` (default now). */
	nextRun(cron: string, from: Date = new Date()): number {
		return CronExpressionParser.parse(cron, { currentDate: from }).next().getTime();
	}

	/** Validate a cron expression (throws on invalid). */
	validateCron(cron: string): void {
		CronExpressionParser.parse(cron);
	}

	create(input: Omit<CreateScheduledTaskInput, "nextRunAt">): ScheduledTaskRow {
		return this.store.create({ ...input, nextRunAt: this.nextRun(input.cron) });
	}

	list(): ScheduledTaskRow[] {
		return this.store.list();
	}

	get(id: string): ScheduledTaskRow | undefined {
		return this.store.get(id);
	}

	delete(id: string): void {
		this.store.delete(id);
	}

	setEnabled(id: string, enabled: boolean): void {
		const task = this.store.get(id);
		if (!task) return;
		const nextRunAt = enabled ? this.safeNext(task.cron) : null;
		this.store.setEnabled(id, enabled, nextRunAt);
	}

	/** Attach an admin creator identity to an existing task (see store.setCreatedBy). */
	setCreatedBy(id: string, senderId: string): ScheduledTaskRow | undefined {
		return this.store.setCreatedBy(id, senderId);
	}

	/**
	 * Stage a user's answer onto a paused chain (resume after need_human).
	 * Pass-through to the store so tools never touch it directly.
	 */
	stageAnswer(id: string, answer: string): void {
		this.store.stageAnswer(id, answer);
	}

	/**
	 * Fire a task immediately, bypassing its cron — the resume/continue path for
	 * paused autonomous chains. Not awaited: the runner pushes its own results;
	 * shares the tick's inFlight guard so a resume can never overlap a due fire.
	 */
	fireNow(id: string): boolean {
		const task = this.store.get(id);
		if (!task || !this.runner || this.inFlight.has(id)) return false;
		this.inFlight.add(id);
		void this.runner
			.runTask(task)
			.catch((err) => console.error(`[scheduler] fireNow ${id} failed:`, (err as Error).message))
			.finally(() => this.inFlight.delete(id));
		return true;
	}

	/**
	 * Patch an existing task (title/prompt/cron/push target/autonomous opts)
	 * without deleting it — keeps run history. A cron change is validated and
	 * recomputes next_run_at; other fields leave the schedule untouched. Returns
	 * undefined for an unknown id or an invalid cron.
	 */
	update(
		id: string,
		patch: {
			title?: string;
			prompt?: string;
			cron?: string;
			conversationId?: string | null;
			autonomous?: boolean;
			maxTurns?: number | null;
			maxMinutes?: number | null;
		},
	): ScheduledTaskRow | undefined {
		const task = this.store.get(id);
		if (!task) return undefined;
		let nextRunAt: number | null | undefined = undefined;
		if (patch.cron !== undefined && patch.cron !== task.cron) {
			try {
				this.validateCron(patch.cron);
			} catch {
				return undefined;
			}
			nextRunAt = this.safeNext(patch.cron);
		}
		// Turning autonomy OFF also drops any paused chain — there is nothing to
		// resume once the task is no longer autonomous.
		if (patch.autonomous === false) this.store.setChainState(id, null);
		return this.store.update(id, patch, nextRunAt);
	}

	/** Start the periodic tick. Idempotent; fires once immediately. */
	start(): void {
		if (this.timer) return;
		void this.tick();
		this.timer = setInterval(() => void this.tick(), TICK_MS);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async tick(): Promise<void> {
		if (!this.runner || this.ticking) return;
		this.ticking = true;
		try {
			const now = Date.now();
			for (const task of this.store.listDue(now)) {
				if (this.inFlight.has(task.id)) continue; // still running — skip this occurrence
				// An autonomous chain paused for a human waits for an explicit resume
				// (resume_scheduled_task); a fresh cron fire must not fork it — the
				// chain's conversation carries all its progress.
				const chainPending = task.autonomous ? parseChainState(task.chain_state)?.pending : undefined;
				if (chainPending) {
					const next = this.safeNext(task.cron);
					const pauseLabel = chainPending === "budget" ? "paused:预算耗尽，等待续跑（跳过本次触发）"
						: chainPending === "stalled" ? "paused:模型无返回，等待处理（跳过本次触发）"
						: "paused:等待人工回复（跳过本次触发）";
					this.store.markRun(task.id, pauseLabel, next);
					continue;
				}
				this.inFlight.add(task.id);
				const next = this.safeNext(task.cron);
				try {
					const { status } = await this.runWithTimeout(task);
					this.store.markRun(task.id, status, next);
				} catch (err) {
					this.store.markRun(task.id, "error:" + (err as Error).message.slice(0, 200), next);
				} finally {
					this.inFlight.delete(task.id);
				}
			}
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * One task run, bounded by a per-task timeout. Autonomous tasks get their
	 * own budget window (max_minutes) plus margin — a 20-turn chain cannot fit
	 * the default 1h ceiling (field 2026-09-30: the chain would be recorded as
	 * timed-out while still working). The losing run keeps executing in the
	 * background (an engine turn can't be meaningfully cancelled from here),
	 * but its eventual rejection is swallowed — the recorded outcome is the
	 * timeout, and the scheduler has already moved on.
	 */
	private runWithTimeout(task: ScheduledTaskRow): Promise<{ status: string }> {
		const autonomousMarginMs = 30 * 60_000;
		const budget = normalizeBudget(task.max_turns, task.max_minutes);
		const timeoutMs = task.autonomous ? budget.maxMinutes * 60_000 + autonomousMarginMs : this.runTimeoutMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`run_timeout:运行超过 ${Math.round(timeoutMs / 60_000)} 分钟，被调度器强制记败（任务自身可能仍在后台执行）`)),
				timeoutMs,
			);
			timer.unref?.();
		});
		const run = this.runner!.runTask(task);
		run.catch(() => {}); // a late failure after a timeout must not become unhandled
		return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
	}

	private safeNext(cron: string): number | null {
		try {
			return this.nextRun(cron);
		} catch {
			return null;
		}
	}
}
