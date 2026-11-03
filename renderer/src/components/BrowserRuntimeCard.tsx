import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import type { BrowserRuntimeStatusView } from "../vite-env.d.ts";

/**
 * Self-healing Chromium status for the browser-automation settings card.
 * Shows ready / downloading progress / error with a manual retry. State is
 * pushed from the main process (BrowserRuntime) and also polled as a fallback.
 */
export function BrowserRuntimeCard() {
	const [status, setStatus] = useState<BrowserRuntimeStatusView | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let alive = true;
		const refresh = (): void => {
			api.getBrowserRuntimeStatus()
				.then((next) => { if (alive) setStatus(next); })
				.catch(() => { /* settings page still usable without this */ });
		};
		refresh();
		const off = api.onBrowserRuntimeStatusChanged((next) => { if (alive) setStatus(next); });
		// Fallback poll: covers installs started before this card mounted and any
		// missed push (the status channel only fires while a settings window exists).
		const timer = setInterval(refresh, 3000);
		return () => { alive = false; clearInterval(timer); off(); };
	}, []);

	const retry = async (): Promise<void> => {
		setBusy(true);
		try {
			setStatus(await api.ensureBrowserRuntime());
		} finally {
			setBusy(false);
		}
	};

	if (!status) return null;
	const installing = status.phase === "installing" || status.phase === "checking";
	const ready = status.phase === "ready";
	const error = status.phase === "error";

	return (
		<div className={`rounded-xl border px-4 py-3 text-sm ${
			ready ? "border-emerald-200 bg-emerald-50"
				: error ? "border-red-200 bg-red-50"
					: installing ? "border-blue-200 bg-blue-50"
						: "border-slate-200 bg-[#f7f8fa]"
		}`}>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className={`font-medium ${
						ready ? "text-emerald-700" : error ? "text-red-700" : installing ? "text-blue-700" : "text-slate-700"
					}`}>
						{ready ? `浏览器内核已就绪${status.revision ? `（Chromium ${status.revision}）` : ""}`
							: installing ? (status.phase === "checking" ? "正在检查浏览器内核…" : `正在下载浏览器内核 ${status.progress}%`)
								: error ? "浏览器内核安装失败"
									: "浏览器内核状态未知"}
					</div>
					{!ready && !error && (
						<div className="mt-0.5 text-xs text-slate-500">
							{status.attempt > 1 ? `第 ${status.attempt} 次尝试（${status.source}），官方源不可达时自动切换镜像` : "内核不随安装包分发，首次使用会自动下载；应用升级后如版本变化也会自动更新"}
						</div>
					)}
					{error && (
						<div className="mt-1 break-all text-xs text-red-600">
							{status.error || "下载失败，请检查网络或更换下载源后重试。"}
						</div>
					)}
				</div>
				{(error || ready) && (
					<button
						type="button"
						onClick={() => { void retry(); }}
						disabled={busy}
						className="shrink-0 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{busy ? "处理中…" : error ? "重新安装" : "重新检查"}
					</button>
				)}
			</div>
			{installing && (
				<div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
					<div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${Math.max(3, status.progress)}%` }} />
				</div>
			)}
		</div>
	);
}
