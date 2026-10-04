import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/ipc";
import type { AuthCatalogEntry, AuthQuotaResponse } from "../../../../src/shared/auth";

interface AuthQuotaDialogProps {
	entry: AuthCatalogEntry;
	onClose: () => void;
}

/** Remaining-quota bar color: healthy green, low amber, critical red. */
function barColor(remainingPercent: number): string {
	if (remainingPercent > 50) return "bg-emerald-500";
	if (remainingPercent > 20) return "bg-amber-500";
	return "bg-rose-500";
}

/**
 * Quota dialog (zai / zai-coding-cn): fetches authQuota and renders limits as
 * label + remainingPercent bars + resetsAt. Failures surface in-dialog with retry.
 */
export function AuthQuotaDialog({ entry, onClose }: AuthQuotaDialogProps) {
	const [quota, setQuota] = useState<AuthQuotaResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setQuota(await api.authQuota(entry.provider));
		} catch (reason) {
			setQuota(null);
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(false);
		}
	}, [entry.provider]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-6 backdrop-blur-[2px]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
				<div className="mb-4 flex items-start justify-between gap-3">
					<div>
						<h3 className="text-base font-semibold text-slate-950">套餐额度</h3>
						<p className="mt-0.5 text-xs text-slate-400">{entry.name}</p>
					</div>
					<button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100" aria-label="关闭">
						✕
					</button>
				</div>

				{loading && (
					<div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-5">
						<span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
						<p className="text-sm text-slate-600">正在查询套餐额度…</p>
					</div>
				)}

				{!loading && error && (
					<div>
						<p className="break-all rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm leading-relaxed text-rose-600">{error}</p>
						<p className="mt-2 text-xs text-slate-400">若提示登录过期，请回到「账号登录」重新录入 Key。</p>
					</div>
				)}

				{!loading && quota && (
					<div className="space-y-4">
						{quota.limits.map((limit, index) => (
							<div key={`${limit.label}-${index}`}>
								<div className="flex items-baseline justify-between gap-3">
									<span className="truncate text-sm font-medium text-slate-800">{limit.label}</span>
									<span className="shrink-0 text-sm font-semibold text-slate-700">{Math.round(limit.remainingPercent)}%</span>
								</div>
								<div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
									<div className={`h-full rounded-full transition-all ${barColor(limit.remainingPercent)}`} style={{ width: `${Math.max(2, Math.min(100, limit.remainingPercent))}%` }} />
								</div>
								{limit.resetsAt !== undefined && <p className="mt-1 text-xs text-slate-400">重置于 {new Date(limit.resetsAt).toLocaleString("zh-CN", { hour12: false })}</p>}
							</div>
						))}
						<p className="text-xs text-slate-400">查询时间：{new Date(quota.fetchedAt).toLocaleString("zh-CN", { hour12: false })}</p>
					</div>
				)}

				<div className="mt-6 flex justify-end gap-2">
					{!loading && (
						<button type="button" onClick={() => void load()} className="rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
							刷新
						</button>
					)}
					<button type="button" onClick={onClose} className="rounded-xl bg-[#1d1d1f] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#3f3f43]">
						关闭
					</button>
				</div>
			</div>
		</div>
	);
}
