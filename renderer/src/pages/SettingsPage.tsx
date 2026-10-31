import { useEffect, useRef, useState } from "react";
import { api } from "../lib/ipc";
import type { AppConfig, ImChannelConfig, IMChannel, ScheduledTaskRow, UpdateState, WorkItemView } from "../lib/types";
import { ModelServiceSection } from "../components/ModelServiceSection";
import { KnowledgeSection } from "../components/KnowledgeSection";
import { MigrationSection } from "../components/MigrationSection";
import { DocumentsSection } from "../components/DocumentsSection";
import { ReportsSection } from "../components/ReportsSection";
import { SkillsSection } from "../components/SkillsSection";
import { ComputerSection } from "../components/ComputerSection";
import { MAX_TIMEOUT_SEC, normalizeTimeoutSec } from "../../../src/shared/timeouts";

interface SettingsPageProps {
	config: AppConfig | null;
	onChange: (patch: Partial<AppConfig>) => Promise<void>;
	/** Updater state (single subscription owned by App; the sidebar badge shares it). */
	updater: {
		state: UpdateState | null;
		check: () => void;
		download: () => void;
		install: () => void;
	};
	onClose: () => void;
}

const CHANNEL_LABELS: Record<string, string> = {
	feishu: "飞书 Lark",
	dingtalk: "钉钉 DingTalk",
	wecom: "企业微信",
	echo: "Echo（测试通道）",
};

type Tab = "model" | "knowledge" | "content" | "skills" | "im" | "general" | "prompt" | "tasks" | "migrate";

type ChannelStatus = Awaited<ReturnType<typeof api.imChannelStatuses>>[number];

function timeAgo(ts: number): string {
	const m = Math.round((Date.now() - ts) / 60_000);
	if (m < 1) return "刚刚";
	if (m < 60) return `${m} 分钟前`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} 小时前`;
	return `${Math.round(h / 24)} 天前`;
}

/** IM 渠道连接状态卡：displayName + 能力声明 + 连接/收发健康度（IMAdapter.status）。 */
function ChannelStatusCard() {
	const [statuses, setStatuses] = useState<ChannelStatus[]>([]);
	const refresh = () => {
		void api.imChannelStatuses().then((list) => {
			setStatuses(list);
			// IM disabled / no channels: stop the poll instead of burning an IPC
			// round-trip every 30s against an empty list.
			if (list.length === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
		}).catch(() => {});
	};
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	useEffect(() => {
		refresh();
		pollTimer = setInterval(refresh, 30_000);
		return () => { if (pollTimer) clearInterval(pollTimer); };
	}, []);
	if (statuses.length === 0) return null;
	return (
		<div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
			<div className="flex items-center justify-between">
				<div className="text-sm font-medium text-slate-800">渠道连接状态</div>
				<button onClick={refresh} className="text-xs text-slate-400 hover:text-slate-600">刷新</button>
			</div>
			<div className="mt-3 space-y-2">
				{statuses.map((c) => (
					<div key={c.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs">
						<div className="flex min-w-0 items-center gap-2">
							<span className={`inline-block h-2 w-2 shrink-0 rounded-full ${c.health?.connected ? "bg-emerald-500" : "bg-slate-300"}`} />
							<span className="font-medium text-slate-700">{c.displayName}</span>
							<span className="truncate text-slate-400">
								{[c.capabilities.proactive ? "主动推送" : null, c.capabilities.groupMention ? "群 @" : null, c.capabilities.media ? "媒体" : null, c.capabilities.streaming ? "流式" : null].filter(Boolean).join(" · ") || "仅应答"}
							</span>
						</div>
						<div className="shrink-0 text-right text-slate-400">
							{c.health?.lastError ? <span className="text-red-500">{c.health.lastError} · </span> : null}
							{c.health?.connected && c.health.startedAt ? `启动于 ${new Date(c.health.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "未启动"}
							{c.health?.lastInboundAt ? ` · 收 ${timeAgo(c.health.lastInboundAt)}` : ""}
							{c.health?.lastOutboundAt ? ` · 发 ${timeAgo(c.health.lastOutboundAt)}` : ""}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
/** Sub-tab inside the unified 内容中心. */
type ContentTab = "resources" | "artifacts";

const TABS: { id: Tab; label: string; icon: JSX.Element }[] = [
	{
		id: "general",
		label: "通用",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[19px] w-[19px]">
				<path strokeLinecap="round" d="M4 7h10M18 7h2M4 17h2M10 17h10M8 4v6M16 14v6" />
			</svg>
		),
	},
	{
		id: "model",
		label: "自定义模型",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[19px] w-[19px]">
				<path strokeLinejoin="round" d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9" />
			</svg>
		),
	},
	{
		id: "knowledge",
		label: "知识库",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[19px] w-[19px]">
				<path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 0 1 1-1h5a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5H5a1 1 0 0 1-1-1V5Z" />
				<path strokeLinecap="round" strokeLinejoin="round" d="M20 5a1 1 0 0 0-1-1h-5a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5H19a1 1 0 0 0 1-1V5Z" />
			</svg>
		),
	},
	{
		id: "content",
		label: "内容中心",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[19px] w-[19px]">
				<path strokeLinecap="round" strokeLinejoin="round" d="M3 7a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v13a1 1 0 0 0-1-1H4a1 1 0 0 1-1-1V7Z" />
				<path strokeLinecap="round" strokeLinejoin="round" d="M21 7a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v13a1 1 0 0 1 1-1h6a1 1 0 0 0 1-1V7Z" />
			</svg>
		),
	},
	{
		id: "skills",
		label: "技能",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[19px] w-[19px]">
				<path strokeLinecap="round" strokeLinejoin="round" d="M13 3 4 14h6l-1 7 9-11h-6l1-7Z" />
			</svg>
		),
	},
	{
		id: "im",
		label: "IM 机器人",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[19px] w-[19px]">
				<path strokeLinecap="round" strokeLinejoin="round" d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
			</svg>
		),
	},
	{
		id: "prompt",
		label: "提示词",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[19px] w-[19px]">
				<path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5 14.5 9 15 9.5 4.5 20H4v-.5Z" />
				<path strokeLinecap="round" strokeLinejoin="round" d="M14.5 9 17 6.5a2 2 0 0 1 2.8 2.8L17.3 11.8 14.5 9Z" />
				<path strokeLinecap="round" d="M4 4h6M4 4v0M4 8V4" />
			</svg>
		),
	},
	{
		id: "tasks",
		label: "定时任务",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[19px] w-[19px]">
				<circle cx="12" cy="13" r="8" />
				<path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4l2.5 1.5M9 3h6M12 5V3" />
			</svg>
		),
	},
	{
		id: "migrate",
		label: "迁移与复制",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[19px] w-[19px]">
				<path strokeLinecap="round" strokeLinejoin="round" d="M4 12h12M12 7l5 5-5 5M16 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2" />
			</svg>
		),
	},
];

/** 自主任务编辑弹窗（设置页 → 任务 → 自主任务）：改目标/执行条件。 */
function WorkEditDialog({ item, onClose, onSaved }: { item: WorkItemView; onClose: () => void; onSaved: () => void }) {
	const [goal, setGoal] = useState(item.goal ?? "");
	const [conditions, setConditions] = useState(item.conditions ?? "");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const save = async () => {
		setBusy(true); setErr("");
		try {
			const res = await api.workItemEdit(item.id, { goal, conditions });
			if (res.ok) { onSaved(); onClose(); } else setErr(res.error ?? "保存失败");
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
			<div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
				<h3 className="text-[15px] font-semibold text-slate-800">编辑自主任务</h3>
				<p className="mt-1 text-xs text-slate-400">{item.title} · 执行中请先暂停再改，避免覆盖在飞窗口的修改</p>
				<label className="mt-4 block text-xs font-medium text-slate-600">目标</label>
				<textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
				<label className="mt-3 block text-xs font-medium text-slate-600">执行条件</label>
				<textarea value={conditions} onChange={(e) => setConditions(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
				{err && <p className="mt-2 text-xs text-rose-500">{err}</p>}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" onClick={onClose} className="rounded-lg px-4 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50">取消</button>
					<button type="button" onClick={() => void save()} disabled={busy} className="rounded-lg bg-slate-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-900 disabled:opacity-50">{busy ? "保存中…" : "保存"}</button>
				</div>
			</div>
		</div>
	);
}

/** 删除确认（终态自主任务）：不可恢复，无回收站。 */
function WorkDeleteDialog({ item, onClose, onDeleted }: { item: WorkItemView; onClose: () => void; onDeleted: () => void }) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	// Status snapshot at open: if the item was resumed between opening the dialog
	// and confirming (rare race), the refusal must say "状态变了" rather than
	// blaming a live task the user never saw (review P2-1).
	const openedStatus = item.status;
	const del = async () => {
		setBusy(true); setErr("");
		try {
			const res = await api.deleteWorkItem(item.id);
			if (res.ok) { onDeleted(); onClose(); }
			else if (res.error === "任务不存在（可能已被删除）" || (res.error ?? "").includes("只能删除")) {
				// The row moved since the dialog opened (e.g. resumed from the IM
				// side while the dialog was up): say so instead of blaming a live
				// task the user never saw (review P2-1).
				const now = await api.listWorkItems().catch(() => []);
				const current = now.find((r) => r.id === item.id);
				setErr(current && current.status !== openedStatus
					? `任务状态已变化（打开时是「${openedStatus}」，现在是「${current.status}」），请刷新后重试`
					: res.error ?? "删除失败");
			} else setErr(res.error ?? "删除失败");
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
			<div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
				<h3 className="text-[15px] font-semibold text-slate-800">删除自主任务</h3>
				<p className="mt-2 text-sm text-slate-600">「{item.title}」将从任务列表中永久删除，<span className="font-medium text-rose-600">无法恢复</span>。</p>
				<p className="mt-1 text-xs text-slate-400">任务执行中沉淀到知识库的经验已独立保存，不受影响（极少见的竞态下：删除恰好落在窗口收尾前，该轮经验可能未及沉淀）。</p>
				{err && <p className="mt-2 text-xs text-rose-500">{err}</p>}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" onClick={onClose} className="rounded-lg px-4 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50">取消</button>
					<button type="button" onClick={() => void del()} disabled={busy} className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50">{busy ? "删除中…" : "确认删除"}</button>
				</div>
			</div>
		</div>
	);
}

/** 定时任务编辑弹窗（设置页 → 任务 → 定时任务）：改标题/prompt/cron。 */
function SchedEditDialog({ task, onClose, onSaved }: { task: ScheduledTaskRow; onClose: () => void; onSaved: () => void }) {
	const [title, setTitle] = useState(task.title);
	const [prompt, setPrompt] = useState(task.prompt);
	const [cron, setCron] = useState(task.cron);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const save = async () => {
		setBusy(true); setErr("");
		const res = await api.editScheduledTask(task.id, { title, prompt, cron });
		setBusy(false);
		if (res.ok) { onSaved(); onClose(); } else setErr(res.error ?? "保存失败");
	};
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
			<div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
				<h3 className="text-[15px] font-semibold text-slate-800">编辑定时任务</h3>
				<label className="mt-4 block text-xs font-medium text-slate-600">标题</label>
				<input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
				<label className="mt-3 block text-xs font-medium text-slate-600">cron（分 时 日 月 周，本地时间）</label>
				<input value={cron} onChange={(e) => setCron(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm focus:border-blue-400 focus:outline-none" />
				<label className="mt-3 block text-xs font-medium text-slate-600">到点执行的指令</label>
				<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
				{err && <p className="mt-2 text-xs text-rose-500">{err}</p>}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" onClick={onClose} className="rounded-lg px-4 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50">取消</button>
					<button type="button" onClick={() => void save()} disabled={busy} className="rounded-lg bg-slate-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-900 disabled:opacity-50">{busy ? "保存中…" : "保存"}</button>
				</div>
			</div>
		</div>
	);
}

function Field({ label, children, hint }: { label: string; children: JSX.Element; hint?: string }) {
	return (
		<label className="block">
			<span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>
			{children}
			{hint && <span className="mt-1.5 block text-xs leading-relaxed text-slate-400">{hint}</span>}
		</label>
	);
}

const inputCls = "h-11 w-full rounded-xl border border-slate-200 bg-[#f7f8fa] px-3.5 text-sm text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100";

/** Capability keys accepted by conversation floors — must match
 *  CAPABILITY_LABEL in src/security/permissions.ts. */
const SECURITY_CAPABILITY_LABEL: Record<string, string> = {
	chat: "对话服务",
	knowledge: "知识库检索",
	learn: "知识/记忆沉淀",
	browser: "浏览器操作",
	computer: "桌面控制",
	shell: "命令执行",
	filesystem: "文件系统",
	documents: "文档处理",
	scheduler: "定时任务",
	reports: "产物中心",
	knowledge_manage: "知识库管理",
	settings: "系统设置",
	admin: "管理员操作",
};

const SHELL_TIMEOUT_FIELDS = [
	{ key: "timeoutSec", label: "同步命令运行时限（秒）", fallback: 60, hint: "同步执行命令的最长运行时间，默认 60 秒，0 = 不限制。超时会终止进程树。保存后对下一次命令执行生效。" },
	{ key: "backgroundTimeoutSec", label: "后台命令运行时限（秒）", fallback: 0, hint: "后台任务独立运行，默认 0 = 不限制。设为正数时，达到时限会终止进程树；长时间采集任务可保持不限时。" },
	{ key: "pollTimeoutSec", label: "后台任务单次等待时间（秒）", fallback: 30, hint: "查询后台任务时，最多阻塞等待的默认秒数，0 = 立即返回。等待结束不会终止进程；长任务可调大以减少轮询次数。" },
] as const;

/** 自主任务状态徽标（设置页 → 定时任务与自主任务 → 自主任务 tab）。 */
const WORK_STATUS: Record<string, { label: string; cls: string }> = {
	proposed: { label: "已提议", cls: "bg-slate-100 text-slate-500" },
	queued: { label: "待执行", cls: "bg-slate-100 text-slate-600" },
	working: { label: "执行中", cls: "bg-blue-50 text-blue-600" },
	waiting_human: { label: "等待人工", cls: "bg-amber-50 text-amber-600" },
	scheduled: { label: "已排期", cls: "bg-indigo-50 text-indigo-600" },
	done: { label: "已完成", cls: "bg-emerald-50 text-emerald-600" },
	cancelled: { label: "已取消", cls: "bg-rose-50 text-rose-500" },
};

export function SettingsPage({ config, onChange, updater, onClose }: SettingsPageProps) {
	const [tab, setTab] = useState<Tab>("model");
	const [contentTab, setContentTab] = useState<ContentTab>("resources");
	const [draft, setDraft] = useState<AppConfig | null>(config);
	/**
	 * Live widget listener state. Multi-profile machines (--profile Nova/Orion…)
	 * each keep their own port; before this, a collision only produced one WARN in
	 * main.log while the settings page still claimed the widget was enabled.
	 */
	const [widgetStatus, setWidgetStatus] = useState<{ running: boolean; starting?: boolean; port: number; error?: string; reassignedFrom?: number } | null>(null);
	const [widgetBusy, setWidgetBusy] = useState(false);
	useEffect(() => {
		let alive = true;
		const load = () => api.getWidgetStatus().then((s) => { if (alive) setWidgetStatus(s); }).catch(() => {});
		load();
		// Startup finishes AFTER this page mounts, so a pull-only panel would sit on
		// "not started" until an unrelated config event (code review P2-2). Subscribe
		// to the listener's own state pushes; config edits also re-read.
		const offStatus = api.onWidgetStatusChanged?.((s) => { if (alive) setWidgetStatus(s); });
		const offCfg = api.onConfigChanged?.(load);
		return () => { alive = false; offStatus?.(); offCfg?.(); };
	}, []);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [channelTypes, setChannelTypes] = useState<string[]>(["echo", "dingtalk"]);
	const [selectedChId, setSelectedChId] = useState<string | null>(null);
	const [promptPreview, setPromptPreview] = useState<string | null>(null);
	const [schedTasks, setSchedTasks] = useState<ScheduledTaskRow[]>([]);
	const refreshSched = () => api.listScheduledTasks().then(setSchedTasks).catch(() => {});
	const [taskTab, setTaskTab] = useState<"scheduled" | "work">("scheduled");
	const [workItems, setWorkItems] = useState<WorkItemView[]>([]);
	const [workActErr, setWorkActErr] = useState("");
	const refreshWork = () => api.listWorkItems().then(setWorkItems).catch(() => {});
	/** Lifecycle actions with failure surfacing (review P3-2). */
	const actWork = async (id: string, action: "pause" | "resume" | "cancel") => {
		try {
			const res = await api.workItemAct(id, action);
			setWorkActErr(res.ok ? "" : res.error ?? "操作失败");
			await refreshWork();
		} catch (e) {
			setWorkActErr(e instanceof Error ? e.message : String(e));
		}
	};
	const [workEdit, setWorkEdit] = useState<WorkItemView | null>(null);
	/** Delete confirmation for a TERMINAL autonomous task (field 2026-10-18). */
	const [workDelete, setWorkDelete] = useState<WorkItemView | null>(null);
	const [schedEdit, setSchedEdit] = useState<ScheduledTaskRow | null>(null);
	useEffect(() => {
		if (tab !== "tasks") return;
		void refreshSched();
		void refreshWork();
		// Work items change status from the IM side (resume answers, window
		// pushes fire im:activity with the work: conversation id) — keep both
		// lists live while the tab is open.
		return api.onImActivity(() => { void refreshSched(); void refreshWork(); });
	}, [tab]);
	// Raw text for the allowed-domains editor — kept separate from the parsed
	// array so the textarea can retain newlines while typing (a derived value
	// would strip the trailing empty line and "eat" the Enter key).
	const [domainsText, setDomainsText] = useState((config?.browser.allowedDomains ?? []).join("\n"));
	const [shellCommandsText, setShellCommandsText] = useState((config?.capabilities.shell.allowedCommands ?? []).join("\n"));
	// Mining health: the feature runs in the background with NO user-visible
	// artifact until a proposal lands. Twice now (prompt_lab, mining) a wired
	// feature sat silently "off" and nobody noticed for months — so the settings
	// page always shows WHEN it last ran and WHAT it produced.
	const [miningStatus, setMiningStatus] = useState<Awaited<ReturnType<typeof api.getMiningStatus>> | null>(null);
	useEffect(() => {
		void api.getMiningStatus().then(setMiningStatus).catch(() => {});
	}, []);
	useEffect(() => {
		const t = setInterval(() => { void api.getMiningStatus().then(setMiningStatus).catch(() => {}); }, 60_000);
		return () => clearInterval(t);
	}, []);
	useEffect(() => {
		setDomainsText((config?.browser.allowedDomains ?? []).join("\n"));
		setShellCommandsText((config?.capabilities.shell.allowedCommands ?? []).join("\n"));
	}, [config]);

	// Adopt an external config refresh ONLY when the draft has no unsaved edits —
	// otherwise an IM-side change (manage_access / manage_settings) would wipe what
	// the admin is typing in the open settings page (field 2026-10-13). "No edits" is
	// measured against the last config we actually synced from, not by reference
	// identity (config is a fresh object on every push). The primary scenario —
	// settings page opened AFTER the change — sees the fresh config on mount anyway.
	const lastSyncedConfig = useRef<AppConfig | null>(config);
	useEffect(() => {
		setDraft((current) => {
			if (!config) return config;
			const synced = lastSyncedConfig.current;
			const untouched = current === null || (synced !== null && JSON.stringify(current) === JSON.stringify(synced));
			lastSyncedConfig.current = config;
			return untouched ? config : current;
		});
	}, [config]);
	useEffect(() => {
		api.imChannels()
			.then((values) => values.length > 0 && setChannelTypes(values))
			.catch(() => {});
	}, []);

	const setIm = (patch: Partial<AppConfig["im"]>) =>
		setDraft((value) => value ? { ...value, im: { ...value.im, ...patch } } : value);

	// --- IM channel list helpers ---
	const setChannels = (list: ImChannelConfig[]) => setIm({ channels: list });
	const updateChannel = (id: string, patch: Partial<ImChannelConfig>) =>
		setChannels(draft ? draft.im.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) : []);
	const addChannel = () => {
		const ch: ImChannelConfig = {
			id: crypto.randomUUID(),
			type: "dingtalk",
			enabled: false,
			name: CHANNEL_LABELS["dingtalk"] ?? "钉钉",
			appId: "",
			appSecret: "",
		};
		setChannels([...(draft?.im.channels ?? []), ch]);
		setSelectedChId(ch.id);
	};
	const removeChannel = (id: string) => {
		setChannels((draft?.im.channels ?? []).filter((c) => c.id !== id));
		if (selectedChId === id) setSelectedChId(null);
	};
	const selectedChannel = draft?.im.channels.find((c) => c.id === selectedChId) ?? null;
	const setGeneral = (patch: Partial<AppConfig["general"]>) =>
		setDraft((value) => value ? { ...value, general: { ...value.general, ...patch } } : value);
	const setIdentity = (patch: Partial<AppConfig["identity"]>) =>
		setDraft((value) => value ? { ...value, identity: { ...value.identity, ...patch } } : value);
	const setPrompt = (patch: Partial<AppConfig["prompt"]>) =>
		setDraft((value) => value ? { ...value, prompt: { ...value.prompt, ...patch } } : value);
	const setBrowser = (patch: Partial<AppConfig["browser"]>) =>
		setDraft((value) => value ? { ...value, browser: { ...value.browser, ...patch } } : value);
	const setDocuments = (patch: Partial<AppConfig["documents"]>) =>
		setDraft((value) => value ? { ...value, documents: { ...value.documents, ...patch } } : value);
	const setReports = (patch: Partial<AppConfig["reports"]>) =>
		setDraft((value) => value ? { ...value, reports: { ...value.reports, ...patch } } : value);
	const setFilesystem = (patch: Partial<AppConfig["filesystem"]>) =>
		setDraft((value) => value ? { ...value, filesystem: { ...value.filesystem, ...patch } } : value);
	const setShell = (patch: Partial<AppConfig["capabilities"]["shell"]>) =>
		setDraft((value) => value ? {
			...value,
			capabilities: { ...value.capabilities, shell: { ...value.capabilities.shell, ...patch } },
		} : value);
	const setSecurity = (patch: Partial<AppConfig["security"]>) =>
		setDraft((value) => value ? { ...value, security: { ...value.security, ...patch } } : value);
	const setWidget = (patch: Partial<AppConfig["widget"]>) =>
		setDraft((value) => value ? { ...value, widget: { ...value.widget, ...patch } } : value);

	const cancel = () => {
		setDraft(config);
		setError(null);
		onClose();
	};

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		setError(null);
		try {
			await onChange(draft);
			onClose();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="titlebar-nodrag fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-8 backdrop-blur-[3px]">
			<div className="animate-settings-in flex h-[min(780px,calc(100vh-64px))] w-[min(1180px,calc(100vw-64px))] min-w-[900px] overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_10px_38px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]">
				<aside className="flex w-[230px] shrink-0 flex-col border-r border-black/[0.08] bg-[#f6f6f7] px-5 pb-5 pt-8">
					<div className="px-3 text-2xl font-semibold tracking-tight text-[#1d1d1f]">设置</div>
					<nav className="mt-7 space-y-1.5">
						{TABS.map((item) => (
							<button
								type="button"
								key={item.id}
								onClick={() => setTab(item.id)}
								className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-[15px] font-medium transition ${
									tab === item.id ? "bg-black/[0.075] text-[#1d1d1f]" : "text-[#6e6e73] hover:bg-black/[0.045] hover:text-[#1d1d1f]"
								}`}
							>
								{item.icon}
								{item.label}
							</button>
						))}
					</nav>
					<div className="mt-auto px-3 text-xs leading-relaxed text-slate-400">π Virtual Employee<br />本机配置中心</div>
				</aside>

				<div className="flex min-w-0 flex-1 flex-col bg-white">
					<header className="flex h-[82px] shrink-0 items-center justify-between border-b border-slate-100 px-8">
						<div>
							<h1 className="text-2xl font-semibold tracking-tight text-[#1d1d1f]">{tab === "model" ? "自定义模型" : tab === "knowledge" ? "知识库" : tab === "content" ? "内容中心" : tab === "skills" ? "技能" : tab === "im" ? "IM 机器人" : tab === "prompt" ? "提示词" : tab === "tasks" ? "定时任务与自主任务" : tab === "migrate" ? "迁移与复制" : "通用"}</h1>
							{tab !== "model" && <p className="mt-1 text-xs text-[#a1a1a6]">{tab === "knowledge" ? "可配置、可插拔的知识库：内置混合检索 + 外接 RAG。" : tab === "content" ? "交付资料库（既有可复用资料）与任务产物（生成的带版本输出）统一在此管理。" : tab === "skills" ? "管理内置与导入的技能（SKILL.md），启停、导入、删除。技能以声明式指令注入提示词。" : tab === "im" ? "连接即时通讯渠道，让虚拟员工随时响应。" : tab === "prompt" ? "自定义员工的内置行为规则与追加指令，保存后新对话生效。" : tab === "tasks" ? "定时任务到点自动执行；自主任务由员工自行判断节奏持续跟进。两者均可在此查看与管理。" : tab === "migrate" ? "把当前员工打包导出（.pve），或导入员工包：克隆为新员工 / 覆盖当前员工，支持跨机器迁移。" : "管理员工身份与系统行为。"}</p>}
						</div>
						<button type="button" onClick={cancel} className="rounded-xl p-2 text-2xl leading-none text-[#a1a1a6] transition hover:bg-black/[0.045] hover:text-[#1d1d1f]" aria-label="关闭设置">×</button>
					</header>

					<div className="flex min-h-0 flex-1">
						{!draft ? (
							<div className="flex flex-1 items-center justify-center text-sm text-slate-400">加载配置中...</div>
						) : tab === "model" ? (
							<ModelServiceSection model={draft.model} onUpdate={(model) => setDraft((value) => value ? { ...value, model } : value)} />
						) : tab === "migrate" ? (
							<MigrationSection />
						) : tab === "knowledge" ? (
							<KnowledgeSection kb={draft.kb} suppliers={draft.model.suppliers} onUpdate={(kb) => setDraft((value) => value ? { ...value, kb } : value)} />
						) : tab === "content" ? (
							<div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#fafbfc] px-10 py-8">
								<div className="mx-auto w-full max-w-3xl">
									<div className="mb-4 inline-flex rounded-xl border border-slate-200 bg-white p-1">
										<button type="button" onClick={() => setContentTab("resources")} className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${contentTab === "resources" ? "bg-black/[0.075] text-[#1d1d1f]" : "text-[#6e6e73] hover:text-[#1d1d1f]"}`}>交付资料库</button>
										<button type="button" onClick={() => setContentTab("artifacts")} className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${contentTab === "artifacts" ? "bg-blue-100/80 text-blue-600" : "text-slate-500 hover:text-slate-800"}`}>任务产物</button>
									</div>
									<div className="space-y-5">
										{contentTab === "resources" ? (
											<DocumentsSection documents={draft.documents} onUpdate={setDocuments} />
										) : (
											<ReportsSection
												reports={draft.reports}
												onUpdate={(reports) => setReports(reports)}
												onBeforeTest={async () => {
													if (draft) await onChange(draft);
												}}
											/>
										)}
									</div>
								</div>
							</div>
						) : tab === "skills" ? (
							<div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-10 py-8">
								<div className="mx-auto w-full max-w-3xl">
									<SkillsSection />
								</div>
							</div>
						) : tab === "prompt" ? (
							<div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-10 py-8">
								<div className="mx-auto max-w-2xl space-y-5">
									<section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
										<div className="mb-3">
											<h3 className="text-[15px] font-semibold text-slate-800">核心行为规则（工作准则）</h3>
											<p className="mt-1 text-xs text-slate-400">留空 = 使用内置默认规则；填入内容则<b>整体覆盖</b>默认规则。能力与工具相关规则（知识库/联网/浏览器等）会按已启用功能自动追加在后面，无需在此重复。</p>
										</div>
										<textarea
											value={draft.prompt.rules}
											onChange={(e) => { setPrompt({ rules: e.target.value }); setPromptPreview(null); }}
											rows={14}
											placeholder={"留空使用内置规则；或点「载入默认」在此基础上修改。每行一条规则。"}
											className={inputCls + " h-auto py-2 font-mono text-xs leading-relaxed"}
										/>
										<div className="mt-2 flex flex-wrap items-center gap-2">
											<button type="button" onClick={() => void api.defaultPromptRules().then((t) => { setPrompt({ rules: t }); setPromptPreview(null); })} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">载入默认（可在此基础上改）</button>
											<button type="button" onClick={() => { setPrompt({ rules: "" }); setPromptPreview(null); }} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">恢复内置（清空自定义）</button>
											<span className="text-xs text-slate-400">{draft.prompt.rules.trim() ? "当前：自定义规则（覆盖内置）" : "当前：内置默认规则"}</span>
										</div>
									</section>

									<section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
										<div className="mb-3">
											<h3 className="text-[15px] font-semibold text-slate-800">追加指令</h3>
											<p className="mt-1 text-xs text-slate-400">附加在规则之后的补充要求，与上面的规则一同生效。</p>
										</div>
										<textarea value={draft.prompt.extra} onChange={(e) => { setPrompt({ extra: e.target.value }); setPromptPreview(null); }} rows={4} placeholder="例如：所有金额相关咨询一律转人工；回复统一加表情符号。" className={inputCls + " h-auto py-2"} />
									</section>

									<section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
										<div className="mb-3 flex items-center justify-between">
											<div>
												<h3 className="text-[15px] font-semibold text-slate-800">系统提示词预览</h3>
												<p className="mt-1 text-xs text-slate-400">按当前配置（含身份、规则、已启用能力）拼装的完整系统提示词。保存后新对话生效。</p>
											</div>
											<button type="button" onClick={() => void api.previewPrompt().then((t) => setPromptPreview(t))} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">刷新预览</button>
										</div>
										<pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">{promptPreview ?? "点「刷新预览」查看拼装结果。预览反映已保存的配置；若改了上面的内容，先点底部「保存」再刷新。"}</pre>
									</section>
								</div>
							</div>
						) : tab === "tasks" ? (
							<div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-10 py-8">
								<div className="mx-auto max-w-2xl space-y-5">
									<div className="flex w-fit items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
										{([["scheduled", "定时任务"], ["work", "自主任务"]] as const).map(([key, label]) => (
											<button key={key} type="button" onClick={() => setTaskTab(key)}
												className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${taskTab === key ? "bg-slate-800 text-white" : "text-slate-500 hover:bg-slate-50"}`}>{label}</button>
										))}
									</div>
									{taskTab === "work" ? (
										<section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
											<div className="mb-3 flex items-center justify-between">
												<div>
													<h3 className="text-[15px] font-semibold text-slate-800">自主任务（{workItems.length}）</h3>
													<p className="mt-1 text-xs text-slate-400">需要持续判断跟进的工作：员工自己决定观察点与节奏，卡住时暂停等人。恢复 / 回答在 IM 对话里进行。</p>
												</div>
												<button type="button" onClick={() => void refreshWork()} className="text-xs font-medium text-blue-600 hover:text-blue-700">刷新</button>
											</div>
											{workActErr && <p className="mb-2 text-xs text-rose-500">{workActErr}</p>}
											<div className="space-y-2">
												{workItems.length === 0 && <div className="text-xs text-slate-400">暂无自主任务。可在 IM 对话里描述一个需要持续跟进的目标让员工创建，例如「每天盯着对账异常，发现问题直接在群里说」。</div>}
												{workItems.map((w) => {
													const badge = WORK_STATUS[w.status] ?? { label: w.status, cls: "bg-slate-100 text-slate-500" };
													return (
														<div key={w.id} className="rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3 text-sm">
															<div className="flex items-center gap-2">
																<span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
																<span className="truncate font-medium text-slate-700">{w.title}</span>
																<span className="ml-auto shrink-0 text-[11px] text-slate-400">{new Date(w.updated_at).toLocaleString("zh-CN", { hour12: false })}</span>
															</div>
															{w.goal && <div className="mt-1 line-clamp-1 text-xs text-slate-500">目标：{w.goal}</div>}
															{w.status === "waiting_human" && w.question && (
																<div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
																	<span className="font-medium">等待人工：</span>{w.question}
																</div>
															)}
															{w.progress && <div className="mt-1 line-clamp-2 text-xs text-slate-400">进展：{w.progress}</div>}
															<div className="mt-1 text-[11px] text-slate-400">
																{w.next_check_at ? `下次跟进 ${new Date(w.next_check_at).toLocaleString("zh-CN", { hour12: false })}` : "无排期"}
																{w.remind_count > 0 ? ` · 已提醒 ${w.remind_count} 次` : ""}
																{w.created_by ? ` · 确认创建 ${w.created_by}` : ""}
															</div>
															<div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
																{w.status !== "done" && w.status !== "cancelled" && (
																	<button type="button" onClick={() => setWorkEdit(w)} className="font-medium text-blue-600 hover:text-blue-700">编辑</button>
																)}
																{(w.status === "done" || w.status === "cancelled") && (
																	<button type="button" onClick={() => setWorkDelete(w)} className="font-medium text-rose-600 hover:text-rose-700">删除</button>
																)}
																{w.status === "scheduled" && (
																	<button type="button" onClick={() => void actWork(w.id, "pause")} className="font-medium text-amber-600 hover:text-amber-700">暂停</button>
																)}
																{w.status === "waiting_human" && (
																	<button type="button" onClick={() => void actWork(w.id, "resume")} className="font-medium text-emerald-600 hover:text-emerald-700">恢复</button>
																)}
																{(w.status === "proposed" || w.status === "queued" || w.status === "working" || w.status === "scheduled" || w.status === "waiting_human") && (
																	<button type="button" onClick={() => void actWork(w.id, "cancel")} className="font-medium text-slate-500 hover:text-slate-700">取消</button>
																)}
															</div>
														</div>
													);
												})}
											</div>
										</section>
									) : (
									<>
									<label className="flex cursor-pointer items-center justify-between rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
										<div><div className="text-sm font-medium text-slate-800">启用定时任务</div><div className="mt-1 text-xs text-slate-400">开启后，员工可在对话中创建定时任务；系统到点自动执行（每分钟检查一次）。</div></div>
										<input type="checkbox" checked={draft.scheduler.enabled} onChange={(e) => setDraft((v) => v ? { ...v, scheduler: { enabled: e.target.checked } } : v)} className="h-5 w-5 accent-blue-500" />
									</label>
									<section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
										<div className="mb-3 flex items-center justify-between">
											<h3 className="text-[15px] font-semibold text-slate-800">已有定时任务（{schedTasks.length}）</h3>
											<button type="button" onClick={() => void refreshSched()} className="text-xs font-medium text-blue-600 hover:text-blue-700">刷新</button>
										</div>
										<div className="space-y-2">
											{schedTasks.length === 0 && <div className="text-xs text-slate-400">暂无定时任务。可在对话中让员工创建，例如「每天早上 9 点查一下昨天订单并汇报」。</div>}
											{schedTasks.map((t) => (
												<div key={t.id} className="rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3 text-sm">
													<div className="flex items-center gap-2">
														<span className="truncate font-medium text-slate-700">{t.title}</span>
														{t.silent === 1 && <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500" title="执行并记录结果，但成功时不推送；出错仍会通知">静默</span>}
														<label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
															启用
															<input type="checkbox" checked={t.enabled === 1} onChange={(e) => { void api.toggleScheduledTask(t.id, e.target.checked).then(refreshSched); }} className="h-4 w-4 accent-blue-500" />
														</label>
														<label className="flex items-center gap-1.5 text-xs text-slate-400" title="静默执行：照常执行并记录，但成功时不推送「定时任务完成」；出错仍会推送">
															静默
															<input type="checkbox" checked={t.silent === 1} onChange={(e) => { void api.setScheduledTaskSilent(t.id, e.target.checked).then(refreshSched); }} className="h-4 w-4 accent-blue-500" />
														</label>
														<button type="button" onClick={() => setSchedEdit(t)} className="text-xs font-medium text-blue-600 hover:text-blue-700">编辑</button>
														<button type="button" onClick={() => void api.deleteScheduledTask(t.id).then(refreshSched)} className="text-xs text-rose-400 hover:text-rose-600">删除</button>
													</div>
													<div className="mt-1 text-xs text-slate-500">cron <code className="rounded bg-slate-100 px-1">{t.cron}</code> · 下次 {t.next_run_at ? new Date(t.next_run_at).toLocaleString("zh-CN", { hour12: false }) : "—"} · 上次 {t.last_run_at ? new Date(t.last_run_at).toLocaleString("zh-CN", { hour12: false }) : "—"}{t.last_status ? ` · ${t.last_status}` : ""}</div>
													<div className="mt-1 line-clamp-2 text-xs text-slate-400">{t.prompt}</div>
												</div>
											))}
										</div>
									</section>
									</>
									)}
									{workEdit && <WorkEditDialog item={workEdit} onClose={() => setWorkEdit(null)} onSaved={() => void refreshWork()} />}
									{workDelete && <WorkDeleteDialog item={workDelete} onClose={() => setWorkDelete(null)} onDeleted={() => void refreshWork()} />}
									{schedEdit && <SchedEditDialog task={schedEdit} onClose={() => setSchedEdit(null)} onSaved={() => void refreshSched()} />}
								</div>
							</div>
						) : (
							<div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-10 py-8">
								<div className="mx-auto max-w-2xl space-y-5">
									{tab === "im" && (
										<>
											<ChannelStatusCard />
											<label className="flex cursor-pointer items-center justify-between rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
												<div><div className="text-sm font-medium text-slate-800">启用 IM 接入</div><div className="mt-1 text-xs text-slate-400">保存后立即启动所有已启用的渠道（可同时连多个）。</div></div>
												<input type="checkbox" checked={draft.im.enabled} onChange={(event) => setIm({ enabled: event.target.checked })} className="h-5 w-5 accent-blue-500" />
											</label>

											<div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
												<label className="flex cursor-pointer items-center justify-between">
													<div><div className="text-sm font-medium text-slate-800">收到即回表情</div><div className="mt-1 text-xs text-slate-400">收到消息瞬间在原消息上盖一个「🤔思考中」表情，回复发出后自动撤回（钉钉原生 reaction，参考 Lobster/OpenClaw）。斜杠命令不盖。</div></div>
													<input type="checkbox" checked={draft.im.ack.enabled} onChange={(e) => setIm({ ack: { ...draft.im.ack, enabled: e.target.checked } })} className="h-5 w-5 accent-blue-500" />
												</label>
												{draft.im.ack.enabled && (
													<div className="mt-3">
														<Field label="备用确认文案（无表情接口的通道用）"><input value={draft.im.ack.text} onChange={(e) => setIm({ ack: { ...draft.im.ack, text: e.target.value } })} placeholder="👍 收到，正在处理…" className={inputCls} /></Field>
													</div>
												)}
											</div>

											<div>
												<div className="mb-2 flex items-center justify-between">
													<span className="text-sm font-medium text-slate-700">渠道</span>
													<button type="button" onClick={addChannel} className="text-xs font-medium text-blue-600 hover:text-blue-700">+ 添加渠道</button>
												</div>
												<div className="space-y-2">
													{draft.im.channels.length === 0 && <div className="text-xs text-slate-400">尚未配置渠道。点「添加渠道」开始。</div>}
													{draft.im.channels.map((c) => (
														<div key={c.id} className={`flex items-center gap-3 rounded-xl border px-4 py-2 text-sm ${c.id === selectedChId ? "border-blue-300 bg-blue-50/40" : "border-slate-200 bg-[#f7f8fa]"}`}>
															<button type="button" onClick={() => setSelectedChId(c.id)} className="min-w-0 text-left">
																<div className="truncate font-medium text-slate-700">{c.name}</div>
																<div className="text-xs text-slate-400">{CHANNEL_LABELS[c.type] ?? c.type}</div>
															</button>
															<label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
																启用
																<input type="checkbox" checked={c.enabled} onChange={(e) => updateChannel(c.id, { enabled: e.target.checked })} className="h-4 w-4 accent-blue-500" />
															</label>
															<button type="button" onClick={() => setSelectedChId(c.id)} className="text-xs text-slate-500 hover:text-slate-700">编辑</button>
															<button type="button" onClick={() => removeChannel(c.id)} className="text-xs text-rose-400 hover:text-rose-600">删除</button>
														</div>
													))}
												</div>
											</div>

											{selectedChannel && (
												<div className="space-y-4 rounded-2xl border border-blue-200 bg-blue-50/30 p-5">
													<div className="grid grid-cols-2 gap-4">
														<Field label="类型">
															<select value={selectedChannel.type} onChange={(e) => updateChannel(selectedChannel.id, { type: e.target.value as IMChannel, name: CHANNEL_LABELS[e.target.value as IMChannel] ?? selectedChannel.name })} className={inputCls}>
																{channelTypes.map((t) => <option key={t} value={t}>{CHANNEL_LABELS[t] ?? t}</option>)}
															</select>
														</Field>
														<Field label="名称"><input value={selectedChannel.name} onChange={(e) => updateChannel(selectedChannel.id, { name: e.target.value })} className={inputCls} /></Field>
													</div>
													<div className="grid grid-cols-2 gap-4">
														<Field label={selectedChannel.type === "dingtalk" ? "ClientID（AppKey）" : "App ID"}><input value={selectedChannel.appId} onChange={(e) => updateChannel(selectedChannel.id, { appId: e.target.value })} className={inputCls} /></Field>
														<Field label={selectedChannel.type === "dingtalk" ? "ClientSecret（AppSecret）" : "App Secret"}><input type="password" value={selectedChannel.appSecret} onChange={(e) => updateChannel(selectedChannel.id, { appSecret: e.target.value })} className={inputCls} /></Field>
													</div>
													{selectedChannel.type === "dingtalk" && (
														<>
															<Field label="互动卡片模板 ID（可选，默认用官方 AI 卡片模板）">
																<input
																	value={selectedChannel.cardTemplateId ?? ""}
																	onChange={(e) => updateChannel(selectedChannel.id, { cardTemplateId: e.target.value })}
																	className={inputCls}
																	placeholder="留空 = 官方 AI 卡片模板（流式、支持表格渲染）"
																/>
															</Field>
															<div className="rounded-2xl border border-amber-100 bg-amber-50 px-5 py-4 text-xs leading-relaxed text-slate-600">
																钉钉开发者后台：创建企业内部应用 → 获取 ClientID / ClientSecret → 添加机器人能力并选择 Stream 模式 → 发布。无需公网回调地址。
															</div>
															<div className="rounded-2xl border border-blue-100 bg-blue-50 px-5 py-4 text-xs leading-relaxed text-slate-600">
																<div className="font-medium text-slate-700">表格/富文本渲染（AI 卡片）：默认开启，只需开权限：</div>
																<div className="mt-1">回复/推送默认走 AI 卡片（完整 GFM 渲染，表格原生支持）。只需在
																	<a href="https://open-dev.dingtalk.com/" target="_blank" rel="noreferrer" className="text-blue-600 underline">钉钉开放平台</a>
																	应用的「权限管理」中申请并发布两个权限：
																	<code className="rounded bg-white px-1 font-mono">Card.Instance.Write</code>（互动卡片实例写权限）、
																	<code className="rounded bg-white px-1 font-mono">Card.Streaming.Write</code>（AI 卡片流式更新权限）。
																	卡片发送失败会自动降级为普通 Markdown（表格转列表），不影响消息送达（失败原因见日志）。
																	如需使用自建卡片模板，再把模板 ID 填入上方输入框即可。
																</div>
															</div>
														</>
													)}
												</div>
											)}

											<div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
												<div className="flex items-center justify-between">
													<div>
														<div className="text-sm font-medium text-slate-800">IM 管理员白名单</div>
														<div className="mt-1 text-xs text-slate-400">名单内的人可在 IM 单聊中修改员工身份、增删管理员、开启受控能力（命令执行等）、创建可无人值守执行受控操作的定时任务。为空 = 未认领：首位在单聊中明确确认身份修改的人自动成为首位管理员。</div>
													</div>
												</div>
												<label className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 cursor-pointer hover:border-slate-300">
													<input type="checkbox" checked={draft.security.adminFullAccess === true} onChange={(e) => setSecurity({ adminFullAccess: e.target.checked })} className="mt-0.5 h-4 w-4 accent-blue-600" />
													<span>
														<span className="text-sm font-medium text-slate-800">管理员完全访问模式</span>
														<span className="mt-1 block text-xs text-slate-400">开启后，管理员在 IM 单聊中的管理操作（改配置、改身份、启停命令、创建自主任务等）不再需要每条消息带「确认」口令——管理员身份即授权。仅去除口令；身份、白名单、单聊校验保持不变。也可在单聊中用 manage_access 的 set_full_access 动作远程开关。</span>
													</span>
												</label>
												<div className="mt-3 space-y-2">
													{draft.security.adminStaffIds.length === 0 && (
														<div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">尚未设置管理员（未认领）。可在此预先填写，或由首位确认者远程认领。</div>
													)}
													{draft.security.adminStaffIds.map((id, idx) => (
														<div key={`${id}-${idx}`} className="flex items-center gap-2">
															<input value={id} onChange={(e) => setSecurity({ adminStaffIds: draft.security.adminStaffIds.map((v, i) => (i === idx ? e.target.value : v)) })} placeholder="钉钉 staffId" className={inputCls} />
															<button type="button" onClick={() => setSecurity({ adminStaffIds: draft.security.adminStaffIds.filter((_, i) => i !== idx) })} className="shrink-0 text-xs text-rose-400 hover:text-rose-600">删除</button>
														</div>
													))}
													<button type="button" onClick={() => setSecurity({ adminStaffIds: [...draft.security.adminStaffIds, ""] })} className="text-xs text-blue-500 hover:text-blue-600">＋ 添加管理员</button>
												</div>
											</div>

											<div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
												<div className="text-sm font-medium text-slate-800">分级权限（角色与会话门槛）</div>
												<div className="mt-1 text-xs text-slate-400">
													角色按平台验证的发送者身份判定，消息内容无法影响：viewer（对话/知识库检索/记忆沉淀）＜ operator（+浏览器/桌面/文档/文件系统/定时任务/白名单命令）＜ admin（+完整命令/系统设置/权限管理）。会话门槛只能收紧，不能超过对方自身角色；未单独指派的人使用默认角色。管理员也可在 IM 单聊里用 manage_access 远程配置（发送 /perm 可查看自己的权限）。
												</div>
												<Field label="默认角色（未单独指派的人）" hint="建议保持 viewer：未知发送者仅能对话与检索知识库。">
													<select value={draft.security.defaultRole ?? "viewer"} onChange={(e) => setSecurity({ defaultRole: e.target.value as "viewer" | "operator" | "admin" })} className={inputCls}>
														<option value="viewer">viewer — 只读</option>
														<option value="operator">operator — 可操作</option>
														<option value="admin">admin — 管理员</option>
													</select>
												</Field>
												<div className="mt-3 space-y-2">
													<div className="text-xs font-medium text-slate-600">人员角色指派</div>
													{(draft.security.people ?? []).map((p, idx) => (
														<div key={`person-${idx}`} className="flex items-center gap-2">
															<input value={p.staffId} onChange={(e) => setSecurity({ people: (draft.security.people ?? []).map((v, i) => (i === idx ? { ...v, staffId: e.target.value } : v)) })} placeholder="钉钉 staffId" className={inputCls} />
															<input value={p.name ?? ""} onChange={(e) => setSecurity({ people: (draft.security.people ?? []).map((v, i) => (i === idx ? { ...v, name: e.target.value } : v)) })} placeholder="备注名（可选）" className={inputCls + " max-w-[10rem]"} />
															<select value={p.role} onChange={(e) => setSecurity({ people: (draft.security.people ?? []).map((v, i) => (i === idx ? { ...v, role: e.target.value as "viewer" | "operator" | "admin" | "owner" } : v)) })} className={inputCls + " max-w-[9rem]"}>
																<option value="viewer">viewer</option>
																<option value="operator">operator</option>
																<option value="admin">admin</option>
															</select>
															<button type="button" onClick={() => setSecurity({ people: (draft.security.people ?? []).filter((_, i) => i !== idx) })} className="shrink-0 text-xs text-rose-400 hover:text-rose-600">删除</button>
														</div>
													))}
													<button type="button" onClick={() => setSecurity({ people: [...(draft.security.people ?? []), { staffId: "", role: "viewer" }] })} className="text-xs text-blue-500 hover:text-blue-600">＋ 添加人员角色</button>
												</div>
												<div className="mt-3 space-y-2">
													<div className="text-xs font-medium text-slate-600">会话门槛（按群/单聊收紧某项能力）</div>
													{(draft.security.conversations ?? []).map((c, ci) => (
														<div key={`conv-${ci}`} className="rounded-lg border border-slate-200 px-3 py-2">
															<div className="flex items-center gap-2">
																<input value={c.id} onChange={(e) => setSecurity({ conversations: (draft.security.conversations ?? []).map((v, i) => (i === ci ? { ...v, id: e.target.value } : v)) })} placeholder="会话 ID，如 dt:group:cidaXXX" className={inputCls} />
																<button type="button" onClick={() => setSecurity({ conversations: (draft.security.conversations ?? []).filter((_, i) => i !== ci) })} className="shrink-0 text-xs text-rose-400 hover:text-rose-600">删除</button>
															</div>
															{Object.entries(c.floors ?? {}).map(([cap, floor]) => (
																<div key={`${cap}`} className="mt-2 flex items-center gap-2">
																	<select value={cap} onChange={(e) => {
																		const floors = { ...(c.floors ?? {}) };
																		delete floors[cap];
																		floors[e.target.value] = floor;
																		setSecurity({ conversations: (draft.security.conversations ?? []).map((v, i) => (i === ci ? { ...v, floors } : v)) });
																	}} className={inputCls + " max-w-[12rem]"}>
																		{Object.entries(SECURITY_CAPABILITY_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
																	</select>
																	<select value={floor} onChange={(e) => setSecurity({ conversations: (draft.security.conversations ?? []).map((v, i) => (i === ci ? { ...v, floors: { ...(v.floors ?? {}), [cap]: e.target.value } } : v)) })} className={inputCls + " max-w-[9rem]"}>
																		<option value="operator">≥ operator</option>
																		<option value="admin">≥ admin</option>
																	</select>
																	<button type="button" onClick={() => {
																		const floors = { ...(c.floors ?? {}) };
																		delete floors[cap];
																		setSecurity({ conversations: (draft.security.conversations ?? []).map((v, i) => (i === ci ? { ...v, floors } : v)) });
																	}} className="shrink-0 text-xs text-rose-400 hover:text-rose-600">删除</button>
																</div>
															))}
															<button type="button" onClick={() => setSecurity({ conversations: (draft.security.conversations ?? []).map((v, i) => (i === ci ? { ...v, floors: { ...(v.floors ?? {}), knowledge: "operator" } } : v)) })} className="mt-2 text-xs text-blue-500 hover:text-blue-600">＋ 添加能力门槛</button>
														</div>
													))}
													<button type="button" onClick={() => setSecurity({ conversations: [...(draft.security.conversations ?? []), { id: "", floors: {} }] })} className="text-xs text-blue-500 hover:text-blue-600">＋ 添加会话门槛</button>
												</div>
											</div>
										</>
									)}

									{tab === "general" && (
										<>
											<Field label="员工名称" hint="显示在对话页，并写入员工系统提示词。"><input value={draft.identity.name} onChange={(event) => setIdentity({ name: event.target.value })} placeholder="客服小派" className={inputCls} /></Field>
										<Field label="员工类型 / 角色" hint="如「虚拟客服」「技术支持」，会写入系统提示词的身份与开场。"><input value={draft.identity.role} onChange={(event) => setIdentity({ role: event.target.value })} placeholder="虚拟客服" className={inputCls} /></Field>
										<Field label="职责描述" hint="描述这个员工负责什么，会写入系统提示词（如：在线为客户提供专业、礼貌、高效的服务）。"><textarea value={draft.identity.duty} onChange={(event) => setIdentity({ duty: event.target.value })} rows={2} placeholder="在线为客户提供专业、礼貌、高效的服务" className={inputCls + " h-auto py-2"} /></Field>
										<Field label="服务时间"><input value={draft.identity.serviceHours} onChange={(event) => setIdentity({ serviceHours: event.target.value })} placeholder="7×24h" className={inputCls} /></Field>
										<div className="rounded-2xl border border-blue-100 bg-blue-50 px-5 py-3 text-xs leading-relaxed text-slate-600">身份与提示词规则可在「<b>提示词</b>」标签页自定义；修改后保存，对<b>新对话</b>生效。管理员（白名单内的人）也可在 IM 单聊中通过对话修改身份。</div>

											<label className="flex cursor-pointer items-center justify-between rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
												<div><div className="text-sm font-medium text-slate-800">开机自动启动</div><div className="mt-1 text-xs text-slate-400">登录系统时自动启动虚拟员工。</div></div>
												<input type="checkbox" checked={draft.general.autostart} onChange={(event) => setGeneral({ autostart: event.target.checked })} className="h-5 w-5 accent-blue-500" />
											</label>

											<Field label="无人值守自动更新" hint="仅 Windows 打包版生效。完全自动=发现新版本自动下载并在空闲时重启安装；仅下载=自动下载但不自动安装，等管理员确认（适合自动安装会卡死的机器）；关闭=仅提示。管理员也可在对话中通过 manage_update 切换。">
												<select
													value={draft.general.autoUpdate === "download_only" ? "download_only" : draft.general.autoUpdate === false || draft.general.autoUpdate === "off" ? "off" : "full"}
													onChange={(event) => setGeneral({ autoUpdate: event.target.value as boolean | "full" | "download_only" | "off" })}
													className={inputCls + " cursor-pointer"}
												>
													<option value="full">完全自动（下载并自动安装）</option>
													<option value="download_only">仅下载（安装需管理员确认）</option>
													<option value="off">关闭</option>
												</select>
											</Field>

											<Field label="回复语言" hint="员工的回复语言，默认中文。仅控制回复内容，不影响界面。保存后对新对话生效。">
												<select value={draft.general.language} onChange={(e) => setGeneral({ language: e.target.value as AppConfig["general"]["language"] })} className={inputCls + " cursor-pointer"}>
													<option value="zh-CN">中文</option>
													<option value="en-US">English</option>
												</select>
											</Field>

											<Field label="单次请求超时（分钟）" hint="单次模型请求的最长等待时间。0 或留空 = 默认约 10 分钟。遇到慢速中转或复杂工具调用超时，可调大（如 20～30）。保存后立即生效。">
												<input
													type="number"
													min={0}
													value={Number.isFinite(draft.general.requestTimeoutMin) ? draft.general.requestTimeoutMin : 0}
													onChange={(e) => setGeneral({ requestTimeoutMin: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
													placeholder="0"
													className={inputCls}
												/>
											</Field>

											<Field label="长任务进度提醒（分钟）" hint="IM 会话中，某轮任务超过该时长仍未完成时，主动推送一条简短的当前进度（旁路总结，不占用对话上下文）。0 = 关闭；低于 5 按 5 生效。默认 15。">
												<input
													type="number"
													min={0}
													value={Number.isFinite(draft.general.longTaskProgressMin) ? draft.general.longTaskProgressMin : 0}
													onChange={(e) => setGeneral({ longTaskProgressMin: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
													placeholder="15"
													className={inputCls}
												/>
											</Field>

											<Field label="任务进度汇报（分钟）" hint="定时任务与自主任务（工作项）执行期间，每隔该时长推送一条当前进度（旁路总结，不占用对话上下文）。与上面的「会话进度」分开配置：任务动辄几十分钟，汇报太频是噪音。0 = 关闭；低于 5 按 5 生效。默认 30。">
												<input
													type="number"
													min={0}
													value={Number.isFinite(draft.general.taskProgressMin) ? draft.general.taskProgressMin : 30}
													onChange={(e) => setGeneral({ taskProgressMin: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
													placeholder="30"
													className={inputCls}
												/>
											</Field>

											<Field label="一次性任务会话保留天数" hint="定时任务执行、自主任务、评测跑出来的会话（列表里那些机器生成的记录）在停止更新超过该天数后自动删除，避免任务列表无限堆积。0 = 不自动清理。你与员工的 IM 对话、控制台自己的会话永不自动删除（只能手动删）。默认 30 天，保存后立即生效。">
												<input
													type="number"
													min={0}
													value={Number.isFinite(draft.general.oneOffRetentionDays) ? draft.general.oneOffRetentionDays : 30}
													onChange={(e) => setGeneral({ oneOffRetentionDays: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
													placeholder="30"
													className={inputCls}
												/>
											</Field>

											<Field label="对话记录保留天数" hint="员工对话的消息正文与执行遥测超过该天数后自动删除（会话条目保留，任务列表不受影响）。0 = 不自动清理。默认 30 天，保存后立即生效。">
												<input
													type="number"
													min={0}
													value={Number.isFinite(draft.general.messageRetentionDays) ? draft.general.messageRetentionDays : 30}
													onChange={(e) => setGeneral({ messageRetentionDays: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
													placeholder="30"
													className={inputCls}
												/>
											</Field>

											<Field label="单轮工具调用上限" hint="限制一轮对话中模型连续调用工具的最大步数，防止异常循环。达到上限后会停止调用工具，并根据已完成的操作生成结果总结。0 = 不限制。保存后立即生效。">
												<input
													type="number"
													min={0}
													value={Number.isFinite(draft.general.maxToolSteps) ? draft.general.maxToolSteps : 0}
													onChange={(e) => setGeneral({ maxToolSteps: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
													placeholder="0"
													className={inputCls}
												/>
											</Field>

											<ComputerSection value={draft.computer} saved={config?.computer ?? draft.computer} onChange={(computer) => setDraft(value => value ? { ...value, computer } : value)} />

											<div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
												<div className="mb-3">
													<div className="text-sm font-medium text-slate-800">Computer Use · 浏览器自动化</div>
													<div className="mt-1 text-xs text-slate-400">开启后员工可用内置浏览器执行网页操作（打开/读取/截图/点击/输入）。需先安装浏览器内核：<code className="rounded bg-slate-100 px-1">npx playwright install chromium</code>。保存后新对话生效。</div>
												</div>
												<div className="space-y-3">
													<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
														<div><div className="text-sm font-medium text-slate-800">启用浏览器自动化</div><div className="mt-0.5 text-xs text-slate-400">为员工注入浏览器工具。</div></div>
														<input type="checkbox" checked={draft.browser.enabled} onChange={(e) => setBrowser({ enabled: e.target.checked })} className="h-5 w-5 accent-blue-500" />
													</label>
													<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
														<div><div className="text-sm font-medium text-slate-800">无头模式</div><div className="mt-0.5 text-xs text-slate-400">后台运行浏览器（不弹窗）。关闭可看到浏览器窗口，便于调试。</div></div>
														<input type="checkbox" checked={draft.browser.headless} onChange={(e) => setBrowser({ headless: e.target.checked })} className="h-5 w-5 accent-blue-500" />
													</label>
													<Field label="允许访问的域名（每行一个，留空 = 不限制）" hint="出于安全，建议限制员工只能访问受信域名（如 order.example.com）。支持子域匹配。">
														<textarea value={domainsText} onChange={(e) => { setDomainsText(e.target.value); setBrowser({ allowedDomains: e.target.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) }); }} rows={3} placeholder={"order.example.com\nhelp.example.com"} className={inputCls + " h-auto py-2 font-mono"} />
													</Field>
													<Field label="浏览器内核下载源" hint="安装 Chromium 内核的下载源（playwright 会自动在后面拼 /builds/chromium/…/chromium-win64.zip）。留空 = 自动（国内默认走 npmmirror 镜像，海外走官方）。默认镜像：https://registry.npmmirror.com/-/binary/playwright ——如该镜像不可达可改其它，或填官方 https://playwright.azureedge.net。">
														<input
															type="text"
															value={draft.browser.downloadHost}
															onChange={(e) => setBrowser({ downloadHost: e.target.value.trim() })}
															placeholder="留空 = 自动（国内默认镜像）"
															className={inputCls + " font-mono"}
														/>
													</Field>
												</div>
											</div>

											<div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
												<div className="mb-3">
													<div className="text-sm font-medium text-slate-800">本地文件访问</div>
													<div className="mt-1 text-xs text-slate-400">开启后员工可列举白名单目录内的文件（只读）。删除受两步授权限制：员工须先列清单、你明确同意后才会执行。保存后新对话生效。</div>
												</div>
												<div className="space-y-3">
													<label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3">
														<div><div className="text-sm font-medium text-slate-800">启用文件访问</div><div className="mt-0.5 text-xs text-slate-400">为员工注入 list_directory / delete_files 工具（删除需你明确授权）。</div></div>
														<input type="checkbox" checked={draft.filesystem.enabled} onChange={(e) => setFilesystem({ enabled: e.target.checked })} className="h-5 w-5 accent-blue-500" />
													</label>
													<Field label="允许访问的目录" hint="仅这些目录内可列举/删除文件；白名单外一律拒绝。支持 ~（如 ~/Downloads）。">
														<div className="space-y-2">
															{draft.filesystem.allowedDirs.map((dir, i) => (
																<div key={i} className="flex items-center gap-2">
																	<input value={dir} onChange={(e) => { const next = [...draft.filesystem.allowedDirs]; next[i] = e.target.value; setFilesystem({ allowedDirs: next }); }} className={inputCls + " font-mono"} />
																	<button type="button" onClick={() => setFilesystem({ allowedDirs: draft.filesystem.allowedDirs.filter((_, j) => j !== i) })} className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-500">移除</button>
																</div>
															))}
															<button type="button" onClick={async () => { const picked = await api.pickDirectory(); if (picked) setFilesystem({ allowedDirs: [...draft.filesystem.allowedDirs, picked] }); }} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50">+ 添加目录…</button>
														</div>
													</Field>
												</div>
											</div>

											<div className="rounded-2xl border border-amber-200 bg-white px-5 py-4 shadow-sm">
												<div className="mb-3">
													<div className="text-sm font-medium text-slate-800">受限命令执行 · run_command</div>
													<div className="mt-1 text-xs leading-relaxed text-slate-400">用于无桌面服务器的进程查看/按 PID 结束、系统与网络诊断等运维任务。默认关闭；每次执行仍须 IM 单聊中的白名单管理员在当前消息明确「确认」。</div>
												</div>
												<div className="space-y-3">
													<label className="flex cursor-pointer items-center justify-between rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-3">
														<div><div className="text-sm font-medium text-slate-800">启用受限命令执行</div><div className="mt-0.5 text-xs text-amber-700/70">开启后为员工提供 run_command；命令以当前应用用户权限运行，不会自动提权。</div></div>
														<input type="checkbox" checked={draft.capabilities.shell.enabled} onChange={(e) => setShell({ enabled: e.target.checked })} className="h-5 w-5 accent-amber-500" />
													</label>
													{SHELL_TIMEOUT_FIELDS.map((field) => <Field key={field.key} label={field.label} hint={field.hint}>
														<input
															type="number"
															min={0}
															max={MAX_TIMEOUT_SEC}
															step={1}
															value={draft.capabilities.shell[field.key]}
															onChange={(e) => setShell({ [field.key]: normalizeTimeoutSec(e.target.valueAsNumber, field.fallback) })}
															className={inputCls}
														/>
													</Field>)}
													<Field label="允许执行的命令（每行一个）" hint="只匹配可执行文件名，不含参数；默认仅含进程/系统/网络诊断命令。留空 = 全部拒绝。powershell、node、npx 属任意代码执行解释器，只有明确需要时才添加；填写 * = 允许任意可执行文件，强烈不建议。">
														<textarea
															value={shellCommandsText}
															onChange={(e) => {
																setShellCommandsText(e.target.value);
																setShell({ allowedCommands: e.target.value.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean) });
															}}
															rows={4}
															placeholder={"tasklist\ntaskkill\nsysteminfo\nipconfig"}
															className={inputCls + " h-auto py-2 font-mono"}
														/>
													</Field>
												</div>
											</div>

											<div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
												<div className="mb-3">
													<div className="text-sm font-medium text-slate-800">自主任务挖掘</div>
													<div className="mt-1 text-xs leading-relaxed text-slate-400">定期阅读各会话的新消息（严格单会话来源、只读），把值得主动跟进的工作整理成提案，推回原会话等你确认——不会自动创建或执行任何任务。默认开启。</div>
												</div>
												<div className="space-y-3">
													<label className="flex cursor-pointer items-center justify-between rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-3">
														<div><div className="text-sm font-medium text-slate-800">启用自主任务挖掘</div><div className="mt-0.5 text-xs text-amber-700/70">开启后按下方间隔在后台提炼提案；驳回过的提案进入冷却，之后对话中再次多次提到才会重新提出。</div></div>
														<input type="checkbox" checked={draft.capabilities.autonomousMining.enabled} onChange={(e) => setDraft((v) => v ? { ...v, capabilities: { ...v.capabilities, autonomousMining: { ...v.capabilities.autonomousMining, enabled: e.target.checked } } } : v)} className="h-5 w-5 accent-amber-500" />
													</label>
													<Field label="挖掘间隔（小时）" hint="两次后台提炼的最小间隔（1–24）。提案会推回各自来源会话，由该会话的管理员确认。">
														<input
															type="number"
															min={1}
															max={24}
															value={draft.capabilities.autonomousMining.intervalHours}
															onChange={(e) => setDraft((v) => v ? { ...v, capabilities: { ...v.capabilities, autonomousMining: { ...v.capabilities.autonomousMining, intervalHours: Math.min(24, Math.max(1, Math.floor(Number(e.target.valueAsNumber) || 1))) } } } : v)}
															className={inputCls}
														/>
													</Field>
													<div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500">
														{!miningStatus ? "正在读取挖掘状态…" : (
															<>
																<div>上次轮询：{miningStatus.lastTickAt ? new Date(Number(miningStatus.lastTickAt)).toLocaleString() : "尚未轮询（每小时检查一次，与开关无关）"}</div>
																<div>上次实际挖掘：{miningStatus.lastRunAt ? new Date(Number(miningStatus.lastRunAt)).toLocaleString() : "还没有运行过"}</div>
																{miningStatus.pendingProposals != null && miningStatus.pendingProposals > 0 && (
																	<div>待你确认的提案：{miningStatus.pendingProposals} 条</div>
																)}
																{miningStatus.lastRunAt && (
																	<div>上次挖掘：扫描会话 {miningStatus.lastMiningScanned ?? "?"} 个 · 产出提案 {miningStatus.lastMiningProposals ?? "?"} 条</div>
																)}
																{miningStatus.lastMiningError && <div className="text-red-600">上次出错：{miningStatus.lastMiningError}</div>}
																{miningStatus.enabled === false && <div className="text-amber-700/80">当前处于关闭状态（出厂默认开启）——关闭期间不会产出任何提案。</div>}
															</>
														)}
													</div>
												</div>
											</div>

											<div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
												<div className="text-sm font-medium text-slate-800">助理小组件（嵌入业务系统）</div>
												<div className="mt-1 text-xs leading-relaxed text-slate-400">
													把本员工作为一个浮窗 AI 助理嵌入到自己的管理后台：业务系统引入一段 script 即可在右下角出现对话浮窗。接入需要两道凭据——访问令牌（请求门禁）与接入密钥（业务后端换取会话票据），票据绑定来源地址；业务方声明的用户角色最高到 admin（owner 永远不可达），回复内容经过与 IM 群相同的敏感凭据拦截。
												</div>
												<div className="mt-3 space-y-3">
													<label className="flex cursor-pointer items-center justify-between rounded-xl border border-indigo-200 bg-indigo-50/50 px-4 py-3">
														<div><div className="text-sm font-medium text-slate-800">启用小组件服务</div><div className="mt-0.5 text-xs text-indigo-700/70">开启后按下方端口提供嵌入脚本与对话接口（启用/停用或改端口后需重启应用生效）。</div></div>
														<input type="checkbox" checked={draft.widget.enabled} onChange={(e) => setWidget({ enabled: e.target.checked })} className="h-5 w-5 accent-indigo-500" />
													</label>
													<div className="grid grid-cols-2 gap-3">
														<Field label="端口" hint="业务系统访问的固定端口，默认 17880。同机多 profile（如 Nova/Orion）各自需要不同端口——启动时会自动避开被占用的端口并记住；也可点「自动分配」立即选一个空闲端口。">
															<div className="flex gap-2">
																<input type="number" min={1} max={65535}
																	value={draft.widget.port}
																	onChange={(e) => setWidget({ port: Math.min(65535, Math.max(1, Math.floor(Number(e.target.valueAsNumber) || 17880))) })}
																	className={inputCls} />
																<button type="button"
																	disabled={widgetBusy}
																	onClick={async () => {
																		setWidgetBusy(true);
																		try {
																			const r = await api.allocateWidgetPort();
																			setWidget({ port: r.port });
																		} finally { setWidgetBusy(false); }
																	}}
																	className="shrink-0 rounded-xl border border-slate-200 px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
																	{widgetBusy ? "…" : "自动分配"}
																</button>
															</div>
														</Field>
														<Field label="暴露范围" hint="仅本机=只接受 127.0.0.1（适合同机反代）；局域网=绑定 0.0.0.0 供其它机器访问，必须设置访问令牌，且需在服务器防火墙放行该端口（Windows 首次监听会弹防火墙授权）。">
															<select value={draft.widget.expose} onChange={(e) => setWidget({ expose: e.target.value === "lan" ? "lan" : "loopback" })} className={inputCls}>
																<option value="loopback">仅本机（127.0.0.1）</option>
																<option value="lan">局域网（0.0.0.0）</option>
															</select>
														</Field>
													</div>
													<Field label="访问令牌" hint="业务系统嵌入时携带的 Bearer 令牌。局域网模式下必填；泄露或人员变动时点「重新生成」轮换即可（旧令牌立即失效）。">
														<div className="flex gap-2">
															<input value={draft.widget.token} onChange={(e) => setWidget({ token: e.target.value })} placeholder="留空并启用局域网模式将无法启动" className={inputCls + " font-mono"} />
															<button type="button"
																onClick={() => { const b = new Uint8Array(24); crypto.getRandomValues(b); setWidget({ token: Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("") }); }}
																className="shrink-0 rounded-lg border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-50">重新生成</button>
														</div>
													</Field>
													<Field label="接入密钥（仅业务系统后端持有）" hint="业务系统后端用它调用 POST /api/widget/session 换取会话票据。此密钥绝不能写进前端页面——拿到它就能签发任意角色的票据。留空则换票接口关闭，小组件将无法对话。">
														<div className="flex gap-2">
															<input value={draft.widget.secret} onChange={(e) => setWidget({ secret: e.target.value })} placeholder="留空则不接受换票" className={inputCls + " font-mono"} />
															<button type="button"
																onClick={() => { const b = new Uint8Array(24); crypto.getRandomValues(b); setWidget({ secret: Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("") }); }}
																className="shrink-0 rounded-lg border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-50">重新生成</button>
														</div>
													</Field>
													<div className="grid grid-cols-2 gap-3">
														<Field label="浮钮图标" hint="右下角入口的外观。默认「文字 AI」保持原有接入方不变；robot/spark 是内置矢量图标，无需外部图片域名，也不受业务页面 CSP 影响。">
															<select value={draft.widget.launcherIcon} onChange={(e) => setWidget({ launcherIcon: (["text", "robot", "spark", "url"] as const).includes(e.target.value as never) ? (e.target.value as "text" | "robot" | "spark" | "url") : "text" })} className={inputCls}>
																<option value="text">文字「AI」（默认，兼容现状）</option>
																<option value="robot">机器人（内置 SVG）</option>
																<option value="spark">星火 AI（内置 SVG）</option>
																<option value="url">自定义图片地址</option>
															</select>
														</Field>
														<Field label="浮钮尺寸（像素）" hint="建议 48–56：管理后台右侧通常已有其它浮动入口，过大会互相遮挡。范围 44–72。">
															<input type="number" min={44} max={72}
																value={draft.widget.launcherSize}
																onChange={(e) => setWidget({ launcherSize: Math.min(72, Math.max(44, Math.floor(Number(e.target.valueAsNumber) || 52))) })}
																className={inputCls} />
														</Field>
													</div>
													{draft.widget.launcherIcon === "url" && (
														<Field label="图标图片地址" hint="仅支持 http/https。图片由业务页面加载，其域名需在业务系统自己的 CSP img-src 白名单内；加载失败会自动回退成「AI」文字，不会留空白圆。">
															<input value={draft.widget.launcherIconUrl} onChange={(e) => setWidget({ launcherIconUrl: e.target.value })} placeholder="https://your-system.example.com/avatar.png" className={inputCls + " font-mono"} />
														</Field>
													)}
													<Field label="允许最高角色" hint="业务系统声明的角色会被限制在此范围内。admin 可管理配置与任务（含 shell/settings 等管理工具）；owner 是部署者专属，任何情况下都不会授予小组件。注意：票据声明的角色是小组件会话的最终权限，不受「默认角色」影响。">
														<select value={draft.widget.maxRole} onChange={(e) => setWidget({ maxRole: e.target.value === "viewer" ? "viewer" : e.target.value === "operator" ? "operator" : "admin" })} className={inputCls}>
															<option value="viewer">viewer（仅对话与检索）</option>
															<option value="operator">operator（可用浏览器/命令）</option>
															<option value="admin">admin（可改配置与管理任务）</option>
														</select>
													</Field>
													<Field label="信任的反向代理（每行一个，留空 = 不信任）" hint="部署在 nginx 等代理后面时，所有请求都来自 127.0.0.1，来源绑定会失效。把代理地址填进来（如 127.0.0.1），来自它的请求才采用 X-Forwarded-For 作为真实客户端地址；其它来源伪造该头会被忽略。">
														<textarea rows={2} value={draft.widget.trustedProxies.join("\n")}
															onChange={(e) => setWidget({ trustedProxies: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
															className={inputCls + " h-auto py-2 font-mono text-xs"} />
													</Field>
													<div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500">
														<div className="font-medium text-slate-700">接入方需要实现的一步（换票）</div>
														<div className="mt-1">业务系统后端调用一次，把返回的 ticket 传给前端页面：</div>
														<pre className="mt-1 overflow-x-auto rounded-md bg-white p-2 font-mono text-[11px] text-slate-600">{`POST http://<VE地址>:${draft.widget.port}/api/widget/session
Authorization: Bearer <访问令牌>
X-VE-Secret: <接入密钥>
{ "user": "zhangsan", "role": "admin",
  "origin": "https://oa.example.com",
  "clientIp": "10.0.0.9" }

→ { "ticket": "...", "role": "admin", "expiresIn": 300 }`}</pre>
														<div className="mt-1">user 请传业务系统里稳定的 ASCII 标识（工号/用户 id）；含中文或特殊字符会被清洗成 <code className="font-mono">anon</code>，导致不同用户共享同一会话。</div>
														<div className="mt-1"><b>origin / clientIp 声明「这张票将交给谁用」</b>——换票是后端发起的，对话是浏览器发起的，两者地址天然不同。省略 clientIp 则只按 Origin 绑定（较弱）；声明了 clientIp 就钉死到该地址，票据被拷走也用不了。</div>
														<div className="mt-1">前端只携带 ticket（<code className="font-mono">data-ticket</code>），永远不接触接入密钥。票据 5 分钟有效。</div>
													</div>
													<div className="grid grid-cols-2 gap-3">
														<Field label="浮窗标题" hint="显示在小组件头部与欢迎语中，如「业务助理」。">
															<input value={draft.widget.title} onChange={(e) => setWidget({ title: e.target.value })} className={inputCls} />
														</Field>
														<Field label="底部声明" hint="展示在小组件输入框下方的免责声明。">
															<input value={draft.widget.disclaimer} onChange={(e) => setWidget({ disclaimer: e.target.value })} className={inputCls} />
														</Field>
													</div>
													<Field label="建议问题（每行一个）" hint="展示在欢迎语下方，点击即发送。留空则不显示。">
														<textarea rows={3} value={draft.widget.suggestions.join("\n")}
															onChange={(e) => setWidget({ suggestions: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
															className={inputCls + " h-auto py-2 font-mono text-xs"} />
													</Field>
													<Field label="允许的来源（每行一个，留空 = 不限制）" hint="局域网模式下建议填业务系统的访问地址（如 https://oa.example.com）；配置后其它来源的浏览器请求会被拒绝。">
														<textarea rows={2} value={draft.widget.allowedOrigins.join("\n")}
															onChange={(e) => setWidget({ allowedOrigins: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
															className={inputCls + " h-auto py-2 font-mono text-xs"} />
													</Field>
													{draft.widget.enabled && widgetStatus && (
														<div className={`rounded-xl px-4 py-3 text-xs leading-relaxed ${widgetStatus.error ? "bg-rose-50 text-rose-700" : widgetStatus.running ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
															{widgetStatus.starting && !widgetStatus.running ? (
																<>
																	<span className="font-medium">正在启动…</span>探测并绑定端口，稍后自动刷新。
																</>
															) : widgetStatus.running ? (
																<>
																	<span className="font-medium">服务运行中</span>：{draft.widget.expose === "lan" ? "0.0.0.0" : "127.0.0.1"}:{widgetStatus.port}
																	{widgetStatus.reassignedFrom ? `（原端口 ${widgetStatus.reassignedFrom} 被占用，已自动改用 ${widgetStatus.port} 并记住）` : ""}
																</>
															) : widgetStatus.error ? (
																<>
																	<span className="font-medium">服务未启动</span>：{widgetStatus.error}
																	{/\.(重新|换一个)|占用/.test(widgetStatus.error) ? "（点上方「自动分配」换一个空闲端口后保存并重启）" : ""}
																</>
															) : (
																<>
																	<span className="font-medium">服务未启动</span>：当前配置尚未生效，保存并重启应用后开始监听 {draft.widget.port}。
																</>
															)}
														</div>
													)}
													{draft.widget.enabled && (
														<div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500">
															<div className="font-medium text-slate-700">接入方式（重启应用后生效）</div>
															<div className="mt-1">整页嵌入：<code className="font-mono">{`http://<本机地址>:${draft.widget.port}/widget#token=${draft.widget.token ? "***" : "<令牌>"}&user=<用户标识>`}</code>（令牌放 # 号后，不会进服务器日志；整页链接含令牌，勿外发）</div>
															<div>浮窗嵌入：在业务系统页面加入 <code className="font-mono">{`<script src="http://<本机地址>:${draft.widget.port}/widget.js" data-token="..." data-user="..."></script>`}</code></div>
															<div className="mt-1 text-amber-700/80">安全边界：小组件用户固定为最低权限（仅对话与知识检索），不受「默认角色」设置影响；请勿在人员管理里创建 widget-user- 开头的员工，以免与小组件身份冲突。</div>
														</div>
													)}
												</div>
											</div>

											{(() => {
												const u = updater.state;
												const busy = u?.phase === "checking" || u?.phase === "downloading";
												return (
													<div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
														<div className="flex items-center justify-between gap-3">
															<div className="min-w-0">
																<div className="flex items-center gap-2 text-sm font-medium text-slate-800">
																	软件更新
																	{u && (
																		<span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">
																			v{u.currentVersion}
																		</span>
																	)}
																</div>
																<div className="mt-1 text-xs text-slate-400">
																	{u?.phase === "checking" && "正在检查更新…"}
																	{u?.phase === "idle" && "当前版本为最新版本。"}
																	{u?.phase === "none" && "已是最新版本。"}
																	{u?.phase === "available" && (
																		<>
																			发现新版本 <span className="font-medium text-slate-600">v{u.version}</span>
																		</>
																	)}
																	{u?.phase === "available" && u.releaseNotes && (
																		<span className="mt-0.5 block whitespace-pre-wrap text-slate-500">{u.releaseNotes}</span>
																	)}
																	{u?.phase === "downloading" && `正在下载 v${u.version}… ${u.percent}%`}
																	{u?.phase === "ready" && `v${u.version} 已下载完成，点击右侧按钮安装。`}
																	{u?.phase === "error" && <span className="text-rose-500">更新失败：{u.message}</span>}
																</div>
															</div>
															<div className="flex shrink-0 items-center gap-2">
																{u?.phase === "available" && (
																	<>
																		<a href={u.manualUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-slate-200 px-4 py-2 text-xs text-slate-500 transition hover:bg-slate-50" title="自动下载失败时的手动下载链接">
																			手动下载
																		</a>
																		<button type="button" onClick={() => updater.download()} className="rounded-xl bg-[#1d1d1f] px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-[#3f3f43]">
																			下载更新
																		</button>
																	</>
																)}
																{u?.phase === "downloading" && (
																	<button type="button" disabled className="rounded-xl bg-[#1d1d1f]/60 px-5 py-2 text-sm font-medium text-white shadow-sm">
																		下载中 {u.percent}%
																	</button>
																)}
																{u?.phase === "ready" && (
																	<button type="button" onClick={() => updater.install()} className="rounded-xl bg-emerald-500 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-600">
																		重启并安装
																	</button>
																)}
																{u && u.phase !== "ready" && u.phase !== "downloading" && u.phase !== "available" && (
																	<button type="button" onClick={() => updater.check()} disabled={busy} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
																		{u.phase === "checking" ? "检查中…" : "检查更新"}
																	</button>
																)}
															</div>
														</div>
													</div>
												);
											})()}
										</>
									)}
								</div>
							</div>
						)}
					</div>

					<footer className="flex h-[76px] shrink-0 items-center justify-end gap-3 border-t border-slate-200 bg-white px-8">
						{error && <span className="mr-auto max-w-lg truncate text-xs text-rose-500">{error}</span>}
						<button type="button" onClick={cancel} disabled={saving} className="rounded-xl border border-black/[0.08] bg-white px-6 py-2.5 text-sm font-medium text-[#1d1d1f] shadow-sm hover:bg-black/[0.045] disabled:opacity-50">取消</button>
						<button type="button" onClick={() => void save()} disabled={saving || !draft} className="rounded-xl bg-[#1d1d1f] px-7 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-[#3f3f43] disabled:opacity-50">{saving ? "保存中..." : "保存"}</button>
					</footer>
				</div>
			</div>
		</div>
	);
}
