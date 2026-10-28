/**
 * Enrich durable's interrupted-tool result with VE's recovery instruction.
 *
 * durable's own text for an interrupted call is one line:
 *   "Tool <name> was interrupted and may have partially run"
 * That is accurate but gives the model no next step, and the obvious next step —
 * call it again — is exactly the duplicate-effect failure this whole feature
 * exists to prevent.
 *
 * `afterTool` can replace a tool's result, so this extension rewrites the
 * interrupted case into a recovery notice that names what to verify (see
 * recovery-policy.ts). Read-only tools are left alone: durable's line is already
 * enough when a rerun is harmless.
 */
import { ToolTask, defineExtension, hook } from "@earendil-works/pi-durable";

import { interruptedToolNotice, recoveryRuleFor } from "./recovery-policy.js";

/** durable's marker for a call whose process died before its result was committed. */
const INTERRUPTED_MARKERS = ["was interrupted and may have partially run", "was interrupted by a restart"];

function outputText(output: unknown): string {
	if (typeof output === "string") return output;
	if (!Array.isArray(output)) return "";
	return output
		.filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

/** True when this result is durable's "interrupted" notice for `toolName`. */
export function isInterruptedResult(toolName: string, output: unknown): boolean {
	const text = outputText(output);
	if (!text) return false;
	// The message names the tool, so a result that merely mentions the words in
	// ordinary content does not match.
	if (!text.includes(toolName)) return false;
	return INTERRUPTED_MARKERS.some((marker) => text.includes(marker));
}

export function createInterruptedToolNotice() {
	return defineExtension({
		name: "ve-interrupted-notice",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result) => {
					try {
						if (!isInterruptedResult(call.name, result.output)) return undefined;
						const rule = recoveryRuleFor(call.name);
						if (rule.policy === "retry") return undefined; // harmless to rerun — leave durable's text
						return {
							...result,
							output: [{ type: "text", text: interruptedToolNotice(call.name, rule) }] as never,
							isError: true,
						};
					} catch {
						// Never break a tool result because the notice failed.
						return undefined;
					}
				},
			}),
		],
	});
}
