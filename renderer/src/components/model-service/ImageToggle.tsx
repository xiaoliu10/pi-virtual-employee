/** Checkbox chips replicated from pi Desktop ModelMetadataDialog (输入类型): [✓ 文本] [☑ 图片]. */
export function TextInputChip() {
	return (
		<span
			role="checkbox"
			aria-checked="true"
			aria-disabled="true"
			className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-400"
		>
			<span aria-hidden="true" className="grid h-3.5 w-3.5 place-items-center rounded-[4px] border border-slate-300 bg-slate-200 text-[9px] text-white">✓</span>
			文本
		</span>
	);
}

export function ImageCheckboxChip(props: {
	checked: boolean;
	onChange: (value: boolean) => void;
	/** When true the model has no explicit override yet (inherits the registry base). */
	inherited?: boolean;
	/** Accessible name, e.g. "<modelId> 图片输入". */
	label?: string;
	/** Shown in the tooltip when an explicit override exists (how to revert). */
	recoveryHint?: string;
}) {
	return (
		<button
			type="button"
			role="checkbox"
			aria-label={props.label}
			aria-checked={props.checked}
			onClick={() => props.onChange(!props.checked)}
			title={`${props.inherited ? "默认继承模型注册表的能力声明；点击后改为强制指定" : "图片输入能力声明，应与服务商提供的模型一致"}${props.recoveryHint ? `。${props.recoveryHint}` : ""}`}
			className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300"
		>
			<span
				aria-hidden="true"
				className={`grid h-3.5 w-3.5 place-items-center rounded-[4px] border text-[9px] ${
					props.checked ? "border-[#1d1d1f] bg-[#1d1d1f] text-white" : "border-slate-300 bg-white text-transparent"
				}`}
			>
				✓
			</span>
			图片
		</button>
	);
}
