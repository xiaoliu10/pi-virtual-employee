import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const MAX_LOG_BYTES = 256_000;
const MAX_PAGE_BYTES = 32_000;

export type CommandStatus = "running" | "exited" | "failed" | "timed_out" | "killed";

/** A supervised process with a bounded log. Waiting never changes its runtime limit. */
export class CommandSession {
	readonly id = randomUUID();
	readonly startedAt = Date.now();
	readonly started: Promise<void>;
	readonly completed: Promise<void>;
	status: CommandStatus = "running";
	code: number | null = null;
	endedAt: number | null = null;
	private log: Buffer = Buffer.alloc(0);
	private totalBytes = 0;
	private readonly waiters = new Set<() => void>();
	private readonly runtimeTimer: ReturnType<typeof setTimeout> | undefined;
	private resolveCompleted!: () => void;

	constructor(
		private readonly child: ChildProcess,
		readonly timeoutSec: number,
		private readonly killTree: (pid: number | undefined) => void,
	) {
		this.completed = new Promise((resolve) => { this.resolveCompleted = resolve; });
		this.started = new Promise((resolve) => {
			child.once("spawn", resolve);
			child.once("error", (err) => {
				this.append(`⚠️ 无法启动命令：${err.message}\n`);
				this.finish("failed", null);
				resolve();
			});
		});
		for (const stream of [child.stdout, child.stderr]) {
			const decoder = new StringDecoder("utf8");
			stream?.on("data", (chunk: Buffer) => this.append(decoder.write(chunk)));
			stream?.once("end", () => this.append(decoder.end()));
		}
		// close follows drained stdout/stderr; exit can lose the final output.
		child.once("close", (code) => this.finish("exited", code));
		this.runtimeTimer = timeoutSec > 0 ? setTimeout(() => this.stop("timed_out"), timeoutSec * 1000) : undefined;
	}

	get pid(): number | undefined { return this.child.pid; }

	private append(text: string): void {
		if (!text) return;
		const chunk = Buffer.from(text, "utf8");
		this.totalBytes += chunk.length;
		const combined = Buffer.concat([this.log, chunk]);
		// Copy the retained tail so discarded buffers can be reclaimed.
		this.log = Buffer.from(combined.subarray(Math.max(0, combined.length - MAX_LOG_BYTES)));
	}

	private finish(status: CommandStatus, code: number | null): void {
		if (this.status !== "running") return;
		this.status = status;
		this.code = code;
		this.endedAt = Date.now();
		clearTimeout(this.runtimeTimer);
		this.resolveCompleted();
		for (const wake of this.waiters) wake();
	}

	stop(status: "timed_out" | "killed" = "killed"): void {
		if (this.status !== "running") return;
		this.killTree(this.pid);
		this.finish(status, null);
	}

	/** A cancelled/expired poll only stops waiting; the command remains supervised. */
	async wait(seconds: number, signal?: AbortSignal): Promise<void> {
		if (this.status !== "running" || seconds === 0 || signal?.aborted) return;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.waiters.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, seconds * 1000);
			this.waiters.add(done);
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	/** Absolute UTF-8 byte offsets let callers fetch incremental log pages. */
	readLog(offset?: number) {
		const retainedFrom = this.totalBytes - this.log.length;
		const requested = offset ?? Math.max(retainedFrom, this.totalBytes - MAX_PAGE_BYTES);
		let start = Math.max(0, Math.min(this.log.length, requested - retainedFrom));
		// Avoid splitting UTF-8 characters at either page boundary.
		while (start < this.log.length && (this.log[start] & 0xc0) === 0x80) start += 1;
		let end = Math.min(this.log.length, start + MAX_PAGE_BYTES);
		while (end < this.log.length && end > start && (this.log[end] & 0xc0) === 0x80) end -= 1;
		return {
			output: this.log.subarray(start, end).toString("utf8"),
			offset: retainedFrom + start,
			nextOffset: retainedFrom + end,
			totalBytes: this.totalBytes,
			truncated: requested < retainedFrom,
			hasMore: retainedFrom + end < this.totalBytes,
		};
	}
}
