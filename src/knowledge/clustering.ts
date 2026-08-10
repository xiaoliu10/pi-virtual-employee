/**
 * Greedy embedding-similarity clustering for knowledge consolidation.
 *
 * Entries have no dedicated embedding; we embed a short proxy (title, or title +
 * first line) and cluster by cosine similarity so semantically related entries
 * are presented to the LLM as one group — improving merge/generalization quality
 * and producing coherent canonical tags.
 *
 * Single-linkage greedy: each item joins the cluster it is most similar to (max
 * cosine over the cluster's members) if that similarity ≥ threshold, otherwise it
 * starts its own cluster. O(n²) is fine for consolidation batch sizes (< 100).
 */

export interface EmbedItem {
	id: string;
	vec: Float32Array;
}

/** Cosine similarity for equal-length Float32Arrays. */
export function cosine(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

/**
 * Cluster items by cosine similarity. Returns arrays of ids, ordered largest-first
 * (ties broken by first-seen). Items below `threshold` to every existing cluster
 * form their own singleton cluster.
 */
export function clusterBySimilarity(items: EmbedItem[], threshold = 0.75): string[][] {
	const clusters: { ids: string[]; vecs: Float32Array[] }[] = [];
	for (const item of items) {
		let best = -1;
		let bestScore = threshold;
		for (let i = 0; i < clusters.length; i++) {
			// Max similarity to any member (single linkage).
			let maxSim = -1;
			for (const v of clusters[i].vecs) {
				const sim = cosine(item.vec, v);
				if (sim > maxSim) maxSim = sim;
			}
			if (maxSim > bestScore) {
				bestScore = maxSim;
				best = i;
			}
		}
		if (best >= 0) {
			clusters[best].ids.push(item.id);
			clusters[best].vecs.push(item.vec);
		} else {
			clusters.push({ ids: [item.id], vecs: [item.vec] });
		}
	}
	return clusters
		.map((c) => c.ids)
		.sort((a, b) => b.length - a.length || 0);
}
