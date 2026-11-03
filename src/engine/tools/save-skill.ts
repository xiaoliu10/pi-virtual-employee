import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { SkillWriter } from "../skills/skill-writer.js";

/**
 * Build the skill-authoring tool. Lets the employee create or update a
 * declarative SKILL.md package under the user skills directory. The split
 * between this and `save_to_knowledge` is intentional and enforced by the
 * system prompt: skills are for explicit "做成技能/Skill" intent, OR for the
 * pi-auto-research loop's verified-reusable-procedure fixation; all other
 * 知识/经验/聊天整理 defaults to the knowledge base.
 */
export function createSaveToSkillTool(
	skillWriter: SkillWriter,
	onSkillsChanged: () => Promise<void>,
): AgentTool {
	return {
		name: "save_to_skill",
		label: "沉淀技能",
		description:
			"把一套「何时触发 + 标准执行步骤 + 完成标准 + 注意事项」写成一个新的 SKILL.md 技能。两种触发：① 对话方明确要求「做成技能 / 创建 Skill / 整理成技能 / 更新或修改某个技能」；② 按 pi-auto-research 技能完成自主研究、方案已在本环境验证通过且属于可复用的操作流程——此时可直接固化为技能并在回复中说明（管理员可随时调整或删除）。" +
			"凡是没有明确提到技能/Skill 的整理请求——例如「整理聊天、整理知识、沉淀经验、总结一下、记下来、以后参考」——一律改用 save_to_knowledge 写入知识库，不要写技能；未经自主研究验证的流程也不要自行写成技能。" +
			"不要因为内容看起来像流程就自行改存为技能；同一条内容默认只写一个渠道，除非对方明确要求「同时保存到知识库和做成技能」才可两边都写。",
		parameters: Type.Object({
			name: Type.String({
				description: "技能名称，中文或小写英文/数字/连字符，如 退款处理、handle-refund",
			}),
			action: Type.Optional(
				Type.Union(
					[Type.Literal("write"), Type.Literal("read"), Type.Literal("write_file")],
					{
						description:
							"write=新建或更新技能正文（默认）。read=读取某个已有技能的正文（更新前必须先读，避免覆盖掉别人/上次写的内容）。write_file=把脚本/参考资料写进该技能的 scripts/、references/、templates/ 目录（复用技能时的首选沉淀方式：脚本收进技能目录，下次直接跑，不必重写）。",
					},
				),
			),
			description: Type.Optional(
				Type.String({
					description: "一句话说明该技能何时被触发（≤1024 字），作为技能的触发依据",
				}),
			),
			content: Type.Optional(
				Type.String({
					description: "技能正文（Markdown）：适用场景、标准步骤、完成标准、注意事项，需完整可独立理解",
				}),
			),
			file_path: Type.Optional(
				Type.String({
					description: "action=write_file 时必填：技能目录内的相对路径，如 scripts/spay_sum.py、references/pitfalls.md。只允许 scripts/、references/、templates/ 三个前缀。",
				}),
			),
			file_content: Type.Optional(
				Type.String({ description: "action=write_file 时要写入的文件内容（脚本源码或参考资料正文）。" }),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("create"), Type.Literal("replace")], {
					description: "create=新建（默认；同名已存在时不会覆盖，会返回提示让你向对方确认）。replace=更新/覆盖已存在的同名技能，仅当对方明确要求「更新/修改/覆盖」时使用。",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const p = params as {
				name: string;
				action?: "write" | "read" | "write_file";
				description?: string;
				content?: string;
				file_path?: string;
				file_content?: string;
				mode?: "create" | "replace";
			};
			const action = p.action ?? "write";

			// Read-before-write: reviewing an existing skill must start here.
			if (action === "read") {
				const read = await skillWriter.readSkillFile(p.name);
				return {
					content: [{ type: "text", text: read.ok ? read.content ?? "" : read.message }],
					details: { ok: read.ok, name: p.name, action },
				};
			}

			// Support file (script / reference) inside an existing skill.
			if (action === "write_file") {
				if (!p.file_path || !p.file_content) {
					return {
						content: [{ type: "text", text: "action=write_file 需要同时提供 file_path（如 scripts/run.py）与 file_content。" }],
						details: { ok: false, name: p.name, action },
					};
				}
				const written = await skillWriter.writeSupportFile({ skill: p.name, path: p.file_path, content: p.file_content });
				if (written.outcome === "created") await onSkillsChanged();
				return {
					content: [{ type: "text", text: written.message }],
					details: { ok: written.outcome === "created", name: p.name, action, filePath: written.filePath },
				};
			}

			const name = p.name;
			const description = p.description ?? "";
			const content = p.content ?? "";
			const mode = p.mode;
			const result = await skillWriter.upsert({ name, description, content, mode });
			if (result.outcome === "created" || result.outcome === "updated") {
				await onSkillsChanged();
			}
			return {
				content: [{ type: "text", text: result.message }],
				details: { outcome: result.outcome, name: result.name, filePath: result.filePath, mode: mode ?? "create" },
			};
		},
	};
}
