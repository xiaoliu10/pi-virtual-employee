/**
 * Employee portability — export/import a whole virtual employee as a `.pve`
 * package (a zip). Bundles config, conversation history, knowledge base, and
 * user skills so an employee can be cloned to a new profile or migrated to
 * another machine (cross-platform: JSON + relative paths, no absolute paths,
 * no native artifacts).
 *
 * Design notes:
 *  - Tables are dumped as JSON via `SELECT *` and restored with a column
 *    WHITELIST per table (defends against crafted packages injecting SQL via
 *    column names, and tolerates schema drift across versions).
 *  - The vector index (kb_vec) is NOT exported — it's dimension-bound to the
 *    embedding model. The caller reindexes after restore so the target's own
 *    embedding model rebuilds vectors from the imported chunks.
 *  - FTS (kb_chunks_fts) is trigger-maintained: inserting into kb_chunks
 *    auto-populates it, so no separate handling.
 */
import AdmZip from "adm-zip";
import { readdir, readFile, rm, mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import type { DB } from "../db/sqlite.js";
import type { ConfigStore } from "../db/config-store.js";
import type { KnowledgeService } from "../knowledge/knowledge-service.js";

export const PACKAGE_SCHEMA_VERSION = 1;
const PENDING_IMPORT_FILE = ".pending-import.pve";

/** What the user chose to include in the export. */
export interface ExportScope {
	history?: boolean;
	knowledge?: boolean;
	skills?: boolean;
}

export interface ExportOptions {
	includeSecrets?: boolean;
	scope?: ExportScope;
	/** Optional source profile name (recorded in the manifest). */
	profileName?: string;
	appVersion?: string;
}

export interface EmployeePackageDeps {
	db: DB;
	config: ConfigStore;
	knowledge: KnowledgeService;
	skillsDir: string;
}

interface Manifest {
	schemaVersion: number;
	appVersion: string;
	createdAt: number;
	profileName?: string;
	includes: { history: boolean; knowledge: boolean; skills: boolean };
	hasSecrets: boolean;
}

/**
 * Per-table column whitelists. Only these columns are read from a package and
 * written on restore; unknown keys are ignored. Keep in sync with sqlite.ts.
 */
const COLUMNS: Record<string, readonly string[]> = {
	conversations: ["id", "title", "created_at", "updated_at", "model_supplier_id", "model_model_id", "origin"],
	messages: ["id", "conversation_id", "role", "content", "created_at"],
	scheduled_tasks: ["id", "title", "prompt", "cron", "enabled", "conversation_id", "origin", "last_run_at", "next_run_at", "last_status", "created_at", "updated_at"],
	kb_entries: ["id", "title", "tags", "content", "created_at", "updated_at", "origin", "archived", "version", "lineage", "confidence", "source_url", "review_status", "hit_count", "last_used_at", "superseded_by"],
	kb_chunks: ["id", "source", "source_id", "title", "tags", "content", "created_at", "updated_at", "chunk_index", "metadata", "embed_status", "embedding_model"],
	kb_docs: ["id", "name", "chunks", "created_at"],
	kb_gaps: ["id", "query", "count", "last_seen", "created_at"],
};

const SECRET_KEYS = /^(apiKey|appSecret|apiSecret|secret|token)$/i;

// ───────────────────────── build (export) ─────────────────────────

/** Build a `.pve` package buffer from the current employee. */
export async function buildEmployeePackage(deps: EmployeePackageDeps, opts: ExportOptions = {}): Promise<Buffer> {
	const scope = { history: true, knowledge: true, skills: true, ...opts.scope };
	const fullConfig = deps.config.all();
	const configForExport = opts.includeSecrets ? fullConfig : sanitizeSecrets(fullConfig);

	const zip = new AdmZip();
	const includes = { history: !!scope.history, knowledge: !!scope.knowledge, skills: !!scope.skills };
	const manifest: Manifest = {
		schemaVersion: PACKAGE_SCHEMA_VERSION,
		appVersion: opts.appVersion ?? "",
		createdAt: Date.now(),
		profileName: opts.profileName,
		includes,
		hasSecrets: !!opts.includeSecrets,
	};
	zip.addFile("employee.json", Buffer.from(JSON.stringify(manifest, null, 2)));
	zip.addFile("config.json", Buffer.from(JSON.stringify(configForExport, null, 2)));

	if (scope.history) {
		const history = {
			conversations: dumpTable(deps.db, "conversations"),
			messages: dumpTable(deps.db, "messages"),
			scheduledTasks: dumpTable(deps.db, "scheduled_tasks"),
		};
		zip.addFile("history.json", Buffer.from(JSON.stringify(history)));
	}
	if (scope.knowledge) {
		const knowledge = {
			entries: dumpTable(deps.db, "kb_entries"),
			chunks: dumpTable(deps.db, "kb_chunks"),
			docs: dumpTable(deps.db, "kb_docs"),
			gaps: dumpTable(deps.db, "kb_gaps"),
		};
		zip.addFile("knowledge.json", Buffer.from(JSON.stringify(knowledge)));
	}
	if (scope.skills) {
		await addDirToZip(zip, deps.skillsDir, "skills");
	}
	return zip.toBuffer();
}

// ───────────────────────── apply (import) ─────────────────────────

export interface ImportSummary {
	manifest: Manifest;
	counts: { conversations: number; messages: number; scheduledTasks: number; entries: number; chunks: number; docs: number; skills: number };
}

/**
 * Restore a `.pve` package into the current stores. Idempotent (ON CONFLICT).
 * Does NOT reindex vectors — the caller decides when (see module doc).
 * @param clearSkills  wipe skillsDir before extracting (overwrite semantics)
 */
export async function importEmployeePackage(
	buffer: Buffer,
	deps: EmployeePackageDeps,
	options: { clearSkills?: boolean } = {},
): Promise<ImportSummary> {
	const zip = new AdmZip(buffer);
	const manifest = parseEntry<Manifest>(zip, "employee.json");
	if (manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
		throw new Error(`不支持的员工包版本(schemaVersion=${manifest.schemaVersion})`);
	}

	const configJson = parseEntry<unknown>(zip, "config.json");
	deps.config.replaceAll(configJson);

	const counts = { conversations: 0, messages: 0, scheduledTasks: 0, entries: 0, chunks: 0, docs: 0, skills: 0 };

	if (manifest.includes.history && zip.getEntry("history.json")) {
		const h = parseEntry<{ conversations: unknown[]; messages: unknown[]; scheduledTasks: unknown[] }>(zip, "history.json");
		counts.conversations = restoreTable(deps.db, "conversations", h.conversations);
		counts.messages = restoreTable(deps.db, "messages", h.messages);
		counts.scheduledTasks = restoreTable(deps.db, "scheduled_tasks", h.scheduledTasks);
	}
	if (manifest.includes.knowledge && zip.getEntry("knowledge.json")) {
		const k = parseEntry<{ entries: unknown[]; chunks: unknown[]; docs: unknown[]; gaps: unknown[] }>(zip, "knowledge.json");
		counts.entries = restoreTable(deps.db, "kb_entries", k.entries);
		counts.chunks = restoreTable(deps.db, "kb_chunks", k.chunks);
		counts.docs = restoreTable(deps.db, "kb_docs", k.docs);
		restoreTable(deps.db, "kb_gaps", k.gaps); // gaps are best-effort, uncounted
	}
	if (manifest.includes.skills) {
		counts.skills = await extractSkills(zip, deps.skillsDir, !!options.clearSkills);
	}

	return { manifest, counts };
}

// ───────────────────────── pending-import boot hook ─────────────────────────

/**
 * On boot, if a `.pending-import.pve` sits in the profile dir (written when the
 * user chose "new profile" on import), restore it into this (fresh) profile and
 * remove the marker. This is the clone path — the same restore code runs in the
 * newly launched profile. Reindexes in the background.
 */
export async function applyPendingImport(deps: EmployeePackageDeps): Promise<boolean> {
	const pendingPath = pendingImportPath(dirname(deps.skillsDir));
	if (!existsSync(pendingPath)) return false;
	try {
		console.log("[main] applying pending employee import…");
		const buffer = await readFile(pendingPath);
		await importEmployeePackage(buffer, deps, { clearSkills: true });
		void deps.knowledge.reindex().catch((err) => console.warn("[main] post-import reindex failed:", err));
		console.log("[main] pending employee import applied");
	} catch (err) {
		console.error("[main] pending employee import failed:", err);
	} finally {
		await unlink(pendingPath).catch(() => {});
	}
	return true;
}

/** Path of the pending-import marker inside a profile dir. */
export function pendingImportPath(profileDir: string): string {
	return join(profileDir, PENDING_IMPORT_FILE);
}

// ───────────────────────── secrets ─────────────────────────

/** Deep-clone `value` and blank any field whose name looks like a secret. */
export function sanitizeSecrets<T>(value: T): T {
	return walk(value) as T;

	function walk(v: unknown): unknown {
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				out[k] = SECRET_KEYS.test(k) && typeof val === "string" ? "" : walk(val);
			}
			return out;
		}
		return v;
	}
}

// ───────────────────────── table dump/restore ─────────────────────────

function dumpTable(db: DB, table: string): Record<string, unknown>[] {
	return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

/** Idempotently upsert rows into `table` (only whitelisted columns). Returns count. */
function restoreTable(db: DB, table: string, rows: unknown): number {
	const allowed = COLUMNS[table];
	if (!allowed || !Array.isArray(rows) || rows.length === 0) return 0;
	const cols = allowed; // only known columns
	const colList = cols.join(", ");
	const placeholders = cols.map(() => "?").join(", ");
	const updates = cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ");
	const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
	const stmt = db.prepare(sql);
	const txn = db.transaction((items: Record<string, unknown>[]) => {
		for (const row of items) {
			const args = cols.map((c) => (row[c] ?? null));
			stmt.run(...(args as never[]));
		}
	});
	txn(rows as Record<string, unknown>[]);
	return rows.length;
}

// ───────────────────────── skills dir ─────────────────────────

async function addDirToZip(zip: InstanceType<typeof AdmZip>, absDir: string, zipRoot: string): Promise<void> {
	if (!existsSync(absDir)) return;
	for (const abs of await walkFiles(absDir)) {
		const rel = relative(absDir, abs).split(/[\\/]/).join("/");
		zip.addFile(`${zipRoot}/${rel}`, await readFile(abs));
	}
}

async function walkFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walkFiles(full)));
		else out.push(full);
	}
	return out;
}

async function extractSkills(zip: InstanceType<typeof AdmZip>, skillsDir: string, clear: boolean): Promise<number> {
	await mkdir(skillsDir, { recursive: true });
	if (clear) await rm(skillsDir, { recursive: true, force: true }).catch(() => {});
	await mkdir(skillsDir, { recursive: true });
	let n = 0;
	for (const entry of zip.getEntries()) {
		const name = entry.entryName;
		if (!name.startsWith("skills/")) continue;
		if (name.endsWith("/")) continue; // directory entry
		const rel = name.slice("skills/".length);
		if (!rel || rel.includes("..")) continue; // guard against path traversal
		const dest = join(skillsDir, ...rel.split("/"));
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, entry.getData());
		n++;
	}
	return n;
}

function parseEntry<T>(zip: InstanceType<typeof AdmZip>, name: string): T {
	const entry = zip.getEntry(name);
	if (!entry) throw new Error(`员工包缺少 ${name}`);
	return JSON.parse(entry.getData().toString("utf8")) as T;
}
