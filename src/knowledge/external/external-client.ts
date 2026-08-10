/**
 * ExternalProviderClient — executes the configured HTTP operations for an
 * external knowledge base (search / upload / parse / list).
 *
 * One engine covers RAGFlow, Dify and arbitrary self-built endpoints: the
 * request shape comes entirely from the provider's operation templates, with
 * placeholders resolved at call time. Auth (`Authorization: Bearer <apiKey>`)
 * is injected from cfg.apiKey unless an op overrides it.
 *
 * `search` does not catch — failures propagate so KnowledgeService can drop a
 * failed source without affecting local retrieval, while a connection test
 * surfaces the error. upload/parse/list throw on missing ops so the caller can
 * present a clear "this preset does not support X" message.
 */
import { readFile } from "node:fs/promises";
import type { ExternalOpTemplate, ExternalProviderConfig } from "../../db/config-store.js";
import type { RetrievalHit } from "../types.js";

export interface ExternalDoc {
	id: string;
	name: string;
	status?: string;
}

type Vars = Record<string, string | number>;

export class ExternalClient {
	constructor(private readonly cfg: ExternalProviderConfig) {}

	async search(query: string, topK: number): Promise<RetrievalHit[]> {
		const op = this.cfg.operations.search;
		if (!op?.path) return [];
		const { url, init } = this.buildRequest(op, { query, topK });
		const res = await fetch(url, init);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`external search ${res.status}: ${detail.slice(0, 200)}`);
		}
		const json = await res.json();
		const results = (resolvePath(json, this.cfg.responseMapping.resultsPath) ?? []) as unknown[];
		if (!Array.isArray(results)) return [];
		return results.map((item, index) => this.toHit(item, index));
	}

	async uploadDocument(filePath: string, fileName: string): Promise<{ documentIds: string[] }> {
		const op = this.cfg.operations.upload;
		if (!op) throw new Error("该外接知识库未配置上传操作（此类型可能不支持上传）");
		const buffer = await readFile(filePath);
		const blob = new Blob([buffer]);
		const form = new FormData();
		form.append(op.multipartField ?? "file", blob, fileName);
		if (op.bodyTemplate) {
			// For multipart presets with a bodyTemplate (e.g. Dify), send it as a
			// JSON `data` form field alongside the file.
			form.append("data", this.resolve(op.bodyTemplate, { fileName }));
		}
		const headers: Record<string, string> = { ...(op.headers ?? {}) };
		if (this.cfg.apiKey && !headers.Authorization) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
		// Note: do NOT set Content-Type — fetch derives the multipart boundary.
		const { url } = this.buildRequest(op, { fileName });
		const res = await fetch(url, { method: op.method, headers, body: form });
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`上传失败 ${res.status}: ${detail.slice(0, 200)}`);
		}
		const json = await res.json().catch(() => ({}));
		return { documentIds: extractIds(json) };
	}

	async parseDocument(documentIds: string[]): Promise<void> {
		const op = this.cfg.operations.parse;
		if (!op) throw new Error("该外接知识库未配置解析操作（此类型可能为自动索引）");
		for (const documentId of documentIds) {
			const { url, init } = this.buildRequest(op, { documentId });
			const res = await fetch(url, init);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw new Error(`解析失败 ${res.status} (${documentId}): ${detail.slice(0, 200)}`);
			}
		}
	}

	async listDocuments(): Promise<ExternalDoc[]> {
		const op = this.cfg.operations.list;
		const mapping = this.cfg.listMapping;
		if (!op) throw new Error("该外接知识库未配置列表操作");
		const { url, init } = this.buildRequest(op, {});
		const res = await fetch(url, init);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`列表失败 ${res.status}: ${detail.slice(0, 200)}`);
		}
		const json = await res.json();
		const docs = (resolvePath(json, mapping?.documentsPath ?? "data") ?? []) as unknown[];
		if (!Array.isArray(docs)) return [];
		return docs.map((d) => ({
			id: String(resolvePath(d, mapping?.idPath ?? "id") ?? ""),
			name: String(resolvePath(d, mapping?.namePath ?? "name") ?? ""),
			status: mapping?.statusPath ? str(resolvePath(d, mapping.statusPath)) : undefined,
		}));
	}

	/** List all accessible datasets (no datasetId needed) — for the dataset picker. */
	async listDatasets(): Promise<{ id: string; name: string }[]> {
		const op = this.cfg.operations.datasets;
		const mapping = this.cfg.datasetsMapping;
		if (!op) throw new Error("该外接知识库未配置数据集列表操作（此类型可能不支持）");
		const { url, init } = this.buildRequest(op, {});
		const res = await fetch(url, init);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`拉取数据集失败 ${res.status}: ${detail.slice(0, 200)}`);
		}
		const json = await res.json();
		const arr = (resolvePath(json, mapping?.resultsPath ?? "data") ?? []) as unknown[];
		if (!Array.isArray(arr)) return [];
		return arr
			.map((d) => ({
				id: String(resolvePath(d, mapping?.idPath ?? "id") ?? ""),
				name: String(resolvePath(d, mapping?.namePath ?? "name") ?? ""),
			}))
			.filter((d) => d.id);
	}

	// --- internals ---

	private buildRequest(op: ExternalOpTemplate, vars: Vars): { url: string; init: RequestInit } {
		const base = this.cfg.baseUrl.replace(/\/+$/, "");
		const url = base + this.resolve(op.path, vars);
		const headers: Record<string, string> = { ...(op.headers ?? {}) };
		if (this.cfg.apiKey && !headers.Authorization) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
		const init: RequestInit = { method: op.method, headers };
		if (op.method === "POST" && op.bodyTemplate && !op.multipartField) {
			headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
			(init as RequestInit & { body: string }).body = this.resolve(op.bodyTemplate, vars);
		}
		return { url, init };
	}

	private resolve(text: string, vars: Vars): string {
		return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
			const v = vars[key];
			return v === undefined ? m : String(v);
		});
	}

	private toHit(item: unknown, index: number): RetrievalHit {
		const m = this.cfg.responseMapping;
		const snippet = String(resolvePath(item, m.snippetPath) ?? "");
		const title = m.titlePath ? String(resolvePath(item, m.titlePath) ?? "") || null : null;
		const source = m.sourcePath ? String(resolvePath(item, m.sourcePath) ?? "") || this.cfg.name : this.cfg.name;
		return {
			id: `ext:${this.cfg.id}:${index}`,
			chunkId: `ext:${this.cfg.id}:${index}`,
			source,
			sourceId: "",
			title,
			tags: null,
			snippet,
			score: 1,
			origin: this.cfg.name,
		};
	}
}

function str(v: unknown): string | undefined {
	return v == null ? undefined : String(v);
}

/** Best-effort extraction of document ids from an upload response. */
function extractIds(json: unknown): string[] {
	const ids: string[] = [];
	const collect = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) {
				const id = (item as Record<string, unknown>)?.id;
				if (typeof id === "string" && id) ids.push(id);
				else collect(item);
			}
		} else {
			const obj = node as Record<string, unknown>;
			if (typeof obj.id === "string") ids.push(obj.id);
			if (Array.isArray(obj.data)) collect(obj.data);
			else if (obj.data && typeof obj.data === "object") collect(obj.data);
			if (Array.isArray(obj.documents)) collect(obj.documents);
		}
	};
	collect(json);
	return [...new Set(ids)];
}

/** Resolve a dot-path (e.g. "data.results") into a nested value. Stops at arrays. */
export function resolvePath(root: unknown, path: string): unknown {
	if (!path) return root;
	return path.split(".").reduce<unknown>((acc, key) => {
		if (acc == null || Array.isArray(acc)) return acc;
		return (acc as Record<string, unknown>)[key];
	}, root);
}
