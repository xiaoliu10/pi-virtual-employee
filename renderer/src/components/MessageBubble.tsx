import ReactMarkdown from "react-markdown";

interface MessageBubbleProps {
	role: "user" | "assistant";
	content: string;
	streaming?: boolean;
}

const MARKDOWN_CLASSES =
	"space-y-2 [&_h1]:text-lg [&_h1]:font-bold [&_h1]:mt-2 [&_h2]:text-base [&_h2]:font-semibold " +
	"[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-1 " +
	"[&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[13px] [&_code]:font-mono " +
	"[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-ink-900 [&_pre]:p-3 [&_pre]:text-[13px] " +
	"[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[#dde2ea] " +
	"[&_p]:leading-relaxed [&_strong]:font-semibold [&_a]:text-accent [&_a]:underline";

export function MessageBubble({ role, content, streaming }: MessageBubbleProps) {
	const isUser = role === "user";
	return (
		<div className={`flex animate-fade-in ${isUser ? "justify-end" : "justify-start"}`}>
			{!isUser && (
				<div className="mr-3 mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#20242c] text-sm font-bold text-[#a8c9ff]">
					π
				</div>
			)}
			<div
				className={`max-w-[78%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
					isUser
						? "rounded-br-md bg-[#202630] text-[#edf0f4]"
						: "rounded-tl-md border border-slate-200 bg-white text-slate-800 shadow-sm"
				}`}
			>
				{isUser ? (
					<p className="whitespace-pre-wrap">{content}</p>
				) : content ? (
					<div className={`${MARKDOWN_CLASSES} ${streaming ? "streaming-caret" : ""}`}>
						<ReactMarkdown>{content}</ReactMarkdown>
					</div>
				) : (
					streaming && <span className="text-slate-400">思考中…</span>
				)}
			</div>
		</div>
	);
}
