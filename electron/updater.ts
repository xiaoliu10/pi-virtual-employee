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
import { appendFileSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
/** Installer watchdog: restore service if NSIS never relaunches the app. */
const WATCHDOG_TIMEOUT_SECONDS = 10 * 60;
const WATCHDOG_DIR = "update-watchdog";
const UPDATE_LOG_DIR = "logs";
const UPDATE_LOG_FILE = "updater.log";

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
/** Before installing, pause new IM turns; released on failure/timeout. */
let beginDrain: (() => void) | null = null;
let endDrain: (() => void) | null = null;

/** main.ts hooks the engine idle check + autoUpdate config in here. */
export function setupUnattended(opts: {
	enabled: () => boolean;
	isIdle: () => boolean;
	beginDrain?: () => void;
	endDrain?: () => void;
	prepareToInstall?: () => Promise<void>;
}): void {
	unattendedEnabled = opts.enabled;
	isEngineIdle = opts.isIdle;
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
		log("INFO", `update downloaded: version=${info.version ?? pendingVersion ?? "unknown"} file=${downloadedInstallerPath ?? "unknown"}`);
		setState({ phase: "ready", currentVersion: app.getVersion(), version: info.version ?? pendingVersion ?? "" });
		if (unattendedEnabled() || requestedInstall) scheduleIdleRestart();
	});
	autoUpdater.on("error", (err: Error) => {
		checking = false;
		downloading = false;
		requestedInstall = false;
		endDrain?.();
		setState({ phase: "error", currentVersion: app.getVersion(), message: err.message || String(err) });
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

/**
 * Independent PowerShell watchdog: runs outside Electron and waits for NSIS.
 * If no app process is alive after 10 minutes, it retries the copied oneClick
 * installer once. This removes the outage mode where NSIS dies/hangs after the
 * application has already quit. The installer copy is outside electron-updater's
 * cache, so cache cleanup cannot race it.
 */
function startInstallWatchdog(): void {
	if (process.platform !== "win32" || !downloadedInstallerPath) {
		log("WARN", "watchdog skipped: downloaded installer path unavailable");
		return;
	}
	try {
		const dir = join(app.getPath("userData"), WATCHDOG_DIR);
		mkdirSync(dir, { recursive: true });
		const installerCopy = join(dir, basename(downloadedInstallerPath));
		const scriptPath = join(dir, "watch-update.ps1");
		const markerPath = join(dir, "completed.txt");
		rmSync(markerPath, { force: true });
		copyFileSync(downloadedInstallerPath, installerCopy);
		const exeName = "Pi Virtual Employee";
		const appExe = process.execPath;
		const script = [
			"$ErrorActionPreference = 'SilentlyContinue'",
			`$log = '${escapePowerShellSingleQuoted(updaterLogPath())}'`,
			`$installer = '${escapePowerShellSingleQuoted(installerCopy)}'`,
			`$appExe = '${escapePowerShellSingleQuoted(appExe)}'`,
			`$marker = '${escapePowerShellSingleQuoted(markerPath)}'`,
			`Start-Sleep -Seconds ${WATCHDOG_TIMEOUT_SECONDS}`,
			`$running = Get-Process -Name '${escapePowerShellSingleQuoted(exeName)}' -ErrorAction SilentlyContinue`,
			"if ($running) {",
			"  Add-Content -Path $log -Value \"[$([DateTime]::UtcNow.ToString('o'))] [INFO] watchdog: application recovered\"",
			"  Set-Content -Path $marker -Value 'ok'",
			"  exit 0",
			"}",
			"Add-Content -Path $log -Value \"[$([DateTime]::UtcNow.ToString('o'))] [ERROR] watchdog: app absent after timeout, terminate stale installers and retry\"",
			"Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Name -like 'Pi-Virtual-Employee-Setup-*.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
			"Start-Sleep -Seconds 3",
			"$retry = Start-Process -FilePath $installer -ArgumentList @('--updated','/S','--force-run') -PassThru",
			"$finished = $retry.WaitForExit(180000)",
			"if (-not $finished) { Stop-Process -Id $retry.Id -Force; Add-Content -Path $log -Value \"[$([DateTime]::UtcNow.ToString('o'))] [ERROR] watchdog: retry installer timed out after 180s\" }",
			"Start-Sleep -Seconds 30",
			`$running = Get-Process -Name '${escapePowerShellSingleQuoted(exeName)}' -ErrorAction SilentlyContinue`,
			"if ($running) { Set-Content -Path $marker -Value 'recovered'; exit 0 }",
			"if (Test-Path $appExe) { Start-Process -FilePath $appExe; Start-Sleep -Seconds 15 }",
			`$running = Get-Process -Name '${escapePowerShellSingleQuoted(exeName)}' -ErrorAction SilentlyContinue`,
			"if ($running) { Add-Content -Path $log -Value \"[$([DateTime]::UtcNow.ToString('o'))] [WARN] watchdog: restored service by launching installed app\"; exit 0 }",
			"Add-Content -Path $log -Value \"[$([DateTime]::UtcNow.ToString('o'))] [ERROR] watchdog: retry and direct app launch both failed\"",
			"exit 2",
		].join("\r\n");
		writeFileSync(scriptPath, script, "utf8");
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			{ detached: true, stdio: "ignore", windowsHide: true },
		);
		child.once("error", (err) => log("ERROR", `watchdog process failed: ${err.message}`));
		child.unref();
		log("INFO", `watchdog armed: pid=${child.pid ?? "unknown"} installer=${installerCopy}`);
	} catch (err) {
		log("ERROR", `watchdog setup failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function escapePowerShellSingleQuoted(value: string): string {
	return value.replace(/'/g, "''");
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
	installing = true;
	requestedInstall = false;
	log("INFO", `install requested: current=${app.getVersion()} target=${pendingVersion ?? "unknown"}`);

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
			startInstallWatchdog();

			const hardExitTimer = setTimeout(() => {
				log("ERROR", "app.quit() 15s 未退出，强制 process.exit(0) 以放行 NSIS 安装器");
				process.exit(0);
			}, 15_000);
			hardExitTimer.unref();
			log("INFO", "calling autoUpdater.quitAndInstall(silent=true, forceRunAfter=true)");
			autoUpdater.quitAndInstall(true, true);
		} catch (err) {
			installing = false;
			endDrain?.();
			const message = err instanceof Error ? err.message : String(err);
			log("ERROR", `install preparation failed: ${message}`);
			setState({ phase: "error", currentVersion: app.getVersion(), message: `安装失败：${message}` });
		}
	})();
}

/** User-initiated check (and the periodic recheck path). Returns current state. */
export async function checkNow(): Promise<UpdateState> {
	if (!enabled()) return lastState;
	if (checking) return lastState;
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

	autoUpdater.autoDownload = false;
	// Never let a normal app quit bypass prepareToInstall/watchdog. All unattended
	// installs run through our guarded quitAndInstall() path.
	autoUpdater.autoInstallOnAppQuit = false;
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
