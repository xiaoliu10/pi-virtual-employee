/**
 * SessionHost — the AgentSession wrapper around VE's self-built Agent.
 *
 * Architecture (docs/design/ve-pi-session-migration.md §3/§7): the transcript
 * is owned by the Agent (VE rehydrates history into it and mutates it in the
 * compaction/recovery paths — all preserved). The session is a SHELL that adds
 * what the bare kernel lacks:
 *
 *  - the extension runtime: registered tools are wrapped so `tool_call` /
 *    `tool_result` fire for VE tools, and `agent_before_settle` / `turn_end`
 *    boundaries run when turns are driven through session.prompt();
 *  - a persistence mirror (in-memory — VE SQLite stays the only authority);
 *  - pi scaffolding (settings/model-runtime) reduced to stubs, because VE
 *    resolves models and credentials in its own layer.
 *
 * Pi's own auto-retry and auto-compaction are DISABLED here on purpose: VE's
 * promptWithRetry ladder and maybeCompact gates are the field-hardened
 * versions (CJK token math, cut points, honest empty-stall chains) and must
 * stay the only decision makers (0.2.67/0.2.69/0.2.80/0.2.85/0.2.93/0.2.95).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";

import { getPiRuntime } from "./imports.js";
import { toToolDefinition } from "./tools/tool-adapter.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface SessionHost {
	/** The self-built agent (same instance VE already holds). */
	agent: Agent;
	/** The pi session shell — drive turns through session.prompt(). */
	session: AgentSession;
	/** Entry point for tools that need the raw module (compaction primitives). */
	runtimeVersion: string;
}

export interface CreateSessionHostOptions {
	conversationId: string;
	/** VE tools (AgentTool shape) — registered as session customTools. */
	tools: AgentTool[];
	/** Inline extension factories (plugin host); empty by default. */
	extensionFactories?: unknown[];
	/** Directory for session scratch state. Defaults to a stable temp dir. */
	cwd?: string;
}

/**
 * Wrap a self-built Agent in a pi AgentSession. Throws when the runtime is
 * not initialized (call sites decide legacy vs pi-session BEFORE building the
 * agent — this function is only reached on the pi-session path).
 */
export async function createSessionHost(agent: Agent, opts: CreateSessionHostOptions): Promise<SessionHost> {
	const pi = getPiRuntime();

	const cwd = opts.cwd ?? join(tmpdir(), "pi-ve-session");
	const loader = new pi.DefaultResourceLoader({
		cwd,
		// Same shared pi agent dir VE's credential-store already uses.
		agentDir: join(cwd, "agent"),
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		// The Agent carries VE's system prompt in its state — the loader's own
		// prompt machinery is scaffolding we never read.
		systemPrompt: "VE session host (system prompt lives on the agent).",
		extensionFactories: (opts.extensionFactories ?? []) as never,
	});
	// Extensions load into the loader's cache ONLY here — the session snapshot
	// (getExtensions) is taken in its constructor (spike-verified 2026-10-17).
	await loader.reload();

	// Minimal ModelRuntime stub: VE's model/auth pipeline (resolveModel +
	// credential-store + streamFn) is authoritative; the session only needs the
	// prompt-time auth gate to pass. Unknown methods are logged once via Proxy
	// so wiring gaps surface in diagnostics instead of silently no-oping.
	const unknownCalls: string[] = [];
	const modelRuntime = new Proxy(
		{
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ ok: true, type: "api" }),
			isUsingOAuth: () => false,
			getModel: () => agent.state.model,
			getAuth: async () => undefined,
		} as Record<string | symbol, unknown>,
		{
			get(target, key) {
				if (typeof key !== "string") return undefined;
				if (key in target) return target[key];
				if (!unknownCalls.includes(String(key))) {
					unknownCalls.push(String(key));
					console.warn(`[session-host] modelRuntime.${String(key)} is not stubbed — returning undefined`);
				}
				return () => undefined;
			},
		},
	);

	const session = new pi.AgentSession({
		agent,
		sessionManager: pi.SessionManager.inMemory(),
		settingsManager: pi.SettingsManager.inMemory({
			// VE's promptWithRetry ladder is the only retry authority.
			retry: { enabled: false },
			// VE's maybeCompact gates are the only compaction authority.
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
		} as never),
		cwd,
		resourceLoader: loader,
		modelRuntime: modelRuntime as never,
		customTools: opts.tools.map(toToolDefinition),
		// Suppress pi's built-in read/bash/edit/write — VE ships its own tools.
		initialActiveToolNames: [],
	});

	// Wire extension bindings (no UI — headless host).
	await session.bindExtensions({ onError: (err) => console.warn("[session-host] extension error:", err instanceof Error ? err.message : err) });

	// The session gates prompt() on a selected model; hand it the agent's own
	// (the real streamFn lives on the Agent, so this is bookkeeping only).
	await session.setModel(agent.state.model);

	return { agent, session, runtimeVersion: pi.version };
}
