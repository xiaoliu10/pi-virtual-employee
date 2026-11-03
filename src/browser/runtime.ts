/**
 * BrowserRuntime — self-healing management of the Playwright Chromium binary.
 *
 * Why this exists (field incident 2026-11-02):
 * Playwright is bundled INSIDE the app, but its browser binary is NOT. It is
 * downloaded on demand into `%LOCALAPPDATA%\ms-playwright\chromium-<rev>`.
 * When an app upgrade bumps Playwright, the bundled code looks for a NEW
 * revision (chromium-1234) while the box still has the old one (chromium-1217),
 * so every browser tool failed with "Executable doesn't exist … run
 * `npx playwright install`". The machine has no standalone node, so that hint
 * is a dead end for the operator.
 *
 * This module makes the app:
 *   1. Detect the exact revision its BUNDLED Playwright wants (never a guessed
 *      number — read through `chromium.executablePath()`).
 *   2. Download it automatically (on startup when browser tools are enabled,
 *      and awaited on first browser use) by running the bundled Playwright CLI
 *      with the app's own Electron binary as Node (`ELECTRON_RUN_AS_NODE`).
 *   3. Re-check after every app upgrade, so a Playwright bump auto-installs the
 *      new revision ("auto upgrade"). The OLD revision is retained
 *      (PLAYWRIGHT_SKIP_BROWSER_GC=1) so other software sharing the cache
 *      (e.g. a Python Playwright on the same box) keeps working.
 *   4. Retry through a mirror if the official CDN is unreachable, and surface
 *      progress / a manual "retry" action in the UI.
 *
 * The actual child-process spawn is injected (`runner`) so the state machine is
 * unit-testable without Electron or a network; see installer.ts for the real
 * runner.
 */

export type RuntimePhase = "idle" | "checking" | "installing" | "ready" | "error";

export interface RuntimeStatus {
	phase: RuntimePhase;
	/** 0–100 while installing. */
	progress: number;
	/** Absolute chromium path once known/ready. */
	executablePath: string;
	/** Bundled revision, e.g. "1234". Empty until resolved. */
	revision: string;
	/** 1-based attempt counter (official CDN = 1, mirror = 2, …). */
	attempt: number;
	/** Which download host is in use / last used (human label). */
	source: string;
	/** Error detail when phase === "error". */
	error: string;
	/** Epoch ms of the last successful install/check. */
	checkedAt: number | null;
}

export interface InstallResult {
	/** Exit success. */
	ok: boolean;
	/** Last ~1 KB of combined output, for actionable error messages. */
	tail: string;
}

/** Runs one install attempt against a host (undefined = official CDN). */
export type InstallRunner = (
	onProgress: (percent: number) => void,
	host: string | undefined,
) => Promise<InstallResult>;

export interface RuntimeDeps {
	/** Path the bundled Playwright would launch (encodes the wanted revision). */
	executablePath: () => string;
	/** fs.existsSync for that path. */
	exists: (file: string) => boolean;
	/** Bundled browser revision label (for status/UI), e.g. "1234". */
	revision: () => string;
	/** Installer child process. */
	runner: InstallRunner;
	/** Download hosts to try, in order. undefined entry = Playwright default.
	 *  A function is read on every ensure() so a settings change applies at once. */
	hosts?: (string | undefined)[] | (() => (string | undefined)[]);
	now?: () => number;
}

export interface EnsureOptions {
	/** Reinstall/re-verify even if the executable already exists. */
	force?: boolean;
}

type Listener = (status: RuntimeStatus) => void;

export class BrowserRuntime {
	private status: RuntimeStatus;
	private readonly listeners = new Set<Listener>();
	private inflight: Promise<RuntimeStatus> | null = null;

	constructor(private readonly deps: RuntimeDeps) {
		this.status = {
			phase: "idle",
			progress: 0,
			executablePath: this.safePath(),
			revision: this.safeRevision(),
			attempt: 0,
			source: "",
			error: "",
			checkedAt: null,
		};
	}

	getStatus(): RuntimeStatus {
		return { ...this.status };
	}

	onChange(cb: Listener): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emit(patch: Partial<RuntimeStatus>): void {
		this.status = { ...this.status, ...patch, executablePath: this.safePath(), revision: this.safeRevision() };
		for (const cb of this.listeners) {
			try {
				cb(this.getStatus());
			} catch {
				/* a UI listener must never break the state machine */
			}
		}
	}

	private safePath(): string {
		try {
			return this.deps.executablePath();
		} catch {
			return "";
		}
	}

	private safeRevision(): string {
		try {
			return this.deps.revision();
		} catch {
			return "";
		}
	}

	/** Cheap synchronous readiness check: does the wanted binary exist? */
	isReady(): boolean {
		const p = this.safePath();
		return !!p && this.deps.exists(p);
	}

	/**
	 * Make sure the browser binary for the BUNDLED Playwright is present.
	 * Single-flight: concurrent callers share one install. Idempotent and cheap
	 * when already ready. Never throws — failures land in status.phase=error.
	 */
	ensure(options: EnsureOptions = {}): Promise<RuntimeStatus> {
		if (this.inflight) return this.inflight;
		this.inflight = this.runEnsure(options).finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	private async runEnsure(options: EnsureOptions): Promise<RuntimeStatus> {
		// Re-read the wanted path on every ensure: after an app upgrade it points
		// at a new revision directory, so an existing old binary is not "ready".
		if (!options.force && this.isReady()) {
			this.emit({ phase: "ready", progress: 100, error: "", checkedAt: this.now() });
			return this.getStatus();
		}

		this.emit({ phase: "checking", progress: 0, error: "", attempt: 0, source: "" });
		if (!options.force && this.isReady()) {
			this.emit({ phase: "ready", progress: 100, error: "", checkedAt: this.now() });
			return this.getStatus();
		}

		const hostList = typeof this.deps.hosts === "function" ? this.deps.hosts() : this.deps.hosts;
		const hosts = hostList && hostList.length > 0 ? hostList : [undefined];
		let lastTail = "";

		for (let i = 0; i < hosts.length; i++) {
			const host = hosts[i];
			this.emit({
				phase: "installing",
				progress: 0,
				attempt: i + 1,
				source: host ? host : "playwright-cdn",
				error: "",
			});
			const result = await this.deps.runner(
				(percent) => this.emit({ phase: "installing", progress: clampPct(percent) }),
				host,
			);
			lastTail = result.tail;
			// The CLI may exit 0 while a later Playwright still can't see the file
			// (partial/AV-quarantined download) — trust the filesystem, not the code.
			if (result.ok && this.isReady()) {
				this.emit({ phase: "ready", progress: 100, error: "", checkedAt: this.now() });
				return this.getStatus();
			}
		}

		this.emit({
			phase: "error",
			progress: 0,
			error: summarizeError(lastTail) || "browser download failed",
		});
		return this.getStatus();
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}
}

function clampPct(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

/** Pull a concise, operator-readable cause out of the CLI's noisy output. */
export function summarizeError(tail: string): string {
	const stripped = tail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[│|■▀▁▂▃▄▅▆▇█\s]+$/g, "").trim();
	if (!stripped) return "";
	const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	// Prefer a line that looks like an error over the final progress bar.
	const errLine = [...lines].reverse().find((l) => /error|fail|econn|etimed|enotfound|timeout|refused|denied/i.test(l));
	return (errLine ?? lines[lines.length - 1] ?? "").slice(0, 500);
}

/** Parse a Playwright CLI progress line ("|███  | 42% of 191.8 MiB"). */
export function parseProgress(chunk: string, last: number): number {
	const matches = [...chunk.matchAll(/(\d{1,3})\s*%\s*of/g)];
	if (matches.length === 0) return last;
	const pct = Number(matches[matches.length - 1][1]);
	return Number.isFinite(pct) ? pct : last;
}
