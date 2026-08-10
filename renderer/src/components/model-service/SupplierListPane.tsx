import type { ModelConfig, Supplier } from "../../lib/types";
import { Toggle } from "./Toggle";

interface SupplierListPaneProps {
	model: ModelConfig;
	selectedId: string | null;
	search: string;
	onSearchChange: (value: string) => void;
	onSelect: (id: string) => void;
	onToggle: (id: string, enabled: boolean) => void;
	onAdd: () => void;
	onImport: () => void;
	onExport: () => void;
}

const providerColor: Record<Supplier["apiType"], string> = {
	anthropic: "bg-sky-50 text-sky-600",
	openai: "bg-emerald-50 text-emerald-600",
};

function SupplierMark({ supplier }: { supplier: Supplier }) {
	return (
		<div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${providerColor[supplier.apiType]}`}>
			{supplier.name.trim().slice(0, 1).toUpperCase() || (supplier.apiType === "openai" ? "O" : "A")}
		</div>
	);
}

export function SupplierListPane(props: SupplierListPaneProps) {
	const enabledCount = props.model.suppliers.filter((supplier) => supplier.enabled).length;
	const keyword = props.search.trim().toLowerCase();
	const suppliers = props.model.suppliers.filter((supplier) =>
		!keyword || supplier.name.toLowerCase().includes(keyword) || supplier.apiType.includes(keyword));

	return (
		<section className="flex min-h-0 w-[320px] shrink-0 flex-col border-r border-slate-200 bg-[#f7f8fa]">
			<div className="px-7 pb-3 pt-7">
				<div className="flex items-center justify-between">
					<div className="flex items-baseline gap-2">
						<h2 className="text-[16px] font-semibold text-slate-900">模型提供商</h2>
						<span className="text-xs text-slate-400">{enabledCount}/{props.model.suppliers.length} 已启用</span>
					</div>
					<div className="flex gap-1.5">
						<button type="button" onClick={props.onImport} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50">导入</button>
						<button type="button" onClick={props.onExport} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50">导出</button>
					</div>
				</div>

				<div className="relative mt-4">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400">
						<circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="m20 20-3.5-3.5" />
					</svg>
					<input
						value={props.search}
						onChange={(event) => props.onSearchChange(event.target.value)}
						placeholder="搜索提供商..."
						className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
					/>
				</div>
			</div>

			<div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-7 pb-3">
				{suppliers.map((supplier) => {
					const selected = supplier.id === props.selectedId;
					return (
						<button
							type="button"
							key={supplier.id}
							onClick={() => props.onSelect(supplier.id)}
							className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition ${
								selected
									? "border-blue-500 bg-blue-50/80 shadow-sm"
									: "border-transparent bg-white hover:border-slate-200"
							}`}
						>
							<SupplierMark supplier={supplier} />
							<div className="min-w-0 flex-1">
								<div className={`truncate text-sm font-medium ${selected ? "text-blue-600" : "text-slate-800"}`}>{supplier.name}</div>
								<div className="mt-0.5 text-[11px] text-slate-400">{supplier.apiType === "anthropic" ? "Anthropic 兼容" : "OpenAI 兼容"} · {supplier.models.length} 个模型</div>
							</div>
							<Toggle checked={supplier.enabled} onChange={(enabled) => props.onToggle(supplier.id, enabled)} label={`${supplier.name} 启用状态`} />
						</button>
					);
				})}
				{suppliers.length === 0 && (
					<div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">没有匹配的提供商</div>
				)}
			</div>

			<div className="border-t border-slate-200 px-7 py-4">
				<button type="button" onClick={props.onAdd} className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-blue-300 bg-blue-50/40 px-3 py-2.5 text-sm font-medium text-blue-600 hover:bg-blue-50">
					<span className="text-lg leading-none">＋</span> 添加提供商
				</button>
			</div>
		</section>
	);
}
