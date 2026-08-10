/**
 * External knowledge-base presets.
 *
 * Each preset ships ready-made HTTP operation templates (search / upload /
 * parse / list) plus response mappings for the common open-source RAG
 * platforms, so the user only fills baseUrl + apiKey + datasetId. `custom`
 * leaves everything blank for arbitrary OpenAI-style / self-built endpoints.
 *
 * API shapes verified against:
 *  - RAGFlow v0.20.x HTTP API (dataset-centric; /api/v1/retrieval, documents, chunks)
 *  - Dify knowledge API (/datasets/{id}/retrieve, document/create-by-file; async index)
 *
 * Placeholders resolved by the client: {{datasetId}} {{query}} {{topK}}
 * {{documentId}} {{fileName}}. Auth (`Authorization: Bearer <apiKey>`) is
 * injected by the client from cfg.apiKey.
 */
import { randomUUID } from "node:crypto";
import type {
	ExternalDatasetsMapping,
	ExternalListMapping,
	ExternalOpTemplate,
	ExternalPresetType,
	ExternalProviderConfig,
	ExternalResponseMapping,
} from "../../db/config-store.js";

export interface ExternalPreset {
	label: string;
	operations: {
		search: ExternalOpTemplate;
		upload?: ExternalOpTemplate;
		parse?: ExternalOpTemplate;
		list?: ExternalOpTemplate;
		/** List all accessible datasets (no datasetId) — for the dataset picker. */
		datasets?: ExternalOpTemplate;
	};
	responseMapping: ExternalResponseMapping;
	listMapping?: ExternalListMapping;
	datasetsMapping?: ExternalDatasetsMapping;
}

const DEFAULT_SEARCH: ExternalOpTemplate = { method: "POST", path: "" };

export const PRESETS: Record<ExternalPresetType, ExternalPreset> = {
	ragflow: {
		label: "RAGFlow",
		operations: {
			search: {
				method: "POST",
				path: "/api/v1/retrieval",
				bodyTemplate:
					'{"question":"{{query}}","dataset_ids":["{{datasetId}}"],"page":1,"page_size":{{topK}},"similarity_threshold":0.2}',
			},
			upload: {
				method: "POST",
				path: "/api/v1/datasets/{{datasetId}}/documents",
				multipartField: "file",
			},
			parse: {
				method: "POST",
				path: "/api/v1/datasets/{{datasetId}}/chunks",
				bodyTemplate: '{"document_ids":["{{documentId}}"]}',
			},
			list: {
				method: "GET",
				path: "/api/v1/datasets/{{datasetId}}/documents?page=1&page_size=50",
			},
			datasets: {
				method: "GET",
				path: "/api/v1/datasets?page=1&page_size=100",
			},
		},
		// RAGFlow retrieval: results under data.chunks; chunk fields include
		// content / document_keyword / document_id.
		responseMapping: {
			resultsPath: "data.chunks",
			snippetPath: "content",
			titlePath: "document_keyword",
			sourcePath: "document_id",
		},
		listMapping: { documentsPath: "data.docs", idPath: "id", namePath: "name", statusPath: "run" },
		datasetsMapping: { resultsPath: "data", idPath: "id", namePath: "name" },
	},
	dify: {
		label: "Dify",
		operations: {
			search: {
				method: "POST",
				path: "/datasets/{{datasetId}}/retrieve",
				bodyTemplate: '{"query":"{{query}}","retrieval_strategy":{"top_k":{{topK}}}}',
			},
			upload: {
				method: "POST",
				path: "/datasets/{{datasetId}}/document/create-by-file",
				multipartField: "file",
				// Dify expects a `data` JSON part alongside the file.
				bodyTemplate:
					'{"name":"{{fileName}}","indexing_technique":"high_quality","process_rule":{"mode":"automatic"}}',
			},
			// Dify indexes asynchronously after upload — no separate parse endpoint.
			list: {
				method: "GET",
				path: "/datasets/{{datasetId}}/documents?page=1&limit=50",
			},
			datasets: {
				method: "GET",
				path: "/datasets?page=1&limit=100",
			},
		},
		responseMapping: {
			resultsPath: "records",
			snippetPath: "content",
			titlePath: "document_name",
			sourcePath: "segment_id",
		},
		listMapping: { documentsPath: "data", idPath: "id", namePath: "name", statusPath: "display_status" },
		datasetsMapping: { resultsPath: "data", idPath: "id", namePath: "name" },
	},
	custom: {
		label: "自定义",
		operations: { search: DEFAULT_SEARCH },
		responseMapping: { resultsPath: "data", snippetPath: "content" },
	},
};

/**
 * Apply a preset to an existing config: replace operation templates +
 * mappings, but preserve identity (id/name/enabled) and connection fields
 * (baseUrl/apiKey/datasetId) so switching type doesn't lose the user's keys.
 */
export function applyPreset(type: ExternalPresetType, cfg: ExternalProviderConfig): ExternalProviderConfig {
	const preset = PRESETS[type];
	return {
		...cfg,
		type,
		name: cfg.name || preset.label,
		operations: structuredClone(preset.operations),
		responseMapping: { ...preset.responseMapping },
		listMapping: preset.listMapping ? { ...preset.listMapping } : undefined,
		datasetsMapping: preset.datasetsMapping ? { ...preset.datasetsMapping } : undefined,
	};
}

/** Build a fresh provider of the given preset type (for the UI "add" button). */
export function newExternalProvider(type: ExternalPresetType): ExternalProviderConfig {
	const preset = PRESETS[type];
	return {
		id: randomUUID(),
		name: preset.label,
		enabled: true,
		type,
		baseUrl: "",
		apiKey: "",
		datasetId: "",
		operations: structuredClone(preset.operations),
		responseMapping: { ...preset.responseMapping },
		listMapping: preset.listMapping ? { ...preset.listMapping } : undefined,
		datasetsMapping: preset.datasetsMapping ? { ...preset.datasetsMapping } : undefined,
	};
}
