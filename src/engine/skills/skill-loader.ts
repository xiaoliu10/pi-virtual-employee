/**
 * SkillLoader — reads SKILL.md files from the built-in resource directory and
 * the user's imported-skills directory, parses them, and returns Skill[] ready
 * to inject into the system prompt via formatSkillsForSystemPrompt.
 *
 * Skill enablement is persisted as a set of disabled names in config so the
 * built-in skills can be turned off without deleting their files.
 */
import type { Skill } from "@earendil-works/pi-agent-core";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseSkillFile } from "./skill-parser.js";

export interface LoadedSkillInfo {
	name: string;
	description: string;
	source: "builtin" | "user";
	filePath: string;
	warnings: string[];
}

export class SkillLoader {
	constructor(
		private readonly builtinDir: string,
		private readonly userDir: string,
	) {}

	async list(): Promise<{ skills: Skill[]; info: LoadedSkillInfo[] }> {
		const [builtin, user] = await Promise.all([
			this.collect(this.builtinDir, "builtin"),
			this.collect(this.userDir, "user"),
		]);
		const info = [...builtin.info, ...user.info];
		const byName = new Map<string, Skill>();
		for (const skill of [...builtin.skills, ...user.skills]) {
			byName.set(skill.name, skill);
		}
		return { skills: [...byName.values()], info };
	}

	private async collect(
		dir: string,
		source: "builtin" | "user",
	): Promise<{ skills: Skill[]; info: LoadedSkillInfo[] }> {
		const skills: Skill[] = [];
		const info: LoadedSkillInfo[] = [];
		let entries: string[] = [];
		try {
			entries = await readdir(dir);
		} catch {
			return { skills, info }; // directory missing → nothing to load
		}
		for (const entry of entries) {
			const abs = join(dir, entry);
			let isDir = false;
			try {
				isDir = (await stat(abs)).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				const skillFile = join(abs, "SKILL.md");
				const parsed = await this.tryParse(skillFile);
				if (parsed?.skill) {
					skills.push({ ...parsed.skill, source } as Skill & { source: string });
					info.push({
						name: parsed.skill.name,
						description: parsed.skill.description,
						source,
						filePath: skillFile,
						warnings: parsed.warning ? [parsed.warning] : [],
					});
				} else if (parsed?.warning) {
					info.push({
						name: entry,
						description: "",
						source,
						filePath: skillFile,
						warnings: [parsed.warning],
					});
				}
			} else if (entry.toLowerCase().endsWith(".md")) {
				const parsed = await this.tryParse(abs);
				if (parsed?.skill) {
					skills.push({ ...parsed.skill, source } as Skill & { source: string });
					info.push({
						name: parsed.skill.name,
						description: parsed.skill.description,
						source,
						filePath: abs,
						warnings: parsed.warning ? [parsed.warning] : [],
					});
				} else if (parsed?.warning) {
					info.push({
						name: entry.replace(/\.md$/i, ""),
						description: "",
						source,
						filePath: abs,
						warnings: [parsed.warning],
					});
				}
			}
		}
		return { skills, info };
	}

	private async tryParse(
		filePath: string,
	): Promise<{ skill: Skill | null; warning?: string } | null> {
		try {
			const raw = await readFile(filePath, "utf8");
			return parseSkillFile(filePath, raw);
		} catch {
			return null;
		}
	}
}

/** Filter to model-invocable, enabled skills and drop the injected `source`. */
export function pickActiveSkills(
	skills: Skill[],
	disabledNames: ReadonlySet<string>,
): Skill[] {
	return skills
		.filter((skill) => !skill.disableModelInvocation && !disabledNames.has(skill.name))
		.map((skill) => {
			const { source: _source, ...rest } = skill as Skill & { source?: string };
			return rest;
		});
}
