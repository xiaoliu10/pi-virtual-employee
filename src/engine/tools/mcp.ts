/**
 * MCP connector: bridges external MCP servers' tools into the employee's
 * native tool set (pi 0.99 brought native MCP to the CLI harness; the employee
 * builds its own harness on agent-core, so this module does the same job in
 * engine space using the shared @modelcontextprotocol/sdk).
 *
 * Design:
 *  - Config lives in `capabilities.mcp` ({ enabled, servers[] }, standard
 *    mcpServers shape — see src/shared/mcp.ts).
 *  - `refresh()` connects to every enabled server and caches its tool list;
 *    `tools()` is a SYNC snapshot read by buildTools (sessions are built
 *    synchronously). The engine refreshes on startup and on config changes,
 *    and marks config changed when the tool surface changes so live sessions
 *    rebuild with the new tools.
 *  - Tool names are namespaced `mcp__<server>__<tool>` so they can never
 *    collide with built-ins. Tools are guarded under the "mcp" capability
 *    like every other capability tool.
 *  - A hung MCP server cannot wedge a turn: every call is bounded by the
 *    server's timeoutSec (default 60).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConfigStore } from "../../db/config-store.js";
import { type McpServerConfig, normalizeMcpServers } from "../../shared/mcp.js";
import { refuse } from "./admin.js";

const CLIENT_INFO = { name: "pi-virtual-employee", version: "1.0.0" };
const DEFAULT_TIMEOUT_SEC = 60;

const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: object;
}

interface ServerConn {
	config: McpServerConfig;
	client: Client;
	tools: McpToolInfo[];
}

type McpContentBlock = { type: "text"; text: string } | { type: "image" | "audio"; mimeType?: string; data?: string } | { type: string; [k: string]: unknown };

/** Render an MCP CallToolResult into the model-facing text form. */
function renderToolResult(result: { content?: McpContentBlock[]; isError?: boolean }, server: string, tool: string): string {
	const blocks = Array.isArray(result.content) ? result.content : [];
	const parts = blocks.map((block) => {
		if (block.type === "text" && typeof block.text === "string") return block.text;
		if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
			return `[${block.type}: ${block.mimeType ?? "unknown"}, ${Math.floor((block.data.length * 3) / 4)} bytes —— 已生成，未在文本中展示]`;
		}
		try {
			return `[${block.type}] ` + JSON.stringify(block).slice(0, 2000);
		} catch {
			return `[${block.type}] (不可序列化内容)`;
		}
	});
	const body = parts.join("\n").trim() || "(MCP 工具返回空结果)";
	return (result.isError ? `⚠️ MCP ${server}/${tool} 报告执行失败：\n` : "") + body;
}

export interface McpRefreshReport {
	name: string;
	ok: boolean;
	tools: number;
	error?: string;
}

export interface McpManagerDeps {
	/** Overridable for tests: spawn the MCP client for one server config. */
	connect?: (server: McpServerConfig) => Promise<Client>;
}

export class McpManager {
	private cache = new Map<string, ServerConn>();
	private lastSignature = "";
	private refreshInFlight: Promise<{ changed: boolean; report: McpRefreshReport[] }> | undefined;

	constructor(private readonly deps: McpManagerDeps = {}) {}

	/** Sync snapshot of cached bridged tools — empty until the first refresh lands. */
	tools(): AgentTool[] {
		const out: AgentTool[] = [];
		for (const [serverName, conn] of this.cache) {
			for (const tool of conn.tools) {
				out.push(this.bridgeTool(serverName, conn, tool));
			}
		}
		return out;
	}

	/** Human-readable one-line status for the capabilities show tool. */
	statusText(): string {
		if (this.cache.size === 0) return "MCP：无已连接服务器";
		const parts = [...this.cache.values()].map((conn) => `${conn.config.name}(${conn.tools.length} 工具)`);
		return `MCP：${parts.join("、")}`;
	}

	/** Connect + list tools for every enabled server. Concurrent calls share one
	 * run; returns whether the tool surface changed (so the engine only rebuilds
	 * sessions when something actually moved). */
	refresh(config: ConfigStore): Promise<{ changed: boolean; report: McpRefreshReport[] }> {
		if (this.refreshInFlight) return this.refreshInFlight;
		this.refreshInFlight = this.runRefresh(config).finally(() => {
			this.refreshInFlight = undefined;
		});
		return this.refreshInFlight;
	}

	private async runRefresh(config: ConfigStore): Promise<{ changed: boolean; report: McpRefreshReport[] }> {
		const mcpConfig = config.all().capabilities?.mcp;
		const { servers, errors } = normalizeMcpServers(mcpConfig?.servers);
		const enabled = mcpConfig?.enabled === true ? servers.filter((s) => s.enabled !== false) : [];
		const report: McpRefreshReport[] = errors.map((error) => ({ name: "(配置)", ok: false, tools: 0, error }));
		const nextCache = new Map<string, ServerConn>();

		for (const server of enabled) {
			const cacheKey = JSON.stringify(server);
			const cached = this.cache.get(server.name);
			try {
				// Reuse the live connection when the config is unchanged and still healthy.
				if (cached && JSON.stringify(cached.config) === cacheKey) {
					nextCache.set(server.name, cached);
					report.push({ name: server.name, ok: true, tools: cached.tools.length });
					continue;
				}
				const client = await this.connect(server);
				const listed = await this.withTimeout(
					client.listTools(),
					(server.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
					`${server.name}: listTools 超时`,
				);
				const tools = (listed.tools ?? []).map((t: { name: string; description?: string; inputSchema?: object }) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema,
				}));
				nextCache.set(server.name, { config: server, client, tools });
				report.push({ name: server.name, ok: true, tools: tools.length });
			} catch (err) {
				report.push({ name: server.name, ok: false, tools: 0, error: err instanceof Error ? err.message : String(err) });
			}
		}

		const signature = [...nextCache.values()]
			.map((conn) => `${conn.config.name}:${conn.tools.map((t) => t.name).join(",")}`)
			.sort()
			.join("|");
		const changed = signature !== this.lastSignature;
		this.lastSignature = signature;
		this.cache = nextCache;
		return { changed, report };
	}

	private async connect(server: McpServerConfig): Promise<Client> {
		if (this.deps.connect) return this.deps.connect(server);
		const client = new Client(CLIENT_INFO);
		if (server.command) {
			const mergedEnv: Record<string, string> = {};
			for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") mergedEnv[k] = v;
			Object.assign(mergedEnv, server.env ?? {});
			const transport = new StdioClientTransport({
				command: server.command,
				args: server.args ?? [],
				env: mergedEnv,
				cwd: server.cwd,
			});
			await client.connect(transport, { timeout: (server.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000 });
			return client;
		}
		const transport = new StreamableHTTPClientTransport(new URL(server.url!), {
			requestInit: { headers: server.headers ?? {} },
		});
		await client.connect(transport, { timeout: (server.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000 });
		return client;
	}

	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			timer.unref?.();
		});
		try {
			return await Promise.race([promise, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** Bridge one MCP tool into an AgentTool. All calls share the server's client;
	 * failures degrade to an in-band error text so a bad server never breaks the turn. */
	private bridgeTool(serverName: string, conn: ServerConn, tool: McpToolInfo): AgentTool {
		const fullName = mcpToolName(serverName, tool.name);
		const timeoutMs = (conn.config.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
		const inputSchema = tool.inputSchema && typeof tool.inputSchema === "object" && Object.keys(tool.inputSchema).length > 0
			? tool.inputSchema
			: { type: "object", properties: {} };
		return {
			name: fullName,
			label: `MCP ${serverName}/${tool.name}`,
			description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
			parameters: Type.Unsafe(inputSchema as unknown as Parameters<typeof Type.Unsafe>[0]),
			async execute(_toolCallId, params) {
				if (conn.client.transport === undefined) {
					return refuse(`MCP 服务器 ${serverName} 已断开连接，本次无法执行。请管理员检查该服务器是否在线。`);
				}
				try {
					const result = (await Promise.race([
						conn.client.callTool({ name: tool.name, arguments: (params ?? {}) as Record<string, unknown> }),
						new Promise<never>((_, reject) => {
							const timer = setTimeout(() => reject(new Error(`执行超时（${timeoutMs / 1000} 秒）`)), timeoutMs);
							timer.unref?.();
						}),
					])) as { content?: McpContentBlock[]; isError?: boolean };
					return {
						content: [{ type: "text", text: renderToolResult(result, serverName, tool.name) }],
						details: { mcp: true, server: serverName, tool: tool.name, isError: result.isError === true },
					};
				} catch (err) {
					return refuse(`⚠️ MCP ${serverName}/${tool.name} 调用失败：${err instanceof Error ? err.message : String(err)}`);
				}
			},
		};
	}
}

export function createMcpManager(deps?: McpManagerDeps): McpManager {
	return new McpManager(deps);
}
