/**
 * The built-in employee definition: who it is (system prompt) and what it can
 * do (tools). This is the single shipped employee — no agent-builder UI.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { KnowledgeService } from "../knowledge/knowledge-service.js";
import type { BrowserService } from "../browser/browser-service.js";
import type { SchedulerService } from "../scheduler/scheduler-service.js";
import type { DocumentService, FileSenderResolver } from "../documents/document-service.js";
import type { FileSystemService } from "../filesystem/filesystem-service.js";
import { inferConversationOrigin } from "../db/history-store.js";
import { buildSystemPrompt } from "./prompt.js";
import { createKnowledgeTool } from "./tools/knowledge.js";
import { createSaveToKnowledgeTool } from "./tools/save-knowledge.js";
import { createManageKnowledgeTool } from "./tools/manage-knowledge.js";
import { createResearchWebTool } from "./tools/research-web.js";
import { createBrowserTools } from "./tools/browser.js";
import { createSchedulerTools } from "./tools/scheduler.js";
import { createDocumentTools } from "./tools/documents.js";
import { createFilesystemTools } from "./tools/filesystem.js";
import { orderTool } from "./tools/orders.js";
import { escalateTool } from "./tools/escalate.js";

export { buildSystemPrompt, BASE_RULES_SUMMARY } from "./prompt.js";

export interface ToolSetOptions {
	kbEnabled: boolean;
	learnEnabled: boolean;
	manageEnabled: boolean;
	researchEnabled: boolean;
	browserEnabled: boolean;
	schedulerEnabled: boolean;
	documentsEnabled: boolean;
	filesystemEnabled: boolean;
	knowledge: KnowledgeService;
	browser: BrowserService;
	scheduler: SchedulerService;
	documents: DocumentService;
	filesystem: FileSystemService;
	conversationId: string;
	/** Live vision-capability check for the session's current model (read at tool
	 * execution time so mid-session model switches are honored). */
	isVisionModel: () => boolean;
	/**
	 * Resolves the current turn's channel file-sender for a conversation (set by
	 * the engine from the inbound context), or undefined when the channel can't
	 * send files. Read at tool-execution time so it reflects the live turn.
	 */
	resolveFileSender?: FileSenderResolver;
}

/** Assemble the employee's tools; capability tools are conditional on their config flags. */
export function buildTools(options: ToolSetOptions): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [];
	if (options.kbEnabled) {
		tools.push(createKnowledgeTool(options.knowledge));
		if (options.learnEnabled) tools.push(createSaveToKnowledgeTool(options.knowledge));
		if (options.manageEnabled) tools.push(createManageKnowledgeTool(options.knowledge));
		if (options.researchEnabled) tools.push(createResearchWebTool(options.knowledge));
	}
	if (options.browserEnabled) tools.push(...createBrowserTools(options.browser, options.isVisionModel));
	if (options.documentsEnabled)
		tools.push(...createDocumentTools(options.documents, options.conversationId, options.resolveFileSender));
	if (options.filesystemEnabled) tools.push(...createFilesystemTools(options.filesystem));
	if (options.schedulerEnabled) {
		const origin = inferConversationOrigin(options.conversationId);
		tools.push(...createSchedulerTools(options.scheduler, options.conversationId, origin));
	}
	tools.push(orderTool, escalateTool);
	return tools;
}
