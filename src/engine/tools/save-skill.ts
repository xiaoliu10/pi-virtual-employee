import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { SkillWriter } from "../skills/skill-writer.js";

/**
 * Build the skill-authoring tool. Lets the employee create or update a
 * declarative SKILL.md package under the user skills directory. The split
 * between this and `save_to_knowledge` is intentional and enforced by the
 * system prompt: skills are only for explicit "做成技能/Skill" intent; all
 * other 知识/经验/聊天整理 defaults to the knowledge base.
 */
export function createSaveToSkillTool(
	skillWriter: SkillWriter,
	onSkillsChanged: () => Promise<void>,
): AgentTool {
	return {
		name: "save_to_skill",
		label: "沉淀技能",
		description:
			"仅在对话方明确要求「做成技能 / 创建 Skill / 整理成技能 / 更新或修改某个技能」时使用：把一套「何时触发 + 标准执行步骤 + 完成标准 + 注意事项」写成一个新的 SKILL.md 技能。" +
			"凡是没有明确提到技能/Skill 的整理请求——例如「整理聊天、整理知识、沉淀经验、总结一下、记下来、以后参考」——一律改用 save_to_knowledge 写入知识库，不要写技能。" +
			"不要因为内容看起来像流程就自行改存为技能；同一条内容默认只写一个渠道，除非对方明确要求「同时保存到知识库和做成技能」才可两边都写。",
		parameters: Type.Object({
			name: Type.String({
				description: "技能名称，中文或小写英文/数字/连字符，如 退款处理、handle-refund",
			}),
			description: Type.String({
				description: "一句话说明该技能何时被触发（≤1024 字），作为技能的触发依据",
			}),
			content: Type.String({
				description: "技能正文（Markdown）：适用场景、标准步骤、完成标准、注意事项，需完整可独立理解",
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("create"), Type.Literal("replace")], {
					description: "create=新建（默认；同名已存在时不会覆盖，会返回提示让你向对方确认）。replace=更新/覆盖已存在的同名技能，仅当对方明确要求「更新/修改/覆盖」时使用。",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const { name, description, content, mode } = params as {
				name: string;
				description: string;
				content: string;
				mode?: "create" | "replace";
			};
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
