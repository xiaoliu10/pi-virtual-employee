import { Component, type ReactNode } from "react";

interface Props {
	children: ReactNode;
}
interface State {
	error: Error | null;
}

/** Catches render-time errors so the window shows a message instead of a blank screen. */
export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: { componentStack: string }) {
		console.error("[ErrorBoundary]", error, info.componentStack);
	}

	render() {
		if (this.state.error) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-3 bg-[#f6f6f7] p-8 text-center">
					<div className="text-2xl">⚠️</div>
					<h2 className="text-lg font-semibold text-ink-900">界面渲染出错</h2>
					<pre className="max-w-xl overflow-auto rounded-lg bg-white p-3 text-left text-xs text-rose-600">
						{this.state.error.message}
					</pre>
					<button
						onClick={() => this.setState({ error: null })}
						className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white"
					>
						重试
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
