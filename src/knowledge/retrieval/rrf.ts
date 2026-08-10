/**
 * Reciprocal Rank Fusion — combine multiple ranked lists into one by scoring
 * each item as sum(weight / (k + rank)). Provider-agnostic: used to fuse BM25 +
 * vector locally, and later to fuse local + external sources.
 */
const DEFAULT_K = 60;

export interface RrfInput<T> {
	list: T[];
	/** Weight applied to this list's contribution (default 1). */
	weight?: number;
}

export interface RrfEntry<T> {
	item: T;
	score: number;
}

/**
 * Fuse ranked lists. Returns entries keyed by `keyOf`, preserving the first
 * item seen for each key. Callers sort the values by `score` descending.
 */
export function reciprocalRankFuse<T>(
	inputs: RrfInput<T>[],
	keyOf: (item: T) => string,
	k: number = DEFAULT_K,
): Map<string, RrfEntry<T>> {
	const scores = new Map<string, RrfEntry<T>>();
	for (const { list, weight = 1 } of inputs) {
		list.forEach((item, index) => {
			const key = keyOf(item);
			const contribution = weight / (k + index + 1);
			const existing = scores.get(key);
			if (existing) existing.score += contribution;
			else scores.set(key, { item, score: contribution });
		});
	}
	return scores;
}
