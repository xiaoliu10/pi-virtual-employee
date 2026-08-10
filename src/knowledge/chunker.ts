/**
 * Text chunker. Splits on paragraph / sentence boundaries up to a target size
 * with overlap, preserving a running chunk index. This replaces the old
 * fixed-character cut that lived in knowledge-store.ts and makes the size and
 * overlap configurable (read from KbConfig.local.chunk).
 */
export interface Chunk {
	text: string;
	chunkIndex: number;
}

export interface ChunkOptions {
	size: number;
	overlap: number;
}

const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { size: 800, overlap: 120 };

export function chunkText(text: string, options: Partial<ChunkOptions> = {}): Chunk[] {
	const { size, overlap } = { ...DEFAULT_CHUNK_OPTIONS, ...options };
	if (size <= 0) return [];
	const step = Math.max(1, size - overlap);

	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (!normalized) return [];

	// Split into paragraph / sentence-ish units, then pack up to `size` chars.
	const paragraphs = normalized
		.split(/\n{2,}|(?<=[。！？!?\.])\n/)
		.map((p) => p.trim())
		.filter(Boolean);

	const blocks: string[] = [];
	let buffer = "";
	for (const paragraph of paragraphs) {
		if (paragraph.length >= size) {
			if (buffer) {
				blocks.push(buffer);
				buffer = "";
			}
			// Hard-split an oversized paragraph into overlapping windows.
			for (let i = 0; i < paragraph.length; i += step) {
				blocks.push(paragraph.slice(i, i + size));
				if (i + size >= paragraph.length) break;
			}
			continue;
		}
		const candidate = buffer ? `${buffer}\n${paragraph}` : paragraph;
		if (candidate.length > size) {
			blocks.push(buffer);
			buffer = paragraph;
		} else {
			buffer = candidate;
		}
	}
	if (buffer) blocks.push(buffer);

	return blocks
		.map((block) => block.trim())
		.filter((block) => block.length > 0)
		.map((text, index) => ({ text, chunkIndex: index }));
}
