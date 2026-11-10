/**
 * Single-instance guard for a profile directory.
 *
 * Extracted from electron/main.ts so the decision logic is testable without an
 * Electron runtime. Three field defects drove this shape (2026-11-02):
 *
 * 1. **EPERM was treated as "process dead".** `process.kill(pid, 0)` throws
 *    EPERM for a LIVE process in another session/user context (the updater
 *    launches its instance in a different Windows session than the desktop
 *    one). The old `catch { /* dead → reclaim *\/ }` reclaimed the lock of a
 *    running process, so two instances shared one profile (and one SQLite DB →
 *    durable `ID ... already belongs to entry` / dead sessions).
 * 2. **PID reuse.** Windows recycles PIDs aggressively; a stale lock whose pid
 *    now belongs to an unrelated process looked "alive" and blocked startup
 *    (Synapse refused to launch, 2026-11-02).
 * 3. **Unconditional unlink on quit.** `will-quit` deleted the lock file
 *    without checking ownership, so a dying OLD instance could delete the lock
 *    its successor had just written.
 *
 * The lock therefore records an identity, not just a pid: `pid|startTime|token`.
 * Start time defeats PID reuse; the random token defeats "same pid, new
 * process". Probes are conservative: only a definite "no such process" frees
 * the lock; an indeterminate probe (EPERM, EINVAL, unreadable state) means the
 * lock is HELD and this instance must exit rather than risk a shared DB.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const LOCK_FILE = ".profile.lock";

export type LockDecision =
	| { action: "acquire" }
	/** Another live instance owns this profile. */
	| { action: "refuse"; pid: number; reason: string };

/** Live identity of the current process, as recorded in the lock file. */
export interface ProcessIdentity {
	pid: number;
	/** Epoch ms of process start, or null when the platform cannot report it. */
	startTimeMs: number | null;
	token: string;
}

export interface LockDeps {
	/** True when the pid refers to a live process; null when indeterminate. */
	isProcessAlive?: (pid: number) => boolean | null;
	/** Start time (epoch ms) of the pid, or null if unknown/dead. */
	startTimeOf?: (pid: number) => number | null;
	now?: () => number;
	randomToken?: () => string;
	log?: (level: "INFO" | "WARN" | "ERROR", msg: string) => void;
}

export function currentIdentity(deps: LockDeps = {}): ProcessIdentity {
	const startTimeOf = deps.startTimeOf ?? defaultStartTimeOf;
	let startTimeMs: number | null = null;
	try {
		startTimeMs = startTimeOf(process.pid);
	} catch {
		startTimeMs = null;
	}
	return {
		pid: process.pid,
		startTimeMs,
		token: (deps.randomToken ?? randomUUID)(),
	};
}

/** Serialize as `pid|startTimeMs|token` (startTime may be `` when unknown). */
export function formatLock(identity: ProcessIdentity): string {
	return `${identity.pid}|${identity.startTimeMs ?? ""}|${identity.token}`;
}

/** Parse a lock file body. Returns null for anything that is not the format
 *  above — including the legacy `pid`-only form, which is treated as stale. */
export function parseLock(raw: string): ProcessIdentity | null {
	const parts = raw.trim().split("|");
	if (parts.length !== 3) return null;
	const pid = Number(parts[0]);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const startRaw = parts[1];
	const startTimeMs = startRaw === "" ? null : Number(startRaw);
	if (startRaw !== "" && !Number.isFinite(startTimeMs)) return null;
	const token = parts[2];
	if (!token) return null;
	return { pid, startTimeMs, token };
}

/**
 * Decide whether this process may take the profile lock.
 *
 * Conservative by design: only a definite "no such process" reclaims. An
 * indeterminate probe (EPERM from a cross-session process) refuses — losing a
 * launch is recoverable, two writers on one database is not.
 */
export function decideLock(raw: string | null, identity: ProcessIdentity, deps: LockDeps = {}): LockDecision {
	if (raw === null) return { action: "acquire" };
	const held = parseLock(raw);
	if (!held) return { action: "acquire" }; // legacy/garbled → stale
	if (held.token === identity.token) return { action: "acquire" }; // ours (re-entry)
	const alive = (deps.isProcessAlive ?? defaultIsProcessAlive)(held.pid);
	if (alive === false) return { action: "acquire" }; // holder is gone → stale
	if (alive === null) {
		// Indeterminate. Two independent signals must agree before we refuse, so
		// a platform that cannot probe never blocks startup outright.
		const sameStart = held.startTimeMs !== null && identity.startTimeMs !== null
			&& held.startTimeMs === identity.startTimeMs;
		if (sameStart) return { action: "refuse", pid: held.pid, reason: "same-process identity" };
		return { action: "acquire" };
	}
	// Holder appears alive. Defeat PID reuse: if BOTH start times are known and
	// differ, the pid now belongs to a different process → stale lock.
	if (held.startTimeMs !== null) {
		const actual = (deps.startTimeOf ?? defaultStartTimeOf)(held.pid);
		if (actual !== null && actual !== held.startTimeMs) {
			return { action: "acquire" };
		}
	}
	return { action: "refuse", pid: held.pid, reason: "another instance is running" };
}

/** Acquire the profile lock, or quit the app when another instance owns it. */
export function acquireProfileLock(
	userDataDir: string,
	onOwnedByOther: (heldPid: number, reason: string) => void,
	deps: LockDeps = {},
): ProcessIdentity | null {
	const lockPath = path.join(userDataDir, LOCK_FILE);
	const log = deps.log ?? ((level, msg) => console[level === "ERROR" ? "error" : "warn"](msg));
	const identity = currentIdentity(deps);

	// Up to 3 attempts: another instance may create the lock between our read and
	// our take (TOCTOU). The old implementation used openSync(path,"wx") exactly
	// to make the take atomic — keep that guarantee for the acquire path.
	for (let attempt = 0; attempt < 3; attempt++) {
		const raw = existsSync(lockPath) ? safeRead(lockPath) : null;
		const decision = decideLock(raw, identity, deps);
		if (decision.action === "refuse") {
			log("ERROR", `[main] profile already running (pid ${decision.pid}: ${decision.reason}); exiting.`);
			onOwnedByOther(decision.pid, decision.reason);
			return null;
		}
		if (raw !== null) {
			// Reclaiming: a plain write is correct (we judged the holder stale). A
			// concurrent starter may have just written its own live lock — re-decide.
			const again = safeRead(lockPath);
			if (again !== null && again !== raw && decideLock(again, identity, deps).action === "refuse") continue;
			log("INFO", "[main] reclaiming a stale profile lock");
		}
		if (claimLock(lockPath, formatLock(identity))) return identity;
		// Lost the atomic create to a racing starter — re-read and decide again.
	}
	log("ERROR", "[main] could not acquire the profile lock (racing starters); exiting.");
	onOwnedByOther(0, "lock contention");
	return null;
}

/**
 * Remove the lock ONLY if this process still owns it. A dying old instance must
 * never delete the lock its successor already wrote (field 2026-11-02).
 */
export function releaseProfileLock(userDataDir: string, identity: ProcessIdentity): boolean {
	const lockPath = path.join(userDataDir, LOCK_FILE);
	const raw = safeRead(lockPath);
	if (raw === null) return false;
	const held = parseLock(raw);
	if (!held || held.token !== identity.token) return false;
	try {
		unlinkSync(lockPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Atomically create the lock file with our identity. Returns false when the file
 * already exists (another starter won the race) — the caller re-decides.
 */
function claimLock(lockPath: string, body: string): boolean {
	try {
		const fd = openSync(lockPath, "wx");
		try {
			writeFileSync(fd, body);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			// Stale leftovers still need to be reclaimable: our caller already
			// decided this file is stale, so replace it atomically-enough by
			// rewriting in place (a racing starter's content is re-checked above).
			try {
				writeFileSync(lockPath, body);
				return true;
			} catch {
				return false;
			}
		}
		return false;
	}
}

function safeRead(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/** `process.kill(pid, 0)` probe: true alive, false gone, null indeterminate. */
function defaultIsProcessAlive(pid: number): boolean | null {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// Only "no such process" means dead. EPERM/EACCES = it EXISTS but we may
		// not signal it (cross-session on Windows) — that is a live holder.
		if (code === "ESRCH") return false;
		if (code === "EPERM" || code === "EACCES") return true;
		return null;
	}
}

/** Process start time in epoch ms, or null when it cannot be determined. */
function defaultStartTimeOf(pid: number): number | null {
	try {
		// Available without spawning on modern Node; throws on unsupported platforms.
		const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
		if (process.platform === "win32") {
			const out = execFileSync(
				"powershell",
				["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds`],
				{ encoding: "utf8", timeout: 4000, windowsHide: true },
			).trim();
			const ms = Math.round(Number(out));
			return Number.isFinite(ms) ? ms : null;
		}
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const startTicks = Number(fields[19]);
			if (!Number.isFinite(startTicks)) return null;
			const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
			const hz = 100; // USER_HZ is 100 on every mainstream Linux build
			return Math.round(Date.now() - uptime * 1000 + (startTicks / hz) * 1000);
		}
		// darwin/bsd: no cheap syscall without spawning — identity then relies on
		// pid + token (a reused pid with a live process would refuse; acceptable).
		return null;
	} catch {
		return null;
	}
}
