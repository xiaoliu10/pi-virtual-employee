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
	 * Patch an existing task (title/prompt/cron/push target) without deleting it
	 * — keeps run history. A cron change is validated and recomputes next_run_at;
	 * other fields leave the schedule untouched. Returns undefined for an
	 * unknown id or an invalid cron.
	 */
	update(
		id: string,
		patch: { title?: string; prompt?: string; cron?: string; conversationId?: string | null },
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
	 * One task run, bounded by runTimeoutMs. The losing run keeps executing in
	 * the background (an engine turn can't be meaningfully cancelled from here),
	 * but its eventual rejection is swallowed — the recorded outcome is the
	 * timeout, and the scheduler has already moved on.
	 */
	private runWithTimeout(task: ScheduledTaskRow): Promise<{ status: string }> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`run_timeout:运行超过 ${Math.round(this.runTimeoutMs / 60_000)} 分钟，被调度器强制记败（任务自身可能仍在后台执行）`)),
				this.runTimeoutMs,
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
