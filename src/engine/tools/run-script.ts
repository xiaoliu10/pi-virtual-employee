/**
 * `run_script`: run a script file with its arguments passed through a JSON file
 * instead of the command line.
 *
 * ## Why this exists
 *
 * Field, repeatedly (2026-11-03 and before): an agent needed to run
 * `python spay_do_login.py <5 args>`. Every attempt died for a reason that has
 * nothing to do with the script:
 *
 *   1. QUOTING — `cmd.exe /d /s /c` re-tokenizes the command, so a space inside
 *      an argument splits it; `Start-Process` without quotes produced
 *      `Cannot find module '...\Pi'`.
 *   2. ENCODING — Chinese Windows writes CP936; a Chinese path in argv arrives
 *      mangled.
 *   3. ESCAPING — the model must both quote for PowerShell AND escape for the
 *      JS/TS layer above it, and one missed backslash kills the call.
 *
 * All three vanish when argv carries NO data: write the arguments to a JSON
 * file and let the script read it. The command line becomes
 * `python script.py --params-file <path>`, which is a single token sequence
 * with no user data in it.
 *
 * This is not a sandbox. It is the shape that makes the existing execution
 * path work on Windows — which is the actual problem, and the one a container
 * would not have fixed (it would still receive argv, still re-tokenize, and add
 * path-mapping problems on top).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ShellToolDeps } from "./shell.js";

/** Where the parameter files live, relative to the app's user data dir. */
export const PARAM_DIR = "script-params";

/** Script extensions we accept; a path without one is rejected (see below). */
const SCRIPT_EXTENSIONS = [".py", ".ps1", ".js", ".mjs", ".cjs", ".bat", ".cmd", ".sh"];

/** The flag each runtime uses to receive a parameter file. */
const PARAM_FLAG = "--params-file";

export interface RunScriptDeps extends ShellToolDeps {
	/** Absolute path of the profile's user-data directory (holds PARAM_DIR). */
	userDataDir: string;
	/**
	 * Execute a command through the EXISTING run_command path so the role gate,
	 * the executable allowlist, the audit trail and the session bookkeeping all
	 * stay in one place — this tool must not become a second, weaker executor.
	 */
	runCommand: (input: { command: string; workingDir?: string; background?: boolean }) => Promise<
		{ text: string; isError?: boolean }
	>;
}

export function createRunScriptTool(deps: RunScriptDeps): AgentTool {
	return {
		name: "run_script",
		label: "执行脚本（参数走文件）",
		description:
			"执行一个脚本文件，**参数通过 JSON 文件传递，不走命令行**。凡是要给脚本传参数，优先用这个而不是 run_command——" +
			"Windows 的 cmd 会重新切分命令行、中文参数会乱码、引号要转两层，参数写在命令行里极易出错且难以排查。" +
			"本工具把参数写成 JSON 文件，命令行只剩「运行时 + 脚本路径 + --params-file <绝对路径>」，不含任何用户数据。" +
			"支持的脚本类型：.py .ps1 .js/.mjs/.cjs .bat/.cmd .sh（按扩展名选运行时）。" +
			"脚本必须自己读取该文件：python 用 argparse 的 --params-file，PowerShell 用 -ParamsFile，Node 用 --params-file。" +
			"参数文件内容 = params 对象原样序列化（UTF-8），脚本内自行取字段。" +
			"背景任务、超时、白名单、审计与 run_command 完全一致（本工具内部走的就是它）。" +
			"若脚本不支持 --params-file，先用 read/write 能力把参数落到你自己的文件，再 run_command 传该文件路径。",
		parameters: Type.Object({
			script: Type.String({ description: "脚本文件的绝对路径，如 C:\\Users\\me\\work\\spay_do_login.py 或 /opt/ve/job.py。" }),
			params: Type.Optional(
				Type.Union([Type.Record(Type.String(), Type.Any()), Type.String()], {
					description:
						"要传给脚本的参数：一个 JSON 对象（推荐），或已序列化好的 JSON 字符串。省略则写空对象 {}。",
				}),
			),
			runtime: Type.Optional(Type.Union([Type.Literal("python"), Type.Literal("powershell"), Type.Literal("node"), Type.Literal("cmd"), Type.Literal("sh")], {
				description: "运行时；省略则按脚本扩展名推断（.py→python、.ps1→powershell、.js/.mjs/.cjs→node、.bat/.cmd→cmd、.sh→sh）。",
			})),
			workingDir: Type.Optional(Type.String({ description: "可选：脚本的工作目录绝对路径（脚本按相对路径找文件时必填）。" })),
			background: Type.Optional(Type.Boolean({ description: "true=后台启动并返回 sessionId（长任务必选）；默认 false=同步等待。" })),
		}),
		async execute(_toolCallId, params) {
			const input = params as {
				script?: string;
				params?: Record<string, unknown> | string;
				runtime?: "python" | "powershell" | "node" | "cmd" | "sh";
				workingDir?: string;
				background?: boolean;
			};
			const script = (input.script ?? "").trim();
			if (!script) return refuse("script 不能为空，请给出脚本文件的绝对路径。");
			if (!isAbsolute(script)) {
				return refuse(`script 必须是绝对路径（收到「${script}」）。相对路径会随工作目录漂移，容易执行到别的文件。`);
			}
			// A path destined for a shell command line must contain no shell
			// metacharacters. `q()` escapes quotes the cmd way (`""`), but cmd also
			// treats `&`, `|`, `<`, `>`, `^`, `%` and parentheses as syntax OUTSIDE
			// quotes and as expansion triggers INSIDE them — no amount of quoting
			// makes an arbitrary path safe, so refuse the characters outright.
			// (A legitimate script path never contains them.)
			if (/[&|<>^%()\r\n\t]/.test(script)) {
				return refuse(`脚本路径含 shell 元字符（& | < > ^ % ( ) 或换行），拒绝执行：${script}`);
			}
			const ext = script.slice(script.lastIndexOf(".")).toLowerCase();
			if (!SCRIPT_EXTENSIONS.includes(ext)) {
				return refuse(
					`不支持的脚本扩展名「${ext}」。支持：${SCRIPT_EXTENSIONS.join(" ")}。` +
						"如果这是一个可执行程序，请直接用 run_command。",
				);
			}

			// Serialize the parameters. A JSON string is accepted for the case where
			// the model already produced one (re-running a failed attempt verbatim).
			let body: string;
			if (typeof input.params === "string") {
				try {
					JSON.parse(input.params);
				} catch {
					return refuse("params 是字符串时必须是一段合法 JSON；也可以直接传对象。");
				}
				body = input.params;
			} else {
				body = JSON.stringify(input.params ?? {}, null, 2);
			}

			// One directory per SCRIPT FILE so two same-named scripts in different
			// folders never overwrite each other's parameters ("a/job.py" vs
			// "b/job.py" share the stem "job"). The hash suffix distinguishes them;
			// the readable stem stays so the directory is still easy to inspect.
			const stem = paramDirName(script);
			const dir = join(deps.userDataDir, PARAM_DIR, stem);
			const file = join(dir, "params.json");
			try {
				mkdirSync(dirname(file), { recursive: true });
				// UTF-8 without BOM: Node and python both read it as UTF-8, and a BOM
				// would make python's json.load fail on some versions.
				writeFileSync(file, body, "utf8");
			} catch (err) {
				return refuse(`参数文件写入失败：${err instanceof Error ? err.message : String(err)}`);
			}

			const runtime = input.runtime ?? inferRuntime(ext);
			// Quote the two PATHS (they may contain spaces) but never the data: the
			// data is in the file, so nothing here needs escaping for content.
			const command = buildCommand(runtime, script, file);
			const result = await deps.runCommand({
				command,
				workingDir: input.workingDir ? resolve(input.workingDir) : undefined,
				background: input.background,
			});
			const preamble =
				`参数已写入 ${file}\n` +
				`执行：${command}\n` +
				"（脚本需自己读取 --params-file 指向的 JSON；若脚本不认这个参数，请改造脚本或改用 run_command 传文件路径）\n\n";
			return {
				content: [{ type: "text" as const, text: preamble + result.text }],
				isError: result.isError,
			} as never;
		},
	};
}

/**
 * Directory name for a script's parameter file: `<readable stem>-<hash>`.
 *
 * The stem alone is not enough — `C:\a\job.py` and `C:\b\job.py` would share
 * it — so a short hash of the FULL path keeps them apart.
 *
 * Uses `path.basename`, not `lastIndexOf("/")`: on Windows the separator is
 * `\`, so splitting on `/` returned the whole path and every script landed in
 * one directory named after its full path with the separators replaced.
 */
export function paramDirName(script: string): string {
	// `path.basename` follows the RUNNING platform's separator, so on macOS/Linux
	// (where this code is developed and tested) a Windows path like
	// `C:\work\job.py` is treated as one long file name. Split on BOTH
	// separators so the result is right wherever the path came from.
	const base = script.split(/[\\/]/).pop() ?? script;
	const dot = base.lastIndexOf(".");
	const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^\w.-]/g, "_") || "script";
	const hash = createHash("sha1").update(script).digest("hex").slice(0, 8);
	return `${stem}-${hash}`;
}

/** Pick the runtime from the script extension. */
export function inferRuntime(extension: string): "python" | "powershell" | "node" | "cmd" | "sh" {
	switch (extension.toLowerCase()) {
		case ".py":
			return "python";
		case ".ps1":
			return "powershell";
		case ".js":
		case ".mjs":
		case ".cjs":
			return "node";
		case ".bat":
		case ".cmd":
			return "cmd";
		default:
			return "sh";
	}
}

/**
 * Build the command line. Only the two PATHS are quoted (they may contain
 * spaces); no user data appears here, which is the whole point.
 */
export function buildCommand(runtime: string, script: string, paramsFile: string): string {
	// Callers must have rejected shell metacharacters already: `""` is the cmd
	// convention for an embedded quote, but it is not an escape for the surrounding
	// syntax characters, so quoting alone does not make a hostile path safe.
	const q = (p: string) => `"${p.replace(/"/g, '""')}"`;
	switch (runtime) {
		case "python":
			return `python ${q(script)} ${PARAM_FLAG} ${q(paramsFile)}`;
		case "powershell":
			// -File takes the script, and -ParamsFile is forwarded to it as a
			// parameter. -ExecutionPolicy Bypass is required on default Windows
			// policies or the script is refused outright.
			return `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(script)} -ParamsFile ${q(paramsFile)}`;
		case "node":
			return `node ${q(script)} ${PARAM_FLAG} ${q(paramsFile)}`;
		case "cmd":
			return `cmd /c ${q(script)} ${PARAM_FLAG} ${q(paramsFile)}`;
		default:
			return `sh ${q(script)} ${PARAM_FLAG} ${q(paramsFile)}`;
	}
}

/** Uniform refusal block (matches the other tools' shape). */
function refuse(reason: string) {
	return { content: [{ type: "text" as const, text: `⛔ ${reason}` }], details: { refused: true, reason } } as never;
}
