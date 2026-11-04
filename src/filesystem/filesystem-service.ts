/**
 * FileSystemService — scoped local filesystem access for the employee.
 *
 * Deliberately minimal and safe: READ-ONLY listing (directory contents +
 * metadata: size / modified / accessed time / extension) plus a two-step,
 * whitelist- and file-only DELETE. There are no write/modify operations.
 *
 * Safety model (mirrors browser.allowedDomains):
 *  - `filesystem.allowedDirs` is a whitelist (supports `~`); anything outside is
 *    refused. Empty whitelist + enabled → everything is refused.
 *  - Paths are resolved before the prefix check, so `..` cannot escape.
 *  - deleteFiles only removes regular files (never directories), and only after
 *    an explicit `confirmed` flag — an unconfirmed call returns a dry-run preview
 *    and deletes nothing. The authorization itself ("did the user say yes") is
 *    enforced by the agent + system-prompt rule; the confirmed flag is the
 *    tool-level gate that makes a two-step flow mandatory.
 */
import { mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConfigStore } from "../db/config-store.js";

export interface FileEntry {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	mtime: number;
	atime: number;
	ext: string;
}

/** Cap how many entries one listing returns, to keep the model context bounded. */
const LIST_LIMIT = 300;
/** Recursion depth cap when recursive listing is requested. */
const RECURSIVE_DEPTH = 2;

export class FileSystemService {
	/** App-level dirs always allowlisted IN ADDITION to the configured
	 * filesystem.allowedDirs — received files must be readable without the user
	 * first editing settings (field 2026-09-18: inbound files sat in OS Temp,
	 * outside the allowlist, so structured reads were refused). */
	private extraAllowed: string[] = [];

	constructor(private readonly config: ConfigStore) {}

	/** Register an app-managed dir (e.g. <userData>/inbound) as accessible. */
	addAllowedDir(dir: string | undefined): void {
		if (dir && !this.extraAllowed.includes(dir)) this.extraAllowed.push(dir);
	}

	/** Allowed directories as absolute paths (`~` expanded, blanks dropped). */
	allowedDirs(): string[] {
		return [
			...this.config
				.all()
				.filesystem.allowedDirs.map((d) => this.expand(d.trim()))
				.filter(Boolean),
			...this.extraAllowed,
		];
	}

	/** Expand a leading `~` to the home dir and resolve to an absolute path. */
	private expand(p: string): string {
		if (!p) return "";
		if (p === "~") return os.homedir();
		if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
		return path.resolve(p);
	}

	/** Throw unless `absPath` is exactly an allowed dir or nested inside one. */
	private assertAllowed(absPath: string): void {
		const resolved = path.resolve(this.expand(absPath));
		const ok = this.allowedDirs().some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
		if (!ok) throw new Error(`路径不在允许访问的目录内：${absPath}`);
		// Deny-list for the app's own sensitive files. The allowed dirs are
		// app-managed, but on Windows a junction/symlink inside one can point at
		// the profile's database, config, skills or logs — a write there is
		// self-escalation (RBAC lives in that DB). See assertAllowedReal below.
		if (this.isSensitive(resolved)) throw new Error(`拒绕访问应用自身数据文件：${absPath}`);
	}

	/** Absolute paths the employee must never read-modify even inside a whitelist. */
	private sensitiveDirs: string[] = [];

	/** Register the app's own data dirs (profile root) as off-limits for writes. */
	addSensitiveDir(dir: string | undefined): void {
		if (!dir) return;
		const abs = path.resolve(dir);
		if (!this.sensitiveDirs.includes(abs)) this.sensitiveDirs.push(abs);
	}

	private isSensitive(resolved: string): boolean {
		return this.sensitiveDirs.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
	}

	/**
	 * Resolve symlinks/junctions before the whitelist check. A literal prefix
	 * compare is not enough on Windows: `scripts/link -> ..` yields a path that
	 * LOOKS allowed while the write lands in the profile. Real-path checking is
	 * defence in depth — the workspace also lives outside the profile.
	 *
	 * For a not-yet-existing target the deepest EXISTING ancestor is resolved
	 * and the remaining segments are appended, so a link cannot be laundered
	 * through a file name that does not exist yet.
	 */
	private async assertAllowedReal(absPath: string): Promise<void> {
		this.assertAllowed(absPath);
		let probe = path.resolve(this.expand(absPath));
		const suffix: string[] = [];
		for (let i = 0; i < 64; i++) {
			let real: string;
			try {
				real = await realpath(probe);
			} catch {
				const parent = path.dirname(probe);
				if (parent === probe) break; // reached the root without an existing ancestor
				suffix.unshift(path.basename(probe));
				probe = parent;
				continue;
			}
			const final = suffix.length ? path.join(real, ...suffix) : real;
			// Compare against the REAL path of every allowed dir too: the literal
			// configured path may itself be a link (/var -> /private/var on macOS,
			// 8.3 short names or junctions on Windows). Comparing a resolved target
			// against an unresolved allowed dir rejects legitimate writes.
			const allowedReal = await Promise.all(
				this.allowedDirs().map((dir) => realpath(dir).catch(() => path.resolve(dir))),
			);
			const ok = allowedReal.some((dir) => final === dir || final.startsWith(dir + path.sep));
			if (!ok) throw new Error(`路径不在允许访问的目录内（符号链接解析后）：${absPath}`);
			if (this.isSensitive(final)) throw new Error(`拒绕访问应用自身数据文件：${absPath}`);
			return;
		}
	}

	/**
	 * List a directory's entries with metadata. Files come first, then oldest
	 * modified first — directly useful for spotting long-unused items. Bounded to
	 * LIST_LIMIT; `truncated` flags when the cap was hit.
	 */
	async listDirectory(dirPath: string, recursive = false): Promise<{ entries: FileEntry[]; truncated: boolean }> {
		this.assertAllowed(dirPath);
		const root = path.resolve(this.expand(dirPath));
		const entries: FileEntry[] = [];
		let truncated = false;

		const walk = async (dir: string, depth: number): Promise<void> => {
			if (entries.length >= LIST_LIMIT) {
				truncated = true;
				return;
			}
			let dirents;
			try {
				dirents = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const d of dirents) {
				if (entries.length >= LIST_LIMIT) {
					truncated = true;
					return;
				}
				const abs = path.join(dir, d.name);
				try {
					const st = await stat(abs);
					const isDir = st.isDirectory();
					entries.push({
						name: d.name,
						path: abs,
						isDir,
						size: isDir ? 0 : st.size,
						mtime: st.mtimeMs,
						atime: st.atimeMs,
						ext: isDir ? "" : path.extname(d.name).toLowerCase(),
					});
					if (recursive && isDir && depth < RECURSIVE_DEPTH && !d.name.startsWith(".")) {
						await walk(abs, depth + 1);
					}
				} catch {
					/* skip unreadable entries */
				}
			}
		};

		await walk(root, 0);
		entries.sort((a, b) => (a.isDir === b.isDir ? a.mtime - b.mtime : a.isDir ? 1 : -1));
		return { entries, truncated };
	}

	/**
	 * Two-step, file-only delete. When `confirmed` is not true this validates the
	 * targets and returns a preview WITHOUT deleting anything; only `confirmed===true`
	 * actually unlinks. Directories are always refused. Returns per-path results.
	 */
	async deleteFiles(
		paths: string[],
		confirmed: boolean,
	): Promise<{ dryRun: boolean; results: { path: string; ok: boolean; error?: string }[] }> {
		const results: { path: string; ok: boolean; error?: string }[] = [];
		for (const p of paths) {
			const abs = path.resolve(this.expand(p));
			try {
				this.assertAllowed(abs);
				const st = await stat(abs);
				if (st.isDirectory()) {
					results.push({ path: abs, ok: false, error: "拒绝删除目录（仅允许删除文件）" });
					continue;
				}
				if (!confirmed) {
					results.push({ path: abs, ok: true }); // dry-run candidate
					continue;
				}
				await unlink(abs);
				results.push({ path: abs, ok: true });
			} catch (err) {
				results.push({ path: abs, ok: false, error: (err as Error).message });
			}
		}
		return { dryRun: !confirmed, results };
	}

	/**
	 * Write a text file VERBATIM (UTF-8), then read it back and verify the byte
	 * count — the write is only reported as successful when the content on disk
	 * matches what was asked (a truncated tool argument must not silently
	 * produce a half-written script).
	 *
	 * WHY this exists: agents on Windows had NO way to create a script file
	 * except inline shell (`echo > file`, `Set-Content`, `python -c ...`), which
	 * stacks three escaping layers (JSON argument → shell quoting → the target
	 * language's own string syntax) and failed repeatedly in the field. Content
	 * as a plain tool argument removes every one of those layers.
	 *
	 * Same whitelist as list/delete (`assertAllowed`, `..` cannot escape).
	 * Unlike delete there is no two-step confirm: writing inside the allowed
	 * workspace is the routine script-iteration operation, and the read-back
	 * result tells the user exactly what landed.
	 */
	async writeTextFile(
		targetPath: string,
		content: string,
		overwrite: boolean,
	): Promise<{ path: string; bytes: number; overwritten: boolean; firstLine: string; replacedBytes?: number }> {
		// Reject unencodable content BEFORE touching the disk: a lone surrogate
		// becomes U+FFFD on write, so the read-back would fail AFTER the previous
		// good file was already destroyed (independent review P1-2).
		if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)) {
			throw new Error("内容含未配对的 UTF-16 代理项（无法无损编码为 UTF-8），未写入任何内容。请检查传入的字符串。");
		}
		const abs = path.resolve(this.expand(targetPath));
		// Same-conversation writes go through the symlink-resolving check so a
		// junction inside the workspace cannot redirect the write into the profile.
		await this.assertAllowedReal(abs);
		const prior = await stat(abs).then((s) => ({ isFile: s.isFile(), size: s.size })).catch(() => undefined);
		const existed = prior?.isFile === true;
		if (existed && !overwrite) {
			throw new Error(`文件已存在且未允许覆盖：${abs}（如需更新脚本内容，设 overwrite=true）`);
		}
		await mkdir(path.dirname(abs), { recursive: true });
		// Write to a sibling temp file and rename over the target only after the
		// content verifies, so a failed write can never destroy a working script.
		const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
		// No BOM: a BOM breaks `node script.mjs` shebang-less ESM detection on
		// some runtimes and shows up as an invisible first-character diff.
		await writeFile(tmp, content, { encoding: "utf8" });
		let back: string;
		try {
			back = await readFile(tmp, "utf8");
		} catch (err) {
			await unlink(tmp).catch(() => {});
			throw err;
		}
		if (back !== content) {
			await unlink(tmp).catch(() => {});
			throw new Error(
				`写入校验失败：内容无法无损写入（请求 ${content.length} 字符，读回 ${back.length} 字符）。` +
					`原文件未被修改。请检查内容是否含无法编码的字符，不要盲目重试。`,
			);
		}
		// rename replaces an existing target atomically on both POSIX and Windows
		// (Node's rename maps to MoveFileEx with REPLACE_EXISTING).
		const { rename } = await import("node:fs/promises");
		await rename(tmp, abs).catch(async (err) => {
			await unlink(tmp).catch(() => {});
			throw err;
		});
		return {
			path: abs,
			bytes: Buffer.byteLength(content, "utf8"),
			overwritten: existed,
			firstLine: (content.split(/\r?\n/, 1)[0] ?? "").slice(0, 80),
			...{ replacedBytes: existed ? prior?.size : undefined },
		};
	}
}
