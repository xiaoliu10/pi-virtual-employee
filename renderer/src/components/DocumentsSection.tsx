import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/ipc";
import type { AppConfig, ResourceInput, ResourceRow } from "../lib/types";

interface Props {
	documents: AppConfig["documents"];
	onUpdate: (patch: Partial<AppConfig["documents"]>) => void;
}

const inputCls =
	"h-10 w-full rounded-xl border border-slate-200 bg-[#f7f8fa] px-3.5 text-sm text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100";

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
	return (
		<label className="block">
			<span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
			{children}
			{hint && <span className="mt-1 block text-xs leading-relaxed text-slate-400">{hint}</span>}
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

/** Split a partners/tags text field (comma / 、 separated) into a clean array. */
function splitList(raw: string): string[] {
	return raw
		.split(/[,，、]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const emptyForm = { name: "", kind: "link" as "file" | "link", url: "", partners: "", scenario: "", description: "" };

export function DocumentsSection({ documents, onUpdate }: Props) {
	const [resources, setResources] = useState<ResourceRow[]>([]);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState(emptyForm);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [confirmId, setConfirmId] = useState<string | null>(null);

	const refresh = () => api.listDocuments().then(setResources).catch(() => {});
	useEffect(() => {
		refresh();
	}, []);

	const flash = (text: string) => {
		setMsg(text);
		window.setTimeout(() => setMsg(null), 2500);
	};

	const formToMeta = (): Partial<ResourceInput> => ({
		name: form.name.trim(),
		partners: splitList(form.partners),
		scenario: form.scenario.trim() || null,
		description: form.description.trim() || null,
	});

	const resetForm = () => {
		setForm(emptyForm);
		setEditingId(null);
	};

	const saveLink = async () => {
		if (!form.name.trim() || !form.url.trim()) {
			flash("名称和链接都必填");
			return;
		}
		setBusy(true);
		try {
			if (editingId) {
				await api.updateDocument(editingId, { ...formToMeta(), url: form.url.trim(), kind: "link" });
			} else {
				await api.addDocument({ ...formToMeta(), kind: "link", url: form.url.trim() } as ResourceInput);
			}
			resetForm();
			await refresh();
			flash("已保存");
		} finally {
			setBusy(false);
		}
	};

	const uploadFile = async () => {
		setBusy(true);
		try {
			const r = await api.uploadDocument(formToMeta());
			resetForm();
			await refresh();
			flash(r.created > 0 ? `已上传 ${r.created} 个文件` : "未选择文件");
		} finally {
			setBusy(false);
		}
	};

	const startEdit = (r: ResourceRow) => {
		setEditingId(r.id);
		setForm({
			name: r.name,
			kind: r.kind,
			url: r.url ?? "",
			partners: r.partners.join(", "),
			scenario: r.scenario ?? "",
			description: r.description ?? "",
		});
	};

	const updateResource = async () => {
		if (!editingId) return;
		setBusy(true);
		try {
			await api.updateDocument(editingId, formToMeta());
			resetForm();
			await refresh();
			flash("已更新");
		} finally {
			setBusy(false);
		}
	};

	const deleteResource = async (id: string) => {
		await api.deleteDocument(id);
		if (editingId === id) resetForm();
		setConfirmId(null);
		await refresh();
	};

	const editing = editingId ? resources.find((r) => r.id === editingId) : null;

	return (
		<div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-10 py-8">
			<div className="mx-auto max-w-3xl space-y-5">
				<Card title="文档资源" desc="员工可检索并把这些文档投递给对接方：在线文档发链接，文件经渠道发送（或说明归档位置）。">
					<div className="flex items-center justify-between">
						<div>
							<div className="text-sm font-medium text-slate-800">启用文档资源工具</div>
							<p className="mt-0.5 text-xs text-slate-400">开启后员工获得 list_documents / provide_document / save_document 工具。</p>
						</div>
						<label className="relative inline-flex cursor-pointer items-center">
							<input
								type="checkbox"
								className="peer sr-only"
								checked={documents.enabled}
								onChange={(e) => onUpdate({ enabled: e.target.checked })}
							/>
							<div className="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-blue-500 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-5" />
						</label>
					</div>
					<div className="mt-4">
						<Field label="文档目录" hint="上传的文件会复制到此目录；留空用默认（应用数据目录下的 documents）。修改后保存生效。">
							<input className={inputCls} value={documents.dir} placeholder="（默认）" onChange={(e) => onUpdate({ dir: e.target.value })} />
						</Field>
					</div>
				</Card>

				<Card title={editing ? "编辑资源" : "新增资源"} desc="链接类填 URL；文件类用下方按钮选择并上传。">
					<div className="grid grid-cols-2 gap-4">
						<Field label="名称">
							<input className={inputCls} value={form.name} placeholder="如：支付宝对账接口文档 v2" onChange={(e) => setForm({ ...form, name: e.target.value })} />
						</Field>
						<Field label="适用对接方" hint="多个用逗号分隔，如：支付宝, 微信">
							<input className={inputCls} value={form.partners} onChange={(e) => setForm({ ...form, partners: e.target.value })} />
						</Field>
						<Field label="场景" hint="什么时候提供，如：接口联调、退款咨询">
							<input className={inputCls} value={form.scenario} onChange={(e) => setForm({ ...form, scenario: e.target.value })} />
						</Field>
						<Field label="描述">
							<input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
						</Field>
					</div>

					{editing && editing.kind === "file" ? (
						<div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">
							文件类资源的路径由上传确定，不可在此修改：{editing.filePath ?? "(无)"}
						</div>
					) : (
						<div className="mt-4">
							<Field label="在线链接（kind=link）" hint="填了链接即保存为在线文档资源，员工会把链接发给对接方。">
								<input className={inputCls} value={form.url} placeholder="https://…" onChange={(e) => setForm({ ...form, url: e.target.value, kind: "link" })} />
							</Field>
						</div>
					)}

					<div className="mt-5 flex flex-wrap items-center gap-3">
						{editing ? (
							<>
								<button type="button" disabled={busy} onClick={updateResource} className="rounded-xl bg-[#e1e7ef] px-4 py-2 text-sm font-medium text-[#171c24] transition hover:bg-white disabled:opacity-50">
									保存修改
								</button>
								<button type="button" onClick={resetForm} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50">
									取消
								</button>
							</>
						) : (
							<>
								<button type="button" disabled={busy} onClick={saveLink} className="rounded-xl bg-[#e1e7ef] px-4 py-2 text-sm font-medium text-[#171c24] transition hover:bg-white disabled:opacity-50">
									保存为在线链接
								</button>
								<button type="button" disabled={busy} onClick={uploadFile} className="rounded-xl border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-600 transition hover:bg-blue-100 disabled:opacity-50">
									选择并上传文件…
								</button>
							</>
						)}
						{msg && <span className="text-xs text-emerald-600">{msg}</span>}
					</div>
				</Card>

				<Card title={`资源列表（${resources.length}）`} desc="员工用 list_documents 按对接方/场景检索这些资源。">
					{resources.length === 0 ? (
						<p className="py-6 text-center text-sm text-slate-400">还没有资源，先在上面新增一个。</p>
					) : (
						<ul className="divide-y divide-slate-100">
							{resources.map((r) => (
								<li key={r.id} className="flex items-center gap-3 py-3">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-sm font-medium text-slate-800">{r.name}</span>
											<span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${r.kind === "link" ? "bg-sky-100 text-sky-600" : "bg-amber-100 text-amber-600"}`}>
												{r.kind === "link" ? "链接" : "文件"}
											</span>
										</div>
										<p className="mt-0.5 truncate text-xs text-slate-400">
											{r.partners.length ? `对接方:${r.partners.join("/")}` : "未指定对接方"}
											{r.scenario ? ` · 场景:${r.scenario}` : ""}
											{r.kind === "link" && r.url ? ` · ${r.url}` : ""}
										</p>
									</div>
									<button type="button" onClick={() => startEdit(r)} className="rounded-lg px-2.5 py-1 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-800">
										编辑
									</button>
									{confirmId === r.id ? (
										<button type="button" onClick={() => deleteResource(r.id)} className="rounded-lg bg-red-50 px-2.5 py-1 text-xs text-red-600 transition hover:bg-red-100">
											确认删除
										</button>
									) : (
										<button type="button" onClick={() => setConfirmId(r.id)} className="rounded-lg px-2.5 py-1 text-xs text-slate-400 transition hover:bg-red-50 hover:text-red-500">
											删除
										</button>
									)}
								</li>
							))}
						</ul>
					)}
				</Card>
			</div>
		</div>
	);
}
