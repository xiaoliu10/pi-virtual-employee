import { useState } from "react";
import { api } from "../lib/ipc";

/**
 * Employee portability UI — export the current employee as a `.pve` package
 * (config + history + knowledge + user skills) and import one, either by
 * cloning into a new profile or overwriting the current employee. Both import
 * modes relaunch the app. See src/io/employee-package.ts and electron/main.ts.
 */
export function MigrationSection() {
	const [includeSecrets, setIncludeSecrets] = useState(false);
	const [scope, setScope] = useState({ history: true, knowledge: true, skills: true });
	const [exporting, setExporting] = useState(false);
	const [exportResult, setExportResult] = useState<{ path: string; size: number } | null>(null);

	const [mode, setMode] = useState<"new" | "overwrite">("new");
	const [profileName, setProfileName] = useState("");
	const [importing, setImporting] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	const onExport = async () => {
		setExporting(true);
		setError(null);
		setExportResult(null);
		try {
			const r = await api.exportEmployee({ includeSecrets, scope });
			if (r) setExportResult(r);
		} catch (e) {
			setError(errMsg(e));
		} finally {
			setExporting(false);
		}
	};

	const onImport = async () => {
		setError(null);
		if (mode === "new" && !profileName.trim()) {
			setError("请填写新员工名称");
			return;
		}
		if (
			mode === "overwrite" &&
			!window.confirm("覆盖当前员工将清除本机当前员工的所有数据（配置/对话/知识库/技能）并替换为包内内容。确定继续？")
		) {
			return;
		}
		setImporting(true);
		setRestarting(true); // both modes relaunch the app
		try {
			await api.importEmployee({ mode, profileName: mode === "new" ? profileName.trim() : undefined });
		} catch (e) {
			setRestarting(false);
			setImporting(false);
			setError(errMsg(e));
		}
	};

	const card = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
	const checkRow = "flex items-center gap-2 text-sm text-slate-700";

	return (
		<div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-10 py-8">
			<div className="mx-auto max-w-2xl space-y-6">
				{/* Export */}
				<section className={card}>
					<h3 className="text-[15px] font-semibold text-slate-800">导出当前员工</h3>
					<p className="mt-1 text-xs leading-relaxed text-slate-400">
						把当前员工打包成一个 <code className="rounded bg-slate-100 px-1">.pve</code> 文件（zip），可用于备份、分享或迁移到另一台机器。向量索引不导出，导入后用目标机的 Embedding 模型自动重建。
					</p>

					<div className="mt-4 space-y-2.5">
						<label className={`${checkRow} cursor-pointer`}>
							<input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} className="h-4 w-4 accent-blue-500" />
							包含密钥/凭据（模型 API Key、IM appSecret、外接知识库 key）
							<span className="text-xs text-amber-600">仅用于自己迁移，勿外发</span>
						</label>
						<div className="pl-1 text-xs font-medium text-slate-500">导出内容：</div>
						{([
							["history", "对话历史 + 定时任务"],
							["knowledge", "知识库（条目 + 文档正文）"],
							["skills", "用户技能（内置技能随 App 自带，不导出）"],
						] as const).map(([key, label]) => (
							<label key={key} className={`${checkRow} cursor-pointer pl-5`}>
								<input
									type="checkbox"
									checked={scope[key]}
									onChange={(e) => setScope((s) => ({ ...s, [key]: e.target.checked }))}
									className="h-4 w-4 accent-blue-500"
								/>
								{label}
							</label>
						))}
					</div>

					<div className="mt-5 flex items-center gap-3">
						<button
							type="button"
							onClick={onExport}
							disabled={exporting}
							className="rounded-xl bg-[#e1e7ef] px-4 py-2.5 text-sm font-medium text-[#171c24] shadow-sm hover:bg-white disabled:opacity-50"
						>
							{exporting ? "打包中…" : "选择位置并导出"}
						</button>
						{exportResult && (
							<span className="text-xs text-emerald-600">
								已导出：{exportResult.path}（{(exportResult.size / 1024).toFixed(1)} KB）
							</span>
						)}
					</div>
				</section>

				{/* Import */}
				<section className={card}>
					<h3 className="text-[15px] font-semibold text-slate-800">导入员工包</h3>
					<p className="mt-1 text-xs leading-relaxed text-slate-400">
						选择一个 <code className="rounded bg-slate-100 px-1">.pve</code> 文件并选择落地方式。两种方式都会<b>自动重启应用</b>。
					</p>

					<div className="mt-4 space-y-3">
						<label className={`${checkRow} cursor-pointer`}>
							<input type="radio" name="impmode" checked={mode === "new"} onChange={() => setMode("new")} className="h-4 w-4 accent-blue-500" />
							<span><b>克隆为新员工</b>（本机新建一个独立员工/profile，不影响当前员工）</span>
						</label>
						{mode === "new" && (
							<input
								value={profileName}
								onChange={(e) => setProfileName(e.target.value)}
								placeholder="新员工名称（字母/数字/下划线/短横，如 emp2）"
								className="ml-7 h-10 w-[78%] rounded-xl border border-slate-200 bg-[#f7f8fa] px-3 text-sm outline-none focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100"
							/>
						)}
						<label className={`${checkRow} cursor-pointer`}>
							<input type="radio" name="impmode" checked={mode === "overwrite"} onChange={() => setMode("overwrite")} className="h-4 w-4 accent-blue-500" />
							<span><b>覆盖当前员工</b>（用包内数据替换本机当前员工，适合跨机器迁移）</span>
						</label>
					</div>

					<div className="mt-5 flex items-center gap-3">
						<button
							type="button"
							onClick={onImport}
							disabled={importing}
							className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
						>
							{importing ? "处理中…" : "选择员工包并导入"}
						</button>
						{restarting && <span className="text-xs text-blue-600">正在重启应用，请稍候…</span>}
					</div>
					{!includeSecrets && mode === "overwrite" && (
						<p className="mt-3 text-xs text-slate-400">提示：若导出时未勾选「包含密钥」，导入后需在「自定义模型 / IM 机器人」里补填各 key。</p>
					)}
				</section>

				{error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>}
			</div>
		</div>
	);
}
