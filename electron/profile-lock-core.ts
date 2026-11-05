/**
 * Profile lock — extracted from main.ts so the stale-lock rules are testable.
 *
 * FIELD 2026-11-04: after an update-related hard kill, Orion would not start for
 * over an hour. Its `.profile.lock` still named pid 27708, which was long dead,
 * and nothing reclaimed it. The old inline code called `process.kill(pid, 0)` and
 * treated "no throw" as "alive"; on Windows that call can resolve for a dead pid
 * (recycled pid / access-denied paths), so the app concluded another instance was
 * running and quit — leaving the profile permanently unstartable until someone
 * deleted the file by hand.
 *
 * The fix: ask an EXPLICIT liveness probe (WMI/`process.kill`) through one
 * injectable point, and treat anything that is not clearly alive as reclaimable.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = ".profile.lock";

export interface LockResult {
	acquired: boolean;
	/** Why acquisition failed, or what was reclaimed. */
	reason?: "in-use" | "reclaimed-stale" | "reclaimed-corrupt" | "reclaimed-own" | "taken" | "write-failed";
	/** The pid that was found in an existing lock, when there was one. */
	foundPid?: number;
}

/** True when `pid` names a running process. */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process EXISTS but belongs to another user — that is
		// still "alive" for our purposes (we must not steal its profile).
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Acquire the profile lock.
 *
 * `pid` defaults to the current process; `isAlive` is injectable so tests can
 * model a dead owner without spawning one.
 */
export function acquireProfileLock(
	userDataDir: string,
	opts: { pid?: number; isAlive?: (pid: number) => boolean; log?: (msg: string) => void } = {},
): LockResult {
	const pid = opts.pid ?? process.pid;
	const alive = opts.isAlive ?? isProcessAlive;
	const log = opts.log ?? ((m: string) => console.error(m));
	const lockPath = join(userDataDir, LOCK_FILE);

	const take = (): LockResult => {
		try {
			const fd = openSync(lockPath, "w");
			writeFileSync(fd, String(pid));
			closeSync(fd);
			return { acquired: true, reason: "taken" };
		} catch {
			return { acquired: false, reason: "write-failed" };
		}
	};

	if (!existsSync(lockPath)) return take();

	let foundPid = Number.NaN;
	try {
		foundPid = Number(readFileSync(lockPath, "utf8").trim());
	} catch {
		/* unreadable → treat as corrupt */
	}

	// A lock naming OURSELVES is a leftover from our own restart (e.g. the update
	// handover), never a competing instance.
	if (Number.isInteger(foundPid) && foundPid === pid) {
		const r = take();
		return { ...r, reason: "reclaimed-own", foundPid };
	}

	// Live owner → refuse. Anything else (dead, corrupt, unparseable) is reclaimed
	// rather than obeyed: a profile must never be permanently unstartable because
	// of a leftover file.
	if (Number.isInteger(foundPid) && foundPid > 0 && alive(foundPid)) {
		log(`[main] profile already running (pid ${foundPid}); exiting.`);
		return { acquired: false, reason: "in-use", foundPid };
	}

	const stale = Number.isInteger(foundPid) && foundPid > 0;
	try {
		unlinkSync(lockPath);
	} catch {
		/* ignore: `take` will report a write failure if it still exists */
	}
	const r = take();
	return { ...r, reason: stale ? "reclaimed-stale" : "reclaimed-corrupt", foundPid: Number.isNaN(foundPid) ? undefined : foundPid };
}

/** Remove the lock if we own it (best effort; never throws). */
export function releaseProfileLock(userDataDir: string, pid: number = process.pid): void {
	const lockPath = join(userDataDir, LOCK_FILE);
	try {
		if (!existsSync(lockPath)) return;
		const found = Number(readFileSync(lockPath, "utf8").trim());
		if (found === pid) unlinkSync(lockPath);
	} catch {
		/* best effort */
	}
}
