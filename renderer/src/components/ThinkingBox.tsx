import { useEffect, useRef, useState } from "react";

interface ThinkingBoxProps {
	/** Accumulated reasoning text (may still be growing while streaming). */
	text: string;
	/** True while the model is still producing output for this turn. */
	streaming?: boolean;
}

/**
 * Collapsible reasoning box.
 *
 * Behaviour (user ruling 2026-11-04): expanded WHILE streaming so the work is
 * visible as it happens, then auto-collapsed once the answer is done — the
 * finished transcript stays readable, and the reasoning is one click away.
 * A manual toggle always wins over the automatic behaviour for that turn, so
 * someone who expands a collapsed box is not fought by a re-render.
 */
export function ThinkingBox({ text, streaming }: ThinkingBoxProps) {
	const [open, setOpen] = useState(true);
	// null = follow the streaming state; true/false = the user decided.
	const [manual, setManual] = useState<boolean | null>(null);
	const wasStreaming = useRef(streaming);

	useEffect(() => {
		// Auto-collapse exactly on the streaming → done edge. Doing it on every
		// render would fight the user; doing it only when `streaming` is false
		// would collapse a historical message on mount (they should default to
		// collapsed too, but without the transition animation).
		if (wasStreaming.current && !streaming) {
			setOpen(false);
			setManual(null);
		}
		wasStreaming.current = streaming;
	}, [streaming]);

	useEffect(() => {
		if (manual === null) setOpen(!!streaming);
	}, [streaming, manual]);

	const isOpen = manual ?? open;
	const chars = text.length;
	const label = streaming
		? `思考中… ${chars > 0 ? `（${chars} 字）` : ""}`
		: `思考过程（${chars} 字）`;

	if (!text) return null;

	return (
		<div className="mb-2 overflow-hidden rounded-lg border border-[#e8e8ed] bg-[#fafafa]">
			<button
				type="button"
				onClick={() => {
					const next = !isOpen;
					setManual(next);
					setOpen(next);
				}}
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-[#6e6e73] transition-colors hover:bg-[#f2f2f3]"
				aria-expanded={isOpen}
			>
				<span
					className={`inline-block transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
					aria-hidden
				>
					▶
				</span>
				<span className={streaming ? "streaming-caret" : ""}>{label}</span>
			</button>
			{isOpen && (
				<div className="max-h-72 overflow-y-auto border-t border-[#e8e8ed] px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#86868b]">
					{text}
				</div>
			)}
		</div>
	);
}
