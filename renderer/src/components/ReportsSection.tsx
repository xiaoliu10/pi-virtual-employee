import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { api } from "../lib/ipc";
import type { AppConfig, Artifact, ArtifactRun } from "../lib/types";

const inputCls =
	"h-10 w-full rounded-lg border border-slate-200 bg-[#f7f8fa] px-3 text-sm text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
	return (
		<label className="block">
			<span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
			{children}
			{hint && <span className="mt-1.5 block text-xs leading-relaxed text-slate-400">{hint}</span>}
		</label>
	);
}

interface ReportsSectionProps {
	reports: AppConfig["reports"];
	onUpdate: (reports: AppConfig["reports"]) => void;
	onBeforeTest?: () => Promise<void>;
}

export function ReportsSection({ reports, onUpdate, onBeforeTest }: ReportsSectionProps) {
	const set = useCallback(
		(patch: Partial<AppConfig["reports"]>) => onUpdate({ ...reports, ...patch }),
		[reports, onUpdate],
	);
	const setGitee = useCallback(
		(patch: Partial<AppConfig["reports"]["gitee"]>) => set({ gitee: { ...reports.gitee, ...patch } }),
		[reports, set],
	);
	const setOss = useCallback(
		(patch: Partial<AppConfig["reports"]["oss"]>) => set({ oss: { ...reports.oss, ...patch } }),
		[reports, set],
	);

	const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
	const [testing, setTesting] = useState(false);

	const runTest = useCallback(async () => {
		// Persist the entered values first (the test reads saved config), then hit
		// the currently selected publisher target.
		await onBeforeTest?.();
		setTesting(true);
		setTestResult(null);
		try {
			const r = await api.testReportTarget();
			setTestResult(r);
		} finally {
			setTesting(false);
		}
	}, [onBeforeTest]);

	// --- Artifact center ---
	const [artifacts, setArtifacts] = useState<Artifact[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [runs, setRuns] = useState<ArtifactRun[]>([]);
	const [body, setBody] = useState<string>("");
	const [bodyFor, setBodyFor] = useState<string | null>(null);
	const [url, setUrl] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const list = await api.listReports();
		setArtifacts(list);
		if (list.length && !selectedId) setSelectedId(list[0].id);
	}, [selectedId]);

	useEffect(() => {
		void refresh();
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (!selectedId) {
			setRuns([]);
			return;
		}
		void api.reportRuns(selectedId).then(setRuns);
	}, [selectedId]);

	const openRun = useCallback(async (run: ArtifactRun) => {
		setBodyFor(run.id);
		const [att, link] = await Promise.all([api.reportBody(run.id), api.reportUrl(run.id)]);
		setBody(att?.content ?? "（无正文内容）");
		setUrl(link);
	}, []);

	// Auto-open the latest run of the selected artifact once runs load.
	useEffect(() => {
		if (runs.length && bodyFor === null) void openRun(runs[0]);
	}, [runs, openRun, bodyFor]);

	const republish = useCallback(async () => {
		if (!bodyFor) return;
		setBusy(true);
		try {
			const r = await api.republishReport(bodyFor);
			if (r) setUrl(r.url);
		} finally {
			setBusy(false);
		}
	}, [bodyFor]);

	const remove = useCallback(
		async (id: string) => {
			await api.deleteReport(id);
			setSelectedId(null);
			setBodyFor(null);
			await refresh();
		},
		[refresh],
	);

	const selected = useMemo(() => artifacts.find((a) => a.id === selectedId) ?? null, [artifacts, selectedId]);

	return (
		<div className="space-y-8">
			{/* Configuration */}
			<section className="rounded-2xl border border-slate-200 bg-white p-6">
				<div className="mb-5 flex items-center justify-between">
					<div>
						<h2 className="text-base font-semibold text-slate-900">报告发布</h2>
						<p className="mt-1 text-xs text-slate-400">
							定时任务生成的报告会推送到所选存储，并在 IM 推送里附带可访问链接。每个实例（员工）可配置不同仓库/桶，不写死。
						</p>
					</div>
					<label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
						<input
							type="checkbox"
							checked={reports.enabled}
							onChange={(e) => set({ enabled: e.target.checked })}
							className="h-5 w-5 accent-blue-500"
						/>
						启用
					</label>
				</div>

				<div className="mb-4 grid grid-cols-2 gap-4">
					<Field label="发布目标 target">
						<select
							value={reports.target}
							onChange={(e) => set({ target: e.target.value as AppConfig["reports"]["target"] })}
							className={inputCls + " cursor-pointer"}
						>
							<option value="oss">阿里云 OSS（预签名链接，推荐）</option>
							<option value="gitee">Gitee 代码仓库</option>
						</select>
					</Field>
				</div>

				{reports.target === "gitee" ? (
				<>
				<div className="grid grid-cols-2 gap-4">
					<Field label="仓库所有者 owner">
						<input value={reports.gitee.owner} onChange={(e) => setGitee({ owner: e.target.value })} placeholder="xiaoliu10" className={inputCls} />
					</Field>
					<Field label="仓库名 repo">
						<input value={reports.gitee.repo} onChange={(e) => setGitee({ repo: e.target.value })} placeholder="pi-reports" className={inputCls} />
					</Field>
					<Field label="分支 branch">
						<input value={reports.gitee.branch} onChange={(e) => setGitee({ branch: e.target.value })} placeholder="main" className={inputCls} />
					</Field>
					<Field label="仓库内路径 basePath" hint="报告存放的子目录，留空为仓库根目录。">
						<input value={reports.gitee.basePath} onChange={(e) => setGitee({ basePath: e.target.value })} placeholder="reports/" className={inputCls} />
					</Field>
					<Field label="API 地址 apiUrl">
						<input value={reports.gitee.apiUrl} onChange={(e) => setGitee({ apiUrl: e.target.value })} placeholder="https://gitee.com/api/v5" className={inputCls} />
					</Field>
					<Field label="网页地址 webUrl">
						<input value={reports.gitee.webUrl} onChange={(e) => setGitee({ webUrl: e.target.value })} placeholder="https://gitee.com" className={inputCls} />
					</Field>
					<Field label="写入令牌 writeToken" hint="有仓库推送权限的私人令牌（提交文件用）。只存本地。">
						<input type="password" value={reports.gitee.writeToken} onChange={(e) => setGitee({ writeToken: e.target.value })} className={inputCls} />
					</Field>
					<Field label="读取令牌 readToken" hint="拼到 raw 链接里用于免登录查看，可与写入令牌相同。">
						<input type="password" value={reports.gitee.readToken} onChange={(e) => setGitee({ readToken: e.target.value })} className={inputCls} />
					</Field>
					<Field label="提交者名称（可选）">
						<input value={reports.gitee.commitAuthor} onChange={(e) => setGitee({ commitAuthor: e.target.value })} placeholder="pi-bot" className={inputCls} />
					</Field>
					<Field label="提交者邮箱（可选）">
						<input value={reports.gitee.commitEmail} onChange={(e) => setGitee({ commitEmail: e.target.value })} placeholder="bot@example.com" className={inputCls} />
					</Field>
				</div>

				<div className="mt-4">
					<Field label="链接生成方式 linkMode">
						<select
							value={reports.publish.linkMode}
							onChange={(e) => set({ publish: { ...reports.publish, linkMode: e.target.value as AppConfig["reports"]["publish"]["linkMode"] } })}
							className={inputCls + " cursor-pointer"}
						>
							<option value="raw_with_token">raw + 读取令牌（尝试免登录直看，私有仓库若被 Gitee 拦截则改选下方）</option>
							<option value="web_blob">Gitee 网页查看（协作者登录后看）</option>
							<option value="public">公开仓库 raw（无令牌，仅公开仓库可用）</option>
						</select>
					</Field>
				</div>
				</>
				) : (
				<div className="grid grid-cols-2 gap-4">
					<Field label="Region">
						<input value={reports.oss.region} onChange={(e) => setOss({ region: e.target.value })} placeholder="oss-cn-hangzhou" className={inputCls} />
					</Field>
					<Field label="Bucket">
						<input value={reports.oss.bucket} onChange={(e) => setOss({ bucket: e.target.value })} placeholder="my-reports" className={inputCls} />
					</Field>
					<Field label="AccessKeyId">
						<input type="password" value={reports.oss.accessKeyId} onChange={(e) => setOss({ accessKeyId: e.target.value })} className={inputCls} />
					</Field>
					<Field label="AccessKeySecret">
						<input type="password" value={reports.oss.accessKeySecret} onChange={(e) => setOss({ accessKeySecret: e.target.value })} className={inputCls} />
					</Field>
					<Field label="Endpoint" hint="留空用默认公网 endpoint；内网/CDN 可改自定义域名。">
						<input value={reports.oss.endpoint} onChange={(e) => setOss({ endpoint: e.target.value })} placeholder="https://oss-cn-hangzhou.aliyuncs.com" className={inputCls} />
					</Field>
					<Field label="桶内路径 basePath" hint="报告存放的前缀，如 reports/。">
						<input value={reports.oss.basePath} onChange={(e) => setOss({ basePath: e.target.value })} placeholder="reports/" className={inputCls} />
					</Field>
					<Field label="链接有效期（天）" hint="预签名 URL 过期时间，过期后链接失效。">
						<input
							type="number"
							min={1}
							value={Math.round(reports.oss.urlTtlSec / 86400)}
							onChange={(e) => setOss({ urlTtlSec: Math.max(1, Math.floor(Number(e.target.value) || 1)) * 86400 })}
							className={inputCls}
						/>
					</Field>
				</div>
				)}

				<div className="mt-5 flex items-center gap-3">
					<button
						onClick={runTest}
						disabled={testing}
						className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600 disabled:opacity-50"
					>
						{testing ? "测试中…" : "测试连接"}
					</button>
					{testResult && (
						<span className={"text-sm " + (testResult.ok ? "text-emerald-600" : "text-rose-600")}>{testResult.detail}</span>
					)}
				</div>
			</section>

			{/* Artifact center */}
			<section className="rounded-2xl border border-slate-200 bg-white p-6">
				<div className="mb-5 flex items-center justify-between">
					<div>
						<h2 className="text-base font-semibold text-slate-900">产物中心</h2>
						<p className="mt-1 text-xs text-slate-400">定时任务生成的报告历史，按来源归类。点击左侧条目查看运行记录与正文。</p>
					</div>
					<button onClick={refresh} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
						刷新
					</button>
				</div>

				{artifacts.length === 0 ? (
					<div className="py-16 text-center text-sm text-slate-400">还没有生成任何报告。定时任务执行后会出现在这里。</div>
				) : (
					<div className="grid grid-cols-[280px_1fr] gap-5">
						{/* artifact list */}
						<div className="max-h-[480px] space-y-1.5 overflow-y-auto pr-1">
							{artifacts.map((a) => {
								const active = a.id === selectedId;
								return (
									<button
										key={a.id}
										onClick={() => {
											setSelectedId(a.id);
											setBodyFor(null);
										}}
										className={
											"w-full rounded-xl border px-3.5 py-2.5 text-left transition " +
											(active ? "border-blue-300 bg-blue-50/60" : "border-transparent hover:bg-slate-50")
										}
									>
										<div className="truncate text-sm font-medium text-slate-800">⏰ {a.title}</div>
										<div className="mt-1 text-xs text-slate-400">
											{new Date(a.updatedAt).toLocaleString("zh-CN", { hour12: false })}
										</div>
									</button>
								);
							})}
						</div>

						{/* runs + body */}
						<div className="min-w-0">
							{selected && (
								<>
									<div className="mb-3 flex items-center justify-between">
										<div className="truncate text-sm font-semibold text-slate-900">{selected.title}</div>
										<button
											onClick={() => remove(selected.id)}
											className="text-xs text-rose-500 hover:text-rose-600"
										>
											删除全部历史
										</button>
									</div>

									<div className="mb-4 flex flex-wrap gap-1.5">
										{runs.map((r) => (
											<button
												key={r.id}
												onClick={() => openRun(r)}
												className={
													"rounded-lg border px-2.5 py-1 text-xs transition " +
													(r.id === bodyFor ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500 hover:bg-slate-50")
												}
											>
												{new Date(r.createdAt).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
												{r.status === "error" ? " · 失败" : r.status === "partial" ? " · 部分" : ""}
											</button>
										))}
									</div>

									{url && (
										<div className="mb-3 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
											<span className="text-slate-500">报告链接：</span>
											<a href={url} target="_blank" rel="noreferrer" className="truncate text-blue-600 hover:underline">
												{url}
											</a>
										</div>
									)}

									{reports.enabled && (
										<button
											onClick={republish}
											disabled={busy || !bodyFor}
											className="mb-3 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
										>
											{busy ? "重新发布中…" : `重新发布到 ${reports.target === "oss" ? "OSS" : "Gitee"}`}
										</button>
									)}

									<div className="max-h-[360px] overflow-y-auto rounded-xl border border-slate-100 bg-white p-5">
										<div className="prose prose-sm max-w-none text-slate-800">
											<ReactMarkdown>{body}</ReactMarkdown>
										</div>
									</div>
								</>
							)}
						</div>
					</div>
				)}
			</section>
		</div>
	);
}
