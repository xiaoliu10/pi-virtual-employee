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

/** Per-run context handed to the runner. */
export interface SchedulerRunCtx {
	/** Unique for one occurrence (task id + fire timestamp). */
	runId: string;
	/** True once the scheduler's timeout raced this run away — the run is a
	 * "losing run": still executing but already recorded as failed. The runner
	 * must annotate any late push so a stale result is never delivered as fresh. */
	isTimedOut(): boolean;
}

export interface SchedulerRunner {
	/** Execute one task; return a status string recorded on the task. */
	runTask(task: ScheduledTaskRow, ctx?: SchedulerRunCtx): Promise<{ status: string }>;
}

/**
 * Should a finished run push its result back to the IM chat?
 *
 * Silent tasks (2026-10-09) execute and record without pushing — a token
 * keep-alive firing every few hours must not notify anyone for succeeding.
 * An ERROR still pushes: silence must never hide a failure the admin has to
 * act on. Tasks with no push target never push either.
 */
export function shouldPushScheduledResult(task: { conversation_id: string | null; silent: number }, error: string | undefined, reply: string): boolean {
	if (!task.conversation_id || !reply) return false;
	return !(task.silent === 1 && !error);
}

const TICK_MS = 60_000;

/**
 * Prefix a losing run's late push so a stale result is never delivered as
 * fresh. Pure + exported so the annotation itself is testable (the runner in
 * electron/main is not unit-tested).
 */
export function annotateLatePush(text: string, timedOut: boolean): string {
	if (!timedOut) return text;
	return `⏱ **迟到结果**：本轮曾因超时被调度器记为失败，以下是该轮后台实际完成后的结果，内容可能已过时。\n\n${text}`;
}
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
			silent?: boolean;
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
				const { raced, settled } = this.runWithTimeout(task);
				try {
					const outcome = await raced;
					this.store.markRun(task.id, outcome.status, next);
				} catch (err) {
					this.store.markRun(task.id, "error:" + (err as Error).message.slice(0, 200), next);
				} finally {
					// Release the re-entrancy guard when the UNDERLYING RUN settles,
					// not when the timeout races it away: a losing run that keeps
					// executing must never overlap the next occurrence (its late
					// push would race the next run's — the double-delivery this
					// guard exists to prevent).
					void settled.then(() => this.inFlight.delete(task.id));
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
	 * timeout, and the scheduler has already moved on. The runner learns about
	 * the timeout via ctx.isTimedOut() and must annotate its late push; the
	 * task's re-entrancy guard is held until the run settles so a losing run
	 * can never overlap the next occurrence.
	 */
	private runWithTimeout(task: ScheduledTaskRow): {
		raced: Promise<{ status: string }>;
		/** Resolves when the underlying run settles — success, failure, or late. */
		settled: Promise<void>;
	} {
		const autonomousMarginMs = 30 * 60_000;
		const budget = normalizeBudget(task.max_turns, task.max_minutes);
		const timeoutMs = task.autonomous ? budget.maxMinutes * 60_000 + autonomousMarginMs : this.runTimeoutMs;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => {
					timedOut = true;
					reject(new Error(`run_timeout:运行超过 ${Math.round(timeoutMs / 60_000)} 分钟，被调度器强制记败（任务自身可能仍在后台执行）`));
				},
				timeoutMs,
			);
			timer.unref?.();
		});
		// The context travels with the run: the runner can ask whether its attempt
		// was already recorded as a timeout (losing run) and annotate its late
		// push instead of delivering a stale result as fresh.
		const ctx: SchedulerRunCtx = {
			runId: `${task.id}:${Date.now()}`,
			isTimedOut: () => timedOut,
		};
		const run = this.runner!.runTask(task, ctx);
		const settled = run.then(() => {}, () => {});
		run.catch(() => {}); // a late failure after a timeout must not become unhandled
		const raced = Promise.race([run, timeout]).finally(() => clearTimeout(timer));
		return { raced, settled };
	}

	private safeNext(cron: string): number | null {
		try {
			return this.nextRun(cron);
		} catch {
			return null;
		}
	}
}
