/**
 * Persistence for the report / artifact center.
 *
 * An artifact is a logical report (e.g. "LiteLLM 日报"); each generation is a
 * run with status + an attachment (the Markdown/HTML body); a publish records
 * that a run was pushed somewhere (Gitee) with the shareable URL.
 *
 * `file_path` on attachments is RELATIVE to userData/reports/ (never an
 * absolute path) so it stays valid across platforms / machines / profiles.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { DB } from "./sqlite.js";

export type ArtifactKind = "report" | "export" | "snapshot" | "log";
export type ArtifactSource = "scheduled_task" | "tool" | "manual" | "system";
export type RunStatus = "running" | "ok" | "partial" | "error";
export type AttachmentType = "markdown" | "html" | "pdf" | "json" | "image" | "file";

export interface Artifact {
	id: string;
	kind: ArtifactKind;
	source: ArtifactSource;
	sourceRef: string | null;
	title: string;
	summary: string | null;
	partner: string | null;
	scenario: string | null;
	tags: string[];
	retentionDays: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ArtifactRun {
	id: string;
	artifactId: string;
	trigger: string;
	status: RunStatus;
	startedAt: number;
	finishedAt: number | null;
	durationMs: number | null;
	error: string | null;
	summary: string | null;
	metrics: Record<string, unknown> | null;
	inputRef: string | null;
	createdAt: number;
}

export interface ArtifactAttachment {
	id: string;
	runId: string;
	type: AttachmentType;
	storage: "sqlite" | "fs";
	content: string | null;
	filePath: string | null;
	fileName: string | null;
	mime: string | null;
	sizeBytes: number;
	checksum: string | null;
	createdAt: number;
}

export interface ArtifactPublish {
	id: string;
	runId: string;
	target: string;
	url: string | null;
	path: string | null;
	status: "ok" | "error";
	error: string | null;
	publishedAt: number;
}

interface ArtifactRow {
	id: string;
	kind: string;
	source: string;
	source_ref: string | null;
	title: string;
	summary: string | null;
	partner: string | null;
	scenario: string | null;
	tags: string | null;
	retention_days: number | null;
	created_at: number;
	updated_at: number;
}

interface RunRow {
	id: string;
	artifact_id: string;
	trigger: string;
	status: string;
	started_at: number;
	finished_at: number | null;
	duration_ms: number | null;
	error: string | null;
	summary: string | null;
	metrics: string | null;
	input_ref: string | null;
	created_at: number;
}

interface AttachmentRow {
	id: string;
	run_id: string;
	type: string;
	storage: string;
	content: string | null;
	file_path: string | null;
	file_name: string | null;
	mime: string | null;
	size_bytes: number;
	checksum: string | null;
	created_at: number;
}

interface PublishRow {
	id: string;
	run_id: string;
	target: string;
	url: string | null;
	path: string | null;
	status: string;
	error: string | null;
	published_at: number;
}

function parseTags(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
	} catch {
		return [];
	}
}

function parseMetrics(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function toArtifact(row: ArtifactRow): Artifact {
	return {
		id: row.id,
		kind: (row.kind as ArtifactKind) || "report",
		source: (row.source as ArtifactSource) || "scheduled_task",
		sourceRef: row.source_ref,
		title: row.title,
		summary: row.summary,
		partner: row.partner,
		scenario: row.scenario,
		tags: parseTags(row.tags),
		retentionDays: row.retention_days,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toRun(row: RunRow): ArtifactRun {
	return {
		id: row.id,
		artifactId: row.artifact_id,
		trigger: row.trigger,
		status: (row.status as RunStatus) || "running",
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		durationMs: row.duration_ms,
		error: row.error,
		summary: row.summary,
		metrics: parseMetrics(row.metrics),
		inputRef: row.input_ref,
		createdAt: row.created_at,
	};
}

function toAttachment(row: AttachmentRow): ArtifactAttachment {
	return {
		id: row.id,
		runId: row.run_id,
		type: (row.type as AttachmentType) || "file",
		storage: (row.storage as "sqlite" | "fs") || "sqlite",
		content: row.content,
		filePath: row.file_path,
		fileName: row.file_name,
		mime: row.mime,
		sizeBytes: row.size_bytes,
		checksum: row.checksum,
		createdAt: row.created_at,
	};
}

function toPublish(row: PublishRow): ArtifactPublish {
	return {
		id: row.id,
		runId: row.run_id,
		target: row.target,
		url: row.url,
		path: row.path,
		status: (row.status as "ok" | "error") || "ok",
		error: row.error,
		publishedAt: row.published_at,
	};
}

export interface UpsertArtifactInput {
	id?: string;
	kind?: ArtifactKind;
	source?: ArtifactSource;
	sourceRef?: string | null;
	title: string;
	summary?: string | null;
	partner?: string | null;
	scenario?: string | null;
	tags?: string[];
}

export interface CreateRunInput {
	id?: string;
	artifactId: string;
	trigger?: string;
	status?: RunStatus;
	summary?: string | null;
	metrics?: Record<string, unknown> | null;
	inputRef?: string | null;
}

export interface CreateAttachmentInput {
	runId: string;
	type: AttachmentType;
	content?: string | null;
	filePath?: string | null;
	fileName?: string | null;
	mime?: string | null;
}

export class ArtifactStore {
	constructor(private readonly db: DB) {}

	/** Insert or update an artifact by (source, sourceRef). Returns the id. */
	upsertBySource(input: UpsertArtifactInput): Artifact {
		const now = Date.now();
		const existing =
			input.source && input.sourceRef
				? (this.db
						.prepare("SELECT * FROM artifacts WHERE source = ? AND source_ref = ?")
						.get(input.source, input.sourceRef) as ArtifactRow | undefined)
				: undefined;
		if (existing) {
			const merged: ArtifactRow = {
				...existing,
				title: input.title || existing.title,
				summary: input.summary ?? existing.summary,
				partner: input.partner ?? existing.partner,
				scenario: input.scenario ?? existing.scenario,
				tags: input.tags ? JSON.stringify(input.tags) : existing.tags,
				updated_at: now,
			};
			this.db
				.prepare(
					`UPDATE artifacts SET title=@title, summary=@summary, partner=@partner, scenario=@scenario, tags=@tags, updated_at=@updated_at WHERE id=@id`,
				)
				.run(merged);
			return toArtifact(merged);
		}
		const row: ArtifactRow = {
			id: input.id ?? randomUUID(),
			kind: input.kind ?? "report",
			source: input.source ?? "scheduled_task",
			source_ref: input.sourceRef ?? null,
			title: input.title,
			summary: input.summary ?? null,
			partner: input.partner ?? null,
			scenario: input.scenario ?? null,
			tags: JSON.stringify(input.tags ?? []),
			retention_days: null,
			created_at: now,
			updated_at: now,
		};
		this.db
			.prepare(
				`INSERT INTO artifacts (id, kind, source, source_ref, title, summary, partner, scenario, tags, retention_days, created_at, updated_at)
				 VALUES (@id, @kind, @source, @source_ref, @title, @summary, @partner, @scenario, @tags, @retention_days, @created_at, @updated_at)`,
			)
			.run(row);
		return toArtifact(row);
	}

	getArtifact(id: string): Artifact | undefined {
		const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
		return row ? toArtifact(row) : undefined;
	}

	listArtifacts(): Artifact[] {
		return (this.db.prepare("SELECT * FROM artifacts ORDER BY updated_at DESC").all() as ArtifactRow[]).map(toArtifact);
	}

	deleteArtifact(id: string): void {
		// Cascade: runs → (attachments + publishes), then the artifact itself.
		const runIds = (this.db.prepare("SELECT id FROM artifact_runs WHERE artifact_id = ?").all(id) as { id: string }[]).map(
			(r) => r.id,
		);
		for (const runId of runIds) {
			this.db.prepare("DELETE FROM artifact_attachments WHERE run_id = ?").run(runId);
			this.db.prepare("DELETE FROM artifact_publishes WHERE run_id = ?").run(runId);
		}
		this.db.prepare("DELETE FROM artifact_runs WHERE artifact_id = ?").run(id);
		this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
	}

	createRun(input: CreateRunInput): ArtifactRun {
		const now = Date.now();
		const row: RunRow = {
			id: input.id ?? randomUUID(),
			artifact_id: input.artifactId,
			trigger: input.trigger ?? "cron",
			status: input.status ?? "running",
			started_at: now,
			finished_at: null,
			duration_ms: null,
			error: null,
			summary: input.summary ?? null,
			metrics: input.metrics ? JSON.stringify(input.metrics) : null,
			input_ref: input.inputRef ?? null,
			created_at: now,
		};
		this.db
			.prepare(
				`INSERT INTO artifact_runs (id, artifact_id, trigger, status, started_at, finished_at, duration_ms, error, summary, metrics, input_ref, created_at)
				 VALUES (@id, @artifact_id, @trigger, @status, @started_at, @finished_at, @duration_ms, @error, @summary, @metrics, @input_ref, @created_at)`,
			)
			.run(row);
		return toRun(row);
	}

	/** Mark a run finished with status + optional error/summary. */
	finishRun(id: string, status: RunStatus, opts: { error?: string | null; summary?: string | null; metrics?: Record<string, unknown> | null } = {}): void {
		const started = (this.db.prepare("SELECT started_at FROM artifact_runs WHERE id = ?").get(id) as { started_at: number } | undefined)?.started_at ?? Date.now();
		const sets: string[] = ["status = @status", "finished_at = @finished_at", "duration_ms = @duration_ms"];
		const params: Record<string, unknown> = { id, status, finished_at: Date.now(), duration_ms: Date.now() - started };
		if (opts.error !== undefined) {
			sets.push("error = @error");
			params.error = opts.error ?? null;
		}
		if (opts.summary !== undefined) {
			sets.push("summary = @summary");
			params.summary = opts.summary ?? null;
		}
		if (opts.metrics !== undefined) {
			sets.push("metrics = @metrics");
			params.metrics = opts.metrics ? JSON.stringify(opts.metrics) : null;
		}
		this.db.prepare(`UPDATE artifact_runs SET ${sets.join(", ")} WHERE id = @id`).run(params);
	}

	listRuns(artifactId: string): ArtifactRun[] {
		return (this.db
			.prepare("SELECT * FROM artifact_runs WHERE artifact_id = ? ORDER BY created_at DESC")
			.all(artifactId) as RunRow[]).map(toRun);
	}

	/** Most recent run of an artifact (any status), if any. */
	latestRun(artifactId: string): ArtifactRun | undefined {
		const row = this.db
			.prepare("SELECT * FROM artifact_runs WHERE artifact_id = ? ORDER BY created_at DESC LIMIT 1")
			.get(artifactId) as RunRow | undefined;
		return row ? toRun(row) : undefined;
	}

	getRun(id: string): ArtifactRun | undefined {
		const row = this.db.prepare("SELECT * FROM artifact_runs WHERE id = ?").get(id) as RunRow | undefined;
		return row ? toRun(row) : undefined;
	}

	createAttachment(input: CreateAttachmentInput): ArtifactAttachment {
		const now = Date.now();
		const content = input.content ?? null;
		const storage: "sqlite" | "fs" = content != null ? "sqlite" : "fs";
		const sizeBytes = content ? Buffer.byteLength(content, "utf8") : 0;
		const checksum = content ? createHash("sha256").update(content).digest("hex") : null;
		const row: AttachmentRow = {
			id: randomUUID(),
			run_id: input.runId,
			type: input.type,
			storage,
			content,
			file_path: input.filePath ?? null,
			file_name: input.fileName ?? null,
			mime: input.mime ?? null,
			size_bytes: sizeBytes,
			checksum,
			created_at: now,
		};
		this.db
			.prepare(
				`INSERT INTO artifact_attachments (id, run_id, type, storage, content, file_path, file_name, mime, size_bytes, checksum, created_at)
				 VALUES (@id, @run_id, @type, @storage, @content, @file_path, @file_name, @mime, @size_bytes, @checksum, @created_at)`,
			)
			.run(row);
		return toAttachment(row);
	}

	/** The body attachment of a run (first markdown/html/text attachment), if any. */
	runBody(runId: string): ArtifactAttachment | undefined {
		const row = this.db
			.prepare(
				`SELECT * FROM artifact_attachments WHERE run_id = ? ORDER BY (type='markdown') DESC, (type='html') DESC, created_at ASC LIMIT 1`,
			)
			.get(runId) as AttachmentRow | undefined;
		return row ? toAttachment(row) : undefined;
	}

	createPublish(input: { runId: string; target?: string; url: string | null; path: string | null; status?: "ok" | "error"; error?: string | null }): ArtifactPublish {
		const row: PublishRow = {
			id: randomUUID(),
			run_id: input.runId,
			target: input.target ?? "gitee",
			url: input.url,
			path: input.path,
			status: input.status ?? "ok",
			error: input.error ?? null,
			published_at: Date.now(),
		};
		this.db
			.prepare(
				`INSERT INTO artifact_publishes (id, run_id, target, url, path, status, error, published_at)
				 VALUES (@id, @run_id, @target, @url, @path, @status, @error, @published_at)`,
			)
			.run(row);
		return toPublish(row);
	}

	/** Latest successful publish URL for a run, if any. */
	latestPublishUrl(runId: string): string | null {
		const row = this.db
			.prepare("SELECT url FROM artifact_publishes WHERE run_id = ? AND status = 'ok' AND url IS NOT NULL ORDER BY published_at DESC LIMIT 1")
			.get(runId) as { url: string } | undefined;
		return row?.url ?? null;
	}
}
