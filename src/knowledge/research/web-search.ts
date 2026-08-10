/**
 * Web search for the auto-research loop.
 *
 * Two engines:
 *  - "duckduckgo" (default, zero-config): the DuckDuckGo Instant Answer JSON API.
 *    No API key required. Results are sparse vs a real search engine but always
 *    available, so auto-research works out of the box.
 *  - "custom": a configurable HTTP endpoint (URL / body templates + response
 *    field mapping), for production setups fronting Bing / SerpAPI / SearXNG /
 *    a self-hosted search. Mirrors the external-retrieval HTTP adapter pattern.
 */
export interface WebSearchHit {
	title: string;
	snippet: string;
	url: string;
}

export interface WebSearchCustomConfig {
	url: string;
	method: "GET" | "POST";
	headers: Record<string, string>;
	bodyTemplate?: string;
	responseMapping: {
		resultsPath: string;
		titlePath?: string;
		snippetPath: string;
		urlPath?: string;
	};
}

export interface WebSearchOptions {
	engine: "duckduckgo" | "custom";
	custom?: WebSearchCustomConfig;
	topK?: number;
}

const DEFAULT_TOP_K = 5;

export async function webSearch(query: string, opts: WebSearchOptions): Promise<WebSearchHit[]> {
	const topK = opts.topK ?? DEFAULT_TOP_K;
	try {
		if (opts.engine === "custom" && opts.custom) return await customSearch(query, opts.custom, topK);
		return await duckDuckGoSearch(query, topK);
	} catch (err) {
		console.warn("[knowledge] web search failed:", (err as Error).message);
		return [];
	}
}

/** DuckDuckGo Instant Answer API — no key, JSON, best-effort. */
async function duckDuckGoSearch(query: string, topK: number): Promise<WebSearchHit[]> {
	const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=pi-ve`;
	const res = await fetch(url, { headers: { Accept: "application/json" } });
	if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
	const json = (await res.json()) as {
		AbstractText?: string;
		AbstractSource?: string;
		AbstractURL?: string;
		Heading?: string;
		RelatedTopics?: unknown[];
	};
	const hits: WebSearchHit[] = [];
	if (json.AbstractText) {
		hits.push({
			title: json.Heading || json.AbstractSource || "摘要",
			snippet: json.AbstractText,
			url: json.AbstractURL || "",
		});
	}
	// RelatedTopics is a flat list, but may contain nested topic groups.
	for (const t of json.RelatedTopics ?? []) {
		if (hits.length >= topK) break;
		const r = t as { Text?: string; FirstURL?: string; Topics?: unknown[] };
		if (r.Text) {
			const [title, ...rest] = r.Text.split(" - ");
			hits.push({ title: title || r.FirstURL || "结果", snippet: rest.join(" - ") || r.Text, url: r.FirstURL || "" });
		} else if (Array.isArray(r.Topics)) {
			for (const sub of r.Topics) {
				if (hits.length >= topK) break;
				const s = sub as { Text?: string; FirstURL?: string };
				if (!s.Text) continue;
				const [title, ...rest] = s.Text.split(" - ");
				hits.push({ title: title || s.FirstURL || "结果", snippet: rest.join(" - ") || s.Text, url: s.FirstURL || "" });
			}
		}
	}
	return hits.slice(0, topK);
}

async function customSearch(
	query: string,
	cfg: WebSearchCustomConfig,
	topK: number,
): Promise<WebSearchHit[]> {
	const url = cfg.url.replace(/{{query}}/g, encodeURIComponent(query));
	const init: RequestInit = { method: cfg.method, headers: { ...cfg.headers } };
	if (cfg.method === "POST" && cfg.bodyTemplate) {
		init.body = cfg.bodyTemplate.replace(/{{query}}/g, query).replace(/{{queryEncoded}}/g, encodeURIComponent(query));
	}
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`custom search ${res.status}`);
	const json = await res.json();
	const list = (getPath(json, cfg.responseMapping.resultsPath) ?? []) as unknown[];
	return list
		.slice(0, topK)
		.map((item) => ({
			title: cfg.responseMapping.titlePath ? String(getPath(item, cfg.responseMapping.titlePath) ?? "") : "",
			snippet: String(getPath(item, cfg.responseMapping.snippetPath) ?? ""),
			url: cfg.responseMapping.urlPath ? String(getPath(item, cfg.responseMapping.urlPath) ?? "") : "",
		}))
		.filter((h) => h.snippet || h.title);
}

/** Dot-path getter (e.g. "data.results" → json.data.results); arrays pass through. */
function getPath(obj: unknown, path: string): unknown {
	if (!path) return obj;
	let cur: unknown = obj;
	for (const key of path.split(".")) {
		if (cur == null) return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}
