/**
 * Bounded retry policy for transient electron-updater DOWNLOAD failures.
 *
 * This module deliberately contains no filesystem cleanup. Multiple VE profiles
 * share electron-updater's user-level cache; an error from one instance is not
 * proof that another profile does not own a temp file in that cache. electron-updater
 * itself clears its own pending directory on a failed download, so application code
 * must not add a second shared-cache deleter.
 */

export const MAX_DOWNLOAD_RETRIES = 3;
export const DOWNLOAD_RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;

const TRANSIENT_FILE_LOCK_ERROR = /EPERM|EBUSY|EACCES|sharing violation|ENOENT/i;

export type DownloadFailureDecision =
	| { action: "ignore" }
	| { action: "retry"; attempt: number; delayMs: number; maxAttempts: number }
	| { action: "stop"; attempts: number; maxAttempts: number };

type Scheduler = (callback: () => void, delayMs: number) => NodeJS.Timeout;
type Canceller = (timer: NodeJS.Timeout | undefined) => void;

/**
 * Stateful per-version retry ladder. A fresh update check resets the ladder, so
 * each scheduled check gets the same bounded number of attempts rather than one
 * bad network day permanently suppressing retries until an app restart.
 */
export class DownloadRetryController {
	private readonly attemptsByVersion = new Map<string, number>();
	private activeVersion: string | undefined;
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly schedule: Scheduler = (callback, delayMs) => setTimeout(callback, delayMs),
		private readonly cancel: Canceller = (timer) => clearTimeout(timer),
	) {}

	/** A new check has selected a version; discard any retry aimed at an older target. */
	versionAvailable(version: string | undefined): void {
		if (!version) return;
		this.cancel(this.timer);
		this.timer = undefined;
		if (this.activeVersion && this.activeVersion !== version) this.attemptsByVersion.delete(this.activeVersion);
		this.activeVersion = version;
		// Each scheduled check is a fresh retry window.
		this.attemptsByVersion.delete(version);
	}

	/** A completed download or a terminal non-download state clears pending retries. */
	reset(version?: string): void {
		this.cancel(this.timer);
		this.timer = undefined;
		this.attemptsByVersion.delete(version ?? this.activeVersion ?? "");
	}

	/** App shutdown: cancel the pending retry without touching persistent state. */
	stop(): void {
		this.cancel(this.timer);
		this.timer = undefined;
	}

	/** A retry callback is scheduled between failed download attempts. */
	hasPendingRetry(): boolean {
		return this.timer !== undefined;
	}

	handleFailure(version: string | undefined, message: string, retryDownload: () => void): DownloadFailureDecision {
		if (!version || !TRANSIENT_FILE_LOCK_ERROR.test(message)) return { action: "ignore" };
		const attempt = (this.attemptsByVersion.get(version) ?? 0) + 1;
		this.attemptsByVersion.set(version, attempt);

		if (attempt > MAX_DOWNLOAD_RETRIES) {
			this.timer = undefined;
			this.attemptsByVersion.delete(version);
			return { action: "stop", attempts: MAX_DOWNLOAD_RETRIES, maxAttempts: MAX_DOWNLOAD_RETRIES };
		}

		const delayMs = DOWNLOAD_RETRY_BACKOFF_MS[attempt - 1] ?? DOWNLOAD_RETRY_BACKOFF_MS[DOWNLOAD_RETRY_BACKOFF_MS.length - 1];
		this.cancel(this.timer);
		this.timer = this.schedule(() => {
			this.timer = undefined;
			retryDownload();
		}, delayMs);
		return { action: "retry", attempt, delayMs, maxAttempts: MAX_DOWNLOAD_RETRIES };
	}

	/** Test/inspection helper: number of failed attempts already recorded. */
	attemptsFor(version: string): number {
		return this.attemptsByVersion.get(version) ?? 0;
	}
}
