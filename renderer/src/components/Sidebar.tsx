import { useState } from "react";
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

/** pi-desktop replica sidebar layout: action rows on top, tiny group labels,
 * 37px session rows (time + actions only on hover), icon-only footer with the
 * version label pinned right. */
export function Sidebar(props: SidebarProps) {
	const { view, conversations, activeId, modelLabel, update } = props;
	const settingsActive = view === "settings";
	const [search, setSearch] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	// Badge only when there's actionable news; everything else (idle/none/
	// checking…) stays quiet to avoid nagging on every 6h recheck.
	const updateVersion = update.state?.phase === "available" || update.state?.phase === "downloading"
		? update.state.version
		: update.state?.phase === "ready"
			? update.state.version
			: undefined;
	const needle = search.trim().toLowerCase();
	const filtered = needle
		? conversations.filter((c) => (c.title ?? "").toLowerCase().includes(needle))
		: conversations;

	return (
		<aside className="titlebar-drag flex w-[366px] shrink-0 flex-col bg-[#f6f6f7]">
			{/* Brand — pi-desktop style: serif π mark + name stack */}
			<div className="flex items-center gap-3 px-5 pb-2 pt-7">
				<div className="select-none font-serif text-[30px] leading-none text-[#1d1d1f]">π</div>
				<div>
					<div className="text-[15px] font-semibold leading-tight text-[#1d1d1f]">虚拟员工</div>
					<div className="text-xs text-[#a1a1a6]">Virtual Employee</div>
				</div>
			</div>

			{/* Primary actions — flat rows (pi-sidebar__action) */}
			<nav className="mx-2.5 mb-2 mt-2.5 flex shrink-0 flex-col gap-0.5">
				<button
					onClick={props.onNewChat}
					className="titlebar-nodrag flex min-h-[36px] w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[13px] text-[#1d1d1f] transition-colors hover:bg-black/[0.045]"
				>
					<span className="text-base leading-none text-[#6e6e73]">＋</span>
					<span className="flex-1">新建对话</span>
				</button>
				<button
					onClick={() => setSearchOpen((v) => !v)}
					aria-expanded={searchOpen}
					className={`titlebar-nodrag flex min-h-[36px] w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[13px] transition-colors ${
						searchOpen ? "bg-black/[0.075] text-[#1d1d1f]" : "text-[#1d1d1f] hover:bg-black/[0.045]"
					}`}
				>
					<span className="text-sm leading-none text-[#6e6e73]">⌕</span>
					<span className="flex-1">搜索任务</span>
				</button>
			</nav>

			{/* Task list */}
			<div className="titlebar-nodrag flex min-h-0 flex-1 flex-col">
				{searchOpen && (
					<div className="px-4 pb-1">
						<input
							autoFocus
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="按标题筛选…"
							className="w-full rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-[13px] outline-none placeholder:text-[#a1a1a6] focus:border-black/[0.2]"
						/>
					</div>
				)}
				<div className="px-[22px] pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#a1a1a6]">
					任务 · {filtered.length}
				</div>
				<div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2.5 pb-3">
					{filtered.length === 0 && (
						<p className="px-3 py-6 text-center text-xs text-[#a1a1a6]">
							{needle ? "没有匹配的任务" : "还没有任务，发起一次对话即可创建。"}
						</p>
					)}
					{filtered.map((c) => {
						const active = !settingsActive && c.id === activeId;
						return (
							<div
								key={c.id}
								onClick={() => props.onSelect(c.id)}
								className={`group flex h-[37px] cursor-pointer items-center gap-2 rounded-xl px-2.5 transition-colors ${
									active ? "bg-black/[0.075]" : "hover:bg-black/[0.045]"
								}`}
							>
								<div className="flex min-w-0 flex-1 items-center gap-1.5">
									<span className="truncate text-[15px] text-[#1d1d1f]">{c.title ?? "新对话"}</span>
									{c.origin === "im" && (
										<span className="shrink-0 rounded bg-black/[0.06] px-1 py-px text-[9px] font-medium text-[#6e6e73]" title="来自 IM 渠道，只读">
											IM
										</span>
									)}
								</div>
								<span className="shrink-0 text-[11px] text-[#a1a1a6] opacity-0 transition-opacity group-hover:opacity-100">
									{timeAgo(c.updated_at)}
								</span>
								<button
									onClick={(e) => {
										e.stopPropagation();
										props.onDelete(c.id);
									}}
									className="hidden shrink-0 rounded px-1 py-0.5 text-xs text-[#a1a1a6] hover:bg-black/[0.075] hover:text-[#1d1d1f] group-hover:block"
									title="删除任务"
								>
									✕
								</button>
							</div>
						);
					})}
				</div>
			</div>

			{/* Footer — icon-only settings + model/version pinned right (pi-sidebar__footer) */}
			<div className="titlebar-nodrag flex items-center justify-between px-3.5 pb-3.5 pt-2.5">
				<div className="flex items-center gap-1">
					<button
						onClick={() => props.onNavigate(settingsActive ? "chat" : "settings")}
						className={`relative flex h-[30px] w-[30px] items-center justify-center rounded-lg transition-colors ${
							settingsActive ? "bg-black/[0.075] text-[#1d1d1f]" : "text-[#6e6e73] hover:bg-black/[0.045] hover:text-[#1d1d1f]"
						}`}
						title="设置"
						aria-label="设置"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[18px] w-[18px]">
							<circle cx="12" cy="12" r="3.2" />
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06-.06a2 2 0 1 1-2.83-2.83l.06.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"
							/>
						</svg>
						{updateVersion && (
							<span
								className={`absolute right-0.5 top-0.5 h-[7px] w-[7px] rounded-full ${
									update.state?.phase === "ready" ? "bg-emerald-500" : "bg-amber-500"
								}`}
								title={update.state?.phase === "ready" ? `新版本 v${updateVersion} 待安装` : `发现新版本 v${updateVersion}`}
							/>
						)}
					</button>
				</div>
				<div className="flex min-w-0 items-center gap-2 text-xs text-[#a1a1a6]">
					<span className="truncate font-mono" title={modelLabel}>{modelLabel}</span>
					{update.state?.currentVersion && <span className="shrink-0">v{update.state.currentVersion}</span>}
				</div>
			</div>
		</aside>
	);
}
