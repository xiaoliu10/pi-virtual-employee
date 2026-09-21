import { useState } from "react";

interface ComposerProps {
	onSend: (text: string) => void;
	disabled?: boolean;
}

/** pi-desktop composer: a floating white card (radius 20, border-strong, no
 * outer strip), borderless tall input, and a toolbar row ending in a 30px
 * near-black square send button. */
export function Composer({ onSend, disabled }: ComposerProps) {
	const [value, setValue] = useState("");

	const submit = () => {
		const text = value.trim();
		if (!text || disabled) return;
		onSend(text);
		setValue("");
	};

	return (
		<div className="bg-white px-6 pb-5 pt-1">
			<div className="mx-auto w-[min(980px,calc(100%-48px))] rounded-[20px] border border-black/[0.14] bg-white px-3.5 py-3">
				<textarea
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
					rows={2}
					placeholder="描述任务，或输入消息…"
					className="block max-h-[180px] min-h-[76px] w-full resize-none border-0 bg-transparent px-0.5 pb-3 pt-2.5 text-[15px] leading-normal outline-none placeholder:text-[#a1a1a6] focus:shadow-none focus:outline-none"
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
