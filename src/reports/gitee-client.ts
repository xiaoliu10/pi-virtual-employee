/**
 * Gitee publisher for the report center.
 *
 * Pushes report files to a configurable Gitee repo via the contents API
 * (create, or update-by-sha if the path already exists), and builds the
 * shareable link according to the configured `linkMode`. Every parameter
 * comes from the per-instance config — nothing is hard-coded.
 *
 * Link modes (config.reports.publish.linkMode):
 *   raw_with_token — raw URL + ?access_token=readToken (try first; Gitee may
 *                    still require a collaborator login on private repos).
 *   web_blob       — Gitee blob page; collaborators log in to view.
 *   public         — raw URL without token (use with a public report repo).
 */
import type { AppConfig } from "../db/config-store.js";

type ReportsConfig = AppConfig["reports"];

export interface PublishResult {
	/** Full path inside the repo (basePath + relPath). */
	path: string;
	/** Shareable link built per linkMode. */
	url: string;
	/** Gitee commit sha, if returned. */
	sha?: string;
}

export class GiteeClient {
	private readonly cfg: ReportsConfig;

	constructor(reports: ReportsConfig) {
		this.cfg = reports;
	}

	private get g() {
		return this.cfg.gitee;
	}

	/** True if the config has the minimum fields to attempt a push. */
	isConfigured(): boolean {
		const g = this.g;
		return !!(g.owner && g.repo && g.writeToken && g.apiUrl && g.webUrl);
	}

	/**
	 * Push (create or update) a text file at `relPath` under the configured
	 * basePath. Returns the repo path + the shareable link.
	 */
	async publishFile(relPath: string, content: string, message: string, _mime?: string): Promise<PublishResult> {
		return this.pushBase64(relPath, Buffer.from(content, "utf8").toString("base64"), message);
	}

	/**
	 * Push (create or update) a binary file (e.g. an image) at `relPath`. The
	 * contents API takes base64 regardless of type, so images go through the same
	 * path as text — the repo stores the raw bytes and `buildLink` yields a raw
	 * URL DingTalk can fetch.
	 */
	async publishBinary(relPath: string, buffer: Buffer, message: string): Promise<PublishResult> {
		return this.pushBase64(relPath, buffer.toString("base64"), message);
	}

	private async pushBase64(relPath: string, b64: string, message: string): Promise<PublishResult> {
		if (!this.isConfigured()) throw new Error("Gitee 未配置完整（owner/repo/writeToken/apiUrl/webUrl）");
		const g = this.g;
		const full = `${g.basePath}${relPath}`.replace(/^\/+/, "");
		const encoded = full.split("/").map(encodeURIComponent).join("/");
		const endpoint = `${g.apiUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}/contents/${encoded}`;
		const body = (extra: Record<string, unknown>) => ({
			access_token: g.writeToken,
			content: b64,
			message,
			branch: g.branch,
			...(g.commitAuthor ? { author: { name: g.commitAuthor, ...(g.commitEmail ? { email: g.commitEmail } : {}) } } : {}),
			...extra,
		});

		// Try create first.
		const created = await this.fetchJson(endpoint, { method: "POST", body: body({}) });
		if (created.ok) {
			const sha = (created.json as { content?: { sha?: string } })?.content?.sha;
			return { path: full, url: this.buildLink(full), sha };
		}

		// Create failed → likely "already exists". Resolve the current sha and PUT.
		const sha = await this.getSha(endpoint);
		const updated = await this.fetchJson(endpoint, { method: "PUT", body: body({ sha }) });
		if (!updated.ok) {
			throw new Error(`Gitee 更新失败 (${updated.status}): ${this.errText(updated.json)}`);
		}
		const newSha = (updated.json as { content?: { sha?: string } })?.content?.sha;
		return { path: full, url: this.buildLink(full), sha: newSha };
	}

	/** Fetch the current blob sha for an existing file (for update). */
	private async getSha(endpoint: string): Promise<string> {
		const g = this.g;
		const sep = endpoint.includes("?") ? "&" : "?";
		const res = await this.fetchJson(`${endpoint}${sep}ref=${encodeURIComponent(g.branch)}&access_token=${encodeURIComponent(g.writeToken)}`, { method: "GET" });
		if (!res.ok) throw new Error(`Gitee 读取已有文件失败 (${res.status}): ${this.errText(res.json)}`);
		const sha = (res.json as { sha?: string })?.sha;
		if (!sha) throw new Error("Gitee 返回内容缺少 sha");
		return sha;
	}

	/** Build the shareable link for a repo-relative path, per linkMode. */
	buildLink(fullRepoPath: string): string {
		const g = this.g;
		const web = g.webUrl.replace(/\/$/, "");
		const pathSeg = fullRepoPath.split("/").map(encodeURIComponent).join("/");
		const base = `${web}/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}`;
		if (this.cfg.publish.linkMode === "web_blob") {
			return `${base}/blob/${encodeURIComponent(g.branch)}/${pathSeg}`;
		}
		const raw = `${base}/raw/${encodeURIComponent(g.branch)}/${pathSeg}`;
		if (this.cfg.publish.linkMode === "raw_with_token" && g.readToken) {
			return `${raw}?access_token=${encodeURIComponent(g.readToken)}`;
		}
		return raw;
	}

	/** Verify the repo is reachable and the write token works (GET repo info). */
	async testRepo(): Promise<{ ok: boolean; detail: string }> {
		if (!this.isConfigured()) return { ok: false, detail: "配置不完整（owner/repo/writeToken/apiUrl/webUrl）" };
		const g = this.g;
		const endpoint = `${g.apiUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}?access_token=${encodeURIComponent(g.writeToken)}`;
		try {
			const res = await this.fetchJson(endpoint, { method: "GET" });
			if (!res.ok) return { ok: false, detail: `Gitee 返回 ${res.status}: ${this.errText(res.json)}` };
			const info = res.json as { full_name?: string; private?: boolean };
			return { ok: true, detail: `已连接仓库 ${info.full_name ?? `${g.owner}/${g.repo}`}${info.private ? "（私有）" : "（公开）"}` };
		} catch (err) {
			return { ok: false, detail: `网络错误：${(err as Error).message}` };
		}
	}

	private async fetchJson(url: string, init: { method: string; body?: unknown }): Promise<{ ok: boolean; status: number; json: unknown }> {
		const headers: Record<string, string> = init.body ? { "Content-Type": "application/json" } : {};
		const res = await fetch(url, { method: init.method, headers, body: init.body ? JSON.stringify(init.body) : undefined });
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = text;
		}
		return { ok: res.ok, status: res.status, json };
	}

	private errText(json: unknown): string {
		if (json && typeof json === "object") {
			const m = (json as { message?: string }).message;
			if (m) return m;
		}
		return typeof json === "string" ? json : "未知错误";
	}
}
