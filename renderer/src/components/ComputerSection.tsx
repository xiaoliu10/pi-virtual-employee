import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import type { ComputerConfig, ComputerStatus } from "../../../src/shared/computer";
import { MAX_TIMEOUT_SEC, normalizeTimeoutSec } from "../../../src/shared/timeouts";

interface Props { value: ComputerConfig; saved: ComputerConfig; onChange: (value: ComputerConfig) => void }
const inputClass = "min-w-0 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400";
const buttonClass = "shrink-0 whitespace-nowrap rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";
const parseApps = (value: string) => value.split("\n").map(s => s.trim()).filter(Boolean);

export function ComputerSection({ value, saved, onChange }: Props) {
	const [status, setStatus] = useState<ComputerStatus | null>(null);
	const [error, setError] = useState("");
	const [working, setWorking] = useState(false);
	const [apps, setApps] = useState(value.allowedApps.join("\n"));
	useEffect(() => {
		setApps(previous => JSON.stringify(parseApps(previous)) === JSON.stringify(value.allowedApps) ? previous : value.allowedApps.join("\n"));
	}, [value.allowedApps]);
	useEffect(() => {
		let alive = true;
		const refresh = () => api.manageComputer("status").then(next => { if (alive) setStatus(next); }).catch(err => { if (alive) setError(String(err)); });
		void refresh();
		const timer = setInterval(() => { void refresh(); }, 3000);
		return () => { alive = false; clearInterval(timer); };
	}, []);
	const update = (patch: Partial<ComputerConfig>) => onChange({ ...value, ...patch });
	const dirty = JSON.stringify(value) !== JSON.stringify(saved);
	const manage = async (action: "install" | "connect" | "disconnect") => {
		setWorking(true); setError("");
		try { setStatus(await api.manageComputer(action)); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setWorking(false); }
	};
	return <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
		<div className="mb-3 flex items-center justify-between">
			<div><h3 className="text-sm font-medium text-slate-800">Computer Use · 桌面控制</h3><p className="mt-1 text-xs text-slate-400">通过 Cua 操作桌面应用。仅管理员单聊可使用；网页任务继续使用浏览器自动化。</p></div>
			<input aria-label="开启桌面控制" type="checkbox" checked={value.enabled} onChange={e => update({ enabled: e.target.checked })} className="h-5 w-5 accent-blue-500" />
		</div>
		<div className="space-y-3">
			<label className="block text-xs text-slate-600">驱动可执行文件路径
				<div className="mt-1 flex gap-2"><input value={value.driverPath} onChange={e => update({ driverPath: e.target.value })} placeholder="留空自动查找已安装的 Cua Driver" className={inputClass} />
					<button type="button" className={buttonClass} onClick={() => void api.pickComputerDriver().then(path => { if (path) update({ driverPath: path }); }).catch(err => setError(String(err)))}>选择文件</button></div>
			</label>
			<div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
				<div>{status?.connected ? "已连接" : status?.driverPath ? "驱动已找到，尚未连接" : "尚未找到驱动"}{status?.serverVersion ? ` · ${status.serverVersion}` : ""}{status?.busy ? " · 任务进行中" : ""}</div>
				{status?.driverPath && <div className="mt-1 break-all">{status.driverPath}</div>}
				{status?.install === "downloading" && <div className="mt-1">正在下载驱动… {status.installProgress ?? 0}%</div>}
				<div className="mt-2 flex flex-wrap gap-2">
					<button type="button" className={buttonClass} disabled={working || dirty || status?.busy || status?.connected} onClick={() => void manage("install")}>安装 Cua Driver</button>
					<button type="button" className={buttonClass} disabled={working || dirty || status?.busy} onClick={() => void manage("connect")}>检测连接</button>
					<button type="button" className={buttonClass} disabled={!working && !status?.connected && !status?.busy} onClick={() => void manage("disconnect")}>停止并断开</button>
				</div>
				<p className="mt-2">{dirty ? "请先保存设置，再安装或检测连接。" : "Windows/Linux 可直接安装。macOS 请先安装官方 CuaDriver.app，并授予辅助功能和屏幕录制权限。"}</p>
			</div>
			{(error || status?.error) && <p role="alert" className="whitespace-pre-wrap break-words text-xs text-red-600">{error || status?.error}</p>}
			<label className="block text-xs text-slate-600">允许操作的应用（每行一个）
				<textarea rows={3} value={apps} onChange={e => { setApps(e.target.value); update({ allowedApps: parseApps(e.target.value) }); }} placeholder={"notepad.exe\nCalculator"} className={`${inputClass} mt-1`} />
				<span className="mt-1 block text-slate-400">填写应用名称、可执行文件名或应用 ID；空列表拒绝所有应用，单独填写 * 允许全部。可先在管理员对话中让员工列出桌面应用。</span>
			</label>
			{([{ key: "allowForeground", label: "允许必要时切换到前台操作" }, { key: "allowScheduled", label: "允许已授权的管理员定时任务操作桌面" }] as const).map(item => <label key={item.key} className="flex items-center justify-between text-xs text-slate-600">{item.label}<input type="checkbox" checked={value[item.key]} onChange={e => update({ [item.key]: e.target.checked })} className="h-4 w-4 accent-blue-500" /></label>)}
			<div className="grid grid-cols-3 gap-3">
				{([{ key: "connectTimeoutSec", label: "连接等待（秒）", fallback: 30 }, { key: "actionTimeoutSec", label: "动作 / 下载等待（秒）", fallback: 120 }, { key: "sessionTimeoutSec", label: "任务总时限（秒）", fallback: 0 }] as const).map(item => <label key={item.key} className="text-xs text-slate-500">{item.label}<input type="number" min={item.key === "sessionTimeoutSec" ? 0 : 1} max={MAX_TIMEOUT_SEC} value={value[item.key]} onChange={e => update({ [item.key]: Math.max(item.key === "sessionTimeoutSec" ? 0 : 1, normalizeTimeoutSec(e.target.valueAsNumber, item.fallback)) })} className={`${inputClass} mt-1`} /></label>)}
			</div>
			<p className="text-xs text-slate-400">任务总时限 0 表示不限时。每个动作独立等待，连接会在动作之间保留；同一桌面的会话依次执行。</p>
		</div>
	</section>;
}
