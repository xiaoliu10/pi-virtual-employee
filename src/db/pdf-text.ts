/**
 * PDF text extraction. Uses `pdf-parse` if installed; otherwise returns a
 * placeholder so document import degrades gracefully rather than failing the
 * whole build. Install pdf-parse (`--ignore-scripts`) to enable real extraction.
 */
export async function extractPdfText(absPath: string): Promise<string> {
	try {
		const buffer = await import("node:fs/promises").then((fs) => fs.readFile(absPath));
		const mod = (await import("pdf-parse").catch(() => null)) as
			| { default?: (buf: Buffer) => Promise<{ text: string }> }
			| null;
		const fn = mod?.default ?? (typeof mod === "function" ? (mod as (buf: Buffer) => Promise<{ text: string }>) : undefined);
		if (!fn) {
			return `[PDF 文本抽取未启用：请安装 pdf-parse 后重新导入 ${absPath}]`;
		}
		const result = await fn(buffer);
		return result.text ?? "";
	} catch (error) {
		return `[PDF 解析失败：${error instanceof Error ? error.message : String(error)}]`;
	}
}
