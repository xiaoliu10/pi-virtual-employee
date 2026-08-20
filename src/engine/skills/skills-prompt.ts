/**
 * Format enabled skills into a system-prompt block with their full instructions
 * inlined. Unlike the pi-agent-core loader's format (which points the model at a
 * file path to read), this embeds the content directly so an agent without
 * filesystem tools can still follow the skill.
 */
import type { Skill } from "@earendil-works/pi-agent-core";

export function formatInlineSkills(skills: Skill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";

	const lines = [
		"以下是已可用的技能。当任务匹配某技能描述时，严格遵循该技能的步骤执行；这是「执行」现有技能，不是「整理/创建」技能。",
		"当对方要求「整理成技能 / 创建 Skill / 更新技能」时，应调用 save_to_skill 写技能，不要把管理请求误当成执行某个现有技能。",
		"当对方说「刷新技能 / 重新加载技能」或问「新导入的技能怎么没生效」时，调用 refresh_skills 重新加载技能列表；刷新后新技能从下一条消息起生效。",
		"**技能冲突时先上报、不擅自取舍**：当多个技能对同一任务给出矛盾指令（步骤不同、列索引/选择器不一致、适用范围重叠但结论冲突），不要默默选一个执行，更不要把两个各执行一半；应停下来向管理者说明冲突点（各自技能名与矛盾之处），请其决定采用哪一个、或更新/删除其中一个。在等待裁决期间如必须继续，可先按描述更具体、与当前页面实测更吻合的技能执行，但回复中必须明确报告存在冲突及你的取舍依据。",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push(`  <skill name="${escapeXml(skill.name)}">`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <instructions>`);
		lines.push(indent(skill.content.trim(), 6));
		lines.push(`    </instructions>`);
		lines.push(`  </skill>`);
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function indent(text: string, spaces: number): string {
	const pad = " ".repeat(spaces);
	return text
		.split("\n")
		.map((line) => (line.length ? pad + line : line))
		.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
