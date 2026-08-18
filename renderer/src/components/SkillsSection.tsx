import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/ipc";
import type { SkillInfo } from "../lib/types";

/**
 * Skill management: list built-in + imported SKILL.md packages, import new ones,
 * toggle each on/off (persisted in config.skills.disabled), and delete imported
 * ones (two-step confirm). Built-ins can be disabled but not deleted.
 *
 * Skills are declarative Markdown injected into the system prompt — no
 * executable plugins this phase, hence no "install code" surface here.
 */
export function SkillsSection(): ReactNode {
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [confirmPath, setConfirmPath] = useState<string | null>(null);

	const refresh = (): void => {
		api.listSkills()
			.then(setSkills)
			.catch(() => setMsg("加载技能失败"));
	};
	useEffect(refresh, []);

	const flash = (text: string): void => {
		setMsg(text);
		window.setTimeout(() => setMsg(null), 3000);
	};

	const onImport = async (): Promise<void> => {
		setBusy(true);
		try {
			const res = await api.importSkills();
			refresh();
			if (res.errors.length > 0) flash(`导入 ${res.imported} 个，失败：${res.errors.join("；")}`);
			else if (res.imported > 0) flash(`已导入 ${res.imported} 个技能`);
			else flash("未导入任何技能");
		} finally {
			setBusy(false);
		}
	};

	const onToggle = async (skill: SkillInfo, enabled: boolean): Promise<void> => {
		await api.setEnabledSkill(skill.name, enabled);
		refresh();
	};

	const onDelete = async (skill: SkillInfo): Promise<void> => {
		if (skill.source !== "user") return;
		setBusy(true);
		try {
			await api.deleteSkill(skill.filePath);
			setConfirmPath(null);
			refresh();
			flash(`已删除技能：${skill.name}`);
		} finally {
			setBusy(false);
		}
	};

	const enabledCount = skills.filter((s) => s.enabled).length;

	return (
		<section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
			<div className="mb-4 flex items-center justify-between">
				<div>
					<h3 className="text-[15px] font-semibold text-slate-800">技能管理</h3>
					<p className="mt-1 text-xs text-slate-400">
						共 {skills.length} 个，启用 {enabledCount} 个。技能以声明式 Markdown 注入系统提示词，本阶段不支持可执行插件。
					</p>
				</div>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => {
							void api.refreshSkills().then(refresh);
						}}
						className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
					>
						刷新
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={onImport}
						className="rounded-xl bg-blue-500 px-4 py-2 text-sm text-white transition hover:bg-blue-600 disabled:opacity-50"
					>
						{busy ? "处理中…" : "导入 Skill…"}
					</button>
				</div>
			</div>

			{msg && <div className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">{msg}</div>}

			{skills.length === 0 ? (
				<p className="py-6 text-center text-sm text-slate-400">还没有技能。点「导入 Skill…」添加 SKILL.md 文件或目录。</p>
			) : (
				<ul className="divide-y divide-slate-100">
					{skills.map((skill) => (
						<li key={skill.filePath} className="flex items-start gap-3 py-3">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium text-slate-800">{skill.name}</span>
									<span
										className={`rounded px-1.5 py-0.5 text-[10px] ${
											skill.source === "user" ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"
										}`}
									>
										{skill.source === "user" ? "导入" : "内置"}
									</span>
									{!skill.enabled && (
										<span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">已停用</span>
									)}
								</div>
								{skill.description && <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{skill.description}</p>}
								{skill.warnings && skill.warnings.length > 0 && (
									<p className="mt-0.5 text-xs text-amber-600">⚠ {skill.warnings.join("；")}</p>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-3">
								<button
									type="button"
									onClick={() => onToggle(skill, !skill.enabled)}
									className={`rounded-lg px-2.5 py-1 text-xs transition ${
										skill.enabled ? "text-slate-400 hover:bg-slate-50 hover:text-slate-600" : "text-blue-500 hover:bg-blue-50"
									}`}
								>
									{skill.enabled ? "停用" : "启用"}
								</button>
								{skill.source === "user" &&
									(confirmPath === skill.filePath ? (
										<span className="flex items-center gap-1">
											<button
												type="button"
												disabled={busy}
												onClick={() => onDelete(skill)}
												className="rounded-lg bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600 disabled:opacity-50"
											>
												确认删除
											</button>
											<button
												type="button"
												onClick={() => setConfirmPath(null)}
												className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-50"
											>
												取消
											</button>
										</span>
									) : (
										<button
											type="button"
											onClick={() => setConfirmPath(skill.filePath)}
											className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-500"
										>
											删除
										</button>
									))}
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
