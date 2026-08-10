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
		<div className="border-t border-slate-200 bg-white/80 px-6 py-4 backdrop-blur">
			<div className="mx-auto flex max-w-3xl items-end gap-3">
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
					placeholder="输入消息,Enter 发送,Shift+Enter 换行"
					className="min-h-[46px] flex-1 resize-none rounded-xl border border-slate-300 bg-white px-4 py-3 text-[15px] outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
				/>
				<button
					onClick={submit}
					disabled={disabled || !value.trim()}
					className="flex h-[46px] shrink-0 items-center rounded-xl bg-ink-900 px-5 text-sm font-medium text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{disabled ? "应答中…" : "发送"}
				</button>
			</div>
		</div>
	);
}
