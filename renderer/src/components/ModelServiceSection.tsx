import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/ipc";
import type { ModelConfig, Supplier } from "../lib/types";
import type { AuthCatalogEntry } from "../../../src/shared/auth";
import { SupplierListPane } from "./model-service/SupplierListPane";
import { SupplierDetailPane } from "./model-service/SupplierDetailPane";
import { AccountLoginSection } from "./model-service/AccountLoginSection";

interface Props {
	model: ModelConfig;
	onUpdate: (next: ModelConfig) => void;
}

const uid = () => globalThis.crypto.randomUUID();

function reconcileDefault(model: ModelConfig): ModelConfig {
	const current = model.suppliers.find((supplier) =>
		supplier.id === model.defaultSupplierId && supplier.enabled && supplier.models.includes(model.defaultModelId));
	if (current) return model;
	const first = model.suppliers.find((supplier) => supplier.enabled && supplier.models.length > 0);
	return {
		...model,
		defaultSupplierId: first?.id ?? "",
		defaultModelId: first?.models[0] ?? "",
	};
}

/** The two sections inside the 自定义模型 page: hand-filled supplier list vs
 *  account login. */
type ModelView = "suppliers" | "account";

export function ModelServiceSection({ model, onUpdate }: Props) {
	const [view, setView] = useState<ModelView>("suppliers");
	const [selectedId, setSelectedId] = useState<string | null>(model.suppliers[0]?.id ?? null);
	const [search, setSearch] = useState("");
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

	useEffect(() => {
		if (selectedId && model.suppliers.some((supplier) => supplier.id === selectedId)) return;
		setSelectedId(model.suppliers[0]?.id ?? null);
	}, [model.suppliers, selectedId]);

	useEffect(() => setTestResult(null), [selectedId]);

	const selected = useMemo(
		() => model.suppliers.find((supplier) => supplier.id === selectedId) ?? null,
		[model.suppliers, selectedId],
	);

	const emit = (next: ModelConfig) => onUpdate(reconcileDefault(next));
	const updateSupplier = (id: string, patch: Partial<Supplier>) => {
		emit({ ...model, suppliers: model.suppliers.map((supplier) => supplier.id === id ? { ...supplier, ...patch } : supplier) });
	};

	const addSupplier = () => {
		const supplier: Supplier = {
			id: uid(),
			name: "新提供商",
			enabled: true,
			apiType: "anthropic",
			baseUrl: "",
			apiKey: "",
			models: [],
		};
		emit({ ...model, suppliers: [...model.suppliers, supplier] });
		setSelectedId(supplier.id);
		setSearch("");
	};

	const removeSupplier = (id: string) => {
		const index = model.suppliers.findIndex((supplier) => supplier.id === id);
		const suppliers = model.suppliers.filter((supplier) => supplier.id !== id);
		emit({ ...model, suppliers });
		setSelectedId(suppliers[Math.min(index, suppliers.length - 1)]?.id ?? null);
	};

	/** 「添加为模型供应商」on the login-done page: create (or refresh an
	 *  existing same-authProvider) supplier with the catalog's model list
	 *  prefilled. Auth rides the stored account credential — apiKey/baseUrl
	 *  stay empty. Preserves per-model overrides on refresh; switches back to
	 *  the supplier list with the supplier selected. */
	const addSupplierFromAuth = (entry: AuthCatalogEntry) => {
		const existing = model.suppliers.find((supplier) => supplier.authProvider === entry.provider);
		const supplier: Supplier = {
			id: existing?.id ?? uid(),
			name: entry.name,
			enabled: true,
			apiType: existing?.apiType ?? "openai",
			baseUrl: "",
			apiKey: "",
			models: entry.models.map((m) => m.id),
			...(existing?.modelImage ? { modelImage: existing.modelImage } : {}),
			...(existing?.modelContextWindow ? { modelContextWindow: existing.modelContextWindow } : {}),
			...(existing?.modelMaxTokens ? { modelMaxTokens: existing.modelMaxTokens } : {}),
			authProvider: entry.provider,
		};
		const suppliers = existing
			? model.suppliers.map((item) => (item.id === existing.id ? supplier : item))
			: [...model.suppliers, supplier];
		emit({ ...model, suppliers });
		setSelectedId(supplier.id);
		setSearch("");
		setView("suppliers");
	};

	const addModel = (modelId: string) => {
		if (!selected || selected.models.includes(modelId)) return;
		const next = model.suppliers.map((supplier) => supplier.id === selected.id
			? { ...supplier, models: [...supplier.models, modelId] }
			: supplier);
		emit({ ...model, suppliers: next });
	};

	const removeModel = (modelId: string) => {
		if (!selected) return;
		emit({
			...model,
			suppliers: model.suppliers.map((supplier) => {
				if (supplier.id !== selected.id) return supplier;
				const models = supplier.models.filter((id) => id !== modelId);
				// Drop any stale image override for the removed model.
				const prevImage = supplier.modelImage;
				if (!prevImage || !(modelId in prevImage)) return { ...supplier, models };
				const nextImage = { ...prevImage };
				delete nextImage[modelId];
				return { ...supplier, models, modelImage: Object.keys(nextImage).length ? nextImage : undefined };
			}),
		});
	};

	const testConnection = async () => {
		if (!selected) return;
		const modelId = selected.id === model.defaultSupplierId && selected.models.includes(model.defaultModelId)
			? model.defaultModelId
			: selected.models[0];
		if (!modelId) return;
		setTesting(true);
		setTestResult(null);
		try {
			const result = await api.testModel(selected, modelId);
			setTestResult({ ok: true, text: `连接成功：${result.reply.slice(0, 36)}` });
		} catch (error) {
			setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
		} finally {
			setTesting(false);
		}
	};

	const importConfig = async () => {
		try {
			const imported = await api.importModelConfig();
			if (!imported) return;
			onUpdate(imported);
			setSelectedId(imported.suppliers[0]?.id ?? null);
		} catch (error) {
			setTestResult({ ok: false, text: `导入失败：${error instanceof Error ? error.message : String(error)}` });
		}
	};

	const exportConfig = async () => {
		try {
			await api.exportModelConfig(model);
		} catch (error) {
			setTestResult({ ok: false, text: `导出失败：${error instanceof Error ? error.message : String(error)}` });
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center border-b border-slate-100 px-7 py-2.5">
				<div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
					<button
						type="button"
						onClick={() => setView("suppliers")}
						className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${view === "suppliers" ? "bg-black/[0.075] text-[#1d1d1f]" : "text-[#6e6e73] hover:text-[#1d1d1f]"}`}
					>
						自定义供应商
					</button>
					<button
						type="button"
						onClick={() => setView("account")}
						className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${view === "account" ? "bg-black/[0.075] text-[#1d1d1f]" : "text-[#6e6e73] hover:text-[#1d1d1f]"}`}
					>
						账号登录
					</button>
				</div>
			</div>
			{view === "suppliers" ? (
				<div className="flex min-h-0 flex-1">
					<SupplierListPane
						model={model}
						selectedId={selectedId}
						search={search}
						onSearchChange={setSearch}
						onSelect={setSelectedId}
						onToggle={(id, enabled) => updateSupplier(id, { enabled })}
						onAdd={addSupplier}
						onImport={() => void importConfig()}
						onExport={() => void exportConfig()}
					/>
					<SupplierDetailPane
						supplier={selected}
						model={model}
						testing={testing}
						testResult={testResult}
						onUpdate={(patch) => selected && updateSupplier(selected.id, patch)}
						onToggle={(enabled) => selected && updateSupplier(selected.id, { enabled })}
						onDelete={() => selected && removeSupplier(selected.id)}
						onSetDefault={(modelId) => selected && onUpdate({ ...model, defaultSupplierId: selected.id, defaultModelId: modelId })}
						onAddModel={addModel}
						onRemoveModel={removeModel}
						onTest={() => void testConnection()}
					/>
				</div>
			) : (
				<AccountLoginSection onCreateSupplier={addSupplierFromAuth} />
			)}
		</div>
	);
}
