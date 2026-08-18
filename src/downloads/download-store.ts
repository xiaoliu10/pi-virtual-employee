/**
 * Persistence for browser downloads.
 *
 * Each row records one file the automated browser saved to the managed
 * downloads directory: where it came from, where it landed, its size/checksum,
 * and a status (ok | blocked_domain | rejected_too_large | error). The body of
 * the file lives on disk; this table is just metadata + provenance so the
 * employee can list/find/read downloads without re-scanning the filesystem.
 *
 * `saved_path` is an absolute path within the managed downloads dir of the
 * active profile; it is per-instance and not portable, so it is never exported.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "../db/sqlite.js";

export type DownloadStatus = "ok" | "blocked_domain" | "rejected_too_large" | "error";

export interface DownloadRecord {
	id: string;
	savedPath: string;
	url: string;
	pageUrl: string;
	suggestedFilename: string;
	mime: string;
	sizeBytes: number;
	sha256: string;
	status: DownloadStatus;
	createdAt: number;
}

interface DownloadRow {
	id: string;
	saved_path: string;
	url: string;
	page_url: string;
	suggested_filename: string;
	mime: string | null;
	size_bytes: number;
	sha256: string | null;
	status: string;
	created_at: number;
}

function toRecord(row: DownloadRow): DownloadRecord {
	return {
		id: row.id,
		savedPath: row.saved_path,
		url: row.url,
		pageUrl: row.page_url,
		suggestedFilename: row.suggested_filename,
		mime: row.mime ?? "",
		sizeBytes: row.size_bytes,
		sha256: row.sha256 ?? "",
		status: (row.status as DownloadStatus) || "ok",
		createdAt: row.created_at,
	};
}

export interface CreateDownloadInput {
	savedPath: string;
	url: string;
	pageUrl: string;
	suggestedFilename: string;
	mime: string;
	sizeBytes: number;
	sha256: string;
	status: DownloadStatus;
}

export class DownloadStore {
	constructor(private readonly db: DB) {}

	create(input: CreateDownloadInput): DownloadRecord {
		const id = randomUUID();
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO downloads (id, saved_path, url, page_url, suggested_filename, mime, size_bytes, sha256, status, created_at)
				 VALUES (@id, @saved_path, @url, @page_url, @suggested_filename, @mime, @size_bytes, @sha256, @status, @created_at)`,
			)
			.run({ id, saved_path: input.savedPath, url: input.url, page_url: input.pageUrl, suggested_filename: input.suggestedFilename, mime: input.mime, size_bytes: input.sizeBytes, sha256: input.sha256, status: input.status, created_at: now });
		return { id, ...input, createdAt: now };
	}

	listRecent(limit = 20): DownloadRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM downloads ORDER BY created_at DESC LIMIT ?")
			.all(Math.max(1, Math.min(limit, 100))) as DownloadRow[];
		return rows.map(toRecord);
	}

	get(id: string): DownloadRecord | undefined {
		const row = this.db.prepare("SELECT * FROM downloads WHERE id = ?").get(id) as DownloadRow | undefined;
		return row ? toRecord(row) : undefined;
	}

	delete(id: void | string): void {
		// Best-effort delete by row id (no-op if absent).
		if (id) this.db.prepare("DELETE FROM downloads WHERE id = ?").run(id);
	}
}
