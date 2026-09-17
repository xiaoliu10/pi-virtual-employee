/**
 * The built-in employee definition: who it is (system prompt) and what it can
 * do (tools). This is the single shipped employee — no agent-builder UI.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { KnowledgeService } from "../knowledge/knowledge-service.js";
import type { BrowserService } from "../browser/browser-service.js";
import type { ComputerService } from "../computer/computer-service.js";
import { createComputerTools } from "./tools/computer.js";
import type { SchedulerService } from "../scheduler/scheduler-service.js";
import type { DocumentService, FileSenderResolver } from "../documents/document-service.js";
import type { FileSystemService } from "../filesystem/filesystem-service.js";
import type { ReportService } from "../reports/report-service.js";
import type { DownloadService } from "../downloads/download-service.js";
import type { SkillWriter } from "./skills/skill-writer.js";
import type { ConfigStore } from "../db/config-store.js";
import type { TelemetryStore } from "../db/telemetry-store.js";
import { createMyStatsTool } from "./tools/telemetry.js";
import { createProposeImprovementTool } from "./tools/proposals.js";
import { createPromptLabTool } from "./tools/prompt-lab.js";
import type { PromptLab } from "../db/prompt-lab.js";
import type { ProposalStore } from "./proposals.js";
import type { InboundActor } from "../im/types.js";
import { inferConversationOrigin } from "../db/history-store.js";
import { buildSystemPrompt } from "./prompt.js";
import { createKnowledgeTool } from "./tools/knowledge.js";
import { createSaveToKnowledgeTool, createRememberTool } from "./tools/save-knowledge.js";
import { createManageKnowledgeTool } from "./tools/manage-knowledge.js";
import { createSaveToSkillTool } from "./tools/save-skill.js";
import { createRefreshSkillsTool } from "./tools/refresh-skills.js";
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
import { createManageUpdateTool, type UpdateOperations } from "./tools/update.js";
import { createManageCapabilitiesTool } from "./tools/capabilities.js";
import { createRunCommandTool, createManageProcessTool, type ShellToolDeps } from "./tools/shell.js";
import { createManageSettingsTool } from "./tools/settings.js";
import { orderTool } from "./tools/orders.js";
import { escalateTool } from "./tools/escalate.js";
import { CAPABILITY_LABEL, checkPermission, permissionRefusal } from "../security/permissions.js";
import { createCheckMyAccessTool, createManageAccessTool, type AccessToolDeps } from "./tools/access.js";

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
	/** Fired after a memory entry is saved — bumps the prompt revision so live sessions rebuild with the fresh index. */
	onMemoryChanged?: () => void;
	browser: BrowserService;
	computer?: ComputerService;
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
	/** Fired when a guarded tool refused because the turn actor's role is below
	 * the capability floor. The engine registers a pending one-shot admin
	 * authorization (「确认授权」) for the conversation; refusing to fire it for
	 * confirmation-gated or misconfig refusals is deliberate. */
	onRoleRefusal?: (conversationId: string, info: { capability: string; need: string }) => void;
	/** Resolve the verified IM actor + raw inbound text for the turn in flight. */
	resolveActor: (conversationId: string) => (InboundActor & { text: string }) | undefined;
	/** Called after a skill is written/updated, so the engine can refresh its
	 * skill cache and mark sessions stale without aborting the running turn. */
	onSkillsChanged: () => Promise<void>;
	/** Fresh skill listing for refresh_skills — the engine's listSkills(), used
	 * to report what the reload actually picked up. */
	listSkills: () => Promise<{ skills: { name: string }[]; info: { name: string; enabled: boolean }[] }>;
	/** Mark sessions stale after a conversation-side config change, without
	 * aborting the turn that performed it. */
	onConfigChanged: () => void;
	conversationId: string;
	/** Live vision-capability check for the session's current model (read at tool
	 * execution time so mid-session model switches are honored). */
	isVisionModel: () => boolean;
	/** Conversation-side app updater, injected by the main process. Undefined in
	 * non-packaged/non-Electron contexts leaves manage_update off the tool list. */
	updates?: UpdateOperations;
	/** Packaged playwright cli.js path — lets manage_capabilities install the
	 * Chromium kernel from a headless conversation. Always wired (skills are on). */
	playwrightCliPath: () => string;
	/** Persistent append-only log for run_command authorization/execution events. */
	shellAuditLogPath?: string;
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
	/**
	 * Known conversations for the RBAC policy editor (so an admin can find a
	 * group's id to apply floors to without knowing DingTalk's openConversationId).
	 */
	listConversations?: () => { id: string; title: string | null; origin: string }[];
	/**
	 * Observed participants of a conversation (senders whose messages we've seen).
	 * Resolves "给这个群的人设权限" to real staffIds instead of a guess.
	 */
	listMembers?: (conversationId: string) => { staffId: string; name: string | null; lastSeenAt: number; messageCount: number }[];
	/**
	 * Called after every tool call with its outcome. This is the only place that
	 * sees each call exactly once, so the telemetry wrapper lives here rather than
	 * inside each tool (a newly added tool is then covered by construction).
	 */
	onToolEvent?: (event: { name: string; durationMs: number; ok: boolean; refused?: boolean; refusedCapability?: string; error?: string }) => void;
	/** Telemetry store for the self-inspection tool (my_stats). */
	telemetry?: TelemetryStore;
	/** Proposal store (self-improvement loop output: propose_improvement). */
	proposals?: ProposalStore;
	/** Where proposals live on disk (shown in the tool's output). */
	proposalsDir?: string;
	/** Prompt lab (evaluation cases + variants + history for prompt.rules). */
	promptLab?: PromptLab;
	/** Isolated evaluation turn runner, provided by the engine. */
	runEvalTurn?: (input: string, variantText: string) => Promise<string>;
	/** Assembles the system prompt as it would be with a candidate rules text. */
	buildPromptWithRules?: (rules: string) => string;
}

/** Assemble the employee's tools; capability tools are conditional on their config flags. */
export function buildTools(options: ToolSetOptions): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [];
	/**
	 * Capability guard (RBAC): wraps a tool's execute with a server-side
	 * permission check against the CURRENT turn's platform-verified actor —
	 * the model never mediates who may call what, so prompt injection in
	 * message/web/file content cannot escalate access. The check is per-turn
	 * (resolveActor reads the live turn actor), so one group conversation
	 * serves different senders at their own roles.
	 */
	const guarded = (capability: string, tool: AgentTool<any>): AgentTool<any> => ({
		...tool,
		async execute(toolCallId, params, signal, onUpdate) {
			const gate = checkPermission(options.config, options.resolveActor(options.conversationId), options.conversationId, capability);
			if (!gate.ok) {
				if (gate.kind === "role") {
					// Role-shortfall in a live IM turn → register a pending one-shot
					// admin authorization and tell the requester the path. Only this
					// refusal kind arms the flow: misconfigurations must be fixed, and
					// confirmation-gated tools keep their own gate.
					const label = CAPABILITY_LABEL[capability] ?? capability;
					options.onRoleRefusal?.(options.conversationId, { capability, need: label });
					const base = permissionRefusal(gate, capability);
					return {
						...base,
						content: [{
							type: "text",
							text:
								`${base.content[0].text}\n\n（可选路径）如果对接方坚持要执行这个操作，可以回复对方：` +
								`「该操作需要${label}权限。请管理员在本会话回复：确认授权 ——管理员回复后本次请求会自动执行（单次有效，10 分钟内）。」` +
								`不要反复重试同一个被拒操作，也不要在管理员未回复时自行降级执行。`,
						}],
					};
				}
				return permissionRefusal(gate, capability);
			}
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	});
	const guardAll = (capability: string, list: AgentTool<any>[]): AgentTool<any>[] => list.map((t) => guarded(capability, t));

	if (options.kbEnabled) {
		tools.push(guarded("knowledge", createKnowledgeTool(options.knowledge)));
		if (options.learnEnabled) {
			tools.push(...guardAll("learn", [createSaveToKnowledgeTool(options.knowledge), createRememberTool(options.knowledge, options.onMemoryChanged)]));
		}
		if (options.manageEnabled) tools.push(guarded("knowledge_manage", createManageKnowledgeTool(options.knowledge)));
		if (options.researchEnabled) tools.push(guarded("browser", createResearchWebTool(options.knowledge)));
	}
	if (options.browserEnabled)
		tools.push(
			...guardAll("browser", createBrowserTools(options.browser, options.isVisionModel, options.screenshotDir, () => options.conversationId)),
		);
	if (options.browserEnabled && options.downloadsEnabled)
		tools.push(...guardAll("browser", createDownloadTools(options.downloadService, options.browser, () => options.conversationId)));
	if (options.documentsEnabled)
		tools.push(...guardAll("documents", createDocumentTools(options.documents, options.conversationId, options.resolveFileSender)));
	if (options.filesystemEnabled) tools.push(...guardAll("filesystem", createFilesystemTools(options.filesystem)));
	if (options.schedulerEnabled) {
		const origin = inferConversationOrigin(options.conversationId);
		tools.push(
			...guardAll("scheduler", createSchedulerTools(
				options.scheduler,
				options.conversationId,
				origin,
				options.config,
				options.resolveActor,
			)),
		);
	}
	if (options.reportsEnabled) tools.push(guarded("reports", createSaveReportTool(options.reportService, options.conversationId)));
	// Skill authoring is an always-on channel: explicit 技能/Skill intent writes
	// here; everything else defaults to the knowledge base (see prompt routing rules).
	tools.push(guarded("learn", createSaveToSkillTool(options.skillWriter, options.onSkillsChanged)));
	// Read-only access to a skill's bundled assets (scripts/templates that shipped
	// alongside SKILL.md in a zip or directory import). Always-on with skills.
	tools.push(createReadSkillAssetTool(options.userSkillsDir));
	// Conversation-side skill reload — the "刷新" button's IM equivalent, so a
	// remote employee can pick up imported/edited skills without the admin UI.
	tools.push(createRefreshSkillsTool(options.listSkills, options.onSkillsChanged));
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
	const accessDeps: AccessToolDeps = {
		config: options.config,
		resolveActor: options.resolveActor,
		onConfigChanged: options.onConfigChanged,
		conversationId: options.conversationId,
		listConversations: options.listConversations,
		listMembers: options.listMembers,
	};
	tools.push(createManageAdminTool(adminDeps), createUpdateIdentityTool(adminDeps));
	// RBAC: one read-only self-query for any sender (check_my_access) plus the
	// admin-only policy editor (manage_access: per-person roles, default role,
	// per-conversation capability floors).
	tools.push(
		createCheckMyAccessTool(accessDeps),
		createManageAccessTool(accessDeps),
	);
	if (options.computer) tools.push(...guardAll("computer", createComputerTools({ ...adminDeps, computer: options.computer,
		isVisionModel: options.isVisionModel, screenshotDir: options.screenshotDir })));
	// Conversation-side capability switches — headless deployments have no desktop
	// settings UI, so admins toggle browser/documents/… from a 1:1 chat.
	tools.push(createManageCapabilitiesTool({
		config: options.config,
		resolveActor: options.resolveActor,
		onConfigChanged: options.onConfigChanged,
		conversationId: options.conversationId,
		playwrightCliPath: options.playwrightCliPath,
	}));
	// Restricted shell execution for headless-server ops (process inspect/kill,
	// system/network checks). Registered always; the tool itself gates on
	// capabilities.shell.enabled + allowedCommands + admin confirmation.
	const shellDeps: ShellToolDeps = {
		config: options.config,
		resolveActor: options.resolveActor,
		onConfigChanged: options.onConfigChanged,
		conversationId: options.conversationId,
		auditLogPath: options.shellAuditLogPath,
	};
	tools.push(createRunCommandTool(shellDeps), createManageProcessTool(shellDeps));
	// Full-config read/write for headless deployments — every block the desktop
	// settings UI exposes, editable from an admin's 1:1 chat (security excluded).
	tools.push(createManageSettingsTool({
		config: options.config,
		resolveActor: options.resolveActor,
		onConfigChanged: options.onConfigChanged,
		conversationId: options.conversationId,
	}));
	if (options.updates) {
		tools.push(createManageUpdateTool({
			config: options.config,
			resolveActor: options.resolveActor,
			onConfigChanged: options.onConfigChanged,
			conversationId: options.conversationId,
			updates: options.updates,
		}));
	}
	tools.push(orderTool, escalateTool);
	if (options.telemetry) tools.push(guarded("telemetry", createMyStatsTool({ ...accessDeps, telemetry: options.telemetry })));
	// The proposal loop's output channel. Same capability as my_stats: a proposal
	// is a review artifact, not an action — it changes nothing on its own.
	if (options.proposals && options.telemetry) {
		tools.push(
			guarded("telemetry", createProposeImprovementTool({
				proposals: options.proposals,
				telemetry: options.telemetry,
				proposalsDir: options.proposalsDir ?? "(未配置)",
			})),
		);
	}
	// Instrument LAST so the wrapper sits outside every other wrapper (including
	// the RBAC guard): a refusal is recorded as a refusal, not as a silent pass.
	return options.onToolEvent ? tools.map((tool) => withTelemetry(tool, options.onToolEvent!)) : tools;
}

/**
 * Record one call per tool invocation. Behaviour-preserving by construction: the
 * original result (or exception) is passed through untouched and a telemetry
 * failure is swallowed, so instrumentation can never break a tool.
 * A refusal counts as NOT ok — it is friction the agent should be able to see.
 */
function withTelemetry(
	tool: AgentTool<any>,
	onEvent: (event: { name: string; durationMs: number; ok: boolean; refused?: boolean; refusedCapability?: string; error?: string }) => void,
): AgentTool<any> {
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate) {
			const started = Date.now();
			try {
				const result = await tool.execute(toolCallId, params, signal, onUpdate);
				const details = (result as { details?: { refused?: boolean; capability?: string } } | undefined)?.details;
				const refused = Boolean(details?.refused);
				onEvent({ name: tool.name, durationMs: Date.now() - started, ok: !refused, refused, refusedCapability: details?.capability });
				return result;
			} catch (err) {
				onEvent({
					name: tool.name,
					durationMs: Date.now() - started,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}
		},
	};
}
