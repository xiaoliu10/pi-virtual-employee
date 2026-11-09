/**
 * Restricted command execution for headless-server operations.
 *
 * Authorizes a platform-verified 1:1 admin (same gate as manage_admin /
 * manage_update), requires the command's executable to be on the
 * `capabilities.shell.allowedCommands` whitelist, and runs the command via
 * `cmd /c` on Windows (the target deployment is a locked-down Windows server
 * with no visible desktop). Every execution is audited (masked admin id +
 * command), truncated to avoid flooding the reply, and bounded by the
 * configured runtime limit (sync: 300 seconds by default; background:
 * unlimited by default).
 *
 * Safety posture:
 *  - Shell execution is OFF by default (`capabilities.shell.enabled=false`).
 *  - Each run_command call by an OPERATOR requires the CURRENT message to
 *    contain an explicit confirmation (the model can't self-authorize by
 *    passing a flag). Admins are exempt: the task initiator being an
 *    admin-verified sender is itself the authorization (user ruling
 *    2026-09-29 — group-chat Python runs kept bouncing off the confirmation
 *    gate mid-task); every run remains audited. Unattended scheduled-task
 *    runs also skip per-message confirmation, re-attaching the task creator's
 *    identity (live whitelist check, prompt is fixed text).
 *  - Only executables on the whitelist may be run; "*" is supported but
 *    documented as "full server control from a stolen admin IM account".
 *  - The command runs with the parent's user token (not elevated); anything
 *    needing elevation fails cleanly instead of silently partial-running.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bool, int, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigStore } from "../../db/config-store.js";
import { MAX_TIMEOUT_SEC } from "../../shared/timeouts.js";
import { CommandSession } from "../command-session.js";
import { maskId, refuse, isSchedulerActor, isExplicitConfirmation, type ActorContext } from "./admin.js";
import { gateDangerousKillForCommand, handleProcessHygieneAction, type ProcessHygieneParams } from "./process-hygiene.js";
import { effectiveActorRole, resolveRole, ROLE_RANK, type Role } from "../../security/permissions.js";

/**
 * Role-tiered command gate (replaces the admin-only gate for run_command):
 *   viewer   — no command execution at all.
 *   operator — interactive confirmation required; executable whitelist applies
 *              (composition still rejected).
 *   admin    — NO interactive confirmation (the verified admin sender is the
 *              authorization, user ruling 2026-09-29); whitelist BYPASSED
 *              (full shell: composition/script files allowed).
 * Scheduled-task actors inherit their creator's role (re-checked live every
 * fire); unattended runs skip the per-message confirmation as before.
 *
 * Single-chat AND group chats are both allowed (user ruling 2026-09-23, field:
 * an SLS triage needed run_command from the group where the task lived). The
 * gates that actually matter hold in either: platform-verified sender, live
 * role resolution, and — for operators — an explicit 「确认」 in the sender's
 * own current message.
 */
function gateCommandRole(
	deps: Pick<ShellToolDeps, "config" | "resolveActor" | "conversationId">,
	opts: { needConfirmation: boolean } = { needConfirmation: true },
): ReturnType<typeof refuse> | { actor: NonNullable<ActorContext>; role: Role } {
	const actor = deps.resolveActor(deps.conversationId);
	if (actor && isSchedulerActor(actor)) {
		const role = resolveRole(deps.config, actor.senderId);
		if (role === "viewer") return refuse("创建该任务的用户没有命令执行权限，任务无法继续。");
		return { actor, role };
	}
	if (!actor && deps.conversationId.startsWith("sched:")) {
		return refuse("该定时任务创建时未记录创建者身份，无法无人值守执行命令。请管理员在 IM 单聊中使用 authorize_scheduled_task 给该任务授权。");
	}
	if (!actor) return refuse("当前会话没有经过验证的发送者身份，无法执行命令。");
	if (!actor.senderId) return refuse("无法识别发送者身份（senderId 为空），拒绝执行。");
	const role = effectiveActorRole(deps.config, actor);
	if (role === "viewer") {
		return refuse("当前用户没有命令执行权限（需要 operator 及以上）。如需开通请联系管理员在 security.people 中指派角色。");
	}
	// Admin: no interactive confirmation — the verified admin initiator IS the
	// authorization (user ruling 2026-09-29; every run stays audited). Only
	// operators confirm per message.
	// owner is a strict superset of admin (rank comparison, not a literal):
	// gating the confirmation on !== "admin" made granting owner REMOVE the
	// admin's confirmation-free shell — the field bug from 2026-10-31.
	if (opts.needConfirmation && ROLE_RANK[role] < ROLE_RANK.admin && !isExplicitConfirmation(actor.text)) {
		return refuse("该操作会执行命令。请明确说明要执行的操作，并在当前消息中包含「确认」（或同义明确肯定语）。");
	}
	return { actor, role };
}

export interface ShellToolDeps {
	config: ConfigStore;
	resolveActor: (conversationId: string) => ActorContext;
	/** Called after a successful write so cached sessions rebuild on next turn. */
	onConfigChanged: () => void;
	conversationId: string;
	/** Persistent audit log (usually userData/logs/shell-audit.log). */
	auditLogPath?: string;
	/**
	 * Process-hygiene contract ledger (<profileDir>/process-contracts.json).
	 * Absent = the register/list/remove contract actions refuse; scans run
	 * without the contract hold-check.
	 */
	processContractsPath?: string;
}

/** Best-effort append-only audit; command output is deliberately never persisted. */
function audit(path: string | undefined, event: Record<string, unknown>): void {
	if (!path) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n", "utf8");
	} catch (err) {
		console.error("[shell] audit write failed:", err instanceof Error ? err.message : String(err));
	}
}

interface SessionEntry {
	process: CommandSession;
	command: string;
	conversationId: string;
	ownerId: string;
	channel: string;
	background: boolean;
}

// ConfigStore is instance-scoped and survives tool/session rebuilds. Logs stay
// in memory, with bounded retention; command output is never written to audit.
const sessionStores = new WeakMap<ConfigStore, Map<string, SessionEntry>>();
const MAX_RUNNING_COMMANDS = 16;
const MAX_RETAINED_SESSIONS = 100;
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

function sessionsFor(config: ConfigStore): Map<string, SessionEntry> {
	let sessions = sessionStores.get(config);
	if (!sessions) {
		sessions = new Map();
		sessionStores.set(config, sessions);
	}
	const cutoff = Date.now() - SESSION_RETENTION_MS;
	for (const [id, entry] of sessions) {
		if (entry.process.endedAt !== null && (entry.process.endedAt < cutoff || sessions.size >= MAX_RETAINED_SESSIONS)) sessions.delete(id);
	}
	return sessions;
}

export function hasActiveShellCommands(config: ConfigStore): boolean {
	return [...(sessionStores.get(config)?.values() ?? [])].some((entry) => entry.process.status === "running");
}

/** Application-owned sessions end on app shutdown, including detached POSIX groups. */
export function disposeShellCommands(config: ConfigStore): void {
	for (const entry of sessionStores.get(config)?.values() ?? []) entry.process.stop();
	sessionStores.delete(config);
}

/** Running background sessions for one conversation — consumed by the manager's
 * turn-settle inventory (field 2026-11-04: a monitor script kept running after
 * the result was already pushed and nothing told the user; silent strays read
 * as delivery bugs). Read-only snapshot; never kills anything. */
/**
 * Stop every RUNNING background process owned by a conversation (process trees:
 * a Playwright browser is a child of its python script and dies with it).
 *
 * Field 2026-11-06 (box Nova): the admin cancelled task b605b244, but its
 * 15–20min query script + browser kept running and held spay_profile, blocking
 * every later login with PROFILE_MASTER_BUSY. A cancelled/aborted turn must
 * not orphan the resources it started.
 *
 * Returns the killed entries for audit logging. Never throws: cascade cleanup
 * must not break the abort path it rides on.
 */
export function stopBackgroundProcesses(
	config: ConfigStore,
	conversationId: string,
	auditLogPath?: string,
): Array<{ sessionId: string; pid: number | null; command: string }> {
	const stopped: Array<{ sessionId: string; pid: number | null; command: string }> = [];
	try {
		for (const entry of sessionsFor(config).values()) {
			if (entry.conversationId !== conversationId || entry.process.status !== "running") continue;
			try {
				entry.process.stop();
			} catch {
				// keep sweeping the rest even if one stop fails
			}
			stopped.push({ sessionId: entry.process.id, pid: entry.process.pid ?? null, command: entry.command });
			audit(auditLogPath, { event: "cascade_kill", conversationId, sessionId: entry.process.id, pid: entry.process.pid ?? null });
		}
	} catch {
		// registry access itself failed — the abort must still proceed
	}
	return stopped;
}

export function runningBackgroundProcesses(
	config: ConfigStore,
	conversationId: string,
): Array<{ sessionId: string; pid: number | null; command: string }> {
	return [...sessionsFor(config).values()]
		.filter((entry) => entry.conversationId === conversationId && entry.process.status === "running")
		.map((entry) => ({ sessionId: entry.process.id, pid: entry.process.pid ?? null, command: entry.command }));
}

/** Extract the first executable token from a command line (quotes/args stripped). */
function executableToken(command: string): { raw: string; name: string; tokenLength: number; extension: string } {
	const trimmed = command.trim();
	const m = trimmed.match(/^"([^"]+)"|^([^\s]+)/);
	const token = m?.[0] ?? "";
	const raw = m?.[1] ?? m?.[2] ?? "";
	const ext = raw.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
	return {
		raw,
		name: raw.toLowerCase().replace(/\.(exe|bat|cmd|com|ps1|js)$/i, ""),
		tokenLength: token.length,
		extension: ext,
	};
}

/**
 * Reject cmd.exe composition before checking the executable whitelist. Without
 * this, `tasklist & del ...` would pass because only the first executable is
 * tasklist. Environment expansion is rejected too: `%X%` / `!X!` can inject
 * shell metacharacters after the original string has passed validation.
 *
 * A whitelisted executable (notably powershell/node/npx) can still interpret
 * its OWN script argument — that is intentional and is why these entries are
 * documented as high-trust whitelist choices.
 */
const CMD_COMPOSITION_RE = /[&|<>^()\r\n\0%!]/;

/** Built-in argument policy for the conservative default command set. */
function checkArguments(exe: string, command: string): string | null {
	const args = command.trim().slice(executableToken(command).tokenLength).trim();
	if (exe === "taskkill") {
		const tokens = args.split(/\s+/).filter(Boolean);
		let pidCount = 0;
		let forceCount = 0;
		for (let i = 0; i < tokens.length; i += 1) {
			if (/^\/pid$/i.test(tokens[i]) && /^\d+$/.test(tokens[i + 1] ?? "")) {
				pidCount += 1;
				i += 1;
				continue;
			}
			if (/^\/f$/i.test(tokens[i])) {
				forceCount += 1;
				continue;
			}
			return "taskkill 只允许本机单个 PID：taskkill /PID <数字> [/F]；不允许 /IM、/T、远程目标或其它参数。";
		}
		if (pidCount !== 1 || forceCount > 1) {
			return "taskkill 必须且只能指定一个数字 PID（可选一个 /F），例如 taskkill /PID 19060 /F。";
		}
	}
	if ((exe === "tasklist" || exe === "systeminfo") && /(^|\s)\/(s|u|p)\b/i.test(args)) {
		return `${exe} 只允许查询本机；不允许 /S、/U、/P 等远程目标或凭据参数。`;
	}
	if (exe === "ipconfig" && args && !/^\/(all|\?)$/i.test(args)) {
		return "ipconfig 只允许无参数、/all 或 /?；不允许 release/renew/flushdns 等会改变系统状态的参数。";
	}
	return null;
}

/** The whitelist gate: one non-composed command; "*" allows any executable. */
function checkWhitelist(command: string, allowed: string[]): { ok: true } | { ok: false; reason: string } {
	const executable = executableToken(command);
	const exe = executable.name;
	if (!exe) return { ok: false, reason: `无法识别命令的可执行文件（命令：${command.slice(0, 80)}）` };
	if (/[\\/:]/.test(executable.raw)) {
		return {
			ok: false,
			reason: "不允许通过绝对/相对路径指定可执行文件；请只填写白名单中的命令名（如 tasklist、taskkill、npx）。",
		};
	}
	if (executable.extension && executable.extension !== "exe" && executable.extension !== "com") {
		return {
			ok: false,
			reason: `不允许以 .${executable.extension} 脚本扩展名冒充白名单命令；请使用命令名或系统 .exe/.com 可执行文件。`,
		};
	}
	if (CMD_COMPOSITION_RE.test(command)) {
		return {
			ok: false,
			reason: "命令包含管道、串联、重定向、分组或变量展开等 shell 控制语法；run_command 每次只允许执行一条独立命令。",
		};
	}
	if (!allowed.includes("*") && !allowed.includes(exe)) {
		return {
			ok: false,
			reason: `命令可执行文件「${exe}」不在白名单内（当前白名单：${allowed.length ? allowed.join("、") : "（空，管理员可在设置中配置）"}）。`,
		};
	}
	const argumentRefusal = checkArguments(exe, command);
	return argumentRefusal ? { ok: false, reason: argumentRefusal } : { ok: true };
}

/** Commands guaranteed to resolve to trusted Windows system binaries. */
const SYSTEM32_COMMANDS = new Set([
	"tasklist", "taskkill", "ping", "ipconfig", "systeminfo", "whoami", "hostname", "netstat", "where",
]);

/**
 * Split an argument tail into argv Windows-style: whitespace-separated tokens
 * with double-quote grouping (e.g. tasklist /FI "PID eq 19060"). The input has
 * already passed composition validation (no & | < > ^ ( ) % ! newlines), so
 * only quotes, spaces and tabs need handling here.
 */
function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let inQuotes = false;
	for (const ch of input) {
		if (ch === '"') {
			inQuotes = !inQuotes;
			started = true;
			continue;
		}
		if (!inQuotes && (ch === " " || ch === "\t")) {
			if (started || current.length > 0) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += ch;
	}
	if (started || current.length > 0) tokens.push(current);
	return tokens;
}

/**
 * How runCommand will execute a validated command.
 *
 * The built-in diagnostic set spawns the System32 binary DIRECTLY with an argv
 * array. Rewriting them through `cmd /c "<full path>"` broke in the packaged
 * app: Node escapes embedded quotes to \" when building the Windows command
 * line, cmd doesn't understand backslash-quote and strips per its own rules —
 * the executable ended up mangled ("not recognized as an internal or external
 * command"). Direct argv spawning sidesteps cmd's quoting entirely.
 *
 * Opt-in interpreter entries (powershell/node/npx added by admins) still go
 * through cmd /c unchanged — their command lines are free-form by design.
 */
type ExecutionPlan =
	| { mode: "direct"; file: string; args: string[] }
	| { mode: "shell"; command: string };

function planExecution(command: string): ExecutionPlan {
	if (process.platform !== "win32") return { mode: "shell", command };
	const executable = executableToken(command);
	if (!SYSTEM32_COMMANDS.has(executable.name)) return { mode: "shell", command };
	const argsTail = command.trim().slice(executable.tokenLength).trim();
	return {
		mode: "direct",
		file: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\${executable.name}.exe`,
		args: tokenizeArgs(argsTail),
	};
}

/** Kill the whole spawned process tree; `child.kill()` only kills cmd.exe on Windows. */
function killProcessTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			const killer = spawn(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`, ["/pid", String(pid), "/t", "/f"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("error", () => { /* best effort; task may already be gone */ });
			killer.unref();
		} catch {
			/* best effort; the timeout response must still return */
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
	}
}

/**
 * Chinese Windows systems run cmd.exe in GBK (CP936) while our decoder is
 * UTF-8 — any Chinese path/filename in the output turns to mojibake (field
 * 2026-10-06: MuMu share folder listing was unreadable). Force the UTF-8 code
 * page for the composed command. The `&` composition is internal: the user's
 * command was already validated as a single command before we got here.
 */
export function wrapWindowsShellCommand(command: string): string {
	return `chcp 65001 >nul & ${command}`;
}

/** Spawn once and retain supervision independently of any tool's wait. */
function startCommand(command: string, timeoutSec: number, workingDir?: string): CommandSession {
	const plan = planExecution(command);
	const common = {
		stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe" | "ipc" | number)[],
		windowsHide: true,
		detached: process.platform !== "win32",
		cwd: workingDir,
		env: {
			...process.env,
			COMSPEC: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`,
			// chcp only fixes console CP — python writing to a PIPE uses the ANSI
			// locale CP and stays GBK. PYTHONUTF8=1 is the documented fix.
			...(process.platform === "win32" ? { PYTHONUTF8: "1" } : {}),
			...(process.platform === "win32" ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
		},
	};
	let child: ChildProcess;
	if (plan.mode === "direct") child = spawn(plan.file, plan.args, common);
	else if (process.platform === "win32") child = spawn(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`, ["/d", "/s", "/c", wrapWindowsShellCommand(plan.command)], common);
	else child = spawn("/bin/sh", ["-c", plan.command], common);
	return new CommandSession(child, timeoutSec, killProcessTree);
}

function sessionResult(entry: SessionEntry, offset?: number) {
	const proc = entry.process;
	const log = proc.readLog(offset);
	const timeoutKey = entry.background ? "backgroundTimeoutSec" : "timeoutSec";
	const state = proc.status === "running" ? "⏳ 仍在运行；等待结束不会终止进程，请继续用 manage_process poll/log 跟踪。"
		: proc.status === "timed_out" ? `⏱️ 命令超过 ${proc.timeoutSec} 秒未结束，已请求强制终止进程树（可能未完成任务）。可调整 capabilities.shell.${timeoutKey}。`
			: proc.status === "killed" ? "命令已取消，已请求终止进程树。"
				: proc.status === "failed" ? "⚠️ 命令启动失败。" : `exit code = ${proc.code}`;
	return {
		content: [{ type: "text" as const, text: `命令：${entry.command}\n会话：${proc.id}（pid=${proc.pid ?? "无"}）\n${state}\n日志 nextOffset=${log.nextOffset}${log.hasMore ? "，仍有后续日志" : ""}${log.truncated ? "；较早日志已超出保留范围" : ""}\n\n${log.output || "（暂无输出；进程已创建不等于脚本已就绪）"}` }],
		details: {
			sessionId: proc.id, pid: proc.pid ?? null, command: entry.command, background: entry.background,
			status: proc.status, code: proc.code, timedOut: proc.status === "timed_out", timeoutSec: proc.timeoutSec,
			startedAt: proc.startedAt, durationMs: (proc.endedAt ?? Date.now()) - proc.startedAt,
			...log, output: log.output.slice(0, 2000),
		},
	};
}

/**
 * Execute one command under the full policy (role gate, allowlist, audit,
 * session bookkeeping, timeouts).
 *
 * Exported because `run_script` must NOT grow its own executor: a second path
 * would drift from the role gate and the executable allowlist, and the weaker
 * of the two becomes the way in. `run_script` builds the command line and calls
 * this.
 */


export async function executeCommand(
	deps: ShellToolDeps,
	input: { command?: string; workingDir?: string; background?: boolean },
	signal?: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
	const { command, workingDir, background = false } = input;


			if (typeof background !== "boolean") return refuse("background 必须是布尔值。");
			if (signal?.aborted) return refuse("本次命令执行已取消。");
			const raw = (command ?? "").trim();
			if (!raw) return refuse("command 不能为空。");
			if (raw.length > 2000) return refuse("命令过长（>2000 字符），拒绝执行。");

			// Process-hygiene execution gate (user ruling 2026-11-10). Checks the raw
			// command AND the content of any referenced script file (.ps1/.sh/.py/
			// .cmd/.bat — the 2026-11-10 incident travelled as `powershell -File
			// kill_pw_chrome.ps1`, invisible on the command line itself). Role-
			// independent and before any authorization: even admin full-shell must
			// not silently run incident-shaped cleanup scripts. Every rejection is
			// audited (the gate-silence lesson from v0.2.173).
			const hygieneReason = gateDangerousKillForCommand(raw, { workingDir: (workingDir ?? "").trim() });
			if (hygieneReason) {
				audit(deps.auditLogPath, { event: "hygiene_gate_reject", command: raw });
				console.log(`[shell] hygiene gate rejected: ${raw.slice(0, 200)}`);
				return refuse(hygieneReason);
			}

			const gate = gateCommandRole(deps);
			if ("content" in gate) return gate;

			const shell = deps.config.all().capabilities?.shell;
			if (!shell?.enabled) {
				return refuse("受限命令执行能力未开启。管理员可在单聊使用 manage_capabilities set shell true 开启（需确认），或在设置页开启。");
			}
			// Operator: allowlist + composition-free single command (the original
			// restricted-shell contract). Admin: full shell — the jump box is a
			// dedicated VM, admins are human-verified, and every run is audited.
			if (ROLE_RANK[gate.role] < ROLE_RANK.admin) {
				const gateResult = checkWhitelist(raw, shell.allowedCommands);
				if (!gateResult.ok) return refuse(gateResult.reason);
			}

			// Validate workingDir: an absolute, composition-free path. It only
			// sets where the process runs, not what runs — but it must not be a
			// vector for shell metacharacters.
			let cwd: string | undefined;
			const dir = (workingDir ?? "").trim();
			if (dir) {
				if (CMD_COMPOSITION_RE.test(dir) || /["']/.test(dir)) {
					return refuse("workingDir 含 shell 控制字符或引号，拒绝执行。");
				}
				const isAbs = process.platform === "win32" ? /^[a-zA-Z]:[\\/]/.test(dir) : dir.startsWith("/");
				if (!isAbs) return refuse("workingDir 必须是绝对路径（如 C:\\Users\\me\\project）。");
				cwd = dir;
			}

			// Audit before running: masked admin id + the exact command line. A
			// scheduler actor records that this ran unattended under the task
			// creator's re-attached identity.
			const actorId = maskId(gate.actor.senderId);
			const via = isSchedulerActor(gate.actor) ? "scheduler" : gate.actor.channel;
			const timeoutSec = background ? shell.backgroundTimeoutSec : shell.timeoutSec;
			const sessions = sessionsFor(deps.config);
			if ([...sessions.values()].filter((entry) => entry.process.status === "running").length >= MAX_RUNNING_COMMANDS) {
				return refuse(`已有 ${MAX_RUNNING_COMMANDS} 条命令在运行，请先用 manage_process 查看或结束已有任务。`);
			}
			const proc = startCommand(raw, timeoutSec, cwd);
			const entry: SessionEntry = { process: proc, command: raw, conversationId: deps.conversationId, ownerId: gate.actor.senderId, channel: via, background };
			sessions.set(proc.id, entry);
			console.log(`[shell] run_command by ${actorId} (${via}) session=${proc.id} background=${background} timeout=${timeoutSec}s: ${raw}`);
			audit(deps.auditLogPath, { event: "start", actor: actorId, channel: via, sessionId: proc.id, command: raw, cwd: cwd ?? null, timeoutSec, background });
			void proc.completed.then(() => {
				audit(deps.auditLogPath, { event: "finish", actor: actorId, sessionId: proc.id, command: raw, code: proc.code, status: proc.status, timedOut: proc.status === "timed_out", durationMs: (proc.endedAt ?? Date.now()) - proc.startedAt, timeoutSec, background });
			});
			await proc.started;
			if (!background) {
				const abort = () => proc.stop();
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				try { await proc.completed; }
				finally { signal?.removeEventListener("abort", abort); }
			}
			return sessionResult(entry);
}

/**
 * Conversation-side restricted shell tool for headless Windows servers where
 * nobody can open a terminal: inspect processes (tasklist), stop one PID
 * (taskkill), and inspect local system/network state.
 *
 * The execute body lives in `executeCommand`, shared with `run_script` — the
 * tool itself is description + parameters + delegation, nothing else.
 */
export function createRunCommandTool(deps: ShellToolDeps): AgentTool {
	return {
		name: "run_command",
		label: "命令执行（分级）",
		description:
			"在部署机器上按角色分级执行 shell 命令（单聊群聊均可，按平台验证的发送者身份与角色授权；operator 需在当前消息明确「确认」，admin 直接执行）。" +
			"权限分级：viewer 不可执行；operator 只能执行 capabilities.shell.allowedCommands 白名单内的可执行文件（* 表示全部），且串联、管道、重定向、变量展开、脚本扩展名和可执行文件路径均被拒绝，每次只跑一条独立命令；" +
			"admin 不受白名单与组合语法限制（完整 shell：可用 powershell -Command 管道、重定向、脚本串联等），仅工作目录仍须为不含引号的绝对路径。" +
			"默认用于运维诊断：tasklist 查看进程、taskkill 按单个 PID 结束进程、systeminfo/whoami/hostname/netstat/ping/ipconfig 查看本机状态。" +
			"**创建或修改脚本文件用 write_text_file**（内容作为参数原样落盘，零转义；不要用本工具内联 echo/Set-Content/python -c 写文件——shell 引号与脚本语言双重转义在 Windows 上反复失败）。**要跑自带脚本且需要传参数时，用 run_script 而不是本工具**：它把参数写成 JSON 文件，命令行里不含任何用户数据，因此不会遇到 cmd 重新分词、引号转义、中文参数乱码这三类问题（这三类问题在 Windows 上极难排查，常见表现为参数被拆开、Cannot find module、中文变问号）。只有在必须拼完整命令行时才用 run_command。" +
			"Windows shell 命令已强制 UTF-8 代码页（cmd 内建命令与 powershell 输出正常；tasklist 等 System32 直连命令与 python 管道输出仍可能是 GBK，中文乱码时改用 list_directory 或脚本写文件再读）；含中文/空格的路径必须整体用双引号包住；列目录、查文件元数据优先用 list_directory（原生支持中文路径，无引号转义问题），run_command 留给真正需要执行程序的场景。" +
			"**同步命令有硬超时（capabilities.shell.timeoutSec，默认 300 秒）**：预计更久一律传 background=true（启动即返回 sessionId，再用 manage_process poll/log 阻塞等待 / kill 终止；等待超时只返回当前状态，不杀后台进程）。被超时强杀后不要原样重试同一脚本——要么改后台方式跑，要么先把脚本本身改成分段/增量可续。playwright、数据拉取、大批量文件处理这类几乎必然超过 300 秒，直接 background。后台进程时限用 backgroundTimeoutSec（默认 0=不限制），管理员可用 manage_settings 修改。" +
			"采集逻辑先写入 .ps1/.py 脚本，命令只用 powershell -File xxx.ps1 或 python xxx.py，参数通过本地文件传递；脚本先输出 observer start 与时间戳，首次 poll/log 检查启动日志，不能把返回 sessionId 当成任务完成。会话由本应用托管，应用退出会终止进程，重启后不可续接；不要再用 nohup 或自制脱管 launcher。" +
			"powershell/node/npx 等解释器需管理员显式加入白名单（admin 角色无需）；安装 Chromium 请改用 manage_capabilities setup_browser。" +
			"安全规则：默认关闭；operator 每次执行需在消息中明确包含「确认」/confirm/yes/ok；admin（平台验证身份）发起即授权，直接执行，全部审计留痕。命令以当前应用用户权限运行，不会自动提权。" +
			"可选 workingDir：命令的工作目录（绝对路径，如 C:\Users\me\project），脚本用相对路径读写数据文件时需要；不影响可执行文件白名单。定时任务无人值守执行时，run_command 以任务创建者身份放行（按该用户当前角色定级），无需消息内含「确认」，但 operator 的白名单校验照常生效。" +
			"执行闸：命令文本及引用的脚本文件内容（.ps1/.sh/.py/.cmd/.bat）命中「ms-playwright/chrome-headless-shell + 杀进程原语」或 killall / pkill -f / Stop-Process -Name / taskkill /im|/t 时直接拒绝，并指路 manage_process scan→kill_pid 两段式；显式 taskkill /pid <n>（无 /im、无 /t）按 PID 定点杀，不受影响。",
		parameters: obj({
			command: str({ description: `要执行的命令，如「tasklist /FI "PID eq 19060"」「taskkill /PID 19060 /F」「python scripts/gen_report.py」。跑脚本直接给脚本文件路径，不要用 python -c 内联代码（括号会被拦截）。` }),
			workingDir: opt(str({ description: "可选：命令的工作目录绝对路径，如 C:\Users\admin\project。脚本按相对路径找数据文件时必填。" })),
			background: opt(bool({ description: "true=后台启动并返回 sessionId，再用 manage_process poll/log 跟踪；默认 false=同步等待命令结束。" })),
		}, { open: true }),
		async execute(_toolCallId, params, signal) {
			return executeCommand(deps, params as { command?: string; workingDir?: string; background?: boolean }, signal);
		},
	};
}

function confirmsProcessStop(text: string): boolean {
	// The ordinary command gate treats "stop/终止" as cancellation. For the
	// explicit kill action those words name the requested operation instead.
	if (/不(?:用|要|能|该|应|得|许)?(?:终止|停止|结束|杀|执行)|禁止|请勿|\b(?:cannot|can't)\b/i.test(text)) return false;
	return isExplicitConfirmation(text.replace(/终止|停止|\bstop\b/gi, "执行"));
}

/** Inspect only the caller's sessions in this conversation; mutations remain confirmed. */

/** The five process-hygiene actions dispatched to tools/process-hygiene.ts. */
const HYGIENE_ACTIONS = new Set(["scan", "kill_pid", "register_contract", "list_contracts", "remove_contract"]);

export function createManageProcessTool(deps: ShellToolDeps): AgentTool {
	return {
		name: "manage_process",
		label: "命令会话管理",
		description:
			"管理 run_command 创建的进程会话：list 列出当前会话中的命令；poll 阻塞等到进程结束或单次等待超时；log 立即读日志；kill 终止进程树（管理员当前消息需「确认」）。" +
			"poll/log/list 无需重复确认，但每次都校验当前管理员身份，只能访问自己在当前对话启动的命令。定时任务可跟踪自身会话。关闭 shell 开关后仍可查询和终止已有会话。" +
			"poll 的 waitSec 仅控制此次等待，默认 capabilities.shell.pollTimeoutSec（30 秒），0=立即返回；无论等待超时还是取消等待，都不会终止后台进程。长等待可提高 waitSec（如 840 秒），避免连续短轮询。" +
			"log/poll 返回 stdout+stderr 与 nextOffset；下次传 offset=nextOffset 只读新增输出。未传 offset 默认显示最新一页，每页最多 32KB，内存保留最近 256KB；完整结果请脚本写文件。先确认 observer start 启动日志，再持续跟踪到退出并核对退出码，不能把 running 当作成功。等待期间用 log 跟踪脚本打印的进度：一旦输出表明需要人参与（等待验证码/确认/输入等），立即前台提问，不要等脚本退出才交互。应用退出会终止进程，重启后会话失效。" +
			"进程卫生（2026-11-10 事故裁定，结构性强制）：清理残留浏览器/杀非本会话进程必须走内置两段式，不要手写清理脚本（含 ms-playwright+Kill/Stop-Process/taskkill /im/killall/pkill -f 的命令或脚本会被执行闸拦截）。" +
			"scan（pattern 默认 chrome*，同时覆盖 chrome-headless-shell；minAgeMin 默认 10）跨平台扫描并按权威度做四道持有判定：调试通道（port|pipe）/父进程存活/年龄/契约在册，输出 SKIP/CANDIDATE 候选表和 10 分钟有效的 ticket。" +
			"kill_pid（ticket+pid 必填）在 kill 前重新判定（TOCTOU），状态已变化则拒绝并要求重新 scan；TERM 5 秒无效才升级强杀，无树杀。" +
			"长任务（超过 2 分钟）启动时 register_contract(pid, purpose, expectedMinutes, killConditions) 登记，结束时 remove_contract(pid) 注销，list_contracts 查看——在册 pid 会被 scan 判 SKIP。",
		parameters: obj({
			action: union([lit("list"), lit("poll"), lit("log"), lit("kill"), lit("scan"), lit("kill_pid"), lit("register_contract"), lit("list_contracts"), lit("remove_contract")]),
			sessionId: opt(str({ description: "poll/log/kill 必填：run_command 返回的 sessionId。" })),
			waitSec: opt(int({ minimum: 0, maximum: MAX_TIMEOUT_SEC, description: "仅 poll：单次最长等待秒数，默认读配置（30 秒），0=立即返回；不影响命令运行时限。" })),
			offset: opt(int({ minimum: 0, description: "日志字节游标，传上次 nextOffset 读取增量；0 从保留日志开头读取，省略显示最新一页。" })),
			pattern: opt(str({ maxLength: 200, description: "仅 scan：进程名通配（chrome* 同时覆盖 chrome-headless-shell）或路径/命令行子串；默认 chrome*。" })),
			minAgeMin: opt(int({ minimum: 0, maximum: 1440, description: "仅 scan：启动不足该分钟数视为活跃（判 SKIP），默认 10。" })),
			ticket: opt(str({ description: "仅 kill_pid：scan 返回的 ticket。" })),
			pid: opt(int({ minimum: 1, description: "kill_pid/register_contract/remove_contract 必填：目标进程 PID。" })),
			purpose: opt(str({ maxLength: 500, description: "仅 register_contract：任务用途（必填）。" })),
			expectedMinutes: opt(int({ minimum: 0, description: "仅 register_contract：预期运行分钟数。" })),
			killConditions: opt(str({ maxLength: 500, description: "仅 register_contract：什么条件下可以终止。" })),
		}, { open: true }),
		async execute(_toolCallId, params, signal) {
			const { action, sessionId, waitSec, offset } = params as { action: string; sessionId?: string; waitSec?: number; offset?: number };
			if (!["list", "poll", "log", "kill", ...HYGIENE_ACTIONS].includes(action)) {
				return refuse("action 必须是 list/poll/log/kill/scan/kill_pid/register_contract/list_contracts/remove_contract。");
			}
			const gate = gateCommandRole(deps, { needConfirmation: false });
			if ("content" in gate) return gate;
			if (action === "kill" && !isSchedulerActor(gate.actor) && !confirmsProcessStop(gate.actor.text)) {
				return refuse("终止命令进程树需要管理员在当前消息中明确确认，例如「确认终止这个任务」。");
			}
			// Process-hygiene actions (scan / kill_pid / contract ledger) dispatch to
			// the dedicated module; authorization already ran above. The list/poll/
			// log/kill semantics below are untouched by it.
			if (HYGIENE_ACTIONS.has(action)) {
				return handleProcessHygieneAction(deps, params as ProcessHygieneParams, {
					actorId: gate.actor.senderId,
					channel: gate.actor.channel,
				}) as never;
			}
			const own = (entry: SessionEntry) => entry.ownerId === gate.actor.senderId && entry.channel === gate.actor.channel && entry.conversationId === deps.conversationId;
			const sessions = sessionsFor(deps.config);
			if (action === "list") {
				const rows = [...sessions.values()].filter(own).map((entry) => ({
					sessionId: entry.process.id, pid: entry.process.pid ?? null, command: entry.command,
					status: entry.process.status, code: entry.process.code, timeoutSec: entry.process.timeoutSec,
					startedAt: entry.process.startedAt, background: entry.background,
				}));
				// Anti-duplicate hint (field 2026-11-06): one window started the same
				// long-lived driver script FOUR times because nothing told it an
				// identical one was already running. A plain list is easy to skim
				// past, so say it explicitly.
				const running = rows.filter((r) => r.status === "running");
				const byCommand = new Map<string, number>();
				for (const r of running) byCommand.set(r.command, (byCommand.get(r.command) ?? 0) + 1);
				const dupes = [...byCommand.entries()].filter(([, n]) => n > 1);
				const dupNote = dupes.length
					? `\n\n⚠️ 有 ${dupes.length} 条命令存在重复运行实例（同一条命令被启动了多次），先 kill 掉多余实例再启动新的：\n${dupes.map(([cmd, n]) => `  · ${n} 个：${cmd.slice(0, 120)}`).join("\n")}\n常驻/循环脚本（while True、文件轮询、等待输入的驱动）在任务结束或不再需要时必须 kill；启动前先 list 确认没有同类在跑。`
					: "";
				return { content: [{ type: "text", text: rows.length ? JSON.stringify(rows, null, 2) + dupNote : "当前对话没有可访问的命令会话。" }], details: { sessions: rows, duplicates: dupes.length } };
			}
			const entry = sessionId ? sessions.get(sessionId) : undefined;
			if (!entry || !own(entry)) return refuse("找不到可访问的命令会话；请使用当前对话的 manage_process list 查询。应用重启后旧会话失效。");
			if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) return refuse("offset 必须是非负安全整数。");
			if (action === "poll") {
				const seconds = waitSec ?? deps.config.all().capabilities.shell.pollTimeoutSec;
				if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_TIMEOUT_SEC) return refuse(`waitSec 必须是 0～${MAX_TIMEOUT_SEC} 的整数秒数。`);
				await entry.process.wait(seconds, signal);
			} else if (action === "kill") {
				audit(deps.auditLogPath, { event: "kill", actor: maskId(gate.actor.senderId), sessionId: entry.process.id });
				entry.process.stop();
			}
			return sessionResult(entry, offset);
		},
	};
}
