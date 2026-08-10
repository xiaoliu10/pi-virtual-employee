/**
 * Persistence for document resources — the catalog of deliverable docs (interface
 * specs, online docs, …) the employee hands to integration partners. Pure CRUD +
 * keyword/partner search; the delivery orchestration (send file via IM, etc.)
 * lives in DocumentService. `partners`/`tags` are JSON arrays in their columns.
 *
 * Distinct from kb_chunks (full-text search of doc *content*): this is metadata-
 * driven retrieval of whole documents, so the model can match "which doc for
 * which partner in which scenario".
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./sqlite.js";

export type ResourceKind = "file" | "link";

export interface Resource {
	id: string;
	name: string;
	description: string | null;
	kind: ResourceKind;
	filePath: string | null;
	url: string | null;
	partners: string[];
	scenario: string | null;
	tags: string[];
	createdAt: number;
	updatedAt: number;
}

/** Raw DB row — snake_case columns, partners/tags as JSON strings. */
interface ResourceRow {
	id: string;
	name: string;
	description: string | null;
	kind: string;
	file_path: string | null;
	url: string | null;
	partners: string | null;
	scenario: string | null;
	tags: string | null;
	created_at: number;
	updated_at: number;
}

export interface ResourceInput {
	id?: string;
	name: string;
	description?: string | null;
	kind: ResourceKind;
	filePath?: string | null;
	url?: string | null;
	partners?: string[];
	scenario?: string | null;
	tags?: string[];
}

function parseList(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
	} catch {
		return [];
	}
}

function rowToResource(row: ResourceRow): Resource {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		kind: (row.kind === "link" ? "link" : "file") as ResourceKind,
		filePath: row.file_path,
		url: row.url,
		partners: parseList(row.partners),
		scenario: row.scenario,
		tags: parseList(row.tags),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class ResourceStore {
	constructor(private readonly db: DB) {}

	create(input: ResourceInput): Resource {
		const now = Date.now();
		const row: ResourceRow = {
			id: input.id ?? randomUUID(),
			name: input.name,
			description: input.description ?? null,
			kind: input.kind,
			file_path: input.filePath ?? null,
			url: input.url ?? null,
			partners: JSON.stringify(input.partners ?? []),
			scenario: input.scenario ?? null,
			tags: JSON.stringify(input.tags ?? []),
			created_at: now,
			updated_at: now,
		};
		this.db
			.prepare(
				`INSERT INTO resources
				 (id, name, description, kind, file_path, url, partners, scenario, tags, created_at, updated_at)
				 VALUES (@id, @name, @description, @kind, @file_path, @url, @partners, @scenario, @tags, @created_at, @updated_at)`,
			)
			.run(row);
		return rowToResource(row);
	}

	list(): Resource[] {
		return (this.db.prepare("SELECT * FROM resources ORDER BY updated_at DESC").all() as ResourceRow[]).map(
			rowToResource,
		);
	}

	get(id: string): Resource | undefined {
		const row = this.db.prepare("SELECT * FROM resources WHERE id = ?").get(id) as ResourceRow | undefined;
		return row ? rowToResource(row) : undefined;
	}

	/** Partial update; only set fields are touched. Returns the updated row, if any. */
	update(id: string, patch: Partial<Omit<ResourceInput, "id">>): Resource | undefined {
		const current = this.get(id);
		if (!current) return undefined;
		const merged: Resource = {
			...current,
			...Object.fromEntries(
				Object.entries({
					name: patch.name,
					description: patch.description,
					kind: patch.kind,
					filePath: patch.filePath,
					url: patch.url,
					scenario: patch.scenario,
				}).filter(([, v]) => v !== undefined),
			),
			partners: patch.partners ?? current.partners,
			tags: patch.tags ?? current.tags,
			updatedAt: Date.now(),
		};
		this.db
			.prepare(
				`UPDATE resources SET name=@name, description=@description, kind=@kind, file_path=@filePath,
				 url=@url, partners=@partners, scenario=@scenario, tags=@tags, updated_at=@updatedAt WHERE id=@id`,
			)
			.run({
				id,
				name: merged.name,
				description: merged.description,
				kind: merged.kind,
				filePath: merged.filePath,
				url: merged.url,
				partners: JSON.stringify(merged.partners),
				scenario: merged.scenario,
				tags: JSON.stringify(merged.tags),
				updatedAt: merged.updatedAt,
			});
		return merged;
	}

	delete(id: string): void {
		this.db.prepare("DELETE FROM resources WHERE id = ?").run(id);
	}

	/**
	 * Keyword + partner search. Empty query → all (optionally filtered by partner).
	 * Keyword matches name/description/scenario/tags; partner matches the partners
	 * JSON array (substring of the quoted name). Small catalog → LIKE is enough.
	 */
	search(query: string | null | undefined, partner: string | null | undefined): Resource[] {
		const where: string[] = [];
		const params: unknown[] = [];
		const q = query?.trim();
		if (q) {
			where.push("(name LIKE ? OR description LIKE ? OR scenario LIKE ? OR tags LIKE ?)");
			const like = `%${q}%`;
			params.push(like, like, like, like);
		}
		const p = partner?.trim();
		if (p) {
			// Match within the JSON array: look for the quoted name as a substring.
			where.push("partners LIKE ?");
			params.push(`%"${p.replace(/["\\]/g, "")}%"`);
		}
		const sql = `SELECT * FROM resources${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`;
		return (this.db.prepare(sql).all(...params) as ResourceRow[]).map(rowToResource);
	}
}
