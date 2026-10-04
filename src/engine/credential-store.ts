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
 * file (`auth.json.lock` carrying pid + timestamp + a per-attempt token) is
 * taken around each read-modify-write, with bounded retry, and crashed holders
 * are reclaimed via pid liveness + mtime staleness. Three content checks close
 * the double-hold races of a file lock: the reclaiming unlink re-verifies the
 * lock STILL holds exactly the stale payload it judged (a waiter that raced
 * the same verdict may have recreated it); a successful O_EXCL create is not
 * trusted blindly — the file is re-read and accepted only if it carries OUR
 * token; and the releasing unlink only deletes a lock that still carries our
 * own token (a long-held lock may have been legitimately reclaimed meanwhile).
 * In-process callers are additionally chained on a promise queue (a file lock
 * cannot serialize async continuations within one process). Payload writes go
 * to a temp file that atomically replaces the target via rename, so readers
 * never observe a torn file; the file is always (re)created 0600 and the
 * directory 0700.
 *
 * Corruption policy: an unparsable or shape-invalid auth.json is treated as
 * empty (console.warn, never throw) — a broken credential file must not take
 * the whole engine down; the next successful modify rewrites it cleanly.
 */
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
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
	/** Holder identity, fresh per acquisition attempt: content comparison
	 * against THIS value is what tells "our lock" from "a lock someone rebuilt
	 * in the race window" (pid alone cannot — pids repeat across processes and
	 * collide with sibling stores in-process). Old writers (pi CLI) omit it;
	 * comparisons with our own token simply never match then. */
	token?: string;
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
	/** Token of the lock currently held, if any. Set only after the post-create
	 * verification, cleared on release. */
	private heldLockToken?: string;

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

	/** Raw lock content, or undefined when absent/unreadable. */
	private readLockText(): string | undefined {
		try {
			return readFileSync(this.lockPath, "utf-8");
		} catch {
			return undefined;
		}
	}

	/** Parsed lock payload, or undefined when absent/unparsable. */
	private readLockPayload(): LockPayload | undefined {
		const text = this.readLockText();
		if (text === undefined) return undefined;
		try {
			const parsed = JSON.parse(text) as LockPayload;
			return parsed && typeof parsed === "object" ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	/** Verdict on the existing lock: undefined = absent or not safe to steal;
	 * otherwise stale, together with the raw content the verdict was based on.
	 * Stale means: the recorded pid is dead (crashed holder) or the lock is
	 * older than the staleness threshold. A LIVE pid — including our own, e.g. a
	 * sibling store instance in this process — is waited out, never stolen.
	 * The observed content travels with the verdict so the reclaiming unlink can
	 * re-verify nothing changed underneath (see acquireLock). */
	private lockIsStale(): { observed: string } | undefined {
		const observed = this.readLockText();
		if (observed === undefined) return undefined; // no lock — nothing to steal; the next wx create decides
		let payload: LockPayload | undefined;
		try {
			payload = JSON.parse(observed) as LockPayload;
		} catch {
			/* unreadable lock content — fall back to mtime */
		}
		if (payload && Number.isFinite(payload.pid)) {
			try {
				process.kill(payload.pid, 0); // throws if the pid is gone
			} catch {
				return { observed }; // dead holder → crashed run, reclaim immediately
			}
		}
		try {
			const ageMs = Date.now() - statSync(this.lockPath).mtimeMs;
			if (ageMs > this.lockStaleMs) return { observed };
		} catch {
			return undefined; // lock vanished between read and stat — not stale, just gone
		}
		return undefined;
	}

	/** Take the cross-process lock (O_EXCL create), retrying with backoff.
	 * Stale/dead holders are reclaimed with a content re-check; live holders are
	 * waited out up to {@link lockTimeoutMs}. Ownership is only trusted after a
	 * post-create re-read confirms the file carries our token. */
	private async acquireLock(): Promise<void> {
		const deadline = Date.now() + this.lockTimeoutMs;
		let delay = LOCK_RETRY_BASE_MS;
		for (;;) {
			this.ensureDir();
			const token = randomUUID();
			let fd = -1;
			try {
				fd = openSync(this.lockPath, "wx", AUTH_FILE_MODE);
				try {
					writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token } satisfies LockPayload), "utf-8");
				} finally {
					closeSync(fd);
				}
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
				const stale = this.lockIsStale();
				if (stale && this.readLockText() === stale.observed) {
					// Reclaim with re-verification: between our staleness verdict and
					// this unlink, another waiter may have unlinked + RECREATED the
					// lock (it raced the same verdict against the same old content).
					// Deleting blind would drop THEIR fresh lock and let two processes
					// hold the lock at once — only unlink when the file still holds
					// exactly the stale payload we judged; anything else (or a vanished
					// file) sends us back around the loop to re-judge.
					try {
						unlinkSync(this.lockPath);
					} catch {
						/* someone else reclaimed it first */
					}
				}
				await sleep(Math.min(delay, deadline - Date.now()));
				delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
				continue;
			}
			// O_EXCL create succeeded — but possession still needs verification:
			// a waiter whose staleness verdict predates our create may unlink our
			// fresh lock and recreate its own right here. Accept the lock only if
			// the file NOW carries OUR payload; anything else (or a vanished file)
			// means we lost that race — keep waiting like any other contender.
			const payload = this.readLockPayload();
			if (payload?.pid === process.pid && payload.token === token) {
				this.heldLockToken = token;
				return;
			}
			if (Date.now() >= deadline) {
				throw new Error(`auth.json 凭证锁获取超时（另一进程可能卡在写入：${this.lockPath}）`);
			}
			await sleep(Math.min(delay, deadline - Date.now()));
			delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
		}
	}

	private releaseLock(): void {
		try {
			// Only unlink OUR OWN lock (content check against our token): while a
			// long fn runs, another process may legitimately reclaim the by-then
			// stale lock and recreate it — deleting blind would drop THEIR lock and
			// open a double-hold window. A foreign or vanished lock is left alone.
			const payload = this.readLockPayload();
			if (this.heldLockToken !== undefined && payload?.pid === process.pid && payload.token === this.heldLockToken) {
				rmSync(this.lockPath, { force: true });
			}
		} catch {
			/* best effort */
		} finally {
			this.heldLockToken = undefined;
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
