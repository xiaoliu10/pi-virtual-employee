/**
 * File content extraction + structured spreadsheet parsing, shared by knowledge
 * imports and the employee's download/read tools.
 *
 * `extractText` is the text fallback (PDF/DOCX/XLSX/HTML/TXT → plain text).
 * `parseSpreadsheet` returns structured sheet metadata + the workbook so callers
 * can do their own analysis (preview rows, aggregations) without re-reading.
 *
 * Extracted here (out of knowledge/store.ts) so the engine's download tools can
 * reuse it without pulling in the whole KB store, and so XLSX parsing lives in
 * exactly one place.
 */
import { readFile } from "node:fs/promises";
import type { WorkBook } from "xlsx";

/** One sheet's structural summary (no cell data — keeps it small). */
export interface SheetSummary {
	name: string;
	totalRows: number;
	totalCols: number;
	headers: unknown[];
}

export interface ParsedSpreadsheet {
	sheets: SheetSummary[];
	workbook: WorkBook;
}

/** Best-effort plain-text extraction by file extension. Degrades cleanly. */
export async function extractText(absPath: string): Promise<string> {
	const lower = absPath.toLowerCase();
	if (lower.endsWith(".pdf")) {
		const { extractPdfText } = await import("../db/pdf-text.js");
		return extractPdfText(absPath);
	}
	if (lower.endsWith(".docx")) {
		const mammoth = await import("mammoth");
		const result = await mammoth.extractRawText({ path: absPath });
		return result.value;
	}
	if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
		const xlsx = await import("xlsx");
		const utils = xlsx.utils ?? (xlsx as unknown as { default?: { utils?: typeof xlsx.utils } }).default?.utils;
		const wb = await readWorkbook(absPath);
		return wb.SheetNames.map((name) => {
			const csv = utils?.sheet_to_csv(wb.Sheets[name]) ?? "";
			return `## ${name}\n${csv}`;
		}).join("\n\n");
	}
	if (lower.endsWith(".html") || lower.endsWith(".htm")) {
		const raw = await readFile(absPath, "utf8");
		return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
	}
	// txt / md / markdown / csv / json / log — read raw.
	return readFile(absPath, "utf8");
}

/** Load an XLS/XLSX workbook (handles both named and default export of xlsx). */
export async function readWorkbook(absPath: string): Promise<WorkBook> {
	const xlsx = await import("xlsx");
	const readFileAny = (xlsx.readFile ?? (xlsx as unknown as { default: { readFile: typeof xlsx.readFile } }).default?.readFile) as (p: string) => WorkBook;
	return readFileAny(absPath);
}

/** Structured sheet list: names, dimensions, header row — without dumping cells. */
export async function parseSpreadsheet(absPath: string): Promise<ParsedSpreadsheet> {
	const workbook = await readWorkbook(absPath);
	const sheets: SheetSummary[] = workbook.SheetNames.map((name) => {
		const sheet = workbook.Sheets[name];
		const ref = sheet?.["!ref"];
		let totalRows = 0;
		let totalCols = 0;
		let headers: unknown[] = [];
		if (ref) {
			const range = safeDecodeRange(ref);
			totalRows = range.lastRow - range.firstRow + 1;
			totalCols = range.lastCol - range.firstCol + 1;
			headers = range.firstRow <= range.lastRow ? readRow(sheet, range.firstRow, range.firstCol, range.lastCol) : [];
		}
		return { name, totalRows, totalCols, headers };
	});
	return { sheets, workbook };
}

interface CellRange {
	firstRow: number;
	lastRow: number;
	firstCol: number;
	lastCol: number;
}

/** Decode an A1 range like "A1:F1844" without pulling in xlsx's decoder. */
function safeDecodeRange(ref: string): CellRange {
	// Split "A1:F1844" → ["A1", "F1844"]. A whole-column/whole-sheet ref may be
	// just "A1"; tolerate a missing colon by treating the single addr as both ends.
	const parts = ref.split(":");
	const start = parseAddr(parts[0]);
	const end = parts[1] ? parseAddr(parts[1]) : start;
	return {
		firstRow: start.row,
		lastRow: Math.max(start.row, end.row),
		firstCol: start.col,
		lastCol: Math.max(start.col, end.col),
	};
}

function parseAddr(addr: string): { row: number; col: number } {
	const match = /^([A-Z]+)(\d+)$/.exec(addr.toUpperCase());
	if (!match) return { row: 0, col: 0 };
	return { col: colLettersToIndex(match[1]), row: parseInt(match[2], 10) - 1 };
}

function colLettersToIndex(letters: string): number {
	// "A" → 0, "Z" → 25, "AA" → 26, … (0-indexed column).
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - "A".charCodeAt(0) + 1);
	return n - 1;
}

/** Read one row's cell values as a plain array (cols firstCol..lastCol). */
function readRow(sheet: { [addr: string]: unknown }, row: number, firstCol: number, lastCol: number): unknown[] {
	const out: unknown[] = [];
	for (let c = firstCol; c <= lastCol; c++) {
		const cell = sheet[`${colIndexToLetters(c)}${row + 1}`] as { v?: unknown; w?: unknown } | undefined;
		out.push(cell?.w ?? cell?.v ?? "");
	}
	return out;
}

function colIndexToLetters(index: number): string {
	let n = index + 1;
	let s = "";
	while (n > 0) {
		const rem = (n - 1) % 26;
		s = String.fromCharCode("A".charCodeAt(0) + rem) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}
