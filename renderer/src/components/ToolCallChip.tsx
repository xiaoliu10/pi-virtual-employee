interface ToolCallChipProps {
	name: string;
	done: boolean;
	isError?: boolean;
}

export function ToolCallChip({ name, done, isError }: ToolCallChipProps) {
	const tone = isError
		? "border-rose-200 bg-rose-50 text-rose-600"
		: done
			? "border-emerald-200 bg-emerald-50 text-emerald-600"
			: "border-slate-200 bg-slate-50 text-slate-500";
	const dot = isError ? "bg-rose-400" : done ? "bg-emerald-400" : "animate-pulse bg-slate-400";

	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}
		>
			<span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
			{name}
			{done && (isError ? " · 失败" : " · 完成")}
		</span>
	);
}
