import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";

// The version pinned by Cua's official installer on 2026-09-08. Upstream marks
// this component release prerelease. Never silently follow monorepo "latest".
export const CUA_VERSION = "0.24.0";
export const CUA_RELEASE_URL = `https://github.com/trycua/cua/releases/tag/cua-driver-rs-v${CUA_VERSION}`;
const ASSETS: Record<string, { suffix: string; sha256: string }> = {
	"win32-x64": { suffix: "windows-x86_64.zip", sha256: "1c7197908b13325083337acdd66db7b65df246f65e2b91e2974a079d0773e596" },
	"win32-arm64": { suffix: "windows-arm64.zip", sha256: "7e593f774ea17fbaf758f4af82cff500418e1cbf6e62400ac27122a963fd20dc" },
	"linux-x64": { suffix: "linux-x86_64.tar.gz", sha256: "e313e4072bde730f16466b90388c7602954ff25714bf73f701d7218eeb7747d2" },
	"linux-arm64": { suffix: "linux-arm64.tar.gz", sha256: "6d7969715e6be6e1d635fc0017040825d132142c8503130b1ce08fb6ee71c8c9" },
};

export function driverInstallDir(dataDir: string): string {
	return join(dataDir, "computer", `cua-${CUA_VERSION}-${process.platform}-${process.arch}`);
}

export async function findDriver(root: string, depth = 0): Promise<string | null> {
	if (depth > 4 || !existsSync(root)) return null;
	const entries = await readdir(root, { withFileTypes: true });
	const name = process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
	const binary = entries.find(e => e.isFile() && e.name === name);
	if (binary) return join(root, binary.name);
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const found = await findDriver(join(root, entry.name), depth + 1);
			if (found) return found;
		}
	}
	return null;
}

export function verifyDriverArchive(bytes: Buffer, expected: string): void {
	if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Cua 安装包 SHA-256 校验失败，未安装。请重新下载。");
}

/** Download only a fixed official artifact; no remote install script is executed. */
export async function installDriver(dataDir: string, signal: AbortSignal, progress: (percent: number) => void): Promise<string> {
	const asset = ASSETS[`${process.platform}-${process.arch}`];
	if (!asset) throw new Error("此平台请先按 Cua 官方说明安装驱动，再填写驱动绝对路径。macOS 需要为 CuaDriver.app 授予辅助功能和屏幕录制权限。");
	const target = driverInstallDir(dataDir);
	const existing = await findDriver(target);
	if (existing) return existing;
	const staging = `${target}.tmp-${randomUUID()}`;
	await mkdir(staging, { recursive: true });
	try {
		const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_VERSION}/cua-driver-rs-${CUA_VERSION}-${asset.suffix}`;
		const response = await fetch(url, { signal });
		if (!response.ok || !response.body) throw new Error(`Cua 下载失败（HTTP ${response.status}）。可从官方发布页离线下载并填写驱动路径。`);
		const total = Number(response.headers.get("content-length")) || 0;
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			signal.throwIfAborted();
			size += chunk.length;
			if (size > 160 * 1024 * 1024) throw new Error("Cua 安装包超过大小限制。");
			chunks.push(Buffer.from(chunk));
			progress(total ? Math.min(95, Math.floor(size / total * 95)) : 0);
		}
		const bytes = Buffer.concat(chunks);
		verifyDriverArchive(bytes, asset.sha256);
		signal.throwIfAborted();
		if (asset.suffix.endsWith(".zip")) {
			const zip = new AdmZip(bytes);
			// Do not let an archive path escape the private staging directory.
			for (const entry of zip.getEntries()) {
				if (/^(?:[\\/]|[a-z]:)/i.test(entry.entryName) || entry.entryName.split(/[\\/]/).includes("..")) throw new Error("Cua 压缩包路径非法。");
			}
			zip.extractAllTo(staging, true);
		} else {
			const archive = join(staging, "driver.tar.gz");
			await writeFile(archive, bytes);
			await promisify(execFile)("tar", ["-xzf", archive, "-C", staging], { signal });
			await rm(archive);
		}
		const driver = await findDriver(staging);
		if (!driver) throw new Error("Cua 安装包未包含 cua-driver 可执行文件。");
		if (process.platform !== "win32") await chmod(driver, 0o755);
		signal.throwIfAborted();
		await rename(staging, target);
		progress(100);
		return (await findDriver(target))!;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
