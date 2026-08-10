/**
 * Filesystem tools. Registered only when filesystem.enabled is on.
 *
 *  - list_directory: read-only listing of an allowed dir with metadata (size /
 *    modified / accessed time / extension) so the model can spot long-unused,
 *    large, or installer-type files.
 *  - delete_files: two-step, file-only delete. An unconfirmed call returns a
 *    dry-run preview and deletes nothing; only after the user has explicitly
 *    authorized may the agent call again with confirmed=true. The tool itself is
 *    the gate — it never deletes without confirmed, and never touches directories
 *    or paths outside the whitelist.
 *
 * No write/modify tools exist: this capability is listing + authorized delete only.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { FileSystemService } from "../../filesystem/filesystem-service.js";

function formatSize(bytes: number): string {
	if (!bytes || bytes <= 0) return "-";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = bytes;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatDate(ms: number): string {
	if (!ms) return "-";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createFilesystemTools(filesystem: FileSystemService): AgentTool[] {
	const list: AgentTool = {
		name: "list_directory",
		label: "文件系统：列目录",
		description:
			"列出允许目录内的文件与子目录，返回名称、类型、大小、最近修改时间、最近访问时间。用于查看本地下载目录等、找出「长期未用/体积大/安装包/压缩包」类文件。只能列举 filesystem.allowedDirs 白名单内的目录；白名单外会被拒绝。",
		parameters: Type.Object({
			path: Type.String({ description: "要列举的目录路径，如 ~/Downloads（须在允许目录内）" }),
			recursive: Type.Optional(Type.Boolean({ description: "是否递归子目录（默认否，且有深度上限）" })),
		}),
		async execute(_toolCallId, params) {
			const { path: dirPath, recursive } = params as { path: string; recursive?: boolean };
			try {
				const { entries, truncated } = await filesystem.listDirectory(dirPath, recursive === true);
				if (entries.length === 0) {
					return { content: [{ type: "text", text: `目录 ${dirPath} 为空或没有可读条目。` }], details: { ok: true, count: 0 } };
				}
				const lines = entries.map(
					(e, i) =>
						`${i + 1}. ${e.isDir ? "[目录]" : "[文件]"} ${e.name}${e.isDir ? "" : `  ${formatSize(e.size)}${e.ext || ""}`}  修改:${formatDate(e.mtime)}  访问:${formatDate(e.atime)}`,
				);
				const note = truncated ? `\n（条目过多，仅显示前 ${entries.length} 条）` : "";
				return {
					content: [{ type: "text", text: lines.join("\n") + note }],
					details: { ok: true, count: entries.length, truncated },
				};
			} catch (err) {
				return { content: [{ type: "text", text: `列举失败：${(err as Error).message}` }], details: { ok: false } };
			}
		},
	};

	const del: AgentTool = {
		name: "delete_files",
		label: "文件系统：删除文件",
		description:
			"删除允许目录内的文件。必须两步：先不带 confirmed（或 confirmed=false）调用，得到拟删清单，把清单明确展示给用户并征得其明确同意；只有在用户明确同意后，才可再次调用并带 confirmed=true 真正删除。未经用户明确授权绝不删除或修改任何文件；仅能删除文件、不能删除目录；白名单外的路径会被拒绝。",
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { description: "要删除的文件绝对路径列表" }),
			confirmed: Type.Optional(
				Type.Boolean({ description: "仅当用户已明确同意删除时才设为 true；缺省/false 只返回拟删清单、不删除" }),
			),
		}),
		async execute(_toolCallId, params) {
			const { paths, confirmed } = params as { paths: string[]; confirmed?: boolean };
			if (!Array.isArray(paths) || paths.length === 0) {
				return { content: [{ type: "text", text: "paths 不能为空。" }], details: { ok: false } };
			}
			const { dryRun, results } = await filesystem.deleteFiles(paths, confirmed === true);
			if (dryRun) {
				const valid = results.filter((r) => r.ok).map((r) => r.path);
				const invalid = results.filter((r) => !r.ok);
				let text = `【拟删清单 · 尚未删除】以下 ${valid.length} 个文件将被删除：\n${
					valid.map((p, i) => `${i + 1}. ${p}`).join("\n") || "（无）"
				}`;
				if (invalid.length > 0) text += `\n以下无法删除：\n${invalid.map((r) => `- ${r.path}：${r.error}`).join("\n")}`;
				text += "\n请把清单展示给用户，征得明确同意后，再带 confirmed=true 调用本工具执行删除。";
				return { content: [{ type: "text", text }], details: { ok: true, dryRun: true, candidates: valid.length } };
			}
			const okCount = results.filter((r) => r.ok).length;
			const failed = results.filter((r) => !r.ok);
			let text = `已删除 ${okCount} 个文件。`;
			if (failed.length > 0) text += `\n删除失败：\n${failed.map((r) => `- ${r.path}：${r.error}`).join("\n")}`;
			return {
				content: [{ type: "text", text }],
				details: { ok: true, dryRun: false, deleted: okCount, failed: failed.length },
			};
		},
	};

	return [list, del];
}
