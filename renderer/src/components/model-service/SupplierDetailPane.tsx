import { useEffect, useState } from "react";
import type { ModelConfig, Supplier } from "../../lib/types";
import { api } from "../../lib/ipc";
import { Toggle } from "./Toggle";
import { EditModelDialog, contextBadge, type ModelOverridePatch } from "./EditModelDialog";

interface SupplierDetailPaneProps {
	supplier: Supplier | null;
	model: ModelConfig;
	testing: boolean;
	testResult: { ok: boolean; text: string } | null;
	onUpdate: (patch: Partial<Supplier>) => void;
	onToggle: (enabled: boolean) => void;
	onDelete: () => void;
	onSetDefault: (modelId: string) => void;
	onAddModel: (modelId: string) => void;
	onRemoveModel: (modelId: string) => void;
	onTest: () => void;
}

const inputCls = "h-11 w-full rounded-xl border border-slate-200 bg-[#f7f8fa] px-3.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100";

export function SupplierDetailPane(props: SupplierDetailPaneProps) {
	const [showKey, setShowKey] = useState(false);
	const [newModel, setNewModel] = useState("");
	/** Effective image-input capability per modelId (from the engine, via IPC). */
	const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
	/** Model id currently open in the edit dialog, if any. */
	const [editingModel, setEditingModel] = useState<string | null>(null);
	const supplier = props.supplier;

	// Re-fetch effective capabilities when the supplier's identity / api type /
	// model list / image overrides change (not on every keystroke of name/key).
	useEffect(() => {
		if (!supplier) {
			setCapabilities({});
			return;
		}
		let cancelled = false;
		api
			.modelCapabilities(supplier)
			.then((caps) => {
				if (!cancelled) setCapabilities(caps);
			})
			.catch(() => {
				/* keep last known */
			});
		return () => {
			cancelled = true;
		};
	}, [supplier?.id, supplier?.apiType, supplier ? JSON.stringify(supplier.modelImage ?? {}) : "", supplier ? supplier.models.join(",") : ""]);

	if (!supplier) {
		return (
			<section className="flex min-w-0 flex-1 items-center justify-center bg-white text-sm text-slate-400">
				请添加或选择一个模型提供商
			</section>
		);
	}

	const isDefaultSupplier = supplier.id === props.model.defaultSupplierId;
	const submitModel = () => {
		const modelId = newModel.trim();
		if (!modelId) return;
		props.onAddModel(modelId);
		setNewModel("");
	};

	/** Apply a per-model override patch from the edit dialog: merges each map and
	 * drops keys that the dialog cleared (empty string = remove the override). */
	const applyModelPatch = (modelId: string, patch: ModelOverridePatch) => {
		const mergeTokens = (map: Record<string, number> | undefined, raw?: string) => {
			if (raw === undefined) return map;
			const next = { ...(map ?? {}) };
			const n = Math.floor(Number(raw));
			if (!raw.trim() || !Number.isFinite(n) || n <= 0) delete next[modelId];
			else next[modelId] = n;
			return Object.keys(next).length ? next : undefined;
		};
		let imageMap = supplier.modelImage;
		if (patch.image !== undefined) {
			const next = { ...(supplier.modelImage ?? {}) };
			if (patch.image === "inherit") delete next[modelId];
			else next[modelId] = patch.image;
			imageMap = Object.keys(next).length ? next : undefined;
		}
		props.onUpdate({
			modelContextWindow: mergeTokens(supplier.modelContextWindow, patch.contextWindow),
			modelMaxTokens: mergeTokens(supplier.modelMaxTokens, patch.maxTokens),
			modelImage: imageMap,
		});
	};

	/** Effective context window for the chip badge: override else nothing (inherit is invisible). */
	const editing = supplier && editingModel && supplier.models.includes(editingModel) ? editingModel : null;

	return (
		<section className="flex min-w-0 flex-1 flex-col bg-white">
			<div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-7">
				<div className="flex items-center justify-between border-b border-slate-100 pb-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="truncate text-xl font-semibold text-slate-950">{supplier.name} 提供商设置</h2>
							{supplier.enabled && <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-600">已开启</span>}
							{isDefaultSupplier && <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-600">全局默认</span>}
						</div>
						<p className="mt-1 text-xs text-slate-400">配置会在保存后用于新对话；已有对话可单独切换模型。</p>
					</div>
					<div className="flex items-center gap-3">
						<Toggle checked={supplier.enabled} onChange={props.onToggle} label={`${supplier.name} 启用状态`} />
						<button type="button" onClick={props.onDelete} className="rounded-lg px-2.5 py-1.5 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-500">删除</button>
					</div>
				</div>

				<div className="mt-6 space-y-5">
					<label className="block">
						<span className="mb-2 block text-sm font-medium text-slate-800">提供商名称</span>
						<input value={supplier.name} onChange={(event) => props.onUpdate({ name: event.target.value })} className={inputCls} placeholder="提供商名称" />
					</label>

					<label className="block">
						<div className="mb-2 flex items-center justify-between">
							<span className="text-sm font-medium text-slate-800">API Key <span className="text-rose-500">*</span></span>
							<span className="text-xs text-blue-500">密钥仅保存在本机</span>
						</div>
						<div className="relative">
							<input type={showKey ? "text" : "password"} value={supplier.apiKey} onChange={(event) => props.onUpdate({ apiKey: event.target.value })} className={`${inputCls} pr-20 font-mono`} placeholder="sk-..." />
							<div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
								{supplier.apiKey && <button type="button" onClick={() => props.onUpdate({ apiKey: "" })} className="rounded-full px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-200">✕</button>}
								<button type="button" onClick={() => setShowKey((value) => !value)} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200" title={showKey ? "隐藏 API Key" : "显示 API Key"}>
									{showKey ? "隐藏" : "显示"}
								</button>
							</div>
						</div>
					</label>

					<label className="block">
						<span className="mb-2 block text-sm font-medium text-slate-800">API Base URL</span>
						<div className="relative">
							<input value={supplier.baseUrl} onChange={(event) => props.onUpdate({ baseUrl: event.target.value })} className={`${inputCls} pr-10 font-mono text-xs`} placeholder={supplier.apiType === "openai" ? "https://api.example.com/v1" : "https://api.example.com"} />
							{supplier.baseUrl && <button type="button" onClick={() => props.onUpdate({ baseUrl: "" })} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-200">✕</button>}
						</div>
					</label>

					<fieldset>
						<legend className="mb-2 text-sm font-medium text-slate-800">API 格式</legend>
						<div className="flex items-center gap-6">
							{(["anthropic", "openai"] as const).map((apiType) => (
								<label key={apiType} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
									<input type="radio" name={`api-${supplier.id}`} checked={supplier.apiType === apiType} onChange={() => props.onUpdate({ apiType })} className="h-4 w-4 accent-blue-500" />
									{apiType === "anthropic" ? "Anthropic 兼容" : "OpenAI 兼容"}
								</label>
							))}
						</div>
						<p className="mt-2 text-xs leading-relaxed text-slate-400">需与 Base URL 的接口协议一致，OpenAI 兼容地址通常以 /v1 结尾。</p>
					</fieldset>

					<div className="flex items-center gap-3">
						<button type="button" onClick={props.onTest} disabled={props.testing || !supplier.models.length || !supplier.apiKey.trim()} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
							{props.testing ? "测试中..." : "⌁  测试连接"}
						</button>
						{props.testResult && <span className={`text-xs ${props.testResult.ok ? "text-emerald-600" : "text-rose-500"}`}>{props.testResult.text}</span>}
					</div>

					<div className="pt-1">
						<div className="mb-3 flex items-center justify-between">
							<div className="flex items-baseline gap-2">
								<h3 className="text-sm font-semibold text-slate-900">可用模型列表</h3>
								<span className="text-xs text-slate-400">({supplier.models.length})</span>
							</div>
						</div>

						<div className="flex flex-wrap gap-2.5">
							{supplier.models.map((modelId) => {
								const isDefault = supplier.id === props.model.defaultSupplierId && modelId === props.model.defaultModelId;
								const badge = contextBadge(supplier.modelContextWindow?.[modelId]);
								const supportsImage = capabilities[modelId] ?? false;
								return (
									<div
										key={modelId}
										className={`group flex items-center gap-2 rounded-full border py-1.5 pl-3 pr-1.5 transition ${isDefault ? "border-blue-300 bg-blue-50/60" : "border-slate-200 bg-white hover:border-slate-300"}`}
									>
										<button
											type="button"
											onClick={() => setEditingModel(modelId)}
											title="编辑模型配置（上下文窗口 / 最大输出 / 输入类型）"
											className="flex items-center gap-2 text-sm font-medium text-slate-800"
										>
											{modelId}
											{badge && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">{badge}</span>}
											{supportsImage && <span title="支持图片输入" className="text-[11px]">🖼️</span>}
											{isDefault && <span className="rounded-md bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-600">默认</span>}
										</button>
										{!isDefault && supplier.enabled && (
											<button type="button" onClick={() => props.onSetDefault(modelId)} title="设为默认模型" className="hidden rounded-full px-1.5 py-0.5 text-[11px] text-blue-500 hover:bg-blue-50 group-hover:block">★</button>
										)}
										<button type="button" onClick={() => props.onRemoveModel(modelId)} title="删除模型" className="rounded-full px-1.5 py-0.5 text-xs text-[#6e6e73] hover:bg-rose-50 hover:text-rose-500">✕</button>
									</div>
								);
							})}
							{supplier.models.length === 0 && <div className="w-full rounded-xl border border-dashed border-slate-200 px-4 py-7 text-center text-sm text-slate-400">还没有模型，请在下方添加模型 ID。</div>}
						</div>
						<p className="mt-2 text-xs text-slate-400">点击模型可编辑上下文窗口、最大输出与输入类型；徽标为该模型的上下文窗口（未设置则继承默认，不显示）。</p>

						<div className="mt-3 flex gap-2">
							<input value={newModel} onChange={(event) => setNewModel(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submitModel()} className={inputCls} placeholder="模型 ID，例如 claude-sonnet-4-5 / gpt-4o" />
							<button type="button" onClick={submitModel} className="shrink-0 rounded-xl bg-[#1d1d1f] px-4 text-sm font-medium text-white hover:bg-[#3f3f43]">＋ 添加模型</button>
						</div>
					</div>
				</div>
			</div>
			{editing && (
				<EditModelDialog
					supplier={supplier}
					modelId={editing}
					effectiveImage={capabilities[editing] ?? false}
					onApply={applyModelPatch}
					onClose={() => setEditingModel(null)}
				/>
			)}
		</section>
	);
}
