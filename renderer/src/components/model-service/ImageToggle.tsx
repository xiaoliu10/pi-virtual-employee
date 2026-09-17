/** Tri-state image-input control for a model: 继承 (inherit base) / 支持 / 关闭. */
export function ImageToggle(props: {
	explicit: boolean | undefined;
	effective: boolean;
	onChange: (value: "inherit" | boolean) => void;
}) {
	const opts = [
		{ key: "inherit", label: "继承", value: "inherit" as const },
		{ key: "on", label: "支持", value: true as const },
		{ key: "off", label: "关闭", value: false as const },
	];
	const isActive = (v: "inherit" | boolean) =>
		props.explicit === undefined ? v === "inherit" : v === props.explicit;
	const tone = (v: "inherit" | boolean) =>
		isActive(v)
			? v === false
				? "bg-rose-50 text-rose-600"
				: v === true
					? "bg-blue-50 text-blue-600"
					: "bg-slate-100 text-slate-600"
			: "text-slate-400 hover:bg-slate-50";
	return (
		<div
			className="flex items-center gap-0.5 rounded-lg border border-slate-200 p-0.5"
			title={`图像识别 · 当前生效：${props.effective ? "支持" : "不支持"}${props.explicit === undefined ? "（继承默认）" : ""}`}
		>
			{opts.map((o) => (
				<button
					key={o.key}
					type="button"
					onClick={() => props.onChange(o.value)}
					className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${tone(o.value)}`}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
