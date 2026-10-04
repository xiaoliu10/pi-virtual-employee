import { useEffect, useState } from "react";
import { AUTH_PROVIDER_LABELS } from "../../../../src/shared/auth";
import type { AuthCatalogEntry, AuthLoginState, AuthPromptView } from "../../../../src/shared/auth";

interface AuthLoginDialogProps {
	state: AuthLoginState;
	/** Catalog row of the provider (may be missing until first load finishes) —
	 * powers the「添加为模型供应商」shortcut on the done page. */
	entry?: AuthCatalogEntry;
	/** Submit an answer to the current prompt. Rejects → shown as inline error. */
	onAnswer: (promptId: string, value: string) => Promise<void>;
	/** Restart the login flow for the same provider (error/cancelled pages). */
	onRetry: () => void;
	/** Abort the in-flight flow (waiting states; engine pushes a cancelled snapshot). */
	onCancel: () => void;
	/** Dismiss the dialog (terminal states only). */
	onClose: () => void;
	/** Quick-create a supplier from the logged-in provider (done page). */
	onCreateSupplier?: (entry: AuthCatalogEntry) => void;
}

/** Small clipboard button with transient「已复制」copied feedback. */
function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			/* clipboard unavailable (rare in Electron) — keep the label stable */
		}
	};
	return (
		<button
			type="button"
			onClick={() => void copy()}
			className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
		>
			{copied ? "已复制" : label}
		</button>
	);
}

/** Form for one prompt (text / secret / select / manual_code). Remounted per
 * prompt id via `key` so stale input never leaks into the next question. */
function PromptForm({
	prompt,
	submitting,
	error,
	onSubmit,
}: {
	prompt: AuthPromptView;
	submitting: boolean;
	error: string | null;
	onSubmit: (promptId: string, value: string) => void;
}) {
	const [value, setValue] = useState("");
	const [showSecret, setShowSecret] = useState(false);

	if (prompt.type === "select") {
		return (
			<div className="space-y-2">
				<p className="text-sm leading-relaxed text-slate-700">{prompt.message}</p>
				{(prompt.options ?? []).map((option) => (
					<button
						type="button"
						key={option.id}
						disabled={submitting}
						onClick={() => onSubmit(prompt.id, option.id)}
						className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-blue-300 hover:bg-blue-50/40 disabled:opacity-50"
					>
						<div className="text-sm font-medium text-slate-800">{option.label}</div>
						{option.description && <div className="mt-0.5 text-xs text-slate-400">{option.description}</div>}
					</button>
				))}
				{error && <p className="text-xs text-rose-500">{error}</p>}
			</div>
		);
	}

	const submit = () => {
		const trimmed = value.trim();
		if (!trimmed || submitting) return;
		onSubmit(prompt.id, trimmed);
	};

	return (
		<div>
			<p className="text-sm leading-relaxed text-slate-700">{prompt.message}</p>
			{prompt.type === "manual_code" ? (
				<textarea
					value={value}
					onChange={(event) => setValue(event.target.value)}
					rows={4}
					placeholder={prompt.placeholder ?? "粘贴页面上的代码"}
					className="mt-3 h-auto w-full rounded-xl border border-slate-200 bg-[#f7f8fa] px-3.5 py-2 font-mono text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100"
				/>
			) : (
				<div className="relative mt-3">
					<input
						type={prompt.type === "secret" && !showSecret ? "password" : "text"}
						value={value}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={(event) => event.key === "Enter" && submit()}
						placeholder={prompt.placeholder ?? ""}
						autoFocus
						className="h-11 w-full rounded-xl border border-slate-200 bg-[#f7f8fa] px-3.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100"
					/>
					{prompt.type === "secret" && (
						<button
							type="button"
							onClick={() => setShowSecret((v) => !v)}
							className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600"
						>
							{showSecret ? "隐藏" : "显示"}
						</button>
					)}
				</div>
			)}
			{error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
			<button
				type="button"
				onClick={submit}
				disabled={!value.trim() || submitting}
				className="mt-3 w-full rounded-xl bg-[#1d1d1f] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#3f3f43] disabled:cursor-not-allowed disabled:opacity-50"
			>
				{submitting ? "提交中…" : "提交"}
			</button>
		</div>
	);
}

/**
 * Single login dialog driven entirely by AuthLoginState snapshots: waiting
 * (url / deviceCode / prompt, in any combination) → done | error | cancelled.
 * The engine pushes a fresh snapshot on every step; nothing here is derived
 * from local bookkeeping except the inline answer error.
 */
export function AuthLoginDialog(props: AuthLoginDialogProps) {
	const { state } = props;
	const providerName = AUTH_PROVIDER_LABELS[state.provider]?.name ?? state.provider;
	const [submitting, setSubmitting] = useState(false);
	const [answerError, setAnswerError] = useState<string | null>(null);
	// A new question invalidates the previous inline answer error.
	useEffect(() => {
		setAnswerError(null);
	}, [state.prompt?.id]);
	const waiting = state.status === "waiting";

	const openUrl = (url: string) => {
		// FOLLOW-UP: preload exposes no generic openExternal channel (main-process
		// files are off-limits for this change), so window.open is the stopgap —
		// without a setWindowOpenHandler in main it hosts the OAuth page in an
		// in-app child window. Replace once main ships a shell.openExternal IPC.
		window.open(url, "_blank", "noopener");
	};

	const submitAnswer = async (promptId: string, value: string) => {
		setSubmitting(true);
		setAnswerError(null);
		try {
			await props.onAnswer(promptId, value);
			// On success the engine pushes the next snapshot (prompt cleared or a
			// terminal state) — nothing to do locally.
		} catch (reason) {
			setAnswerError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-6 backdrop-blur-[2px]"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !waiting) props.onClose();
			}}
		>
			<div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
				<div className="mb-4 flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h3 className="text-base font-semibold text-slate-950">{providerName}</h3>
						<p className="mt-0.5 text-xs text-slate-400">
							{state.status === "done" ? "登录完成" : state.status === "error" ? "登录失败" : state.status === "cancelled" ? "登录已取消" : "正在等待完成登录…"}
						</p>
					</div>
					{!waiting && (
						<button type="button" onClick={props.onClose} className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100" aria-label="关闭">
							✕
						</button>
					)}
				</div>

				{state.status === "done" && (
					<div className="py-1 text-center">
						<div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-2xl text-emerald-500">✓</div>
						<p className="mt-3 text-sm font-medium text-slate-800">{state.message || "登录成功，凭证已保存"}</p>
						{props.entry && props.entry.models.length > 0 && props.onCreateSupplier ? (
							<>
								<button
									type="button"
									onClick={() => props.onCreateSupplier?.(props.entry!)}
									className="mt-4 w-full rounded-xl bg-[#1d1d1f] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#3f3f43]"
								>
									添加为模型供应商（预填 {props.entry.models.length} 个模型）
								</button>
								<p className="mt-2 text-xs leading-relaxed text-slate-400">
									将在「自定义供应商」中创建 {props.entry.name}：模型列表已预填，鉴权走本次登录凭证，无需 API Key / Base URL。
								</p>
							</>
						) : (
							<p className="mt-2 text-xs leading-relaxed text-slate-400">
								可稍后在「自定义供应商」页添加该供应商：选择模型即可，无需填写 API Key 与 Base URL。
							</p>
						)}
					</div>
				)}

				{state.status === "error" && (
					<div className="py-1">
						<p className="break-all rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm leading-relaxed text-rose-600">
							{state.error || state.message || "登录失败，请重试"}
						</p>
						<p className="mt-2 text-xs text-slate-400">可重试；若反复失败，请检查网络或账号订阅状态。</p>
					</div>
				)}

				{state.status === "cancelled" && (
					<div className="py-1">
						<p className="rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-3 text-sm leading-relaxed text-slate-600">
							{state.message || "登录已取消"}
						</p>
					</div>
				)}

				{waiting && (
					<div className="space-y-3">
						{!state.url && !state.deviceCode && !state.prompt && (
							<div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-[#f7f8fa] px-4 py-4">
								<span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
								<p className="text-sm text-slate-600">{state.message || "正在启动登录…"}</p>
							</div>
						)}

						{state.url && (
							<div className="rounded-xl border border-slate-200 bg-[#f7f8fa] p-4">
								{!state.prompt && <p className="text-sm leading-relaxed text-slate-700">{state.message || "在浏览器完成授权。"}</p>}
								<div className="mt-1 flex flex-wrap items-center gap-2">
									<button
										type="button"
										onClick={() => openUrl(state.url!)}
										className="rounded-xl bg-[#1d1d1f] px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-[#3f3f43]"
									>
										打开授权页面
									</button>
									<CopyButton text={state.url} label="复制链接" />
								</div>
								<p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-slate-400">{state.url}</p>
							</div>
						)}

						{state.deviceCode && (
							<div className="rounded-xl border border-slate-200 bg-[#f7f8fa] p-4 text-center">
								<p className="text-xs text-slate-400">在打开的页面中输入设备码</p>
								<div className="mt-2 select-all font-mono text-2xl font-semibold tracking-[0.3em] text-slate-900">{state.deviceCode}</div>
								<div className="mt-3 flex justify-center">
									<CopyButton text={state.deviceCode} label="复制设备码" />
								</div>
							</div>
						)}

						{state.prompt && (
							<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
								<PromptForm key={state.prompt.id} prompt={state.prompt} submitting={submitting} error={answerError} onSubmit={(id, value) => void submitAnswer(id, value)} />
							</div>
						)}
					</div>
				)}

				<div className="mt-5 flex items-center justify-between gap-3">
					{waiting ? (
						<button type="button" onClick={props.onCancel} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700">
							取消登录
						</button>
					) : (
						<span />
					)}
					<div className="flex gap-2">
						{(state.status === "error" || state.status === "cancelled") && (
							<button
								type="button"
								onClick={props.onRetry}
								className="rounded-xl bg-[#1d1d1f] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#3f3f43]"
							>
								{state.status === "error" ? "重试" : "重新登录"}
							</button>
						)}
						{!waiting && (
							<button
								type="button"
								onClick={props.onClose}
								className="rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
							>
								{state.status === "done" ? "完成" : "关闭"}
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
