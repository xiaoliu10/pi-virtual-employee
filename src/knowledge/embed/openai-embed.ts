/**
 * OpenAI-compatible embedding provider.
 *
 * Calls `POST {baseUrl}/embeddings` with the supplier's API key, reusing the
 * existing model-supplier config. Anthropic has no embedding product, so
 * embedding is restricted to OpenAI-compatible suppliers elsewhere in the stack.
 * Implemented with plain fetch — no extra SDK dependency.
 */
import type { EmbedProvider } from "../types.js";

export interface OpenAIEmbedOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
	dims: number;
	batchSize: number;
}

interface EmbeddingResponse {
	data: { embedding: number[] }[];
}

export class OpenAIEmbedProvider implements EmbedProvider {
	readonly model: string;
	readonly dims: number;
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly batchSize: number;

	constructor(opts: OpenAIEmbedOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/$/, "");
		this.apiKey = opts.apiKey;
		this.model = opts.model;
		this.dims = opts.dims;
		this.batchSize = Math.max(1, opts.batchSize || 64);
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		const out: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += this.batchSize) {
			const batch = texts.slice(i, i + this.batchSize);
			out.push(...(await this.call(batch)));
		}
		return out;
	}

	async embedOne(text: string): Promise<Float32Array> {
		const [vec] = await this.call([text]);
		return vec;
	}

	private async call(inputs: string[]): Promise<Float32Array[]> {
		if (!this.apiKey.trim()) throw new Error("embedding supplier has no API key");
		const url = `${this.baseUrl}/embeddings`;
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({ model: this.model, input: inputs }),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`embedding request failed (${res.status}): ${detail.slice(0, 200)}`);
		}
		const json = (await res.json()) as EmbeddingResponse;
		return json.data.map((d) => new Float32Array(d.embedding));
	}
}

/**
 * Probe the real output dimension of an embedding model by sending a throwaway
 * input. Used by the settings UI to backfill KbConfig.local.embedding.dimensions
 * so the vec0 table is created with the correct width.
 */
export async function probeEmbeddingDimensions(opts: {
	baseUrl: string;
	apiKey: string;
	model: string;
}): Promise<number> {
	const provider = new OpenAIEmbedProvider({ ...opts, dims: 0, batchSize: 1 });
	const vec = await provider.embedOne("ping");
	return vec.length;
}
