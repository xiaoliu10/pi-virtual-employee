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
import type { WorkItemStore } from "../db/work-item-store.js";
import { createWorkTools } from "./tools/work.js";
import { stopBackgroundProcesses } from "./tools/shell.js";
import { join } from "node:path";
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
import { createWorkerTaskDetailTool } from "./tools/worker-task.js";
import { createSessionDetailTool } from "./tools/session-detail.js";
import { createSaveToKnowledgeTool, createRememberTool } from "./tools/save-knowledge.js";
import { createManageKnowledgeTool } from "./tools/manage-knowledge.js";
import { createSaveToSkillTool } from "./tools/save-skill.js";
import { createRefreshSkillsTool } from "./tools/refresh-skills.js";
import { createManageSkillsTool } from "./tools/skills-market.js";
import { createCurrentTimeTool } from "./tools/time.js";
import { createReadSkillAssetTool } from "./tools/read-skill-asset.js";
import { createResearchWebTool } from "./tools/research-web.js";
import { createBrowserTools } from "./tools/browser.js";
import { createSchedulerTools } from "./tools/scheduler.js";
import { createDocumentTools } from "./tools/documents.js";
import { createFilesystemTools } from "./tools/filesystem.js";
import { createDownloadTools } from "./tools/downloads.js";
import { createSaveReportTool } from "./tools/reports.js";
import { createSendImageTool, type ImageSenderResolver } from "./tools/send-image.js";
import { createViewImageTool } from "./tools/view-image.js";
import { createManageAdminTool, createUpdateIdentityTool, type AdminToolDeps } from "./tools/admin.js";
import { createManageUpdateTool, type UpdateOperations } from "./tools/update.js";
import { createManageCapabilitiesTool } from "./tools/capabilities.js";
import { createRunCommandTool, createManageProcessTool, executeCommand, type ShellToolDeps } from "./tools/shell.js";
import { createRunScriptTool } from "./tools/run-script.js";
import { computeToolFingerprint, normalizeForFingerprint } from "./progress-watchdog.js";
import { createManageSettingsTool } from "./tools/settings.js";
import { orderTool } from "./tools/orders.js";
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
	/** Resolve the live turn's verified person/conversation memory scope. */
	resolveMemoryContext?: (conversationId: string) => { personOwner?: string; conversationOwner?: string };
	/** worker_task_detail read side (context-management P2): the Chain-of-Recall
	 * second hop behind the prefix's worker:<id> one-liners. Telemetry-flavored:
	 * registered under the "telemetry" capability (operator floor). */
	workerTaskDetail?: (id: string) => import("./tools/worker-task.js").WorkerTaskDetailRow | undefined;
	/** session_detail (field 2026-11-08): look a conversation UP by id — recent
	 * messages, its worker tasks, its work items. The query side of session
	 * visibility (the model's own id rides the system prompt). Telemetry. */
	sessionDetail?: import("./tools/session-detail.js").SessionDetailDeps;
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
	/** The conversation this turn logically BELONGS to when it differs from the
	 * transcript's own id. A worker session (`worker:<id>`) acts on behalf of a
	 * source chat: task scoping, origin filtering and delivery all mean the
	 * SOURCE conversation, not the worker's scratch id. Absent = conversationId
	 * (inline turns). Field 2026-11-07: inside a worker, manage_work_items list
	 * answered「当前来源会话还没有自主任务」while the source chat owned one. */
	originConversationId?: string;
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
	/** Profile user-data dir; `run_script` writes parameter files under it. */
	userDataDir?: string;
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
	 *
	 * `argsBrief`/`resultBrief` (WorkSession P1 wiring): bounded, secret-masked
	 * one-liners collected HERE — the wrapper already holds params and result in
	 * hand, so no tool is pierced for collection. Optional: an event without
	 * them still yields a valid degraded digest (name + cost + outcome).
	 */
	onToolEvent?: (event: { name: string; durationMs: number; ok: boolean; refused?: boolean; refusedCapability?: string; error?: string; fingerprint?: string; argsBrief?: string; resultBrief?: string }) => void;
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
	/** MCP external tools: enabled flag from capabilities.mcp, tools from the
	 * connector manager's cache (empty until its first refresh lands). */
	mcp?: { enabled: boolean; tools: AgentTool<any>[] };
	/** Work items (autonomous work phase 2): mined/confirmed goals worked by the
	 * employee across self-scheduled windows. Absent → manage_work* are off. */
	work?: {
		items: WorkItemStore;
		/** Fire a work window now (confirm kickoff / resume). Provided by main. */
		fireItem: (id: string) => boolean;
		/** On-demand mining over recent conversation deltas (admin-triggered). */
		mine: (opts: { maxProposals?: number }) => Promise<{
			proposals: { title: string; goal: string; evidence: string; conditions: string; originConversation: string | null; id: string }[];
			scanned: number;
			error?: string;
		}>;
	};
}

/** Assemble the employee's tools; capability tools are conditional on their config flags. */
/**
 * Wrap a tool with the RBAC capability gate. Exported so callers that do NOT go
 * through buildTools (the durable kernel installs MCP as its own registry
 * extension, bypassing this function) apply the SAME check instead of a copy.
 */
export function guardTool(capability: string, tool: AgentTool<any>, options: ToolSetOptions): AgentTool<any> {
	return {
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
	};
}

export function buildTools(input: ToolSetOptions): AgentTool<any>[] {
	// EVERY tool below treats `conversationId` as "the conversation this turn is
	// about". For a worker/scheduler round that is the ORIGIN chat, not the
	// scratch transcript id — so it is resolved ONCE here and the rest of this
	// function keeps its single, unchanged meaning.
	const options: ToolSetOptions = input.originConversationId
		? {
				...input,
				conversationId: input.originConversationId,
				// Actor lookup must fall back to the SCRATCH id: the engine stamps
				// turnActor under the transcript the round runs on (worker:…), not
				// under the origin chat. Without this, every admin check inside a
				// worker would see "no verified actor" and silently downgrade an
				// owner to a non-admin (field 2026-11-07).
				// The fallback must return an actor that AGREES with the rewritten
				// conversationId, or every IM-shaped check downstream (verifiedIMActor
				// wants chatType single|group + a matching dt: prefix) fails on a
				// mismatch that does not exist: conversationId is the ORIGIN chat
				// (dt:group:…), while the only live turn actor is stamped on the
				// worker transcript (worker:…), so its chatType is the worker's.
				//
				// Field 2026-11-07: an OWNER asked inside a worker to change their own
				// task's prompt and was told 「只能到任务来源的群聊里操作」 — the owner
				// exemption in work.ts never got a chance to run because the actor
				// never verified. Reported as 「我是最高权限，我应该可以修改任何配置和
				// 任务」. Identity (senderId) is what authorization needs; the channel
				// labels describe the chat we are ACTING FOR, so they come from the
				// origin chat.
				resolveActor: (cid) => {
					const direct = input.resolveActor(cid);
					if (direct) return direct;
					if (cid !== input.originConversationId) return undefined;
					const scratch = input.resolveActor(input.conversationId);
					if (!scratch) return undefined;
					const origin = input.originConversationId;
					const channel = origin.startsWith("dt:") ? "dingtalk" : scratch.channel;
					const chatType = origin.startsWith("dt:group:") ? "group" : origin.startsWith("dt:") ? "single" : scratch.chatType;
					return { ...scratch, channel, chatType, conversationId: origin };
				},
			}
		: input;
	const tools: AgentTool<any>[] = [];
	/**
	 * Capability guard (RBAC): wraps a tool's execute with a server-side
	 * permission check against the CURRENT turn's platform-verified actor —
	 * the model never mediates who may call what, so prompt injection in
	 * message/web/file content cannot escalate access. The check is per-turn
	 * (resolveActor reads the live turn actor), so one group conversation
	 * serves different senders at their own roles.
	 */
	const guarded = (capability: string, tool: AgentTool<any>): AgentTool<any> => guardTool(capability, tool, options);
	const guardAll = (capability: string, list: AgentTool<any>[]): AgentTool<any>[] => list.map((t) => guarded(capability, t));

	if (options.kbEnabled) {
		tools.push(guarded("knowledge", createKnowledgeTool(options.knowledge, () => options.resolveMemoryContext?.(options.conversationId) ?? {})));
		if (options.learnEnabled) {
			tools.push(...guardAll("learn", [createSaveToKnowledgeTool(options.knowledge), createRememberTool({
				knowledge: options.knowledge,
				resolveActor: () => options.resolveActor(options.conversationId),
				conversationId: options.conversationId,
				config: options.config,
				onSaved: options.onMemoryChanged,
			})]));
		}
		if (options.manageEnabled) tools.push(guarded("knowledge_manage", createManageKnowledgeTool(options.knowledge)));
		// "knowledge" floor, not "browser": web research is part of the KB loop and must not require browser permission.
		if (options.researchEnabled) tools.push(guarded("knowledge", createResearchWebTool(options.knowledge)));
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
	if (options.workerTaskDetail) {
		tools.push(guarded("telemetry", createWorkerTaskDetailTool(options.workerTaskDetail)));
	}
	if (options.sessionDetail) {
		tools.push(guarded("telemetry", createSessionDetailTool(options.sessionDetail)));
	}
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
	// MCP external tools — guarded under the "mcp" capability like every other
	// capability tool; the tool list comes from the connector manager's cache.
	if (options.mcp?.enabled && options.mcp.tools.length > 0) {
		tools.push(...guardAll("mcp", options.mcp.tools));
	}
	// Work items: internal notebook + admin-gated management (the tools carry
	// their own admin checks, same pattern as authorize_scheduled_task).
	if (options.work) {
		tools.push(...createWorkTools({
			workItems: options.work.items,
			fireItem: options.work.fireItem,
			mine: options.work.mine,
			config: options.config,
			resolveActor: options.resolveActor,
			conversationId: options.conversationId,
			// Cancel must reclaim a finished window's still-running background work
			// (review P2-2 2026-11-06): the turn can be over while its script runs.
			reclaimBackground: (id) => {
				const killed = stopBackgroundProcesses(options.config, `work:${id}`);
				if (killed.length > 0) console.log(`[work] cancel reclaim: ${killed.length} background process(es) killed for work:${id}`);
			},
		}));
	}
	// Skill authoring is an always-on channel: explicit 技能/Skill intent writes
	// here, as does the pi-auto-research loop's verified-procedure fixation;
	// everything else defaults to the knowledge base (see prompt routing rules).
	tools.push(guarded("learn", createSaveToSkillTool(options.skillWriter, options.onSkillsChanged)));
	// Read-only access to a skill's bundled assets (scripts/templates that shipped
	// alongside SKILL.md in a zip or directory import). Always-on with skills.
	tools.push(createReadSkillAssetTool(options.userSkillsDir));
	// Conversation-side skill reload — the "刷新" button's IM equivalent, so a
	// remote employee can pick up imported/edited skills without the admin UI.
	tools.push(createRefreshSkillsTool(options.listSkills, options.onSkillsChanged));
	// Skill market: admin-gated install/remove of SKILL.md packages (market list or
	// direct https URL). Confirmation mirrors adminFullAccess via requireConfirmedAdmin.
	tools.push(createManageSkillsTool({
		config: options.config,
		resolveActor: options.resolveActor,
		onConfigChanged: options.onConfigChanged,
		conversationId: options.conversationId,
		skillWriter: options.skillWriter,
		userSkillsDir: options.userSkillsDir,
		listSkills: options.listSkills,
		onSkillsChanged: options.onSkillsChanged,
	}));
	// Always-on real clock: date-sensitive tasks must read the true date, never
	// guess it (field 2026-09-18: a daily report was titled one day off).
	tools.push(createCurrentTimeTool());
	// Inline image delivery — degrades to a text notice when the channel can't send
	// images, so it's safe to always register.
	tools.push(createSendImageTool(options.resolveImageSender, options.conversationId));
	// Let the model actually SEE local screenshots (shell/adb captures land on
	// disk only; without this the model can never analyze its own screenshots).
	tools.push(createViewImageTool(options.isVisionModel, options.shellAuditLogPath, options.conversationId));
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
		// Process-hygiene contract ledger lives in the profile dir (same root the
		// engine already hands to run_script for its parameter files).
		processContractsPath: options.userDataDir ? join(options.userDataDir, "process-contracts.json") : undefined,
	};
	tools.push(createRunCommandTool(shellDeps), createManageProcessTool(shellDeps));
	// `run_script`: the same executor, but arguments travel in a JSON file so the
	// command line carries no user data. This is the fix for Windows argv
	// re-tokenization / quoting / GBK mangling — see tools/run-script.ts.
	if (options.userDataDir) {
		tools.push(createRunScriptTool({
			...shellDeps,
			userDataDir: options.userDataDir,
			runCommand: async (input) => {
				const result = await executeCommand(shellDeps, input, input.signal);
				const text = result.content.map((c) => c.text).join("\n");
				return { text, isError: result.details?.refused === true };
			},
		}));
	}
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
	tools.push(orderTool);
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
	// prompt_lab — the RSI step-4 evaluation loop. Every dep is plumbed from
	// engine.ts (promptLab / runEvalTurn / buildPromptWithRules); the tool
	// carries its own gates (single-chat actor + 管理员 + 确认口令 for apply),
	// same convention as the admin tools — no extra RBAC capability needed.
	// Zombie-scan 2026-10-17: the import existed since 0.2.66 but the
	// registration call never did, so the model never had this tool.
	if (options.promptLab && options.runEvalTurn && options.buildPromptWithRules) {
		tools.push(createPromptLabTool({
			config: options.config,
			lab: options.promptLab,
			resolveActor: options.resolveActor,
			conversationId: options.conversationId,
			onConfigChanged: options.onConfigChanged,
			runTurn: options.runEvalTurn,
			buildPrompt: options.buildPromptWithRules,
		}));
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
/** Byte-identical result threshold for the dedupe stub: smaller payloads are
 * not worth a reference line, and errors are never stubbed. */
const DUP_RESULT_STUB_MIN_CHARS = 512;
const DUP_STUB_ARGS_PREVIEW = 120;
/** Cap on remembered first-call ids (one per distinct fingerprint pattern). */
const DUP_STUB_MAX_ENTRIES = 128;

/** fingerprint+preview+toolCallId of the FIRST call of a repeat run, per tool
 * call signature. Kept process-wide: a loop is a loop regardless of which
 * conversation object observed it. */
const firstCallOfRepeat = new Map<string, { toolCallId: string; preview: string }>();

/**
 * Replace a byte-identical duplicate tool result with a short reference.
 *
 * Hermes' tool_guardrails does this for the same reason: a poller returning an
 * unchanged 4KB payload ten times costs 40KB of context for one bit of
 * information. The stub names the tool, the args preview and the earlier
 * tool_call_id so the model can still reason about it ("same as before").
 */
export function stubDuplicateResult<T>(
	toolName: string,
	toolCallId: string,
	params: unknown,
	result: T,
	refused: boolean,
): T {
	try {
		if (refused || typeof result !== "object" || result === null) return result;
		const envelope = result as { content?: Array<{ type?: string; text?: string }> };
		const blocks = envelope.content;
		if (!Array.isArray(blocks) || blocks.length !== 1) return result;
		const block = blocks[0];
		if (!block || block.type !== "text" || typeof block.text !== "string") return result;
		const text = block.text;
		if (text.length < DUP_RESULT_STUB_MIN_CHARS) return result;

		// FULL-text signature: a truncated prefix would treat two long payloads that
		// differ only at the end as identical (a poll that MOVED would be stubbed).
		const signature = `${toolName}\u0000${text.length}\u0000${text.slice(0, 200)}\u0000${text.slice(-200)}`;
		const prior = firstCallOfRepeat.get(signature);
		if (!prior) {
			// First occurrence of this exact payload: remember it (bounded) and
			// deliver the real content.
			if (firstCallOfRepeat.size >= DUP_STUB_MAX_ENTRIES) {
				const oldest = firstCallOfRepeat.keys().next().value;
				if (oldest !== undefined) firstCallOfRepeat.delete(oldest);
			}
			firstCallOfRepeat.set(signature, {
				toolCallId: toolCallId || "",
				preview: normalizeForFingerprint(params).slice(0, DUP_STUB_ARGS_PREVIEW),
			});
			return result;
		}
		const ref = prior.toolCallId ? `（tool_call_id ${prior.toolCallId}）` : "";
		return {
			...envelope,
			content: [{
				type: "text",
				text: `[本次 ${toolName} 的结果与本次任务中先前那次逐字节相同${ref}，内容没有变化；请直接引用先前那次结果。参数：${prior.preview}]`,
			}],
		} as unknown as T;
	} catch {
		return result; // dedupe must never break a tool call
	}
}

export interface TelemetryOptions {
	/** Skip digest brief collection entirely (deep-copy + stringify of the
	 * whole params/result) — briefs are only consumed by work+contextStore
	 * sessions; other conversations pay the cost for nothing (review P3-1). */
	noBriefs?: boolean;
}

export function withTelemetry(
	tool: AgentTool<any>,
	onEvent: (event: { name: string; durationMs: number; ok: boolean; refused?: boolean; refusedCapability?: string; error?: string; fingerprint?: string; argsBrief?: string; resultBrief?: string }) => void,
	options?: TelemetryOptions,
): AgentTool<any> {
	const collectBriefs = !options?.noBriefs;
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate) {
			const started = Date.now();
			// WorkSession digest briefs: collected ONCE here (bounded + masked below)
			// and carried on both the success and the failure event.
			const argsBrief = collectBriefs ? briefToolArgs(params) : undefined;
			try {
				const result = await tool.execute(toolCallId, params, signal, onUpdate);
				const details = (result as { details?: { refused?: boolean; capability?: string } } | undefined)?.details;
				const refused = Boolean(details?.refused);
				// Progress fingerprint: the progress watchdog judges repetition by
				// tool + normalized params + result digest. Computed here — the
				// OUTERMOST wrapper — so both kernels and every capability feed it.
				const fingerprint = computeToolFingerprint(tool.name, params, result);
				onEvent({ name: tool.name, durationMs: Date.now() - started, ok: !refused, refused, refusedCapability: details?.capability, fingerprint, argsBrief, resultBrief: collectBriefs ? briefToolResultSafe(result) : undefined });
				// Duplicate-result stub (Hermes tool_guardrails, ported 2026-11-06):
				// a polling loop that reads the SAME unchanged payload every round
				// otherwise pushes the whole thing into the context each time. From
				// the 2nd byte-identical repeat the payload is replaced by a
				// reference — the tool still ran, only the context representation is
				// deduplicated, so polling semantics survive.
				return stubDuplicateResult(tool.name, toolCallId, params, result, refused);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				onEvent({
					name: tool.name,
					durationMs: Date.now() - started,
					ok: false,
					error,
					argsBrief,
					resultBrief: collectBriefs ? briefText(maskResultText(error)) : undefined,
					// A throwing tool still carries a fingerprint: the same tool with
					// the same params throwing the same error every round IS a loop.
					fingerprint: computeToolFingerprint(tool.name, params, error),
				});
				throw err;
			}
		},
	};
}

// ── WorkSession digest brief collection (bounded truncation + secret masking).
// These live next to withTelemetry because the wrapper is the ONE place that
// sees params and result together; tests pin them THROUGH withTelemetry.

/** The digest rides every later window and the recovery brief — its two
 * free-text fields must stay one-liners, never full payloads. */
const DIGEST_BRIEF_MAX_CHARS = 240;

/** Leaf values under these keys never enter the (permanent, replayed) ledger:
 * tool args can carry credentials, and truncation alone would still leak the
 * secret itself when it sits inside the first 240 chars. */
const DIGEST_SECRET_KEY_RE = /pass|pwd|secret|token|api_?key|authorization|cookie|credential|otp|验证码|密码|密钥|private[_-]?key|access[_-]?key|session|(^|[^a-z])key($|[^a-z])/i;

/** VALUE shapes (review 9b41e5ba P2-1): secrets also arrive as free text —
 * "Authorization: Bearer …" bodies, URL query tokens, PEM blocks — where no
 * key name ever identifies them. Mask the value forms wherever they appear.
 * PEM blocks are dropped whole (no useful prefix); key=value / Bearer forms
 * keep their key so the digest still says WHAT was masked. */
const DIGEST_PEM_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const DIGEST_SECRET_VALUE_RE = /(api[_-]?key|access[_-]?key|token|password|passwd|pwd|secret|session[_-]?id|credential|[Bb]earer)[=:：]?\s*\S+/g;

function briefText(raw: string): string {
	const text = raw.replace(/\s+/g, " ").trim();
	return text.length > DIGEST_BRIEF_MAX_CHARS ? `${text.slice(0, DIGEST_BRIEF_MAX_CHARS)}…（截断）` : text;
}

function maskValueShapes(text: string): string {
	return text
		.replace(DIGEST_PEM_BLOCK_RE, "***")
		.replace(DIGEST_SECRET_VALUE_RE, "$1 ***");
}

function maskSecrets(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) return value.map((item) => maskSecrets(item));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskSecrets(v, k);
		return out;
	}
	if (typeof value !== "string") return value;
	if (key && DIGEST_SECRET_KEY_RE.test(key)) return "***";
	// Free-text values still carry Bearer headers / URL tokens / PEM blocks.
	return maskValueShapes(value);
}

function briefToolArgs(params: unknown): string {
	try {
		const masked = maskSecrets(params);
		return briefText(typeof masked === "string" ? masked : JSON.stringify(masked) ?? "");
	} catch {
		return "<unserializable args>";
	}
}

/** Tool results and error messages reach the SAME permanent ledger as args —
 * review 9b41e5ba P2-2: the masking contract is empty unless it covers them.
 * Key masking is moot here (plain text, no keys) but value shapes are not. */
function maskResultText(text: string): string {
	return maskValueShapes(text);
}

/** Tool results are `{ content: [{ type: "text", text }] }` envelopes; flatten
 * the text blocks. Non-text blocks (images, …) degrade to a marker — the digest
 * stays honest about what the tool produced without inlining it. Never throws:
 * a brief-collection bug must not flip a successful call into a failure. */
function briefToolResultSafe(result: unknown): string {
	try {
		return briefToolResult(result);
	} catch (err) {
		console.warn("[engine] briefToolResult failed:", err instanceof Error ? err.message : err);
		return "（结果摘要采集失败）";
	}
}

function briefToolResult(result: unknown): string {
	const blocks = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
	if (!Array.isArray(blocks)) return "（无文本结果）";
	const texts: string[] = [];
	let nonText = 0;
	for (const block of blocks) {
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) texts.push(block.text);
		else if (block?.type && block.type !== "text") nonText += 1;
	}
	const text = texts.join("\n");
	if (!text.trim()) return nonText > 0 ? `（无文本结果，含 ${nonText} 个非文本块）` : "（无文本结果）";
	return briefText(maskResultText(text));
}
