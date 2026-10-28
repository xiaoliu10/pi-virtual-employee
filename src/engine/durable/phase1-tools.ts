/**
 * Phase 1 tool surface for the durable host: the READ-ONLY subset only.
 *
 * Why a subset instead of all 61 tools: a tool that runs under durable can be
 * re-executed after a crash when it is declared `replay: "safe"`. Rolling out
 * every tool at once would mean betting the whole surface on the replay
 * classification being right; a wrong `safe` turns a crash into a duplicate
 * external effect. So phase 1 wires ONLY tools whose rerun is provably harmless
 * (see SAFE_TOOLS in ve-tools.ts), proves the recovery contract against them,
 * and leaves the mutating set for phase 3 where each one gets an idempotency key
 * or a business-state check.
 *
 * The tools themselves are taken from `buildTools()` — the SAME instances the
 * legacy kernel uses, already wrapped in the RBAC `guarded()` capability checks.
 * Taking them here (rather than re-creating them) guarantees the durable path
 * cannot diverge from the permission model: an actor without a capability is
 * refused inside the tool, no matter which kernel drives it.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { SAFE_TOOLS } from "./ve-tools.js";

/**
 * Tools wired into the durable host in phase 1.
 *
 * Single source of truth: this IS `SAFE_TOOLS`. Two hand-maintained lists would
 * drift, and the drift is dangerous in one direction only — a name present here
 * but absent from SAFE_TOOLS would run under durable while being classified
 * unsafe (never replayed, so simply useless), while the reverse would be
 * harmless. Deriving it removes the class entirely.
 */
export const PHASE1_TOOL_NAMES: readonly string[] = [...SAFE_TOOLS];

/**
 * Pick the phase-1 tools out of a built tool set.
 *
 * Missing tools are simply absent (a deployment may disable knowledge, browser,
 * …); the host must not fail because an optional tool is off.
 */
export function selectPhase1Tools(all: AgentTool<any>[]): AgentTool<any>[] {
	const wanted = new Set(PHASE1_TOOL_NAMES);
	return all.filter((tool) => wanted.has(tool.name));
}
