import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/ipc";
import type { AuthCatalogEntry, AuthCatalogProviderId, AuthCatalogResponse, AuthLoginState } from "../../../../src/shared/auth";
import { AuthLoginDialog } from "./AuthLoginDialog";
import { AuthQuotaDialog } from "./AuthQuotaDialog";

interface AccountLoginSectionProps {
	/** 「添加为模型供应商」 on the login-done page: create/refresh the
	 *  authProvider supplier from this catalog row (parent writes the model
	 *  config and switches back to the supplier view). */
	onCreateSupplier: (entry: AuthCatalogEntry) => void;
}

const badgeOf = (entry: AuthCatalogEntry): { text: string; className: string } => {
	if (entry.configured) {
		return entry.authType === "oauth" || (entry.authType === undefined && entry.kind === "oauth")
			? { text: "已登录 · OAuth", className: "bg-emerald-50 text-emerald-600" }
			: { text: "已登录 · API Key", className: "bg-emerald-50 text-emerald-600" };
	}
	return { text: "未登录", className: "bg-slate-100 text-slate-500" };
};

/** Model preview on a provider card: first 3 ids + remaining count. */
function ModelPreview({ entry }: { entry: AuthCatalogEntry }) {
	if (!entry.models.length) return null;
	const shown = entry.models.slice(0, 3);
	const rest = entry.models.length - shown.length;
	return (
		<div className="mt-2 flex flex-wrap items-center gap-1.5">
			{shown.map((model) => (
				<span key={model.id} className="max-w-[14rem] truncate rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500" title={model.id}>
					{model.id}
				</span>
			))}
			{rest > 0 && <span className="text-[11px] text-slate-400">还有 {rest} 个</span>}
		</div>
	);
}

/**
 * The「账号登录」section of the 自定义模型 page: provider catalog cards +
 * login dialog + quota dialog. Login progress is driven entirely by the
 * engine-pushed full AuthLoginState snapshots (onAuthLoginEvent); this
 * component only starts/cancels/answers flows, logs out, queries quota, and
 * refreshes the catalog.
 */
export function AccountLoginSection({ onCreateSupplier }: AccountLoginSectionProps) {
	const [catalog, setCatalog] = useState<AuthCatalogResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	/** Login-flow snapshot currently shown in the dialog (non-null = open). */
	const [login, setLogin] = useState<AuthLoginState | null>(null);
	/** Card-level error from starting a login (unknown provider / concurrent-login conflict). */
	const [actionError, setActionError] = useState<{ provider: AuthCatalogProviderId; message: string } | null>(null);
	/** Two-step logout confirm: provider armed for confirmation. */
	const [logoutArm, setLogoutArm] = useState<AuthCatalogProviderId | null>(null);
	const [busyProvider, setBusyProvider] = useState<AuthCatalogProviderId | null>(null);
	/** Provider whose quota dialog is open (non-null = open). */
	const [quotaEntry, setQuotaEntry] = useState<AuthCatalogEntry | null>(null);
	const logoutArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setCatalog(await api.authCatalog());
			setLoadError(null);
		} catch (reason) {
			setLoadError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		// Resume an in-flight login when the settings page reopens (the engine
		// keeps at most one active flow).
		void api
			.authLoginStatus()
			.then((state) => state && setLogin(state))
			.catch(() => {});
	}, [refresh]);

	// Subscribe to the engine's pushed full-state snapshots; refresh the
	// catalog on done so badges/quota buttons catch up.
	useEffect(() => {
		const unsubscribe = api.onAuthLoginEvent((state) => {
			setLogin(state);
			if (state.status === "done") void refresh();
		});
		return unsubscribe;
	}, [refresh]);

	useEffect(() => () => {
		if (logoutArmTimer.current) clearTimeout(logoutArmTimer.current);
	}, []);

	const startLogin = async (provider: AuthCatalogProviderId) => {
		setActionError(null);
		try {
			setLogin(await api.authLogin(provider));
		} catch (reason) {
			// e.g.「已有登录流程正在进行」— adopt the engine's active flow if any.
			const status = await api.authLoginStatus().catch(() => null);
			if (status) {
				setLogin(status);
				return;
			}
			setActionError({ provider, message: reason instanceof Error ? reason.message : String(reason) });
		}
	};

	const cancelLogin = () => {
		// The engine answers the cancel with a pushed cancelled snapshot; the
		// dialog switches to its terminal page.
		void api.authLoginCancel().catch(() => {});
	};

	const closeLogin = () => {
		setLogin(null);
		setActionError(null);
		void refresh();
	};

	const armLogout = (provider: AuthCatalogProviderId) => {
		setLogoutArm(provider);
		if (logoutArmTimer.current) clearTimeout(logoutArmTimer.current);
		logoutArmTimer.current = setTimeout(() => setLogoutArm(null), 4000);
	};

	const confirmLogout = async (entry: AuthCatalogEntry) => {
		if (logoutArmTimer.current) clearTimeout(logoutArmTimer.current);
		setLogoutArm(null);
		setBusyProvider(entry.provider);
		try {
			await api.authLogout(entry.provider);
			await refresh();
		} catch (reason) {
			setActionError({ provider: entry.provider, message: `退出失败：${reason instanceof Error ? reason.message : String(reason)}` });
		} finally {
			setBusyProvider(null);
		}
	};

	const entryOf = (provider: AuthCatalogProviderId): AuthCatalogEntry | undefined => catalog?.providers.find((entry) => entry.provider === provider);

	return (
		<div className="min-h-0 flex-1 overflow-y-auto bg-[#fafbfc] px-10 py-8">
			<div className="mx-auto w-full max-w-3xl space-y-5">
				<section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
					<div className="flex items-start justify-between gap-4">
						<div>
							<h2 className="text-[15px] font-semibold text-slate-800">账号登录</h2>
							<p className="mt-1 text-xs leading-relaxed text-slate-400">
								用订阅账号（ChatGPT / Claude / Kimi / Copilot 等）一键登录，或在下方录入 API Key。凭证保存在本机 auth.json，与 pi CLI 通用；登录成功后可在「自定义供应商」中以该账号创建供应商，无需手填 API Key。
							</p>
							{catalog && (
								<p className="mt-1.5 break-all font-mono text-[11px] text-slate-400" title={catalog.authPath}>
									凭证文件：{catalog.authPath}
								</p>
							)}
						</div>
						<button type="button" onClick={() => void refresh()} disabled={loading} className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
							{loading ? "刷新中…" : "刷新"}
						</button>
					</div>
					{loadError && <p className="mt-3 break-all rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-600">目录加载失败：{loadError}</p>}
				</section>

				<section className="space-y-2.5">
					{(catalog?.providers ?? []).map((entry) => {
						// openai-chatgpt has no registered pi-ai implementation yet: keep it
						// visible but greyed out (unconfigured + zero models = unavailable in
						// this build). Recovers automatically once pi-ai registers it.
						const unavailable = !entry.configured && entry.models.length === 0;
						const badge = badgeOf(entry);
						const busy = busyProvider === entry.provider;
						const armed = logoutArm === entry.provider;
						return (
							<div key={entry.provider} className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition ${unavailable ? "opacity-60" : ""}`}>
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<h3 className="text-sm font-semibold text-slate-900">{entry.name}</h3>
											<span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.text}</span>
											{unavailable && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600">暂不可用</span>}
										</div>
										<p className="mt-1 text-xs leading-relaxed text-slate-400">{unavailable ? "当前版本尚未提供该方式的登录实现，敬请后续版本更新。" : entry.description}</p>
										<ModelPreview entry={entry} />
									</div>
									<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
										{entry.kind === "api_key" && entry.configured && (
											<span className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-1.5 text-xs font-medium text-emerald-600">已录入</span>
										)}
										{!unavailable && (
											<button
												type="button"
												onClick={() => void startLogin(entry.provider)}
												disabled={busy}
												className="rounded-xl bg-[#1d1d1f] px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-[#3f3f43] disabled:cursor-not-allowed disabled:opacity-50"
											>
												{entry.kind === "oauth" ? (entry.configured ? "重新登录" : "登录") : entry.configured ? "重新录入" : "录入 Key"}
											</button>
										)}
										{entry.kind === "api_key" && entry.configured && (
											<button type="button" onClick={() => setQuotaEntry(entry)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
												套餐额度
											</button>
										)}
										{entry.configured &&
											(armed ? (
												<span className="flex items-center gap-1">
													<button
														type="button"
														onClick={() => void confirmLogout(entry)}
														disabled={busy}
														className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-rose-600 disabled:opacity-50"
													>
														{busy ? "退出中…" : "确认退出"}
													</button>
													<button type="button" onClick={() => setLogoutArm(null)} className="rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-100">
														取消
													</button>
												</span>
											) : (
												<button
													type="button"
													onClick={() => armLogout(entry.provider)}
													disabled={busy}
													className="rounded-lg px-2.5 py-1.5 text-xs text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-50"
													title="退出并删除本机保存的登录凭证"
												>
													退出
												</button>
											))}
									</div>
								</div>
								{actionError?.provider === entry.provider && <p className="mt-3 break-all rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-600">{actionError.message}</p>}
							</div>
						);
					})}

					{loading && !catalog && (
						<div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">正在加载供应商目录…</div>
					)}
					{!loading && catalog && catalog.providers.length === 0 && (
						<div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">目录为空</div>
					)}
				</section>
			</div>

			{login && (
				<AuthLoginDialog
					state={login}
					entry={entryOf(login.provider)}
					onAnswer={async (promptId, value) => {
						await api.authLoginAnswer(promptId, value);
					}}
					onRetry={() => void startLogin(login.provider)}
					onCancel={cancelLogin}
					onClose={closeLogin}
					onCreateSupplier={(entry) => {
						onCreateSupplier(entry);
						closeLogin();
					}}
				/>
			)}

			{quotaEntry && <AuthQuotaDialog entry={quotaEntry} onClose={() => setQuotaEntry(null)} />}
		</div>
	);
}
