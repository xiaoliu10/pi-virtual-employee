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
import { readdir, stat, unlink } from "node:fs/promises";
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
}
