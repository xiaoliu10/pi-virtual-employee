/**
 * Per-profile updater cache isolation (v0.2.229).
 *
 * Field incident this exists for (2026-11-12): the Windows box ran three
 * profiles whose updater logs ALL said `updater cache dir:
 * ...\pi-virtual-employee-updater` — one shared directory. Three instances
 * running `emptyDir(pending)` and `temp-*.exe -> final` renames over the same
 * folder deleted each other's downloads mid-flight, producing the exact log
 * family on that box: `Cannot rename temp file ... ENOENT`, `watchdog setup
 * failed: ENOENT copyfile`, `Cannot run installer: ENOENT spawn` — two
 * consecutive cross-version failures tripped the machine breaker and
 * auto-install stayed off until a manual repair.
 *
 * Why the old fix never worked: `isolateUpdaterCache` guarded on
 * `setUpdaterCacheDir` — an API electron-updater 6.8.9 does NOT have — so the
 * function silently returned for every profile and the shared dir stayed. The
 * lesson is encoded here: isolation either HAPPENS (a log line names the dir)
 * or SAYS SO (a WARN) — never a silent return.
 *
 * How it actually works (electron-updater 6.x, AppUpdater.js):
 *   getOrCreateDownloadHelper() builds the helper ONCE from the static
 *   app-update.yml `updaterCacheDirName` and caches it on
 *   `updater.downloadedUpdateHelper`. Pre-seeding that exact field with our own
 *   `DownloadedUpdateHelper(isolatedDir)` makes the cache hit before
 *   electron-updater ever creates the shared one; `emptyDir` and the
 *   `temp-*` dance then all happen inside the profile's own directory.
 *   `baseCachePath` has no consumers outside the updater, and the default
 *   profile keeps the original path so an existing download is not orphaned.
 */

/** Minimal shape of the electron-updater instance we need to touch. */
export interface UpdaterLike {
	/** Present only in hypothetical newer electron-updater versions. */
	setUpdaterCacheDir?: unknown;
	/** Pre-created helper; if unset, electron-updater builds one from app-update.yml (the shared dir). */
	downloadedUpdateHelper?: unknown;
}

/** Minimal shape of electron-updater's DownloadedUpdateHelper we rely on. */
export interface HelperCtor {
	new (cacheDir: string): { cacheDir: string };
}

export interface CacheIsolationOutcome {
	/** true when the updater will now write into a profile-owned directory. */
	isolated: boolean;
	/** The directory the updater will use after this call. */
	cacheDir: string;
	/** Human-readable verdict — the caller logs it verbatim (no silent paths). */
	detail: string;
}

export function isolatedUpdaterCacheDir(baseCacheDir: string, profileName: string): string {
	return profileName && profileName !== "default" ? `${baseCacheDir}-${profileName}` : baseCacheDir;
}

/**
 * Point `updater` at a profile-owned cache directory.
 *
 * Order of preference:
 *  1. an official `setUpdaterCacheDir` API (forward compatibility — if
 *     electron-updater ever ships one, use it instead of touching internals);
 *  2. pre-seeding `downloadedUpdateHelper` with our own helper instance.
 *
 * Never throws: an isolation failure must not take the updater down — the
 * outcome's `detail` explains what to look at in the log.
 */
export function applyUpdaterCacheIsolation(
	profileName: string,
	updater: UpdaterLike,
	Helper: HelperCtor | null,
	baseCacheDir: string,
): CacheIsolationOutcome {
	const isolatedDir = isolatedUpdaterCacheDir(baseCacheDir, profileName);
	if (isolatedDir === baseCacheDir) {
		return { isolated: false, cacheDir: baseCacheDir, detail: `default profile keeps the shared cache dir ${baseCacheDir}` };
	}
	if (typeof updater.setUpdaterCacheDir === "function") {
		(updater.setUpdaterCacheDir as (dir: string) => void)(isolatedDir);
		return { isolated: true, cacheDir: isolatedDir, detail: `via setUpdaterCacheDir` };
	}
	if (!Helper) {
		return { isolated: false, cacheDir: baseCacheDir, detail: "DownloadedUpdateHelper unavailable — profiles share the cache dir; concurrent downloads of one version may collide (ENOENT) until this is fixed" };
	}
	try {
		const helper = new Helper(isolatedDir);
		if (!helper || typeof helper.cacheDir !== "string" || helper.cacheDir !== isolatedDir) {
			return { isolated: false, cacheDir: baseCacheDir, detail: `DownloadedUpdateHelper ignored the cache dir argument (cacheDir=${String(helper?.cacheDir)})` };
		}
		updater.downloadedUpdateHelper = helper;
		return { isolated: true, cacheDir: isolatedDir, detail: `pre-seeded downloadedUpdateHelper` };
	} catch (err) {
		return { isolated: false, cacheDir: baseCacheDir, detail: `DownloadedUpdateHelper construction failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}
