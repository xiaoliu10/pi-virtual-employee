/**
 * Format enabled skills into a system-prompt block with their full instructions
 * inlined. Unlike the pi-agent-core loader's format (which points the model at a
 * file path to read), this embeds the content directly so an agent without
 * filesystem tools can still follow the skill.
 */
import type { Skill } from "./types.js";

export function formatInlineSkills(skills: Skill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";

	const AUTO_RESEARCH_HINT = "遇到知识库和已有技能都没有现成方案的问题，按 pi-auto-research 技能的闭环处理：联网查阅 → 在本环境验证 → 沉淀知识库，可复用的操作流程固化为技能。";
	const lines = [
		"以下是已可用的技能。当任务匹配某技能描述时，严格遵循该技能的步骤执行；这是「执行」现有技能，不是「整理/创建」技能。",
		// Field 2026-11-08 (Nova, 「查支付渠道下单日志」): a skill for exactly that
		// task was inlined below, and the model answered with a generic refusal —
		// 「我运行在临时的本地会话环境中，没有连接到你公司的支付系统…请把日志贴给我」
		// — without ever opening the skill. A matching skill IS the capability:
		// declaring yourself unable while an unused execution path sits in the
		// prompt is the same class of defect as inventing a refusal reason.
		"**匹配到技能就必须按它去做，不要先声明做不到**：技能存在即说明这个环境具备完成它的路径（凭据、入口、步骤都写在技能里）。先用技能里的步骤实际跑一轮——打开它说的系统、执行它给的命令、调它指定的工具；只有真的跑过且失败，才说明卡在哪一步、缺什么。**严禁在未执行技能前就回答「我无法查询/我没有连接/我运行在临时环境」这类能力自述**——那是把「没试」伪装成「做不到」。",
		"当对方要求「整理成技能 / 创建 Skill / 更新技能」时，应调用 save_to_skill 写技能，不要把管理请求误当成执行某个现有技能。",
		"当对方说「刷新技能 / 重新加载技能」或问「新导入的技能怎么没生效」时，调用 refresh_skills 重新加载技能列表；刷新后新技能从下一条消息起生效。",
		"**技能冲突时先上报、不擅自取舍**：当多个技能对同一任务给出矛盾指令（步骤不同、列索引/选择器不一致、适用范围重叠但结论冲突），不要默默选一个执行，更不要把两个各执行一半；应停下来向管理者说明冲突点（各自技能名与矛盾之处），请其决定采用哪一个、或更新/删除其中一个。在等待裁决期间如必须继续，可先按描述更具体、与当前页面实测更吻合的技能执行，但回复中必须明确报告存在冲突及你的取舍依据。",
		"",
		"<available_skills>",
	];
	// Only reference the auto-research skill when it is ACTUALLY visible: an
	// admin who disabled it must stop the research behaviour, not just hide its
	// body while the preamble keeps ordering it (review M2).
	if (visible.some((skill) => skill.name === "pi-auto-research")) {
		lines.splice(3, 0, AUTO_RESEARCH_HINT);
	}
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
