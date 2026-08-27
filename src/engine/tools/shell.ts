/**
 * Restricted command execution for headless-server operations.
 *
 * Authorizes a platform-verified 1:1 admin (same gate as manage_admin /
 * manage_update), requires the command's executable to be on the
 * `capabilities.shell.allowedCommands` whitelist, and runs the command via
 * `cmd /c` on Windows (the target deployment is a locked-down Windows server
 * with no visible desktop). Every execution is audited (masked admin id +
 * command), truncated to avoid flooding the reply, and bounded by a hard
 * timeout so a hung `taskkill`/install can never wedge the conversation.
 *
 * Safety posture:
 *  - Shell execution is OFF by default (`capabilities.shell.enabled=false`).
 *  - Each run_command call requires the CURRENT message to contain an explicit
 *    confirmation (the model can't self-authorize by passing a flag).
 *  - Only executables on the whitelist may be run; "*" is supported but
 *    documented as "full server control from a stolen admin IM account".
 *  - The command runs with the parent's user token (not elevated); anything
 *    needing elevation fails cleanly instead of silently partial-running.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigStore } from "../../db/config-store.js";
import { maskId, refuse, requireConfirmedAdmin, type ActorContext } from "./admin.js";

export interface ShellToolDeps {
	config: ConfigStore;
	resolveActor: (conversationId: string) => ActorContext;
	/** Called after a successful write so cached sessions rebuild on next turn. */
	onConfigChanged: () => void;
	conversationId: string;
	/** Persistent audit log (usually userData/logs/shell-audit.log). */
	auditLogPath?: string;
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

/** Output cap per run — commands like `dir /s` or VM stats can be large. */
const MAX_OUTPUT_BYTES = 32_000;
/** Hard runtime cap; taskkill/install/VM operations must return or be killed. */
const RUN_TIMEOUT_MS = 60_000;

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

/** Run the planned execution; resolve stdout+stderr, truncate, enforce timeout. */
function runCommand(command: string): Promise<{ output: string; code: number | null; timedOut: boolean }> {
	const plan = planExecution(command);
	return new Promise((resolve) => {
		const common = {
			stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe" | "ipc" | number)[],
			windowsHide: true,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				COMSPEC: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`,
				// Packed app: process.execPath is the GUI exe; anything we exec as a
				// plain Node script needs this flag instead of launching a second GUI.
				...(process.platform === "win32" ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
			},
		};
		let child: ChildProcess;
		if (plan.mode === "direct") {
			child = spawn(plan.file, plan.args, common);
		} else if (process.platform === "win32") {
			child = spawn(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`, ["/d", "/s", "/c", plan.command], common);
		} else {
			child = spawn("/bin/sh", ["-c", plan.command], common);
		}
		const kept: Buffer[] = [];
		let keptBytes = 0;
		let totalBytes = 0;
		let settled = false;
		const collect = (chunk: Buffer) => {
			totalBytes += chunk.length;
			const remaining = MAX_OUTPUT_BYTES - keptBytes;
			if (remaining <= 0) return;
			const part = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
			kept.push(part);
			keptBytes += part.length;
		};
		const outputText = () => {
			const body = Buffer.concat(kept, keptBytes).toString("utf8").trim();
			return body + (totalBytes > MAX_OUTPUT_BYTES ? `\n…（输出 ${totalBytes} 字节，已截断）` : "");
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			killProcessTree(child.pid);
			resolve({ output: outputText(), code: null, timedOut: true });
		}, RUN_TIMEOUT_MS);
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.once("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ output: `⚠️ 无法启动命令：${e.message}`, code: null, timedOut: false });
		});
		child.once("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ output: outputText(), code, timedOut: false });
		});
	});
}

/**
 * Conversation-side restricted shell tool for headless Windows servers where
 * nobody can open a terminal: inspect processes (tasklist), stop one PID
 * (taskkill), and inspect local system/network state.
 */
export function createRunCommandTool(deps: ShellToolDeps): AgentTool {
	return {
		name: "run_command",
		label: "受限命令执行",
		description:
			"在部署机器上执行受限的 shell 命令（仅限 IM 单聊，需系统管理员身份且在当条消息明确「确认」）。" +
			"默认用于运维诊断：tasklist 查看进程、taskkill 按单个 PID 结束进程、systeminfo/whoami/hostname/netstat/ping/ipconfig 查看本机状态。" +
			"只允许执行 capabilities.shell.allowedCommands 白名单内的可执行文件（* 表示全部）；命令输出自动截断、60 秒超时；串联、管道、重定向、变量展开、脚本扩展名和可执行文件路径均拒绝。" +
			"powershell/node/npx 等解释器需管理员显式加入白名单；安装 Chromium 请改用 manage_capabilities setup_browser。" +
			"安全规则：默认关闭；每次执行必须由管理员在当前消息中明确包含「确认」/confirm/yes/ok；群聊一律拒绝。命令以当前应用用户权限运行，不会自动提权。",
		parameters: Type.Object({
			command: Type.String({ description: `要执行的命令，如「tasklist /FI "PID eq 19060"」「taskkill /PID 19060 /F」「systeminfo」` }),
		}),
		async execute(_toolCallId, params) {
			const { command } = params as { command?: string };
			const raw = (command ?? "").trim();
			if (!raw) return refuse("command 不能为空。");
			if (raw.length > 512) return refuse("命令过长（>512 字符），拒绝执行。");

			const gate = requireConfirmedAdmin(deps, {
				needConfirmation: true,
				confirmationHint:
					"执行命令会在部署机器上即时运行，请明确说出要执行的命令，并在当前消息中包含「确认」。",
			});
			if ("content" in gate) return gate;

			const shell = deps.config.all().capabilities?.shell;
			if (!shell?.enabled) {
				return refuse("受限命令执行能力未开启。管理员可在单聊使用 manage_capabilities set shell true 开启（需确认），或在设置页开启。");
			}
			const gateResult = checkWhitelist(raw, shell.allowedCommands);
			if (!gateResult.ok) return refuse(gateResult.reason);

			// Audit before running: masked admin id + the exact command line.
			const actorId = maskId(gate.actor.senderId);
			console.log(`[shell] run_command by ${actorId}: ${raw}`);
			audit(deps.auditLogPath, { event: "start", actor: actorId, channel: gate.actor.channel, command: raw });

			const startedAt = Date.now();
			const { output, code, timedOut } = await runCommand(raw);
			const durationMs = Date.now() - startedAt;
			audit(deps.auditLogPath, { event: "finish", actor: actorId, command: raw, code, timedOut, durationMs });
			const head = timedOut
				? `⏱️ 命令超过 60 秒未结束，已强制终止（可能未完成任务）。`
				: `exit code = ${code}`;
			return {
				content: [{ type: "text", text: `已执行：${raw}\n${head}\n\n${output || "（无输出）"}` }],
				details: { command: raw, code, timedOut, output: output.slice(0, 2000) },
			};
		},
	};
}