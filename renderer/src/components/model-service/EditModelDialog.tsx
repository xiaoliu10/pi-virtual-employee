import { useState } from "react";
import type { Supplier } from "../../lib/types";
import { ImageToggle } from "./ImageToggle";

/** Format a token count the way the reference UI does: 1M / 200K / raw. */
export function contextBadge(tokens: number | undefined): string | null {
	if (!tokens || tokens <= 0) return null;
	if (tokens >= 1_000_000) return `${stripZero(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return String(Math.floor(tokens));
}

function stripZero(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Patch for one model's per-model overrides; empty-string removes the key. */
export interface ModelOverridePatch {
	contextWindow?: string;
	maxTokens?: string;
	image?: "inherit" | boolean;
}

interface EditModelDialogProps {
	supplier: Supplier;
	modelId: string;
	/** Effective image-input capability after inherit/override resolution. */
	effectiveImage: boolean;
	onApply: (modelId: string, patch: ModelOverridePatch) => void;
	onClose: () => void;
}

const inputCls = "h-11 w-full rounded-xl border border-slate-200 bg-[#f7f8fa] px-3.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100";

/**
 * Per-model editor, styled after the reference model-config dialog (2026-09-17):
 * identity, context window, max output tokens, and a collapsed 高级配置 section
 * for input-type overrides. Only fields the engine actually consumes are
 * exposed — everything here writes a real Supplier override.
 */
export function EditModelDialog(props: EditModelDialogProps) {
	const { supplier, modelId } = props;
	const [contextWindow, setContextWindow] = useState(String(supplier.modelContextWindow?.[modelId] ?? ""));
	const [maxTokens, setMaxTokens] = useState(String(supplier.modelMaxTokens?.[modelId] ?? ""));
	const [image, setImage] = useState<"inherit" | boolean>(supplier.modelImage?.[modelId] ?? "inherit");
	const [advanced, setAdvanced] = useState(false);

	const save = () => {
		props.onApply(modelId, { contextWindow, maxTokens, image });
		props.onClose();
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
			<div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
				<div className="mb-5 flex items-center justify-between">
					<h3 className="text-base font-semibold text-slate-950">编辑模型配置</h3>
					<button type="button" onClick={props.onClose} className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100">✕</button>
				</div>

				<div className="space-y-4">
					<label className="block">
						<span className="mb-2 block text-sm font-medium text-slate-800">模型 ID</span>
						<input value={modelId} disabled className={`${inputCls} font-mono text-xs text-slate-500`} />
					</label>

					<label className="block">
						<span className="mb-2 block text-sm font-medium text-slate-800">
							上下文窗口 <span className="ml-1 cursor-help text-[#a1a1a6]" title="真实上下文窗口（tokens）。中转/别名模型务必按网关实际值填写，否则长对话会被错误压缩甚至空回复；留空 = 继承默认。">?</span>
						</span>
						<input type="number" min={0} value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} className={inputCls} placeholder="继承默认（200000）" />
					</label>

					<label className="block">
						<span className="mb-2 block text-sm font-medium text-slate-800">
							最大输出 Token <span className="ml-1 cursor-help text-[#a1a1a6]" title="单次回复的最大输出长度（tokens）。中转模型继承到不合适的基础值时会截断长回复；留空 = 继承默认。">?</span>
						</span>
						<input type="number" min={0} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} className={inputCls} placeholder="继承默认" />
					</label>

					<div>
						<button type="button" onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900">
							<span className={`inline-block transition-transform ${advanced ? "rotate-90" : ""}`}>›</span> 高级配置
						</button>
						{advanced && (
							<div className="mt-3 space-y-4 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
								<div>
									<span className="mb-2 block text-sm font-medium text-slate-800">输入类型</span>
									<div className="flex items-center gap-2">
										<span className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">✓ 文本</span>
										<div className="flex items-center gap-2">
											<span className="text-xs text-slate-500">图片</span>
											<ImageToggle
												explicit={supplier.modelImage?.[modelId]}
												effective={props.effectiveImage}
												onChange={(val) => setImage(val)}
											/>
										</div>
									</div>
									<p className="mt-2 text-xs text-slate-400">当前生效：{props.effectiveImage ? "支持图片输入" : "仅文本"}（继承基础注册表，可在此强制指定）。</p>
								</div>
							</div>
						)}
					</div>
				</div>

				<div className="mt-6 flex items-center justify-between">
					<button
						type="button"
						onClick={() => {
							setContextWindow(String(supplier.modelContextWindow?.[modelId] ?? ""));
							setMaxTokens(String(supplier.modelMaxTokens?.[modelId] ?? ""));
							setImage(supplier.modelImage?.[modelId] ?? "inherit");
						}}
						className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
					>
						重置表单
					</button>
					<div className="flex gap-3">
						<button type="button" onClick={props.onClose} className="rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">取消</button>
						<button type="button" onClick={save} className="rounded-xl bg-[#1d1d1f] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#3f3f43]">保存</button>
					</div>
				</div>
			</div>
		</div>
	);
}
