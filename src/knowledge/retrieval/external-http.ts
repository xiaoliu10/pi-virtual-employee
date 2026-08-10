/**
 * External HTTP retrieval adapter — thin RetrievalProvider wrapper around
 * ExternalClient. Kept as a separate module so KnowledgeService depends on a
 * RetrievalProvider (used both for live search fusion and connection tests)
 * while upload/parse/list live directly on the client / KnowledgeService.
 *
 * `search` does not catch: failures propagate so the caller can decide (the
 * service drops a failed source to empty without affecting local retrieval,
 * while a connection test surfaces the error).
 */
import type { ExternalProviderConfig } from "../../db/config-store.js";
import { ExternalClient } from "../external/external-client.js";
import type { HealthStatus, RetrievalHit, RetrievalProvider, SearchRequest } from "../types.js";

export class ExternalHttpRetrievalProvider implements RetrievalProvider {
	readonly kind = "external" as const;
	readonly capabilities = { upsert: false, delete: false, vector: false, rerank: false };
	readonly id: string;
	private readonly client: ExternalClient;

	constructor(private readonly cfg: ExternalProviderConfig) {
		this.id = "external:" + cfg.id;
		this.client = new ExternalClient(cfg);
	}

	async search(req: SearchRequest): Promise<RetrievalHit[]> {
		return this.client.search(req.query, req.topK);
	}

	async health(): Promise<HealthStatus> {
		const ok = this.cfg.enabled && !!this.cfg.baseUrl;
		return { ok, ready: ok, detail: this.cfg.baseUrl ? this.cfg.name : "no url" };
	}
}

export { resolvePath } from "../external/external-client.js";
