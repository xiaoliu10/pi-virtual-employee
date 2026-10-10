/**
 * Register the compaction custom message roles with pi-agent-core 1.1.0.
 *
 * pi 1.x narrowed `AgentMessage` to `Message | CustomAgentMessages[...]` and
 * moved the coding-agent's compactionSummary/branchSummary roles out of the
 * core package (they now live in pi-coding-agent, which we deliberately do not
 * depend on — see src/engine/pi-compaction.ts). Declaration merging is the
 * documented extension point (CustomAgentMessages in pi-agent-core types.ts):
 * it restores the pre-1.0 AgentMessage union our compaction pipeline compiles
 * against, so role comparisons like `msg.role === "compactionSummary"`
 * typecheck again.
 */
import type { BranchSummaryMessage, CompactionSummaryMessage } from "./pi-compaction.js";

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
