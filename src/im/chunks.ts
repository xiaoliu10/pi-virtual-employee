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
	const budget = maxChars * maxParts;
	if (trimmed.length > budget) {
		// Over maxParts worth of content: deliver ONE truncated part with an
		// explicit note (existing contract — a truncated report is better than a
		// 10-part flood).
		const head = cutAtBoundary(trimmed, budget);
		return [head + "\n…（内容过长，已截断）"];
	}
	const source = trimmed;
	if (source.length <= maxChars) return [source];
	return splitEvenly(source, maxChars);
}

interface Block {
	lines: string[];
	/** Header + delimiter rows of a table block (repeated in every part it spans). */
	tableHeader?: string[];
}

/**
 * Split into `maxChars`-bounded parts by greedily packing BLOCKS.
 *
 * Blocks are whole markdown units: paragraphs, headings, and TABLES (adjacent
 * table rows). Packing whole blocks (instead of cutting at line boundaries)
 * is what keeps tables renderable — a table is never cut mid-run, and a table
 * taller than one message is split BY ROWS with its header repeated in every
 * part (field 2026-10-28: reports arrived as headerless walls of pipes).
 */
function splitEvenly(text: string, maxChars: number): string[] {
	const blocks = toBlocks(text.split("\n"));
	const parts: string[] = [];
	let current: string[] = [];
	let length = 0;
	const flush = (): void => {
		if (current.length) parts.push(current.join("\n"));
		current = [];
		length = 0;
	};
	const push = (blockText: string): void => {
		const extra = (current.length ? 1 : 0) + blockText.length; // +1 for the joining newline
		if (length + extra > maxChars && current.length) flush();
		current.push(blockText);
		length += extra;
	};
	for (const block of blocks) {
		const blockText = block.lines.join("\n");
		if (blockText.length <= maxChars) {
			push(blockText);
			continue;
		}
		// Block too big for one message: a table splits by rows with a repeated
		// header; anything else is cut at inner boundaries.
		if (block.tableHeader) {
			const header = block.tableHeader;
			const body = block.lines.slice(header.length);
			let rows: string[] = [];
			for (const row of body) {
				const candidate = [...header, ...rows, row].join("\n");
				if (candidate.length > maxChars && rows.length) {
					push([...header, ...rows].join("\n"));
					rows = [];
				}
				rows.push(row);
			}
			if (rows.length) push([...header, ...rows].join("\n"));
			continue;
		}
		let rest = blockText;
		while (rest.length > maxChars) {
			const head = cutAtBoundary(rest, maxChars);
			push(head.trimEnd());
			rest = rest.slice(head.length).trimStart();
			flush();
		}
		if (rest) push(rest);
	}
	flush();
	return parts;
}

/** Group lines into whole units: table runs (with header captured) vs paragraphs. */
function toBlocks(lines: string[]): Block[] {
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		if (TABLE_ROW.test(lines[i])) {
			let end = i;
			while (end < lines.length && TABLE_ROW.test(lines[end])) end += 1;
			const run = lines.slice(i, end);
			// A table needs a delimiter row; otherwise treat the run as plain text.
			const hasDelimiter = run.length >= 2 && /^\s*\|\s*:?-{2,}/.test(run[1]);
			blocks.push(hasDelimiter ? { lines: run, tableHeader: run.slice(0, 2) } : { lines: run });
			i = end;
			continue;
		}
		// Text paragraph: up to (not including) the next blank line or table.
		let end = i;
		while (end < lines.length && lines[end].trim() !== "" && !TABLE_ROW.test(lines[end])) end += 1;
		if (end === i) {
			end = i + 1; // a blank line on its own
			blocks.push({ lines: [lines[i]] });
		} else {
			blocks.push({ lines: lines.slice(i, end) });
		}
		i = end;
	}
	// A heading must never be packed alone: keep it with the block that follows
	// (skipping blank separators) so no part ends on a bare "## 第 4 节".
	const merged: Block[] = [];
	for (let k = 0; k < blocks.length; k += 1) {
		const block = blocks[k];
		const isHeadingOnly = block.lines.length === 1 && /^#{1,6}\s/.test(block.lines[0].trim()) && !block.tableHeader;
		if (isHeadingOnly) {
			let j = k + 1;
			const gap: string[] = [];
			while (j < blocks.length && blocks[j].lines.every((l) => l.trim() === "")) {
				gap.push(...blocks[j].lines);
				j += 1;
			}
			if (j < blocks.length && !blocks[j].tableHeader) {
				merged.push({ lines: [...block.lines, ...gap, ...blocks[j].lines] });
				k = j;
				continue;
			}
		}
		merged.push(block);
	}
	return merged;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * Move a cut point so it does not land inside a table block (both halves would
 * lose their header and render as a wall of pipes).
 */
function backOutOfTable(text: string, cut: number): number {
	const lines = text.slice(0, cut).split("\n");
	let blockStart = -1;
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		if (TABLE_ROW.test(lines[i])) {
			blockStart = i;
			continue;
		}
		break;
	}
	if (blockStart <= 0) return cut;
	if (lines.length - blockStart < 2) return cut;
	const block = lines.slice(blockStart);
	if (!block.some((l) => /^\s*\|\s*:?-{2,}/.test(l))) return cut;
	return lines.slice(0, blockStart).join("\n").length;
}

/** Longest prefix of `text` up to `max` that ends at a paragraph/line edge,
 * never stranding a markdown heading at the end of a part. */
function cutAtBoundary(text: string, max: number): string {
	if (text.length <= max) return text;
	const para = text.lastIndexOf("\n\n", max);
	const line = text.lastIndexOf("\n", max);
	let cut = para > 0 ? para : line > 0 ? line : max;
	// Never cut INSIDE a markdown table: table rows are separated by single
	// newlines, so a line-boundary cut happily splits a table in half and both
	// halves render as broken pipes ("表头错位", field 2026-10-28). Walk back
	// to before the table block's first row instead — a whole table in one
	// message is worth a slightly shorter part.
	if (cut > 0) cut = backOutOfTable(text, cut);
	// A part must not end on a heading whose body lands in the next part —
	// pull the heading down (field 2026-09-20: "## 第 4 节" stranded at the
	// end of part 1 by the paragraph boundary right below it).
	const stranded = text.slice(0, cut).match(/\n#[^\n]*$/);
	const strandedAt = stranded?.index ?? 0;
	if (strandedAt > 0) cut = strandedAt;
	return cut > 0 ? text.slice(0, cut) : text.slice(0, max);
}
