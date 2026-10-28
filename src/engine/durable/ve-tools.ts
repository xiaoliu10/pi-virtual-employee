/**
 * AgentTool (VE) → durable ToolRegistration adapter.
 *
 * VE ships 30+ tools built on pi-agent-core's `AgentTool`; a durable session
 * needs `ToolRegistration` (typebox params + `execute(args, api, context)`).
 * The two shapes differ in the call signature and the result field name, so
 * they get ONE explicit mapping here — the same discipline as
 * `tools/tool-adapter.ts` (kernel migration): an upstream rename becomes a
 * compile error at this seam instead of a silent runtime gap.
 *
 * REPLAY POLICY is the part that cannot be defaulted: durable reruns an
 * interrupted call only when the stored intent AND the current tool both say
 * `safe`. VE's AgentTool carries a `replay?: "never" | "safe"` field, but the
 * legacy kernel never reads it (verified: no consumer in pi-agent-core), so
 * every VE tool must be classified here rather than inherited blindly.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Tools whose rerun cannot change the outside world.
 *
 * Classification rule (phase 1, read-only set): a tool is `safe` only when
 * re-running it produces the SAME observable state — a read, a query, or a write
 * to a file this app owns (audit log, screenshot artifact, download). Anything
 * that mutates business state, sends something to a human, or changes config is
 * NOT here, even if it also has read-only actions.
 *
 * Deliberately excluded despite sounding harmless:
 *  - `manage_*` family: every one of them has a write action (create/confirm/
 *    pause/cancel/set), and the policy is keyed on the tool NAME, so a crash
 *    mid-write would replay the mutation.
 *  - `browser_navigate` / `browser_click` / `browser_type*` / `browser_evaluate`
 *    / `browser_download`: they drive an external site; a replay submits the form
 *    or the order twice.
 *  - `send_image` / `provide_document` / `save_report`: visible to a human —
 *    replay = the user receives it twice.
 *  - `remember` / `save_to_knowledge` / `save_to_skill` / `save_document`:
 *    append records; a duplicate pollutes the knowledge base.
 *  - `run_command` / `computer_use`: arbitrary external effects.
 */
export const SAFE_TOOLS: ReadonlySet<string> = new Set([
	// Pure reads.
	"get_current_time",
	"read_file",
	"list_directory",
	"list_documents",
	"list_downloads",
	"list_scheduled_tasks",
	"get_scheduled_task",
	"read_skill_asset",
	"search_knowledge_base",
	"lookup_order",
	"inspect_spreadsheet",
	"my_stats",
	"check_my_access",
	// Reads that also write a file this app owns (idempotent: same input → same
	// artifact path/content; a replay cannot change business state).
	"view_image",
	"browser_read",
	"browser_screenshot",
]);

/**
 * Effect classification for one VE tool name.
 *
 * Deliberately a DENYLIST-by-default (only listed names are safe): a tool
 * added later without review must not silently become replayable after a
 * crash, because a rerun may repeat an external effect (a sent message, a
 * refund, a submitted form).
 */
export function replayPolicyFor(toolName: string): "safe" | "unsafe" {
	return SAFE_TOOLS.has(toolName) ? "safe" : "unsafe";
}

export interface AdaptOptions {
	/** Force a specific policy (tests / deliberate overrides). */
	replay?: () => "safe" | "unsafe";
}

/**
 * Wrap one VE tool as a durable tool registration.
 *
 * `api`/`context` are dropped on purpose: VE's tools resolve everything they
 * need from construction-time closures (config, services, the per-turn actor
 * map). Running them under durable does NOT change their authority — the RBAC
 * gate inside each tool still decides. The actor itself is persisted by
 * `ve-actor.ts` so a recovered turn re-derives the same identity.
 */
export function toDurableTool(tool: AgentTool<any>, opts: AdaptOptions = {}): ToolRegistration<any, any> {
	const replay = opts.replay?.() ?? replayPolicyFor(tool.name);
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		replay,
		execute: async (args: any) => {
			const result = await tool.execute(`${tool.name}-durable`, args, undefined, undefined);
			return {
				output: result.content as never,
				...(result.details !== undefined ? { details: result.details as never } : {}),
				...(result.isError ? { isError: true } : {}),
			};
		},
	} as ToolRegistration<any, any>;
}

/** Adapt a whole tool set, preserving order (first wins on duplicate names, as durable does). */
export function toDurableTools(tools: AgentTool<any>[], opts: AdaptOptions = {}): ToolRegistration<any, any>[] {
	const seen = new Set<string>();
	const out: ToolRegistration<any, any>[] = [];
	for (const tool of tools) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		out.push(toDurableTool(tool, opts));
	}
	return out;
}
