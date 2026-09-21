import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import type { AppConfig, ImChannelConfig, IMChannel, ScheduledTaskRow, UpdateState } from "../lib/types";
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

export function SettingsPage({ config, onChange, updater, onClose }: SettingsPageProps) {
	const [tab, setTab] = useState<Tab>("model");
	const [contentTab, setContentTab] = useState<ContentTab>("resources");
	const [draft, setDraft] = useState<AppConfig | null>(config);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [channelTypes, setChannelTypes] = useState<string[]>(["echo", "dingtalk"]);
	const [selectedChId, setSelectedChId] = useState<string | null>(null);
	const [promptPreview, setPromptPreview] = useState<string | null>(null);
	const [schedTasks, setSchedTasks] = useState<ScheduledTaskRow[]>([]);
	const refreshSched = () => api.listScheduledTasks().then(setSchedTasks).catch(() => {});
	useEffect(() => {
		if (tab === "tasks") void refreshSched();
	}, [tab]);
	// Raw text for the allowed-domains editor — kept separate from the parsed
	// array so the textarea can retain newlines while typing (a derived value
	// would strip the trailing empty line and "eat" the Enter key).
	const [domainsText, setDomainsText] = useState((config?.browser.allowedDomains ?? []).join("\n"));
	const [shellCommandsText, setShellCommandsText] = useState((config?.capabilities.shell.allowedCommands ?? []).join("\n"));
	useEffect(() => {
		setDomainsText((config?.browser.allowedDomains ?? []).join("\n"));
		setShellCommandsText((config?.capabilities.shell.allowedCommands ?? []).join("\n"));
	}, [config]);

	useEffect(() => setDraft(config), [config]);
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
							<h1 className="text-2xl font-semibold tracking-tight text-[#1d1d1f]">{tab === "model" ? "自定义模型" : tab === "knowledge" ? "知识库" : tab === "content" ? "内容中心" : tab === "skills" ? "技能" : tab === "im" ? "IM 机器人" : tab === "prompt" ? "提示词" : tab === "tasks" ? "定时任务" : tab === "migrate" ? "迁移与复制" : "通用"}</h1>
							{tab !== "model" && <p className="mt-1 text-xs text-[#a1a1a6]">{tab === "knowledge" ? "可配置、可插拔的知识库：内置混合检索 + 外接 RAG。" : tab === "content" ? "交付资料库（既有可复用资料）与任务产物（生成的带版本输出）统一在此管理。" : tab === "skills" ? "管理内置与导入的技能（SKILL.md），启停、导入、删除。技能以声明式指令注入提示词。" : tab === "im" ? "连接即时通讯渠道，让虚拟员工随时响应。" : tab === "prompt" ? "自定义员工的内置行为规则与追加指令，保存后新对话生效。" : tab === "tasks" ? "在对话中创建定时任务，系统到点自动执行；此处可查看与管理。" : tab === "migrate" ? "把当前员工打包导出（.pve），或导入员工包：克隆为新员工 / 覆盖当前员工，支持跨机器迁移。" : "管理员工身份与系统行为。"}</p>}
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
														<label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
															启用
															<input type="checkbox" checked={t.enabled === 1} onChange={(e) => { void api.toggleScheduledTask(t.id, e.target.checked).then(refreshSched); }} className="h-4 w-4 accent-blue-500" />
														</label>
														<button type="button" onClick={() => void api.deleteScheduledTask(t.id).then(refreshSched)} className="text-xs text-rose-400 hover:text-rose-600">删除</button>
													</div>
													<div className="mt-1 text-xs text-slate-500">cron <code className="rounded bg-slate-100 px-1">{t.cron}</code> · 下次 {t.next_run_at ? new Date(t.next_run_at).toLocaleString("zh-CN", { hour12: false }) : "—"} · 上次 {t.last_run_at ? new Date(t.last_run_at).toLocaleString("zh-CN", { hour12: false }) : "—"}{t.last_status ? ` · ${t.last_status}` : ""}</div>
													<div className="mt-1 line-clamp-2 text-xs text-slate-400">{t.prompt}</div>
												</div>
											))}
										</div>
									</section>
								</div>
							</div>
						) : (
							<div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-10 py-8">
								<div className="mx-auto max-w-2xl space-y-5">
									{tab === "im" && (
										<>
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
															<select value={p.role} onChange={(e) => setSecurity({ people: (draft.security.people ?? []).map((v, i) => (i === idx ? { ...v, role: e.target.value as "viewer" | "operator" | "admin" } : v)) })} className={inputCls + " max-w-[9rem]"}>
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

											<Field label="长任务进度提醒（分钟）" hint="IM 会话中，某轮任务超过该时长仍未完成时，主动在群里发一条简短的当前进度。0 = 关闭。默认 30。">
												<input
													type="number"
													min={0}
													value={Number.isFinite(draft.general.longTaskProgressMin) ? draft.general.longTaskProgressMin : 0}
													onChange={(e) => setGeneral({ longTaskProgressMin: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
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
