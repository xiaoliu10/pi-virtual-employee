import { useCallback, useEffect, useRef, useState } from "react";
import {
	COMPOSER_HEIGHT_KEY,
	clampComposerHeight,
	heightCeilingForViewport,
	heightFromDrag,
} from "../lib/composer-height";

interface ComposerProps {
	onSend: (text: string) => void;
	disabled?: boolean;
}

/**
 * pi-desktop composer: a floating white card (radius 20, border-strong, no
 * outer strip), borderless tall input, and a toolbar row ending in a 30px
 * near-black square send button.
 *
 * Resizable since 0.2.195 (user: "怎么还不支持拖动对话框大小" — the 0.2.193
 * resize only covered the embedded widget). Drag the strip along the CARD's
 * top edge; the height is remembered across restarts and clamped both
 * absolutely and against the viewport so the transcript can never be starved.
 */
export function Composer({ onSend, disabled }: ComposerProps) {
	const [value, setValue] = useState("");
	const [height, setHeight] = useState(() => clampComposerHeight(readStored()));
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	/** Effective ceiling: absolute max, but never more room than the window has. */
	const ceiling = () => heightCeilingForViewport(
		typeof window === "undefined" ? 0 : window.innerHeight,
	);

	const persist = useCallback((next: number) => {
		try {
			window.localStorage?.setItem(COMPOSER_HEIGHT_KEY, String(next));
		} catch {
			// Private mode / storage disabled: resizing still works, it just
			// does not survive a restart.
		}
	}, []);

	// Pointer handlers live on window so a fast drag that leaves the 4px strip
	// keeps tracking (same lesson as the sidebar divider).
	useEffect(() => {
		if (!dragging) return;
		const move = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;
			// Dragging UP (negative deltaY) makes the composer TALLER.
			const next = heightFromDrag(drag.startHeight, drag.startY - e.clientY);
			setHeight(Math.min(next, ceiling()));
		};
		const up = () => {
			setDragging(false);
			dragRef.current = null;
			setHeight((h) => {
				const clamped = clampComposerHeight(h);
				persist(clamped);
				return clamped;
			});
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
		};
	}, [dragging, persist]);

	// Shrinking the window must not leave the composer taller than the room left.
	useEffect(() => {
		const onResize = () => setHeight((h) => Math.min(h, ceiling()));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const submit = () => {
		const text = value.trim();
		if (!text || disabled) return;
		onSend(text);
		setValue("");
	};

	return (
		<div className="bg-white px-6 pb-5 pt-1">
			<div className="mx-auto w-[min(980px,calc(100%-48px))] rounded-[20px] border border-black/[0.14] bg-white px-3.5 py-3">
				{/* Drag strip: a comfortable hit area with a visible-on-hover handle. */}
				<div
					role="separator"
					aria-orientation="horizontal"
					aria-label="拖动调整输入框高度"
					title="拖动调整输入框高度"
					onPointerDown={(e) => {
						dragRef.current = { startY: e.clientY, startHeight: height };
						setDragging(true);
						e.preventDefault();
					}}
					onDoubleClick={() => {
						// Double-click restores the default — the usual escape from a
						// hand-dragged layout the user no longer wants.
						const d = clampComposerHeight(undefined);
						setHeight(d);
						persist(d);
					}}
					className="group -mx-3.5 -mt-3 mb-1 flex h-3 cursor-ns-resize items-center justify-center rounded-t-[20px]"
				>
					<span className="h-[3px] w-9 rounded-full bg-[#d8d8dc] transition-colors group-hover:bg-[#b4b4bb]" />
				</div>
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
					style={{ height: `${height}px` }}
					placeholder="描述任务，或输入消息…"
					className="block w-full resize-none border-0 bg-transparent px-0.5 pb-3 pt-1.5 text-[15px] leading-normal outline-none placeholder:text-[#a1a1a6] focus:shadow-none focus:outline-none"
				/>
				<div className="flex items-center justify-end gap-1.5 pt-1">
					<button
						onClick={submit}
						disabled={disabled || !value.trim()}
						className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[#1d1d1f] text-sm font-medium text-white transition hover:opacity-[0.82] disabled:bg-[#f2f2f3] disabled:text-[#a1a1a6] disabled:opacity-100"
						aria-label="发送"
						title="发送（Enter）"
					>
						↑
					</button>
				</div>
			</div>
		</div>
	);
}

/** Read the stored height once at mount; any corruption falls back to default. */
function readStored(): number {
	try {
		return clampComposerHeight(window.localStorage?.getItem(COMPOSER_HEIGHT_KEY));
	} catch {
		return clampComposerHeight(undefined);
	}
}
