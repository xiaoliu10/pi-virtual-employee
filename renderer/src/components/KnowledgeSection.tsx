import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/ipc";
import {
	EXTERNAL_PRESET_TYPES,
	applyExternalPreset,
	newExternalProvider,
} from "../lib/external-presets";
import type {
	ExternalDoc,
	ExternalOpTemplate,
	ExternalPresetType,
	ExternalProviderConfig,
	KbConfig,
	KbGap,
	KnowledgeDoc,
	KnowledgeEntry,
	SearchHit,
	Supplier,
	VectorStatus,
} from "../lib/types";

interface Props {
	kb: KbConfig;
	suppliers: Supplier[];
	onUpdate: (next: KbConfig) => void;
}

const inputCls =
	"h-11 w-full rounded-xl border border-slate-200 bg-[#f7f8fa] px-3.5 text-sm text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100";

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
	return (
		<label className="block">
			<span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>
			{children}
			{hint && <span className="mt-1.5 block text-xs leading-relaxed text-slate-400">{hint}</span>}
		</label>
	);
}

function Card({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
	return (
		<section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
			<div className="mb-4">
				<h3 className="text-[15px] font-semibold text-slate-800">{title}</h3>
				{desc && <p className="mt-1 text-xs text-slate-400">{desc}</p>}
			</div>
			{children}
		</section>
	);
}

export function KnowledgeSection({ kb, suppliers, onUpdate }: Props) {
	const setKb = (patch: Partial<KbConfig>) => onUpdate({ ...kb, ...patch });
	const setLocal = (patch: Partial<KbConfig["local"]>) => setKb({ local: { ...kb.local, ...patch } });
	const setHybrid = (patch: Partial<KbConfig["local"]["hybrid"]>) =>
		setLocal({ hybrid: { ...kb.local.hybrid, ...patch } });
	const setEmbedding = (patch: Partial<KbConfig["local"]["embedding"]>) =>
		setLocal({ embedding: { ...kb.local.embedding, ...patch } });
	const setLearn = (patch: Partial<KbConfig["learn"]>) => setKb({ learn: { ...kb.learn, ...patch } });
	const setResearch = (patch: Partial<KbConfig["research"]>) =>
		setKb({ research: { ...kb.research, ...patch } });

	// Embedding-eligible suppliers: OpenAI-compatible + enabled (Anthropic has none).
	const embeddingSuppliers = suppliers.filter((s) => s.enabled && s.apiType === "openai");

	// --- vector status / reindex ---
	const [vs, setVs] = useState<VectorStatus | null>(null);
	const [reindexing, setReindexing] = useState(false);
	const refreshVs = () => api.vectorStatusKnowledge().then(setVs).catch(() => {});
	useEffect(() => {
		refreshVs();
	}, []);

	const reindex = async () => {
		setReindexing(true);
		try {
			await api.reindexKnowledge();
			await refreshVs();
		} finally {
			setReindexing(false);
		}
	};

	// --- embedding test ---
	const [testingEmb, setTestingEmb] = useState(false);
	const [embResult, setEmbResult] = useState<{ ok: boolean; dims: number; error?: string } | null>(null);
	const testEmbedding = async () => {
		const emb = kb.local.embedding;
		const input =
			emb.mode === "custom"
				? { baseUrl: emb.baseUrl, apiKey: emb.apiKey, model: emb.model }
				: (() => {
						const s = embeddingSuppliers.find((x) => x.id === emb.supplierId);
						return s ? { baseUrl: s.baseUrl, apiKey: s.apiKey, model: emb.model } : null;
					})();
		if (!input) return;
		setTestingEmb(true);
		setEmbResult(null);
		try {
			const result = await api.testEmbedding(input);
			setEmbResult(result);
			if (result.ok && result.dims > 0) setEmbedding({ dimensions: result.dims }); // backfill
		} finally {
			setTestingEmb(false);
		}
	};

	// --- content: entries (live + archived) ---
	const [allEntries, setAllEntries] = useState<KnowledgeEntry[]>([]);
	const [entrySearch, setEntrySearch] = useState("");
	const [editing, setEditing] = useState<{ id?: string; title: string; tags: string; content: string } | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [confirmId, setConfirmId] = useState<string | null>(null); // two-step delete confirmation
	const [showArchive, setShowArchive] = useState(false);
	const refreshEntries = () => api.listKnowledgeEntries(true).then(setAllEntries).catch(() => {});
	useEffect(() => {
		refreshEntries();
	}, []);

	const liveEntries = allEntries.filter((e) => !e.archived);
	const archivedEntries = allEntries.filter((e) => e.archived);
	const filterFn = (e: KnowledgeEntry) => {
		const q = entrySearch.trim().toLowerCase();
		if (!q) return true;
		return (
			e.title.toLowerCase().includes(q) ||
			e.tags.toLowerCase().includes(q) ||
			e.content.toLowerCase().includes(q)
		);
	};
	const visibleLive = liveEntries.filter(filterFn);

	// Auto-clear the two-step delete confirmation after a delay.
	const askDelete = (id: string) => {
		setConfirmId(id);
		setTimeout(() => setConfirmId((cur) => (cur === id ? null : cur)), 3000);
	};

	const saveEntry = async () => {
		if (!editing || !editing.title.trim()) return;
		await api.upsertKnowledgeEntry(editing);
		setEditing(null);
		refreshEntries();
		refreshVs();
	};
	const removeEntry = async (id: string) => {
		await api.deleteKnowledgeEntry(id);
		setConfirmId(null);
		refreshEntries();
		refreshVs();
	};
	const archiveEntry = async (id: string) => {
		await api.archiveKnowledgeEntry(id);
		refreshEntries();
		refreshVs();
	};
	const restoreEntry = async (id: string) => {
		await api.restoreKnowledgeEntry(id);
		refreshEntries();
		refreshVs();
	};

	// --- content: docs ---
	const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
	const [importing, setImporting] = useState(false);
	const refreshDocs = () => api.listKnowledgeDocs().then(setDocs).catch(() => {});
	useEffect(() => {
		refreshDocs();
	}, []);
	const importDocs = async () => {
		setImporting(true);
		try {
			await api.importKnowledge();
			refreshDocs();
			refreshVs();
		} finally {
			setImporting(false);
		}
	};
	const removeDoc = async (id: string) => {
		await api.deleteKnowledgeDoc(id);
		refreshDocs();
		refreshVs();
	};

	// --- search test ---
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SearchHit[]>([]);
	const runSearch = async () => setHits(await api.searchKnowledge(query));

	// --- auto-learn / consolidation ---
	const setConsolidate = (patch: Partial<KbConfig["learn"]["consolidate"]>) =>
		setLearn({ consolidate: { ...kb.learn.consolidate, ...patch } });
	const [learnStat, setLearnStat] = useState<{
		learnEnabled: boolean;
		consolidateEnabled: boolean;
		intervalMinutes: number;
		consolidatedAt: number;
		researchedAt: number;
		learnedCount: number;
		derivedCount: number;
		researchCount: number;
		pendingCount: number;
		archivedCount: number;
		researchEnabled: boolean;
		gapCount: number;
	} | null>(null);
	const [consolidating, setConsolidating] = useState(false);
	const [consolidateResult, setConsolidateResult] = useState<{
		merged: number;
		archived: number;
		derived: number;
		retagged: number;
		skipped: number;
		error?: string;
	} | null>(null);
	const refreshLearn = () => api.learnStatusKnowledge().then(setLearnStat).catch(() => {});
	useEffect(() => {
		refreshLearn();
	}, []);
	const consolidate = async () => {
		setConsolidating(true);
		try {
			const r = await api.consolidateKnowledge();
			setConsolidateResult(r);
			refreshLearn();
			refreshEntries();
			refreshGaps();
		} finally {
			setConsolidating(false);
		}
	};

	// --- knowledge gaps (KB misses feeding auto-research) ---
	const [gaps, setGaps] = useState<KbGap[]>([]);
	const refreshGaps = () => api.listKnowledgeGaps(20).then(setGaps).catch(() => {});
	useEffect(() => {
		refreshGaps();
	}, []);
	const resolveGap = async (query: string) => {
		await api.resolveKnowledgeGap(query);
		refreshGaps();
		refreshLearn();
	};

	// --- pending-review entries (research findings awaiting approval) ---
	const pendingEntries = allEntries.filter((e) => !e.archived && e.review_status === "pending");
	const approveEntry = async (id: string) => {
		await api.approveKnowledgeEntry(id);
		refreshEntries();
		refreshLearn();
	};

	// --- manual gap-driven research trigger ---
	const [researching, setResearching] = useState(false);
	const [researchResult, setResearchResult] = useState<{
		researched: number;
		gaps: number;
		skipped: number;
		error?: string;
	} | null>(null);
	const runResearch = async () => {
		setResearching(true);
		try {
			const r = await api.researchGapsKnowledge();
			setResearchResult(r);
			refreshEntries();
			refreshLearn();
			refreshGaps();
		} finally {
			setResearching(false);
		}
	};

	// --- external providers ---
	const [activeProvId, setActiveProvId] = useState<string | null>(kb.external.providers[0]?.id ?? null);
	const setProviders = (providers: ExternalProviderConfig[]) =>
		setKb({ external: { ...kb.external, providers } });
	const updateProvider = (id: string, patch: Partial<ExternalProviderConfig>) =>
		setProviders(kb.external.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)));
	const removeProvider = (id: string) => {
		setProviders(kb.external.providers.filter((p) => p.id !== id));
		if (kb.external.activeId === id) setKb({ external: { ...kb.external, activeId: "" } });
	};
	const activeProv = kb.external.providers.find((p) => p.id === activeProvId) ?? null;

	const [provTest, setProvTest] = useState<{ ok: boolean; count: number; error?: string } | null>(null);
	const testProvider = async () => {
		if (!activeProv) return;
		setProvTest(null);
		setProvTest(await api.testExternalKnowledge(activeProv));
	};

	// Switch preset type — refills operation templates, keeps connection fields.
	const changeProviderType = (id: string, type: ExternalPresetType) => {
		const p = kb.external.providers.find((x) => x.id === id);
		if (!p) return;
		setProviders(kb.external.providers.map((x) => (x.id === id ? applyExternalPreset(type, x) : x)));
		setProvTest(null);
		setExtDocs(null);
	};

	// External document management (list / upload / reparse) — UI-only.
	const [extDocs, setExtDocs] = useState<ExternalDoc[] | null>(null);
	const [extDocsLoading, setExtDocsLoading] = useState(false);
	const [uploadLoading, setUploadLoading] = useState(false);
	const [parseLoading, setParseLoading] = useState(false);
	const [extMsg, setExtMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const refreshExtDocs = async () => {
		if (!activeProv) return;
		setExtDocsLoading(true);
		setExtDocs(null);
		try {
			setExtDocs(await api.listExternalKnowledgeDocs(activeProv.id));
		} catch (err) {
			setExtMsg({ ok: false, text: `列表失败：${(err as Error).message}` });
		} finally {
			setExtDocsLoading(false);
		}
	};
	const uploadExtDoc = async () => {
		if (!activeProv) return;
		setUploadLoading(true);
		setExtMsg(null);
		try {
			const r = await api.uploadExternalKnowledge(activeProv.id);
			if (r.canceled) return;
			setExtMsg(
				r.ok
					? { ok: true, text: `上传成功（${r.documentIds.length} 个文档）${r.parsed ? "，已触发解析" : ""}` }
					: { ok: false, text: `上传失败：${r.error}` },
			);
			if (r.ok) void refreshExtDocs();
		} finally {
			setUploadLoading(false);
		}
	};
	const parseExtDoc = async (documentId?: string) => {
		if (!activeProv) return;
		setParseLoading(true);
		setExtMsg(null);
		try {
			const r = await api.parseExternalKnowledge(activeProv.id, documentId);
			setExtMsg(r.ok ? { ok: true, text: `已重新解析 ${r.parsed} 个文档` } : { ok: false, text: `解析失败：${r.error}` });
		} finally {
			setParseLoading(false);
		}
	};

	return (
		<div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-10 py-8">
			<div className="mx-auto max-w-3xl space-y-5">
				{/* 主开关 + 模式 */}
				<Card title="知识库" desc="可配置、可插拔：内置混合检索，亦可外接 Dify / RAGFlow / 自建 RAG。">
					<div className="space-y-4">
						<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
							<div>
								<div className="text-sm font-medium text-slate-800">启用知识库</div>
								<div className="mt-0.5 text-xs text-slate-400">关闭后员工不再查询知识库。</div>
							</div>
							<input
								type="checkbox"
								checked={kb.enabled}
								onChange={(e) => setKb({ enabled: e.target.checked })}
								className="h-5 w-5 accent-blue-500"
							/>
						</label>
						<Field label="检索来源" hint="external 模式下，本地内容仍参与检索并与外接结果融合（叠加，非互斥）。">
							<select value={kb.mode} onChange={(e) => setKb({ mode: e.target.value as KbConfig["mode"] })} className={inputCls}>
								<option value="local">仅内置</option>
								<option value="external">内置 + 外接融合</option>
							</select>
						</Field>
					</div>
				</Card>

				{/* 检索参数 */}
				<Card title="检索参数">
					<div className="grid grid-cols-2 gap-4">
						<Field label="返回条数 topK">
							<input
								type="number"
								min={1}
								value={kb.local.topK}
								onChange={(e) => setLocal({ topK: Number(e.target.value) || 1 })}
								className={inputCls}
							/>
						</Field>
						<Field label="切分大小 / 重叠（字符）">
							<div className="flex gap-2">
								<input type="number" min={100} value={kb.local.chunk.size} onChange={(e) => setLocal({ chunk: { ...kb.local.chunk, size: Number(e.target.value) || 800 } })} className={inputCls} />
								<input type="number" min={0} value={kb.local.chunk.overlap} onChange={(e) => setLocal({ chunk: { ...kb.local.chunk, overlap: Number(e.target.value) || 0 } })} className={inputCls} />
							</div>
						</Field>
						<Field label="BM25 权重">
							<input type="number" step={0.1} min={0} value={kb.local.hybrid.bm25Weight} onChange={(e) => setHybrid({ bm25Weight: Number(e.target.value) })} className={inputCls} />
						</Field>
						<Field label="向量权重">
							<input type="number" step={0.1} min={0} value={kb.local.hybrid.vectorWeight} onChange={(e) => setHybrid({ vectorWeight: Number(e.target.value) })} className={inputCls} />
						</Field>
					</div>
				</Card>

				{/* 向量 / Embedding */}
				<Card title="向量检索（语义）" desc="复用已配置的 OpenAI 兼容供应商生成向量，sqlite-vec 做近邻检索。不可用时自动降级为纯 BM25。">
					<div className="space-y-4">
						<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
							<div>
								<div className="text-sm font-medium text-slate-800">启用向量召回</div>
								<div className="mt-0.5 text-xs text-slate-400">与 BM25 经 RRF 融合。</div>
							</div>
							<input type="checkbox" checked={kb.local.hybrid.vectorEnabled} onChange={(e) => setHybrid({ vectorEnabled: e.target.checked })} className="h-5 w-5 accent-blue-500" />
						</label>
						<div className="space-y-4">
							<Field label="Embedding 来源" hint="供应商模式复用「自定义模型」里 OpenAI 兼容供应商；独立模式可填任意 OpenAI 兼容向量端点。">
								<select value={kb.local.embedding.mode} onChange={(e) => setEmbedding({ mode: e.target.value as "supplier" | "custom" })} className={inputCls}>
									<option value="supplier">复用模型供应商（OpenAI 兼容）</option>
									<option value="custom">独立向量端点</option>
								</select>
							</Field>
							{kb.local.embedding.mode === "supplier" ? (
								<Field label="供应商">
									<select value={kb.local.embedding.supplierId} onChange={(e) => setEmbedding({ supplierId: e.target.value })} className={inputCls}>
										<option value="">未选择</option>
										{embeddingSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
									</select>
								</Field>
							) : (
								<div className="grid grid-cols-2 gap-4">
									<Field label="向量端点 Base URL">
										<input value={kb.local.embedding.baseUrl} onChange={(e) => setEmbedding({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" className={inputCls} />
									</Field>
									<Field label="API Key">
										<input type="password" value={kb.local.embedding.apiKey} onChange={(e) => setEmbedding({ apiKey: e.target.value })} className={inputCls} />
									</Field>
								</div>
							)}
							<Field label="Embedding 模型">
								<input value={kb.local.embedding.model} onChange={(e) => setEmbedding({ model: e.target.value })} placeholder="text-embedding-3-small" className={inputCls} />
							</Field>
						</div>
						<div className="flex flex-wrap items-center gap-3">
							<button type="button" onClick={() => void testEmbedding()} disabled={testingEmb || (kb.local.embedding.mode === "supplier" ? !kb.local.embedding.supplierId : !kb.local.embedding.baseUrl)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
								{testingEmb ? "测试中..." : "测试并回填维度"}
							</button>
							<span className="text-xs text-slate-400">当前维度：{kb.local.embedding.dimensions}</span>
							{embResult && <span className={`text-xs ${embResult.ok ? "text-emerald-600" : "text-rose-500"}`}>{embResult.ok ? `实际维度 ${embResult.dims}，已回填` : `失败：${embResult.error}`}</span>}
						</div>
						<div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">
							<span>状态：</span>
							<span>{vs ? (vs.available ? "✓ sqlite-vec 可用" : "✗ sqlite-vec 不可用（已降级 BM25）") : "读取中..."}</span>
							{vs?.available && (
								<>
									<span>·</span><span>维度 {vs.dims}</span><span>·</span><span>已索引 {vs.indexed}</span><span>·</span><span>待索引 {vs.pending}</span>
									{vs.failed > 0 && <span className="text-rose-500">· 失败 {vs.failed}</span>}
								</>
							)}
							<button type="button" onClick={() => void reindex()} disabled={!vs?.available || reindexing} className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
								{reindexing ? "重建中..." : "重建索引"}
							</button>
						</div>
					</div>
				</Card>

				{/* 外接知识库 */}
				<Card title="外接知识库" desc="内置 RAGFlow / Dify 预设（选好类型只需填 Base URL / API Key / Dataset ID），也支持自定义；可查询、上传、重新解析。">
					<div className="space-y-3">
						{kb.external.providers.length === 0 && <div className="text-xs text-slate-400">尚未配置外接知识库。</div>}
						{kb.external.providers.map((p) => (
							<div key={p.id} className={`rounded-xl border px-4 py-3 ${p.id === activeProvId ? "border-blue-300 bg-blue-50/40" : "border-slate-200 bg-[#f7f8fa]"}`}>
								<div className="flex items-center gap-3">
									<button type="button" onClick={() => { setActiveProvId(p.id); setExtDocs(null); setExtMsg(null); }} className="flex items-center gap-2 text-sm font-medium text-slate-800 hover:text-blue-600">
										{p.name}
										<span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{EXTERNAL_PRESET_TYPES.find((t) => t.value === p.type)?.label ?? p.type}</span>
									</button>
									<label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
										启用
										<input type="checkbox" checked={p.enabled} onChange={(e) => updateProvider(p.id, { enabled: e.target.checked })} className="h-4 w-4 accent-blue-500" />
									</label>
									<label className="flex items-center gap-1.5 text-xs text-slate-400">
										主力
										<input type="radio" checked={kb.external.activeId === p.id} onChange={() => setKb({ external: { ...kb.external, activeId: p.id } })} className="h-4 w-4 accent-blue-500" />
									</label>
									<button type="button" onClick={() => removeProvider(p.id)} className="text-xs text-rose-400 hover:text-rose-600">删除</button>
								</div>
								{p.id === activeProvId && (
									<div className="mt-3 space-y-3">
										<div className="grid grid-cols-2 gap-3">
											<Field label="类型" hint="切换会重新填充调用模板，但保留 Base URL / API Key / Dataset ID。">
												<select value={p.type} onChange={(e) => changeProviderType(p.id, e.target.value as ExternalPresetType)} className={inputCls}>
													{EXTERNAL_PRESET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
												</select>
											</Field>
											<Field label="名称"><input value={p.name} onChange={(e) => updateProvider(p.id, { name: e.target.value })} className={inputCls} /></Field>
											<div className="col-span-2"><Field label="Base URL"><input value={p.baseUrl} onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })} placeholder="http://localhost:9380 或 https://api.dify.ai" className={inputCls} /></Field></div>
											<Field label="API Key"><input type="password" value={p.apiKey} onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })} placeholder="ragflow-xxx / dataset-xxx" className={inputCls} /></Field>
											<DatasetIdPicker provider={p} onChange={(datasetId) => updateProvider(p.id, { datasetId })} />
										</div>

										<div className="flex flex-wrap items-center gap-2">
											<button type="button" onClick={() => void testProvider()} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">测试检索</button>
											<button type="button" onClick={() => void refreshExtDocs()} disabled={extDocsLoading || !p.operations.list} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{extDocsLoading ? "查询中..." : "列出文档"}</button>
											<button type="button" onClick={() => void uploadExtDoc()} disabled={uploadLoading || !p.operations.upload} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{uploadLoading ? "上传中..." : "上传文档"}</button>
											{p.operations.parse && <button type="button" onClick={() => void parseExtDoc()} disabled={parseLoading} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{parseLoading ? "解析中..." : "全部重新解析"}</button>}
										</div>
										{provTest && <div className={`text-xs ${provTest.ok ? "text-emerald-600" : "text-rose-500"}`}>{provTest.ok ? `检索连接成功，命中 ${provTest.count} 条` : `检索失败：${provTest.error}`}</div>}
										{extMsg && <div className={`text-xs ${extMsg.ok ? "text-emerald-600" : "text-rose-500"}`}>{extMsg.text}</div>}

										{extDocs && (
											<div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
												<div className="mb-1.5 text-xs font-medium text-slate-500">文档列表（{extDocs.length}）</div>
												{extDocs.length === 0 && <div className="text-xs text-slate-400">暂无文档。</div>}
												<div className="space-y-1">
													{extDocs.map((d, i) => (
														<div key={d.id || i} className="flex items-center gap-2 text-xs">
															<span className="truncate text-slate-600">{d.name || d.id}</span>
															{d.status && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400">{d.status}</span>}
															{p.operations.parse && <button type="button" onClick={() => void parseExtDoc(d.id)} disabled={parseLoading} className="ml-auto text-[11px] text-blue-500 hover:text-blue-700 disabled:opacity-50">重解析</button>}
														</div>
													))}
												</div>
											</div>
										)}

										<AdvancedExternalOps provider={p} onChange={(patch) => updateProvider(p.id, patch)} />
									</div>
								)}
							</div>
						))}
						<button type="button" onClick={() => { const p = newExternalProvider("ragflow"); setProviders([...kb.external.providers, p]); setActiveProvId(p.id); }} className="rounded-xl border border-dashed border-slate-300 px-4 py-2 text-sm font-medium text-slate-500 hover:border-blue-300 hover:text-blue-600">+ 添加外接知识库</button>
					</div>
				</Card>

				{/* 内容：条目 + 文档 */}
				<Card title="知识内容" desc="条目可直接编辑；文档导入后自动切分与索引（autoIndex 开启时）。">
					<div className="space-y-4">
						<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
							<div><div className="text-sm font-medium text-slate-800">导入后自动建向量索引</div><div className="mt-0.5 text-xs text-slate-400">需要向量检索已启用。</div></div>
							<input type="checkbox" checked={kb.local.autoIndex} onChange={(e) => setLocal({ autoIndex: e.target.checked })} className="h-5 w-5 accent-blue-500" />
						</label>

						<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
							<div>
								<div className="text-sm font-medium text-slate-800">允许在对话中整理知识库</div>
								<div className="mt-0.5 text-xs text-slate-400">开启后，管理者可在对话中指派员工归档/删除/恢复知识条目（删除默认归档，可在此恢复）。</div>
							</div>
							<input type="checkbox" checked={kb.manage.enabled} onChange={(e) => setKb({ manage: { ...kb.manage, enabled: e.target.checked } })} className="h-5 w-5 accent-blue-500" />
						</label>

						<div>
							<div className="mb-2 flex items-center justify-between">
								<span className="text-sm font-medium text-slate-700">文档</span>
							</div>
							<div className="space-y-2">
								{docs.length === 0 && <div className="text-xs text-slate-400">暂无文档。</div>}
								{docs.map((d) => (
									<div key={d.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-2 text-sm">
										<span className="truncate text-slate-700">{d.name}</span>
										<span className="text-xs text-slate-400">{d.chunks} 块</span>
										<button type="button" onClick={() => void removeDoc(d.id)} className="ml-auto text-xs text-rose-400 hover:text-rose-600">删除</button>
									</div>
								))}
							</div>
							<button type="button" onClick={() => void importDocs()} disabled={importing} className="mt-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{importing ? "导入中..." : "导入文档（txt/md/pdf/docx/xlsx/html）"}</button>
						</div>

						<div>
							<div className="mb-2 flex items-center justify-between">
								<span className="text-sm font-medium text-slate-700">知识条目</span>
								<button type="button" onClick={() => setEditing({ title: "", tags: "", content: "" })} className="text-xs font-medium text-blue-600 hover:text-blue-700">+ 新建条目</button>
							</div>
							{editing && (
								<div className="mb-3 space-y-2 rounded-xl border border-blue-200 bg-blue-50/30 p-4">
									<input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="标题" className={inputCls} />
									<input value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} placeholder="标签（逗号分隔）" className={inputCls} />
									<textarea value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} placeholder="正文" rows={4} className={inputCls + " h-auto py-2"} />
									<div className="flex gap-2">
										<button type="button" onClick={() => void saveEntry()} className="rounded-xl bg-[#1d1d1f] px-4 py-2 text-sm font-medium text-white hover:bg-[#3f3f43]">保存</button>
										<button type="button" onClick={() => setEditing(null)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">取消</button>
									</div>
								</div>
							)}
							<input value={entrySearch} onChange={(e) => setEntrySearch(e.target.value)} placeholder="搜索条目（标题 / 标签 / 正文）" className={inputCls + " mb-2"} />
							<div className="space-y-2">
								{visibleLive.length === 0 && <div className="text-xs text-slate-400">{liveEntries.length === 0 ? "暂无条目。" : "无匹配条目。"}</div>}
								{visibleLive.map((e) => {
									const open = expandedId === e.id;
									const confirming = confirmId === e.id;
									return (
										<div key={e.id} className="rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-2 text-sm">
											<div className="flex items-center gap-3">
												<button type="button" onClick={() => setExpandedId(open ? null : e.id)} className="min-w-0 text-left">
													<div className="flex items-center gap-2">
														<span className="truncate font-medium text-slate-700">{e.title}</span>
														<OriginBadge origin={e.origin} />
														<ReviewBadge status={e.review_status} />
														<ConfidenceBadge confidence={e.confidence} />
													</div>
													<div className="truncate text-xs text-slate-400">{e.tags || "无标签"}</div>
												</button>
												{e.review_status === "pending" && (
													<button type="button" onClick={() => void approveEntry(e.id)} className="ml-auto text-xs text-emerald-500 hover:text-emerald-700">通过</button>
												)}
												<button type="button" onClick={() => setEditing({ id: e.id, title: e.title, tags: e.tags, content: e.content })} className={e.review_status === "pending" ? "text-xs text-slate-500 hover:text-slate-700" : "ml-auto text-xs text-slate-500 hover:text-slate-700"}>编辑</button>
												<button type="button" onClick={() => void archiveEntry(e.id)} className="text-xs text-amber-500 hover:text-amber-700">归档</button>
												<button type="button" onClick={() => (confirming ? void removeEntry(e.id) : askDelete(e.id))} className={`text-xs ${confirming ? "text-rose-600 font-medium" : "text-rose-400 hover:text-rose-600"}`}>{confirming ? "确认删除?" : "删除"}</button>
											</div>
											{open && (
												<div className="mt-2 border-t border-slate-200 pt-2">
													<EntryProvenance entry={e} />
													<div className="whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{e.content}</div>
												</div>
											)}
										</div>
									);
								})}
							</div>

							{/* 归档区 */}
							<div className="mt-3">
								<button type="button" onClick={() => setShowArchive((v) => !v)} className="text-xs font-medium text-slate-500 hover:text-slate-700">
									{showArchive ? "▾" : "▸"} 已归档（{archivedEntries.length}）
								</button>
								{showArchive && (
									<div className="mt-2 space-y-2">
										{archivedEntries.length === 0 && <div className="text-xs text-slate-400">归档区为空。</div>}
										{archivedEntries.map((e) => (
											<div key={e.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm">
												<div className="min-w-0">
													<div className="flex items-center gap-2"><span className="truncate text-slate-600">{e.title}</span><OriginBadge origin={e.origin} /></div>
													<div className="truncate text-xs text-slate-400">{e.tags || "无标签"}</div>
												</div>
												<button type="button" onClick={() => void restoreEntry(e.id)} className="ml-auto text-xs text-emerald-500 hover:text-emerald-700">恢复</button>
												<button type="button" onClick={() => void removeEntry(e.id)} className="text-xs text-rose-400 hover:text-rose-600">彻底删除</button>
											</div>
										))}
									</div>
								)}
							</div>
						</div>
					</div>
				</Card>

				{/* 自动记忆 */}
				<Card title="自动记忆" desc="员工对话中自主沉淀可复用知识；周期性用 LLM 整理（去重/合并/归类/泛化归纳），像记忆巩固。">
					<div className="space-y-4">
						<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
							<div>
								<div className="text-sm font-medium text-slate-800">启用自动沉淀</div>
								<div className="mt-0.5 text-xs text-slate-400">对话中出现可复用知识时，员工主动调用 save_to_knowledge 沉淀（按标题去重合并）。</div>
							</div>
							<input type="checkbox" checked={kb.learn.enabled} onChange={(e) => setLearn({ enabled: e.target.checked })} className="h-5 w-5 accent-blue-500" />
						</label>
						<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
							<div>
								<div className="text-sm font-medium text-slate-800">启用自动整理（记忆巩固）</div>
								<div className="mt-0.5 text-xs text-slate-400">按间隔用默认对话模型整理 learned 条目：合并重复、归档过时、归纳泛化。</div>
							</div>
							<input type="checkbox" checked={kb.learn.consolidate.enabled} onChange={(e) => setConsolidate({ enabled: e.target.checked })} className="h-5 w-5 accent-blue-500" />
						</label>
						<div className="grid grid-cols-2 gap-4">
							<Field label="整理间隔（分钟）"><input type="number" min={1} value={kb.learn.consolidate.intervalMinutes} onChange={(e) => setConsolidate({ intervalMinutes: Number(e.target.value) || 360 })} className={inputCls} /></Field>
							<Field label="每批整理条数"><input type="number" min={2} value={kb.learn.consolidate.batch} onChange={(e) => setConsolidate({ batch: Number(e.target.value) || 40 })} className={inputCls} /></Field>
						</div>
						<div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">
							<span>状态：</span>
							<span>learned {learnStat?.learnedCount ?? "—"}</span>
							<span>·</span><span>derived {learnStat?.derivedCount ?? "—"}</span>
							<span>·</span><span>archived {learnStat?.archivedCount ?? "—"}</span>
							<span>·</span><span>最近整理 {learnStat?.consolidatedAt ? new Date(learnStat.consolidatedAt).toLocaleString() : "未运行"}</span>
							<button type="button" onClick={() => void consolidate()} disabled={consolidating} className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">{consolidating ? "整理中..." : "立即整理"}</button>
						</div>
						{consolidateResult && (
							<div className={`rounded-xl px-4 py-2 text-xs ${consolidateResult.error ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-700"}`}>
								{consolidateResult.error
									? `整理失败：${consolidateResult.error}`
									: `已整理：合并 ${consolidateResult.merged} 条 → ${consolidateResult.derived} 条泛化，归档 ${consolidateResult.archived}，重标 ${consolidateResult.retagged}`}
							</div>
						)}
					</div>
				</Card>

				{/* 自动研究 */}
				<Card title="自动研究（联网补充）" desc="知识库未命中时，员工可联网查询资料并据实回答，可信结论沉淀为待核实条目（低置信度），人工通过后转为正式知识。">
					<div className="space-y-4">
						<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
							<div>
								<div className="text-sm font-medium text-slate-800">启用自动研究</div>
								<div className="mt-0.5 text-xs text-slate-400">开启后员工在知识库未命中且问题可查证时，自动调用 research_web 联网查询并沉淀。</div>
							</div>
							<input type="checkbox" checked={kb.research.enabled} onChange={(e) => setResearch({ enabled: e.target.checked })} className="h-5 w-5 accent-blue-500" />
						</label>
						<Field label="搜索引擎" hint="DuckDuckGo 免 Key 即用；自定义模式需提供端点（在 config-store 进一步配置模板）。">
							<select value={kb.research.engine} onChange={(e) => setResearch({ engine: e.target.value as KbConfig["research"]["engine"] })} className={inputCls}>
								<option value="duckduckgo">DuckDuckGo（免 Key）</option>
								<option value="custom">自定义搜索引擎</option>
							</select>
						</Field>

						{/* 待核实评审区 */}
						<div className="rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
							<div className="mb-2 flex items-center justify-between">
								<span className="text-sm font-medium text-slate-700">待核实（AI 研究沉淀）</span>
								<span className="text-xs text-slate-400">{learnStat?.pendingCount ?? 0} 条待评审</span>
							</div>
							<div className="space-y-2">
								{pendingEntries.length === 0 && <div className="text-xs text-slate-400">暂无待核实条目。</div>}
								{pendingEntries.map((e) => (
									<div key={e.id} className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-2 text-sm">
										<div className="min-w-0">
											<div className="flex items-center gap-2">
												<span className="truncate text-slate-700">{e.title}</span>
												<ConfidenceBadge confidence={e.confidence} />
											</div>
											<div className="truncate text-xs text-slate-400">{e.content.slice(0, 80)}</div>
										</div>
										<button type="button" onClick={() => void approveEntry(e.id)} className="ml-auto rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">通过</button>
										<button type="button" onClick={() => void archiveEntry(e.id)} className="text-xs text-amber-500 hover:text-amber-700">否决</button>
									</div>
								))}
							</div>
						</div>

						{/* 知识缺口 */}
						<div className="rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
							<div className="mb-2 flex items-center justify-between">
								<span className="text-sm font-medium text-slate-700">知识缺口</span>
								<span className="text-xs text-slate-400">检索未命中、按出现频次排序</span>
							</div>
							<div className="space-y-2">
								{gaps.length === 0 && <div className="text-xs text-slate-400">暂无记录的知识缺口。</div>}
								{gaps.map((g) => (
									<div key={g.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
										<span className="truncate text-slate-700">{g.query}</span>
										<span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">未命中 ×{g.count}</span>
										<span className="ml-auto text-[10px] text-slate-400">{g.last_seen ? new Date(g.last_seen).toLocaleDateString() : ""}</span>
										<button type="button" onClick={() => void resolveGap(g.query)} className="text-xs text-slate-400 hover:text-slate-600">忽略</button>
									</div>
								))}
							</div>
						</div>

						<div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">
							<span>状态：</span>
							<span>研究沉淀 {learnStat?.researchCount ?? "—"}</span>
							<span>·</span><span>待核实 {learnStat?.pendingCount ?? "—"}</span>
							<span>·</span><span>缺口 {learnStat?.gapCount ?? "—"}</span>
							<span>·</span><span>最近研究 {learnStat?.researchedAt ? new Date(learnStat.researchedAt).toLocaleString() : "未运行"}</span>
							<button type="button" onClick={() => void runResearch()} disabled={researching} className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">{researching ? "研究中..." : "立即研究缺口"}</button>
						</div>
						{researchResult && (
							<div className={`rounded-xl px-4 py-2 text-xs ${researchResult.error ? "bg-rose-50 text-rose-600" : "bg-cyan-50 text-cyan-700"}`}>
								{researchResult.error
									? `研究失败：${researchResult.error}`
									: `已处理 ${researchResult.gaps} 个缺口：沉淀 ${researchResult.researched} 条待核实，跳过 ${researchResult.skipped}`}
							</div>
						)}
					</div>
				</Card>

				{/* 搜索测试 */}
				<Card title="检索测试" desc="按当前配置查询，验证召回效果（保存后生效）。">
					<div className="flex gap-2">
						<input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} placeholder="输入查询，例如：退货流程" className={inputCls} />
						<button type="button" onClick={() => void runSearch()} className="shrink-0 rounded-xl bg-[#1d1d1f] px-5 text-sm font-medium text-white hover:bg-[#3f3f43]">搜索</button>
					</div>
					{hits.length > 0 && (
						<div className="mt-3 space-y-2">
							{hits.map((h, i) => (
								<div key={h.id + i} className="rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-2 text-sm">
									<div className="mb-0.5 flex items-center gap-2 text-xs text-slate-400">
										<span>{h.source.startsWith("doc:") ? `文档《${h.source.slice(4)}》` : h.source}</span>
										{h.title && <span>· {h.title}</span>}
									</div>
									<div className="text-slate-700">{h.snippet}</div>
								</div>
							))}
						</div>
					)}
				</Card>
			</div>
		</div>
	);
}

/** Collapsible advanced editor for an external provider's operation templates + mappings. */
function AdvancedExternalOps({
	provider,
	onChange,
}: {
	provider: ExternalProviderConfig;
	onChange: (patch: Partial<ExternalProviderConfig>) => void;
}) {
	const ops = provider.operations;
	const setOp = (key: "search" | "upload" | "parse" | "list", patch: Partial<ExternalOpTemplate>) => {
		const cur = ops[key] ?? { method: "POST" as const, path: "" };
		onChange({ operations: { ...ops, [key]: { ...cur, ...patch } } });
	};
	const rm = provider.responseMapping;
	const lm = provider.listMapping;
	return (
		<details className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs">
			<summary className="cursor-pointer font-medium text-slate-500">高级：请求模板与响应映射（字段名可能随平台版本变化，可微调）</summary>
			<div className="mt-3 space-y-3">
				{(
					[
						["search", "检索"],
						["upload", "上传"],
						["parse", "解析"],
						["list", "列表"],
					] as const
				).map(([key, label]) => {
					const op = ops[key];
					if (!op) return null;
					return (
						<div key={key} className="space-y-1.5">
							<div className="font-medium text-slate-500">{label}操作</div>
							<div className="flex gap-2">
								<select value={op.method} onChange={(e) => setOp(key, { method: e.target.value as "GET" | "POST" })} className={inputCls + " h-9 w-24 text-xs"}>
									<option value="POST">POST</option>
									<option value="GET">GET</option>
								</select>
								<input value={op.path} onChange={(e) => setOp(key, { path: e.target.value })} placeholder="/path（相对 Base URL，支持占位符）" className={inputCls + " h-9 text-xs"} />
							</div>
							{op.bodyTemplate !== undefined && (
								<textarea value={op.bodyTemplate} onChange={(e) => setOp(key, { bodyTemplate: e.target.value })} rows={2} className={inputCls + " h-auto py-1.5 text-xs font-mono"} placeholder="JSON 模板" />
							)}
						</div>
					);
				})}
				<div className="grid grid-cols-2 gap-2">
					<label className="block"><span className="text-slate-500">结果路径</span><input value={rm.resultsPath} onChange={(e) => onChange({ responseMapping: { ...rm, resultsPath: e.target.value } })} className={inputCls + " h-9 text-xs"} /></label>
					<label className="block"><span className="text-slate-500">正文路径</span><input value={rm.snippetPath} onChange={(e) => onChange({ responseMapping: { ...rm, snippetPath: e.target.value } })} className={inputCls + " h-9 text-xs"} /></label>
					<label className="block"><span className="text-slate-500">标题路径</span><input value={rm.titlePath ?? ""} onChange={(e) => onChange({ responseMapping: { ...rm, titlePath: e.target.value } })} className={inputCls + " h-9 text-xs"} /></label>
					<label className="block"><span className="text-slate-500">来源路径</span><input value={rm.sourcePath ?? ""} onChange={(e) => onChange({ responseMapping: { ...rm, sourcePath: e.target.value } })} className={inputCls + " h-9 text-xs"} /></label>
				</div>
				{lm && (
					<div className="grid grid-cols-2 gap-2">
						<label className="block"><span className="text-slate-500">文档列表路径</span><input value={lm.documentsPath} onChange={(e) => onChange({ listMapping: { ...lm, documentsPath: e.target.value } })} className={inputCls + " h-9 text-xs"} /></label>
						<label className="block"><span className="text-slate-500">状态字段</span><input value={lm.statusPath ?? ""} onChange={(e) => onChange({ listMapping: { ...lm, statusPath: e.target.value } })} className={inputCls + " h-9 text-xs"} /></label>
					</div>
				)}
			</div>
		</details>
	);
}

/** Entry-origin badge: manual (手工) / learned (AI沉淀) / derived (AI归纳) / research (联网研究). */
function OriginBadge({ origin }: { origin: string }) {
	const map: Record<string, { label: string; cls: string }> = {
		manual: { label: "手工", cls: "bg-slate-100 text-slate-500" },
		learned: { label: "AI沉淀", cls: "bg-blue-50 text-blue-600" },
		derived: { label: "AI归纳", cls: "bg-violet-50 text-violet-600" },
		research: { label: "AI研究", cls: "bg-cyan-50 text-cyan-600" },
	};
	const m = map[origin] ?? { label: origin || "未知", cls: "bg-slate-100 text-slate-500" };
	return <span className={`rounded px-1.5 py-0.5 text-[10px] ${m.cls}`}>{m.label}</span>;
}

/** Review-status badge — only renders for non-approved entries (pending / rejected). */
function ReviewBadge({ status }: { status: string }) {
	if (status === "approved" || !status) return null;
	const map: Record<string, { label: string; cls: string }> = {
		pending: { label: "待核实", cls: "bg-amber-50 text-amber-600" },
		rejected: { label: "已否决", cls: "bg-rose-50 text-rose-500" },
	};
	const m = map[status] ?? { label: status, cls: "bg-amber-50 text-amber-600" };
	return <span className={`rounded px-1.5 py-0.5 text-[10px] ${m.cls}`}>{m.label}</span>;
}

/** Confidence badge — only renders below full confidence (manual = 1.0 hidden). */
function ConfidenceBadge({ confidence }: { confidence: number }) {
	if (confidence == null || confidence >= 1) return null;
	const pct = Math.round((confidence ?? 0) * 100);
	return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400" title="置信度">置信{pct}%</span>;
}

/** Provenance line under an expanded entry: lineage + source URL. */
function EntryProvenance({ entry }: { entry: KnowledgeEntry }) {
	const lineageCount = entry.lineage ? safeJsonArray(entry.lineage).length : 0;
	const url = entry.source_url?.trim();
	if (lineageCount === 0 && !url) return null;
	return (
		<div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
			{lineageCount > 0 && <span>泛化自 {lineageCount} 条历史</span>}
			{url && (
				<a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-500 hover:text-blue-700">
					来源 <span className="max-w-[220px] truncate align-middle">{url}</span> ↗
				</a>
			)}
		</div>
	);
}

/** Parse a lineage JSON array; fall back to [] on malformed input. */
function safeJsonArray(text: string | null): string[] {
	if (!text) return [];
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Dataset ID field with a "拉取" button: after the user fills Base URL + API
 * Key, it calls the provider's list-datasets endpoint and turns into a
 * dropdown. Manual entry is always one click away (the "手动" button).
 */
function DatasetIdPicker({
	provider,
	onChange,
}: {
	provider: ExternalProviderConfig;
	onChange: (id: string) => void;
}) {
	const [datasets, setDatasets] = useState<{ id: string; name: string }[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canFetch =
		!!provider.operations.datasets && !!provider.baseUrl.trim() && !!provider.apiKey.trim();

	const fetchDatasets = async () => {
		setLoading(true);
		setError(null);
		try {
			const list = await api.listExternalDatasets(provider);
			setDatasets(list);
			if (list.length === 0) setError("接口未返回数据集，请检查 Base URL / API Key / 权限");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setDatasets(null);
		} finally {
			setLoading(false);
		}
	};

	const showSelect = !!datasets && datasets.length > 0;
	return (
		<Field
			label="Dataset ID（知识库 ID）"
			hint={canFetch ? "填好 Base URL + API Key 后可点「拉取」自动列出。" : undefined}
		>
			<div className="flex gap-2">
				{showSelect ? (
					<select value={provider.datasetId} onChange={(e) => onChange(e.target.value)} className={inputCls}>
						<option value="">— 选择数据集 —</option>
						{datasets!.map((d) => (
							<option key={d.id} value={d.id}>
								{d.name}（{d.id.slice(0, 8)}）
							</option>
						))}
					</select>
				) : (
					<input
						value={provider.datasetId}
						onChange={(e) => onChange(e.target.value)}
						placeholder="知识库 ID"
						className={inputCls}
					/>
				)}
				{showSelect ? (
					<button
						type="button"
						onClick={() => setDatasets(null)}
						className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-500 hover:bg-slate-50"
						title="切回手动输入"
					>
						手动
					</button>
				) : (
					<button
						type="button"
						onClick={() => void fetchDatasets()}
						disabled={!canFetch || loading}
						className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
						title={canFetch ? "调用接口列出数据集" : "该类型不支持，或未填 Base URL / API Key"}
					>
						{loading ? "拉取中…" : "拉取"}
					</button>
				)}
			</div>
			{error && <div className="mt-1 text-xs text-rose-500">{error}</div>}
		</Field>
	);
}
