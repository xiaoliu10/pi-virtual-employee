/**
 * Process-hygiene built-ins (user ruling 2026-11-10: the four 运维脚本 safety
 * rules move from the skill layer — a soft constraint the field ignored — into
 * structural tool enforcement).
 *
 * Incident this answers (2026-11-10, box): kill_pw_chrome.ps1 killed every
 * ms-playwright browser by path prefix, taking down a LIVE spay login twice
 * (49s / 62s). A skill cannot be relied on to prevent that; structure can.
 *
 * Three layers live here:
 *  1. manage_process scan      — cross-platform process snapshot + four
 *                                hold-checks in authority order (debug channel
 *                                port|pipe → parent alive → age → contract),
 *                                SKIP/CANDIDATE verdicts, and a 10-minute kill
 *                                ticket covering the candidate PIDs.
 *  2. manage_process kill_pid  — ticket-scoped kill: ticket valid → pid listed →
 *                                RE-JUDGE the pid at kill time (TOCTOU guard:
 *                                debug channel / parent / contract re-checked on
 *                                a fresh snapshot; any hold = refuse and demand
 *                                a new scan) → TERM, escalate to force-kill only
 *                                after 5s.
 *  3. Execution gate           — run_command/run_script refuse incident-shaped
 *                                cleanup content (playwright marker + kill
 *                                primitives) and by-name batch killers
 *                                (killall / pkill -f / Stop-Process -Name /
 *                                taskkill /im|/t), pointing at scan→kill_pid.
 *                                Explicit `taskkill /pid <n>` (no /im, no /t)
 *                                stays allowed — it is the targeted-by-PID form.
 *
 * Contract ledger (<profileDir>/process-contracts.json, path injected via
 * ShellToolDeps.processContractsPath): long tasks register
 * {pid, purpose, expected_minutes, kill_conditions, registered_at}; scans SKIP
 * registered pids; the model removes the entry when the task ends.
 *
 * Everything decision-shaped is a pure exported function (verdictFor,
 * detectDangerousKill, matchesPattern, parseWin32CimProcessList,
 * scanLinuxProcesses) so the logic is testable without Windows.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, type Dirent } from "node:fs";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { maskId, refuse, type AdminRefusal } from "./admin.js";
import type { ConfigStore } from "../../db/config-store.js";
import { SCRIPT_EXTENSIONS } from "./run-script.js";
import type { ShellToolDeps } from "./shell.js";

/** Kill tickets live this long after their scan (task spec: 10 minutes). */
export const TICKET_TTL_MS = 10 * 60_000;
/** How long TERM gets to work before the kill escalates to force-kill. */
export const KILL_ESCALATE_MS = 5_000;
/** Defense against a pathological scan snapshot flooding memory. */
const MAX_SCAN_OUTPUT_CHARS = 5_000_000;

const DEFAULT_PATTERN = "chrome*";
const DEFAULT_MIN_AGE_MIN = 10;

// ── Records, verdicts, pattern matching (pure) ──────────────────────────────

/** One process from a platform snapshot. Field names mirror the verdict rows. */
export interface ProcessRecord {
	pid: number;
	/** Parent pid from the snapshot; null when unknown/absent. */
	ppid: number | null;
	command_line: string;
	exe_path: string | null;
	/** Process start epoch ms; null when unreadable (→ verdict SKIP 年龄未知). */
	started_at_ms: number | null;
}

/** One row of the scan candidate table. */
export interface ScanRow extends ProcessRecord {
	name: string;
	debug_channel: boolean;
	parent_alive: boolean;
	age_min: number | null;
	contract_registered: boolean;
	verdict: "SKIP" | "CANDIDATE";
	reason: string;
}

/** Snapshot of current processes (platform-specific; tests inject mocks). */
export type ProcessScanner = () => Promise<ProcessRecord[]>;

/** Hold-check inputs for one process. Names are the task's authoritative terms. */
export interface VerdictInput {
	debug_channel: boolean;
	parent_alive: boolean;
	age_min: number | null;
	contract_registered: boolean;
	min_age_min: number;
}

export interface VerdictOutput {
	verdict: "SKIP" | "CANDIDATE";
	reason: string;
}

/**
 * The four hold-checks in AUTHORITY order, short-circuiting. Order matters and
 * is pinned by tests: a process on a debug channel must SKIP even if it is
 * also old and unregistered — the earlier checks are the stronger evidence of
 * "something is using it right now". Age-unknown never drifts toward kill.
 */
export function verdictFor(input: VerdictInput): VerdictOutput {
	if (input.debug_channel) return { verdict: "SKIP", reason: "调试通道占用中（driver 在连）" };
	if (input.parent_alive) return { verdict: "SKIP", reason: "父进程存活（driver/宿主在跑）" };
	if (input.age_min === null || !Number.isFinite(input.age_min)) {
		return { verdict: "SKIP", reason: "启动时间不可读（年龄未知）" };
	}
	if (input.age_min < input.min_age_min) {
		return { verdict: "SKIP", reason: `启动仅 ${Math.round(input.age_min * 10) / 10} 分钟（< ${input.min_age_min}）` };
	}
	if (input.contract_registered) return { verdict: "SKIP", reason: "契约登记在册" };
	return { verdict: "CANDIDATE", reason: "疑似残留" };
}

/** Playwright's default debugging transports: port AND pipe (pipe is the default!). */
export function hasDebugChannel(commandLine: string): boolean {
	return /--remote-debugging-(?:port|pipe)/i.test(commandLine ?? "");
}

/** Basename across both separators; falls back to the command line's first token. */
export function processNameOf(rec: { exe_path: string | null; command_line: string }): string {
	const fromExe = rec.exe_path?.split(/[\\/]/).pop();
	if (fromExe) return fromExe;
	const first = (rec.command_line ?? "").trim().split(/\s+/)[0] ?? "";
	return first.split(/[\\/]/).pop() ?? "";
}

/**
 * Is the parent of `rec` alive in this snapshot? Platform-aware because the OS
 * decides what a parentless process looks like (review 05421c05 P2-2):
 *  - win32 keeps literal PPID semantics: Windows does NOT re-parent orphans, so
 *    a listed ppid that exists in the snapshot means the parent still runs.
 *  - POSIX (Linux/macOS) re-parents orphans to init/subreaper (pid 1, which is
 *    ALWAYS in the snapshot) — there a ppid of 1 means "parent is DEAD". Treating
 *    it as alive made every Linux orphan SKIP forever with a lying reason.
 */
export function parentAliveOn(platform: string, rec: ProcessRecord, records: ProcessRecord[]): boolean {
	if (rec.ppid === null || rec.ppid <= 0) return false;
	if (platform !== "win32" && rec.ppid === 1) return false;
	return records.some((other) => other.pid === rec.ppid);
}

/**
 * pattern semantics: containing * or ? → wildcard match against the process
 * NAME ("chrome*" covers chrome AND chrome-headless-shell); otherwise a
 * case-insensitive substring match against name, exe path, or command line.
 */
export function matchesPattern(pattern: string, rec: { exe_path: string | null; command_line: string }): boolean {
	const p = (pattern ?? "").trim();
	if (!p) return false;
	const name = processNameOf(rec);
	if (/[*?]/.test(p)) {
		const re = new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\?/g, ".") + "$", "i");
		return re.test(name);
	}
	const needle = p.toLowerCase();
	return name.toLowerCase().includes(needle)
		|| (rec.exe_path ?? "").toLowerCase().includes(needle)
		|| (rec.command_line ?? "").toLowerCase().includes(needle);
}

// ── Windows snapshot: parse (pure, fixture-tested) ──────────────────────────

/**
 * Process start time from whatever the snapshot handed us. Three REAL formats
 * reach this parser (review 05421c05 P1-1: the old DMTF-only fixture shipped a
 * scan that could never produce a candidate on the primary deployment OS):
 *  1. Windows PowerShell 5.1 ConvertTo-Json (the System32 powershell.exe this
 *     scanner always spawns): "/Date(1794217736983)/" — epoch ms. FIRST priority;
 *     optional backslashes survive double-escaping, the optional ±HHMM suffix is
 *     serialization metadata (the number is already UTC epoch ms).
 *  2. PS 7+ (pwsh) ConvertTo-Json: ISO-8601, e.g. "2026-11-09T22:50:53.745805+08:00".
 *  3. Raw DMTF from CIM: "20261109080000.123456+480" — components are
 *     machine-local, trailing offset is MINUTES from UTC (1-3 digits; UTC+8 = +480).
 * Unparseable → null (drifts to SKIP 年龄未知, never toward kill).
 * DMTF 小数秒截断使年龄偏大 ≤1 秒（review P3-5，方向安全不修：对持有判定的影响在噪声以下）。
 */
export function parseProcessStartTime(raw: string | null | undefined): number | null {
	if (!raw) return null;
	const text = raw.trim();
	// 1. PS 5.1 /Date(epochMs)/
	const dotNet = /\\?\/Date\((-?\d+)(?:[+-]\d{4})?\)\\?\//.exec(text);
	if (dotNet) {
		const ms = Number(dotNet[1]);
		return Number.isFinite(ms) ? ms : null;
	}
	// 2. ISO-8601 (PS7)
	if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:/.test(text)) {
		const ms = Date.parse(text);
		return Number.isFinite(ms) ? ms : null;
	}
	// 3. DMTF compact
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(text);
	if (!m) return null;
	const off = /([+-])(\d{1,3})\s*$/.exec(text);
	const offMin = off ? (off[1] === "-" ? -1 : 1) * Number(off[2]) : 0;
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - offMin * 60_000;
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse the ConvertTo-Json output of the Win32_Process query. Handles the
 * single-object form (ConvertTo-Json unwraps 1-element arrays), empty output,
 * and null fields. Bad JSON throws (caller refuses honestly).
 */
export function parseWin32CimProcessList(jsonText: string): ProcessRecord[] {
	const text = (jsonText ?? "").trim();
	if (!text) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`无法解析扫描输出：${err instanceof Error ? err.message : String(err)}`);
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const out: ProcessRecord[] = [];
	for (const row of rows) {
		const r = row as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown; ExecutablePath?: unknown; CreationDate?: unknown };
		const pid = Number(r.ProcessId);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const ppid = Number(r.ParentProcessId);
		out.push({
			pid,
			ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
			command_line: typeof r.CommandLine === "string" ? r.CommandLine : "",
			exe_path: typeof r.ExecutablePath === "string" && r.ExecutablePath ? r.ExecutablePath : null,
			started_at_ms: parseProcessStartTime(typeof r.CreationDate === "string" ? r.CreationDate : null),
		});
	}
	return out;
}

// ── Platform scanners ────────────────────────────────────────────────────────

/** Bounded child capture with hard timeout; used by the Windows scanner + kill ops. */
function spawnCapture(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let error: string | undefined;
		let child;
		try {
			child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch (err) {
			resolve({ code: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const timer = setTimeout(() => {
			error = `超时（>${timeoutMs}ms）`;
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < MAX_SCAN_OUTPUT_CHARS) stdout += chunk.toString("utf8"); });
		child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 200_000) stderr += chunk.toString("utf8"); });
		child.on("error", (err) => { error = err.message; });
		child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, error }); });
	});
}

/**
 * Windows scan: ONE powershell call listing every process; the query is a
 * module-level constant delivered via -EncodedCommand (UTF-16LE base64), so
 * nothing — neither quoting layers nor user data — ever travels through a
 * command line (引号地狱规范; the pattern filter happens in Node below).
 */
const WIN_PS_QUERY =
	"$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | "
	+ "Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath,CreationDate | ConvertTo-Json -Compress -Depth 3";
const WIN_PS_QUERY_B64 = Buffer.from(WIN_PS_QUERY, "utf16le").toString("base64");
const SCAN_TIMEOUT_MS = 30_000;

export async function scanWindowsProcesses(): Promise<ProcessRecord[]> {
	const ps = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
	const r = await spawnCapture(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", WIN_PS_QUERY_B64], SCAN_TIMEOUT_MS);
	if (r.error) throw new Error(`powershell 进程扫描失败：${r.error}`);
	if (r.code !== 0) throw new Error(`powershell 进程扫描失败 exit=${r.code}：${r.stderr.slice(0, 200)}`);
	return parseWin32CimProcessList(r.stdout);
}

/**
 * Linux scan: read /proc directly with Node — no shell out, no pgrep (name
 * pre-filtering misses processes whose comm is truncated; the exe link is the
 * ground truth). ppid parses stat AFTER the last ")" so a comm containing
 * spaces/parens cannot shift the fields (the naive `awk '{print $4}'` bug).
 */
export async function scanLinuxProcesses(procDir = "/proc"): Promise<ProcessRecord[]> {
	const out: ProcessRecord[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(procDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number(entry.name);
		const dir = join(procDir, entry.name);
		let exe_path: string | null = null;
		try { exe_path = await readlink(join(dir, "exe")); } catch { /* unreadable stays null */ }
		let command_line = "";
		try {
			// cmdline is NUL-separated; join the segments the way ps would show them.
			const raw = await readFile(join(dir, "cmdline"), "utf8");
			command_line = raw.split("\0").filter(Boolean).join(" ");
		} catch { /* empty */ }
		const ppid = await readPpidFromStat(join(dir, "stat"));
		let started_at_ms: number | null = null;
		try { started_at_ms = (await stat(dir)).mtimeMs; } catch { /* 年龄未知 */ }
		out.push({ pid, ppid, command_line, exe_path, started_at_ms });
	}
	return out;
}

/** stat field 4 = ppid; fields restart after the comm's closing ")" — find the LAST one. */
async function readPpidFromStat(statPath: string): Promise<number | null> {
	try {
		const text = await readFile(statPath, "utf8");
		const close = text.lastIndexOf(")");
		if (close < 0) return null;
		const fields = text.slice(close + 1).trim().split(/\s+/);
		const ppid = Number(fields[1]);
		return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
	} catch {
		return null;
	}
}

/** Default scanner for the running platform. macOS dev machines refuse honestly. */
export function defaultScanner(): ProcessScanner {
	if (process.platform === "win32") return scanWindowsProcesses;
	if (process.platform === "linux") return () => scanLinuxProcesses("/proc");
	throw new Error(`scan 仅支持 Windows/Linux 部署机（当前平台 ${process.platform} 不支持）`);
}

// ── Kill ops (platform defaults; injectable for tests) ──────────────────────

export interface KillStepResult { ok: boolean; detail: string; }

export interface KillOps {
	/** Graceful stop (TERM / taskkill without /t or /f). */
	terminate(pid: number): Promise<KillStepResult>;
	/** Force stop (SIGKILL / taskkill /f) — only after TERM failed for 5s. */
	escalate(pid: number): Promise<KillStepResult>;
	isAlive(pid: number): Promise<boolean>;
}

function notFoundDetail(err: unknown): string {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	return code === "ESRCH" ? "进程不存在（可能已自行退出）" : `失败：${err instanceof Error ? err.message : String(err)}`;
}

function defaultKillOps(): KillOps {
	if (process.platform === "win32") {
		const system32 = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
		const runTaskkill = async (args: string[]): Promise<KillStepResult> => {
			const r = await spawnCapture(join(system32, "taskkill.exe"), args, 15_000);
			if (r.error) return { ok: false, detail: r.error };
			if (r.code === 0) return { ok: true, detail: r.stdout.trim().slice(0, 200) || "成功" };
			const text = `${r.stdout} ${r.stderr}`.trim();
			if (r.code === 128 || /不存在|not found/i.test(text)) return { ok: false, detail: "进程不存在（可能已自行退出）" };
			return { ok: false, detail: `exit=${r.code} ${text.slice(0, 200)}` };
		};
		return {
			// No /t: a targeted single-pid stop must not take a whole tree with it.
			terminate: (pid) => runTaskkill(["/pid", String(pid)]),
			escalate: (pid) => runTaskkill(["/pid", String(pid), "/f"]),
			isAlive: async (pid) => {
				const r = await spawnCapture(join(system32, "tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], 15_000);
				// Query failed → assume alive (conservative; a force-kill on an
				// already-dead pid fails harmlessly, the reverse risks a mistake).
				if (r.error) return true;
				return new RegExp(`^"[^"]*",\\s*"?${pid}"?,`, "m").test(r.stdout);
			},
		};
	}
	return {
		terminate: async (pid) => {
			try { process.kill(pid, "SIGTERM"); return { ok: true, detail: "已发送 SIGTERM" }; }
			catch (err) { return { ok: false, detail: notFoundDetail(err) }; }
		},
		escalate: async (pid) => {
			try { process.kill(pid, "SIGKILL"); return { ok: true, detail: "已发送 SIGKILL" }; }
			catch (err) { return { ok: false, detail: notFoundDetail(err) }; }
		},
		isAlive: async (pid) => {
			try { process.kill(pid, 0); return true; }
			catch (err) { return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM"; }
		},
	};
}

async function waitUntilGone(ops: KillOps, pid: number, graceMs: number): Promise<boolean> {
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (!(await ops.isAlive(pid))) return true;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return !(await ops.isAlive(pid));
}

// ── Contract ledger (<profileDir>/process-contracts.json) ───────────────────

export interface ProcessContract {
	pid: number;
	purpose: string;
	expected_minutes: number | null;
	kill_conditions: string | null;
	registered_at: string;
}

interface ContractLedger {
	entries: ProcessContract[];
	/** Ledger exists but is unreadable (half-written on crash / corrupt JSON) —
	 * every caller must degrade LOUDLY, not silently lose the hold-check
	 * (review 05421c05 P2-4). */
	corrupted: boolean;
}

function readContracts(path: string | undefined): ContractLedger {
	if (!path || !existsSync(path)) return { entries: [], corrupted: false };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed)) return { entries: [], corrupted: true };
		return {
			entries: parsed.filter((e): e is ProcessContract =>
				!!e && typeof e === "object" && typeof (e as ProcessContract).pid === "number"),
			corrupted: false,
		};
	} catch (err) {
		console.error("[process-hygiene] contract ledger unreadable (hold-check degraded):", err instanceof Error ? err.message : String(err));
		return { entries: [], corrupted: true };
	}
}

/** tmp+rename so a crash mid-write cannot corrupt the ledger into silent
 * protection loss (review 05421c05 P2-4). Same-directory rename is atomic on
 * POSIX; Node's rename over an existing file maps to MoveFileEx(REPLACE_EXISTING) on Windows. */
function writeContracts(path: string, entries: ProcessContract[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(entries, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

// ── Kill tickets ─────────────────────────────────────────────────────────────

interface KillTicket {
	token: string;
	/** Scan-time identity anchors, per candidate PID (review 05421c05 P2-1:
	 * tickets that only lock PIDs can be hijacked by PID reuse inside the TTL).
	 * A kill re-judge must match BOTH the holds AND this identity. */
	anchors: Map<number, { exe_path: string | null; started_at_ms: number | null }>;
	pattern: string;
	min_age_min: number;
	created_at: number;
	expires_at: number;
}

/** Per-config ticket store — same scoping pattern as the shell session registry. */
const ticketStores = new WeakMap<ConfigStore, Map<string, KillTicket>>();

function ticketStoreFor(config: ConfigStore): Map<string, KillTicket> {
	let store = ticketStores.get(config);
	if (!store) {
		store = new Map();
		ticketStores.set(config, store);
	}
	return store;
}

function sweepTickets(store: Map<string, KillTicket>, now: number): void {
	for (const [token, ticket] of store) {
		if (now > ticket.expires_at) store.delete(token);
	}
}

// ── Execution gate (pure detection + path extraction) ───────────────────────

/** The incident marker: playwright browser installs / headless shell binaries. */
const PLAYWRIGHT_MARKER = /ms-playwright|chrome-headless-shell/i;

/**
 * Kill primitives. \bkill\b boundaries keep innocent text ("skill", "kill
 * 流程") out; taskkill/killall/pkill have their own tokens. `\bkill\s*\(` covers
 * python os.kill(pid, 9).
 */
const KILL_PRIMITIVE =
	/\.\s*Kill\s*\(|\bkill\s*\(|\bkill\s+(?:-[^ ]+\s+)?[\d$]|\bStop-Process\b|\btaskkill\b|\bkillall\b|\bpkill\b/i;

/** The exemption: an explicit by-PID taskkill (no /im, no /t) is a targeted kill. */
const TASKKILL_BY_PID_EXEMPT = /\btaskkill\s+\/pid\s+\d+(?:\s+\/f)?\b/gi;

/** By-name/pipeline batch killers refused on the command line alone (line-scoped;
 * flag order tolerated; review 05421c05 P2-3 added bare pkill, piped
 * Stop-Process, and the `| % { $_.Kill() }` loop — all incident-class shapes). */
const BY_NAME_KILLERS: Array<[RegExp, string]> = [
	[/\bkillall\b/i, "killall（按进程名批量杀）"],
	[/\bpkill\b/i, "pkill（按模式批量杀）"],
	[/\bStop-Process\b[^|\r\n;]*-\s*Name\b/i, "Stop-Process -Name（按进程名批量杀）"],
	[/\|\s*Stop-Process\b/i, "管道 Stop-Process（Get-Process | Stop-Process 批量杀）"],
	[/\$(?:_|PSItem)\s*\.\s*Kill\s*\(/i, "管道 .Kill()（| % { $_.Kill() } 循环杀）"],
	[/\btaskkill\b[^|\r\n;]*\/im\b/i, "taskkill /im（按进程名杀）"],
	[/\btaskkill\b[^|\r\n;]*\/t(?:\s|$)/i, "taskkill /t（树杀，连带子进程）"],
];

function dangerousKillReason(hits: string[]): string {
	return `命令/脚本命中危险清理模式（${[...new Set(hits)].join("、")}）。`
		+ "2026-11-10 盒子事故：kill_pw_chrome.ps1 按 ms-playwright 前缀 foreach .Kill() 无差别杀浏览器，把正在运行的 spay 登录任务连杀两次（49s/62s）——手写批量清理脚本不再放行。"
		+ "请改用内置两段式：先 manage_process(action=\"scan\") 做四道持有判定（调试通道/父进程/年龄/契约）并返回 ticket，再凭 ticket 用 manage_process(action=\"kill_pid\", ticket=…, pid=…) 定点结束。"
		+ "显式 taskkill /pid <n>（无 /im、无 /t）按 PID 定点杀，不在拦截范围；如是只读排查（并非要杀进程），请让管理员改用 taskkill /pid 定点或把脚本改为纯查询输出。";
}

/**
 * Detect incident-shaped kill content. Returns the refusal reason (with why +
 * how) or null. High-precision v1: rule (a) needs BOTH a playwright marker AND
 * a kill primitive; rule (b) fires on the listed by-name killers alone; the
 * explicit taskkill /pid form is stripped before rule (a) so a targeted kill
 * next to playwright content stays allowed.
 */
export function detectDangerousKill(text: string): string | null {
	const raw = text ?? "";
	const hits: string[] = [];
	// (b) by-name killers, evaluated per line so a safe Stop-Process -Id line is
	// not conflated with a dangerous -Name line elsewhere in the script.
	for (const line of raw.split(/\r?\n/)) {
		for (const [re, label] of BY_NAME_KILLERS) {
			if (re.test(line)) hits.push(label);
		}
	}
	// (a) playwright marker + kill primitive, after stripping the /pid exemption.
	const stripped = raw.replace(TASKKILL_BY_PID_EXEMPT, "");
	if (PLAYWRIGHT_MARKER.test(stripped) && KILL_PRIMITIVE.test(stripped)) {
		hits.push("ms-playwright/chrome-headless-shell 内容 + 杀进程原语");
	}
	return hits.length ? dangerousKillReason(hits) : null;
}

/**
 * Script-file candidates referenced by a command line (double- or single-quoted
 * or bare tokens ending in a run_script script extension). Content of these
 * files is what the gate scans — the 2026-11-10 incident travelled as
 * `powershell -File kill_pw_chrome.ps1`, invisible on the command line itself.
 *
 * The extension list is run-script.ts's SCRIPT_EXTENSIONS verbatim (review
 * 05421c05 P2-3: a runtime run_script accepts is a runtime the gate must scan;
 * the old inline ps1|sh|py|cmd|bat list let .js/.mjs/.cjs killers run). The
 * bare-token branch carries a lookahead so `params.json` is never read as a
 * `.js` script (review P3-1: quoted-with-spaces paths, single-quoted ones too).
 */
const SCRIPT_PATH_RE = (() => {
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const ext = SCRIPT_EXTENSIONS.map(esc).join("|");
	return new RegExp(`"([^"]+(?:${ext}))"|'([^']+(?:${ext}))'|(\\S+(?:${ext}))(?=\\s|$)`, "gi");
})();

export function extractScriptPaths(command: string): string[] {
	const out: string[] = [];
	for (const m of (command ?? "").matchAll(SCRIPT_PATH_RE)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

function readScriptForGate(
	path: string,
	workingDir: string,
	readFile?: (p: string) => string | null,
	onUnreadable?: (resolvedPath: string) => void,
): string | null {
	// isAbsolute follows the RUNNING platform: a Windows-style path on macOS
	// (where tests run) is not absolute, so with no workingDir we pass the raw
	// path through and let the reader decide (a real-fs miss → null → skip).
	const abs = isAbsolute(path) ? path : workingDir ? join(workingDir, path) : path;
	if (readFile) {
		const content = readFile(abs);
		if (content === null) onUnreadable?.(abs);
		return content;
	}
	try {
		// Detection needs the head of the file, not the whole thing.
		return readFileSync(abs, "utf8").slice(0, 1_000_000);
	} catch {
		// Unreadable/missing scripts are logged by the caller (audit), then
		// skipped — 宁漏勿误伤, but never silently (gate-silence lesson).
		onUnreadable?.(abs);
		return null;
	}
}

/**
 * The gate itself: command text + every referenced script file's content.
 * Returns the refusal reason or null. Synchronous; runs inside executeCommand
 * after the role gate (review P3-2) and before the whitelist/authorization.
 * `onUnreadable` observes script files that could not be read for the content
 * scan (review P3-1: silent skips are invisible coverage gaps).
 */
export function gateDangerousKillForCommand(
	command: string,
	opts: { workingDir?: string; readFile?: (p: string) => string | null; onUnreadable?: (resolvedPath: string) => void } = {},
): string | null {
	const reason = detectDangerousKill(command);
	if (reason) return reason;
	const workingDir = (opts.workingDir ?? "").trim();
	for (const path of extractScriptPaths(command)) {
		const content = readScriptForGate(path, workingDir, opts.readFile, opts.onUnreadable);
		if (content === null) continue;
		const contentReason = detectDangerousKill(content);
		if (contentReason) return `${contentReason}\n（检出位置：脚本文件 ${path}）`;
	}
	return null;
}

// ── manage_process action handler ────────────────────────────────────────────

export interface ProcessHygieneParams {
	action: string;
	pattern?: string;
	minAgeMin?: number;
	ticket?: string;
	pid?: number;
	purpose?: string;
	expectedMinutes?: number;
	killConditions?: string;
}

/** Context injected by the manage_process dispatch (audit identity; platform
 * steers the POSIX vs win32 parent-alive semantics — review 05421c05 P2-2). */
export interface HygieneInject {
	scanner?: ProcessScanner;
	now?: () => number;
	kill?: KillOps;
	actorId?: string;
	channel?: string;
	platform?: string;
}

export interface HygieneResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

/** Same JSON-line format and file as shell.ts's audit. */
function audit(path: string | undefined, event: Record<string, unknown>): void {
	if (!path) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
	} catch (err) {
		console.error("[process-hygiene] audit write failed:", err instanceof Error ? err.message : String(err));
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function scanSnapshot(inject: HygieneInject): Promise<ProcessRecord[]> {
	const scanner = inject.scanner ?? defaultScanner();
	return scanner();
}

async function scanAction(deps: ShellToolDeps, params: ProcessHygieneParams, inject: HygieneInject): Promise<HygieneResult | AdminRefusal> {
	const pattern = (params.pattern ?? DEFAULT_PATTERN).trim();
	if (!pattern || pattern.length > 200) return refuse("pattern 必须是 1～200 个字符的进程名通配或路径子串。");
	const minAge = params.minAgeMin ?? DEFAULT_MIN_AGE_MIN;
	if (!Number.isInteger(minAge) || minAge < 0 || minAge > 1440) return refuse("minAgeMin 必须是 0～1440 的整数分钟。");
	const nowMs = inject.now?.() ?? Date.now();

	let records: ProcessRecord[];
	try {
		records = await scanSnapshot(inject);
	} catch (err) {
		// Scan failures are audited, never silent (review 05421c05 P3-3).
		audit(deps.auditLogPath, { event: "hygiene_scan", actor: maskId(inject.actorId ?? ""), channel: inject.channel ?? "", ok: false, error: truncate(String(err instanceof Error ? err.message : err), 200) });
		return refuse(`进程扫描失败：${err instanceof Error ? err.message : String(err)}`);
	}

	const platform = inject.platform ?? process.platform;
	const ledger = readContracts(deps.processContractsPath);
	if (ledger.corrupted) {
		// The hold-check just lost its fourth leg: warn in-band AND in the audit
		// log, never silently (review 05421c05 P2-4).
		audit(deps.auditLogPath, { event: "hygiene_contracts_corrupt", actor: maskId(inject.actorId ?? ""), path: deps.processContractsPath ?? "" });
	}
	const registered = new Set(ledger.entries.map((c) => c.pid));
	const matched = records.filter((r) => matchesPattern(pattern, r));
	const rows: ScanRow[] = matched.map((r) => {
		const debug_channel = hasDebugChannel(r.command_line);
		const parent_alive = parentAliveOn(platform, r, records);
		const age_min = r.started_at_ms === null ? null : (nowMs - r.started_at_ms) / 60_000;
		const contract_registered = registered.has(r.pid);
		const v = verdictFor({ debug_channel, parent_alive, age_min, contract_registered, min_age_min: minAge });
		return { ...r, name: processNameOf(r), debug_channel, parent_alive, age_min, contract_registered, verdict: v.verdict, reason: v.reason };
	});
	const candidates = rows.filter((r) => r.verdict === "CANDIDATE");

	audit(deps.auditLogPath, {
		event: "hygiene_scan", actor: maskId(inject.actorId ?? ""), channel: inject.channel ?? "",
		ok: true, pattern, min_age_min: minAge, matched: rows.length, candidates: candidates.length,
	});

	// Corruption warning rides FIRST so it cannot be cut off by long tables
	// (review 05421c05 P2-4).
	const corruptNote = ledger.corrupted
		? "⚠️ 契约台账损坏（process-contracts.json 无法解析）：本轮「契约在册」判据失效，结果可能把在册任务误判为候选；请人工检查该文件后重试。\n"
		: "";
	const header = `${corruptNote}scan（pattern=${pattern}，minAgeMin=${minAge}）：匹配 ${rows.length} 个进程，候选 ${candidates.length} 个。`;
	if (!rows.length) {
		return {
			content: [{ type: "text", text: `${header}\n没有匹配的进程，没有需要清理的目标。` }],
			details: { pattern, min_age_min: minAge, matched: 0, candidate_count: 0, rows: [], ticket: null, expires_at: null, contracts_corrupted: ledger.corrupted },
		};
	}

	const render = (r: ScanRow) =>
		`PID ${r.pid}｜${r.verdict} ${r.reason}｜age=${r.age_min === null ? "?" : `${Math.round(r.age_min * 10) / 10}min`}`
		+ `｜ppid=${r.ppid ?? "?"}${r.parent_alive ? "（存活）" : "（不在快照/已退出）"}`
		+ `｜contract=${r.contract_registered ? "在册" : "无"}`
		+ `｜exe=${r.exe_path ?? "?"}｜cmd=${truncate(r.command_line, 120)}`;
	// Bound the rendered table; the full rows stay in details.
	const shown = rows.slice(0, 40);
	const overflowNote = rows.length > shown.length ? `\n（另有 ${rows.length - shown.length} 个匹配未逐行展示，完整列表在 details.rows）` : "";

	let ticketText = "";
	let ticket: KillTicket | null = null;
	let expires_at: number | null = null;
	if (candidates.length) {
		const store = ticketStoreFor(deps.config);
		sweepTickets(store, nowMs);
		ticket = {
			token: randomUUID(),
			// Identity anchors (review 05421c05 P2-1): a PID alone is re-usable
			// inside the TTL; the kill re-judge must see the SAME process.
			anchors: new Map(candidates.map((c) => [c.pid, { exe_path: c.exe_path, started_at_ms: c.started_at_ms }])),
			pattern,
			min_age_min: minAge,
			created_at: nowMs,
			expires_at: nowMs + TICKET_TTL_MS,
		};
		store.set(ticket.token, ticket);
		expires_at = ticket.expires_at;
		const candidatePids = [...ticket.anchors.keys()];
		ticketText = `\n\nticket=${ticket.token}（10 分钟内有效；覆盖候选 PID：${candidatePids.join(", ")}）`
			+ `\n下一步：manage_process(action="kill_pid", ticket="${ticket.token}", pid=<PID>) 逐个定点结束；kill 前会重新判定（身份锚点/调试通道/父进程/契约），状态已变化会被拒绝并要求重新 scan。`;
	} else {
		ticketText = "\n没有可清理的候选——全部被持有判定挡下（都可能有主）。不要手写脚本强杀；如确属残留，等它超过 minAgeMin 后重新 scan。";
	}

	return {
		content: [{ type: "text", text: `${header}\n${shown.map(render).join("\n")}${overflowNote}${ticketText}` }],
		details: { pattern, min_age_min: minAge, matched: rows.length, candidate_count: candidates.length, rows, ticket: ticket?.token ?? null, expires_at, contracts_corrupted: ledger.corrupted },
	};
}

async function killPidAction(deps: ShellToolDeps, params: ProcessHygieneParams, inject: HygieneInject): Promise<HygieneResult | AdminRefusal> {
	const token = (params.ticket ?? "").trim();
	if (!token) return refuse("kill_pid 需要 scan 返回的 ticket。");
	const pid = params.pid;
	if (!Number.isInteger(pid) || (pid as number) < 1) return refuse("pid 必须是正整数。");
	const nowMs = inject.now?.() ?? Date.now();

	const store = ticketStoreFor(deps.config);
	sweepTickets(store, nowMs);
	const ticket = store.get(token);
	if (!ticket) return refuse("ticket 不存在或已过期，请重新 scan 获取新 ticket。");

	const anchor = ticket.anchors.get(pid as number);
	if (!anchor) {
		const known = [...ticket.anchors.keys()];
		return refuse(`pid=${pid} 不在该 ticket 名单内（名单：${known.join(", ")}）。请重新 scan 后按新票操作。`);
	}

	// TOCTOU re-judge: the scan verdict is minutes old; the ONLY authoritative
	// state is a fresh snapshot taken at kill time.
	let records: ProcessRecord[];
	try {
		records = await scanSnapshot(inject);
	} catch (err) {
		// Scan failures are audited, never silent (review 05421c05 P3-3).
		audit(deps.auditLogPath, { event: "hygiene_kill_pid", actor: maskId(inject.actorId ?? ""), channel: inject.channel ?? "", pid, ok: false, error: truncate(String(err instanceof Error ? err.message : err), 200) });
		return refuse(`kill 前重新扫描失败：${err instanceof Error ? err.message : String(err)}`);
	}
	const target = records.find((r) => r.pid === pid);
	if (!target) {
		// Honest no-op — still audited so kill attempts are fully traceable
		// (review 05421c05 P3-3).
		audit(deps.auditLogPath, { event: "hygiene_kill_pid", actor: maskId(inject.actorId ?? ""), channel: inject.channel ?? "", pid, ok: true, already_gone: true });
		return {
			content: [{ type: "text", text: `PID ${pid} 已退出（scan 后自行结束），无需处理。` }],
			details: { pid, already_gone: true, ok: true },
		};
	}
	const changed: string[] = [];
	// Identity anchor (review 05421c05 P2-1): a reused PID inside the TTL must
	// never inherit the ticket — same pid, different process = refuse.
	const sameStart = anchor.started_at_ms === null || target.started_at_ms === null || anchor.started_at_ms === target.started_at_ms;
	const sameExe = anchor.exe_path === null || target.exe_path === null
		|| target.exe_path === anchor.exe_path
		|| target.exe_path.startsWith(anchor.exe_path)
		|| anchor.exe_path.startsWith(target.exe_path);
	if (!sameStart || !sameExe) {
		audit(deps.auditLogPath, { event: "hygiene_kill_pid", actor: maskId(inject.actorId ?? ""), channel: inject.channel ?? "", pid, ok: false, identity_mismatch: true });
		return refuse(`PID ${pid} 身份不符（疑似 PID 复用）：scan 时锚点 exe=${anchor.exe_path ?? "?"} started=${anchor.started_at_ms ?? "?"}，当前是 exe=${target.exe_path ?? "?"} started=${target.started_at_ms ?? "?"}。拒绝杀；请重新 scan 获取反映当前进程的新 ticket。`);
	}
	if (hasDebugChannel(target.command_line)) changed.push("调试通道占用中（driver 在连）");
	if (parentAliveOn(inject.platform ?? process.platform, target, records)) changed.push("父进程存活（driver/宿主在跑）");
	const ledger = readContracts(deps.processContractsPath);
	if (ledger.corrupted) {
		// The ledger is the authority on "registered"; unreadable = unknown hold
		// state = refuse rather than guess (review 05421c05 P2-4).
		audit(deps.auditLogPath, { event: "hygiene_contracts_corrupt", actor: maskId(inject.actorId ?? ""), path: deps.processContractsPath ?? "" });
		return refuse(`契约台账损坏（${deps.processContractsPath} 无法解析），无法确认该 pid 是否登记在册；kill 拒绝。请人工修复台账后重新 scan。`);
	}
	if (ledger.entries.some((c) => c.pid === pid)) changed.push("契约登记在册");
	if (changed.length) {
		return refuse(`PID ${pid} 状态已变化（${changed.join("；")}），不能杀。请重新 scan 获取反映当前状态的新 ticket。`);
	}

	const ops = inject.kill ?? defaultKillOps();
	const targetPid = pid as number;
	const steps: string[] = ["TERM："];
	const term = await ops.terminate(targetPid);
	steps[0] = `TERM：${term.detail}`;
	let gone = term.ok ? await waitUntilGone(ops, targetPid, KILL_ESCALATE_MS) : /不存在/.test(term.detail);
	let escalated = false;
	if (!gone) {
		escalated = true;
		const esc = await ops.escalate(targetPid);
		steps.push(`强杀：${esc.detail}`);
		gone = esc.ok ? await waitUntilGone(ops, targetPid, 2_000) : /不存在/.test(esc.detail);
	}
	if (!gone) {
		steps.push("结果：进程仍在运行");
		audit(deps.auditLogPath, { event: "hygiene_kill_pid", actor: maskId(inject.actorId ?? ""), channel: inject.channel ?? "", pid, ok: false, escalated });
		return {
			content: [{ type: "text", text: `PID ${pid} 未能结束（${steps.join("；")}）。如仍需处理，请重新 scan 确认状态。` }],
			details: { pid, escalated, steps, ok: false, failed: true },
		};
	}
	audit(deps.auditLogPath, { event: "hygiene_kill_pid", actor: maskId(inject.actorId ?? ""), channel: inject.channel ?? "", pid, ok: true, escalated });
	return {
		content: [{ type: "text", text: `PID ${pid} 已结束（${steps.join("；")}）。` }],
		details: { pid, escalated, steps, ok: true },
	};
}

function registerContractAction(deps: ShellToolDeps, params: ProcessHygieneParams, inject: HygieneInject): HygieneResult | AdminRefusal {
	const pid = params.pid;
	if (!Number.isInteger(pid) || (pid as number) < 1) return refuse("register_contract 需要 pid（正整数）。");
	const purpose = (params.purpose ?? "").trim();
	if (!purpose || purpose.length > 500) return refuse("purpose 必填（1～500 字符）：写清这个进程是干什么的。");
	const expected = params.expectedMinutes ?? null;
	if (expected !== null && (!Number.isInteger(expected) || (expected as number) < 0 || (expected as number) > 60 * 24 * 30)) {
		return refuse("expectedMinutes 必须是 0～43200 的整数分钟。");
	}
	const conditions = (params.killConditions ?? "").trim();
	if (conditions.length > 500) return refuse("killConditions 最长 500 字符。");
	if (!deps.processContractsPath) return refuse("契约文件路径未配置（profile 目录缺失），无法登记。");
	// 陈旧契约+PID 复用（review 05421c05 P3-4，方向安全不修）：pid 键模型下，无关新进程
	// 可能继承旧免杀保护、remove 按 pid 盲注销——保护性偏置（多放不杀少），自洽不升级。

	const ledger = readContracts(deps.processContractsPath);
	if (ledger.corrupted) {
		audit(deps.auditLogPath, { event: "hygiene_contracts_corrupt", actor: maskId(inject.actorId ?? ""), path: deps.processContractsPath });
		return refuse(`契约台账损坏（${deps.processContractsPath} 无法解析），拒绝在未知状态的台账上追加；请人工修复后重试。`);
	}
	const entries = ledger.entries;
	if (entries.some((c) => c.pid === pid)) {
		return refuse(`pid=${pid} 已有登记。先 remove_contract(pid=${pid}) 注销旧的，再重新登记。`);
	}
	entries.push({
		pid: pid as number,
		purpose,
		expected_minutes: expected,
		kill_conditions: conditions || null,
		registered_at: new Date(inject.now?.() ?? Date.now()).toISOString(),
	});
	writeContracts(deps.processContractsPath, entries);
	audit(deps.auditLogPath, { event: "hygiene_contract_register", actor: maskId(inject.actorId ?? ""), channel: inject.channel ?? "", pid });
	return {
		content: [{ type: "text", text: `已登记契约：pid=${pid}，用途「${purpose}」${expected !== null ? `，预期 ${expected} 分钟` : ""}。任务结束时必须 remove_contract(pid=${pid}) 注销——在册的 pid 会被 scan 判 SKIP，忘删会让残留永久免杀。` }],
		details: { pid, registered: true, total: entries.length },
	};
}

function listContractsAction(deps: ShellToolDeps): HygieneResult {
	const ledger = readContracts(deps.processContractsPath);
	const corruptNote = ledger.corrupted ? "⚠️ 契约台账损坏，以下列表可能不完整；请人工检查 process-contracts.json。\n" : "";
	const entries = ledger.entries;
	const text = corruptNote + (entries.length
		? `契约登记 ${entries.length} 条：\n${entries.map((c) =>
			`PID ${c.pid}｜${c.purpose}${c.expected_minutes !== null ? `｜预期 ${c.expected_minutes} 分钟` : ""}${c.kill_conditions ? `｜可终止条件：${c.kill_conditions}` : ""}｜登记于 ${c.registered_at}`).join("\n")}`
		: "没有登记的契约。");
	return { content: [{ type: "text", text }], details: { contracts: entries, contracts_corrupted: ledger.corrupted } };
}

function removeContractAction(deps: ShellToolDeps, params: ProcessHygieneParams, inject: HygieneInject): HygieneResult | AdminRefusal {
	const pid = params.pid;
	if (!Number.isInteger(pid) || (pid as number) < 1) return refuse("remove_contract 需要 pid（正整数）。");
	if (!deps.processContractsPath) return refuse("契约文件路径未配置（profile 目录缺失），无法注销。");
	const ledger = readContracts(deps.processContractsPath);
	if (ledger.corrupted) {
		audit(deps.auditLogPath, { event: "hygiene_contracts_corrupt", actor: maskId(inject.actorId ?? ""), path: deps.processContractsPath });
		return refuse(`契约台账损坏（${deps.processContractsPath} 无法解析），拒绝按 pid 盲注销（可能误删其他任务的登记）；请人工修复后重试。`);
	}
	const entries = ledger.entries;
	const remaining = entries.filter((c) => c.pid !== pid);
	if (remaining.length === entries.length) {
		return { content: [{ type: "text", text: `没有 pid=${pid} 的登记。` }], details: { pid, removed: false, total: entries.length } };
	}
	writeContracts(deps.processContractsPath, remaining);
	audit(deps.auditLogPath, { event: "hygiene_contract_remove", actor: maskId(inject.actorId ?? ""), channel: inject.channel ?? "", pid });
	return {
		content: [{ type: "text", text: `已注销契约 pid=${pid}（剩余 ${remaining.length} 条）。` }],
		details: { pid, removed: true, total: remaining.length },
	};
}

/** Entry point the manage_process tool dispatches the five hygiene actions to. */
export async function handleProcessHygieneAction(
	deps: ShellToolDeps,
	params: ProcessHygieneParams,
	inject: HygieneInject = {},
): Promise<HygieneResult | AdminRefusal> {
	switch (params.action) {
		case "scan": return scanAction(deps, params, inject);
		case "kill_pid": return killPidAction(deps, params, inject);
		case "register_contract": return registerContractAction(deps, params, inject);
		case "list_contracts": return listContractsAction(deps);
		case "remove_contract": return removeContractAction(deps, params, inject);
		default:
			return refuse(`未知的进程卫生动作：${params.action}`);
	}
}
