/**
 * WorkerService — the execution half of the Router/Worker infrastructure.
 *
 * Router/Worker is INFRASTRUCTURE (user ruling 2026-11-07), not a flavor of
 * the task system. A worker is ONE durable conversation whose lifecycle is
 * driven by CODE events, never by model-declared markers:
 *
 *   spawn → claim → engine.send(instruction) → [durable turn settles]
 *         → deliver the final assistant text to the source conversation → done
 *
 * There is no [[TASK_DONE]] parsing (the durable turn's settle IS completion),
 * no [[NEXT_CHECK]] path (no scheduling code exists here at all), no
 * waiting_human state (a worker that needs a human just says so in its reply;
 * the human's next message comes back through Router as a follow-up turn in
 * the SAME session — conversation continuity, not a pause/resume state machine).
 *
 * If a model emits work-item markers ([[NEXT_CHECK]] etc.) they are inert:
 * plain text that gets pushed verbatim, because NO code here looks for them.
 * That inertness — not an interception rule — is what makes the two systems
 * structurally separate.
 */
import { WorkerTaskStore, type WorkerTaskRow } from "./worker-tasks.js";

/** Injected durable-execution primitives (same shape WorkService uses — the
 * shared KERNEL below both infrastructures; nothing task-flavored crosses). */
export interface WorkerEngineDeps<Session> {
	/** history.ensureConversation + engine.getOrCreateSession. */
	open(conversationId: string): Promise<Session> | Session;
	/** One durable round: returns when the turn settles. reply = the final
	 * assistant text (code-extracted result — no marker parsing anywhere). */
	send(session: Session, message: string, senderId: string, sourceConversation: string): Promise<{ reply?: string; error?: string }>;
	/** Deliver to the source conversation (idempotent upstream). */
	push(conversationId: string, text: string): Promise<unknown> | unknown;
	/** Cancel a live durable round (foreground-escape). Injected because the
	 * abort surface lives on the session, which this service only holds. */
	abort?(session: Session): void;
	/** Result archival hook (context-management P2): called once per dispatched
	 * turn with the final outcome, so main.ts can land a searchable record
	 * (search_knowledge_base second hop). Errors here must never break delivery. */
	onSettled?: (task: { id: string; instruction: string; sourceConversation: string; createdBy: string }, outcome: string) => void;
	/** Long-task progress broadcaster (taskProgressMin cadence), same shape
	 * WorkService injects. Optional — without it long workers run silent
	 * until their result (the exact complaint that opened this file's field
	 * history), so main.ts always wires it. */
	progress?(task: { title: string; target: string; conversationId: string }, session: Session): {
		start(): void; stop(): void; drain(timeoutMs?: number): Promise<void>;
	};
	maxConcurrent?: number;
	clock?: { now(): number; setTimeout(fn: () => void, ms: number): unknown };
	onError?(err: unknown): void;
}

export interface WorkerSpec {
	instruction: string;
	sourceConversation: string;
	createdBy: string;
	maxMinutes?: number;
}

export class WorkerService<Session> {
	private readonly store: WorkerTaskStore;
	private readonly opts: WorkerEngineDeps<Session>;
	private readonly maxConcurrent: number;
	private readonly clock: { now(): number; setTimeout(fn: () => void, ms: number): unknown };
	private running = false;
	private wake?: unknown;
	private readonly active = new Set<string>();
	/** taskId → live durable session, so the foreground escape can abort the
	 * round the way WorkService aborts a window. */
	private readonly sessions = new Map<string, Session>();
	/**
	 * sessionKey → tail of that session's turn chain.
	 *
	 * The kernel's Agent REFUSES a second prompt while one is in flight
	 * ("Agent is already processing. Specify streamingBehavior…" — field
	 * 2026-11-07 on the box, surfaced to the user as 执行未完成). Worker is
	 * dialogue infrastructure: a follow-up typed while the worker is still
	 * working must QUEUE behind the running turn and run after it settles —
	 * not fail, not be dropped, and not be delivered as an error notice.
	 * Keyed by conversation id (one chain per worker session).
	 */
	private readonly turnChains = new Map<string, Promise<void>>();

	constructor(store: WorkerTaskStore, opts: WorkerEngineDeps<Session>) {
		this.store = store;
		this.opts = opts;
		this.maxConcurrent = opts.maxConcurrent ?? 5;
		this.clock = opts.clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms) };
	}

	start(intervalMs = 15_000): void {
		if (this.running) return;
		this.running = true;
		// Stale-row reconciliation before the first tick. `running` is an
		// in-memory fact; the process that owned those rows is gone, so nothing
		// will ever settle them and they would claim to be alive forever.
		// Deliberately INERT (log only) — see recoverOrphans().
		this.recoverOrphans();
		const loop = () => {
			if (!this.running) return;
			try {
				this.tick();
			} catch (err) {
				this.opts.onError?.(err);
			}
			if (this.running) this.clock.setTimeout(loop, intervalMs);
		};
		loop();
	}

	stop(): void {
		this.running = false;
		if (this.wake) { this.clock.setTimeout(() => {}, 0); this.wake = undefined; }
	}

	/** Reconcile workers whose owning process died. LOG ONLY — no push, no
	 * re-dispatch, no re-queue.
	 *
	 * User ruling 2026-11-07: 「崩溃恢复不见得是一件好事，要克制，如果一直不停
	 * 的触发是有问题的，会造成死循环，模型后台空转」. A restart-triggered notice
	 * invites a re-dispatch; if the box restarts again mid-run, notice →
	 * re-dispatch → restart is a self-sustaining loop that burns model turns and
	 * delivers nothing. The honest minimum is: the stale row stops claiming to
	 * be running, and ops can see why in the log and in worker_task_detail.
	 *
	 * The user still finds out through the paths that already exist and cost
	 * nothing when idle: the task simply has no result, and asking about it
	 * (worker_task_detail / 任务状态) reports the interruption reason. */
	private recoverOrphans(): void {
		const bootAt = this.clock.now();
		let orphans: WorkerTaskRow[];
		try {
			orphans = this.store.recoverOrphans(bootAt, "应用在执行中退出，该轮未完成（如需继续请重新派发）");
		} catch (err) {
			this.opts.onError?.(err);
			return;
		}
		for (const o of orphans) {
			console.log(`[worker] orphan reconciled: ${o.id} (${o.source_conversation}) — ${o.instruction.slice(0, 60)}`);
		}
	}

	/** Router's single entry point. Fire-and-forget: the Router never waits on
	 * a worker, and the worker never reports back through the Router. */
	spawn(spec: WorkerSpec): WorkerTaskRow {
		const row = this.store.create({
			id: `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
			instruction: spec.instruction,
			sourceConversation: spec.sourceConversation,
			createdBy: spec.createdBy,
			maxMinutes: spec.maxMinutes,
			now: this.clock.now(),
		});
		return row;
	}

	/** 「前台执行」escape: cancel this conversation's QUEUED-or-RUNNING worker
	 * (dispatcher only — same conversation AND same sender) and hand back the
	 * original instruction for an inline re-run. A RUNNING round is aborted
	 * first; a QUEUED one never starts. Returns undefined when nothing is
	 * convertible (Router then re-runs the phrase inline as a plain message). */
	cancelForEscape(sourceConversation: string, senderId: string, note: string): string | undefined {
		const row = this.store.cancelForEscape(sourceConversation, senderId, note, this.clock.now());
		if (!row) return undefined;
		const session = row.status === "cancelled" ? this.sessions.get(row.id) : undefined;
		if (session) {
			try { this.opts.abort?.(session); } catch (err) { this.opts.onError?.(err); }
			this.sessions.delete(row.id);
		}
		this.active.delete(row.id);
		return row.instruction;
	}

	/** Route a follow-up message into the same durable session as this
	 * conversation's most recent worker. Returns false when none exists
	 * (Router then makes a NEW dispatch decision). A follow-up turn is
	 * CONVERSATION, not state: the worker_tasks row stays settled — the
	 * durable session holds the dialogue, and the reply is delivered to the
	 * source conversation like any other turn's result. */
	async inject(sourceConversation: string, message: string, senderId: string): Promise<boolean> {
		const recent = this.store.recentForConversation(sourceConversation);
		if (!recent?.conversation_id) return false;
		const session = await this.opts.open(recent.conversation_id);
		// Serialize on the session's turn chain: the kernel refuses concurrent
		// prompts, and a user typing during a running turn expects their message
		// to be ANSWERED NEXT, not rejected.
		this.enqueueTurn(recent.conversation_id, () => this.runTurn(recent, session, message, senderId, { record: false }));
		return true;
	}

	/** Append a turn to a session's serial chain. The chain never rejects: a
	 * failing turn reports through runTurn's own error path, and a rejected
	 * link would poison every later turn on that session. */
	private enqueueTurn(sessionKey: string, run: () => Promise<void>): void {
		const previous = this.turnChains.get(sessionKey) ?? Promise.resolve();
		const next = previous.then(run, run).catch((err) => {
			this.opts.onError?.(err);
		});
		this.turnChains.set(sessionKey, next);
		// Drop the tail once it settles AND is still the tail, so a long-lived
		// map cannot retain one entry per conversation forever.
		void next.then(() => {
			if (this.turnChains.get(sessionKey) === next) this.turnChains.delete(sessionKey);
		});
	}

	/** True while this conversation still has queued/running turns (test seam +
	 *  progress-pump sanity: a worker mid-chain is not idle). */
	hasPendingTurns(sessionKey: string): boolean {
		return this.turnChains.has(sessionKey);
	}

	private tick(): void {
		while (this.active.size < this.maxConcurrent) {
			const task = this.store.claim(this.clock.now());
			if (!task) break;
			this.active.add(task.id);
			void this.execute(task).catch((err) => {
				this.opts.onError?.(err);
				this.active.delete(task.id);
			});
		}
	}

	private async execute(task: WorkerTaskRow): Promise<void> {
		const session = await this.opts.open(task.conversation_id!);
		this.sessions.set(task.id, session);
		const notifier = this.opts.progress?.(
			{ title: task.instruction.slice(0, 60), target: task.source_conversation, conversationId: task.conversation_id! },
			session,
		);
		notifier?.start();
		try {
			// Enqueued like a follow-up: one serial chain per session, so the
			// dispatch turn and any follow-ups never overlap on the Agent.
			await new Promise<void>((resolve) => {
				this.enqueueTurn(task.conversation_id!, async () => {
					await this.runTurn(task, session, task.instruction, task.created_by, { record: true });
					resolve();
				});
			});
		} finally {
			notifier?.stop();
			await notifier?.drain(5_000).catch(() => {});
			this.sessions.delete(task.id);
			this.active.delete(task.id);
		}
	}

	/** One durable round. `record` marks the DISPATCH round (the only one the
	 * linear state machine tracks); follow-up turns are conversation, not
	 * state — they deliver their reply and leave the row settled. */
	private async runTurn(task: WorkerTaskRow, session: Session, message: string, senderId: string, opts: { record: boolean }): Promise<void> {
		try {
			const r = await this.opts.send(session, message, senderId, task.source_conversation);
			const text = (r.reply ?? "").trim();
			if (r.error || !text) {
				await this.deliver(task, `⚠️ 执行未完成：${r.error ?? "模型无返回"}`, opts);
				return;
			}
			// The reply is pushed VERBATIM. Work-item markers in it are inert —
			// nothing here parses them, which is the structural separation.
			await this.deliver(task, text, opts);
		} catch (err) {
			this.opts.onError?.(err);
			try {
				await this.deliver(task, `⚠️ 执行未完成：${err instanceof Error ? err.message : String(err)}`, opts);
			} catch { /* delivery of the failure notice is best-effort */ }
		}
	}

	/** Source-conversation delivery; also the terminal transition for the
	 * dispatch round (record=true). One push per turn. */
	private async deliver(task: WorkerTaskRow, text: string, opts: { record: boolean }): Promise<void> {
		if (opts.record) {
			this.store.settle(task.id, text.startsWith("⚠️") ? { error: text } : { text }, this.clock.now());
			try {
				this.opts.onSettled?.({ id: task.id, instruction: task.instruction, sourceConversation: task.source_conversation, createdBy: task.created_by }, text);
			} catch (err) {
				this.opts.onError?.(err);
			}
		}
		try {
			await this.opts.push(task.source_conversation, text);
		} catch (err) {
			this.opts.onError?.(err);
		}
	}
}
