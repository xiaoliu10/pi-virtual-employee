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
		"以下是可用技能。当任务匹配某技能描述时，严格遵循该技能的步骤执行。",
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
