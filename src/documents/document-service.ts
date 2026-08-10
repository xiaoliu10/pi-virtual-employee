/**
 * DocumentService — facade over ResourceStore plus delivery orchestration.
 *
 * The catalog (list/get/search/save/update/delete) is plain metadata retrieval.
 * `provide()` is the interesting bit: it hands a resource to the integration
 * partner in the current conversation — a link is returned as text (the agent
 * relays it), a file is sent through the channel's file sender when one is
 * available (DingTalk real file send), else degraded to "archived at <path>".
 *
 * The per-turn file sender is resolved by the engine from the inbound context
 * (see EmployeeEngine.send / ToolSetOptions.resolveFileSender), so this service
 * stays free of any IM/adapter coupling.
 */
import { access } from "node:fs/promises";
import path from "node:path";
import type { ConfigStore } from "../db/config-store.js";
import type { DB } from "../db/sqlite.js";
import { ResourceStore, type Resource, type ResourceInput, type ResourceKind } from "../db/resource-store.js";

/** Channel file-delivery callback (provided by the IM adapter for the current turn). */
export type FileSender = (filePath: string, fileName: string) => Promise<{ ok: boolean; error?: string }>;

/** Resolves the sender for a given conversation, or undefined when the channel can't send files. */
export type FileSenderResolver = (conversationId: string) => FileSender | undefined;

export interface ProvideResult {
	ok: boolean;
	delivered: "link" | "file" | "fallback";
	text: string;
	resource?: Resource;
}

export class DocumentService {
	private readonly store: ResourceStore;
	constructor(
		private readonly db: DB,
		private readonly config: ConfigStore,
		private readonly defaultDir: string,
	) {
		this.store = new ResourceStore(db);
	}

	/** Effective documents directory: configured dir, else the userData default. */
	dir(): string {
		const configured = this.config.all().documents.dir.trim();
		return configured || this.defaultDir;
	}

	// --- catalog (proxy to the store) ---
	list(): Resource[] {
		return this.store.list();
	}
	get(id: string): Resource | undefined {
		return this.store.get(id);
	}
	search(query: string | null, partner: string | null): Resource[] {
		return this.store.search(query, partner);
	}
	add(input: ResourceInput): Resource {
		return this.store.create(input);
	}
	update(id: string, patch: Partial<Omit<ResourceInput, "id">>): Resource | undefined {
		return this.store.update(id, patch);
	}
	delete(id: string): void {
		this.store.delete(id);
	}

	/**
	 * Agent-facing: save a resource (typically an online link discovered during a
	 * task). File resources are usually added via the admin UI (upload → copied
	 * path), but a known file path is accepted too.
	 */
	save(input: {
		name: string;
		kind: ResourceKind;
		url?: string | null;
		filePath?: string | null;
		partners?: string[];
		description?: string | null;
		scenario?: string | null;
		tags?: string[];
	}): Resource {
		return this.store.create({
			name: input.name,
			kind: input.kind,
			url: input.url ?? null,
			filePath: input.filePath ?? null,
			partners: input.partners,
			description: input.description,
			scenario: input.scenario,
			tags: input.tags,
		});
	}

	/**
	 * Deliver a resource into the current conversation. Links → returned as text
	 * (the agent writes the URL into its reply). Files → sent via the channel's
	 * file sender when available; otherwise degraded to an archived-path notice so
	 * the employee never goes silent on the request.
	 */
	async provide(
		id: string,
		conversationId: string,
		resolveFileSender?: FileSenderResolver,
	): Promise<ProvideResult> {
		const r = this.store.get(id);
		if (!r) return { ok: false, delivered: "fallback", text: `未找到 id=${id} 的文档资源。` };

		if (r.kind === "link") {
			const url = r.url?.trim() || "";
			return url
				? { ok: true, delivered: "link", text: `在线文档《${r.name}》：${url}`, resource: r }
				: { ok: false, delivered: "fallback", text: `《${r.name}》未配置链接。`, resource: r };
		}

		// kind === "file"
		const fp = r.filePath?.trim() || "";
		if (!fp) return { ok: false, delivered: "fallback", text: `文件资源《${r.name}》未配置文件路径。`, resource: r };
		try {
			await access(fp);
		} catch {
			return { ok: false, delivered: "fallback", text: `文件《${r.name}》在磁盘上已不存在（${fp}）。`, resource: r };
		}

		const sender = resolveFileSender?.(conversationId);
		if (!sender) {
			return {
				ok: true,
				delivered: "fallback",
				text: `文件《${r.name}》已归档：${fp}（当前渠道无法直接投递文件，请把文件转给对方，或改用在线链接类资源）。`,
				resource: r,
			};
		}
		try {
			const res = await sender(fp, path.basename(fp));
			return res.ok
				? { ok: true, delivered: "file", text: `已把文件《${r.name}》投递到当前会话。`, resource: r }
				: {
						ok: false,
						delivered: "fallback",
						text: `文件《${r.name}》投递失败（${res.error ?? "未知错误"}），已归档：${fp}。`,
						resource: r,
					};
		} catch (err) {
			return {
				ok: false,
				delivered: "fallback",
				text: `文件《${r.name}》投递异常（${(err as Error).message}），已归档：${fp}。`,
				resource: r,
			};
		}
	}
}
