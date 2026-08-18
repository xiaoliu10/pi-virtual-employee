/**
 * SkillWriter — creates and updates user-authored SKILL.md packages under the
 * user skills directory. Skills are declarative Markdown injected into the
 * system prompt, so writing one is a long-lived change to the employee's
 * behavior: validation is strict and built-ins stay read-only.
 *
 * The writer is intentionally the ONLY path that mutates the skills directory
 * from the agent side. It reuses {@link SkillLoader} to detect existing skills
 * (by name and on-disk file) and {@link parseSkillFile} to validate the result
 * round-trips through the loader, so what is written is exactly what loads.
 */
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-agent-core";
import { SkillLoader } from "./skill-loader.js";
import { SKILL_NAME_PATTERN, parseSkillFile } from "./skill-parser.js";

export type SkillWriteMode = "create" | "replace";

export interface SkillUpsertInput {
	/** Stable kebab-case skill name. */
	name: string;
	/** One-line trigger description (≤1024 chars). */
	description: string;
	/** Full Markdown body: when-to-use, standard steps, completion criteria, caveats. */
	content: string;
	/** create refuses to overwrite; replace updates an existing same-name skill. */
	mode?: SkillWriteMode;
}

export interface SkillWriteResult {
	/** Outcome category the caller (tool/UI) can switch on for messaging. */
	outcome: "created" | "updated" | "needs-confirm" | "rejected";
	name: string;
	/** Absolute path written (created/updated) or the conflicting existing path. */
	filePath?: string;
	/** Human-readable Chinese explanation suitable for the agent to relay. */
	message: string;
}

/**
 * Serialize a skill to the on-disk SKILL.md format the loader parses. The
 * frontmatter values are YAML-quoted so descriptions containing `:`, `#`, or
 * quotes survive the parser's round-trip exactly.
 */
export function serializeSkill(input: SkillUpsertInput): string {
	return `---\nname: ${yamlScalar(input.name)}\ndescription: ${yamlScalar(input.description)}\n---\n\n${input.content.trim()}\n`;
}

/**
 * Write (create or replace) a user skill under `userSkillsDir`. Built-ins are
 * never writable. Writes are atomic (temp file + rename) and serialized, so two
 * concurrent saves can't interleave or hand a half-written file to the loader.
 *
 * The caller is responsible for refreshing the engine skill cache afterward —
 * `upsert` only touches disk, to keep it safe to invoke mid-turn.
 */
export class SkillWriter {
	/** Serializes all writes; each awaits the previous before starting. */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly loader: SkillLoader,
		private readonly userSkillsDir: string,
	) {}

	async upsert(input: SkillUpsertInput): Promise<SkillWriteResult> {
		// Serialize: a save must observe all prior saves, and later saves must
		// observe this one. Return this run's own result to the caller.
		const run = this.chain.then(() => this.upsertOnce(input));
		this.chain = run.then(noop, noop);
		return run;
	}

	private async upsertOnce(input: SkillUpsertInput): Promise<SkillWriteResult> {
		const name = (input.name ?? "").trim();
		const description = (input.description ?? "").trim();
		const content = (input.content ?? "").trim();
		const mode: SkillWriteMode = input.mode === "replace" ? "replace" : "create";

		const nameError = validateName(name);
		if (nameError) return reject(name, nameError);
		if (!description) return reject(name, "缺少 description（一句话说明该技能何时触发）");
		if (description.length > 1024) return reject(name, `description 过长（${description.length} > 1024）`);
		if (!content) return reject(name, "content 正文不能为空：需写清适用场景、标准步骤、完成标准");

		// Built-ins are read-only: a same-name built-in blocks create and replace.
		const builtin = await this.collectAt(this.loader.builtinDir);
		if (builtin.skills.some((s) => s.name === name)) {
			return reject(name, `「${name}」与内置技能重名，内置技能不可覆盖，请改用其它名称`);
		}

		// Locate an existing same-name user skill to update, if any. The loader
		// already dedups by name, so finding the user-side file tells us where to
		// replace rather than creating a duplicate.
		const user = await this.collectAt(this.loader.userDir);
		const existing = user.skills.find((s) => s.name === name);
		const existingPath = existing?.filePath ?? user.info.find((i) => i.name === name)?.filePath;

		if (existingPath && mode === "create") {
			return {
				outcome: "needs-confirm",
				name,
				filePath: existingPath,
				message: `技能「${name}」已存在。如需覆盖/更新，请明确确认后再次以 mode=replace 更新。`,
			};
		}

		// Prefer the canonical directory form <dir>/<name>/SKILL.md; if an existing
		// top-level <name>.md exists, write back to it so we don't fork into two.
		const target = existingPath && isTopLevelMd(existingPath, this.userSkillsDir, name)
			? existingPath
			: resolve(this.userSkillsDir, name, "SKILL.md");

		const safe = this.assertInsideUserDir(target);
		if (!safe) return reject(name, "目标路径越界，写入被拒绝");

		const serialized = serializeSkill({ name, description, content });
		// Round-trip check: what we write must parse back to the same skill.
		const parsed = parseSkillFile(target, serialized);
		if (!parsed.skill || parsed.skill.name !== name || parsed.skill.description !== description) {
			return reject(name, "写入内容校验失败：序列化后无法还原为有效技能（检查 description 是否含特殊字符）");
		}

		try {
			await mkdir(dirname(target), { recursive: true });
			// If migrating a top-level .md to the directory form (no existing file at
			// target yet), remove the old file so the loader stops finding both.
			if (existingPath && existingPath !== target && existsSync(existingPath)) {
				await unlink(existingPath).catch(() => {});
			}
			await atomicWriteFile(target, serialized);
		} catch (err) {
			return reject(name, `写入失败：${err instanceof Error ? err.message : String(err)}`);
		}

		return {
			outcome: existingPath ? "updated" : "created",
			name,
			filePath: target,
			message: existingPath
				? `已更新技能「${name}」（${target}）。新技能对后续新对话生效。`
				: `已创建技能「${name}」（${target}）。新技能对后续新对话生效。`,
		};
	}

	/** True iff `targetPath` resolves strictly under the user skills directory. */
	private assertInsideUserDir(targetPath: string): boolean {
		try {
			const base = resolve(this.userSkillsDir);
			const dest = resolve(targetPath);
			// Reject symlinks/`..` escapes. `resolve` normalizes `..`, so a path
			// outside `base` no longer has `base` as a real prefix.
			if (dest !== base && !dest.startsWith(base + "/")) return false;
			// If an ancestor is a symlink, lstat won't follow it; resolve+startsWith
			// on a symlinked user dir would still be fine (base is the symlink root),
			// but block a target whose own path is a symlink pointing outside.
			if (existsSync(dest)) {
				const st = lstatSync(dest);
				if (st.isSymbolicLink()) return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	/** Collect one directory without throwing on a missing user dir. */
	private async collectAt(dir: string): Promise<{ skills: Skill[]; info: { filePath: string; name: string }[] }> {
		const res = await this.loader.collect(dir, dir === this.loader.userDir ? "user" : "builtin");
		return {
			skills: res.skills,
			info: res.info.map((i) => ({ filePath: i.filePath, name: i.name })),
		};
	}
}

/** Validate a skill name against the loader's rule + length cap. */
function validateName(name: string): string | null {
	if (!name) return "name 不能为空";
	if (name.length > 64) return `name 过长（${name.length} > 64）`;
	if (!SKILL_NAME_PATTERN.test(name)) return "name 仅允许小写字母、数字、连字符（如 handle-refund）";
	return null;
}

function reject(name: string, message: string): SkillWriteResult {
	return { outcome: "rejected", name, message };
}

/** True when an existing file is a top-level `<name>.md` (vs the directory form). */
function isTopLevelMd(filePath: string, userSkillsDir: string, name: string): boolean {
	const rel = relative(resolve(userSkillsDir), resolve(filePath));
	if (isAbsolute(rel) || rel.startsWith("..")) return false;
	return rel === `${name}.md`;
}

/** Write to `<path>.tmp-<pid>` then atomically rename, so a crash never leaves a half-written SKILL.md. */
async function atomicWriteFile(target: string, data: string): Promise<void> {
	const tmp = `${target}.tmp-${process.pid}`;
	await writeFile(tmp, data, "utf8");
	await rename(tmp, target);
	// Guard: if rename didn't replace (shouldn't happen), ensure no tmp remains.
	if (existsSync(tmp)) await unlink(tmp).catch(() => {});
}

/** YAML-quote a scalar so `:` / `#` / leading specials don't break the parser. */
function yamlScalar(value: string): string {
	const needsQuotes = /[:#]/.test(value) || value.startsWith(" ") || value.endsWith(" ") || value.includes("\n");
	if (!needsQuotes) return value;
	// Double-quote, escape backslashes and double-quotes per YAML double-quoted style.
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

/** Swallow a promise so a rejected link doesn't break the serialized chain. */
function noop(): void {}
