/**
 * Long-text splitting for proactive IM pushes (scheduled-task results, report
 * pushes, admin notices). DingTalk's robot APIs cap one message at roughly
 * 4000 characters / 20KB — a daily report routinely exceeds that, and the old
 * behavior (hard-cut the push at 1200 chars, "完整内容见报告链接") threw away
 * most of the content the user asked for (field 2026-09-20).
 *
 * Policy: deliver the FULL text across at most `maxParts` messages, split at
 * blank-line boundaries (markdown sections/tables stay intact); only when even
 * `maxParts` cannot fit it does the caller fall back to a brief + link.
 */
export interface PushChunkOptions {
	/** Target size per message; stays under the platform's ~4000-char cap. */
	maxChars?: number;
	/** Hard cap on messages per push — spam guard and rate-limit guard. */
	maxParts?: number;
}

export function splitForPush(text: string, opts: PushChunkOptions = {}): string[] {
	const maxChars = opts.maxChars ?? 3800;
	const maxParts = opts.maxParts ?? 3;
	const trimmed = text.trim();
	if (!trimmed) return [];
	// `maxParts` segments cover at most this much; a bigger text must be
	// truncated at the last clean boundary that fits.
	const budget = maxChars * maxParts;
	if (trimmed.length <= maxChars) return [trimmed];
	if (trimmed.length > budget) {
		const head = cutAtBoundary(trimmed, budget);
		return head.length < trimmed.length ? [head + "\n…（内容过长，已截断）"] : [head];
	}
	return splitEvenly(trimmed, maxChars);
}

/** Split into as few `maxChars`-bounded pieces as possible at clean lines. */
function splitEvenly(text: string, maxChars: number): string[] {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		const head = cutAtBoundary(rest, maxChars);
		parts.push(head.trimEnd());
		rest = rest.slice(head.length).trimStart();
	}
	if (rest) parts.push(rest);
	return parts;
}

/** Longest prefix of `text` up to `max` that ends at a paragraph/line edge,
 * never stranding a markdown heading at the end of a part. */
function cutAtBoundary(text: string, max: number): string {
	if (text.length <= max) return text;
	const para = text.lastIndexOf("\n\n", max);
	const line = text.lastIndexOf("\n", max);
	let cut = para > 0 ? para : line > 0 ? line : max;
	// A part must not end on a heading whose body lands in the next part —
	// pull the heading down (field 2026-09-20: "## 第 4 节" stranded at the
	// end of part 1 by the paragraph boundary right below it).
	const stranded = text.slice(0, cut).match(/\n#[^\n]*$/);
	const strandedAt = stranded?.index ?? 0;
	if (strandedAt > 0) cut = strandedAt;
	return cut > 0 ? text.slice(0, cut) : text.slice(0, max);
}
