/**
 * Register the compaction custom message roles with pi-agent-core.
 *
 * Verified against 1.5.2 (the family was upgraded from a mixed 1.2.0/1.5.0 tree
 * in the pi-sdk-1.5.2 change): the extension point still exists —
 * `CustomAgentMessages` plus `AgentMessage = Message | CustomAgentMessages[keyof
 * CustomAgentMessages]` in pi-agent-core/dist/types.d.ts.
 *
 * pi 1.x narrowed `AgentMessage` to `Message | CustomAgentMessages[...]` and
 * moved the coding-agent's compactionSummary/branchSummary roles out of the
 * core package (they now live in pi-coding-agent, which we deliberately do not
 * depend on at runtime — see src/engine/pi-compaction.ts; pi-agent-core 1.5.2
 * still exports no compaction primitives, so the vendoring stays necessary).
 * Declaration merging is the documented extension point: it restores the
 * pre-1.0 AgentMessage union our compaction pipeline compiles against, so role
 * comparisons like `msg.role === "compactionSummary"` typecheck again.
 */
import type { BranchSummaryMessage, CompactionSummaryMessage } from "./pi-compaction.js";

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
