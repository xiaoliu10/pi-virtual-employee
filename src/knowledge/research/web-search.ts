/**
 * Web search for the auto-research loop.
 *
 * Three engines:
 *  - "bing" (default, zero-config): Bing HTML results, no API key, reachable from
 *    mainland China (the DuckDuckGo API is not). Parsing is regex-based over the
 *    stable b_algo block — best-effort by design, failures return [].
 *  - "duckduckgo": the DuckDuckGo Instant Answer JSON API. No key, but unreachable
 *    from mainland China — kept for existing configs and non-CN deployments.
 *  - "custom": a configurable HTTP endpoint (URL / body templates + response
 *    field mapping), for production setups fronting SerpAPI / SearXNG /
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
	engine: "bing" | "duckduckgo" | "custom";
	custom?: WebSearchCustomConfig;
	topK?: number;
}

const DEFAULT_TOP_K = 5;

export async function webSearch(query: string, opts: WebSearchOptions): Promise<WebSearchHit[]> {
	const topK = opts.topK ?? DEFAULT_TOP_K;
	try {
		if (opts.engine === "custom" && opts.custom) return await customSearch(query, opts.custom, topK);
		if (opts.engine === "bing") return await bingSearch(query, topK);
		return await duckDuckGoSearch(query, topK);
	} catch (err) {
		console.warn("[knowledge] web search failed:", (err as Error).message);
		return [];
	}
}

/** Bing HTML results — no key, works from mainland China. Regex over b_algo blocks. */
const BING_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function bingSearch(query: string, topK: number): Promise<WebSearchHit[]> {
	const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(topK * 2, 20)}&mkt=zh-CN`;
	const res = await fetch(url, {
		headers: { "User-Agent": BING_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`bing ${res.status}`);
	const html = await res.text();
	const hits: WebSearchHit[] = [];
	for (const rawBlock of html.split('<li class="b_algo"').slice(1)) {
		if (hits.length >= topK) break;
		// The last block has no right boundary — cut at the next list item so
		// footer/related-search markup can't leak into the snippet match.
		const block = rawBlock.split("<li ")[0];
		const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
		if (!link) continue;
		const para = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
		const title = stripTags(link[2]);
		const snippet = para ? stripTags(para[1]) : "";
		// href is guaranteed non-empty by the regex; the title alone gates the block.
		if (!title) continue;
		hits.push({ title, snippet, url: decodeEntities(link[1]) });
	}
	return hits.slice(0, topK);
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
	const safeCodePoint = (code: string, radix: number) => {
		const n = parseInt(code, radix);
		// Out-of-range entities must not throw (a single bad entity killed the whole parse).
		return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
	};
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCodePoint(code, 16))
		.replace(/&#(\d+);/g, (_, code) => safeCodePoint(code, 10));
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
