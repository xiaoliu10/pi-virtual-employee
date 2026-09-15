/**
 * SQLite connection + schema migrations (better-sqlite3).
 *
 * The DB lives under the Electron `userData` dir (path passed in by the main
 * process) so config, conversations, messages and the knowledge base persist
 * across launches.
 */
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export type DB = DatabaseType;

export function openDatabase(path: string, nativeBinding?: string): DB {
	// Packaged cross-platform builds ship the target better-sqlite3 addon under
	// resources/native. Passing it explicitly avoids loading the build-host addon
	// (e.g. darwin-arm64 inside a Windows x64 package).
	const db = new Database(path, nativeBinding ? { nativeBinding } : undefined);
	db.pragma("journal_mode = WAL");
	migrate(db);
	return db;
}

/**
 * Close a Database before the process exits during an auto-update install.
 * better-sqlite3 holds a native SQLite handle; an open connection keeps the
 * DB + WAL file locked AND keeps the .node addon mapped into the process.
 * NSIS overwriting resources/ while the old process still maps the addon is
 * the file-replace race behind spurious "NODE_MODULE_VERSION" ABI errors and
 * half-overwritten installs. Closing here releases the handle so the silent
 * installer can replace files cleanly before the watchdog relaunches.
 */
export function closeDatabase(db: DB): void {
	try {
		db.pragma("wal_checkpoint(TRUNCATE)");
	} catch {
		/* best-effort checkpoint; close still releases the handle */
	}
	try {
		db.close();
	} catch {
		/* already closed or never opened — close is idempotent enough */
	}
}

function migrate(db: DB): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS config (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS conversations (
			id                TEXT PRIMARY KEY,
			title             TEXT,
			created_at        INTEGER NOT NULL,
			updated_at        INTEGER NOT NULL,
			model_supplier_id TEXT,
			model_model_id    TEXT,
			origin            TEXT NOT NULL DEFAULT 'console'
		);
		CREATE TABLE IF NOT EXISTS messages (
			id              TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			role            TEXT NOT NULL,
			content         TEXT,
			created_at      INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

		CREATE TABLE IF NOT EXISTS kb_entries (
			id         TEXT PRIMARY KEY,
			title      TEXT,
			tags       TEXT,
			content    TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS kb_chunks (
			id         TEXT PRIMARY KEY,
			source     TEXT NOT NULL,
			source_id  TEXT,
			title      TEXT,
			tags       TEXT,
			content    TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS kb_docs (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			chunks     INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON kb_chunks(source, source_id);

		-- Runtime state for the knowledge base (vec availability / dims / model, …).
		CREATE TABLE IF NOT EXISTS kb_state (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		-- IM 会话成员花名册：由入站消息逐条累积（staff_id 来自平台签名载荷，不是
		-- 消息文本）。用途：管理员在单聊里说「给这个群的人设权限」时，能列出该群
		-- 真实出现过的成员，而不是让模型猜 staffId。只含发过消息的人——机器人
		-- 未必有平台「列出群成员」的权限，这是唯一可核实的来源，工具会如实标注。
		CREATE TABLE IF NOT EXISTS conversation_members (
			conversation_id TEXT NOT NULL,
			staff_id        TEXT NOT NULL,
			name            TEXT,
			first_seen_at   INTEGER NOT NULL,
			last_seen_at    INTEGER NOT NULL,
			message_count   INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (conversation_id, staff_id)
		);

		-- 运行遥测：每条「回合」一行、每次「工具调用」一行。存在的唯一理由是让员工
		-- 能看见自己的真实表现——在此之前，重试次数/步数封顶/看门狗中断/空回复只
		-- 存在于日志和瞬间里，模型无从知道自己哪儿反复失败，任何「自我改进」都只能
		-- 靠感觉。写入是本地的、短字段截断的；不发往任何外部服务。
		CREATE TABLE IF NOT EXISTS turn_events (
			id              TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			origin          TEXT NOT NULL DEFAULT 'console',
			actor_id        TEXT,
			channel         TEXT,
			chat_type       TEXT,
			started_at      INTEGER NOT NULL,
			duration_ms     INTEGER NOT NULL DEFAULT 0,
			status          TEXT NOT NULL,
			error           TEXT,
			tool_calls      INTEGER NOT NULL DEFAULT 0,
			retries         INTEGER NOT NULL DEFAULT 0,
			step_cap_hit    INTEGER NOT NULL DEFAULT 0,
			empty_reply     INTEGER NOT NULL DEFAULT 0,
			deterministic   INTEGER NOT NULL DEFAULT 0,
			abort_reason    TEXT,
			correction      INTEGER NOT NULL DEFAULT 0,
			reply_len       INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_turn_events_started ON turn_events(started_at);
		CREATE INDEX IF NOT EXISTS idx_turn_events_conv ON turn_events(conversation_id, started_at);

		CREATE TABLE IF NOT EXISTS tool_events (
			id              TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			turn_id         TEXT,
			name            TEXT NOT NULL,
			started_at      INTEGER NOT NULL,
			duration_ms     INTEGER NOT NULL DEFAULT 0,
			ok              INTEGER NOT NULL DEFAULT 1,
			refused         INTEGER NOT NULL DEFAULT 0,
			refused_capability TEXT,
			error           TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_tool_events_started ON tool_events(started_at);
		CREATE INDEX IF NOT EXISTS idx_tool_events_name ON tool_events(name, started_at);
	`);
	// Add per-conversation model columns to pre-existing tables.
	const cols = new Set(
		(db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).map((r) => r.name),
	);
	if (!cols.has("model_supplier_id")) db.exec("ALTER TABLE conversations ADD COLUMN model_supplier_id TEXT");
	if (!cols.has("model_model_id")) db.exec("ALTER TABLE conversations ADD COLUMN model_model_id TEXT");
	// origin ('console' | 'im') marks where a conversation was created, so the
	// console UI can render IM sessions read-only. Existing rows predate IM and
	// get backfilled by inferring from their id below.
	if (!cols.has("origin")) db.exec("ALTER TABLE conversations ADD COLUMN origin TEXT NOT NULL DEFAULT 'console'");
	// Backfill origin for pre-existing IM conversations (channel-prefixed ids).
	// Only known IM prefixes count — scheduled-task ids (sched:…) are NOT IM.
	db.exec(
		"UPDATE conversations SET origin = 'im' WHERE origin = 'console' AND " +
			"(id LIKE 'dt:%' OR id LIKE 'feishu:%' OR id LIKE 'wecom:%' OR id LIKE 'echo:%')",
	);

	// Knowledge chunks: add chunk index + metadata + embedding-lifecycle columns
	// to pre-existing tables. The vec0 virtual table itself is created lazily by
	// VecStore (P1) once the embedding dimension is known.
	const kbCols = new Set(
		(db.prepare("PRAGMA table_info(kb_chunks)").all() as { name: string }[]).map((r) => r.name),
	);
	if (!kbCols.has("chunk_index")) db.exec("ALTER TABLE kb_chunks ADD COLUMN chunk_index INTEGER");
	if (!kbCols.has("metadata")) db.exec("ALTER TABLE kb_chunks ADD COLUMN metadata TEXT");
	// Which capability a refusal was about, as a structured field. Clustering
	// "which kind of request keeps getting denied" must not depend on parsing the
	// refusal sentence we happen to write today.
	const toolCols = new Set(
		(db.prepare("PRAGMA table_info(tool_events)").all() as { name: string }[]).map((r) => r.name),
	);
	if (!toolCols.has("refused_capability")) db.exec("ALTER TABLE tool_events ADD COLUMN refused_capability TEXT");
	if (!kbCols.has("embed_status")) db.exec("ALTER TABLE kb_chunks ADD COLUMN embed_status TEXT DEFAULT 'pending'");
	if (!kbCols.has("embedding_model")) db.exec("ALTER TABLE kb_chunks ADD COLUMN embedding_model TEXT");

	// Knowledge entries: origin tracks how an entry was produced (manual/learned/
	// derived) for the auto-learn system; archived is a soft-delete flag used by
	// consolidation (archive instead of hard delete, so it stays recoverable).
	const entryCols = new Set(
		(db.prepare("PRAGMA table_info(kb_entries)").all() as { name: string }[]).map((r) => r.name),
	);
	if (!entryCols.has("origin")) db.exec("ALTER TABLE kb_entries ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
	if (!entryCols.has("archived")) db.exec("ALTER TABLE kb_entries ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
	// Production auto-sedimentation: versioning, lineage, confidence, provenance,
	// review status, usage feedback, supersession. All additive with safe defaults.
	if (!entryCols.has("version")) db.exec("ALTER TABLE kb_entries ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
	if (!entryCols.has("lineage")) db.exec("ALTER TABLE kb_entries ADD COLUMN lineage TEXT");
	if (!entryCols.has("confidence")) db.exec("ALTER TABLE kb_entries ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5");
	if (!entryCols.has("source_url")) db.exec("ALTER TABLE kb_entries ADD COLUMN source_url TEXT");
	if (!entryCols.has("review_status")) db.exec("ALTER TABLE kb_entries ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved'");
	if (!entryCols.has("hit_count")) db.exec("ALTER TABLE kb_entries ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0");
	if (!entryCols.has("last_used_at")) db.exec("ALTER TABLE kb_entries ADD COLUMN last_used_at INTEGER");
	if (!entryCols.has("superseded_by")) db.exec("ALTER TABLE kb_entries ADD COLUMN superseded_by TEXT");

	// Knowledge gaps: queries that missed the KB, feeding the auto-research loop.
	db.exec(`
		CREATE TABLE IF NOT EXISTS kb_gaps (
			id         TEXT PRIMARY KEY,
			query      TEXT NOT NULL,
			count      INTEGER NOT NULL DEFAULT 1,
			last_seen  INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_kb_gaps_last_seen ON kb_gaps(last_seen);
	`);

	// Scheduled tasks: created in conversation (or via settings) and run by the
	// scheduler at their cron time. Each fire runs the employee on `prompt`.
	db.exec(`
		CREATE TABLE IF NOT EXISTS scheduled_tasks (
			id              TEXT PRIMARY KEY,
			title           TEXT NOT NULL,
			prompt          TEXT NOT NULL,
			cron            TEXT NOT NULL,
			enabled         INTEGER NOT NULL DEFAULT 1,
			conversation_id TEXT,
			origin          TEXT NOT NULL DEFAULT 'console',
			created_by      TEXT,
			last_run_at     INTEGER,
			next_run_at     INTEGER,
			last_status     TEXT,
			created_at      INTEGER NOT NULL,
			updated_at      INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
	`);
	// created_by: platform senderId of the admin who created the task in a 1:1
	// chat. The scheduler re-attaches this identity at fire time so guarded
	// tools (run_command) can authorize unattended runs — re-validated against
	// the live admin whitelist on every fire. NULL = created from the console
	// settings UI (no verified identity) → runs without admin-gated tools.
	const taskCols = new Set(
		(db.prepare("PRAGMA table_info(scheduled_tasks)").all() as { name: string }[]).map((r) => r.name),
	);
	if (!taskCols.has("created_by")) db.exec("ALTER TABLE scheduled_tasks ADD COLUMN created_by TEXT");

	// Document resources: a catalog of deliverable docs the employee can hand to
	// integration partners. kind=file points at a copied file under documents.dir;
	// kind=link holds an online URL. partners/scenario drive "give which doc to
	// whom in what situation" matching. Distinct from kb_chunks (full-text search
	// of doc *content*) — this is metadata-driven retrieval of whole documents.
	db.exec(`
		CREATE TABLE IF NOT EXISTS resources (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			description TEXT,
			kind        TEXT NOT NULL,              -- 'file' | 'link'
			file_path   TEXT,                       -- abs path (kind=file)
			url         TEXT,                       -- online URL (kind=link)
			partners    TEXT,                       -- JSON array of recipient/partner names
			scenario    TEXT,                       -- when to provide this doc
			tags        TEXT,                       -- JSON array of tags
			created_at  INTEGER NOT NULL,
			updated_at  INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_resources_updated ON resources(updated_at DESC);
	`);

	// Report / artifact center: generated reports (scheduled-task outputs, etc.)
	// with run history + attachments + publish records (push to Gitee etc.).
	// Distinct from `resources` (manually-curated doc catalog) — these are system-
	// generated, versioned per run, and shared via a pushed link.
	db.exec(`
		CREATE TABLE IF NOT EXISTS artifacts (
			id             TEXT PRIMARY KEY,
			kind           TEXT NOT NULL DEFAULT 'report',
			source         TEXT NOT NULL DEFAULT 'scheduled_task',
			source_ref     TEXT,
			title          TEXT NOT NULL,
			summary        TEXT,
			partner        TEXT,
			scenario       TEXT,
			tags           TEXT,
			retention_days INTEGER,
			created_at     INTEGER NOT NULL,
			updated_at     INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_artifacts_source ON artifacts(source, source_ref);
		CREATE TABLE IF NOT EXISTS artifact_runs (
			id           TEXT PRIMARY KEY,
			artifact_id  TEXT NOT NULL,
			trigger      TEXT NOT NULL DEFAULT 'cron',
			status       TEXT NOT NULL DEFAULT 'running',
			started_at   INTEGER NOT NULL,
			finished_at  INTEGER,
			duration_ms  INTEGER,
			error        TEXT,
			summary      TEXT,
			metrics      TEXT,
			input_ref    TEXT,
			created_at   INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_artifact_runs_artifact ON artifact_runs(artifact_id, created_at DESC);
		CREATE TABLE IF NOT EXISTS artifact_attachments (
			id          TEXT PRIMARY KEY,
			run_id      TEXT NOT NULL,
			type        TEXT NOT NULL,
			storage     TEXT NOT NULL DEFAULT 'sqlite',
			content     TEXT,
			file_path   TEXT,
			file_name   TEXT,
			mime        TEXT,
			size_bytes  INTEGER NOT NULL DEFAULT 0,
			checksum    TEXT,
			created_at  INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_artifact_attachments_run ON artifact_attachments(run_id);
		CREATE TABLE IF NOT EXISTS artifact_publishes (
			id           TEXT PRIMARY KEY,
			run_id       TEXT NOT NULL,
			target       TEXT NOT NULL DEFAULT 'gitee',
			url          TEXT,
			path         TEXT,
			status       TEXT NOT NULL DEFAULT 'ok',
			error        TEXT,
			published_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_artifact_publishes_run ON artifact_publishes(run_id);
	`);

	// FTS5 full-text index over knowledge chunks. Uses the `trigram` tokenizer so
	// CJK text is matched by substring (unicode61 doesn't segment Chinese, which
	// made space-less Chinese queries return nothing). Upgrades existing tables.
	ensureChunksFts(db);

	// Browser downloads: metadata + provenance for files the automated browser
	// saved to the managed downloads dir. The file body lives on disk; this row
	// is how the employee lists/finds/reads downloads without scanning the FS.
	db.exec(`
		CREATE TABLE IF NOT EXISTS downloads (
			id                 TEXT PRIMARY KEY,
			saved_path         TEXT NOT NULL,
			url                TEXT NOT NULL,
			page_url           TEXT NOT NULL,
			suggested_filename TEXT NOT NULL,
			mime               TEXT,
			size_bytes         INTEGER NOT NULL DEFAULT 0,
			sha256             TEXT,
			status             TEXT NOT NULL DEFAULT 'ok',
			created_at         INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);
	`);
}

/** Create (or upgrade) the kb_chunks FTS table. Falls back to LIKE if FTS5 is unavailable. */
function ensureChunksFts(db: DB): void {
	const trigram = ftsSupportsTrigram(db);
	const want = trigram ? "trigram" : "unicode61";
	const existing = db
		.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='kb_chunks_fts'")
		.get() as { sql?: string } | undefined;
	if (existing) {
		const have = existing.sql?.includes("trigram") ? "trigram" : "unicode61";
		if (have === want) return;
		// Tokenizer changed — drop and rebuild from the source-of-truth table.
		db.exec(
			"DROP TRIGGER IF EXISTS kb_chunks_ai; DROP TRIGGER IF EXISTS kb_chunks_ad;" +
				" DROP TRIGGER IF EXISTS kb_chunks_au; DROP TABLE kb_chunks_fts;",
		);
	}
	try {
		db.exec(`
			CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
				content, title, tags,
				content='kb_chunks', content_rowid='rowid', tokenize='${want}'
			);
			CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
				INSERT INTO kb_chunks_fts(rowid, content, title, tags)
				VALUES (new.rowid, new.content, new.title, new.tags);
			END;
			CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
				INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, title, tags)
				VALUES ('delete', old.rowid, old.content, old.title, old.tags);
			END;
			CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
				INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, title, tags)
				VALUES ('delete', old.rowid, old.content, old.title, old.tags);
				INSERT INTO kb_chunks_fts(rowid, content, title, tags)
				VALUES (new.rowid, new.content, new.title, new.tags);
			END;
		`);
		// External-content table: 'rebuild' re-reads every row from kb_chunks.
		db.exec("INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES('rebuild')");
	} catch {
		/* FTS5 unavailable — LIKE fallback will be used. */
	}
}

/** Probe whether this SQLite build supports the FTS5 trigram tokenizer. */
function ftsSupportsTrigram(db: DB): boolean {
	try {
		db.exec("CREATE VIRTUAL TABLE fts_trigram_probe USING fts5(x, tokenize='trigram'); DROP TABLE fts_trigram_probe;");
		return true;
	} catch {
		db.exec("DROP TABLE IF EXISTS fts_trigram_probe;");
		return false;
	}
}
