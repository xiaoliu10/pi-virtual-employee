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
import { looksLikeTask } from "../engine/task-planner.js";
import { isBareContextToken } from "../im/triage.js";

/** Injected durable-execution primitives (same shape WorkService uses — the
 * shared KERNEL below both infrastructures; nothing task-flavored crosses). */
export interface WorkerEngineDeps<Session> {
	/** history.ensureConversation + engine.getOrCreateSession. */
	open(conversationId: string): Promise<Session> | Session;
	/** One durable round: returns when the turn settles. reply = the final
	 * assistant text (code-extracted result — no marker parsing anywhere). */
	send(session: Session, message: string, senderId: string, sourceConversation: string): Promise<{ reply?: string; error?: string; deterministic?: boolean }>;
	/** Deliver to the source conversation (idempotent upstream). */
	push(conversationId: string, text: string): Promise<unknown> | unknown;
	/** Cancel a live durable round (foreground-escape). Injected because the
	 * abort surface lives on the session, which this service only holds. */
	abort?(session: Session): void;
	/** Result archival hook (context-management P2): called once per dispatched
	 * turn with the final outcome, so main.ts can land a searchable record
	 * (search_knowledge_base second hop). Errors here must never break delivery. */
	onSettled?: (task: { id: string; instruction: string; sourceConversation: string; createdBy: string }, outcome: string) => void;
	/** Full task context for a re-run (field 2026-11-08): the interrupted row's
	 * instruction is often just a title + 「继续」 — the substance lives in the
	 * matching work item (goal/conditions/progress). Without this the respawned
	 * worker starts from two bare user lines and re-explores from zero (the
	 * original run burned half an hour getting there). Looked up at retry time,
	 * NOT at boot, so it sees the current state. */
	taskContext?: (sourceConversation: string, instruction: string) => string | null;
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

	/** Reconcile workers whose owning process died, and say so ONCE.
	 *
	 * User rulings, 2026-11-07 — both halves matter:
	 *   (1) 「可以给一个提示 因为什么原因中断了 问用户是否原因重跑」: silence is not
	 *     restraint. The group watched a progress note promise 「报告已生成完毕」
	 *     and then nothing ever arrived; a person must be told the run was
	 *     interrupted, why, and be offered the choice to re-run.
	 *   (2) 「崩溃恢复不见得是一件好事，要克制，如果一直不停的触发是有问题的，
	 *     会造成死循环，模型后台空转」: the notice must NOT start work by itself.
	 *     It reports and asks; it never re-queues, never re-dispatches, never
	 *     opens a session (zero model turns).
	 *
	 * Both hold together because the notice is ONCE-PER-ROW: recoverOrphans only
	 * returns rows it actually flipped (UPDATE gated on status='running'), so a
	 * reboot loop cannot produce a notice loop — the second boot finds nothing to
	 * flip and stays silent. A re-run happens only if a human asks for one. */
	private recoverOrphans(): void {
		const bootAt = this.clock.now();
		let orphans: WorkerTaskRow[];
		try {
			orphans = this.store.recoverOrphans(bootAt, "应用在执行中退出，该轮未跑完（可回复「重新执行」重跑）");
		} catch (err) {
			this.opts.onError?.(err);
			return;
		}
		for (const o of orphans) {
			console.log(`[worker] orphan reconciled: ${o.id} (${o.source_conversation}) — ${o.instruction.slice(0, 60)}`);
			const title = o.instruction.slice(0, 60).replace(/\s+/g, " ").trim();
			const text = [
				`⚠️ **任务被中断：${title}**`,
				"",
				"**原因**：应用在任务执行中退出了（升级 / 重启 / 崩溃），这一轮没有跑完，也没有最终结果。",
				"",
				"如果你之前收到过「即将完成 / 报告已生成」之类的进度汇报，那是中断前的估计——**不能当作结果**。",
				"",
				"回复「**重新执行**」我就重跑这一轮；不需要就忽略这条消息。",
			].join("\n");
			// Report + ask ONLY. Nothing is queued here: no re-dispatch, no session.
			// Deliberately NOT written into the source conversation's history
			// (0.2.207's recordDelivery did that): a worker's follow-up replies
			// never come from the source conversation's session, so those copies
			// land as user-less assistant fragments and POISON the source
			// history's rehydration. The reply the notice invites (「重新执行」)
			// is handled deterministically in inject(), which reads worker_tasks
			// — it never needed the model to see the notice.
			void Promise.resolve(this.opts.push(o.source_conversation, text)).catch(() => {});
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
		// Deterministic re-run (field 2026-11-08): the interrupt notice ends with
		// 「回复『重新执行』我就重跑这一轮」. Honor that promise HERE — as code,
		// not as model behavior — because the worker session the notice refers to
		// has NO usable history: pi-session keeps the transcript in memory
		// (SessionManager.inMemory), so after the restart that killed the run the
		// session is EMPTY. Routing「重新执行」into it produces exactly what the
		// user saw: 「请告诉我要重新执行的具体任务是什么？」. Everything the re-run
		// needs survives in worker_tasks: the original instruction, verbatim.
		const retryMatch = /^\s*(重新执行|重跑)\s*$/.test(message);
		if (retryMatch) {
			const retry = this.retryInterrupted(sourceConversation);
			if (retry) {
				const cid = retry.conversation_id ?? `worker:${retry.id}`;
				const note = `✅ 已重新派发：${retry.instruction.replace(/\s+/g, " ").slice(0, 60)}。新一轮任务编号 ${cid}，完成后结果照常推回本会话。`;
				// The spawn is already real — a failed confirmation must be
				// OBSERVABLE (push-only means no history anchor left): surface it
				// through onError instead of swallowing it.
				void Promise.resolve(this.opts.push(sourceConversation, note)).catch((err) => {
					this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
				});
				return true;
			}
			// No interrupted worker to re-run: fall through to the ordinary
			// follow-up path — the message may still be a valid continuation of
			// some other worker.
		}
		const recent = this.store.recentForConversation(sourceConversation);
		if (!recent?.conversation_id) return false;
		// ONLY a LIVE worker owns the dialogue unconditionally (field 2026-11-07:
		// the worker asked 「把验证码发给我」, the user's reply must reach IT).
		// A FINISHED worker (done/error/cancelled) is history: a NEW task request
		// (triage-fires) must fall through to spawn/inline — routing it into the
		// finished worker's session made the boundary brief turn it away entirely
		// (field 2026-11-08 23:44: 「我这边只负责平阳数币监控…没有…能力或权限」 for a
		// fresh serial-number lookup). Conversational follow-ups (「结果呢」「继续」 —
		// not task-shaped) still continue here: the done-worker continuation
		// contract stays intact.
		const LIVE_STATUSES = new Set(["queued", "running"]);
		if (!LIVE_STATUSES.has(recent.status) && looksLikeTask(message)) {
			return false;
		}
		// A BARE context token (digits / codes / serials like 「875055」) is a
		// REFERENCE into the source chat — a FINISHED worker never holds that
		// context (it was born with its instruction only), so it guesses and asks
		// the user what the chat already answered (field 2026-11-10, single chat:
		// 「查了一下，875055 在订单系统里没匹配到…这是什么类型的编号？」— the type was
		// established turns ago in the very conversation the message came from).
		// Fall through to the foreground turn: it carries the full conversation
		// history and can resolve the reference, and triageMessage has the SAME
		// guard (shared isBareContextToken → reason=reference), so the planless
		// dispatch cannot loop the token back into a freshly spawned context-less
		// worker either (review 7ba60092 P1). LIVE workers are untouched — the
		// verification-code flow (field 2026-11-07) is served above this gate.
		if (!LIVE_STATUSES.has(recent.status) && isBareContextToken(message)) {
			return false;
		}
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

	/** Respawn the newest INTERRUPTED worker of this conversation as a NEW task
	 * (same instruction, same source, same creator, same budget). Returns the
	 * fresh queued row, or null when there is nothing interrupted to re-run.
	 *
	 * This is a NEW spawn, not a resurrection: the dead run's in-memory session
	 * is gone (pi-session in-memory transcript), and there is nothing to resume
	 * INTO — what survives (the instruction, in worker_tasks) is exactly what a
	 * fresh run consumes. Identity stays with the ORIGINAL creator so the
	 * re-run's authority matches the run that was interrupted. */
	private retryInterrupted(sourceConversation: string): WorkerTaskRow | null {
		const dead = this.store.latestInterruptedFor(sourceConversation);
		if (!dead) return null;
		// The instruction alone is often a bare「…继续」— the substance (goal,
		// conditions, progress) lives in the matching work item. Attach it so the
		// fresh worker starts with what the dead run had spent half an hour
		// accumulating. Failure to find context is fine: the worker can still
		// explore, exactly like the original run did.
		const context = this.opts.taskContext?.(sourceConversation, dead.instruction) ?? null;
		const instruction = context ? `${dead.instruction}\n\n${context}` : dead.instruction;
		const row = this.spawn({
			instruction,
			sourceConversation: dead.source_conversation,
			createdBy: dead.created_by,
			maxMinutes: dead.max_minutes ?? undefined,
		});
		console.log(`[worker] re-run: ${dead.id} (interrupted) → new ${row.id} via 「重新执行」${context ? " (with task context)" : ""}`);
		return row;
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
			if (!text && r.error) {
				// Only fall back to the raw error when there is NO reply: send()
				// already turns known failures (abort, overflow, login) into a
				// Chinese explanation with next steps — dropping it for
				// 「执行未完成：This operation was aborted」 was the field bug.
				await this.deliver(task, `⚠️ 执行未完成：${r.error}`, opts);
				return;
			}
			if (!text) {
				await this.deliver(task, "⚠️ 执行未完成：模型无返回", opts);
				return;
			}
			// Review e6c6fd82 #1: a NON-deterministic reply WITH an error means
			// the model answered something but the run still recorded a failure
			// (e.g. a mid-run tool channel died) — appending keeps the failure
			// signal; replacing (or dropping) it hides that the task is unfinished.
			if (r.error && !r.deterministic) {
				await this.deliver(task, `${text}\n\n⚠️ 执行未完成：${r.error}`, opts);
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
