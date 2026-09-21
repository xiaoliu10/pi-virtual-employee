import type { ConversationRow, UpdateState } from "../lib/types";

interface SidebarProps {
	view: "chat" | "settings";
	conversations: ConversationRow[];
	activeId: string | null;
	/** Updater state (single subscription owned by App). Only surfaces a badge when there's news. */
	update: {
		state: UpdateState | null;
		check: () => void;
		download: () => void;
		install: () => void;
	};
	modelLabel: string;
	onNavigate: (view: "chat" | "settings") => void;
	onSelect: (id: string) => void;
	onNewChat: () => void;
	onDelete: (id: string) => void;
}

function timeAgo(ts: number): string {
	const diff = Date.now() - ts;
	const m = Math.floor(diff / 60000);
	if (m < 1) return "刚刚";
	if (m < 60) return `${m} 分钟前`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} 小时前`;
	return `${Math.floor(h / 24)} 天前`;
}

function GearIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
			<circle cx="12" cy="12" r="3.2" />
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"
			/>
		</svg>
	);
}

export function Sidebar(props: SidebarProps) {
	const { view, conversations, activeId, modelLabel, update } = props;
	const settingsActive = view === "settings";
	// Badge only when there's actionable news; everything else (idle/none/
	// checking…) stays quiet to avoid nagging on every 6h recheck.
	const updateVersion = update.state?.phase === "available" || update.state?.phase === "downloading"
		? update.state.version
		: update.state?.phase === "ready"
			? update.state.version
			: undefined;

	return (
		<aside className="titlebar-drag flex w-72 shrink-0 flex-col bg-[#191c22] text-[#c3cad6] border-r border-[#30343c]">
			{/* Brand — pi-desktop style: serif π mark + name stack */}
			<div className="flex items-center gap-3 px-5 pb-4 pt-6">
				<div className="select-none font-serif text-[30px] leading-none text-slate-100">π</div>
				<div>
					<div className="text-[15px] font-semibold leading-tight text-white">虚拟员工</div>
					<div className="text-xs text-slate-400">Virtual Employee</div>
				</div>
			</div>

			{/* New chat */}
			<div className="titlebar-nodrag px-4">
				<button
					onClick={props.onNewChat}
					className="flex w-full items-center justify-center gap-2 rounded-lg bg-ink-700 px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ink-600 active:bg-ink-700"
				>
					<span className="text-base leading-none">＋</span> 新建对话
				</button>
			</div>

			{/* Conversation / task list */}
			<div className="titlebar-nodrag mt-4 flex min-h-0 flex-1 flex-col px-2">
				<div className="px-3 pb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
					任务 · {conversations.length}
				</div>
				<div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
					{conversations.length === 0 && (
						<p className="px-3 py-6 text-center text-xs text-slate-500">
							还没有任务,发起一次对话即可创建。
						</p>
					)}
					{conversations.map((c) => {
						const active = !settingsActive && c.id === activeId;
						return (
							<div
								key={c.id}
								onClick={() => props.onSelect(c.id)}
								className={`group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
									active ? "bg-ink-700" : "hover:bg-ink-800"
								}`}
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5">
										<span className="truncate text-sm text-[#dde2ea]">{c.title ?? "新对话"}</span>
										{c.origin === "im" && (
											<span className="shrink-0 rounded bg-ink-700 px-1 py-px text-[9px] font-medium text-sky-300" title="来自 IM 渠道，只读">
												IM
											</span>
										)}
									</div>
									<div className="text-[11px] text-slate-500">{timeAgo(c.updated_at)}</div>
								</div>
								<button
									onClick={(e) => {
										e.stopPropagation();
										props.onDelete(c.id);
									}}
									className="hidden shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-ink-600 hover:text-slate-200 group-hover:block"
									title="删除任务"
								>
									✕
								</button>
							</div>
						);
					})}
				</div>
			</div>

			{/* Bottom-left: model status + settings */}
			<div className="titlebar-nodrag border-t border-ink-700 p-3">
				<div className="mb-2 flex items-center gap-2 px-2 text-xs text-slate-400">
					<span className="h-2 w-2 rounded-full bg-emerald-400" />
					<span className="truncate font-mono" title={modelLabel}>{modelLabel}</span>
				</div>
				{updateVersion && (
					<button
						onClick={() => props.onNavigate("settings")}
						className="mb-2 flex w-full items-center gap-2 rounded-lg bg-ink-800 px-2 py-1.5 text-xs transition-colors hover:bg-ink-700"
						title="前往设置页处理更新"
					>
						<span
							className={`h-2 w-2 shrink-0 rounded-full ${
								update.state?.phase === "ready" ? "bg-emerald-400" : "bg-amber-400"
							} animate-pulse`}
						/>
						<span className={update.state?.phase === "ready" ? "text-emerald-300" : "text-amber-300"}>
							{update.state?.phase === "ready" ? `新版本 v${updateVersion} 待安装` : `发现新版本 v${updateVersion}`}
						</span>
					</button>
				)}
				<button
					onClick={() => props.onNavigate(settingsActive ? "chat" : "settings")}
					className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors ${
						settingsActive
							? "bg-ink-700 text-white"
							: "text-[#8b93a1] hover:bg-ink-800 hover:text-white"
					}`}
				>
					<GearIcon className="h-[18px] w-[18px]" />
					设置
				</button>
			</div>
		</aside>
	);
}
