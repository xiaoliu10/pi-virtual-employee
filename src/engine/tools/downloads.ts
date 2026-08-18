/**
 * Download / file-content tools. Registered when browser + downloads are on.
 *
 * These close the "downloaded a file but can't read it" gap: the passive
 * browser funnel saves downloads into a managed workspace; here the employee
 * lists them, reads text/doc/spreadsheet content, and — for very large
 * exports — can analyze a spreadsheet via aggregation instead of dumping every
 * row into the model context (preview reads up to 5,000 rows directly; beyond
 * that, summary mode aggregates without loading the whole sheet).
 *
 * Trust: reads are confined to the managed downloads dir + configured filesystem
 * allowedDirs (DownloadService.isReadable). Deletion is NOT offered here — that
 * stays on the two-step delete_files tool.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { DownloadService } from "../../downloads/download-service.js";
import type { BrowserService } from "../../browser/browser-service.js";
import { extractText, parseSpreadsheet } from "../../knowledge/file-parser.js";

const READ_DEFAULT_BYTES = 64 * 1024;
const SPREADSHEET_EXT = new Set([".xls", ".xlsx", ".xlsm"]);
const PREVIEW_DEFAULT_ROWS = 20;
// 5000 rows is the practical context budget for direct row-by-row reading
// (~80 chars/row ≈ 400KB text); beyond that the model should aggregate first.
const PREVIEW_MAX_ROWS = 5000;
const SUMMARY_MAX_GROUPS = 200;

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details };
}

function errorResult(err: unknown): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: `文件操作失败：${(err as Error).message}` }],
		details: { ok: false, error: (err as Error).message },
	};
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function createDownloadTools(
	downloadService: DownloadService,
	browser: BrowserService,
	/** 当前会话归属（ownerId，即 conversationId）：触发下载时操作该会话专属的浏览器 Page。 */
	resolveOwnerId: () => string = () => "default",
): AgentTool[] {
	const listDownloads: AgentTool = {
		name: "list_downloads",
		label: "下载：列出已下载文件",
		description:
			"列出浏览器最近下载并保存到受管目录的文件（文件名、大小、来源网址、下载页面、时间、状态）。浏览器下载会自动存盘，用本工具找到文件后，再用 read_file 读取或 inspect_spreadsheet 分析表格。",
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ description: "返回条数，默认 20，最多 100" })),
		}),
		async execute(_id, params) {
			try {
				const limit = (params as { limit?: number }).limit;
				const rows = downloadService.listRecent(limit);
				if (rows.length === 0) return textResult("还没有已下载的文件。浏览器触发的下载会自动存到这里。", { ok: true, count: 0 });
				const lines = rows.map(
					(r) =>
						`- ${r.suggestedFilename}（${fmtBytes(r.sizeBytes)}，${new Date(r.createdAt).toLocaleString("zh-CN")}）${
							r.status === "ok" ? "" : ` [${r.status}]`
						}\n  路径：${r.savedPath}\n  来源：${r.url || "(未知)"}`,
				);
				return textResult(`已下载文件（最近 ${rows.length} 个）：\n\n${lines.join("\n\n")}`, { ok: true, count: rows.length, rows });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const readFileTool: AgentTool = {
		name: "read_file",
		label: "文件：读取内容",
		description:
			"读取一个已下载/受管文件的文本内容。支持 txt/md/csv/json/html/log（原文）、docx（正文）、xlsx/xls（转 CSV 文本）、pdf（正文）。二进制或超大文件按 maxBytes（默认 64KB）截断并标注。表格文件若要按结构/聚合分析，请改用 inspect_spreadsheet。仅可读取受管下载目录或已配置允许目录内的文件。",
		parameters: Type.Object({
			path: Type.String({ description: "文件绝对路径（来自 list_downloads 或允许目录内）" }),
			maxBytes: Type.Optional(Type.Integer({ description: "最多读取的字节数，默认 65536" })),
		}),
		async execute(_id, params) {
			try {
				const p = params as { path: string; maxBytes?: number };
				if (!downloadService.isReadable(p.path)) {
					return textResult(`该路径不在可读取范围内（受管下载目录或已配置允许目录之外）：${p.path}`, { ok: false });
				}
				const st = await stat(p.path);
				if (st.isDirectory()) return textResult("目标是一个目录，不能读取。请用 list_directory 查看，或指定一个文件路径。", { ok: false });
				const max = Math.max(512, p.maxBytes ?? READ_DEFAULT_BYTES);
				const ext = extname(p.path).toLowerCase();
				if (SPREADSHEET_EXT.has(ext)) {
					// Spreadsheets as text tend to be huge — steer to the structured tool.
					return textResult(
						`这是表格文件（${ext}），直接转文本会很大且难分析。建议改用 inspect_spreadsheet：先用 mode=preview 看表头和样本行，再用 mode=summary 按列聚合分析（如按机构/地区分组计数）。文件路径：${p.path}`,
						{ ok: true, hint: "use_inspect_spreadsheet", path: p.path },
					);
				}
				const text = await extractText(p.path);
				const truncated = text.length > max;
				const body = truncated ? text.slice(0, max) + "\n\n…（已截断，共 " + text.length + " 字符；如需更多可调大 maxBytes）" : text;
				return textResult(`文件：${p.path}（${fmtBytes(st.size)}）\n\n${body}`, { ok: true, path: p.path, truncated, size: st.size });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const inspectSpreadsheet: AgentTool = {
		name: "inspect_spreadsheet",
		label: "表格：结构化分析",
		description:
				"结构化分析 xlsx/xls/xlsm 表格。两种模式：preview（默认）返回工作表列表、行列数、表头和前 N 行样本（默认20，可调大到最多 5000 行全量读取，带类型推断）；summary 做聚合——给定 groupBy 列按组计数/求和/平均等，不给 groupBy 则返回总行数和各数值列的 sum/avg/min/max。行数不超过 5000 的表用 preview 全量读取即可；超过 5000 行的超大表才需要用 summary 模式先聚合再下结论。",
		parameters: Type.Object({
			path: Type.String({ description: "表格文件绝对路径" }),
			sheet: Type.Optional(Type.String({ description: "工作表名，默认第一个" })),
			mode: Type.Optional(Type.Union([Type.Literal("preview"), Type.Literal("summary")], { description: "preview=预览表头与样本行（默认）；summary=聚合统计" })),
			groupBy: Type.Optional(Type.String({ description: "summary 模式按此列分组（列名，表头须存在）" })),
			aggColumn: Type.Optional(Type.String({ description: "summary 模式要聚合的数值列（默认仅计数）" })),
			aggFunc: Type.Optional(Type.Union(
				[Type.Literal("sum"), Type.Literal("count"), Type.Literal("avg"), Type.Literal("min"), Type.Literal("max")],
				{ description: "聚合方式，默认 count" },
			)),
				limit: Type.Optional(Type.Integer({ description: "preview 样本行数（默认20，最多可到 5000 全量）；summary 分组上限200" })),
		}),
		async execute(_id, params) {
			try {
				const p = params as {
					path: string;
					sheet?: string;
					mode?: "preview" | "summary";
					groupBy?: string;
					aggColumn?: string;
					aggFunc?: "sum" | "count" | "avg" | "min" | "max";
					limit?: number;
				};
				if (!downloadService.isReadable(p.path)) {
					return textResult(`该路径不在可读取范围内：${p.path}`, { ok: false });
				}
				const ext = extname(p.path).toLowerCase();
				if (!SPREADSHEET_EXT.has(ext)) {
					return textResult(`inspect_spreadsheet 仅支持 xls/xlsx/xlsm，该文件是 ${ext || "(无扩展名)"}。文本类用 read_file。`, { ok: false });
				}
				const parsed = await parseSpreadsheet(p.path);
				const sheetName = p.sheet ?? parsed.sheets[0]?.name;
				const sheetSummary = parsed.sheets.find((s) => s.name === sheetName) ?? parsed.sheets[0];
				if (!sheetName || !sheetSummary) return textResult("未找到任何工作表。", { ok: false });

				if ((p.mode ?? "preview") === "preview") {
					const want = Math.min(PREVIEW_MAX_ROWS, Math.max(1, p.limit ?? PREVIEW_DEFAULT_ROWS));
					const sheet = parsed.workbook.Sheets[sheetName];
					const samples = readPreviewRows(sheet, sheetSummary, want);
					const headerLine = formatHeaderRow(sheetSummary.headers);
					const lines = [
						`工作表：${sheetName}（${sheetSummary.totalRows} 行 × ${sheetSummary.totalCols} 列）`,
						`全部工作表：${parsed.sheets.map((s) => `${s.name}(${s.totalRows}×${s.totalCols})`).join("， ")}`,
						`表头：${headerLine}`,
						"",
						`前 ${samples.length} 行样本：`,
						...samples.map((r) => "  " + r.join(" | ")),
					];
					return textResult(lines.join("\n"), { ok: true, sheet: sheetName, rows: sheetSummary.totalRows, cols: sheetSummary.totalCols });
				}

				// summary mode
				const sheet = parsed.workbook.Sheets[sheetName];
				const { headers, totalRows } = sheetSummary;
				const gCol = p.groupBy ? findColIndex(headers, p.groupBy) : -1;
				const aCol = p.aggColumn ? findColIndex(headers, p.aggColumn) : -1;
				const func = p.aggFunc ?? "count";
				if (p.groupBy && gCol < 0) return textResult(`未找到分组列「${p.groupBy}」。可用列：${formatHeaderRow(headers)}`, { ok: false });
				if (p.aggColumn && aCol < 0) return textResult(`未找到聚合列「${p.aggColumn}」。可用列：${formatHeaderRow(headers)}`, { ok: false });

				if (gCol >= 0) {
					const groups = aggregateByGroup(sheet, sheetSummary, gCol, aCol, func);
					const cap = SUMMARY_MAX_GROUPS;
					const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
					const truncated = sorted.length > cap;
					const shown = truncated ? sorted.slice(0, cap) : sorted;
					const lines = [
						`工作表：${sheetName}（共 ${totalRows} 行），按「${headers[gCol] ?? gCol}」分组，${describeFunc(func, headers[aCol])}`,
						`分组数：${groups.size}${truncated ? `（仅显示最多的 ${cap} 组）` : ""}`,
						"",
						...shown.map(([k, v]) => `  ${k ?? "(空)"}：${v.count} 行${aCol >= 0 ? `，${describeFunc(func, headers[aCol])}=${fmtNum(v.value)}` : ""}`),
					];
					return textResult(lines.join("\n"), { ok: true, mode: "summary", groupCount: groups.size, truncated, groups: shown });
				}

				// no groupBy → per-numeric-column stats
				const stats = numericColumnStats(sheet, sheetSummary);
				const lines = [
					`工作表：${sheetName}（共 ${totalRows} 行）数值列统计：`,
					"",
					...stats.map((s) => `  ${s.name}：合计=${fmtNum(s.sum)}，平均=${fmtNum(s.avg)}，最小=${fmtNum(s.min)}，最大=${fmtNum(s.max)}，非空=${s.count}`),
				];
				if (stats.length === 0) lines.push("  （无数值列；如需计数请用 groupBy 按某列分组）");
				return textResult(lines.join("\n"), { ok: true, mode: "summary", rows: totalRows, stats });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const browserDownload: AgentTool = {
		name: "browser_download",
		label: "浏览器：触发下载",
		description:
			"点击当前页面上一个会触发文件下载的元素（导出/下载按钮、链接），自动等待下载完成并存入受管下载目录。用于页面点击会弹出『另存为』/直接下载文件的场景。下载完成后用 list_downloads 找到文件，再用 read_file 或 inspect_spreadsheet 处理。",
		parameters: Type.Object({
			selector: Type.String({ description: "会触发下载的元素的 CSS 选择器，如 'button.export'、'a.download-link'" }),
		}),
		async execute(_id, params) {
			try {
				const selector = (params as { selector: string }).selector;
				const meta = await browser.clickAndDownload(resolveOwnerId(), selector);
				return textResult(
					`已点击并触发下载：${meta.suggestedFilename}（来源 ${meta.url || "(未知)"}）。文件已自动存入受管目录，用 list_downloads 查看，再 read_file / inspect_spreadsheet 处理。`,
					{ ok: true, ...meta },
				);
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	return [listDownloads, readFileTool, inspectSpreadsheet, browserDownload];
}

// ─────────────────── spreadsheet helpers (operate on the xlsx sheet object) ───────────────────

interface CellRangeLite {
	firstRow: number;
	lastRow: number;
	firstCol: number;
	lastCol: number;
}

function decodeRange(ref: string | undefined): CellRangeLite | null {
	if (!ref) return null;
	const parts = ref.split(":");
	const start = parseAddr(parts[0]);
	const end = parts[1] ? parseAddr(parts[1]) : start;
	if (!start || !end) return null;
	return {
		firstRow: start.row,
		lastRow: Math.max(start.row, end.row),
		firstCol: start.col,
		lastCol: Math.max(start.col, end.col),
	};
}

function parseAddr(addr: string): { row: number; col: number } | null {
	const m = /^([A-Z]+)(\d+)$/.exec(addr.toUpperCase());
	if (!m) return null;
	return { col: colLettersToIndex(m[1]), row: parseInt(m[2], 10) - 1 };
}

function colLettersToIndex(letters: string): number {
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - "A".charCodeAt(0) + 1);
	return n - 1;
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

function cellValue(sheet: { [addr: string]: unknown }, row: number, col: number): unknown {
	const cell = sheet[`${colIndexToLetters(col)}${row + 1}`] as { v?: unknown; w?: unknown } | undefined;
	return cell?.w ?? cell?.v ?? "";
}

/** Find a column index by header label (case/trim-insensitive). */
function findColIndex(headers: unknown[], name: string): number {
	const want = name.trim().toLowerCase();
	return headers.findIndex((h) => String(h ?? "").trim().toLowerCase() === want);
}

function formatHeaderRow(headers: unknown[]): string {
	return (headers as unknown[]).map((h, i) => `[${i}] ${h ?? ""}`).join("， ");
}

/** Read up to `want` sample rows after the header, inferring a type per cell. */
function readPreviewRows(
	sheet: { [addr: string]: unknown },
	summary: { headers: unknown[]; totalRows: number; totalCols: number; firstRow?: number },
	want: number,
): unknown[][] {
	const range = decodeRange((sheet["!ref"] as string | undefined));
	const firstRow = range ? range.firstRow + 1 : 1; // +1 to skip header
	const lastRow = range ? range.lastRow : summary.totalRows;
	const firstCol = range ? range.firstCol : 0;
	const lastCol = range ? range.lastCol : summary.totalCols - 1;
	const out: unknown[][] = [];
	for (let r = firstRow; r <= lastRow && out.length < want; r++) {
		const row: unknown[] = [];
		for (let c = firstCol; c <= lastCol; c++) row.push(cellValue(sheet, r, c));
		out.push(row);
	}
	return out;
}

interface GroupAgg {
	count: number;
	value: number; // running sum (func decides how it's reported)
	min: number;
	max: number;
}

function aggregateByGroup(
	sheet: { [addr: string]: unknown },
	summary: { headers: unknown[]; totalRows: number; firstRow?: number },
	groupCol: number,
	aggCol: number,
	func: "sum" | "count" | "avg" | "min" | "max",
): Map<string, GroupAgg> {
	const range = decodeRange((sheet["!ref"] as string | undefined));
	const firstRow = range ? range.firstRow + 1 : 1;
	const lastRow = range ? range.lastRow : summary.totalRows;
	const groups = new Map<string, GroupAgg>();
	for (let r = firstRow; r <= lastRow; r++) {
		const key = String(cellValue(sheet, r, groupCol) ?? "").trim();
		const cur = groups.get(key) ?? { count: 0, value: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
		cur.count += 1;
		if (aggCol >= 0) {
			const num = toNumber(cellValue(sheet, r, aggCol));
			if (num !== null) {
				cur.value += num;
				cur.min = Math.min(cur.min, num);
				cur.max = Math.max(cur.max, num);
			}
		}
		groups.set(key, cur);
	}
	// Normalize infinities for empty numeric sets.
	for (const v of groups.values()) {
		if (!Number.isFinite(v.min)) v.min = 0;
		if (!Number.isFinite(v.max)) v.max = 0;
	}
	void func; // func is applied at display time (describeFunc + fmtNum) to keep value raw
	return groups;
}

function describeFunc(func: string, col: unknown): string {
	const name = col ?? "";
	switch (func) {
		case "sum":
			return `${name}合计`;
		case "avg":
			return `${name}平均`;
		case "min":
			return `${name}最小`;
		case "max":
			return `${name}最大`;
		default:
			return "计数";
	}
}

function fmtNum(n: number): string {
	if (!Number.isFinite(n)) return "—";
	if (Number.isInteger(n)) return String(n);
	return n.toFixed(2);
}

function toNumber(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string") {
		const s = v.trim().replace(/[,，]/g, "");
		if (s === "") return null;
		const n = Number(s);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

interface ColStat {
	name: unknown;
	sum: number;
	avg: number;
	min: number;
	max: number;
	count: number;
}

/** Stats for every column that yields at least one numeric value. */
function numericColumnStats(sheet: { [addr: string]: unknown }, summary: { headers: unknown[]; totalRows: number }): ColStat[] {
	const range = decodeRange((sheet["!ref"] as string | undefined));
	const firstRow = range ? range.firstRow + 1 : 1;
	const lastRow = range ? range.lastRow : summary.totalRows;
	const firstCol = range ? range.firstCol : 0;
	const lastCol = range ? range.lastCol : (summary.headers.length || 0) - 1;
	const out: ColStat[] = [];
	for (let c = firstCol; c <= lastCol; c++) {
		let sum = 0;
		let count = 0;
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		for (let r = firstRow; r <= lastRow; r++) {
			const n = toNumber(cellValue(sheet, r, c));
			if (n === null) continue;
			sum += n;
			count += 1;
			min = Math.min(min, n);
			max = Math.max(max, n);
		}
		if (count > 0) {
			out.push({ name: summary.headers[c] ?? `列${c}`, sum, avg: sum / count, min, max, count });
		}
	}
	return out;
}
