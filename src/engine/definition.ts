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
import type { ReportService } from "../reports/report-service.js";
import type { DownloadService } from "../downloads/download-service.js";
import type { SkillWriter } from "./skills/skill-writer.js";
import type { ConfigStore } from "../db/config-store.js";
import type { InboundActor } from "../im/types.js";
import { inferConversationOrigin } from "../db/history-store.js";
import { buildSystemPrompt } from "./prompt.js";
import { createKnowledgeTool } from "./tools/knowledge.js";
import { createSaveToKnowledgeTool } from "./tools/save-knowledge.js";
import { createManageKnowledgeTool } from "./tools/manage-knowledge.js";
import { createSaveToSkillTool } from "./tools/save-skill.js";
import { createReadSkillAssetTool } from "./tools/read-skill-asset.js";
import { createResearchWebTool } from "./tools/research-web.js";
import { createBrowserTools } from "./tools/browser.js";
import { createSchedulerTools } from "./tools/scheduler.js";
import { createDocumentTools } from "./tools/documents.js";
import { createFilesystemTools } from "./tools/filesystem.js";
import { createDownloadTools } from "./tools/downloads.js";
import { createSaveReportTool } from "./tools/reports.js";
import { createSendImageTool, type ImageSenderResolver } from "./tools/send-image.js";
import { createManageAdminTool, createUpdateIdentityTool, type AdminToolDeps } from "./tools/admin.js";
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
	reportsEnabled: boolean;
	downloadsEnabled: boolean;
	knowledge: KnowledgeService;
	browser: BrowserService;
	scheduler: SchedulerService;
	documents: DocumentService;
	filesystem: FileSystemService;
	reportService: ReportService;
	downloadService: DownloadService;
	/** Writes declarative SKILL.md packages to the user skills dir (always wired —
	 * skill authoring is a built-in channel, not gated by a config flag). */
	skillWriter: SkillWriter;
	/** User skills dir root — lets read_skill_asset resolve a skill's bundled
	 * assets (scripts/templates) by relative path. Always wired (skills are on). */
	userSkillsDir: string;
	/** Persistent config store used by guarded admin/identity tools. */
	config: ConfigStore;
	/** Resolve the verified IM actor + raw inbound text for the turn in flight. */
	resolveActor: (conversationId: string) => (InboundActor & { text: string }) | undefined;
	/** Called after a skill is written/updated, so the engine can refresh its
	 * skill cache and mark sessions stale without aborting the running turn. */
	onSkillsChanged: () => Promise<void>;
	/** Mark sessions stale after a conversation-side config change, without
	 * aborting the turn that performed it. */
	onConfigChanged: () => void;
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
	/**
	 * Resolves the current turn's inline-image sender for a conversation (set by
	 * the engine from the inbound context), or undefined when the channel can't
	 * send images. Read at tool-execution time so it reflects the live turn.
	 */
	resolveImageSender?: ImageSenderResolver;
	/**
	 * Resolves a managed directory where browser screenshots are also saved to
	 * disk (so send_image can deliver them). Absent → screenshots stay in-context
	 * only. Provided by the engine from the downloads dir.
	 */
	screenshotDir?: () => Promise<string | undefined>;
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
	if (options.browserEnabled)
		tools.push(
			...createBrowserTools(options.browser, options.isVisionModel, options.screenshotDir, () => options.conversationId),
		);
	if (options.browserEnabled && options.downloadsEnabled)
		tools.push(...createDownloadTools(options.downloadService, options.browser, () => options.conversationId));
	if (options.documentsEnabled)
		tools.push(...createDocumentTools(options.documents, options.conversationId, options.resolveFileSender));
	if (options.filesystemEnabled) tools.push(...createFilesystemTools(options.filesystem));
	if (options.schedulerEnabled) {
		const origin = inferConversationOrigin(options.conversationId);
		tools.push(...createSchedulerTools(options.scheduler, options.conversationId, origin));
	}
	if (options.reportsEnabled) tools.push(createSaveReportTool(options.reportService, options.conversationId));
	// Skill authoring is an always-on channel: explicit 技能/Skill intent writes
	// here; everything else defaults to the knowledge base (see prompt routing rules).
	tools.push(createSaveToSkillTool(options.skillWriter, options.onSkillsChanged));
	// Read-only access to a skill's bundled assets (scripts/templates that shipped
	// alongside SKILL.md in a zip or directory import). Always-on with skills.
	tools.push(createReadSkillAssetTool(options.userSkillsDir));
	// Inline image delivery — degrades to a text notice when the channel can't send
	// images, so it's safe to always register.
	tools.push(createSendImageTool(options.resolveImageSender, options.conversationId));
	// Guarded config tools — always registered; the tools themselves enforce
	// sender identity (1:1 IM + admin whitelist / explicit confirmation).
	const adminDeps: AdminToolDeps = {
		config: options.config,
		resolveActor: options.resolveActor,
		onConfigChanged: options.onConfigChanged,
		conversationId: options.conversationId,
	};
	tools.push(createManageAdminTool(adminDeps), createUpdateIdentityTool(adminDeps));
	tools.push(orderTool, escalateTool);
	return tools;
}
