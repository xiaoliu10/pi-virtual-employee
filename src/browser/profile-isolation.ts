/**
 * Browser profile isolation — "copy the login profile out, then use the copy".
 *
 * FIELD 2026-11-04: a scheduled reconciliation task ran two work windows against
 * the same persistent Chromium profile (`spay_profile`). Chromium allows exactly
 * ONE process per user-data-dir; the second launch died with
 * `exitCode=21 — the known persistent lock issue`, and the runs kept fighting
 * over it. The model's workaround was to hand-write `shutil.copytree` into ad-hoc
 * scripts (`chk9.py`), which produced TWELVE stale `spay_profile*` directories on
 * the box and still raced each other.
 *
 * This module makes that a first-class capability:
 *   - a MASTER profile holds the login state (read-only in practice);
 *   - every launch gets a FRESH COPY in a temp dir, so two browsers never share
 *     a user-data-dir and the SingletonLock can never collide;
 *   - copies are swept when the context closes, and stale copies from a crash
 *     are swept on the next launch.
 *
 * Copying (rather than sharing) costs a little disk and startup time; it is the
 * only way two concurrent runs can both be logged in.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

/** Chromium's per-user-data-dir lock files. A copy carrying these is a landmine:
 *  the fresh process sees a "running instance" that does not exist. */
const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

/** Cache/scratch dirs that only inflate the copy and are rebuilt on demand. */
const SKIP_DIRS = new Set([
	"Crashpad",
	"ShaderCache",
	"GPUCache",
	"Code Cache",
	"GrShaderCache",
	"GraphiteDawnCache",
	"BrowserMetrics",
	"component_crx_cache",
	"Default/Cache",
	"Default/Code Cache",
	"Default/GPUCache",
	"Default/DawnCache",
	"Default/DawnGraphiteCache",
	"Default/DawnWebGPUCache",
	".org.chromium.Chromium.*",
]);

export interface CloneOptions {
	/** Master profile holding the login state. */
	source: string;
	/** Where copies are created (defaults to the OS temp dir). */
	root?: string;
	/** Unique suffix (usually a conversation id or work-item id). */
	label: string;
	/** Overwrite an existing copy for the same label (default false). */
	force?: boolean;
}

export interface CloneResult {
	/** The isolated profile directory to hand to launchPersistentContext. */
	profileDir: string;
	/** True when an existing copy was reused (force=false). */
	reused: boolean;
}

/**
 * Sanitize a label into a safe directory name.
 *
 * SECURITY: the label comes from a conversation/work-item id, but it is also
 * reachable from model-supplied text. Stripping only non-safe characters left
 * `..` intact, so `../../etc/passwd` would have escaped the clone root (found by
 * this module's own test). Dots are removed entirely — no legitimate id needs
 * them — and only one trailing join happens, so the result is always a direct
 * child of the root.
 */
export function cloneDirName(label: string): string {
	const safe = label
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return `ve-browser-${safe || "default"}`;
}

/**
 * Create (or reuse) an isolated copy of the master profile.
 *
 * Refuses when the master does not exist — silently falling back to a fresh
 * empty profile would look like "logged out" and send the model hunting for
 * cookies, which is worse than a clear error.
 */
export function cloneBrowserProfile(opts: CloneOptions): CloneResult {
	const { source, label, force = false } = opts;
	if (!existsSync(source)) {
		throw new Error(`浏览器 profile 模板不存在：${source}`);
	}
	const root = opts.root ?? join(tmpdir(), "ve-browser-profiles");
	mkdirSync(root, { recursive: true });
	const profileDir = join(root, cloneDirName(label));

	if (existsSync(profileDir) && !force) return { profileDir, reused: true };
	if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });

	cpSync(source, profileDir, {
		recursive: true,
		// A copy that carries SingletonLock makes Chromium refuse to start with
		// "profile appears to be in use". Strip them; also strip pure caches.
		filter: (src) => {
			const name = basename(src);
			if (SINGLETON_FILES.includes(name)) return false;
			const rel = src.slice(source.length + 1).replace(/\\/g, "/");
			if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(name)) return false;
			return true;
		},
	});
	return { profileDir, reused: false };
}

/** Remove one isolated copy (best effort). */
export function removeClone(profileDir: string): void {
	try {
		rmSync(profileDir, { recursive: true, force: true });
	} catch {
		/* the next sweep retries */
	}
}

/**
 * Sweep stale copies older than `maxAgeMs`.
 *
 * A crashed run leaves its copy behind, and Chromium profiles are large; without
 * this the box accumulates them forever (field: 12 stale `spay_profile*` dirs,
 * ~150MB each).
 */
export function sweepClones(root: string, maxAgeMs: number, now = Date.now()): string[] {
	if (!existsSync(root)) return [];
	const removed: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("ve-browser-")) continue;
		const full = join(root, entry.name);
		try {
			if (now - statSync(full).mtimeMs < maxAgeMs) continue;
			rmSync(full, { recursive: true, force: true });
			removed.push(full);
		} catch {
			/* in use / locked: leave it for the next sweep */
		}
	}
	return removed;
}

/** Where copies live by default. */
export function defaultCloneRoot(): string {
	return join(tmpdir(), "ve-browser-profiles");
}
