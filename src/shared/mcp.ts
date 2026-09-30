/**
 * MCP (Model Context Protocol) server configuration — the shared shape used by
 * config storage, the settings tool and the engine's MCP connector.
 *
 * The format mirrors the standard `mcpServers` shape (Claude Desktop / Cursor /
 * pi's mcp.json), so existing entries can be copied over. stdio servers take
 * `command`/`args`/`env`/`cwd`; HTTP servers take `url`/`headers` (streamable
 * HTTP). `env` and `headers` values may reference environment variables via
 * `${NAME}`, interpolated when the config is loaded.
 */

export interface McpServerConfig {
	/** Unique name: letters, digits, `_`, `-`. Tools are exposed as mcp__<name>__<tool>. */
	name: string;
	/** stdio transport: executable to launch (single executable, not a shell string). */
	command?: string;
	args?: string[];
	/** Extra environment for the child process, merged over this app's process.env. */
	env?: Record<string, string>;
	cwd?: string;
	/** Streamable HTTP transport endpoint. */
	url?: string;
	headers?: Record<string, string>;
	/** Per-request timeout seconds (default 60). */
	timeoutSec?: number;
	/** Disabled entries are skipped without connecting (default true). */
	enabled?: boolean;
}

export const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Interpolate `${NAME}` from the process environment; missing vars become "". */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

const stringRecord = (value: unknown, env: NodeJS.ProcessEnv): Record<string, string> | undefined => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "string") out[key] = interpolateEnv(raw, env);
	}
	return out;
};

/** Normalize one raw server entry; returns the error reason instead of throwing. */
export function normalizeMcpServer(raw: unknown, env: NodeJS.ProcessEnv = process.env): { ok: true; value: McpServerConfig } | { ok: false; reason: string } {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "条目必须是对象" };
	const record = raw as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name.trim() : "";
	if (!MCP_NAME_RE.test(name)) return { ok: false, reason: `name 非法（仅字母/数字/_/-）："${name || "(空)"}"` };
	const hasCommand = typeof record.command === "string" && record.command.trim().length > 0;
	const hasUrl = typeof record.url === "string" && record.url.trim().length > 0;
	if (!hasCommand && !hasUrl) return { ok: false, reason: `${name}: 缺少 command（stdio）或 url（HTTP）` };
	const server: McpServerConfig = { name };
	if (hasCommand) {
		server.command = interpolateEnv((record.command as string).trim(), env);
		if (Array.isArray(record.args)) {
			const args = record.args.filter((a): a is string => typeof a === "string").map((a) => interpolateEnv(a, env));
			if (args.length > 0) server.args = args;
		}
		const envOut = stringRecord(record.env, env);
		if (envOut) server.env = envOut;
		if (typeof record.cwd === "string" && record.cwd.trim()) server.cwd = interpolateEnv(record.cwd.trim(), env);
	}
	if (hasUrl) {
		server.url = (record.url as string).trim();
		const headers = stringRecord(record.headers, env);
		if (headers) server.headers = headers;
	}
	if (typeof record.timeoutSec === "number" && Number.isFinite(record.timeoutSec) && record.timeoutSec > 0) {
		server.timeoutSec = Math.floor(record.timeoutSec);
	}
	if (record.enabled === false) server.enabled = false;
	return { ok: true, value: server };
}

/** Normalize a raw servers value: an array of entries, or a record keyed by
 * name (the standard mcpServers shape). Invalid entries are skipped and
 * reported; the rest still connect (same contract as pi's mcp.json). */
export function normalizeMcpServers(raw: unknown, env: NodeJS.ProcessEnv = process.env): { servers: McpServerConfig[]; errors: string[] } {
	const servers: McpServerConfig[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	const push = (keyName: string | null, entry: unknown): void => {
		const parsed = normalizeMcpServer(keyName ? { ...(entry as Record<string, unknown>), name: keyName } : entry, env);
		if (!parsed.ok) {
			errors.push(parsed.reason);
			return;
		}
		if (seen.has(parsed.value.name)) {
			errors.push(`${parsed.value.name}: 重名条目被跳过`);
			return;
		}
		seen.add(parsed.value.name);
		servers.push(parsed.value);
	};
	if (Array.isArray(raw)) {
		for (const entry of raw) push(null, entry);
	} else if (raw && typeof raw === "object") {
		for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) push(name, entry);
	}
	return { servers, errors };
}
