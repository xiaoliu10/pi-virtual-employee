import { useState } from "react";

interface ComposerProps {
	onSend: (text: string) => void;
	disabled?: boolean;
}

export function Composer({ onSend, disabled }: ComposerProps) {
	const [value, setValue] = useState("");

	const submit = () => {
		const text = value.trim();
		if (!text || disabled) return;
		onSend(text);
		setValue("");
	};

	return (
		<div className="border-t border-slate-200 bg-[#14171d] px-6 py-4">
			{/* pi-desktop composer: one rounded panel holding a borderless input
			 * and a light primary action — no separate boxed field. */}
			<div className="mx-auto flex max-w-3xl items-end gap-3 rounded-2xl border border-[#414854] bg-ink-800 p-3">
				<textarea
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
					rows={1}
					placeholder="描述任务，或输入消息…"
					className="max-h-[180px] min-h-[46px] flex-1 resize-none border-0 bg-transparent px-2 py-2 text-[15px] outline-none placeholder:text-slate-500"
				/>
				<button
					onClick={submit}
					disabled={disabled || !value.trim()}
					className="flex h-[42px] shrink-0 items-center rounded-xl bg-[#e1e7ef] px-5 text-sm font-medium text-[#171c24] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
				>
					{disabled ? "应答中…" : "发送 ↑"}
				</button>
			</div>
		</div>
	);
}
