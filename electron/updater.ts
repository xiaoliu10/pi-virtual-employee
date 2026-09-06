/**
 * Auto-update via electron-updater (generic provider → Gitee Releases).
 *
 * Gate: only the packaged Windows build runs the updater — dev and macOS are
 * no-ops (renderer still gets a state so the UI shows the current version and
 * no misleading buttons). Strategy is "auto-check, confirm-download": startup
 * checks after 15s, then every 6h; a found update is announced but only
 * downloaded when the user clicks download. Once downloaded, the user clicks
 * "restart & install"; normal app quit never installs implicitly, so every
 * install passes through our guarded cleanup + watchdog path.
 *
 * Unattended mode (headless servers, config general.autoUpdate=true): after
 * download completes, a poll waits for the engine to be idle (no in-flight
 * agent turn) and then restarts into the installer automatically. The poll
 * gives up after 24h and leaves the update ready for a later explicit trigger.
 *
 * The renderer is the display surface: every state change is pushed as
 * "update:event", and on mount the renderer pulls "update:getState" so events
 * that fired before it subscribed (the startup check fires ~15s in) aren't
 * lost. IPC is idempotent against re-entry — a second check while one is in
 * flight just returns the current state.
 */
import { app, type BrowserWindow } from "electron";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

/** The update feed: a stable URL pointing at the `latest` release tag. */
const UPDATE_FEED = "https://gitee.com/xiaoliu10/pi-virtual-employee/releases/download/latest";
const FIRST_CHECK_DELAY_MS = 15_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Unattended mode: how often to re-check engine idleness after a download. */
const IDLE_POLL_MS = 60_000;
/** Unattended mode: give up waiting for idle after this long. */
const IDLE_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Let the final IM/HTTP response flush after draining new work. */
const REPLY_FLUSH_DELAY_MS = 5_000;
/** Watchdog: how long the app waits for its own graceful exit before the hard
 *  tree-kill hands the install to the detached watchdog. */
const APP_EXIT_GRACE_MS = 10_000;
const WATCHDOG_DIR = "update-watchdog";
const UPDATE_LOG_DIR = "logs";
const UPDATE_LOG_FILE = "updater.log";
/** Circuit-breaker state: repeated failures for the same target version. */
const FAILURE_FILE = "update-failures.json";
/** After this many failed install attempts for one target version, stop auto-installing it. */
const MAX_ATTEMPTS_PER_VERSION = 2;
/**
 * MACHINE-level breaker: consecutive failed installs ACROSS different target
 * versions. A box whose old uninstaller is broken fails identically for every
 * new release (0.2.17, 0.2.18, 0.2.21 — three outages, one per version bump,
 * each per-version counter reset to zero). When the consecutive count across
 * versions reaches this, auto-INSTALL stops entirely (checks/downloads still
 * work) until one successful manual repair install clears the streak.
 */
const MAX_CONSECUTIVE_INSTALL_FAILURES = 2;

interface FailureRecord {
	attempts: number;
	lastError: string;
	lastAttemptAt: string;
}

interface FailureFileShape {
	/** per-version counters (legacy + per-target granularity) */
	versions?: Record<string, FailureRecord>;
	/** consecutive install failures across versions, machine-level */
	consecutiveFailures?: number;
	lastConsecutiveError?: string;
	/**
	 * An install attempt in flight: written BEFORE the app quits for NSIS,
	 * reconciled at next startup. This makes failure accounting independent of
	 * the watchdog (which may be blocked by endpoint security — observed:
	 * "watchdog armed" with zero script output on every outage) and of the
	 * hard-exit timer (the natural-quit path never recorded anything).
	 */
	pending?: { target: string; fromVersion: string; startedAt: string };
}

/** Persistent failure counters (survives restarts → breaks loops). */
function loadFailures(): FailureFileShape {
	try {
		const raw = JSON.parse(readFileSync(join(app.getPath("userData"), FAILURE_FILE), "utf8")) as FailureFileShape | Record<string, FailureRecord>;
		// Legacy shape (flat per-version map) → migrate.
		if (raw && !("versions" in raw) && typeof raw === "object") {
			return { versions: raw as Record<string, FailureRecord>, consecutiveFailures: 0 };
		}
		return raw ?? { versions: {}, consecutiveFailures: 0 };
	} catch {
		return { versions: {}, consecutiveFailures: 0 };
	}
}

function saveFailures(map: FailureFileShape): void {
	try {
		mkdirSync(join(app.getPath("userData")), { recursive: true });
		writeFileSync(join(app.getPath("userData"), FAILURE_FILE), JSON.stringify(map, null, 2), "utf8");
	} catch (err) {
		log("WARN", `failed to persist failure record: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function recordFailure(version: string, error: string): number {
	const map = loadFailures();
	const versions = map.versions ?? {};
	const prev = versions[version] ?? { attempts: 0, lastError: "", lastAttemptAt: "" };
	versions[version] = { attempts: prev.attempts + 1, lastError: error.slice(0, 500), lastAttemptAt: new Date().toISOString() };
	const consecutive = (map.consecutiveFailures ?? 0) + 1;
	saveFailures({ versions, consecutiveFailures: consecutive, lastConsecutiveError: error.slice(0, 500) });
	return versions[version].attempts;
}

function clearFailure(version: string): void {
	const map = loadFailures();
	const versions = map.versions ?? {};
	if (map.versions?.[version] || versions[version]) {
		delete versions[version];
		saveFailures({ versions, consecutiveFailures: map.consecutiveFailures ?? 0, lastConsecutiveError: map.lastConsecutiveError });
	}
}

function failureAttempts(version: string): number {
	return loadFailures().versions?.[version]?.attempts ?? 0;
}

/** Machine-level consecutive-install-failure count (across target versions). */
function consecutiveInstallFailures(): number {
	return loadFailures().consecutiveFailures ?? 0;
}

/**
 * Clear the machine-level streak: called when the RUNNING app is newer than the
 * last failed target — proof that an install (the manual repair, typically)
 * finally succeeded on this box.
 */
function clearConsecutiveFailures(): void {
	const map = loadFailures();
	if ((map.consecutiveFailures ?? 0) > 0) {
		log("INFO", "clearing machine-level consecutive install-failure streak (install succeeded)");
		saveFailures({ versions: map.versions ?? {}, consecutiveFailures: 0 });
	}
}

/** True when auto-INSTALL must be blocked machine-wide (manual repair needed). */
function machineBreakerOpen(): boolean {
	return consecutiveInstallFailures() >= MAX_CONSECUTIVE_INSTALL_FAILURES;
}

/**
 * Record an install attempt in flight, BEFORE the app quits for NSIS. Reconciled
 * at next startup by reconcilePendingInstall(): if the running version never
 * reached the target, the install failed (the app only came back via the
 * watchdog/manual restart on the OLD version) — count it. This closes the gap
 * where the natural-quit path (NSIS kills the app, quit completes, the 15s
 * hard-exit timer never fires) recorded NOTHING, so the breaker could never
 * trip no matter how many outages happened.
 */
function markPendingInstall(target: string): void {
	const map = loadFailures();
	saveFailures({ ...map, pending: { target, fromVersion: app.getVersion(), startedAt: new Date().toISOString() } });
	log("INFO", `pending install recorded: ${app.getVersion()} -> ${target}`);
}

/**
 * Startup reconciliation of markPendingInstall. MUST run once per app start.
 * Success (running >= target) also clears the machine streak — this is the
 * only place a successful SILENT install (no hard-exit, no watchdog action)
 * gets recognized, so the breaker resets the moment an update actually works.
 */
function reconcilePendingInstall(): void {
	const map = loadFailures();
	const pending = map.pending;
	if (!pending) return;
	const current = app.getVersion();
	if (compareVersions(current, pending.target) >= 0) {
		log("INFO", `startup: pending install ${pending.fromVersion} -> ${pending.target} SUCCEEDED (running ${current})`);
		const { pending: _drop, ...rest } = map;
		saveFailures(rest);
		clearFailure(pending.target);
		clearConsecutiveFailures();
	} else {
		log("ERROR", `startup: pending install ${pending.fromVersion} -> ${pending.target} FAILED (still running ${current}) — counting failure`);
		const { pending: _drop, ...rest } = map;
		saveFailures(rest);
		recordFailure(pending.target, `startup reconciliation: still on ${current} after attempting ${pending.target}`);
	}
}

/**
 * A per-user NSIS install MUST have its uninstall registry entry. A missing
 * entry (or an UninstallString pointing at a deleted exe) means the previous
 * install was broken or manually mangled — and since every upgrade runs the
 * OLD uninstaller first, any new auto-install attempt will fail with
 * "Failed to uninstall old application files". Detect that at startup and
 * block auto-update until the deployment is repaired by a manual install.
 */
export function inspectInstallHealth(): { healthy: boolean; reason?: string } {
	if (!enabled()) return { healthy: true };
	// electron-builder NSIS per-user key:
	// HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<appId-or-guid>
	// Reading via PowerShell avoids pulling winreg into the main bundle.
	try {
		const child = spawn(
			"reg.exe",
			["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s", "/f", "Pi Virtual Employee", "/d"],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		let out = "";
		child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
		let settled = false;
		const done = new Promise<boolean>((resolve) => {
			child.once("error", () => resolve(false));
			child.once("exit", () => {
				settled = true;
				resolve(out.includes("Pi Virtual Employee"));
			});
		});
		void done.then((found) => {
			if (!found) {
				log("ERROR", "install health: no HKCU uninstall registry entry found — install is broken; blocking auto-update until a manual repair install");
				setState({ phase: "error", currentVersion: app.getVersion(), message: "检测到安装不完整（缺少卸载注册表项），自动更新已暂停。请手动运行最新版安装包修复。" });
			}
		});
		// Non-blocking health probe; if reg.exe hangs, settle after 10s.
		setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill();
			}
		}, 10_000).unref();
	} catch {
		/* probe failure must never break startup */
	}
	return { healthy: true }; // provisional; async result flips state if broken
}

function updaterLogPath(): string {
	return join(app.getPath("userData"), UPDATE_LOG_DIR, UPDATE_LOG_FILE);
}

/** Persist updater logs — packaged headless deployments have no visible console. */
function log(level: "INFO" | "WARN" | "ERROR", message: unknown): void {
	const text = typeof message === "string" ? message : String(message);
	const line = `[${new Date().toISOString()}] [${level}] ${text}`;
	if (level === "ERROR") console.error(line);
	else if (level === "WARN") console.warn(line);
	else console.log(line);
	try {
		mkdirSync(join(app.getPath("userData"), UPDATE_LOG_DIR), { recursive: true });
		appendFileSync(updaterLogPath(), line + "\n", "utf8");
	} catch {
		/* logging must never break update */
	}
}

const fileLogger = {
	info: (message?: unknown) => log("INFO", message ?? ""),
	warn: (message?: unknown) => log("WARN", message ?? ""),
	error: (message?: unknown) => log("ERROR", message ?? ""),
	debug: (message: string) => log("INFO", message),
};

/** Downloaded installer captured from update-downloaded for the watchdog. */
let downloadedInstallerPath: string | undefined;
/** Awaitable cleanup injected by main: browser, IM and local HTTP server. */
let prepareToInstall: (() => Promise<void>) | null = null;

export type UpdateState =
	| { phase: "idle"; currentVersion: string }
	| { phase: "checking"; currentVersion: string }
	| { phase: "available"; currentVersion: string; version: string; releaseNotes?: string; manualUrl: string }
	| { phase: "none"; currentVersion: string }
	| { phase: "downloading"; currentVersion: string; version: string; percent: number }
	| { phase: "ready"; currentVersion: string; version: string }
	| { phase: "error"; currentVersion: string; message: string };

let lastState: UpdateState = { phase: "idle", currentVersion: app.getVersion() };
let window: BrowserWindow | null = null;
let recheckTimer: NodeJS.Timeout | undefined;
let idlePollTimer: NodeJS.Timeout | undefined;
let checking = false;
let downloading = false;
/** Guard against re-entrant install: set once quitAndInstall has been issued. */
let installing = false;
let pendingVersion: string | undefined;
let pendingReleaseNotes: string | undefined;
/** One-shot request from an IM admin: install once the current update is downloaded. */
let requestedInstall = false;

/**
 * Unattended mode: download + install without a human at the UI. Wired by
 * main.ts to config (general.autoUpdate) and the engine's idle signal. Both
 * are getters so config changes apply without re-wiring.
 */
let unattendedEnabled: () => boolean = () => false;
let isEngineIdle: () => boolean = () => true;
/**
 * download_only mode: auto-check + auto-download still run, but the install
 * step NEVER runs unattended — the update stays "ready" until an admin
 * explicitly requests it (IM manage_update update, or the settings button).
 * Intended for hosts whose unattended NSIS install wedges (proven: the manual
 * silent install finishes in 14s, the unattended one wedges every time).
 */
let unattendedInstallBlocked: () => boolean = () => false;
/** Notifies admins (via IM) when a download_only update sits ready for install. */
let notifyReady: ((version: string, manualUrl: string) => void) | null = null;
/** Before installing, pause new IM turns; released on failure/timeout. */
let beginDrain: (() => void) | null = null;
let endDrain: (() => void) | null = null;

/** main.ts hooks the engine idle check + autoUpdate config in here. */
export function setupUnattended(opts: {
	enabled: () => boolean;
	isIdle: () => boolean;
	/** True when unattended INSTALL must not run (download_only mode). */
	installBlocked?: () => boolean;
	/** Called once per download when the update sits ready in download_only mode. */
	notifyReady?: (version: string, manualUrl: string) => void;
	beginDrain?: () => void;
	endDrain?: () => void;
	prepareToInstall?: () => Promise<void>;
}): void {
	unattendedEnabled = opts.enabled;
	isEngineIdle = opts.isIdle;
	unattendedInstallBlocked = opts.installBlocked ?? (() => false);
	notifyReady = opts.notifyReady ?? null;
	beginDrain = opts.beginDrain ?? null;
	endDrain = opts.endDrain ?? null;
	prepareToInstall = opts.prepareToInstall ?? null;
}

/** Whether this build can download and restart into a Windows update. */
export function updateCapability(): { supported: boolean; reason?: string } {
	if (process.platform !== "win32") return { supported: false, reason: "当前系统不是 Windows，仅 Windows 打包版支持自动更新" };
	if (!app.isPackaged) return { supported: false, reason: "开发模式不支持自动更新" };
	return { supported: true };
}

/** Whether the updater actually runs (packaged Windows only). */
function enabled(): boolean {
	return app.isPackaged && process.platform === "win32";
}

/** Push the current state to the renderer (no-op if the window is gone). */
function push(): void {
	const wc = window?.webContents;
	if (wc && !wc.isDestroyed()) wc.send("update:event", lastState);
}

/** Set + push in one step. */
function setState(next: UpdateState): void {
	lastState = next;
	push();
}

/** Coerce electron-updater release notes (string | { notes }) to plain text. */
function coerceNotes(notes: unknown): string | undefined {
	if (typeof notes === "string" && notes.trim()) return notes.trim();
	if (notes && typeof notes === "object" && typeof (notes as { notes?: string }).notes === "string") {
		return (notes as { notes: string }).notes.trim();
	}
	return undefined;
}

/** Manual-download URL for the given version (fallback when auto-download fails). */
function manualUrl(version: string): string {
	return `${UPDATE_FEED}/Pi-Virtual-Employee-Setup-${version}-x64.exe`;
}

/**
 * Best-effort sweep of stale partial downloads in electron-updater's shared
 * cache. 小派 failed its download twice (6h apart) with EPERM on the same
 * temp file — a leftover from an interrupted download that every later
 * attempt collides with. Two profiles share this user-level cache dir, so
 * the sweep only removes .tmp/.blocked partials older than an hour (never a
 * completed installer another instance may be installing).
 */
function sweepStaleUpdaterTemps(): void {
	if (process.platform !== "win32") return;
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return;
	// Field-observed name ("pi-virtual-employee-updater") plus the productName
	// variant electron-updater can derive depending on the app identity.
	const candidates = [join(localAppData, "pi-virtual-employee-updater"), join(localAppData, "Pi Virtual Employee-updater")];
	for (const cacheDir of candidates) {
		const pendingDir = join(cacheDir, "pending");
		for (const dir of [cacheDir, pendingDir]) {
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!/\.(tmp|blocked)$/i.test(name)) continue;
				const full = join(dir, name);
				try {
					if (Date.now() - statSync(full).mtimeMs < 60 * 60_000) continue;
					rmSync(full, { force: true, recursive: true });
					log("INFO", `swept stale updater temp file: ${full}`);
				} catch (err) {
					log("WARN", `could not sweep stale updater temp ${full}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	}
}

// One EPERM-style download retry per target version (no loops): two instances
// sharing the updater cache collide on the same temp file — the other side
// finishes seconds later, so a delayed re-download succeeds.
let epermRetriedForVersion: string | undefined;
let epermRetryTimer: NodeJS.Timeout | undefined;

/** Wire electron-updater events → UpdateState. Called once at setup. */
function wireEvents(): void {
	autoUpdater.on("checking-for-update", () => {
		checking = true;
		setState({ phase: "checking", currentVersion: app.getVersion() });
	});
	autoUpdater.on("update-available", (info: { version?: string; releaseNotes?: unknown } = {}) => {
		checking = false;
		pendingVersion = info.version;
		pendingReleaseNotes = coerceNotes(info.releaseNotes);
		setState({
			phase: "available",
			currentVersion: app.getVersion(),
			version: info.version ?? "",
			releaseNotes: pendingReleaseNotes,
			manualUrl: manualUrl(info.version ?? ""),
		});
		// Download without a click when unattended is on, or an IM admin asked for it.
		if (unattendedEnabled() || requestedInstall) void downloadNow().catch(() => {});
	});
	autoUpdater.on("update-not-available", () => {
		checking = false;
		requestedInstall = false;
		setState({ phase: "none", currentVersion: app.getVersion() });
	});
	autoUpdater.on("download-progress", (progress: { percent?: number }) => {
		setState({
			phase: "downloading",
			currentVersion: app.getVersion(),
			version: pendingVersion ?? "",
			percent: Math.round(progress.percent ?? 0),
		});
	});
	autoUpdater.on("update-downloaded", (info: { version?: string; downloadedFile?: string } = {}) => {
		downloading = false;
		downloadedInstallerPath = info.downloadedFile;
		const targetVersion = info.version ?? pendingVersion ?? "unknown";
		log("INFO", `update downloaded: version=${targetVersion} file=${downloadedInstallerPath ?? "unknown"}`);
		setState({ phase: "ready", currentVersion: app.getVersion(), version: targetVersion });
		// download_only mode: never install unattended — park at "ready" and tell
		// an admin the update is waiting (once per download). Explicit requests
		// (IM manage_update update / settings button) set requestedInstall and
		// still proceed below.
		if (unattendedInstallBlocked() && !requestedInstall) {
			log("INFO", `download_only: update ${targetVersion} parked at ready — install requires an explicit admin request`);
			notifyReady?.(targetVersion, manualUrl(targetVersion));
			return;
		}
		if (!unattendedEnabled() && !requestedInstall) return;
		// Machine-level breaker: consecutive installs failed across DIFFERENT
		// target versions (0.2.17→0.2.18→0.2.21 pattern). Each per-version
		// counter resets on a version bump, so the per-target breaker below never
		// caught it — the box's old uninstaller breaks every upgrade identically.
		// Stop auto-INSTALL entirely until a manual repair install succeeds.
		if (machineBreakerOpen()) {
			requestedInstall = false;
			log("ERROR", `machine breaker open: ${consecutiveInstallFailures()} consecutive install failures across versions; auto-install disabled until manual repair`);
			setState({ phase: "error", currentVersion: app.getVersion(), message: `本机已连续 ${consecutiveInstallFailures()} 次自动安装失败（跨版本），已停止自动安装。请手动运行最新安装包修复一次，成功后自动更新自动恢复。` });
			return;
		}
		// Circuit breaker: this target already failed MAX_ATTEMPTS_PER_VERSION
		// times on this machine. Do NOT loop again — a broken old-uninstaller
		// makes every retry fail identically, and each failed attempt takes the
		// service down for minutes. Leave the update ready + manual URL.
		if (failureAttempts(targetVersion) >= MAX_ATTEMPTS_PER_VERSION) {
			requestedInstall = false;
			log("ERROR", `circuit breaker open: ${targetVersion} already failed ${MAX_ATTEMPTS_PER_VERSION}+ times; NOT auto-installing again. Manual install required.`);
			setState({ phase: "error", currentVersion: app.getVersion(), message: `版本 ${targetVersion} 在本机已连续安装失败 ${MAX_ATTEMPTS_PER_VERSION} 次，已停止自动重试。请手动运行安装包修复（下载链接在设置页）。` });
			return;
		}
		scheduleIdleRestart();
	});
	autoUpdater.on("error", (err: Error) => {
		checking = false;
		downloading = false;
		endDrain?.();
		const message = err.message || String(err);
		setState({ phase: "error", currentVersion: app.getVersion(), message });
		// 小派 pattern: two profiles share the user-level updater cache and
		// collided on the same temp file → EPERM/sharing violation. Sweep stale
		// partials and retry the download ONCE after the other instance has
		// finished; never loop on repeated failures.
		if (/EPERM|EBUSY|EACCES|sharing violation|-4082|ENOENT/i.test(message) && pendingVersion && epermRetriedForVersion !== pendingVersion) {
			epermRetriedForVersion = pendingVersion;
			log("WARN", `download failed with a file-lock style error (${message}) — sweeping stale temp files, retrying once in 30s`);
			sweepStaleUpdaterTemps();
			if (epermRetryTimer) clearTimeout(epermRetryTimer);
			epermRetryTimer = setTimeout(() => {
				// Reset to "available" so downloadNow's phase gate lets us back in.
				setState({
					phase: "available",
					currentVersion: app.getVersion(),
					version: pendingVersion ?? "",
					releaseNotes: pendingReleaseNotes,
					manualUrl: manualUrl(pendingVersion ?? ""),
				});
				void downloadNow().catch(() => {});
			}, 30_000);
			return;
		}
		requestedInstall = false;
	});
	autoUpdater.on("update-cancelled", () => {
		downloading = false;
		setState({ phase: "idle", currentVersion: app.getVersion() });
	});
}

/**
 * Unattended mode: poll the engine until it's idle (no in-flight agent turn),
 * then restart into the installer. Stops after IDLE_WAIT_TIMEOUT_MS — the
 * downloaded update still applies on the next normal quit, so giving up just
 * defers the restart rather than losing it.
 */
function scheduleIdleRestart(): void {
	// Once install has been issued, another download event / IM request must not
	// re-enter — the installer is already running.
	if (installing) return;
	if (idlePollTimer) clearInterval(idlePollTimer);
	const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS;
	idlePollTimer = setInterval(() => {
		if (installing) {
			clearInterval(idlePollTimer);
			idlePollTimer = undefined;
			return;
		}
		if (Date.now() > deadline) {
			clearInterval(idlePollTimer);
			idlePollTimer = undefined;
			requestedInstall = false;
			endDrain?.();
			return;
		}
		if (!isEngineIdle()) return;
		clearInterval(idlePollTimer);
		idlePollTimer = undefined;
		// Stop new IM turns first, then re-check before restarting. The first poll
		// fires only after this callback returns, so the current turn's reply has
		// time to leave engine.send() and reach the IM adapter.
		beginDrain?.();
		if (!isEngineIdle()) {
			scheduleIdleRestart();
			return;
		}
		quitAndInstall();
	}, IDLE_POLL_MS);
}

/** Scheduled-task name used to launch the watchdog parent-independently. */
const WATCHDOG_TASK_NAME = "PiVE-Update-Watchdog";

/** The --profile args this instance was launched with (empty for default). */
function profileArgs(): string[] {
	const i = process.argv.indexOf("--profile");
	if (i >= 0 && process.argv[i + 1]) return ["--profile", process.argv[i + 1]];
	const eq = process.argv.find((a) => a.startsWith("--profile="));
	return eq ? [eq] : [];
}

/**
 * Profiles of every RUNNING instance of this app on the box (NSIS kills by
 * image name, so all of them go down together — the watchdog must bring back
 * exactly the set that was alive, no more). Snapshotted via wmic just before
 * the quit; empty-string entry = the default profile. On wmic failure we fall
 * back to this instance's own args only.
 */
function snapshotRunningProfiles(): string[] {
	if (process.platform !== "win32") return [];
	try {
		const out = spawnSync(
			"wmic.exe",
			["process", "where", "name='Pi Virtual Employee.exe'", "get", "commandline", "/value"],
			{ encoding: "utf8", windowsHide: true, timeout: 10_000 },
		);
		const text = out.stdout ?? "";
		const profiles = new Set<string>();
		for (const line of text.split(/\r?\n/)) {
			const m = /CommandLine=(.*)/.exec(line);
			if (!m || !m[1].includes("Pi Virtual Employee.exe")) continue;
			const cl = m[1];
			const p = /--profile[= ]([\w-]+)/.exec(cl);
			profiles.add(p ? p[1] : "");
		}
		// Always include self so a wmc miss can't strand the updating instance.
		profiles.add(profileArgs()[1] ?? "");
		return [...profiles];
	} catch {
		return [profileArgs()[1] ?? ""];
	}
}

/**
 * Independent PowerShell watchdog — the sole INSTALLER DRIVER and restarter of
 * the app after an update. Runs outside Electron, launched via the Task
 * Scheduler (schtasks children have no parent linkage to the dying app); when
 * schtasks is unavailable the fallback chain is WMI Win32_Process.Create
 * (reparented to WmiPrvSE, survives the app's taskkill /T) and last a detached
 * spawn.
 *
 * Why the watchdog RUNS the installer instead of watching electron-updater's:
 * electron-updater starts NSIS while the app is still tearing down, and that
 * race wedged the uninstall-old step on at least one host SEVEN outages in a
 * row — while the identical manual sequence (app fully dead → kill stale
 * installers → installer /S → relaunch) succeeded every single time (12-14s).
 * So the app now exits itself and the watchdog performs the install:
 *
 * 1. Waits for the app to exit (max 120s) — if it never exits, the install was
 *    abandoned and the watchdog stands down.
 * 2. Kills stale installers, runs the captured installer copy with /S (max
 *    300s — the proven silent install takes seconds), and relaunches the app
 *    exe DIRECTLY via Start-Process with the pre-quit profile snapshot (a
 *    multi-profile box gets every instance restored; no interactive desktop
 *    needed). A wedged install is killed, bumped to the machine-level failure
 *    counter, and the launch proceeds on whatever is installed — service
 *    first; a failed update waits for a manual repair.
 */
function startInstallWatchdog(): "wmi" | "schtasks" | "detached" | "failed" {
	if (process.platform !== "win32" || !downloadedInstallerPath) {
		log("WARN", "watchdog skipped: downloaded installer path unavailable");
		return "failed";
	}
	try {
		const dir = join(app.getPath("userData"), WATCHDOG_DIR);
		mkdirSync(dir, { recursive: true });
		const installerCopy = join(dir, basename(downloadedInstallerPath));
		const scriptPath = join(dir, "watch-update.ps1");
		const wrapperPath = join(dir, "watch-update.cmd");
		const markerPath = join(dir, "completed.txt");
		rmSync(markerPath, { force: true });
		copyFileSync(downloadedInstallerPath, installerCopy);
		const exeName = "Pi Virtual Employee";
		const appExe = process.execPath;
		// Snapshot the RUNNING instances now — after the quit it's too late
		// (NSIS kills them all). Empty-string entry = default profile.
		const runningProfiles = snapshotRunningProfiles();
		const relaunch = runningProfiles.map((p) => `'${escapePowerShellSingleQuoted(p)}'`).join(", ");
		const script = [
			"$ErrorActionPreference = 'SilentlyContinue'",
			"function Log($m) { Add-Content -Path $log -Value \"[$([DateTime]::UtcNow.ToString('o'))] $m\" }",
			`$log = '${escapePowerShellSingleQuoted(updaterLogPath())}'`,
			`$appExe = '${escapePowerShellSingleQuoted(appExe)}'`,
			`$marker = '${escapePowerShellSingleQuoted(markerPath)}'`,
			`$profileLaunch = @(${relaunch})`,
			`$exeName = '${escapePowerShellSingleQuoted(exeName)}'`,
			`$installerCopy = '${escapePowerShellSingleQuoted(installerCopy)}'`,
			// Remove the scheduled task that launched us — the app also sweeps a
			// stale task at startup, this covers the normal exit paths.
			`& schtasks.exe /Delete /TN '${escapePowerShellSingleQuoted(WATCHDOG_TASK_NAME)}' /F | Out-Null`,
			"Log ('watchdog: started pid=' + $PID + ' profiles=[' + ($profileLaunch -join ',') + ']')",
			// update-failures.json lives one directory up from logs/updater.log.
			// The watchdog is an independent PowerShell process, so it bumps the
			// machine-level consecutive-failure counter itself when the installer
			// wedges — belt-and-braces alongside the app-side pending marker.
			`$failuresFile = Join-Path (Split-Path (Split-Path $log -Parent) -Parent) '${FAILURE_FILE}'`,
			"function TestApp { return [bool](Get-Process -Name $exeName -ErrorAction SilentlyContinue) }",
			"function TestInstaller { return [bool](Get-Process | Where-Object { $_.ProcessName -like 'Pi-Virtual-Employee-Setup*' }) }",
			"function KillStaleInstallers {",
			"  Get-Process | Where-Object { $_.ProcessName -like 'Pi-Virtual-Employee-Setup*' } | Stop-Process -Force",
			"}",
			"function LaunchApp {",
			"  if (-not (Test-Path $appExe)) { return $false }",
			// A watchdog spawned from the app process inherits its environment —
			// on hosts where ELECTRON_RUN_AS_NODE (or any ELECTRON_*) is set,
			// Start-Process would launch the exe as a bare Node process that
			// exits instantly ("direct app launch failed"). Launch the app with
			// a clean environment, like a fresh user launch.
			"  Get-ChildItem Env:ELECTRON_* -ErrorAction SilentlyContinue | Remove-Item -ErrorAction SilentlyContinue",
			"  # NSIS kills by image name, so ALL instances go down together (a",
			"  # sibling --profile 小派 on the same install has no watchdog of its",
			"  # own). Bring back exactly the set snapshotted before the quit.",
			"  foreach ($p in $profileLaunch) {",
			"    if ($p) { Start-Process -FilePath $appExe -ArgumentList @('--profile', $p) }",
			"    else { Start-Process -FilePath $appExe }",
			"  }",
			"  Start-Sleep -Seconds 30",
			"  return (TestApp)",
			"}",
			"function BumpFailureCount {",
			"  try {",
			"    $obj = [ordered]@{ versions = [ordered]@{}; consecutiveFailures = 1; lastConsecutiveError = 'watchdog: installer wedged, service restored to previous version (or failed to restore)' }",
			"    if (Test-Path $failuresFile) { $raw = Get-Content -Raw -Path $failuresFile | ConvertFrom-Json; if ($raw.versions) { $obj.versions = $raw.versions }; if ($raw.consecutiveFailures) { $obj.consecutiveFailures = [int]$raw.consecutiveFailures + 1 } }",
			"    $obj | ConvertTo-Json -Depth 5 | Set-Content -Path $failuresFile -Encoding UTF8",
			"    Log ('watchdog: bumped machine-level failure count to ' + $obj.consecutiveFailures)",
			"  } catch { Log ('watchdog: failed to write failure record: ' + $_.Exception.Message) }",
			"}",
			// Phase 0a: this watchdog may come up BEFORE the app has quit (schtasks
			// round-trip vs. the 5s reply-flush + quit). TestApp being TRUE right
			// now means nothing yet — wait for the app to actually exit first
			// (hard-exit timer bounds it at 15s; 120s is generous). If it never
			// exits the install was abandoned and we can stand down.
			"Log 'watchdog phase0a: waiting for app to exit (max 120s)'",
			"$grace = (Get-Date).AddSeconds(120)",
			"while ((Get-Date) -lt $grace -and (TestApp)) { Start-Sleep -Seconds 5 }",
			"if (TestApp) { Log 'watchdog: app never exited — install abandoned, standing down'; Set-Content -Path $marker -Value 'ok'; exit 0 }",
			// Phase 1: the app tree is gone — install exactly the way the manual
			// repair does on every successful outage fix: clear stale installers,
			// run the captured installer copy silently, wait, relaunch. The
			// in-app quitAndInstall NSIS race (7/7 wedges) is gone by design:
			// nothing but this watchdog touches the installer.
			"Log 'watchdog phase1: app exited; killing stale installers and running the update silently'",
			"KillStaleInstallers",
			"Start-Sleep -Seconds 2",
			// Root cause of all 8 outages on the cloud box (现场, 2026-09-06):
			// NSIS installing IN PLACE over the old tree wedges in the
			// uninstall-old-files step (5min+, zero file writes, WorkingSet 2.2MB)
			// every single time — while renaming the old install dir away and
			// letting NSIS do a FRESH install completes in ~15s. So rename first;
			// fall back to in-place only if the rename is blocked by a locked file.
			"$instDir = Split-Path $appExe -Parent",
			"$oldDir = ''",
			"try {",
			"  $oldName = (Split-Path $instDir -Leaf) + '.old-' + (Get-Date -Format 'yyyyMMdd-HHmmss')",
			"  Rename-Item -Path $instDir -NewName $oldName -ErrorAction Stop",
			"  $oldDir = Join-Path (Split-Path $instDir -Parent) $oldName",
			"  Log ('watchdog phase1: old install dir renamed out of the way -> ' + $oldDir)",
			"} catch {",
			"  $oldDir = ''",
			"  Log ('watchdog phase1: rename of old install dir failed (locked?) — installing in place: ' + $_.Exception.Message)",
			"}",
			"$instProc = Start-Process -FilePath $installerCopy -ArgumentList '/S' -PassThru",
			"$instDeadline = (Get-Date).AddSeconds(300)",
			"while ($instProc -and (-not $instProc.HasExited) -and ((Get-Date) -lt $instDeadline)) { Start-Sleep -Seconds 5 }",
			"if (-not $instProc) {",
			"  Log 'watchdog phase1: silent install failed to start'",
			"} elseif (-not $instProc.HasExited) {",
			"  Log 'watchdog phase1: silent install wedged; killing it and bumping failure count'",
			"  BumpFailureCount",
			"  Stop-Process -Id $instProc.Id -Force",
			"  Start-Sleep -Seconds 5",
			"} else {",
			"  Log ('watchdog phase1: silent install exited code=' + $instProc.ExitCode)",
			"}",
			"$d2 = (Get-Date).AddSeconds(120)",
			"while ((Get-Date) -lt $d2 -and (TestInstaller)) { Start-Sleep -Seconds 5 }",
			"Start-Sleep -Seconds 3",
			// Fresh install succeeded → the renamed old tree is junk; reclaim it.
			// Locked leftovers stay on disk rather than risking the relaunch.
			"if ($oldDir -and (Test-Path $appExe)) {",
			"  Remove-Item -Path $oldDir -Recurse -Force -ErrorAction SilentlyContinue",
			"  if (Test-Path $oldDir) { Log ('watchdog phase1: old install dir kept (locked): ' + $oldDir) } else { Log 'watchdog phase1: old install dir removed' }",
			"}",
			// Direct launch of the installed exe — no desktop required.
			"if (LaunchApp) { Log 'watchdog: service relaunched (update installed, or previous version restored after a wedged install)'; Set-Content -Path $marker -Value 'ok'; exit 0 }",
			// The fresh install never produced an exe — roll the renamed old tree
			// back into place and restore service on the previous version.
			"if ($oldDir -and -not (Test-Path $appExe)) {",
			"  Log 'watchdog: new install did not produce the exe — rolling back to the renamed old install dir'",
			"  Remove-Item -Path $instDir -Recurse -Force -ErrorAction SilentlyContinue",
			"  Rename-Item -Path $oldDir -NewName (Split-Path $instDir -Leaf) -ErrorAction SilentlyContinue",
			"  if (LaunchApp) { Log 'watchdog: service relaunched (previous version restored after a failed install)'; Set-Content -Path $marker -Value 'ok'; exit 0 }",
			"}",
			"Log 'watchdog: direct app launch failed — exe missing or damaged; manual repair install required'",
			"exit 2",
		].join("\r\n");
		writeFileSync(scriptPath, script, "utf8");
		// Task Scheduler's /TR is length- and quote-limited; a tiny .cmd wrapper
		// keeps it to a single quoted path.
		writeFileSync(wrapperPath, `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`, "utf8");

		// Arm SYNCHRONOUSLY (spawnSync, blocking). The previous chain relied on
		// async child-exit callbacks — the app could quit (or taskkill its own
		// tree) before ANY callback fired, leaving zero watchdog processes alive
		// behind an "install handed to watchdog" line (0.2.31 field failure,
		// twice). When this function returns, the watchdog either exists outside
		// our process tree, or the caller knows exactly why not.
		const psExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const inner = `${psExe} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
		// Field finding (0.2.31, twice): Win32_Process.Create returned ReturnValue 0
		// and the app logged "armed via WMI", yet no watchdog process ever existed
		// on the box — the created process died instantly (bare `powershell.exe`
		// fails to resolve inside the WMI host context). The arm now uses the
		// absolute powershell path, sets an explicit CurrentDirectory, and VERIFIES
		// the created PID is still alive 3s later — falling through to the next
		// mechanism when it isn't, instead of trusting ReturnValue.
		const wmiCommand = [
			`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner.replace(/'/g, "''")}'; CurrentDirectory = '${escapePowerShellSingleQuoted(dir)}' }`,
			"if ($r.ReturnValue -ne 0) { Write-Output ('CREATE-FAIL ' + $r.ReturnValue); exit 1 }",
			"Start-Sleep -Seconds 3",
			"if (Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue) { Write-Output ('ALIVE ' + $r.ProcessId) } else { Write-Output ('DIED ' + $r.ProcessId); exit 1 }",
		].join("; ");

		// 1) WMI: Win32_Process.Create parents the watchdog to WmiPrvSE.exe —
		//    outside both our job object and the taskkill /T tree-kill.
		try {
			const wmi = spawnSync(psExe, ["-NoProfile", "-NonInteractive", "-Command", wmiCommand], {
				encoding: "utf8", timeout: 30_000, windowsHide: true,
			});
			const wmiOut = wmi.stdout?.trim() ?? "";
			if (wmi.status === 0 && wmiOut.startsWith("ALIVE")) {
				log("INFO", `watchdog armed via WMI Win32_Process: pid=${wmiOut.split(/\s+/)[1] ?? "?"} installer=${installerCopy}`);
				return "wmi";
			}
			log("WARN", `watchdog WMI create failed (exit=${wmi.status} out=${wmiOut || "(none)"}) — trying schtasks`);
		} catch (err) {
			log("WARN", `watchdog WMI create threw: ${err instanceof Error ? err.message : String(err)} — trying schtasks`);
		}

		// 2) schtasks: the Task Scheduler service owns the watchdog (also tree-
		//    independent). Create + Run, both synchronous.
		try {
			const startAt = new Date(Date.now() + 2 * 60_000);
			const hhmm = `${String(startAt.getHours()).padStart(2, "0")}:${String(startAt.getMinutes()).padStart(2, "0")}`;
			const create = spawnSync("schtasks.exe", ["/Create", "/F", "/TN", WATCHDOG_TASK_NAME, "/SC", "ONCE", "/ST", hhmm, "/TR", `"${wrapperPath}"`], {
				encoding: "utf8", timeout: 20_000, windowsHide: true,
			});
			if (create.status !== 0) {
				log("WARN", `watchdog schtasks create exit=${create.status} — falling back to detached spawn`);
			} else {
				const run = spawnSync("schtasks.exe", ["/Run", "/TN", WATCHDOG_TASK_NAME], { encoding: "utf8", timeout: 20_000, windowsHide: true });
				if (run.status === 0) {
					log("INFO", `watchdog armed via schtasks: installer=${installerCopy} relaunchArgs=[${profileArgs().join(" ")}]`);
					return "schtasks";
				}
				log("WARN", `watchdog schtasks run exit=${run.status} — falling back to detached spawn`);
			}
		} catch (err) {
			log("WARN", `watchdog schtasks failed: ${err instanceof Error ? err.message : String(err)} — falling back to detached spawn`);
		}

		// 2b) Register-ScheduledTask: same Task Scheduler ownership (tree-kill
		//     immune) via the cmdlet/CIM surface instead of schtasks.exe — on the
		//     cloud box schtasks.exe exits 1 on everything while the
		//     ScheduledTasks module is a different access path. Verify the task
		//     actually reached Running before trusting it.
		try {
			const regCommand = [
				`$action = New-ScheduledTaskAction -Execute '${escapePowerShellSingleQuoted(psExe)}' -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"'`,
				"$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)",
				`Register-ScheduledTask -TaskName '${WATCHDOG_TASK_NAME}' -Action $action -Trigger $trigger -Force | Out-Null`,
				`Start-ScheduledTask -TaskName '${WATCHDOG_TASK_NAME}'`,
				"Start-Sleep -Seconds 3",
				`$st = (Get-ScheduledTask -TaskName '${WATCHDOG_TASK_NAME}' -ErrorAction SilentlyContinue).State`,
				"if ($st -eq 'Running') { Write-Output 'TASK-RUNNING' } else { Write-Output ('TASK-STATE ' + $st); exit 1 }",
			].join("; ");
			const reg = spawnSync(psExe, ["-NoProfile", "-NonInteractive", "-Command", regCommand], {
				encoding: "utf8", timeout: 30_000, windowsHide: true,
			});
			const regOut = reg.stdout?.trim() ?? "";
			if (reg.status === 0 && regOut.includes("TASK-RUNNING")) {
				log("INFO", `watchdog armed via Register-ScheduledTask: installer=${installerCopy}`);
				return "schtasks";
			}
			log("WARN", `watchdog Register-ScheduledTask failed (exit=${reg.status} out=${regOut || "(none)"}) — falling back to detached spawn`);
		} catch (err) {
			log("WARN", `watchdog Register-ScheduledTask threw: ${err instanceof Error ? err.message : String(err)} — falling back to detached spawn`);
		}

		// 3) Last resort: detached spawn. This watchdog is still a child in the
		//    PPID tree, so the caller MUST NOT taskkill the tree in this mode —
		//    it signals the mode back via the return value.
		spawnWatchdogDirect(scriptPath, installerCopy);
		return "detached";
	} catch (err) {
		log("ERROR", `watchdog setup failed: ${err instanceof Error ? err.message : String(err)}`);
		return "failed";
	}
}

/** Fallback watchdog launch (previous, less reliable mechanism). The child
 *  powershell inherits our environment — strip ELECTRON_* (notably
 *  ELECTRON_RUN_AS_NODE) so nothing it launches degrades to a bare Node
 *  process, and so its own child processes start from a clean slate. */
function spawnWatchdogDirect(scriptPath: string, installerCopy: string): void {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^ELECTRON_/i.test(key)) delete env[key];
	}
	const child = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
		{ detached: true, stdio: "ignore", windowsHide: true, env },
	);
	child.once("error", (err) => log("ERROR", `watchdog process failed: ${err.message}`));
	child.unref();
	log("INFO", `watchdog armed via detached spawn: pid=${child.pid ?? "unknown"} installer=${installerCopy}`);
}

/** Sweep a watchdog scheduled task left over from a previous run (startup). */
function cleanupWatchdogTask(): void {
	if (process.platform !== "win32") return;
	try {
		const child = spawn("schtasks.exe", ["/Delete", "/TN", WATCHDOG_TASK_NAME, "/F"], { stdio: "ignore", windowsHide: true });
		child.once("error", () => {});
		child.unref();
	} catch {
		/* best effort */
	}
}

function escapePowerShellSingleQuoted(value: string): string {
	return value.replace(/'/g, "''");
}

/**
 * Kill this process's own tree BEFORE the hard exit. process.exit(0) only ends
 * the Electron main/renderer processes — detached children (Playwright's
 * Chromium, node helpers spawned with detached:true) survive, keep handles on
 * files inside the app directory, and the NSIS old-uninstaller then hangs
 * forever in "Failed to uninstall old application files" waiting to delete
 * them (the 1h+ wedged-installer state behind three outages). taskkill /T
 * takes the whole tree by PID; fire-and-forget, best effort.
 */
function killOwnProcessTree(): void {
	if (process.platform !== "win32") return;
	try {
		const killer = spawn(
			`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`,
			["/pid", String(process.pid), "/t", "/f"],
			{ stdio: "ignore", windowsHide: true, detached: true },
		);
		killer.unref();
		log("INFO", `killOwnProcessTree: taskkill /pid ${process.pid} /t /f dispatched`);
	} catch (err) {
		log("WARN", `killOwnProcessTree failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Compare dotted versions numerically ("0.2.14" vs "0.2.9"). */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Schedule the periodic recheck. */
function scheduleRecheck(): void {
	if (recheckTimer) clearInterval(recheckTimer);
	recheckTimer = setInterval(() => {
		void checkNow().catch(() => {});
	}, RECHECK_INTERVAL_MS);
}

/**
 * Install the downloaded update: silent re-install over the current install
 * (no UAC under oneClick per-user mode) + relaunch. The `installing` flag
 * prevents re-entry from concurrent triggers (update-downloaded event, IM
 * manage_update, renderer install button). If app.quit() hasn't completed in
 * 15s (Playwright/DingTalk child process holding the loop), force-exit so the
 * NSIS installer isn't left waiting forever.
 */
export function quitAndInstall(): void {
	if (!enabled() || installing) return;
	// Machine-level breaker: repeated cross-version install failures (usually a
	// broken old uninstaller) — refuse to take the app down again; a manual
	// repair install is the documented exit.
	if (machineBreakerOpen()) {
		log("ERROR", "quitAndInstall blocked: machine breaker open (consecutive install failures)");
		setState({
			phase: "error",
			currentVersion: app.getVersion(),
			message: `本机已连续 ${consecutiveInstallFailures()} 次自动安装失败，已禁用自动安装。请手动下载最新安装包修复一次，成功后自动恢复。`,
		});
		return;
	}
	installing = true;
	requestedInstall = false;
	const targetVersion = pendingVersion ?? "unknown";
	log("INFO", `install requested: current=${app.getVersion()} target=${targetVersion}`);
	// Persist the attempt BEFORE quitting: if the app comes back still on the
	// old version, startup reconciliation counts the failure (the breaker then
	// trips in-process — no dependence on the watchdog being alive).
	markPendingInstall(targetVersion);

	// electron-updater starts NSIS BEFORE calling app.quit(). Drain new work,
	// allow the final response to flush, then close Chromium/IM/HTTP before NSIS
	// starts; otherwise the old process tree can keep the silent installer stuck.
	void (async () => {
		try {
			beginDrain?.();
			await new Promise((resolve) => setTimeout(resolve, REPLY_FLUSH_DELAY_MS));
			if (prepareToInstall) {
				await Promise.race([
					prepareToInstall(),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("安装前清理超过 10 秒")), 10_000),
					),
				]);
			}
			// Arm the watchdog synchronously (spawnSync — blocking). When this
			// returns, the watchdog either exists OUTSIDE our process tree
			// ("wmi"/"schtasks" — taskkill /T cannot reach it), or is a PPID
			// child ("detached" — caller must skip the tree-kill), or every
			// mechanism failed ("failed" — legacy fallback below).
			const armed = startInstallWatchdog();

			const hardExitTimer = setTimeout(() => {
				// Forced exit: outcome is unknowable from here, and the watchdog
				// owns the install from here on. Failure accounting is the startup
				// reconciliation's job now (pending marker written above) —
				// double-counting here made a single failed install trip the
				// breaker twice as fast.
				log("ERROR", "app.quit() 未在宽限期内退出，强制退出，移交 watchdog");
				// A "detached" watchdog is a PPID child of this process —
				// taskkill /T would take it down with the tree. Skip the
				// tree-kill in that mode: the watchdog's own KillStaleInstallers
				// and wedged-install branch handle the leftovers.
				if (armed !== "detached") killOwnProcessTree();
				process.exit(0);
			}, APP_EXIT_GRACE_MS);
			hardExitTimer.unref();
			if (armed === "failed") {
				// Every arm mechanism failed (WMI, schtasks, detached). Quitting
				// now would leave the app DOWN with nothing to install — fall
				// back to the legacy in-process NSIS path and accept the wedge
				// risk: a possible hang beats a certain outage.
				log("ERROR", "watchdog arm failed on every mechanism — falling back to legacy quitAndInstall (wedge risk accepted)");
				autoUpdater.quitAndInstall(true, false);
				return;
			}
			// The app NEVER invokes electron-updater's NSIS path: it starts the
			// installer while the app is still tearing down, and that race wedged
			// the uninstall-old step on every attempt on at least one host
			// (7/7) — while the identical manual sequence (app fully dead →
			// installer /S → relaunch, which is exactly what the armed watchdog
			// now performs) succeeded every time. The app just quits; the
			// watchdog does the rest.
			log("INFO", `install handed to watchdog (${armed}): app quitting now; watchdog runs installer /S after exit`);
			app.quit();
		} catch (err) {
			installing = false;
			endDrain?.();
			const message = err instanceof Error ? err.message : String(err);
			log("ERROR", `install preparation failed: ${message}`);
			recordFailure(targetVersion, message);
			setState({ phase: "error", currentVersion: app.getVersion(), message: `安装失败：${message}` });
		}
	})();
}

/** User-initiated check (and the periodic recheck path). Returns current state. */
export async function checkNow(): Promise<UpdateState> {
	if (!enabled()) return lastState;
	if (checking) return lastState;
	// 小派 got wedged for 12h+ by one stale temp file in the shared updater
	// cache — clear old partials before every check so a leftover can't block
	// the next download.
	sweepStaleUpdaterTemps();
	try {
		await autoUpdater.checkForUpdates();
	} catch (err) {
		setState({ phase: "error", currentVersion: app.getVersion(), message: (err as Error).message || String(err) });
	}
	return lastState;
}

/** User-initiated download of the already-announced update. */
export async function downloadNow(): Promise<UpdateState> {
	if (!enabled()) return lastState;
	if (downloading) return lastState;
	if (lastState.phase !== "available") return lastState;
	downloading = true;
	try {
		await autoUpdater.downloadUpdate();
	} catch (err) {
		downloading = false;
		requestedInstall = false;
		setState({ phase: "error", currentVersion: app.getVersion(), message: (err as Error).message || String(err) });
	}
	return lastState;
}

export type UpdateRequest =
	| { started: true; mode: "checking" | "downloading" | "pending" | "installing"; state: UpdateState }
	| { started: false; reason: string; state: UpdateState };

/**
 * Conversation-triggered update: an admin has already authorized the request,
 * so this routine owns check → download → idle install end to end. It is
 * fire-and-forget by design — the caller replies first, and the updater only
 * restarts after all in-flight turns have drained.
 */
export function requestUpdateAndInstall(): UpdateRequest {
	const capability = updateCapability();
	if (!capability.supported) {
		return { started: false, reason: capability.reason ?? "当前环境不支持自动更新", state: lastState };
	}
	if (!enabled()) {
		return { started: false, reason: "自动更新不可用", state: lastState };
	}

	requestedInstall = true;
	switch (lastState.phase) {
		case "idle":
		case "none":
		case "error":
			void checkNow().catch(() => {});
			return { started: true, mode: "checking", state: lastState };
		case "available":
			void downloadNow().catch(() => {});
			return { started: true, mode: "downloading", state: lastState };
		case "checking":
		case "downloading":
			return { started: true, mode: "pending", state: lastState };
		case "ready":
			scheduleIdleRestart();
			return { started: true, mode: "installing", state: lastState };
	}
}

/** Current state (renderer pulls this on mount). */
export function getUpdateState(): UpdateState {
	return lastState;
}

/** Stop the periodic recheck timer (called from will-quit). */
export function stopUpdater(): void {
	if (recheckTimer) {
		clearInterval(recheckTimer);
		recheckTimer = undefined;
	}
	if (idlePollTimer) {
		clearInterval(idlePollTimer);
		idlePollTimer = undefined;
	}
}

/**
 * Initialize the updater after the main window exists. No-op in dev/macOS.
 * The startup check is fire-and-forget — it must never block app startup.
 */
export function setupAutoUpdater(win: BrowserWindow): void {
	window = win;
	if (!enabled()) {
		// Non-Windows/dev: renderer still gets a stable "idle" state so the UI
		// shows the current version without offering update buttons.
		setState({ phase: "idle", currentVersion: app.getVersion() });
		return;
	}

	// Startup reconciliation: if the running version is >= any recorded failed
	// target, that install actually succeeded before relaunch — clear the count
	// so future updates to NEW versions aren't blocked by stale breakers.
	reconcilePendingInstall();
	const current = app.getVersion();
	for (const [version, record] of Object.entries(loadFailures().versions ?? {})) {
		if (compareVersions(current, version) >= 0) {
			log("INFO", `startup: running ${current} >= previously failed target ${version} — clearing failure record`);
			clearFailure(version);
			// An install DID succeed on this box → the machine-level streak is
			// over; re-enable auto-install.
			clearConsecutiveFailures();
		} else if (record.attempts >= MAX_ATTEMPTS_PER_VERSION) {
			log("WARN", `startup: ${version} remains blocked after ${record.attempts} failed attempts (last: ${record.lastError})`);
		}
	}
	if (machineBreakerOpen()) {
		log("WARN", `startup: machine breaker open (${consecutiveInstallFailures()} consecutive cross-version install failures) — auto-install stays off until a manual repair install succeeds`);
	}

	// Broken-install probe: per-user NSIS must have an HKCU uninstall entry.
	inspectInstallHealth();
	// Sweep a watchdog scheduled task the previous run may have left behind
	// (the script deletes its own task, this covers crash paths).
	cleanupWatchdogTask();
	// Sweep a watchdog scheduled task the previous run may have left behind
	// (the script deletes its own task, this covers crash paths).
	cleanupWatchdogTask();

	autoUpdater.autoDownload = false;
	// Never let a normal app quit bypass prepareToInstall/watchdog. All unattended
	// installs run through our guarded quitAndInstall() path.
	autoUpdater.autoInstallOnAppQuit = false;
	// Gitee Releases serve assets via a 302 → foruda.gitee.com CDN that does NOT
	// advertise Accept-Ranges. electron-updater's differential downloader probes
	// ranges on every check, fails ("Server doesn't support Accept-Ranges"),
	// then falls back to a full 97MB re-download. The probe itself is wasted I/O
	// and the noisy fallback occasionally aborts. Disabling webInstaller makes
	// the generic provider always use the simple full-download path, which is
	// what actually worked here anyway.
	autoUpdater.disableWebInstaller = true;
	autoUpdater.logger = fileLogger;
	try {
		autoUpdater.setFeedURL({ provider: "generic", url: UPDATE_FEED });
	} catch (err) {
		console.error("[updater] setFeedURL failed:", err);
	}
	wireEvents();
	setState({ phase: "idle", currentVersion: app.getVersion() });

	// Startup check (delayed so it never races app/boot) + periodic recheck.
	setTimeout(() => { void checkNow().catch(() => {}); }, FIRST_CHECK_DELAY_MS);
	scheduleRecheck();
}
