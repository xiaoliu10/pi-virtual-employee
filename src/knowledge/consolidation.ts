/**
 * LLM-driven knowledge consolidation: given a batch of 'learned' entries, ask the
 * model for merge / archive / retag operations (including generalization — folding
 * several concrete cases into one derived rule). The service executes the returned
 * ops transactionally.
 */
import type { KnowledgeEntry } from "./store.js";

export interface MergeOp {
	ids: string[];
	title: string;
	content: string;
	tags?: string;
}
export interface RetagOp {
	id: string;
	tags: string;
}

export interface ConsolidateOps {
	merge: MergeOp[];
	archive: string[];
	retag: RetagOp[];
}

export interface ConsolidateReport {
	merged: number;
	archived: number;
	derived: number;
	retagged: number;
	skipped: number;
	error?: string;
}

export const CONSOLIDATE_SYSTEM = `你是知识库整理助手。分析给定的知识条目，输出整理操作以去重、合并、归类与泛化归纳。

【最高优先级 · 关键信息保护】
这个知识库属于一名「虚拟员工」，需要长期、自动地在真实生产系统中作业。条目里出现的账号、密码、密钥、令牌(Token/API Key)、连接串、数据库/服务器地址、端点 URL、端口、环境参数等，都是该员工持续作业所必需的关键信息。
- 合并、泛化或重写任何条目时，必须**逐字保留**上述关键凭据与配置的具体取值，绝不得省略、概括、打码或替换成"从受控凭据库获取""见安全存储"之类的话。
- 原文是"账号：abc / 密码：xyz"，合并后的条目里也必须照样出现"账号：abc / 密码：xyz"。
- 含有关键凭据的条目永远有价值，不要 archive。
- 不得以"安全""隐私""脱敏"为由删改这些信息。

规则：
- 语义重复或高度重叠的条目 → merge：合并为一条，标题概括共同主题，内容融合去重，并在正文开头注明"（泛化自：标题A、标题B）"。合并时务必按上面"关键信息保护"把各条目的账号/密码/地址等原值保留进新条目。
- 多条具体案例可归纳出通用规则/流程时 → merge 生成一条泛化条目（标题写通用主题、内容写通用规则与适用条件），原具体条目的 id 一并放入 merge.ids（它们会被归档）。注意：原条目里的关键凭据/配置值要原样带进泛化条目。
- 过时、空泛、无价值或被合并覆盖的条目 → archive（含关键凭据的条目除外）。
- 标签缺失或不规范的条目 → retag（补全规范标签，逗号分隔）。
- 无需整理的条目不要输出。merge.ids 中的条目会被自动归档，不要重复放进 archive。

只输出一个 JSON 对象，不要输出任何其他文字，格式：
{"merge":[{"ids":["id1","id2"],"title":"...","content":"...","tags":"..."}],"archive":["id3"],"retag":[{"id":"id4","tags":"..."}]}`;

export function buildConsolidationPrompt(entries: KnowledgeEntry[], groups?: string[][]): string {
	const index = new Map<string, number>();
	entries.forEach((e, i) => index.set(e.id, i));
	// Render grouped (semantic clusters first) so the model sees related entries
	// together; falls back to a flat list when no clustering is available.
	const groupOf = new Map<string, number>();
	if (groups && groups.length) {
		groups.forEach((ids, gi) => ids.forEach((id) => groupOf.set(id, gi)));
	}
	const renderEntry = (e: KnowledgeEntry) =>
		`  - id=${e.id} | title=${e.title} | tags=${e.tags || "(无)"} | content=${truncate(e.content, 1500)}`;

	let body: string;
	if (groups && groups.length) {
		const used = new Set<string>();
		const blocks = groups
			.map((ids, gi) => {
				const members = ids
					.map((id) => index.get(id))
					.filter((i): i is number => typeof i === "number")
					.map((i) => entries[i]);
				members.forEach((m) => used.add(m.id));
				if (members.length === 0) return "";
				return `【关联组 ${gi + 1}（语义相近，优先合并/归纳）】\n${members.map(renderEntry).join("\n")}`;
			})
			.filter(Boolean)
			.join("\n\n");
		// Any entries not represented in a group (e.g. embedding skipped some).
		const leftover = entries.filter((e) => !used.has(e.id));
		const leftoverBlock = leftover.length
			? `${blocks ? "\n\n" : ""}【其他】\n${leftover.map(renderEntry).join("\n")}`
			: "";
		body = blocks + leftoverBlock;
	} else {
		body = entries.map((e) => renderEntry(e).trim()).join("\n");
	}

	const topicRule = `- 每条保留/新建的条目都应有规范标签（tags）：用一组稳定的小写中英文短语概括其所属主题（如 退货,售后,物流,账号,支付），让同主题条目能被聚合检索。retag 时即按此规范补全。`;
	return `以下是 ${entries.length} 条知识条目（已按语义初步分组），请按规则输出整理操作 JSON：\n\n${body}\n\n注意：${topicRule}`;
}

/** Parse the model's reply into ops, tolerating fenced code or surrounding prose. */
export function parseConsolidationOps(reply: string): ConsolidateOps {
	const json = extractJson(reply);
	if (!json) return { merge: [], archive: [], retag: [] };
	let obj: Partial<ConsolidateOps>;
	try {
		obj = JSON.parse(json) as Partial<ConsolidateOps>;
	} catch {
		return { merge: [], archive: [], retag: [] };
	}
	const knownIds = new Set<string>();
	const merge: MergeOp[] = Array.isArray(obj.merge)
		? (obj.merge as MergeOp[])
				.filter((m) => Array.isArray(m.ids) && m.ids.length > 0 && m.title && m.content)
				.map((m) => {
					for (const id of m.ids as string[]) knownIds.add(id);
					return {
						ids: (m.ids as string[]).filter((id) => typeof id === "string"),
						title: String(m.title),
						content: String(m.content),
						tags: typeof m.tags === "string" ? m.tags : undefined,
					};
				})
		: [];
	// archive dedups against ids already consumed by a merge.
	const archive = Array.isArray(obj.archive)
		? [...new Set(obj.archive.filter((x): x is string => typeof x === "string"))].filter(
				(id) => !knownIds.has(id),
			)
		: [];
	const retag = Array.isArray(obj.retag)
		? (obj.retag as RetagOp[])
				.filter((r) => r.id && r.tags)
				.map((r) => ({ id: String(r.id), tags: String(r.tags) }))
		: [];
	return { merge, archive, retag };
}

function extractJson(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) return text.slice(start, end + 1);
	return null;
}

// --- critical-value preservation (deterministic backstop) ---------------------
// The consolidation prompt asks the model to keep credentials verbatim, but LLM
// safety training reliably redacts them (we observed account/password replaced
// with "从受控凭据库获取" boilerplate). This is a code-level guarantee: critical
// values (地址/账号/密码/卡号/商户号/密钥/端口…) are extracted from source entries
// and re-checked against the merged content; any that vanished are appended back
// verbatim. Auto-consolidation can therefore never silently drop production
// credentials, regardless of what the model does.

interface CriticalValue {
	label: string;
	value: string;
	snippet: string;
}

/**
 * Label patterns for values that must be preserved verbatim. Each regex's first
 * capture group is the value. Extend this list to cover more field types.
 */
const CRITICAL_PATTERNS: { label: string; re: RegExp }[] = [
	{ label: "地址", re: /(?:地址|网址|链接|端点|域名|访问地址|URL)\s*[:：]\s*([^\s\n，,。、；;｜|]+)/gi },
	{ label: "账号", re: /(?:账号|账户|用户名|登录名|用户ID|UID)\s*[:：]\s*([^\s\n，,。、；;｜|]+)/gi },
	{ label: "密码", re: /(?:密码|口令|pwd|passwd|password)\s*[:：]\s*(\S+)/gi },
	{ label: "卡号", re: /(?:卡号|银行卡号|信用卡号|储蓄卡号)\s*[:：]\s*([^\s\n，,。、；;｜|]+)/gi },
	{ label: "商户号", re: /(?:商户号|商户编号|终端号|商户ID|机构号|MID|TID)\s*[:：]\s*([^\s\n，,。、；;｜|]+)/gi },
	{ label: "密钥/令牌", re: /(?:密钥|秘钥|key|token|令牌|apikey|api_key|secret|appsecret)\s*[:：]\s*(\S+)/gi },
	{ label: "端口", re: /(?:端口|port)\s*[:：]\s*(\d{2,5})/gi },
];

const TRAILING_PUNCT = /[。.，,；;：:、|｜]+$/;

/** Pull every critical value out of `text` as { label, value, snippet }. */
export function extractCriticalValues(text: string): CriticalValue[] {
	const out: CriticalValue[] = [];
	for (const { label, re } of CRITICAL_PATTERNS) {
		const rx = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = rx.exec(text)) !== null) {
			const value = (m[1] ?? "").replace(TRAILING_PUNCT, "");
			if (!value) continue;
			out.push({ label, value, snippet: m[0].trim() });
		}
	}
	return out;
}

/**
 * Guarantee every critical value present in the `sources` also appears verbatim
 * in `merged`. Missing ones are appended under a clearly-marked section so the
 * model's redaction can never silently drop production credentials. Returns the
 * (possibly amended) merged content and the list of values that had to be restored.
 */
export function ensureCriticalValuesPreserved(
	merged: string,
	sources: string[],
): { content: string; restored: CriticalValue[] } {
	const seen = new Set<string>();
	const restored: CriticalValue[] = [];
	for (const src of sources) {
		for (const cv of extractCriticalValues(src)) {
			if (seen.has(cv.value)) continue;
			seen.add(cv.value);
			if (!merged.includes(cv.value)) restored.push(cv);
		}
	}
	if (restored.length === 0) return { content: merged, restored };
	const lines = restored.map((m) => `- ${m.snippet}`);
	return {
		content: `${merged.trimEnd()}\n\n## 关键信息（整理时自动保留，原样勿改）\n${lines.join("\n")}`,
		restored,
	};
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

// --- gap-driven research synthesis ---
// When auto-research is on, the scheduler picks high-frequency KB misses
// (gaps), runs a web search, and asks the LLM to distill the hits into one
// concise, reusable knowledge entry. Result is stored as origin='research',
// pending review, low confidence — never asserted as authoritative.

export const RESEARCH_SYNTHESIS_SYSTEM = `你是知识整理助手。基于联网检索到的资料片段，针对一个“知识库未命中”的查询，归纳出一条简明、可复用的知识条目。
要求：
- 仅依据给定资料归纳，资料不足或互相矛盾时不要编造，直接返回 {"skip": true}。
- 内容写清结论与适用条件，标注来源域名；语言简练（中文）。
- 输出严格 JSON：{"skip": false, "title": "...", "content": "...", "tags": "逗号分隔"}
- title 简明概括；content 200 字以内；tags 1-3 个。`;

export interface ResearchSynthesis {
	skip: boolean;
	title?: string;
	content?: string;
	tags?: string;
}

export function buildResearchSynthesisPrompt(query: string, hits: { title: string; snippet: string; url: string }[]): string {
	const lines = hits.map((h, i) => `[${i + 1}] ${h.title}\n${truncate(h.snippet, 300)}\n来源: ${h.url}`);
	return `查询（知识库未命中）：${query}\n\n检索到的资料片段：\n${lines.join("\n\n")}\n\n请归纳为一条知识条目。`;
}

export function parseResearchSynthesis(reply: string): ResearchSynthesis {
	const json = extractJson(reply);
	if (!json) return { skip: true };
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(json) as Record<string, unknown>;
	} catch {
		return { skip: true };
	}
	if (obj.skip === true) return { skip: true };
	const title = typeof obj.title === "string" ? obj.title.trim() : "";
	const content = typeof obj.content === "string" ? obj.content.trim() : "";
	if (!title || !content) return { skip: true };
	const tags = typeof obj.tags === "string" ? obj.tags.trim() : "";
	return { skip: false, title, content, tags };
}
