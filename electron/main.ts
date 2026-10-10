/**
 * Electron main process.
 *
 * Owns the single-employee runtime: opens the SQLite DB (in userData), wires up
 * config/history/engine, starts the local HTTP+SSE transport (the renderer
 * streams chat through it), the IM adapter manager, and autostart. All
 * GUI-facing state (config, tasks, autostart) flows over IPC.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { mkdir, readFile, writeFile, copyFile, readdir, rm } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import util from "node:util";
import { openDatabase, closeDatabase } from "../src/db/sqlite.js";
import { ConfigStore, normalizeModelConfig, type ExternalProviderConfig, type Supplier } from "../src/db/config-store.js";
import { HistoryStore } from "../src/db/history-store.js";
import { KnowledgeService } from "../src/knowledge/knowledge-service.js";
import { BrowserService } from "../src/browser/browser-service.js";
import { ComputerService } from "../src/computer/computer-service.js";
import { ScheduledTaskStore, type ScheduledTaskRow } from "../src/db/scheduled-task-store.js";
import { WorkItemStore } from "../src/db/work-item-store.js";
import { WorkService, buildWorkLearning } from "../src/scheduler/work-service.js";
import { resolveRole } from "../src/security/permissions.js";
import { SchedulerService, shouldPushScheduledResult } from "../src/scheduler/scheduler-service.js";
import {
	type AutonomousChainState,
	buildAutonomousTurnPrefix,
	budgetExceeded,
	normalizeBudget,
	parseChainReply,
	parseChainState,
	buildLearnTurnAsk,
	nextStallStep,
	STALL_QUIET_RETRIES,
} from "../src/scheduler/autonomous.js";
import { TelemetryStore } from "../src/db/telemetry-store.js";
import { ProposalStore } from "../src/engine/proposals.js";
import { PromptLab } from "../src/db/prompt-lab.js";
import { DocumentService } from "../src/documents/document-service.js";
import { FileSystemService } from "../src/filesystem/filesystem-service.js";
import { ArtifactStore } from "../src/db/artifact-store.js";
import { ReportService } from "../src/reports/report-service.js";
import { DownloadStore } from "../src/downloads/download-store.js";
import { DownloadService } from "../src/downloads/download-service.js";
import { EmployeeEngine, type AuthLoginEventBridge } from "../src/engine/engine.js";
import { disposeShellCommands } from "../src/engine/tools/shell.js";
import { replyHasReportLink } from "../src/engine/tools/reports.js";
import { scheduledTimePrefix } from "../src/engine/tools/time.js";
import { buildSystemPrompt, defaultCoreRules } from "../src/engine/prompt.js";
import { AUTH_IPC } from "../src/shared/auth.js";
import type { AuthLoginState } from "../src/shared/auth.js";
import { startHttpTransport } from "../src/transport/http.js";
import { setupAutoUpdater, getUpdateState, lastCheckTime, checkNow, downloadNow, quitAndInstall, installNow as installNowUpdate, stopUpdater, setupUnattended, updateCapability, requestUpdateAndInstall, type UpdateState } from "./updater.js";
import type { UpdateToolStatus } from "../src/engine/tools/update.js";
import { IMAdapterManager, availableChannels } from "../src/im/manager.js";
import { setDiagFile } from "../src/im/diag.js";
import type { InboundActor } from "../src/im/types.js";
import {
	buildEmployeePackage,
	importEmployeePackage,
	applyPendingImport,
	pendingImportPath,
	type ExportOptions,
} from "../src/io/employee-package.js";
import AdmZip from "adm-zip";
import { parseSkillFile, SKILL_NAME_PATTERN } from "../src/engine/skills/skill-parser.js";

// __dirname is provided at runtime by the esbuild ESM shim banner (scripts/).
const isDev = !!process.env.VITE_DEV_SERVER_URL;

/**
 * Multi-instance support: each named profile gets its own userData directory
 * (DB + config + skills + history all isolate automatically). The default
 * profile keeps the original userData path for backward compatibility. Resolve
 * and redirect BEFORE app.whenReady — everything reading userData depends on it.
 */
const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const LOCK_FILE = ".profile.lock";

/** Project the Electron updater state to the platform-agnostic tool status. */
function toUpdateToolStatus(state: UpdateState): UpdateToolStatus {
	return {
		currentVersion: state.currentVersion,
		phase: state.phase,
		targetVersion: "version" in state ? state.version : undefined,
		percent: state.phase === "downloading" ? state.percent : undefined,
		error: state.phase === "error" ? state.message : undefined,
		lastCheckAt: lastCheckTime(),
	};
}

function resolveProfile(argv: string[], env: NodeJS.ProcessEnv): string {
	const fromArg = (() => {
		const i = argv.indexOf("--profile");
		return i >= 0 ? argv[i + 1] : undefined;
	})();
	const name = (fromArg ?? env.PI_PROFILE ?? "default").trim();
	if (name !== "default" && !PROFILE_NAME_RE.test(name)) {
		console.error(`[main] invalid profile name "${name}" (allowed: A-Z a-z 0-9 _ -)`);
		app.quit();
		return "default";
	}
	return name;
}

/** Acquire an exclusive lock on the profile dir; quit if another live process holds it. */
function acquireProfileLock(userDataDir: string): void {
	const lockPath = path.join(userDataDir, LOCK_FILE);
	const take = () => {
		const fd = openSync(lockPath, "wx");
		writeFileSync(fd, String(process.pid));
	};
	if (!existsSync(lockPath)) {
		take();
		return;
	}
	// Stale-lock recovery: if the recorded pid is dead, take over.
	try {
		const pid = Number(readFileSync(lockPath, "utf8").trim());
		if (pid && pid !== process.pid) {
			process.kill(pid, 0); // throws if the process is gone
			console.error(`[main] profile already running (pid ${pid}); exiting.`);
			app.quit();
			return;
		}
	} catch {
		// pid missing or dead → reclaim
		try {
			unlinkSync(lockPath);
		} catch {
			/* ignore */
		}
	}
	take();
}

const activeProfile = resolveProfile(process.argv, process.env);
if (activeProfile !== "default") {
	app.setPath("userData", path.join(app.getPath("appData"), "pi-virtual-employee", "profiles", activeProfile));
}
// app.setPath doesn't create the dir; ensure it exists before writing the lock.
mkdirSync(app.getPath("userData"), { recursive: true });
// App logs live with the profile data (not the packaged app-name dir Electron
// would pick) — one known place for field diagnostics like im.log.
app.setPath("logs", path.join(app.getPath("userData"), "logs"));
acquireProfileLock(app.getPath("userData"));
app.on("will-quit", () => {
	try {
		unlinkSync(path.join(app.getPath("userData"), LOCK_FILE));
	} catch {
		/* ignore */
	}
});

let mainWindow: BrowserWindow | null = null;
/** Invoked when the main window closes — used to abort a pending account login
 * (the renderer can no longer answer its prompts). Assigned in main(). */
let onMainWindowClosed: () => void = () => {};

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1360,
		height: 860,
		minWidth: 1060,
		minHeight: 680,
		titleBarStyle: "hiddenInset",
		backgroundColor: "#ffffff",
		// Window/taskbar icon in DEV (Linux/Win). Packaged apps take their
		// dock/exe icon from the bundle (mac) / NSIS config (win), so we don't
		// set it there.
		...(app.isPackaged ? {} : { icon: path.join(__dirname, "../../build/icon.png") }),
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
	} else {
		mainWindow.loadFile(path.join(__dirname, "../renderer/dist/index.html"));
	}

	// No renderer-initiated child windows (review H5): every window.open is
	// denied in-app; https URLs are handed to the SYSTEM browser instead, so an
	// OAuth page can never render inside a window we do not control.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		try {
			if (new URL(url).protocol === "https:") void shell.openExternal(url);
		} catch {
			/* unparsable → just deny */
		}
		return { action: "deny" };
	});

	if (activeProfile !== "default") mainWindow.setTitle(`虚拟员工 — ${activeProfile}`);

	mainWindow.on("closed", () => {
		mainWindow = null;
		onMainWindowClosed();
	});

	// Forward renderer console (incl. React errors) to the main-process log.
	mainWindow.webContents.on("console-message", (_e, level: number, message: string) => {
		if (level >= 2) console.log(`[renderer:${level}] ${message}`);
	});
	mainWindow.webContents.on("render-process-gone", (_e, details) => {
		console.error("[renderer] process gone:", details.reason);
	});
}

function applyAutostart(enabled: boolean): void {
	try {
		app.setLoginItemSettings({ openAtLogin: enabled });
	} catch (err) {
		// Unsigned dev builds can't register login items on macOS; non-fatal.
		console.warn("[main] could not set login item:", (err as Error).message);
	}
}

/** Recursively copy a directory tree (used to import skill directories). */
async function copyTree(src: string, dest: string): Promise<void> {
	await mkdir(dest, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const from = path.join(src, entry.name);
		const to = path.join(dest, entry.name);
		if (entry.isDirectory()) await copyTree(from, to);
		else await copyFile(from, to);
	}
}

/**
 * Import a skill from a .zip whose root IS the skill directory: top-level
 * SKILL.md plus any number of bundled scripts/templates/subdirectories.
 *
 * Safety (zip-slip): every entry's relative path is normalized and rejected if
 * it escapes the skill dir (`..`, absolute, drive letters). `entryName` is never
 * joined raw — we split on `/` and let `path.join` re-normalize, then assert
 * the resolved dest stays under the skill dir.
 *
 * Top-level wrapper directory: zips often wrap content in `<name>/SKILL.md`.
 * If all entries share a single top-level segment we strip it so the skill
 * lands at `userSkillsDir/<skillName>/SKILL.md` (the form the loader expects).
 * Returns `{ok:false}` for any malformed structure so the caller reports it.
 */
async function importSkillZip(
	zipPath: string,
	userSkillsDir: string,
	confirmOverwrite?: (name: string) => Promise<"overwrite" | "skip" | "cancel">,
): Promise<
	| { ok: true; name: string; skipped?: boolean; canceled?: boolean }
	| { ok: false; error: string }
> {
	let zip: AdmZip;
	try {
		zip = new AdmZip(zipPath);
	} catch (err) {
		return { ok: false, error: `无法读取 zip：${(err as Error).message}` };
	}
	const entries = zip.getEntries().filter((e) => !e.isDirectory && !e.entryName.endsWith("/"));
	if (entries.length === 0) return { ok: false, error: "zip 内无可读文件" };

	// Normalize entry names to forward-slash relative paths; reject anything
	// that looks like an absolute or escaping path outright.
	const rels: string[] = [];
	for (const e of entries) {
		let rel = e.entryName.replace(/\\/g, "/").replace(/^\.\//, "");
		// Drop any leading "/" — an entryName that starts with "/" is absolute in zip terms.
		rel = rel.replace(/^\/+/, "");
		if (!rel || rel.includes("..") || /^[a-zA-Z]:/.test(rel)) {
			return { ok: false, error: `zip 内含非法路径，已拒绝：${e.entryName}` };
		}
		rels.push(rel);
	}

	// Detect & strip a shared top-level wrapper directory (e.g. my-skill/SKILL.md).
	const prefix = sharedTopLevelSegment(rels);
	const stripped = prefix ? rels.map((r) => r.slice(prefix.length)) : rels;

	// There must be a top-level SKILL.md for this to be a valid skill package.
	const hasSkillMd = stripped.some((r) => r === "SKILL.md");
	if (!hasSkillMd) {
		return { ok: false, error: "zip 顶层缺少 SKILL.md（若外层有包裹目录，应直接以 SKILL.md 为顶层）" };
	}

	// Skill name: prefer the SKILL.md frontmatter `name`; fall back to the zip
	// file name (minus extension). Both must satisfy the loader's name rule so
	// the imported directory is one the loader will actually load.
	const skillMdEntry = entries.find((e) =>
		e.entryName.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").slice(prefix?.length ?? 0) === "SKILL.md",
	)!;
	let name = "";
	try {
		const raw = skillMdEntry.getData().toString("utf8");
		const parsed = parseSkillFile("SKILL.md", raw);
		name = parsed.skill?.name ?? "";
	} catch {
		/* fall back to filename */
	}
	if (!name) {
		name = path.basename(zipPath, ".zip");
	}
	if (!SKILL_NAME_PATTERN.test(name)) {
		return { ok: false, error: `技能名「${name}」不合法：仅允许中文、小写字母、数字、连字符` };
	}

	const dest = path.join(userSkillsDir, name);
	// Same-name import: ask before replacing an existing skill so the user never
	// loses local edits silently. Clean the target first when overwriting so
	// stale files from a prior version don't linger.
	if (confirmOverwrite && existsSync(dest)) {
		const choice = await confirmOverwrite(name);
		if (choice === "cancel") return { ok: true, name, skipped: false, canceled: true };
		if (choice === "skip") return { ok: true, name, skipped: true };
	}
	await rm(dest, { recursive: true, force: true }).catch(() => {});
	await mkdir(dest, { recursive: true });

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const rel = stripped[i];
		// Final safety net: the resolved destination must stay under the skill dir.
		const target = path.resolve(dest, ...rel.split("/"));
		const base = path.resolve(dest);
		if (target !== base && !target.startsWith(base + path.sep)) {
			return { ok: false, error: `解压路径越界，已拒绝：${entry.entryName}` };
		}
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, entry.getData());
	}
	return { ok: true, name, skipped: false };
}

/** If every relative path shares the same first segment followed by `/`, return
 * that segment (with trailing `/`) so callers can strip the wrapper dir. */
function sharedTopLevelSegment(rels: string[]): string | null {
	const tops = rels.map((r) => (r.includes("/") ? r.slice(0, r.indexOf("/") + 1) : null));
	if (tops.length === 0) return null;
	const first = tops[0];
	if (!first) return null; // a path with no `/` means files live at zip root → no wrapper
	if (!tops.every((t) => t === first)) return null;
	return first;
}

/** Directory for a named (non-default) profile. */
function profileDir(name: string): string {
	return path.join(app.getPath("appData"), "pi-virtual-employee", "profiles", name);
}

/**
 * Tee main-process console output to a log file. Packaged builds have no
 * visible console, so engine/im errors printed with console.* were invisible
 * to anyone debugging a headless box — an entire outage class ("this one group
 * went silent") stayed undiagnosable from the machine itself. ~5MB rotation
 * (main.log → main.log.old); original console behavior is preserved.
 */
function teeConsoleToDisk(file: string): void {
	try { mkdirSync(path.dirname(file), { recursive: true }); } catch { /* exists */ }
	const append = (line: string): void => {
		try {
			if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) {
				try { unlinkSync(`${file}.old`); } catch { /* no old yet */ }
				renameSync(file, `${file}.old`);
			}
		} catch { /* best effort */
		}
		try { appendFileSync(file, line); } catch { /* read-only volume etc. */
		}
	};
	const fmt = (parts: unknown[]): string => util.format(...parts);
	const orig = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
	const stamped = (parts: unknown[]): string => `[${new Date().toISOString()}] ${fmt(parts)}\n`;
	console.log = (...parts: unknown[]) => { orig.log(...parts); append(stamped(parts)); };
	console.warn = (...parts: unknown[]) => { orig.warn(...parts); append(stamped(parts)); };
	console.error = (...parts: unknown[]) => { orig.error(...parts); append(stamped(parts)); };
}

/** Relaunch the app into a different profile (used by "import as new employee"). */
function relaunchInto(profile: string): void {
	const args: string[] = [];
	const raw = process.argv.slice(1);
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "--profile") {
			i++; // skip the value too
			continue;
		}
		if (raw[i]?.startsWith("--profile=")) continue;
		args.push(raw[i]);
	}
	args.push("--profile", profile);
	app.relaunch({ args });
	app.exit(0);
}

async function main(): Promise<void> {
	const userData = app.getPath("userData");
	// Files received over IM live inside the profile (not OS Temp) and are
	// allowlisted automatically — the employee must read what was just sent to
	// it without a settings round-trip (field 2026-09-18).
	const inboundDir = path.join(userData, "inbound");
	void mkdir(inboundDir, { recursive: true }).catch(() => {});
	// From here on, everything printed with console.* also lands in
	// logs/main.log — the headless box's only window into main-process errors.
	teeConsoleToDisk(path.join(userData, "logs", "main.log"));
	// Cross-platform packages ship target-native binaries as extraResources. In
	// dev, omit these overrides and let each npm package resolve its local build.
	const nativeDir = app.isPackaged ? path.join(process.resourcesPath, "native") : null;
	const sqliteBinding = nativeDir ? path.join(nativeDir, "better_sqlite3.node") : undefined;
	const vecExtension = nativeDir
		? path.join(nativeDir, process.platform === "win32" ? "vec0.dll" : process.platform === "darwin" ? "vec0.dylib" : "vec0.so")
		: undefined;
	const db = openDatabase(path.join(userData, "pi-employee.sqlite"), sqliteBinding);
	const config = new ConfigStore(db);
	const history = new HistoryStore(db);
	const knowledge = new KnowledgeService(db, config, vecExtension);
	const browser = new BrowserService(config, userData);
	const computer = new ComputerService(config, userData);
	const scheduledTaskStore = new ScheduledTaskStore(db);
	const scheduler = new SchedulerService(scheduledTaskStore);

	// Document resources: uploaded files live under the configured documents dir
	// (default userData/documents). Create the default so the catalog has a home.
	const defaultDocumentsDir = path.join(userData, "documents");
	const documents = new DocumentService(db, config, defaultDocumentsDir);
	await mkdir(documents.dir(), { recursive: true }).catch(() => {});

	// Scoped local filesystem access for the employee (read-only listing + the
	// two-step authorized delete tool). No directory is pre-created here — the
	// service just resolves the configured whitelist at call time.
	const filesystem = new FileSystemService(config);
	filesystem.addAllowedDir(inboundDir);

	// Browser downloads: capture into a managed workspace so the employee can
	// list/read/analyze downloaded files (Excel exports, etc.) without touching
	// the user's real Downloads folder. Funnel every Playwright download event.
	const downloadStore = new DownloadStore(db);
	const downloadService = new DownloadService(config, userData, downloadStore);
	await downloadService.dir();
	browser.setDownloadHandler((dl, page) => {
		void downloadService.handleDownload(dl, page);
	});
	// OS clipboard access for browser_paste_text: RDP/SSH canvas sessions only
	// accept CJK through a paste (keydown → remote scan code loses it), and the
	// client syncs the OS clipboard, not the page one.
	browser.setClipboardWriter((text) => clipboard.writeText(text));

	// Built-in skills ship under dist-electron/resources/skills (copied by the
	// build script). User-imported skills live under userData/skills.
	const builtinSkillsDir = path.join(__dirname, "resources", "skills");
	const userSkillsDir = path.join(userData, "skills");
	// Self-improvement proposals live next to the profile, as plain markdown the
	// operator (or a developer) can read, diff and delete.
	const proposalsDir = path.join(userData, "proposals");
	await mkdir(userSkillsDir, { recursive: true }).catch(() => {});

	// Clone path: if this profile was launched to absorb a pending employee
	// package, restore it now (before the engine reads config / skills load).
	await applyPendingImport({ db, config, knowledge, skillsDir: userSkillsDir });

	const initialCfg = config.all();
	const reportService = new ReportService(new ArtifactStore(db), config);
	const engine = new EmployeeEngine(config, history, knowledge, browser, scheduler, documents, filesystem, reportService, downloadService, {
		builtinSkillsDir,
		userSkillsDir,
		shellAuditLogPath: path.join(userData, "logs", "shell-audit.log"),
		proposalsDir,
	}, { timeoutMs: (initialCfg.general.requestTimeoutMin || 0) * 60_000 });
	engine.setComputerService(computer);
	// Run telemetry: the employee's own record of how its turns went (my_stats tool;
	// later, the input to a self-improvement proposal loop). Pruned at startup,
	// alongside the other housekeeping sweeps.
	const telemetry = new TelemetryStore(db);
	engine.setTelemetryStore(telemetry);
	engine.setProposalStore(new ProposalStore(proposalsDir));

	// Work items (autonomous work phase 2): mined from daily conversations,
	// confirmed by an admin, worked across self-scheduled windows.
	const workItemStore = new WorkItemStore(db);
	engine.workItems = workItemStore;
	// Prompt lab: evaluation cases + variants + history for prompt.rules. The
	// red-line cases are seeded once so a fresh box can evaluate a candidate
	// without having to invent an evaluation set first. Evaluation runs go through
	// the engine's isolated, non-persisted, telemetry-excluded path.
	const promptLab = new PromptLab(db);
	const seededCases = promptLab.seedCases();
	if (seededCases > 0) console.log(`[main] prompt-lab: seeded ${seededCases} evaluation cases`);
	engine.setPromptLab(promptLab);
	try {
		const pruned = telemetry.prune();
		if (pruned > 0) console.log(`[main] telemetry pruned: ${pruned} turn rows past retention`);
	} catch (err) {
		console.warn("[main] telemetry prune failed:", (err as Error).message);
	}
	// The packaged playwright package sits under app.asar/node_modules; its CLI
	// can install the Chromium kernel into the user's ms-playwright cache.
	engine.setPlaywrightCliPath(path.join(__dirname, "../node_modules/playwright/cli.js"));
	engine.setUpdateOperations({
		isSupported: updateCapability,
		getStatus: () => toUpdateToolStatus(getUpdateState()),
		checkNow: async () => toUpdateToolStatus(await checkNow()),
		requestUpdateAndInstall: () => {
			const result = requestUpdateAndInstall();
			return { ...result, status: toUpdateToolStatus(result.state) };
		},
		installNow: () => {
			const result = installNowUpdate(() => engine.abortAllTurns("install_now"));
			return result.ok
				? { started: true as const, mode: "installing" as const, status: toUpdateToolStatus(getUpdateState()) }
				: { started: false as const, reason: result.error ?? "未知原因", status: toUpdateToolStatus(getUpdateState()) };
		},
	});
	knowledge.setLlm((system, user) => engine.complete(system, user));
	// Self-heal: pick up chunks a previous run left pending/failed (crash, upgrade,
	// or a transient embedding failure). Best-effort — never block startup on it.
	void knowledge
		.indexOutstanding()
		.then((report) => {
			if (report.total > 0) console.log(`[main] startup reindex: ${report.indexed}/${report.total} embedded`);
		})
		.catch((err) => console.warn("[main] startup reindex failed:", (err as Error).message));
	// Scheduled-task runner: each fire runs the employee on the task prompt in a
	// dedicated conversation (results show in the sidebar), then refreshes the UI.
	// If the task was created in an IM conversation, the result is proactively
	// pushed back to that group/1:1 through the active IM adapter.
	const im = new IMAdapterManager(engine, config, { reportService, inboundDir });
	// /restart command hook: relaunch the same binary with the same args.
	im.setOnRestart(() => {
		app.relaunch();
		app.exit(0);
	});
	// Persist IM send-path outcomes (card delivered / markdown fallback + reason)
	// to userData/logs/im.log — packaged builds have no visible console, and the
	// fallback reason is the #1 clue when IM formatting looks wrong.
	setDiagFile(path.join(userData, "logs", "im.log"));

	/** Truncated tail of a long text for progress pushes. */
	const tailForProgress = (text: string, n = 160) => {
		const t = text.replace(/\s+\n/g, "\n").trim();
		return t.length > n ? t.slice(-n) : t;
	};

	/**
	 * Autonomous chain runner (field 2026-09-30): one fire keeps working across
	 * turns in ONE conversation until the model reports done (marker), asks for
	 * a human, or the budget runs out — then a 「继续」 reply resumes with a
	 * fresh budget window. Chain state persists per turn so a crash or restart
	 * leaves a resumable record. See docs/research/autonomous-work.md.
	 */
	// Persistent failure log (field 2026-10-06: "报错的日志能不能拉一下" — nothing
	// was on disk). Console output is invisible in a packaged app; scheduler
	// failures, stall retries and escalations go to the standard logs dir.
	const LOG_FILE = path.join(app.getPath("logs"), "pi-virtual-employee.log");
	const appendAppLog = (message: string) => {
		try {
			mkdirSync(app.getPath("logs"), { recursive: true });
			// 5MB rotation: one .old generation, no unbounded growth.
			try {
				const stats = statSync(LOG_FILE);
				if (stats.size > 5 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.old`);
			} catch {
				/* first write — nothing to rotate */
			}
			appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
		} catch {
			/* logging must never break the run */
		}
	};
	const runAutonomousTask = async (task: ScheduledTaskRow): Promise<{ status: string }> => {
		const budget = normalizeBudget(task.max_turns, task.max_minutes);
		const prior = parseChainState(task.chain_state);
		// Resume reuses the SAME conversation but resets the budget window; a
		// fresh chain gets a unique conversation (no bleed between chains).
		const chain: AutonomousChainState = prior
			? { ...prior, turns: 0, startedAt: Date.now(), pending: undefined, stallCount: 0 }
			: { convId: `sched:${task.id}:${Date.now()}`, turns: 0, startedAt: Date.now() };
		// A staged reply (resume after a human question) is consumed on turn 0 and
		// then dropped from the persisted state.
		const stagedAnswer = prior?.answer;
		history.ensureConversation(chain.convId, `⏰ ${task.title}`);
		const agent = engine.getOrCreateSession(chain.convId);
		const pushActivity = (cid: string) => {
			const wc = mainWindow?.webContents;
			if (wc && !wc.isDestroyed()) wc.send("im:activity", cid);
		};

		// In-turn heartbeat (same shape as the IM manager's): every
		// longTaskProgressMin while a turn is streaming, push a progress note.
		const progressMin = config.all().general.longTaskProgressMin;
		let progressInFlight = false;
		const heartbeat = progressMin > 0 && task.conversation_id
			? setInterval(() => {
				if (progressInFlight || !agent.state.isStreaming) return;
				progressInFlight = true;
				void engine.progressBrief(agent, chain.convId)
					.then((note) => {
						const hb = note.startsWith("⏳") ? note : `⏳ ${note}`;
						if (agent.state.isStreaming && shouldPushScheduledResult(task, undefined, hb)) {
							const cid = task.conversation_id!;
							void im.pushToConversation(cid, hb);
						}
					})
					.catch(() => {})
					.finally(() => {
						progressInFlight = false;
					});
			}, progressMin * 60_000)
			: undefined;

		const reportRun = reportService.startRun({
			source: "scheduled_task",
			sourceRef: task.id,
			title: task.title,
			trigger: prior?.pending ? "resume" : "cron",
			inputRef: task.prompt,
		});

		const persistChain = () => scheduledTaskStore.setChainState(task.id, JSON.stringify(chain));
		const kbLookupOn = config.all().kb.enabled;
		let lastText = "";
		let outcome: "done" | "human" | "budget" | "stalled" | "error" = "error";
		let question: string | undefined;
		try {
			// True right after a silent stall-retry: the full prompt is already in
			// history — resume with a short "继续。" instead of injecting it again.
			let stallResumed = false;
			for (;;) {
				const prefix = buildAutonomousTurnPrefix({
					turn: chain.turns, budget,
					kbEnabled: config.all().kb.enabled,
					kbLearn: config.all().kb.enabled && config.all().kb.learn.enabled,
				});
				const answerBlock = chain.turns === 0 && stagedAnswer ? `用户对你上一轮问题的回复：${stagedAnswer}\n\n` : "";
				// Resuming a pending chain: force a KB lookup BEFORE retrying — the
				// stuck-learn round (below) recorded what was already tried; repeated
				// blockers must not replay the same dead end (field 2026-10-06).
				const resumeKbHint = prior?.pending && chain.turns === 0 && !stallResumed && kbLookupOn
					? "\n\n恢复前先 kb_search 本次卡点相关经验；已有解法直接应用，不要重复无效尝试。"
					: "";
				// The real-time stamp rides EVERY turn, not just turn 0: chains run
				// for days, and a continuation turn after midnight (or a stall
				// resume, which used to skip the stamp entirely) otherwise leaves
				// the model anchoring "today" on history dates (field 2026-10-09).
				const message = scheduledTimePrefix() + (chain.turns === 0 && !stallResumed ? prefix + answerBlock + task.prompt + resumeKbHint : prefix + "继续。");
				const send = await engine.send(agent, message, {
					// Same creator-identity re-attachment as single-turn runs: guarded
					// tools authorize against the LIVE role on every turn.
					...(task.created_by
						? { actor: { senderId: task.created_by, channel: "scheduler" as const, chatType: "single" as const } }
						: {}),
					onPersist: () => {
						pushActivity(chain.convId);
						if (task.conversation_id) pushActivity(task.conversation_id);
					},
				});
				chain.turns += 1;
				lastText = send.reply ?? "";
				const decision = parseChainReply(lastText);
				if (decision.remember?.length && config.all().kb.enabled && config.all().kb.learn.enabled) {
					// [[REMEMBER: …]] — the model found the path after exploration.
					// Sediment immediately (compaction would wipe it); never stop the chain.
					try {
						for (const note of decision.remember) {
							const saved = knowledge.saveLearned({
								title: `经验：${task.title}`,
								content: note,
								tags: "auto,探索发现",
							});
							// No note text in the log — these entries are exactly the
							// credential-prone kind (#41 masking standard).
							appendAppLog(`[sched] chain ${task.id} remember saved (id=${saved.id}, merged=${saved.merged}, len=${note.length})`);
							const conNote = `📌 已沉淀经验到知识库：${note.slice(0, 120)}`;
							if (shouldPushScheduledResult(task, undefined, conNote)) {
								const cid = task.conversation_id!;
								void im.pushToConversation(cid, conNote);
							}
						}
					} catch (learnErr) {
						appendAppLog(`[sched] chain ${task.id} remember save failed: ${learnErr instanceof Error ? learnErr.message.slice(0, 120) : String(learnErr)}`);
					}
				}
				if (send.error) {
					outcome = "error";
					lastText = send.error;
					scheduledTaskStore.setChainState(task.id, null); // hard error — chain over
					break;
				}
				if (send.deterministic) {
					// Model service stall (no content after the engine's in-turn
					// retries). Field 2026-10-06 policy: an occasional stall that a
					// retry absorbs must not ping the human — stay SILENT, back off,
					// retry the same turn (the failed attempt doesn't consume a turn).
					// Only persistent stalls escalate to paused-and-notify.
					chain.stallCount = (chain.stallCount ?? 0) + 1;
					const step = nextStallStep(chain.stallCount);
					if (step.action === "retry") {
						stallResumed = true;
						persistChain();
						console.warn(`[sched] task ${task.id} turn ${chain.turns} stalled (attempt ${chain.stallCount}/${STALL_QUIET_RETRIES + 1}); silent retry in ${Math.round(step.backoffMs / 1000)}s`);
						appendAppLog(`[sched] task ${task.id} (${task.title}) turn ${chain.turns} model stall attempt ${chain.stallCount}; silent retry in ${Math.round(step.backoffMs / 1000)}s`);
						await new Promise((resolve) => setTimeout(resolve, step.backoffMs));
						chain.turns -= 1; // the failed attempt must not consume budget turns
						continue;
					}
					// Escalate: the task is genuinely interrupted.
					outcome = "stalled";
					chain.pending = "stalled";
					chain.question = "模型服务连续未返回内容，任务已中断暂停";
					persistChain();
					break;
				}
				if (decision.kind === "human") {
					outcome = "human";
					question = decision.question || decision.text;
					chain.pending = "human";
					chain.question = question;
					persistChain();
					break;
				}
				if (decision.kind === "done") {
					outcome = "done";
					lastText = decision.text;
					scheduledTaskStore.setChainState(task.id, null); // chain complete — no stale state
					break;
				}
				if (budgetExceeded(chain, budget)) {
					outcome = "budget";
					chain.pending = "budget";
					persistChain();
					break;
				}
				// Still working: persist progress, then push a turn-boundary note so
				// the target chat sees the chain is alive without reading the console.
				chain.stallCount = 0; // a successful turn clears the stall streak
				persistChain();
				const tbNote = `⏳ **${task.title}** 第 ${chain.turns}/${budget.maxTurns} 轮完成，继续推进…
${tailForProgress(decision.text)}`;
				if (shouldPushScheduledResult(task, undefined, tbNote)) {
					const cid = task.conversation_id!;
					await im.pushToConversation(cid, tbNote);
				}
			}
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			// Scheduled chains are fire-and-forget: close the chain conversation's
			// browser page so a paused chain doesn't leak its tab.
			await browser.releasePage(chain.convId).catch(() => {});
		}

		reportService.completeRun(reportRun.runId, {
			// stalled is a PAUSE (resumable), not a completion failure — same
			// reporting as human/budget pauses; the returned status carries the
			// "paused:模型无返回" signal for the scheduler's last_status.
			status: outcome === "error" ? "error" : "ok",
			content: lastText || "",
			error: outcome === "error" ? lastText || null : null,
		});

		// No reply content here: model replies may echo credentials the protocol
		// taught it to look up — logs carry lengths, not text (#41 masking standard).
		appendAppLog(`[sched] autonomous task ${task.id} (${task.title}) outcome=${outcome} turns=${chain.turns} stallCount=${chain.stallCount ?? 0} replyLen=${lastText.length}${outcome === "error" ? ` error=${lastText.slice(0, 120).replace(/\s+/g, " ")}` : ""}`);
		// Auto-sediment (field 2026-10-06: "已经处理过一次的事情为什么还会不知道" —
		// the KB was empty because sedimentation was suggestion-level and the model
		// skipped it). After a done outcome, run one dedicated turn that REQUIRES
		// the KB write-back; silent and best-effort — must never break the run.
		const kbLearnOn = config.all().kb.enabled && config.all().kb.learn.enabled;
		if (kbLearnOn && (outcome === "done" || outcome === "stalled" || outcome === "human" || outcome === "budget" || outcome === "error")) {
			try {
				const learnPrefix = buildAutonomousTurnPrefix({
					turn: chain.turns, budget,
					kbEnabled: true, kbLearn: true,
				});
				// ephemeral: the learn Q/A must NOT enter the chain conversation
				// history — otherwise a human-resume's "上一轮问题的回复" pairs
				// against the learn turn instead of the actual question.
				const learnSend = await engine.send(agent, learnPrefix + buildLearnTurnAsk(outcome, task.title), {
					ephemeral: true,
					...(task.created_by ? { actor: { senderId: task.created_by, channel: "scheduler" as const, chatType: "single" as const } } : {}),
				});
				// engine.send resolves (not throws) on model-service stalls — a failed
				// learn turn must not be reported as success.
				if (learnSend.deterministic || learnSend.error) {
					appendAppLog(`[sched] chain ${task.id} auto-learn turn failed (deterministic=${!!learnSend.deterministic}, error=${learnSend.error?.slice(0, 80) ?? "none"}); skipped`);
				} else {
					appendAppLog(`[sched] chain ${task.id} (${task.title}) outcome=${outcome}; auto-learn turn ok`);
				const alNote = outcome === "error"
					? "📌 已把本次的卡点沉淀到知识库（卡在哪、已尝试什么、下次建议）。"
					: "📌 已把本次的卡点沉淀到知识库（卡在哪、已尝试什么、下次建议），恢复后会先查经验再继续。";
				const alText = outcome === "done"
					? "📌 已把本次任务的经验沉淀到知识库，下次同类任务直接复用。"
					: alNote;
				if (shouldPushScheduledResult(task, undefined, alText)) {
					const cid = task.conversation_id!;
					await im.pushToConversation(cid, alText);
				}
				}
			} catch (err) {
				appendAppLog(`[sched] chain ${task.id} auto-learn failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
			}
		}

		// Deliver the outcome to the target chat (markers stripped by the parser).
		if (task.conversation_id) {
			const resumeHint = `\n\n回复「继续 ${task.title}」重置预算继续；不回复则保持暂停。`;
			const stalledHint = `\n\n通常是模型服务或中转临时不可用，不是任务内容的问题。排查并处理后任务可从断点原地继续：\n① 检查模型服务状态，或在 设置 → 自定义模型 顶部把其他模型「设为默认」并保存；\n② 恢复任务（resume_scheduled_task 或回复「继续 ${task.title}」）；\n③ 恢复成功后会先检索知识库里的卡点记录再继续（本次卡点已自动沉淀）。`;
			const pushText =
				outcome === "done"
					? `✅ **自主任务完成：${task.title}**（共 ${chain.turns} 轮）\n\n${lastText}`
					: outcome === "human"
						? `⏸️ **自主任务暂停（需要人工）:${task.title}**\n\n${question ?? lastText}\n\n回复「继续 ${task.title}」并附上答案，我会带着你的回复继续。`
						: outcome === "budget"
							? `⏸️ **自主任务已达预算：${task.title}**（${chain.turns}/${budget.maxTurns} 轮）\n\n${tailForProgress(lastText, 400)}${resumeHint}`
							: outcome === "stalled"
								? `⏸️ **自主任务已中断暂停：${task.title}**（模型服务连续 ${STALL_QUIET_RETRIES + 1} 次未返回内容，任务在第 ${chain.turns} 轮中断，不会自动继续）${stalledHint}`
								: `⚠️ **自主任务出错停止：${task.title}**\n\n${lastText}`;
		// Silent autonomous runs suppress the SUCCESS (done) notice only — every
		// other outcome (human/budget/stalled/error) needs attention and still
		// pushes. shouldPushScheduledResult's "error" param is the attention
		// signal here: a non-done outcome counts as requiring human notice.
		const attention = outcome !== "done" ? outcome : undefined;
		if (shouldPushScheduledResult(task, attention, pushText)) {
			const cid = task.conversation_id!;
			const pushed = await im.pushToConversation(cid, pushText);
			if (!pushed.ok) console.warn(`[sched] autonomous push failed for ${cid}: ${pushed.error}`);
		}
		}

		const status =
			outcome === "done" ? "done" :
			outcome === "human" ? "paused:等待人工回复" :
			outcome === "budget" ? `paused:预算耗尽（${chain.turns} 轮）` :
			outcome === "stalled" ? `paused:模型无返回，等待处理（${chain.turns} 轮）` :
			"error:" + lastText.slice(0, 180);
		return { status };
	};

	/**
	 * Work-item window runner (autonomous work phase 2): one window of focused
	 * work on a work item, in its permanent `work:<id>` conversation. Outcomes:
	 * done (→ knowledge write-back), human (→ wait for a reply), self-scheduled
	 * (the model declares its own next check time). Frequency is the model's
	 * judgement — the tick only wakes items at their declared time.
	 */
	const workService = new WorkService({
		store: workItemStore,
		isAdmin: (senderId) => {
			const security = config.all().security;
			// A permissive defaultRole must not resurrect a removed confirmer.
			const declared = security.adminStaffIds.includes(senderId) || security.people?.some((p) => p.staffId === senderId && p.role === "admin");
			return !!declared && resolveRole(config, senderId) === "admin";
		},
		open: (item, convId) => {
			history.ensureConversation(convId, `🧭 ${item.title}`);
			return engine.getOrCreateSession(convId);
		},
		send: (agent, message, senderId) => engine.send(agent, message, {
			actor: { senderId, channel: "scheduler", chatType: "single" },
			onPersist: (cid) => {
				const wc = mainWindow?.webContents;
				if (wc && !wc.isDestroyed()) wc.send("im:activity", cid);
			},
		}),
		release: (convId) => browser.releasePage(convId),
		push: (cid, text) => im.pushToConversation(cid, text),
		lastInboundAt: (cid, sinceTs) => history.lastInboundAt(cid, sinceTs),
		canLearn: () => {
			const kb = config.all().kb;
			return kb.enabled && kb.learn.enabled;
		},
		kbFeatures: () => {
			const kb = config.all().kb;
			return { search: kb.enabled, learn: kb.enabled && kb.learn.enabled };
		},
		learn: (item, result) => {
			const input = buildWorkLearning(item, result);
			if (input) knowledge.saveLearned(input);
		},
		onError: (err) => console.warn(`[work] lifecycle operation failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`),
	});
	const fireWorkItem = (id: string): boolean => workService.fireItem(id);
	let workMiningTimer: ReturnType<typeof setInterval> | undefined;
	const stopWork = (): Promise<void> => {
		if (workMiningTimer) clearInterval(workMiningTimer);
		workMiningTimer = undefined;
		return workService.stop();
	};
	app.on("before-quit", () => { void stopWork(); });

	scheduler.setRunner({
		async runTask(task) {
			if (task.autonomous) return runAutonomousTask(task);
			// Execute in an isolated background conversation, NOT the originating IM
			// chat. Reusing the IM conversation's Agent would collide with a live IM
			// turn on the same chat ("Agent is already processing a prompt") — the
			// IM conversation is only the push-back target, never the exec agent.
			// Each run gets a unique id (task id + fire timestamp): no history bleed
			// between runs, runs never share an agent.
			const execConvId = `sched:${task.id}:${Date.now()}`;
			// Give the sidebar entry the task title instead of a prompt-derived title
			// (engine.send keeps an existing title when re-ensuring the conversation).
			history.ensureConversation(execConvId, `⏰ ${task.title}`);
			const agent = engine.getOrCreateSession(execConvId);
			// Push a per-message live-refresh for BOTH the exec conversation (sidebar
			// entry) and the originating IM conversation (its open pane), then a final
			// turn-complete signal once the reply is persisted.
			const pushActivity = (conversationId: string) => {
				const wc = mainWindow?.webContents;
				if (wc && !wc.isDestroyed()) wc.send("im:activity", conversationId);
			};
			// Report center: open a run before the LLM turn so it records the real
			// duration, then close it + publish the body to Gitee for a shareable link.
			const reportRun = reportService.startRun({
				source: "scheduled_task",
				sourceRef: task.id,
				title: task.title,
				trigger: "cron",
				inputRef: task.prompt,
			});
			let sendResult: Awaited<ReturnType<typeof engine.send>>;
			try {
				sendResult = await engine.send(agent, scheduledTimePrefix() + task.prompt, {
					// Re-attach the task creator's identity for guarded tools
					// (run_command). Captured at creation in a verified 1:1 admin
					// chat; requireAdminForCommand re-checks the live whitelist on
					// every fire, so a removed admin's tasks lose command access
					// immediately. Only run_command honors scheduler actors — the
					// other admin tools keep refusing non-IM conversations.
					...(task.created_by
						? { actor: { senderId: task.created_by, channel: "scheduler", chatType: "single" as const } }
						: {}),
					onPersist: () => {
						pushActivity(execConvId);
						if (task.conversation_id) pushActivity(task.conversation_id);
					},
				});
			} finally {
				// Scheduled runs are fire-and-forget: each run uses a unique
				// conversation id, so its browser page can never be reused. Close it
				// to avoid leaking a Page (and its tab) per fire.
				await browser.releasePage(execConvId);
			}
			const { reply, error } = sendResult;
			pushActivity(execConvId);
			if (task.conversation_id) pushActivity(task.conversation_id);
			reportService.completeRun(reportRun.runId, {
				status: error ? "error" : "ok",
				content: reply || "",
				error: error ?? null,
			});
			let reportUrl: string | null = null;
			// Skip the scheduler's own publish when the reply already cites a
			// report link (save_report ran mid-task and 小派 embedded its URL).
			// Re-publishing would mint a SECOND artifact+URL → two links in one
			// push (field 2026-09-21). The reply's own link is the one to deliver.
			if (reply && !replyHasReportLink(reply)) {
				const pub = await reportService.publish(reportRun.runId, task.title, reply);
				reportUrl = pub?.url ?? null;
			}
			// Push the FULL result back to the originating IM chat — the manager
			// chunks anything past the platform's per-message cap into ordered
			// parts, so the report arrives whole. The link stays appended for the
			// rendered/original copy. Non-IM tasks skip push.
			// Silent runs (2026-10-09): the task executed and is recorded, but its
			// completion push is suppressed — maintenance tasks (e.g. a token
			// keep-alive firing every few hours) exist to run, not to notify, and
			// the ⏰ completion + report-link notice is product-level and cannot be
			// muted from the prompt. An ERROR still pushes (silence never hides a
			// failure); the decision lives in shouldPushScheduledResult.
			let pushError: string | undefined;
			const pushTarget = task.conversation_id;
			if (pushTarget && shouldPushScheduledResult(task, error, reply)) {
				const body = reportUrl ? `${reply}\n\n📎 查看报告：${reportUrl}` : reply;
				const pushText = `⏰ **定时任务完成：${task.title}**\n\n${body}`;
				const pushed = await im.pushToConversation(pushTarget, pushText);
				if (!pushed.ok) {
					pushError = pushed.error || "未知推送错误";
					console.warn(`[sched] push result failed for ${pushTarget}: ${pushError}`);
				}
			}
			appendAppLog(`[sched] task ${task.id} (${task.title}) ${error ? `error=${error.slice(0, 120).replace(/\s+/g, " ")}` : pushError ? `ok;push_error=${pushError}` : "ok"}`);
			if (error) return { status: "error:" + error.slice(0, 200) };
			return { status: pushError ? "ok;push_error:" + pushError.slice(0, 180) : "ok" };
		},
	});

	// Local HTTP+SSE transport — the renderer streams chat through localhost.
	const httpPort = Number(process.env.PORT) || 0;
	const { port, server: httpServer } = await startHttpTransport(engine, { port: httpPort });
	console.log(`[main] employee http transport on 127.0.0.1:${port}`);

	// Preload skills so the first session already has them.
	await engine.refreshSkills().catch((err) => console.error("[engine] skill load failed", err));

	// Reconcile IM adapter + autostart with saved config.
	applyAutostart(config.all().general.autostart);
	await im.sync().catch((err) => console.error("[im] sync failed", err));
	// Start ticking only after IM adapters have connected, so an overdue task fired
	// during startup can immediately push its result instead of missing the channel.
	scheduler.start();

	// Work-item bridge: the tools/engine fire windows and push proposals through
	// the IM adapters. Wiring lives here because `im` is created above.
	engine.workBridge = {
		fireItem: fireWorkItem,
		push: (cid, text) => im.pushToConversation(cid, text),
	};
	// Recovery + dispatch only after IM initialization and bridge installation.
	workService.start();

	// Background mining (autonomous work phase 2): off by default — admins opt
	// in via capabilities.autonomousMining. Checked hourly; fires per its
	// interval. On-demand mining (manage_work_items action=mine) is unaffected.
	let lastMiningRun = 0;
	workMiningTimer = setInterval(() => {
		const mining = config.all().capabilities.autonomousMining;
		if (!mining?.enabled) return;
		if (Date.now() - lastMiningRun < mining.intervalHours * 3_600_000) return;
		lastMiningRun = Date.now();
		void engine
			.mineRecentWork({ maxProposals: 2 })
			.then((r) => {
				if (r.error) console.warn("[work] background mining failed:", r.error);
			})
			.catch((err) => console.warn("[work] background mining failed:", (err as Error).message));
	}, 60 * 60_000);

	ipcMain.handle("server:port", () => port);
	const computerAction = async (event: Electron.IpcMainInvokeEvent, action: string) => {
		if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("桌面控制只能由本应用设置页管理。");
		if (action === "install") return computer.startInstall();
		if (action === "connect") await computer.connect();
		else if (action === "disconnect") await computer.disconnect();
		else if (action !== "status") throw new Error("未知桌面管理动作。");
		return computer.status();
	};
	ipcMain.handle("computer:manage", computerAction);
	ipcMain.handle("computer:pickDriver", async event => {
		if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("非法设置请求。");
		const result = await dialog.showOpenDialog(mainWindow, { title: "选择 Cua Driver 可执行文件", properties: ["openFile"] });
		return result.canceled ? null : result.filePaths[0] ?? null;
	});
	ipcMain.handle("config:get", () => config.all());
	ipcMain.handle("config:set", async (_e, patch) => {
		const updated = config.update(patch);
		await computer.syncConfig();
		applyAutostart(updated.general.autostart);
		await im.sync().catch((err) => console.error("[im] sync failed", err));
		engine.setRequestTimeoutMs((updated.general.requestTimeoutMin || 0) * 60_000);
		await engine.invalidate(); // prompt/skill/tool composition may have changed
		return updated;
	});

	ipcMain.handle("tasks:list", () => history.listConversations());
	ipcMain.handle("tasks:messages", (_e, id: string) => history.listMessages(id));
	ipcMain.handle("tasks:delete", (_e, id: string) => {
		engine.dropSession(id);
		history.deleteConversation(id);
		return true;
	});

	ipcMain.handle("autostart:get", () => app.getLoginItemSettings().openAtLogin);
	ipcMain.handle("autostart:set", (_e, enabled: boolean) => {
		applyAutostart(enabled);
		config.update({ general: { autostart: enabled } });
		return app.getLoginItemSettings().openAtLogin;
	});

	// Auto-update: renderer pulls state on mount + receives live "update:event"
	// pushes; check/download/install are user-initiated (see updater.ts gate).
	ipcMain.handle("update:getState", () => getUpdateState());
	ipcMain.handle("update:check", async () => checkNow());
	ipcMain.handle("update:download", async () => downloadNow());
	ipcMain.handle("update:install", () => {
		quitAndInstall();
		return true;
	});

	// `im:simulate` drives the echo test channel from the local console (a
	// trusted-admin surface). The optional `actor` is forwarded as a
	// platform-verified sender so the console can exercise the full RBAC/admin
	// pipeline — test-channel only, never a production IM path.
	ipcMain.handle("im:simulate", async (_e, conversationId: string, text: string, actor?: InboundActor) =>
		im.simulate(conversationId, text, actor),
	);
	ipcMain.handle("im:channels", () => availableChannels());

	ipcMain.handle("model:list", () => engine.availableModels());
	ipcMain.handle("model:test", async (_e, supplier: Supplier, modelId: string) => {
		const reply = await engine.testModelConnection(supplier, modelId);
		return { ok: true, reply };
	});
	// Effective image-input capability per model (override else base) — for the settings UI.
	ipcMain.handle("model:capabilities", (_e, supplier: Supplier) => {
		const out: Record<string, boolean> = {};
		for (const id of supplier.models) out[id] = engine.effectiveImageCapability(supplier.id, id);
		return out;
	});

	// ── Employee portability: export/import a whole employee (.pve package) ──
	ipcMain.handle("employee:export", async (_e, opts: ExportOptions = {}) => {
		const dialogOpts: Electron.SaveDialogOptions = {
			title: "导出虚拟员工",
			defaultPath: `employee-${activeProfile}.pve`,
			filters: [{ name: "虚拟员工包", extensions: ["pve"] }],
		};
		const result = mainWindow
			? await dialog.showSaveDialog(mainWindow, dialogOpts)
			: await dialog.showSaveDialog(dialogOpts);
		if (result.canceled || !result.filePath) return null;
		const buffer = await buildEmployeePackage(
			{ db, config, knowledge, skillsDir: userSkillsDir },
			{ ...opts, profileName: activeProfile, appVersion: app.getVersion() },
		);
		await writeFile(result.filePath, buffer);
		return { path: result.filePath, size: buffer.length, bytes: buffer.length };
	});
	ipcMain.handle("employee:import", async (_e, args: { mode: "new" | "overwrite"; profileName?: string }) => {
		const dialogOpts: Electron.OpenDialogOptions = {
			title: "导入虚拟员工",
			properties: ["openFile"],
			filters: [{ name: "虚拟员工包", extensions: ["pve"] }],
		};
		const pick = mainWindow
			? await dialog.showOpenDialog(mainWindow, dialogOpts)
			: await dialog.showOpenDialog(dialogOpts);
		if (pick.canceled || !pick.filePaths[0]) return { done: false, canceled: true };

		const buffer = await readFile(pick.filePaths[0]);

		if (args.mode === "new") {
			const name = (args.profileName ?? "").trim();
			if (!name || name === "default" || !/^[A-Za-z0-9_-]+$/.test(name)) {
				throw new Error("员工名无效（仅字母、数字、下划线、短横，且不能为 default）");
			}
			const dir = profileDir(name);
			await mkdir(dir, { recursive: true });
			await writeFile(pendingImportPath(dir), buffer);
			relaunchInto(name); // exits
			return { done: true, mode: "new", profileName: name };
		}

		// overwrite current employee
		const summary = await importEmployeePackage(
			buffer,
			{ db, config, knowledge, skillsDir: userSkillsDir },
			{ clearSkills: true },
		);
		await knowledge.reindex().catch((err) => console.warn("[main] post-import reindex failed:", err));
		// Restart so IM/scheduler/engine pick up the new config cleanly.
		setTimeout(() => {
			app.relaunch();
			app.exit(0);
		}, 400);
		return { done: true, mode: "overwrite", summary };
	});
	ipcMain.handle("model:import", async () => {
		const options: Electron.OpenDialogOptions = {
			title: "导入模型服务配置",
			properties: ["openFile"],
			filters: [{ name: "JSON", extensions: ["json"] }],
		};
		const result = mainWindow
			? await dialog.showOpenDialog(mainWindow, options)
			: await dialog.showOpenDialog(options);
		if (result.canceled || !result.filePaths[0]) return null;
		const parsed = JSON.parse(await readFile(result.filePaths[0], "utf8"));
		return normalizeModelConfig(parsed.model ?? parsed);
	});
	ipcMain.handle("model:export", async (_e, model: unknown) => {
		const normalized = normalizeModelConfig(model);
		const safe = {
			...normalized,
			suppliers: normalized.suppliers.map((supplier) => ({ ...supplier, apiKey: "" })),
		};
		const options: Electron.SaveDialogOptions = {
			title: "导出模型服务配置",
			defaultPath: "pi-model-providers.json",
			filters: [{ name: "JSON", extensions: ["json"] }],
		};
		const result = mainWindow
			? await dialog.showSaveDialog(mainWindow, options)
			: await dialog.showSaveDialog(options);
		if (result.canceled || !result.filePath) return false;
		await writeFile(result.filePath, JSON.stringify({ model: safe }, null, 2), "utf8");
		return true;
	});
	// Lightweight global-default switch: no invalidate (in-flight streams keep running).
	ipcMain.handle("model:setDefault", (_e, supplierId: string, modelId: string) => engine.setDefaultModel(supplierId, modelId));
	ipcMain.handle("model:setForConversation", (_e, conversationId: string, supplierId: string, modelId: string) => {
		// Empty both = "follow global default": clear the per-conversation pin.
		if (!supplierId && !modelId) {
			engine.clearConversationModel(conversationId);
		} else {
			engine.setConversationModel(conversationId, supplierId, modelId);
		}
		return true;
	});

	// ── Provider account login (auth.json-backed; tokens never leave the main process) ──
	// Login flow state is PUSHED to the renderer (AUTH_IPC.loginEvent carries the
	// full AuthLoginState snapshot, prompts included); the renderer answers via
	// AUTH_IPC.loginAnswer and aborts via AUTH_IPC.loginCancel. The bridge holds
	// no credentials — only display state.
	const authBridge: AuthLoginEventBridge = {
		onEvent: (state: AuthLoginState) => {
			const wc = mainWindow?.webContents;
			if (wc && !wc.isDestroyed()) wc.send(AUTH_IPC.loginEvent, state);
		},
	};
	onMainWindowClosed = () => engine.authLoginCancel();
	// Settings-page-only surface: reject events not originating from the main
	// window's top frame (same guard as computer:manage).
	const fromMainWindow = (event: Electron.IpcMainInvokeEvent): boolean =>
		!!mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
	const authFromSettings = (event: Electron.IpcMainInvokeEvent): void => {
		if (!fromMainWindow(event)) {
			throw new Error("账号登录只能由本应用设置页管理。");
		}
	};
	ipcMain.handle(AUTH_IPC.catalog, (e) => {
		authFromSettings(e);
		return engine.authCatalog();
	});
	ipcMain.handle(AUTH_IPC.login, (e, provider: string) => {
		authFromSettings(e);
		return engine.authLogin(provider, authBridge);
	});
	ipcMain.handle(AUTH_IPC.loginStatus, (e) => {
		authFromSettings(e);
		return engine.authLoginStatus();
	});
	ipcMain.handle(AUTH_IPC.loginAnswer, (e, promptId: string, value: string) => {
		authFromSettings(e);
		engine.authLoginAnswer(promptId, value);
		return true;
	});
	ipcMain.handle(AUTH_IPC.loginCancel, (e) => {
		authFromSettings(e);
		return engine.authLoginCancel();
	});
	ipcMain.handle(AUTH_IPC.logout, (e, provider: string) => {
		authFromSettings(e);
		return engine.authLogout(provider);
	});
	ipcMain.handle(AUTH_IPC.quota, (e, provider: string) => {
		authFromSettings(e);
		return engine.authQuota(provider);
	});
	//「打开授权页面」: https-only hand-off to the system browser (review H5) —
	// no in-app child window (setWindowOpenHandler denies), no other schemes.
	ipcMain.handle(AUTH_IPC.openExternal, (e, url: string) => {
		authFromSettings(e);
		let parsed: URL;
		try {
			parsed = new URL(String(url));
		} catch {
			throw new Error("无效的链接");
		}
		if (parsed.protocol !== "https:") throw new Error("仅允许打开 https 链接");
		return shell.openExternal(parsed.href);
	});

	// --- Prompt management (editable built-in rules + live preview) ---
	ipcMain.handle("prompt:preview", () => {
		const c = config.all();
		return buildSystemPrompt({
			name: c.identity.name,
			role: c.identity.role,
			duty: c.identity.duty,
			serviceHours: c.identity.serviceHours,
			kbEnabled: c.kb.enabled,
			learnEnabled: c.kb.learn.enabled,
			manageEnabled: c.kb.manage.enabled,
			researchEnabled: c.kb.research.enabled,
			browserEnabled: c.browser.enabled,
			schedulerEnabled: c.scheduler.enabled,
			documentsEnabled: c.documents.enabled,
			filesystemEnabled: c.filesystem.enabled,
			reportsEnabled: c.reports.enabled,
			downloadsEnabled: c.downloads.enabled,
			rules: c.prompt.rules,
			extra: c.prompt.extra,
		});
	});
	ipcMain.handle("prompt:defaults", () => {
		const c = config.all();
		return defaultCoreRules({
			kbEnabled: c.kb.enabled,
			learnEnabled: c.kb.learn.enabled,
			manageEnabled: c.kb.manage.enabled,
			researchEnabled: c.kb.research.enabled,
			browserEnabled: c.browser.enabled,
			schedulerEnabled: c.scheduler.enabled,
			documentsEnabled: c.documents.enabled,
			filesystemEnabled: c.filesystem.enabled,
			reportsEnabled: c.reports.enabled,
			downloadsEnabled: c.downloads.enabled,
		});
	});

	// --- Scheduled-task management (settings UI) ---
	ipcMain.handle("tasks:schedList", () => scheduler.list());
	// Autonomous tasks (settings UI): the store orders by updated_at DESC.
	// Projected to the view fields the renderer shows (review L1) — answer /
	// conditions / lessons stay on the main-process side.
	ipcMain.handle("tasks:workList", () => (engine.workItems?.list() ?? []).map(({ id, title, goal, status, progress, question, next_check_at, remind_count, created_by, created_at, updated_at }) =>
		({ id, title, goal, status, progress, question, next_check_at, remind_count, created_by, created_at, updated_at })));
	ipcMain.handle("tasks:schedDelete", (_e, id: string) => {
		scheduler.delete(id);
		return true;
	});
	ipcMain.handle("tasks:schedSilent", (_e, id: string, silent: boolean) => {
		scheduler.update(id, { silent });
		return true;
	});
	ipcMain.handle("tasks:schedToggle", (_e, id: string, enabled: boolean) => {
		scheduler.setEnabled(id, enabled);
		return true;
	});

	// --- Report / artifact center ---
	ipcMain.handle("reports:test", async () => reportService.testTarget());
	ipcMain.handle("reports:testGitee", async () => reportService.testGitee());
	ipcMain.handle("reports:testOss", async () => reportService.testOss());
	ipcMain.handle("reports:list", () => reportService.listArtifacts());
	ipcMain.handle("reports:get", (_e, id: string) => reportService.getArtifact(id) ?? null);
	ipcMain.handle("reports:runs", (_e, artifactId: string) => reportService.listRuns(artifactId));
	ipcMain.handle("reports:body", (_e, runId: string) => reportService.runBody(runId) ?? null);
	ipcMain.handle("reports:url", (_e, runId: string) => reportService.runUrl(runId));
	ipcMain.handle("reports:republish", async (_e, runId: string) => reportService.republish(runId));
	ipcMain.handle("reports:delete", (_e, id: string) => {
		reportService.deleteArtifact(id);
		return true;
	});

	// --- Knowledge base ---
	ipcMain.handle("kb:status", () => ({ fts: knowledge.isFtsEnabled(), chunks: knowledge.count() }));
	ipcMain.handle("kb:listEntries", (_e, includeArchived?: boolean) =>
		knowledge.listEntries(includeArchived ? { includeArchived: true } : {}));
	ipcMain.handle("kb:upsertEntry", (_e, entry: { id?: string; title: string; tags: string; content: string }) =>
		knowledge.upsertEntry(entry));
	ipcMain.handle("kb:deleteEntry", (_e, id: string) => {
		knowledge.deleteEntry(id);
		return true;
	});
	ipcMain.handle("kb:archiveEntry", (_e, id: string) => {
		knowledge.archiveEntry(id);
		return true;
	});
	ipcMain.handle("kb:restoreEntry", (_e, id: string) => {
		knowledge.restoreEntry(id);
		return true;
	});
	ipcMain.handle("kb:listDocs", () => knowledge.listDocs());
	ipcMain.handle("kb:deleteDoc", (_e, id: string) => {
		knowledge.deleteDoc(id);
		return true;
	});
	ipcMain.handle("kb:search", async (_e, query: string) => knowledge.search(query));
	ipcMain.handle("kb:vectorStatus", () => knowledge.vectorStatus());
	ipcMain.handle("kb:reindex", async () => knowledge.reindex());
	ipcMain.handle("kb:testEmbedding", async (_e, input: { baseUrl: string; apiKey: string; model: string }) =>
		knowledge.testEmbedding(input),
	);
	ipcMain.handle("kb:testExternal", async (_e, cfg: ExternalProviderConfig) =>
		knowledge.testExternal(cfg),
	);
	ipcMain.handle("kb:externalDatasets", (_e, cfg: ExternalProviderConfig) =>
		knowledge.listExternalDatasets(cfg),
	);
	ipcMain.handle("kb:consolidate", async () => knowledge.consolidate());
	ipcMain.handle("kb:researchGaps", async () => knowledge.researchGaps());
	ipcMain.handle("kb:learnStatus", () => knowledge.learnStatus());
	ipcMain.handle("kb:listGaps", (_e, limit?: number) => knowledge.listGaps(limit));
	ipcMain.handle("kb:resolveGap", (_e, query: string) => {
		knowledge.resolveGap(query);
		return true;
	});
	ipcMain.handle("kb:approveEntry", (_e, id: string) => {
		knowledge.approveEntry(id);
		return true;
	});
	ipcMain.handle("kb:import", async () => {
		const open = mainWindow
			? await dialog.showOpenDialog(mainWindow, {
					title: "导入知识库文档",
					properties: ["openFile", "multiSelections"],
					filters: [{ name: "文档", extensions: ["txt", "md", "markdown", "pdf", "docx", "xlsx", "xls", "html", "htm"] }],
				})
			: await dialog.showOpenDialog({
					title: "导入知识库文档",
					properties: ["openFile", "multiSelections"],
					filters: [{ name: "文档", extensions: ["txt", "md", "markdown", "pdf", "docx", "xlsx", "xls", "html", "htm"] }],
				});
		if (open.canceled || !open.filePaths.length) return { imported: 0, errors: [] as string[] };
		const errors: string[] = [];
		let imported = 0;
		for (const file of open.filePaths) {
			try {
				const name = path.basename(file);
				const chunks = await knowledge.importDocument(file, name);
				imported += chunks;
			} catch (err) {
				errors.push(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		await engine.invalidate();
		return { imported, errors };
	});

	// --- Document resources (catalog of deliverable docs for integration partners) ---
	ipcMain.handle("documents:list", () => documents.list());
	ipcMain.handle("documents:add", async (_e, input) => {
		const r = documents.add(input);
		await engine.invalidate();
		return r;
	});
	ipcMain.handle("documents:update", async (_e, id: string, patch) => {
		const r = documents.update(id, patch);
		await engine.invalidate();
		return r ?? null;
	});
	ipcMain.handle("documents:delete", async (_e, id: string) => {
		documents.delete(id);
		await engine.invalidate();
		return true;
	});
	ipcMain.handle("documents:dir", () => documents.dir());

	// Native folder picker for the filesystem allowed-dirs whitelist (renderer).
	ipcMain.handle("filesystem:pickDir", async () => {
		const opts: import("electron").OpenDialogOptions = {
			title: "选择允许访问的目录",
			properties: ["openDirectory"],
		};
		const open = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
		return open.canceled || !open.filePaths.length ? null : open.filePaths[0];
	});
	// Upload file(s) → copy into the documents dir → create kind=file resources.
	// `meta` carries the shared metadata (name applies only when a single file is picked).
	ipcMain.handle("documents:upload", async (_e, meta?: { name?: string; partners?: string[]; scenario?: string; description?: string; tags?: string[] }) => {
		const opts: import("electron").OpenDialogOptions = {
			title: "上传文档资源",
			properties: ["openFile", "multiSelections"],
			filters: [{ name: "文档", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "md", "txt", "png", "jpg", "jpeg", "zip"] }],
		};
		const open = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
		if (open.canceled || !open.filePaths.length) return { created: 0, ids: [] as string[] };
		await mkdir(documents.dir(), { recursive: true }).catch(() => {});
		const ids: string[] = [];
		for (const file of open.filePaths) {
			const base = path.basename(file);
			let dest = path.join(documents.dir(), base);
			if (existsSync(dest)) {
				const ext = path.extname(base);
				const stem = base.slice(0, base.length - ext.length);
				dest = path.join(documents.dir(), `${stem}-${Date.now()}${ext}`);
			}
			await copyFile(file, dest);
			const r = documents.add({
				name: open.filePaths.length === 1 && meta?.name?.trim() ? meta.name.trim() : base,
				kind: "file",
				filePath: dest,
				partners: meta?.partners,
				scenario: meta?.scenario,
				description: meta?.description,
				tags: meta?.tags,
			});
			ids.push(r.id);
		}
		await engine.invalidate();
		return { created: ids.length, ids };
	});

	ipcMain.handle("kb:externalList", (_e, providerId: string) =>
		knowledge.listExternalDocuments(providerId),
	);
	ipcMain.handle("kb:externalParse", (_e, providerId: string, documentId?: string) =>
		knowledge.parseExternal(providerId, documentId),
	);
	ipcMain.handle("kb:externalUpload", async (_e, providerId: string) => {
		const open = mainWindow
			? await dialog.showOpenDialog(mainWindow, {
					title: "上传文档到外接知识库",
					properties: ["openFile"],
				})
			: await dialog.showOpenDialog({
					title: "上传文档到外接知识库",
					properties: ["openFile"],
				});
		if (open.canceled || !open.filePaths.length) {
			return { ok: false, documentIds: [] as string[], parsed: false, canceled: true };
		}
		const file = open.filePaths[0];
		return knowledge.uploadToExternal(providerId, file, path.basename(file));
	});

	// --- Skills ---
	ipcMain.handle("skills:list", async () => {
		const { info } = await engine.listSkills();
		return info; // already carries enabled (false ⇒ in config.skills.disabled)
	});
	ipcMain.handle("skills:refresh", async () => {
		await engine.invalidate();
		return true;
	});
	ipcMain.handle("skills:setEnabled", async (_e, name: string, enabled: boolean) => {
		const cur = new Set(config.all().skills?.disabled ?? []);
		if (enabled) cur.delete(name);
		else cur.add(name);
		config.update({ skills: { disabled: [...cur] } });
		await engine.invalidate();
		return true;
	});
	ipcMain.handle("skills:import", async () => {
		const open = mainWindow
			? await dialog.showOpenDialog(mainWindow, {
					title: "导入 Skill（SKILL.md / 目录 / zip）",
					properties: ["openFile", "openDirectory", "multiSelections"],
					filters: [
						{ name: "Skill", extensions: ["md", "zip"] },
						{ name: "Markdown", extensions: ["md"] },
						{ name: "Zip", extensions: ["zip"] },
					],
				})
			: await dialog.showOpenDialog({
					title: "导入 Skill（SKILL.md / 目录 / zip）",
					properties: ["openFile", "openDirectory", "multiSelections"],
					filters: [
						{ name: "Skill", extensions: ["md", "zip"] },
						{ name: "Markdown", extensions: ["md"] },
						{ name: "Zip", extensions: ["zip"] },
					],
				});
		if (open.canceled || !open.filePaths.length) return { imported: 0, skipped: 0, errors: [] as string[] };
		const errors: string[] = [];
		let imported = 0;
		let skipped = 0;
		let canceledAll = false;
		// Ask once per conflicting skill: overwrite / skip this one / cancel the
		// remaining imports. "取消" aborts the whole loop so no further prompts appear.
		const confirmOverwrite = async (name: string): Promise<"overwrite" | "skip" | "cancel"> => {
			const opts: Electron.MessageBoxOptions = {
				type: "question",
				title: "技能已存在",
				message: `已存在同名技能「${name}」，是否覆盖？`,
				detail: "覆盖将删除原有技能的全部文件。",
				buttons: ["覆盖", "跳过", "取消剩余导入"],
				defaultId: 0,
				cancelId: 2,
				noLink: true,
			};
			const { response } = mainWindow
				? await dialog.showMessageBox(mainWindow, opts)
				: await dialog.showMessageBox(opts);
			if (response === 0) return "overwrite";
			if (response === 1) return "skip";
			return "cancel";
		};
		await mkdir(userSkillsDir, { recursive: true }).catch(() => {});
		for (const selected of open.filePaths) {
			if (canceledAll) break;
			try {
				const stat = await import("node:fs/promises").then((fs) => fs.stat(selected));
				if (stat.isDirectory()) {
					// Copy the whole skill directory, then validate it contains SKILL.md
					// before counting as imported — otherwise it silently disappears from
					// the skill list (the loader only finds SKILL.md / root .md).
					const name = path.basename(selected);
					const dest = path.join(userSkillsDir, name);
					if (!existsSync(path.join(selected, "SKILL.md"))) {
						errors.push(`${name}: 目录内缺少 SKILL.md，已跳过`);
						continue;
					}
					if (existsSync(dest)) {
						const choice = await confirmOverwrite(name);
						if (choice === "cancel") {
							canceledAll = true;
							continue;
						}
						if (choice === "skip") {
							skipped++;
							continue;
						}
					}
					await rm(dest, { recursive: true, force: true });
					await mkdir(dest, { recursive: true });
					await copyTree(selected, dest);
					imported++;
				} else if (selected.toLowerCase().endsWith(".zip")) {
					const result = await importSkillZip(selected, userSkillsDir, confirmOverwrite);
					if (result.ok) {
						if (result.canceled) canceledAll = true;
						else if (result.skipped) skipped++;
						else imported++;
					} else errors.push(`${path.basename(selected)}: ${result.error}`);
				} else if (selected.toLowerCase().endsWith(".md")) {
					const name = path.basename(selected);
					const dest = path.join(userSkillsDir, name);
					if (existsSync(dest)) {
						const choice = await confirmOverwrite(name);
						if (choice === "cancel") {
							canceledAll = true;
							continue;
						}
						if (choice === "skip") {
							skipped++;
							continue;
						}
					}
					await copyFile(selected, dest);
					imported++;
				} else {
					errors.push(`${path.basename(selected)}: 仅支持 .md 文件、含 SKILL.md 的目录或 zip`);
				}
			} catch (err) {
				errors.push(`${path.basename(selected)}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		await engine.invalidate();
		return { imported, skipped, errors };
	});
	ipcMain.handle("skills:delete", async (_e, filePath: string) => {
		// Containment check via canonical paths — a string prefix check could be
		// fooled by a sibling dir sharing the userSkillsDir prefix.
		const resolved = path.resolve(filePath);
		const userDir = path.resolve(userSkillsDir);
		if (resolved !== userDir && !resolved.startsWith(userDir + path.sep)) return false;
		await rm(filePath, { force: true }).catch(() => {});
		const dir = path.dirname(filePath);
		const dirResolved = path.resolve(dir);
		if (dirResolved.startsWith(userDir + path.sep) && dirResolved !== userDir) {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
		await engine.invalidate();
		return true;
	});

	// Periodic knowledge consolidation (auto-learn memory). Re-reads config each tick
	// so enabling/disabling or changing the interval takes effect without a restart.
	let consolidateTimer: ReturnType<typeof setInterval> | null = null;
	const tickConsolidation = () => {
		try {
			const status = knowledge.learnStatus();
			const intervalMs = Math.max(1, status.intervalMinutes) * 60_000;

			// Periodic memory consolidation (merge / archive / generalize).
			if (status.learnEnabled && status.consolidateEnabled && Date.now() - status.consolidatedAt >= intervalMs) {
				knowledge
					.consolidate()
					.catch((err) =>
						console.warn("[knowledge] scheduled consolidate failed:", (err as Error).message),
					);
			}

			// Gap-driven auto-research: distill recurring KB misses into pending
			// entries. Throttled on the same cadence; runs independently of
			// consolidation so it works even when consolidation is off.
			if (status.researchEnabled && status.gapCount > 0 && Date.now() - status.researchedAt >= intervalMs) {
				knowledge
					.researchGaps()
					.catch((err) =>
						console.warn("[knowledge] scheduled research failed:", (err as Error).message),
					);
			}
		} catch (err) {
			console.warn("[knowledge] consolidate tick failed:", (err as Error).message);
		}
	};
	consolidateTimer = setInterval(tickConsolidation, 60_000);
	app.on("will-quit", () => {
		if (consolidateTimer) clearInterval(consolidateTimer);
		disposeShellCommands(config);
		scheduler.stop();
		stopUpdater();
		// Ordinary quits are best-effort. The update path awaits browser/IM/HTTP
		// cleanup explicitly in prepareToInstall BEFORE electron-updater spawns NSIS.
		void browser.close();
		void computer.close();
	});

	createWindow();
	// Auto-updater hooks the main window so state changes can be pushed to the
	// renderer. No-op in dev / macOS (packaged Windows-only); setState still
	// pushes an "idle" so the UI shows the current version without update buttons.
	if (mainWindow) setupAutoUpdater(mainWindow);
	// Unattended auto-update wiring: re-read config + engine idle on each use
	// so toggling the setting takes effect without a restart. Legacy tri-state:
	// boolean true / "full" → full unattended; "download_only" → check+download
	// but park at ready (install only on explicit admin request); false / "off".
	const updateMode = () => {
		const v = config.all().general.autoUpdate;
		return v === "download_only" ? "download_only" : v === true || v === "full" ? "full" : "off";
	};
	const firstAdminId = () => config.all().security.adminStaffIds[0];
	setupUnattended({
		enabled: () => updateMode() !== "off",
		installBlocked: () => updateMode() === "download_only",
		notifyReady: (version, manualUrl) => {
			// IM admins, not the console: this fires on headless servers where the
			// UI is never opened. Push once per download to the first admin's 1:1.
			const admin = firstAdminId();
			if (!admin) return;
			void im.pushToConversation(
				`dt:${admin}`,
				`🔔 新版本 v${version} 已下载完成。本机为「仅下载」更新模式，不会自动安装——请回复「确认更新到最新版」安装，或手动下载：${manualUrl}`,
			).catch(() => {});
		},
		isIdle: () => engine.isIdle(),
		beginDrain: () => im.setDraining(true),
		endDrain: () => im.setDraining(false),
		prepareToInstall: async () => {
			// electron-updater spawns NSIS before app.quit(). Release every process /
			// listener that can keep the old app tree alive before calling it.
			await stopWork();
			scheduler.stop();
			disposeShellCommands(config);
			await im.stopAll();
			await browser.close();
			await computer.close();
			await new Promise<void>((resolve) => {
				if (!httpServer.listening) return resolve();
				httpServer.close(() => resolve());
				// Node ≥18: close keep-alive connections so close() cannot hang.
				httpServer.closeAllConnections?.();
			});
			// Close the SQLite handle LAST so the better-sqlite3 .node addon is
			// unmapped from the process before NSIS overwrites resources/native.
			// An open handle keeps the DB + WAL locked (stalls the installer) and
			// keeps the addon mapped (a mid-overwrite require is the file-race that
			// surfaces as spurious "NODE_MODULE_VERSION" ABI errors).
			closeDatabase(db);
		},
	});
	// Push IM activity to the renderer so the task list refreshes live (the
	// renderer otherwise never learns about asynchronously-stored IM messages).
	im.setOnActivity((conversationId: string) => {
		const wc = mainWindow?.webContents;
		if (wc && !wc.isDestroyed()) wc.send("im:activity", conversationId);
	});
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
}

app.whenReady().then(() => {
	main().catch((err) => {
		console.error("[main] fatal", err);
		app.quit();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
