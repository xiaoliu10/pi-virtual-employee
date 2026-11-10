/**
 * Data-root resolution — where ALL profile data lives on disk.
 *
 * Why this exists (field 2026-11-10, box 144): the data root used to be hard-
 * coded to `%APPDATA%\pi-virtual-employee`, so every profile's DB, browser
 * profile, downloads and logs accumulated on the system drive. On a 120GB C:
 * partition that filled up. The user ruling: write to E: when present, else D:,
 * else fall back to C: — and make it configurable.
 *
 * Resolution order, evaluated ONCE at startup BEFORE app.whenReady (the SQLite
 * DB and every downstream path derive from userData, so the root must be fixed
 * before any of them open):
 *
 *   1. PI_DATA_ROOT env var — explicit override, highest priority. Must be an
 *      absolute path; an unwritable target is a hard error, never a fallback.
 *   2. Marker file `.data-root` under the legacy appData dir — once a root is
 *      chosen it is PINNED. We must never re-probe on every launch: if E: were a
 *      removable/network drive that is temporarily offline, re-probing would
 *      silently fall back to an empty C: root and look exactly like total data
 *      loss (the shortcut-profile incident, same day). A pinned root that is
 *      unavailable, OR whose volume fingerprint does not match, is a HARD error.
 *   3. First run, no marker:
 *      a. If the legacy directory already holds data (a non-empty legacy root —
 *         the DEFAULT profile stores its data directly there with no profiles/
 *         subdir, so checking only profiles/ would orphan the most common
 *         existing-install shape), pin the legacy root. Existing machines never
 *         auto-migrate; migration is an explicit, verified operation.
 *      b. Otherwise (fresh install) probe fixed drives E: -> D: -> C:, first one
 *         that passes a real write probe wins; pin it via marker + fingerprint.
 *
 * The non-Windows path never probes drive letters (there is no E:/D: there) —
 * it always uses the platform appData location, i.e. the pre-feature behaviour.
 *
 * Layout contract (do not change without auditing every path.join below):
 *   <dataRoot>/profiles/<name>            named-profile userData
 *   <dataRoot>                            default-profile userData
 *   <dataRoot>-workspace/<name>/scripts   script workspace (sibling, never
 *                                         overlapping the sensitive profile tree)
 * The `pi-virtual-employee/profiles` substring is preserved so updater.ts's
 * currentProfileName() keeps deriving the profile name from the userData path.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const APP_DIR = "pi-virtual-employee";
export const WORKSPACE_SUFFIX = "-workspace";
export const DATA_ROOT_MARKER = ".data-root";
/** Volume-identity file written into a pinned data root. */
export const ROOT_FINGERPRINT_FILE = ".data-root-id";
/** Drive preference for the fresh-install probe (Windows only). */
export const DRIVE_PREFERENCE = ["E:", "D:", "C:"] as const;

/** Thrown when a PINNED data root (marker or env) cannot be reached or no
 *  longer matches the volume it was pinned to. Callers must surface this to the
 *  user and quit — never silently re-target. */
export class DataRootUnavailableError extends Error {
	constructor(
		public readonly root: string,
		public readonly reason: string,
	) {
		super(`数据目录不可用：${root}（${reason}）。请恢复该盘后重启，或用环境变量 PI_DATA_ROOT 指定有效目录。`);
		this.name = "DataRootUnavailableError";
	}
}

/** Filesystem port — every side effect goes through here so the full E:/D:/C:
 *  matrix and the fingerprint checks are unit-testable with a virtual fs. */
export interface FsPort {
	exists(p: string): boolean;
	/** Real write probe: create+delete a temp file inside the dir. */
	writable(p: string): boolean;
	/** Text read, or undefined when the file is missing/unreadable. */
	readText(p: string): string | undefined;
	/** Atomic text write (temp file + rename), creating parent dirs. */
	writeText(p: string, content: string): void;
	/** True when the path is a directory containing at least one entry. */
	isNonEmptyDir(p: string): boolean;
}

export interface DataRootDeps {
	/** app.getPath("appData") — the roaming app-data root. */
	appData: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	fs?: FsPort;
}

interface MarkerContent {
	root: string;
	/** Undefined for a legacy plain-text marker (no fingerprint contract). */
	fingerprint?: string;
}

/** Default port backed by the real filesystem. */
function realFsPort(): FsPort {
	return {
		exists: (p) => existsSync(p),
		writable: (p) => {
			try {
				mkdirSync(p, { recursive: true });
				const probe = path.join(p, `.write-probe-${process.pid}-${Date.now()}`);
				writeFileSync(probe, "ok");
				rmSync(probe, { force: true });
				return true;
			} catch {
				// P3: mkdir may have left an empty litter dir on a write-denied
				// share; best-effort cleanup, never throw from the probe itself.
				try {
					if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
				} catch {
					/* best effort */
				}
				return false;
			}
		},
		readText: (p) => {
			try {
				return readFileSync(p, "utf8");
			} catch {
				return undefined;
			}
		},
		writeText: (p, content) => {
			mkdirSync(path.dirname(p), { recursive: true });
			// Atomic: a torn write must never leave a half marker that pins a bad
			// root. Temp + rename on the same volume is atomic on NTFS/APFS.
			const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
			writeFileSync(tmp, content, "utf8");
			renameSync(tmp, p);
		},
		isNonEmptyDir: (p) => {
			try {
				return existsSync(p) && readdirSync(p).length > 0;
			} catch {
				return false;
			}
		},
	};
}

/** Legacy root on the system drive — always reachable, marker lives here too. */
export function legacyDataRoot(appData: string): string {
	return path.join(appData, APP_DIR);
}

export function markerPath(appData: string): string {
	return path.join(legacyDataRoot(appData), DATA_ROOT_MARKER);
}

/** Script workspace sibling: `.../pi-virtual-employee-workspace`. String
 *  append keeps the C: layout byte-identical to the pre-feature path. */
export function workspaceRoot(dataRoot: string): string {
	return `${dataRoot}${WORKSPACE_SUFFIX}`;
}

/** Absolute-path check that honours the TARGET platform. On a darwin test
 *  runner, path.isAbsolute('F:\\x') is false because that's not a posix
 *  root — but it IS a valid Windows absolute path. Production win32 already
 *  gets the right answer from path.isAbsolute, so this only changes testing.
 */
function isAbsolutePath(p: string, platform: NodeJS.Platform): boolean {
	if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
	return path.isAbsolute(p);
}

/** userData for a profile: default = root itself; named = root/profiles/name.
 *  Uses the platform path join so packaged win32 keeps backslashes; on other
 *  platforms (tests, mac/linux installs) it follows the host separator. */
export function profileUserDataDir(dataRoot: string, profile: string): string {
	return profile === "default" ? dataRoot : path.join(dataRoot, "profiles", profile);
}

function fingerprintPath(dataRoot: string): string {
	return path.join(dataRoot, ROOT_FINGERPRINT_FILE);
}

/** Normalize a marker path WITHOUT relying on the host platform's path
 *  semantics: the resolver runs in tests on darwin while production values are
 *  Windows paths (backslashes). Collapse separators and strip a trailing one
 *  so a hand-edited marker like `E:\\dir\\` cannot produce a broken
 *  `E:\\dir\\-workspace` sibling (review 3bd05d8a P3-1). */
function normalizeMarkerPath(raw: string, platform: NodeJS.Platform): string {
	let p = raw.trim();
	if (platform === "win32") {
		p = p.replace(/\//g, "\\");
		p = p.replace(/[\\]+$/g, "");
		return p;
	}
	return p.replace(/[/]+$/g, "");
}

/** Parse the marker. Accepts the JSON form and a legacy bare-path line. */
function parseMarker(raw: string | undefined, platform: NodeJS.Platform): MarkerContent | undefined {
	if (!raw) return undefined;
	const text = raw.trim();
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as MarkerContent;
		if (typeof parsed.root === "string" && parsed.root.trim()) {
			return { root: normalizeMarkerPath(parsed.root, platform), fingerprint: parsed.fingerprint };
		}
	} catch {
		// legacy plain-text marker: a bare absolute path, no fingerprint.
	}
	return { root: normalizeMarkerPath(text, platform) };
}

function readMarker(fs: FsPort, appData: string, platform: NodeJS.Platform): MarkerContent | undefined {
	return parseMarker(fs.readText(markerPath(appData)), platform);
}

/** Pin a root: write the volume fingerprint into the root and the marker under
 *  appData. `withFingerprint=false` only records the path (legacy plain marker). */
function pinRoot(fs: FsPort, appData: string, root: string, fingerprint: string | undefined, platform: NodeJS.Platform): void {
	if (fingerprint) fs.writeText(fingerprintPath(root), fingerprint);
	// Normalize the recorded root the same way parseMarker will on read-back,
	// so the write-verify compares canonical forms (on a non-win32 test runner
	// path.join yields mixed separators; production win32 is already canonical).
	const canonicalRoot = platform === "win32" ? normalizeMarkerPath(root, platform) : root;
	const content: MarkerContent = { root: canonicalRoot, fingerprint };
	fs.writeText(markerPath(appData), JSON.stringify(content));
	// Write-verify: a marker we cannot read back must not be treated as pinned.
	const back = readMarker(fs, appData, platform);
	if (!back || back.root !== canonicalRoot) throw new Error(`数据根标记写入失败：${markerPath(appData)}`);
	// Concurrent first-launch guard (review 95d63207 N1): two instances pinning
	// the same drive can interleave their fingerprint/marker writes and leave a
	// marker whose fingerprint no longer matches the file on disk, which would
	// hard-fail every later launch. Verify the fingerprint file agrees too; a
	// mismatch here means another writer won — abort rather than poison the pin.
	if (fingerprint && fs.readText(fingerprintPath(root))?.trim() !== fingerprint) {
		throw new Error(`数据根指纹写入冲突（可能有另一个实例同时启动）：${root}`);
	}
}

/**
 * Resolve the data root. Pure apart from the injected fs port; deterministic
 * for a given on-disk state so the whole E->D->C matrix is unit-testable.
 */
export function resolveDataRoot(deps: DataRootDeps): string {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const fs = deps.fs ?? realFsPort();
	const legacy = legacyDataRoot(deps.appData);

	// 1. Explicit env override. A hard instruction: reject relative forms
	//    (P3-4: a drive-relative "E:foo" resolves against an unknown cwd) and
	//    treat an unwritable target as a hard error, never a silent fallback.
	const envRoot = env.PI_DATA_ROOT?.trim();
	if (envRoot) {
		if (!isAbsolutePath(envRoot, platform)) {
			throw new DataRootUnavailableError(envRoot, "PI_DATA_ROOT 必须是绝对路径");
		}
		// Reject a bare drive root on Windows (review 95d63207 N3): normalizing
		// "C:\\" strips the separator to "C:", after which the -workspace
		// sibling becomes the drive-relative "C:-workspace" and the workspace
		// resolves against an unknown cwd. Require a real subdirectory.
		if (platform === "win32" && /^[A-Za-z]:[\\/]*$/.test(envRoot)) {
			throw new DataRootUnavailableError(envRoot, "PI_DATA_ROOT 不能是裸盘根目录，请指定一个子目录");
		}
		// Host path.normalize is posix on non-win test runners; normalize explicitly
		// for win32 so drive paths keep their backslash shape everywhere.
		const abs = platform === "win32" ? normalizeMarkerPath(envRoot, platform) : path.normalize(envRoot);
		if (!fs.writable(abs)) throw new DataRootUnavailableError(abs, "PI_DATA_ROOT 指定的目录不可写或不存在");
		return abs;
	}

	// 2. Pinned marker. Unavailable root OR fingerprint mismatch = hard error
	//    (a swapped/emptied volume presenting the same drive letter must not
	//    silently start empty).
	const marker = readMarker(fs, deps.appData, platform);
	if (marker) {
		const pinned = marker.root;
		if (!fs.exists(pinned) || !fs.writable(pinned)) {
			throw new DataRootUnavailableError(pinned, fs.exists(pinned) ? "目录存在但不可写" : "盘或目录不存在（可能未挂载）");
		}
		if (marker.fingerprint) {
			const actual = fs.readText(fingerprintPath(pinned))?.trim();
			if (actual !== marker.fingerprint) {
				throw new DataRootUnavailableError(pinned, "卷指纹不匹配（该盘可能已更换或被清空）");
			}
		}
		return pinned;
	}

	// 3a. Legacy data already present: pin and keep it. Check the legacy ROOT
	//     itself, not only profiles/: a default-profile-only machine stores its
	//     DB/Cookies/skills directly in the legacy root (review 3bd05d8a P1).
	//     Existing machines never auto-migrate — migration is explicit.
	if (fs.isNonEmptyDir(legacy)) {
		const fingerprint = randomUUID();
		pinRoot(fs, deps.appData, legacy, fingerprint, platform);
		return legacy;
	}

	// 3b. Fresh install. Non-Windows has no drive letters: keep appData behaviour.
	if (platform !== "win32") {
		mkdirSync(legacy, { recursive: true });
		pinRoot(fs, deps.appData, legacy, randomUUID(), platform);
		return legacy;
	}

	// Windows: probe E: -> D: -> C:. A drive that is absent or fails the real
	// write probe is skipped; the first writable one wins. C: is the guaranteed
	// last resort (the legacy appData tree under it is creatable).
	for (const drive of DRIVE_PREFERENCE) {
		// This branch only ever runs on Windows, so build the drive path with an
		// explicit backslash rather than path.join: under a non-win32 test runner
		// path.join treats `C:\` as a literal name and yields `C:\/...`.
		const candidate = `${drive}\\${APP_DIR}`;
		if (fs.writable(candidate)) {
			pinRoot(fs, deps.appData, candidate, randomUUID(), platform);
			return candidate;
		}
	}

	// Defensive: C: should always be writable. Fail loudly rather than return an
	// undefined root if every probe somehow failed.
	throw new DataRootUnavailableError(legacy, "E:/D:/C: 探测均不可写");
}
