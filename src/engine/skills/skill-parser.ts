/**
 * Parse a SKILL.md file into a {@link Skill}. Supports YAML frontmatter
 * (`name`, `description`, `disable-model-invocation`) followed by markdown body.
 *
 * Mirrors the on-disk format that pi-agent-core's own loader expects, so a
 * hand-authored or imported skill stays portable.
 */
import type { Skill } from "@earendil-works/pi-agent-core";

export interface ParsedSkill {
	skill: Skill | null;
	warning?: string;
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseSkillFile(filePath: string, raw: string): ParsedSkill {
	const { frontmatter, body } = splitFrontmatter(raw);
	const name = (frontmatter.name ?? deriveNameFromPath(filePath)).trim();
	const description = (frontmatter.description ?? "").trim();
	const content = body.trim();

	if (!name) return { skill: null, warning: "缺少 name" };
	if (name.length > 64) return { skill: null, warning: `name 过长（${name.length} > 64）` };
	if (!NAME_PATTERN.test(name)) {
		return { skill: null, warning: "name 仅允许小写字母、数字、连字符（如 pi-knowledge-base）" };
	}
	if (!description) return { skill: null, warning: "缺少 description" };
	if (description.length > 1024) {
		return { skill: null, warning: `description 过长（${description.length} > 1024）` };
	}

	const skill: Skill = {
		name,
		description,
		content,
		filePath,
	};
	if (frontmatter["disable-model-invocation"] === true) {
		skill.disableModelInvocation = true;
	}
	return { skill };
}

function deriveNameFromPath(filePath: string): string {
	const parts = filePath.replace(/\\/g, "/").split("/");
	const file = parts[parts.length - 1];
	if (file.toLowerCase() === "skill.md") {
		return parts[parts.length - 2] ?? "";
	}
	return file.replace(/\.md$/i, "");
}

interface Frontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
}

function splitFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) return { frontmatter: {}, body: raw };
	return { frontmatter: parseSimpleYaml(match[1]), body: match[2] };
}

/** Minimal YAML parser for the flat key/value frontmatter skills use. */
function parseSimpleYaml(src: string): Frontmatter {
	const out: Frontmatter = {};
	for (const line of src.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = trimmed.indexOf(":");
		if (idx < 0) continue;
		const key = trimmed.slice(0, idx).trim();
		let value = trimmed.slice(idx + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key === "name") out.name = value;
		else if (key === "description") out.description = value;
		else if (key === "disable-model-invocation") out["disable-model-invocation"] = value === "true";
	}
	return out;
}
