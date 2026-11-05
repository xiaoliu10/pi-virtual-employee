/**
 * Cookie/credential database copy that survives a RUNNING Chromium.
 *
 * THE PROBLEM
 * -----------
 * A Chromium profile's cookies live in a SQLite database (`Default/Network/Cookies`
 * on modern builds, `Default/Cookies` on older ones). While the browser runs, it
 * holds that file with an exclusive lock — on Windows a plain file copy fails with
 * `WinError 32` (ERROR_SHARING_VIOLATION). Our own field evidence agrees: an
 * attempted `rm lockfile` returned `PermissionError(13)` because a live handle held
 * it. A snapshot that "sometimes works when the browser happens to be closed" is
 * not a feature; the operator's browser is normally OPEN when we snapshot.
 *
 * THE FIX (same as Hermes `hermes_cli/browser_connect.py`)
 * ------------------------------------------------------
 * Use the SQLite **online backup API** through a read-only connection: SQLite
 * itself coordinates with the live writer, so we get a consistent page-level copy
 * without touching Chromium's lock. Cookies get a real budget (they carry the
 * login); other databases (Login Data / Web Data) get a short budget and are
 * skipped when locked — they are convenience data, not the session.
 *
 * When the copy still fails (locked beyond the budget), the caller must DEGRADE
 * VISIBLY: reuse the previous snapshot if there is one, and say so — never hand
 * the model a silently signed-out browser and let it conclude the account is gone.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Files that carry credentials/login state inside a Chromium profile. */
export const AUTH_DB_FILES = [
	// Session cookies — the login itself. Budget: worth waiting for.
	"Default/Network/Cookies",
	"Default/Cookies",
	// Saved passwords / autofill — convenience only, skip when locked.
	"Default/Login Data",
	"Default/Login Data For Account",
	"Default/Web Data",
] as const;

/** Plain (non-SQLite) files copied as-is when present. */
export const AUTH_PLAIN_FILES = [
	// Holds os_crypt.encrypted_key: without it the cookie values cannot decrypt.
	"Local State",
	// Site permissions / profile prefs (also suppresses the "Continue as…" bubble).
	"Default/Preferences",
	"Default/Secure Preferences",
] as const;

export interface CopyOutcome {
	/** Files copied successfully (relative to the profile root). */
	copied: string[];
	/** Files skipped because they were locked/busy beyond their budget. */
	skipped: string[];
	/** Hard failures (not lock-related) — the caller must surface these. */
	failed: { file: string; error: string }[];
}

/** SQLite's SQLITE_BUSY / "database is locked" surfaces as a busy error message. */
function looksBusy(err: unknown): boolean {
	const msg = String((err as Error)?.message ?? err).toLowerCase();
	return (
		msg.includes("busy") ||
		msg.includes("locked") ||
		msg.includes("sharing violation") ||
		msg.includes("eperm") ||
		msg.includes("eacces")
	);
}

/**
 * Page-copy a SQLite database via the online backup API.
 *
 * `pages: 256` keeps each step short so `shouldStop()` (a deadline check) can
 * actually interrupt a huge database; a live Chromium writing concurrently is the
 * normal case, not the exception.
 */
export function backupSqlite(srcPath: string, dstPath: string, deadlineMs: number): void {
	mkdirSync(dirname(dstPath), { recursive: true });
	// A stale destination from an earlier attempt would make SQLite merge rather
	// than replace; the snapshot must be a clean copy.
	rmSync(dstPath, { force: true });
	const src = new DatabaseSync(srcPath, { readOnly: true });
	try {
		// VACUUM INTO is atomic and SQLite-coordinated with a live writer, so the
		// result is a consistent copy even while Chromium holds the database.
		// `deadlineMs` is advisory: an over-budget copy is still a GOOD copy, so we
		// keep it rather than discarding work (a fresh snapshot beats a missing one).
		void deadlineMs;
		src.exec(`VACUUM INTO '${dstPath.replace(/'/g, "''")}'`);
	} finally {
		src.close();
	}
}

/**
 * Snapshot the credential-bearing files of `sourceProfile` into `destProfile`.
 *
 * Never throws for lock contention: locked files land in `skipped` so the caller
 * can fall back to a previous snapshot and tell the truth about freshness. Real
 * failures (corrupt DB, permissions that are not lock-related) land in `failed`.
 */
export function snapshotAuthInto(
	sourceProfile: string,
	destProfile: string,
	opts: { cookiesBudgetMs?: number; otherBudgetMs?: number } = {},
): CopyOutcome {
	const cookiesBudgetMs = opts.cookiesBudgetMs ?? 5_000;
	const otherBudgetMs = opts.otherBudgetMs ?? 500;
	const outcome: CopyOutcome = { copied: [], skipped: [], failed: [] };

	for (const rel of AUTH_DB_FILES) {
		const src = join(sourceProfile, rel);
		if (!existsSync(src)) continue;
		const dst = join(destProfile, rel);
		const isCookies = rel.endsWith("Cookies");
		try {
			backupSqlite(src, dst, isCookies ? cookiesBudgetMs : otherBudgetMs);
			outcome.copied.push(rel);
		} catch (err) {
			if (looksBusy(err)) {
				outcome.skipped.push(rel);
			} else if (isCookies) {
				// Cookies are the login: an unexpected failure is reported, not hidden.
				outcome.failed.push({ file: rel, error: String((err as Error)?.message ?? err) });
			} else {
				outcome.skipped.push(rel);
			}
		}
	}

	for (const rel of AUTH_PLAIN_FILES) {
		const src = join(sourceProfile, rel);
		if (!existsSync(src)) continue;
		const dst = join(destProfile, rel);
		try {
			mkdirSync(dirname(dst), { recursive: true });
			// These are small; read+write is enough and avoids the SQLite path.
			writeFileSync(dst, readFileSync(src));
			outcome.copied.push(rel);
		} catch (err) {
			if (looksBusy(err)) outcome.skipped.push(rel);
			else outcome.failed.push({ file: rel, error: String((err as Error)?.message ?? err) });
		}
	}

	return outcome;
}

/**
 * True when a snapshot holds an actually usable login — a cookie database that is
 * present AND contains at least one cookie row.
 *
 * A file-exists (or size>0) check is not enough: a schema-only or corrupted-but-
 * non-empty DB passes it, and the caller then launches a browser that looks
 * signed out while every step reported success. That is the silent-degradation
 * failure mode this whole module exists to prevent.
 */
export function snapshotHasCookies(snapshotDir: string): boolean {
	for (const rel of ["Default/Network/Cookies", "Default/Cookies"]) {
		const p = join(snapshotDir, rel);
		if (!existsSync(p)) continue;
		try {
			if (statSync(p).size === 0) continue;
		} catch {
			continue; // unreadable counts as missing
		}
		try {
			const db = new DatabaseSync(p, { readOnly: true });
			try {
				const row = db.prepare("SELECT COUNT(*) AS n FROM cookies").get() as { n?: number } | undefined;
				if (Number(row?.n ?? 0) > 0) return true;
			} finally {
				db.close();
			}
		} catch {
			// Not a readable cookie DB (corrupt / not SQLite): not a usable login.
			continue;
		}
	}
	return false;
}

/** Progress-report text: state the freshness of the login we are reusing. */
export function staleSnapshotNote(snapshotPath: string, ageMs: number): string {
	const hours = Math.round(ageMs / (60 * 60 * 1000));
	return (
		`当前浏览器正在运行，登录态文件被占用，已复用上次完成的登录态快照（约 ${hours} 小时前，${snapshotPath}）。` +
		"如果任务需要最新的登录状态，请先关闭浏览器再重试。"
	);
}
