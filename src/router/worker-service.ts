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

	constructor(store: WorkerTaskStore, opts: WorkerEngineDeps<Session>) {
		this.store = store;
		this.opts = opts;
		this.maxConcurrent = opts.maxConcurrent ?? 5;
		this.clock = opts.clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms) };
	}

	start(intervalMs = 15_000): void {
		if (this.running) return;
		this.running = true;
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
		void this.runTurn(recent, session, message, senderId, { record: false });
		return true;
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
			await this.runTurn(task, session, task.instruction, task.created_by, { record: true });
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
		if (opts.record) this.store.settle(task.id, text.startsWith("⚠️") ? { error: text } : { text }, this.clock.now());
		try {
			await this.opts.push(task.source_conversation, text);
		} catch (err) {
			this.opts.onError?.(err);
		}
	}
}
