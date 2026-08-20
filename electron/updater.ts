/**
 * Auto-update via electron-updater (generic provider → Gitee Releases).
 *
 * Gate: only the packaged Windows build runs the updater — dev and macOS are
 * no-ops (renderer still gets a state so the UI shows the current version and
 * no misleading buttons). Strategy is "auto-check, confirm-download": startup
 * checks after 15s, then every 6h; a found update is announced but only
 * downloaded when the user clicks download; once downloaded, the user clicks
 * "restart & install", or the next normal quit installs it silently
 * (autoInstallOnAppQuit).
 *
 * Unattended mode (headless servers, config general.autoUpdate=true): after
 * download completes, a poll waits for the engine to be idle (no in-flight
 * agent turn) and then restarts into the installer automatically. The poll
 * gives up after 24h — the downloaded update still installs on the next
 * normal quit via autoInstallOnAppQuit.
 *
 * The renderer is the display surface: every state change is pushed as
 * "update:event", and on mount the renderer pulls "update:getState" so events
 * that fired before it subscribed (the startup check fires ~15s in) aren't
 * lost. IPC is idempotent against re-entry — a second check while one is in
 * flight just returns the current state.
 */
import { app, type BrowserWindow } from "electron";
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
let pendingVersion: string | undefined;
let pendingReleaseNotes: string | undefined;

/**
 * Unattended mode: download + install without a human at the UI. Wired by
 * main.ts to config (general.autoUpdate) and the engine's idle signal. Both
 * are getters so config changes apply without re-wiring.
 */
let unattendedEnabled: () => boolean = () => false;
let isEngineIdle: () => boolean = () => true;

/** main.ts hooks the engine idle check + autoUpdate config in here. */
export function setupUnattended(opts: { enabled: () => boolean; isIdle: () => boolean }): void {
	unattendedEnabled = opts.enabled;
	isEngineIdle = opts.isIdle;
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
		// Unattended servers: kick the download off without waiting for a click.
		if (unattendedEnabled()) void downloadNow().catch(() => {});
	});
	autoUpdater.on("update-not-available", () => {
		checking = false;
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
	autoUpdater.on("update-downloaded", (info: { version?: string } = {}) => {
		downloading = false;
		setState({ phase: "ready", currentVersion: app.getVersion(), version: info.version ?? pendingVersion ?? "" });
		if (unattendedEnabled()) scheduleIdleRestart();
	});
	autoUpdater.on("error", (err: Error) => {
		checking = false;
		downloading = false;
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
	if (idlePollTimer) clearInterval(idlePollTimer);
	const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS;
	idlePollTimer = setInterval(() => {
		if (Date.now() > deadline) {
			clearInterval(idlePollTimer);
			idlePollTimer = undefined;
			return;
		}
		if (!isEngineIdle()) return;
		clearInterval(idlePollTimer);
		idlePollTimer = undefined;
		quitAndInstall();
	}, IDLE_POLL_MS);
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
 * (no UAC under currentUser mode) + relaunch. Safe to call from renderer; the
 * existing will-quit handlers (profile lock, scheduler, browser) run first.
 */
export function quitAndInstall(): void {
	if (!enabled()) return;
	try {
		autoUpdater.quitAndInstall(true, true);
	} catch (err) {
		setState({ phase: "error", currentVersion: app.getVersion(), message: `安装失败：${(err as Error).message}` });
	}
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
		setState({ phase: "error", currentVersion: app.getVersion(), message: (err as Error).message || String(err) });
	}
	return lastState;
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
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.logger = console;
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
