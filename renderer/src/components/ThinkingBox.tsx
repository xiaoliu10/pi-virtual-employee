import { useEffect, useRef, useState } from "react";

interface ThinkingBoxProps {
	/** Accumulated reasoning text (may still be growing while streaming). */
	text: string;
	/** True while the model is still producing output for this turn. */
	streaming?: boolean;
}

export interface ThinkingState {
	/** Whether the reasoning body is visible. */
	open: boolean;
	/** null = follow the automatic rule; true/false = the user decided. */
	manual: boolean | null;
}

/**
 * The whole expand/collapse rule, as a PURE function so it can be tested
 * without a DOM.
 *
 * Rules (user ruling 2026-11-04):
 *  1. EXPANDED while streaming — the work is visible as it happens.
 *  2. COLLAPSED the moment the turn finishes (the streaming→done edge). This is
 *     the behaviour the user asked for explicitly: "输出完思考信息之后默认折叠".
 *  3. An explicit click wins until that finish edge, so someone who collapses
 *     (or re-opens) mid-stream is not fought by every incoming delta. The finish
 *     edge then resets to the default, so the *next* render is predictable.
 *  4. A message that was never streaming (loaded from history, or a turn that
 *     produced no deltas) starts collapsed.
 */
export function reduceThinking(
	state: ThinkingState,
	streaming: boolean,
	prevStreaming: boolean,
): ThinkingState {
	// The finish edge owns the default: collapse and drop any manual override.
	if (prevStreaming && !streaming) return { open: false, manual: null };
	// A click made during this turn wins over the automatic expansion.
	if (state.manual !== null) return { open: state.manual, manual: state.manual };
	// Otherwise: expanded iff still streaming.
	return { open: streaming, manual: null };
}

/**
 * Collapsible reasoning box.
 *
 * Expanded while streaming, auto-collapsed once the answer is done so the
 * finished transcript stays readable; one click brings the reasoning back.
 */
export function ThinkingBox({ text, streaming }: ThinkingBoxProps) {
	const [state, setState] = useState<ThinkingState>(() =>
		reduceThinking({ open: false, manual: null }, !!streaming, false),
	);
	const prevStreaming = useRef(!!streaming);

	useEffect(() => {
		const was = prevStreaming.current;
		prevStreaming.current = !!streaming;
		setState((prev) => reduceThinking(prev, !!streaming, was));
	}, [streaming]);

	if (!text) return null;

	const label = streaming
		? `思考中…${text.length > 0 ? `（${text.length} 字）` : ""}`
		: `思考过程（${text.length} 字）`;

	return (
		<div className="mb-2 overflow-hidden rounded-lg border border-[#e8e8ed] bg-[#fafafa]">
			<button
				type="button"
				onClick={() => setState((prev) => ({ open: !prev.open, manual: !prev.open }))}
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-[#6e6e73] transition-colors hover:bg-[#f2f2f3]"
				aria-expanded={state.open}
			>
				<span
					className={`inline-block transition-transform duration-150 ${state.open ? "rotate-90" : ""}`}
					aria-hidden
				>
					▶
				</span>
				<span className={streaming ? "streaming-caret" : ""}>{label}</span>
			</button>
			{state.open && (
				<div className="max-h-72 overflow-y-auto border-t border-[#e8e8ed] px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#86868b]">
					{text}
				</div>
			)}
		</div>
	);
}
