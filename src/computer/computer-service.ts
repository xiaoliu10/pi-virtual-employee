import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, delimiter } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ConfigStore } from "../db/config-store.js";
import { COMPUTER_ACTIONS, type ComputerAction, type ComputerStatus } from "../shared/computer.js";
import { driverInstallDir, findDriver, installDriver } from "./driver-install.js";

type Args = Record<string, unknown>;
const INPUT_ACTIONS = new Set<string>(COMPUTER_ACTIONS.filter(v => !["list_apps", "list_windows", "get_window_state", "launch_app"].includes(v)));
const FIELDS = new Set([
	"pid", "window_id", "element_index", "element_token", "snapshot_id", "x", "y", "on_screen_only",
	"from_x", "from_y", "to_x", "to_y", "duration_ms", "steps", "text", "delay_ms", "key", "keys", "direction", "amount", "by",
	"modifier", "modifiers", "button", "count", "action", "value", "delivery_mode", "include_screenshot",
	"include_accessibility_tree", "max_dimension", "max_depth", "max_elements", "query", "name", "bundle_id", "aumid", "app_id", "path", "launch_path",
]);

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function textResult(text: string, structuredContent?: Args): CallToolResult {
	return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}

/** Cua returns structured data; tolerate envelope changes without parsing labels as executable code. */
export function resultRecords(result: CallToolResult, key: "apps" | "windows"): Args[] {
	const roots: unknown[] = [result.structuredContent];
	for (const block of result.content) if (block.type === "text") {
		try { roots.push(JSON.parse(block.text)); } catch { /* summaries are not JSON */ }
	}
	function visit(value: unknown, depth: number): Args[] | undefined {
		if (depth > 4 || !value || typeof value !== "object") return;
		const obj = value as Args;
		if (Array.isArray(obj[key])) return obj[key].filter(v => v && typeof v === "object") as Args[];
		for (const field of ["data", "result", "output"]) {
			const nested = visit(obj[field], depth + 1);
			if (nested) return nested;
		}
	}
	for (const root of roots) { const found = visit(root, 0); if (found) return found; }
	throw new Error(`Cua 未返回可验证的 ${key} 数据。请检查驱动版本；未执行桌面操作。`);
}

export function appAllowed(app: Args, allowed: string[]): boolean {
	const identities = ["name", "app_name", "bundle_id", "app_id", "exe", "exe_name", "executable", "executable_path", "launch_path", "path", "process_name"]
		.flatMap(key => typeof app[key] === "string" ? [String(app[key]).toLowerCase(), String(app[key]).split(/[\\/]/).pop()!.toLowerCase()] : []);
	if (typeof app.launch_path === "string") {
		const executable = /^(?:"([^"]+)"|(\S+))/.exec(app.launch_path)?.slice(1).find(Boolean);
		if (executable) identities.push(executable.toLowerCase(), executable.split(/[\\/]/).pop()!.toLowerCase());
	}
	return allowed.some(value => value === "*" || identities.includes(value.toLowerCase()));
}

export class ComputerService {
	private client?: Client;
	private transport?: StdioClientTransport;
	private connecting?: Promise<void>;
	private disconnecting?: Promise<void>;
	private tools = new Map<string, Tool>();
	private connectedPath?: string;
	private serverVersion?: string;
	private error?: string;
	private installState: ComputerStatus["install"] = "idle";
	private installProgress = 0;
	private installAbort?: AbortController;
	private installing?: Promise<void>;
	private owner?: string;
	private session?: string;
	private sessionAbort?: AbortController;
	private sessionTimer?: ReturnType<typeof setTimeout>;
	private waiters = new Set<() => void>();
	private activeCalls = 0;
	private snapshots = new Set<string>();
	private disposed = false;
	private configKey: string;
	private generation = 0;
	private stoppedOwners = new Set<string>();

	constructor(private readonly config: ConfigStore, private readonly dataDir: string) {
		this.configKey = JSON.stringify(config.all().computer);
	}

	async syncConfig(): Promise<void> {
		const key = JSON.stringify(this.config.all().computer);
		if (key === this.configKey) return;
		this.configKey = key;
		await this.disconnect();
	}

	get busy(): boolean { return !!this.owner || this.activeCalls > 0 || this.installState === "downloading" || !!this.connecting || !!this.disconnecting; }

	async driverPath(): Promise<string | null> {
		const configured = this.config.all().computer.driverPath;
		if (configured) {
			if (!isAbsolute(configured)) throw new Error("Cua 驱动路径必须是可执行文件的绝对路径，不包含命令参数。");
			return existsSync(configured) ? configured : null;
		}
		const managed = await findDriver(driverInstallDir(this.dataDir));
		if (managed) return managed;
		const exe = process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
		const candidates = [
			join(homedir(), ".local", "bin", exe), join(homedir(), ".cua-driver", "bin", exe),
			join(homedir(), "Applications", "CuaDriver.app", "Contents", "MacOS", "cua-driver"),
			"/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
			...((process.env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, exe))),
		];
		return candidates.find(p => isAbsolute(p) && existsSync(p)) ?? null;
	}

	async status(): Promise<ComputerStatus> {
		let driverPath: string | null = null;
		try { driverPath = await this.driverPath(); } catch (error) { this.error = message(error); }
		return { enabled: this.config.all().computer.enabled, connected: !!this.client, driverPath,
			serverVersion: this.serverVersion, busy: this.busy, install: this.installState,
			installProgress: this.installProgress, error: this.error };
	}

	async startInstall(): Promise<ComputerStatus> {
		if (this.disposed) throw new Error("应用正在退出。");
		if (this.installState === "downloading") return this.status();
		if (this.busy || this.client) throw new Error("请先停止桌面任务并断开连接再安装驱动。");
		const abort = new AbortController();
		this.installAbort = abort;
		this.installState = "downloading";
		this.error = undefined;
		this.installProgress = 0;
		const timeout = setTimeout(() => abort.abort(new Error("Cua 下载等待超时；可提高 computer.actionTimeoutSec 后重试，或离线安装。")), this.config.all().computer.actionTimeoutSec * 1000);
		this.installing = installDriver(this.dataDir, abort.signal, value => { this.installProgress = value; })
			.then(() => { this.installState = "installed"; })
			.catch(error => { this.installState = "failed"; this.error = message(error); })
			.finally(() => { clearTimeout(timeout); this.installAbort = undefined; this.installing = undefined; });
		return this.status();
	}

	async connect(): Promise<void> {
		if (this.disposed) throw new Error("应用正在退出。");
		await this.syncConfig();
		await this.disconnecting;
		if (this.disposed) throw new Error("应用正在退出。");
		if (this.installState === "downloading") throw new Error("Cua 驱动正在安装，请等待安装完成。");
		const generation = this.generation;
		const path = await this.driverPath();
		if (generation !== this.generation) throw new Error("连接已取消。");
		if (!path) throw new Error("未找到 Cua Driver。请在桌面控制设置中安装，或填写已安装驱动的绝对路径。");
		if (this.client && path === this.connectedPath) return;
		if (this.connecting) return this.connecting;
		if (this.client) await this.disconnect();
		const pending = this.open(path).finally(() => { if (this.connecting === pending) this.connecting = undefined; });
		this.connecting = pending;
		return pending;
	}

	private async open(path: string): Promise<void> {
		const env: Record<string, string> = { CUA_DRIVER_PERMISSION_MODE: "standard" };
		for (const key of ["HOME", "USERPROFILE", "PATH", "APPDATA", "LOCALAPPDATA", "SystemRoot", "WINDIR", "TEMP", "TMP", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL"])
			if (process.env[key]) env[key] = process.env[key]!;
		const transport = new StdioClientTransport({ command: path, args: ["mcp"], env, stderr: "pipe" });
		const client = new Client({ name: "pi-virtual-employee", version: "1.0.0" });
		let diagnostic = "";
		transport.stderr?.on("data", data => { diagnostic = (diagnostic + String(data)).slice(-2000); });
		this.transport = transport;
		client.onclose = () => {
			if (this.transport === transport) {
				this.client = undefined;
				this.tools.clear();
				this.sessionAbort?.abort(new Error("Cua 连接已关闭。请重新检查窗口状态后继续。"));
			}
		};
		const timeout = this.config.all().computer.connectTimeoutSec * 1000;
		try {
			await client.connect(transport, { timeout });
			const found: Tool[] = [];
			let cursor: string | undefined;
			do {
				const result = await client.listTools({ cursor }, { timeout });
				found.push(...result.tools);
				cursor = result.nextCursor;
				if (found.length > 500) throw new Error("Cua 返回了过多工具。");
			} while (cursor);
			for (const required of ["list_apps", "list_windows", "get_window_state", "click"])
				if (!found.some(t => t.name === required)) throw new Error(`Cua 缺少 ${required} 工具，请使用兼容的 Cua Driver。`);
			if (this.disposed || this.transport !== transport) throw new Error("连接已取消。");
			this.tools = new Map(found.filter(t => (COMPUTER_ACTIONS as readonly string[]).includes(t.name) || t.name === "end_session").map(t => [t.name, t]));
			this.client = client;
			this.connectedPath = path;
			this.serverVersion = client.getServerVersion()?.version;
			this.error = undefined;
		} catch (error) {
			await transport.close().catch(() => {});
			this.error = `${message(error)}${diagnostic ? `\n${diagnostic}` : ""}`;
			throw new Error(this.error);
		}
	}

	async toolCatalog(action?: ComputerAction): Promise<Tool[]> {
		await this.connect();
		return [...this.tools.values()].filter(t => (COMPUTER_ACTIONS as readonly string[]).includes(t.name) && (!action || t.name === action)).map(t => ({
			name: t.name, description: t.description, inputSchema: {
				...t.inputSchema,
				properties: Object.fromEntries(Object.entries(t.inputSchema.properties ?? {}).filter(([key]) => FIELDS.has(key))),
			},
		}));
	}

	private async acquire(owner: string, signal?: AbortSignal): Promise<void> {
		await this.disconnecting;
		const generation = this.generation;
		const deadline = Date.now() + this.config.all().computer.actionTimeoutSec * 1000;
		while ((this.owner && this.owner !== owner) || this.activeCalls > 0) {
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); this.waiters.delete(done); };
				const done = () => { cleanup(); resolve(); };
				const aborted = () => { cleanup(); reject(signal?.reason ?? new Error("已取消")); };
				const timer = setTimeout(() => { cleanup(); reject(new Error("另一会话正在操作桌面，排队等待超时。请稍后重试。")); }, Math.max(1, deadline - Date.now()));
				this.waiters.add(done);
				signal?.addEventListener("abort", aborted, { once: true });
				if (signal?.aborted) aborted();
			});
		}
		signal?.throwIfAborted();
		if (generation !== this.generation) this.stoppedOwners.add(owner);
		if (this.stoppedOwners.has(owner)) throw new Error("本轮桌面任务已停止。请结束当前任务，在新消息中重新开始。");
		if (this.disposed) throw new Error("应用正在退出。");
		if (!this.owner) {
			this.owner = owner;
			this.session = `pi-${randomUUID()}`;
			this.sessionAbort = new AbortController();
			const seconds = this.config.all().computer.sessionTimeoutSec;
			if (seconds > 0) this.sessionTimer = setTimeout(() => {
				this.sessionAbort?.abort(new Error("桌面任务总时限已到。"));
				void this.disconnect();
			}, seconds * 1000);
		}
		this.sessionAbort?.signal.throwIfAborted();
		this.activeCalls++; // Acquire synchronously before returning, including same-owner parallel tool calls.
	}

	private async call(name: string, args: Args, signal?: AbortSignal): Promise<CallToolResult> {
		if (!this.client) throw new Error("Cua 尚未连接。");
		const input = { ...args };
		if (this.session && this.tools.get(name)?.inputSchema.properties?.session) input.session = this.session;
		return this.client.callTool({ name, arguments: input }, undefined, { signal, timeout: this.config.all().computer.actionTimeoutSec * 1000 }) as Promise<CallToolResult>;
	}

	async execute(action: ComputerAction, input: Args, owner: string, signal?: AbortSignal, authorize: () => void = () => {}): Promise<CallToolResult> {
		if (!(COMPUTER_ACTIONS as readonly string[]).includes(action)) throw new Error("不允许的桌面工具。");
		authorize();
		if (!this.config.all().computer.enabled) throw new Error("桌面控制未开启。");
		await this.syncConfig();
		await this.acquire(owner, signal);
		try {
			authorize(); // Recheck the verified actor after waiting for another conversation.
			if (!this.config.all().computer.enabled) throw new Error("桌面控制已关闭。");
			const lease = this.sessionAbort!;
			await this.connect();
			const combined = AbortSignal.any([lease.signal, ...(signal ? [signal] : [])]);
			const cfg = this.config.all().computer;
			const verify = () => {
				authorize();
				if (JSON.stringify(cfg) !== JSON.stringify(this.config.all().computer)) throw new Error("桌面配置已修改，请重新检查允许列表后继续。");
				combined.throwIfAborted();
			};
			const checkedCall = async (name: string, nativeArgs: Args) => {
				verify();
				const result = await this.call(name, nativeArgs, combined);
				verify();
				return result;
			};
			const args = { ...input };
			for (const field of Object.keys(args)) if (!FIELDS.has(field)) throw new Error(`不允许的桌面参数：${field}`);
			const tool = this.tools.get(action);
			if (!tool) throw new Error(`当前平台的 Cua 不支持 ${action}。`);
			const appsResult = await checkedCall("list_apps", {});
			if (appsResult.isError) return appsResult;
			const apps = resultRecords(appsResult, "apps");
			if (action === "list_apps") {
				const summary = apps.map(app => ({ ...app, allowed: appAllowed(app, cfg.allowedApps) }));
				return textResult(JSON.stringify({ apps: summary }), { apps: summary });
			}
			if (action === "launch_app") {
				if (Object.keys(args).length !== 1) throw new Error("启动应用必须只提供一个应用标识，不能传入其他参数。");
				const selector = ["bundle_id", "aumid", "app_id", "name", "launch_path", "path"].find(key => typeof args[key] === "string" && args[key]);
				const app = selector ? apps.find(app => appAllowed(app, [String(args[selector])]) && appAllowed(app, cfg.allowedApps)) : undefined;
				if (!app)
					throw new Error("应用未在已发现的允许列表中。先 list_apps，再由管理员设置 computer.allowedApps。");
				// Resolve aliases to the exact discovered identity/path. Never feed a
				// model-supplied command string into ShellExecute/PATH resolution.
				delete args[selector!];
				if (typeof app.bundle_id === "string" && app.bundle_id.includes("!") && tool.inputSchema.properties?.aumid) args.aumid = app.bundle_id;
				else if (typeof app.launch_path === "string" && app.launch_path && tool.inputSchema.properties?.launch_path) args.launch_path = app.launch_path;
				else if (typeof app.bundle_id === "string" && app.bundle_id && tool.inputSchema.properties?.bundle_id) args.bundle_id = app.bundle_id;
				else if (typeof app.name === "string" && tool.inputSchema.properties?.name) args.name = app.name;
				else throw new Error("该应用缺少可验证的启动标识，请先手动打开应用，再根据 pid 操作。");
			} else {
				if (args.pid !== undefined && (!Number.isSafeInteger(args.pid) || Number(args.pid) <= 0)) throw new Error("pid 必须是已发现的正整数进程号。");
				if (action !== "list_windows" && !args.pid) throw new Error("请先 list_apps/list_windows，再传入 pid 和 window_id。");
				const allowedPids = new Set(apps.filter(app => appAllowed(app, cfg.allowedApps)).map(app => Number(app.pid)).filter(pid => pid > 0));
				if (args.pid && !allowedPids.has(Number(args.pid))) throw new Error("该进程不在 computer.allowedApps 允许列表中。");
				if (action === "list_windows") {
					const result = await checkedCall(action, args);
					if (result.isError) return result;
					const windows = resultRecords(result, "windows").filter(window => allowedPids.has(Number(window.pid)));
					return textResult(JSON.stringify({ windows }), { windows });
				}
				if (!Number.isSafeInteger(args.window_id) || Number(args.window_id) <= 0) throw new Error("window_id 必须来自 list_windows 的真实窗口。");
				const snapshot = `${args.pid}:${args.window_id}`;
				if (INPUT_ACTIONS.has(action) && !this.snapshots.has(snapshot)) throw new Error("请先对该窗口调用 get_window_state，再根据截图或控件信息操作。");
				if (INPUT_ACTIONS.has(action)) {
					if (args.delivery_mode !== undefined && !["background", "foreground"].includes(String(args.delivery_mode))) throw new Error("delivery_mode 只能是 background 或 foreground。");
					if (args.delivery_mode === "foreground" && !cfg.allowForeground) throw new Error("管理员尚未允许前台操作（computer.allowForeground）。");
					// Native set_value uses accessibility APIs and has no delivery_mode.
					if (tool.inputSchema.properties?.delivery_mode) args.delivery_mode ??= "background";
					this.snapshots.delete(snapshot); // A new observation is required after every input.
				}
			}
			for (const field of Object.keys(args)) if (!tool.inputSchema.properties?.[field]) throw new Error(`当前 Cua 的 ${action} 不支持参数 ${field}，请用 manage_computer tools 查看实际参数。`);
			for (const field of tool.inputSchema.required ?? []) if (field !== "session" && args[field] === undefined) throw new Error(`${action} 缺少参数 ${field}。`);
			const result = await checkedCall(action, args);
			if (action === "get_window_state" && !result.isError) this.snapshots.add(`${args.pid}:${args.window_id}`);
			return result;
		} catch (error) {
			this.error = message(error);
			if (signal?.aborted || this.sessionAbort?.signal.aborted || /timed out|timeout|connection closed/i.test(this.error)) {
				await this.disconnect();
				throw new Error(`${this.error}\n已断开桌面连接；操作结果可能尚未确认，重新连接后先检查窗口，不要直接重复提交。`);
			}
			throw error;
		} finally { this.activeCalls--; for (const wake of this.waiters) wake(); }
	}

	async release(owner: string): Promise<void> {
		this.stoppedOwners.delete(owner);
		if (this.owner !== owner) return;
		try {
			if (this.client && this.session && this.tools.has("end_session")) await this.call("end_session", {});
		} catch { await this.transport?.close().catch(() => {}); }
		finally { if (this.owner === owner) this.clearLease(); }
	}

	private clearLease(): void {
		clearTimeout(this.sessionTimer);
		this.sessionTimer = undefined;
		this.owner = undefined;
		this.session = undefined;
		this.sessionAbort = undefined;
		this.snapshots.clear();
		for (const wake of this.waiters) wake();
	}

	disconnect(): Promise<void> {
		if (this.disconnecting) return this.disconnecting;
		this.generation++;
		if (this.owner) this.stoppedOwners.add(this.owner);
		this.sessionAbort?.abort(new Error("桌面连接已停止。"));
		this.installAbort?.abort(new Error("Cua 驱动安装已取消。"));
		const transport = this.transport;
		this.transport = undefined;
		this.client = undefined;
		this.connecting = undefined;
		this.tools.clear();
		this.clearLease();
		const pending = Promise.all([transport?.close().catch(() => {}), this.installing]).then(() => {}).finally(() => {
			if (this.disconnecting === pending) this.disconnecting = undefined;
		});
		this.disconnecting = pending;
		return pending;
	}

	async close(): Promise<void> {
		this.disposed = true;
		await this.disconnect();
	}
}
