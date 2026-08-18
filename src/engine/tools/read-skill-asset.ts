/**
 * read_skill_asset — read-only access to an imported skill's bundled files.
 *
 * A skill imported from a zip (or a multi-file directory) may carry scripts,
 * templates, or reference data alongside SKILL.md. The skill's instructions can
 * point the model at those assets (e.g. "执行 ./run.py 的步骤" or "参考
 * templates/tpl.html"). This tool lets the model read a single file by relative
 * path inside ONE skill's directory — nothing else.
 *
 * Safety contract (mirrors skill-writer.ts):
 *   - `skill` must match the loader's name pattern (blocks `..` / path chars).
 *   - the resolved file must land strictly under `<userSkillsDir>/<skill>/`;
 *     any `..`, absolute, or symlink escape is rejected.
 *   - read-only; directories return a listing, never file contents from a dir.
 *   - large or non-text assets are summarized (size + a hex/preview snippet)
 *     so the context window isn't flooded.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SKILL_NAME_PATTERN } from "../skills/skill-parser.js";

/** Max bytes of a text asset to inline; larger files are summarized. */
const TEXT_INLINE_LIMIT = 65_536; // 64 KiB
/** Bytes of binary preview to show as hex when we can't inline the content. */
const BINARY_PREVIEW_BYTES = 64;

export function createReadSkillAssetTool(userSkillsDir: string): AgentTool {
	return {
		name: "read_skill_asset",
		label: "技能：读取附属文件",
		description:
			"读取某个已导入技能目录下的附属文件（脚本、模板、参考数据等，随该技能的 SKILL.md 一起导入）。用于执行或参考 SKILL.md 中以相对路径引用的文件（如 run.py、templates/tpl.html）。" +
			"只读，且只能读取该技能自身目录内的文件；路径含 ..、绝对路径、或指向技能目录之外都会被拒绝。读目录则返回其下文件清单（不递归），不返回目录内容正文。",
		parameters: Type.Object({
			skill: Type.String({
				description: "技能名（与技能目录名一致，如 退款处理、handle-refund）",
			}),
			path: Type.String({
				description: "要读取的文件在该技能目录下的相对路径，如 run.py、templates/tpl.html；留空或为 . 则列出该技能目录根的文件清单",
			}),
		}),
		async execute(_toolCallId, params) {
			const { skill, path: rel } = params as { skill: string; path: string };
			const skillErr = validateName(skill);
			if (skillErr) {
				return { content: [{ type: "text", text: `技能名无效：${skillErr}` }], details: { ok: false } };
			}
			// Resolve strictly under <userSkillsDir>/<skill>/; reject any escape.
			const base = resolve(userSkillsDir, skill);
			const dest = resolve(base, rel ?? ".");
			if (!isInside(dest, base)) {
				return {
					content: [{ type: "text", text: `路径越界：只能读取技能「${skill}」目录内的文件。` }],
					details: { ok: false },
				};
			}
			let st;
			try {
				st = statSync(dest);
			} catch {
				return {
					content: [{ type: "text", text: `文件不存在：${rel || "(技能目录根)"}（位于技能「${skill}」目录内）` }],
					details: { ok: false },
				};
			}
			// Reject symlinks that point outside (lstat the path itself first).
			try {
				if (lstatSync(dest).isSymbolicLink()) {
					return { content: [{ type: "text", text: `拒绝读取符号链接：${rel}` }], details: { ok: false } };
				}
			} catch {
				/* fall through to the stat-based handling */
			}

			if (st.isDirectory()) {
				const listing = safeListDir(dest, base);
				if (!listing) {
					return { content: [{ type: "text", text: `目录不可读：${rel}` }], details: { ok: false } };
				}
				if (listing.length === 0) {
					return { content: [{ type: "text", text: `目录 ${rel || "."} 为空。` }], details: { ok: true, count: 0 } };
				}
				const lines = listing.map((e) => `${e.isDir ? "[目录]" : "[文件]"} ${e.name}${e.isDir ? "" : `  ${formatSize(e.size)}`}`);
				return {
					content: [{ type: "text", text: `技能「${skill}」目录 ${rel || "."} 下的条目：\n${lines.join("\n")}` }],
					details: { ok: true, count: listing.length },
				};
			}

			// File: size guard first.
			if (st.size > 4 * 1024 * 1024) {
				return {
					content: [{ type: "text", text: `文件过大（${formatSize(st.size)}），不读入正文。如需其内容请说明用途，或分段引用。` }],
					details: { ok: false, size: st.size },
				};
			}
			const buf = readFileSync(dest);
			if (isLikelyBinary(buf)) {
				const preview = buf.subarray(0, BINARY_PREVIEW_BYTES);
				const hex = Array.from(preview, (b) => b.toString(16).padStart(2, "0")).join(" ");
				return {
					content: [
						{ type: "text", text: `${rel} 是二进制文件（${formatSize(st.size)}），不读入正文。前 ${preview.length} 字节(hex)：\n${hex}` },
					],
					details: { ok: true, binary: true, size: st.size },
				};
			}
			let text = buf.toString("utf8");
			let truncated = false;
			if (text.length > TEXT_INLINE_LIMIT) {
				text = text.slice(0, TEXT_INLINE_LIMIT);
				truncated = true;
			}
			const note = truncated ? `\n（已截断，仅显示前 ${TEXT_INLINE_LIMIT} 字符；完整文件 ${formatSize(st.size)}）` : "";
			return {
				content: [{ type: "text", text: `${rel} （技能「${skill}」，${formatSize(st.size)}）：\n${text}${note}` }],
				details: { ok: true, size: st.size, truncated },
			};
		},
	};
}

/** Validate a skill name against the loader's rule + length cap. */
function validateName(name: string): string | null {
	if (!name) return "name 不能为空";
	if (name.length > 64) return `name 过长（${name.length} > 64）`;
	if (!SKILL_NAME_PATTERN.test(name)) return "name 仅允许中文、小写字母、数字、连字符";
	return null;
}

/** True iff `dest` resolves strictly under `base` (no `..`/symlink escape). */
function isInside(dest: string, base: string): boolean {
	try {
		const b = resolve(base);
		const d = resolve(dest);
		return d === b || d.startsWith(b + "/");
	} catch {
		return false;
	}
}

/** List a directory's direct children, rejecting any symlinked entry that escapes base. */
function safeListDir(dir: string, base: string): { name: string; isDir: boolean; size: number }[] | null {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	const out: { name: string; isDir: boolean; size: number }[] = [];
	for (const name of names) {
		const full = resolve(dir, name);
		if (!isInside(full, base)) continue;
		try {
			const lst = lstatSync(full);
			if (lst.isSymbolicLink()) continue; // skip symlinks outright
			out.push({ name, isDir: lst.isDirectory(), size: lst.size });
		} catch {
			/* skip unreadable entry */
		}
	}
	return out;
}

/** Heuristic: a file with a NUL byte in the first 8 KiB is treated as binary. */
function isLikelyBinary(buf: Buffer): boolean {
	const probe = buf.subarray(0, Math.min(buf.length, 8192));
	for (let i = 0; i < probe.length; i++) {
		if (probe[i] === 0) return true;
	}
	return false;
}

function formatSize(bytes: number): string {
	if (!bytes || bytes <= 0) return "-";
	const units = ["B", "KB", "MB", "GB"];
	let v = bytes;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
