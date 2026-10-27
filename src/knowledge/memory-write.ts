/**
 * Memory write-time helpers: conflict detection, declarative phrasing, and
 * the short-term/durable routing hint.
 *
 * Why these live here and not in the store: they shape what the MODEL is told
 * before it commits a fact, not what the DB accepts. The store stays a dumb
 * key-value-ish writer (same title overwrites), and these rules keep the model
 * from authoring memories that will rot or fight each other later.
 */

/** Placeholder phrase used when a near-duplicate title is detected. */
export const CONFLICT_HINT_TEMPLATE =
	"注意：已有相近记忆「{title}」（{summary}）。若这是对它的纠正，请用相同标题重新 remember 覆盖；若是不同事实，请改用更能区分两者的标题。";

/** Imperative openers that turn a memory into a future command. */
const IMPERATIVE_PREFIXES = [
	"始终", "永远", "总是", "一定", "必须", "务必", "不要再", "别再", "不要", "禁止", "应该", "应当", "需要",
	"always", "never", "must", "should", "do not", "don't", "make sure",
];

/**
 * Memories are re-read in later sessions and imperative phrasing gets consumed
 * as a live instruction, where it can override the user's CURRENT request.
 * Hermes states the rule as: "Write entries as declarative facts, not
 * instructions to yourself: 'User prefers concise responses' ✓ — 'Always
 * respond concisely' ✗".
 *
 * This does not rewrite the model's text (silent rewriting loses the user's
 * nuance); it returns a hint the tool prepends to its reply so the model learns
 * the convention and can correct itself.
 */
export function memoryPhrasingHint(content: string): string | null {
	const text = content.trim();
	if (!text) return null;
	// Second person ("你以后都用...") also reads as a directive in later turns.
	if (/^你(要|应该|必须|总是|以后)/.test(text)) {
		return "这条记忆写成了对「你」的祈使要求——记忆会被后续会话当成命令执行，可能压过对方当时的真实诉求。建议改写成陈述事实（如「对方偏好…」「这套环境的做法是…」）。";
	}
	const lower = text.toLowerCase();
	for (const prefix of IMPERATIVE_PREFIXES) {
		if (lower.startsWith(prefix.toLowerCase())) {
			return "这条记忆以祈使句开头（「始终/必须/不要…」），后续会话可能把它当命令执行。建议改写成陈述事实（如「对方偏好…」「该系统的规则是…」）。";
		}
	}
	return null;
}

/**
 * Facts expected to expire within a week belong in the conversation, not in
 * durable memory: they crowd the recall budget and then rot into misleading
 * "current truth". Hermes draws the same line ("A fact stale within a week
 * belongs in session history").
 *
 * Detection is deliberately narrow — only explicit near-term time references.
 * A false positive here would silently push a useful fact out of memory, so
 * anything ambiguous (dates without a horizon, "最近") stays durable.
 */
export function looksShortLived(content: string, now = Date.now()): string | null {
	const text = content.trim();
	if (!text) return null;
	const relative = text.match(/(今天|今晚|明天|后天|这周|本周|这周内|本周内|下周|接下来几天|这两天|这两天里|这几天)/);
	if (relative) {
		return `这条带有短期时间限定（「${relative[1]}」）——一周内就会过时的事实不适合进长期记忆，会在之后的会话里变成误导。建议先用于当前对话，或改写成不随时间变化的部分（如长期偏好）。`;
	}
	// An absolute date within 7 days is also short-lived.
	const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
	if (iso) {
		const when = Date.parse(`${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}T23:59:59`);
		if (Number.isFinite(when) && when - now <= 7 * 24 * 60 * 60 * 1000 && when >= now - 24 * 60 * 60 * 1000) {
			return "这条记忆指向的是 7 天内的日期——短期事实放进长期记忆，过期后会变成误导。建议只记住其中长期有效的部分。";
		}
	}
	return null;
}

/** Normalized title key for near-duplicate detection. */
export function memoryTitleKey(title: string): string {
	return title
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "")
		.trim();
}

/** Character-bigram set, the cheap Chinese-friendly similarity proxy. */
function bigrams(text: string): Set<string> {
	const key = memoryTitleKey(text);
	const out = new Set<string>();
	if (key.length < 2) {
		if (key) out.add(key);
		return out;
	}
	for (let i = 0; i + 2 <= key.length; i += 1) out.add(key.slice(i, i + 2));
	return out;
}

/**
 * Similarity in [0,1] between two memory titles (Dice coefficient over
 * character bigrams). Titles are short and often Chinese, where word
 * tokenization is unavailable — bigrams are the standard cheap approximation.
 */
export function titleSimilarity(a: string, b: string): number {
	const A = bigrams(a);
	const B = bigrams(b);
	if (!A.size || !B.size) return 0;
	let shared = 0;
	for (const gram of A) if (B.has(gram)) shared += 1;
	return (2 * shared) / (A.size + B.size);
}

/** Threshold above which two titles are treated as "the same topic". */
export const CONFLICT_THRESHOLD = 0.62;

export interface ConflictCandidate {
	id: string;
	title: string;
	summary?: string | null;
}

/**
 * Pick the most similar existing memory for the incoming title, or null.
 * Exact-same-title is NOT a conflict: that is the sanctioned correction path
 * (same key overwrites in place).
 */
export function findTitleConflict(
	incomingTitle: string,
	existing: ConflictCandidate[],
): ConflictCandidate | null {
	let best: ConflictCandidate | null = null;
	let bestScore = 0;
	const incomingKey = memoryTitleKey(incomingTitle);
	for (const row of existing) {
		if (memoryTitleKey(row.title) === incomingKey) continue; // exact overwrite, not a conflict
		const score = titleSimilarity(incomingTitle, row.title);
		if (score > bestScore) {
			bestScore = score;
			best = row;
		}
	}
	return bestScore >= CONFLICT_THRESHOLD ? best : null;
}
