/**
 * FileCredentialStore — pi-ai CredentialStore persisted as `<pi-agent-dir>/auth.json`,
 * the SAME file the pi CLI uses, so a login here is a login everywhere.
 *
 * The agent dir resolves as `PI_CODING_AGENT_DIR` env (preferred), else `~/.pi`
 * — matching pi CLI convention. File layout is one type-tagged credential per
 * provider id: `{ "<providerId>": Credential }`.
 *
 * Concurrency (mirrors pi-coding-agent's FileAuthStorageBackend): `modify` is
 * the only write path and must serialize across processes — an O_EXCL lock
 * file (`auth.json.lock` carrying pid + timestamp) is taken around each
 * read-modify-write, with bounded retry, and crashed holders are reclaimed via
 * pid liveness + mtime staleness. In-process callers are additionally chained
 * on a promise queue (a file lock cannot serialize async continuations within
 * one process). Payload writes go to a temp file that atomically replaces the
 * target via rename, so readers never observe a torn file; the file is always
 * (re)created 0600 and the directory 0700.
 *
 * Corruption policy: an unparsable or shape-invalid auth.json is treated as
 * empty (console.warn, never throw) — a broken credential file must not take
 * the whole engine down; the next successful modify rewrites it cleanly.
 */
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The pi agent dir: env override first, else ~/.pi (pi CLI convention). */
export function resolveAgentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv) return fromEnv;
	return join(homedir(), ".pi");
}

/** Default credential file path (pi CLI's auth.json). */
export function resolveAuthPath(): string {
	return join(resolveAgentDir(), "auth.json");
}

const AUTH_DIR_MODE = 0o700;
const AUTH_FILE_MODE = 0o600;
/** A lock older than this is stale regardless of the recorded pid (pi uses 30s too). */
const DEFAULT_LOCK_STALE_MS = 30_000;
/** Total budget for acquiring the lock before giving up. */
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_BASE_MS = 10;
const LOCK_RETRY_MAX_MS = 200;

interface LockPayload {
	pid: number;
	at: number;
}

/** Structural check mirroring pi's auth.json validation (ReadOnlyAuthStorage). */
function isCredentialShape(value: unknown): value is Credential {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const c = value as Record<string, unknown>;
	if (c.type === "api_key") {
		const keyOk = c.key === undefined || typeof c.key === "string";
		const envOk = c.env === undefined
			|| (typeof c.env === "object" && c.env !== null && !Array.isArray(c.env)
				&& Object.values(c.env).every((v) => typeof v === "string"));
		return keyOk && envOk;
	}
	if (c.type === "oauth") {
		return typeof c.access === "string"
			&& typeof c.refresh === "string"
			&& typeof c.expires === "number"
			&& Number.isFinite(c.expires);
	}
	return false;
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface FileCredentialStoreOptions {
	/** Explicit file path (tests / alternate agent dirs). Default: resolveAuthPath(). */
	authPath?: string;
	/** Staleness threshold for a held lock. Default 30s. */
	lockStaleMs?: number;
	/** Total budget for lock acquisition before failing. Default 15s. */
	lockTimeoutMs?: number;
}

export class FileCredentialStore implements CredentialStore {
	readonly authPath: string;
	private readonly lockPath: string;
	private readonly lockStaleMs: number;
	private readonly lockTimeoutMs: number;
	/** Serializes this instance's own async modify/delete continuations. */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(options: FileCredentialStoreOptions = {}) {
		this.authPath = options.authPath ?? resolveAuthPath();
		this.lockPath = `${this.authPath}.lock`;
		this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
		this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	}

	// ── CredentialStore ──

	async read(providerId: string, options?: { signal?: AbortSignal }): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credential = this.readAll()[providerId];
		return credential ? structuredClone(credential) : undefined;
	}

	async list(options?: { signal?: AbortSignal }): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(this.readAll()).map(([entryId, credential]) => ({ providerId: entryId, type: credential.type }));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: { signal?: AbortSignal },
	): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.serialize(() =>
			this.withFileLock(async () => {
				const all = this.readAll();
				const current = all[providerId] ? structuredClone(all[providerId]) : undefined;
				const next = await fn(current);
				if (next === undefined) return current; // leave the entry unchanged
				all[providerId] = next;
				this.writeAll(all);
				return structuredClone(next);
			}));
	}

	async delete(providerId: string, options?: { signal?: AbortSignal }): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.serialize(async () => {
			await this.withFileLock(async () => {
				const all = this.readAll();
				if (!(providerId in all)) return undefined;
				delete all[providerId];
				this.writeAll(all);
				return undefined;
			});
		});
	}

	// ── internals ──

	/** Chain async write operations so concurrent modify/delete calls in THIS
	 * process settle strictly one after another (the file lock only guards
	 * cross-process races). */
	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(task, task);
		this.chain = run.catch(() => {});
		return run;
	}

	private ensureDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: AUTH_DIR_MODE });
	}

	/** Read + validate the whole file. Missing → {}; corrupt or invalid entries
	 * → warn and treat as absent (never throw — a broken auth.json must not
	 * brick the engine, and the next modify rewrites the file cleanly). */
	private readAll(): Record<string, Credential> {
		if (!existsSync(this.authPath)) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(readFileSync(this.authPath, "utf-8")));
		} catch (err) {
			console.warn(`[credential-store] auth.json is corrupt, treating as empty: ${err instanceof Error ? err.message : err} (${this.authPath})`);
			return {};
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			console.warn(`[credential-store] auth.json is not an object, treating as empty (${this.authPath})`);
			return {};
		}
		const out: Record<string, Credential> = {};
		for (const [providerId, credential] of Object.entries(parsed as Record<string, unknown>)) {
			if (!isCredentialShape(credential)) {
				console.warn(`[credential-store] auth.json has an invalid credential for provider "${providerId}", skipping it`);
				continue;
			}
			out[providerId] = credential;
		}
		return out;
	}

	/** Atomic replace: write a 0600 temp file in the same dir, then rename over
	 * the target so concurrent readers never see a partial file. */
	private writeAll(all: Record<string, Credential>): void {
		this.ensureDir();
		const tmp = `${this.authPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
		try {
			const fd = openSync(tmp, "wx", AUTH_FILE_MODE);
			try {
				writeFileSync(fd, JSON.stringify(all, null, 2), "utf-8");
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, this.authPath);
		} finally {
			try {
				rmSync(tmp, { force: true });
			} catch {
				/* rename already moved it */
			}
		}
	}

	/** True when the existing lock is safe to steal: the recorded pid is dead
	 * (crashed holder) or the lock is older than the staleness threshold. A LIVE
	 * pid — including our own, e.g. a sibling store instance in this process —
	 * is waited out, never stolen. */
	private lockIsStale(): boolean {
		let payload: LockPayload | undefined;
		try {
			payload = JSON.parse(readFileSync(this.lockPath, "utf-8")) as LockPayload;
		} catch {
			/* unreadable/missing lock content — fall back to mtime */
		}
		if (payload && Number.isFinite(payload.pid)) {
			try {
				process.kill(payload.pid, 0); // throws if the pid is gone
			} catch {
				return true; // dead holder → crashed run, reclaim immediately
			}
		}
		try {
			const ageMs = Date.now() - statSync(this.lockPath).mtimeMs;
			if (ageMs > this.lockStaleMs) return true;
		} catch {
			return true; // lock vanished — not stale, just gone
		}
		return false;
	}

	/** Take the cross-process lock (O_EXCL create), retrying with backoff.
	 * Stale/dead holders are reclaimed immediately; live holders are waited out
	 * up to {@link lockTimeoutMs}. */
	private async acquireLock(): Promise<void> {
		const deadline = Date.now() + this.lockTimeoutMs;
		let delay = LOCK_RETRY_BASE_MS;
		for (;;) {
			this.ensureDir();
			let fd = -1;
			try {
				fd = openSync(this.lockPath, "wx", AUTH_FILE_MODE);
				try {
					writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockPayload), "utf-8");
				} finally {
					closeSync(fd);
				}
				return;
			} catch (err) {
				if (fd !== -1) {
					try {
						closeSync(fd);
					} catch {
						/* already closed */
					}
				}
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
				if (Date.now() >= deadline) {
					throw new Error(`auth.json 凭证锁获取超时（另一进程可能卡在写入：${this.lockPath}）`);
				}
				if (this.lockIsStale()) {
					try {
						// Two processes may race to unlink a stale lock; only the next
						// O_EXCL create matters, so unlink failures are harmless.
						unlinkSync(this.lockPath);
					} catch {
						/* someone else reclaimed it first */
					}
					continue;
				}
				await sleep(Math.min(delay, deadline - Date.now()));
				delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
			}
		}
	}

	private releaseLock(): void {
		try {
			rmSync(this.lockPath, { force: true });
		} catch {
			/* best effort */
		}
	}

	/** Run `fn` while holding the cross-process lock. */
	private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquireLock();
		try {
			return await fn();
		} finally {
			this.releaseLock();
		}
	}
}
