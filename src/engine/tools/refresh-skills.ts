import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

/**
 * Build the refresh_skills tool: lets the employee reload the skill list from
 * disk mid-conversation. Mirrors the admin UI's 刷新 button — useful when a
 * skill was imported/deleted/edited outside this conversation and the employee
 * was asked to pick it up without waiting for a new session. Uses the
 * non-aborting path (markSkillsChanged), so the current turn is never
 * interrupted: other sessions pick the new list up on their next message.
 */
export function createRefreshSkillsTool(
	listSkills: () => Promise<{ skills: { name: string }[]; info: { name: string; enabled: boolean }[] }>,
	onSkillsChanged: () => Promise<void>,
): AgentTool {
	return {
		name: "refresh_skills",
		label: "刷新技能",
		description:
			"重新从磁盘加载技能列表并立即生效。当对方说「刷新技能 / 重新加载技能 / 新技能怎么没生效」或导入、更新、删除技能后需要让新技能立即可用时调用。" +
			"不会打断任何正在进行的任务；刷新后可按需向对方简单确认已加载的技能数。",
		parameters: Type.Object({}),
		async execute() {
			await onSkillsChanged();
			const { skills, info } = await listSkills();
			const names = info.map((i) => `${i.name}${i.enabled ? "" : "（已禁用）"}`);
			const text =
				skills.length === 0
					? "技能列表已刷新，当前没有已加载的技能。"
					: `技能列表已刷新，当前共 ${skills.length} 个技能：${names.join("、")}。新技能从下一条消息起生效。`;
			return {
				content: [{ type: "text", text }],
				details: { count: skills.length },
			};
		},
	};
}
