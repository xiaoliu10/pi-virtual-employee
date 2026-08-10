interface ToggleProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
}

export function Toggle({ checked, onChange, label }: ToggleProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			onClick={(event) => {
				event.stopPropagation();
				onChange(!checked);
			}}
			className={`relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors ${
				checked ? "bg-blue-500" : "bg-slate-300"
			}`}
		>
			<span
				className={`absolute left-0 top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
					checked ? "translate-x-[23px]" : "translate-x-[3px]"
				}`}
			/>
		</button>
	);
}
