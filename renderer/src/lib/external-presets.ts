/**
 * Renderer-side mirror of src/knowledge/external/presets.ts — the provider
 * config is edited client-side then persisted via config:set, so the preset
 * templates must be available in the renderer to fill the form on type switch.
 * Keep in sync with the main-process copy (browser-safe randomUUID only).
 */
import type {
	ExternalDatasetsMapping,
	ExternalListMapping,
	ExternalOpTemplate,
	ExternalPresetType,
	ExternalProviderConfig,
} from "./types";

interface ExternalPreset {
	label: string;
	operations: {
		search: ExternalOpTemplate;
		upload?: ExternalOpTemplate;
		parse?: ExternalOpTemplate;
		list?: ExternalOpTemplate;
		datasets?: ExternalOpTemplate;
	};
	responseMapping: { resultsPath: string; snippetPath: string; titlePath?: string; sourcePath?: string };
	listMapping?: ExternalListMapping;
	datasetsMapping?: ExternalDatasetsMapping;
}

export const EXTERNAL_PRESET_TYPES: { value: ExternalPresetType; label: string }[] = [
	{ value: "ragflow", label: "RAGFlow" },
	{ value: "dify", label: "Dify" },
	{ value: "custom", label: "自定义" },
];

const PRESETS: Record<ExternalPresetType, ExternalPreset> = {
	ragflow: {
		label: "RAGFlow",
		operations: {
			search: {
				method: "POST",
				path: "/api/v1/retrieval",
				bodyTemplate:
					'{"question":"{{query}}","dataset_ids":["{{datasetId}}"],"page":1,"page_size":{{topK}},"similarity_threshold":0.2}',
			},
			upload: { method: "POST", path: "/api/v1/datasets/{{datasetId}}/documents", multipartField: "file" },
			parse: {
				method: "POST",
				path: "/api/v1/datasets/{{datasetId}}/chunks",
				bodyTemplate: '{"document_ids":["{{documentId}}"]}',
			},
			list: { method: "GET", path: "/api/v1/datasets/{{datasetId}}/documents?page=1&page_size=50" },
			datasets: { method: "GET", path: "/api/v1/datasets?page=1&page_size=100" },
		},
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
				bodyTemplate:
					'{"name":"{{fileName}}","indexing_technique":"high_quality","process_rule":{"mode":"automatic"}}',
			},
			list: { method: "GET", path: "/datasets/{{datasetId}}/documents?page=1&limit=50" },
			datasets: { method: "GET", path: "/datasets?page=1&limit=100" },
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
		operations: { search: { method: "POST", path: "" } },
		responseMapping: { resultsPath: "data", snippetPath: "content" },
	},
};

function clone(preset: ExternalPreset): Pick<ExternalProviderConfig, "operations" | "responseMapping" | "listMapping" | "datasetsMapping"> {
	return {
		operations: JSON.parse(JSON.stringify(preset.operations)),
		responseMapping: { ...preset.responseMapping },
		listMapping: preset.listMapping ? { ...preset.listMapping } : undefined,
		datasetsMapping: preset.datasetsMapping ? { ...preset.datasetsMapping } : undefined,
	};
}

/** Apply a preset to an existing config, preserving identity + connection fields. */
export function applyExternalPreset(
	type: ExternalPresetType,
	cfg: ExternalProviderConfig,
): ExternalProviderConfig {
	const preset = PRESETS[type];
	return { ...cfg, type, name: cfg.name || preset.label, ...clone(preset) };
}

/** Build a fresh provider of the given preset type. */
export function newExternalProvider(type: ExternalPresetType): ExternalProviderConfig {
	const preset = PRESETS[type];
	return {
		id: globalThis.crypto.randomUUID(),
		name: preset.label,
		enabled: true,
		type,
		baseUrl: "",
		apiKey: "",
		datasetId: "",
		...clone(preset),
	};
}
