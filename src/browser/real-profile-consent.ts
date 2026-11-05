/**
 * Real-profile browsing consent + snapshot lifecycle.
 *
 * Mirrors Hermes (`tools/browser_session_real_profile.py`): the operator opts in
 * via config, we snapshot the browser profile into a VE-owned copy, run against
 * that copy, and DELETING the consent deletes the credential copies. A user's
 * cookies are credentials; keeping a copy around after they said no would be a
 * silent credential leak.
 *
 * Consent is an explicit boolean in config (`browser.useRealProfile`) — never
 * inferred from a path string. browser-use learned this the hard way: its copy
 * logic keys off `'chrome' in path`, so an MCP profile at
 * `~/.config/browseruse/profiles/default` silently skipped isolation and 36
 * processes fought over one lock (issue #4548, still unfixed upstream).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directory (under the app profile dir) holding snapshots made for real-profile browsing. */
export const SNAPSHOT_ROOT = "browser-profile-snapshots";

export interface ConsentState {
	/** Operator turned real-profile browsing on. */
	enabled: boolean;
	/** Snapshot root for this app profile. */
	snapshotRoot: string;
	/** Snapshots currently on disk. */
	snapshots: string[];
}

/** Resolve the snapshot root for an app profile. */
export function snapshotRoot(profileDir: string): string {
	return join(profileDir, SNAPSHOT_ROOT);
}

/** What is on disk right now (used to prove that revoking consent deletes copies). */
export function listSnapshots(profileDir: string): string[] {
	const root = snapshotRoot(profileDir);
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join(root, e.name));
	} catch {
		return [];
	}
}

/**
 * Delete every snapshot. Called when consent is turned off, on app exit when
 * consent is off, and defensively at startup.
 *
 * Best effort per entry: a locked file must not prevent cleaning the rest, but
 * the failure is reported so the caller can log it (never silent).
 */
export function deleteSnapshots(profileDir: string): { removed: string[]; failed: string[] } {
	const removed: string[] = [];
	const failed: string[] = [];
	for (const dir of listSnapshots(profileDir)) {
		try {
			rmSync(dir, { recursive: true, force: true });
			removed.push(dir);
		} catch {
			failed.push(dir);
		}
	}
	return { removed, failed };
}

/**
 * Apply a consent change: turning it OFF must delete the copies.
 *
 * Returns what happened so the caller can log it and surface a failure to the
 * operator — the only acceptable reason to leave a credential copy behind is a
 * locked file, and that must be visible.
 */
export function applyConsentChange(profileDir: string, enabled: boolean): { removed: string[]; failed: string[] } {
	if (enabled) return { removed: [], failed: [] };
	return deleteSnapshots(profileDir);
}

/** Ensure the snapshot root exists (called right before a snapshot is written). */
export function ensureSnapshotRoot(profileDir: string): string {
	const root = snapshotRoot(profileDir);
	mkdirSync(root, { recursive: true });
	return root;
}

/**
 * Sweep snapshots older than `maxAgeMs`.
 *
 * A crashed run leaves its snapshot behind and Chromium profiles are large, so
 * without this the disk fills silently — browser-use accumulated 7741 temp
 * profile dirs / 14GB because its cleanup filter never matched the prefix it
 * created (issue #5422, still unfixed upstream). The prefix check and the
 * creation prefix here come from the SAME constant, which is the actual fix.
 */
export function sweepSnapshots(profileDir: string, maxAgeMs: number, now = Date.now()): string[] {
	const removed: string[] = [];
	for (const dir of listSnapshots(profileDir)) {
		try {
			if (now - statSync(dir).mtimeMs < maxAgeMs) continue;
			rmSync(dir, { recursive: true, force: true });
			removed.push(dir);
		} catch {
			/* in use: the next sweep retries */
		}
	}
	return removed;
}

/** Human-facing explanation of what turning the switch on means. */
export const CONSENT_COPY = {
	title: "使用你的真实浏览器登录态",
	body:
		"开启后，虚拟员工会把本机浏览器的登录态（cookies / 登录凭据）复制一份到自己的目录里，用于替你完成需要登录的任务。" +
		"关闭后，这些副本会被立即删除。登录态档案不会离开这台机器。",
	revokeNote: "已关闭并删除登录态副本。",
} as const;
