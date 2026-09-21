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
	"[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[#1d1d1f] " +
	"[&_p]:leading-relaxed [&_strong]:font-semibold [&_a]:text-accent [&_a]:underline";

/** pi-desktop message shapes: user = right-aligned light-gray bubble (max
 * 68%); assistant = flat full-width markdown, no avatar, no card. */
export function MessageBubble({ role, content, streaming }: MessageBubbleProps) {
	const isUser = role === "user";
	if (isUser) {
		return (
			<div className="flex animate-fade-in flex-col items-end">
				<div className="flex w-fit max-w-[68%] flex-col items-start gap-1.5 rounded-2xl bg-[#f2f2f3] px-4 py-2.5 text-[15px] leading-relaxed text-[#1d1d1f]">
					<p className="whitespace-pre-wrap">{content}</p>
				</div>
			</div>
		);
	}
	return (
		<div className="animate-fade-in text-[15px] leading-relaxed text-[#1d1d1f]">
			{content ? (
				<div className={`${MARKDOWN_CLASSES} ${streaming ? "streaming-caret" : ""}`}>
					<ReactMarkdown>{content}</ReactMarkdown>
				</div>
			) : (
				streaming && (
					<span className="flex items-center gap-2 text-[12.5px] text-[#a1a1a6]">
						<span className="streaming-caret" />
						思考中…
					</span>
				)
			)}
		</div>
	);
}
