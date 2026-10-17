/**
 * AgentTool (pi-agent-core, VE's 30+ tool factories) → ToolDefinition
 * (pi-coding-agent session customTools) adapter.
 *
 * The shapes are structurally compatible (both derive from the typebox Tool
 * convention: name/label/description/parameters + execute(toolCallId, params,
 * signal, onUpdate) — spike-verified 2026-10-17: a VE-shaped tool passed the
 * session registry and executed). The adapter exists to keep ONE explicit
 * place that maps the two types, so an upstream field rename in either
 * package is a compile error here instead of a silent runtime gap.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function toToolDefinition(tool: AgentTool): ToolDefinition {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: tool.execute,
	} as ToolDefinition;
}
