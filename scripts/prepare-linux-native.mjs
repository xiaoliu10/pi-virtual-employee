import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAbi } from "node-abi";

// Stages the target-native (linux-x64) binaries as extraResources so the
// packaged app never depends on the build host's node addon. Mirror of
// prepare-win-native.mjs: same fetch/extract shape, ELF magic check instead of
// PE, and the linux package names (better_sqlite3.node / vec0.so — the latter
// matches electron/main.ts's `process.platform === "linux"` branch).

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "build", "native-linux");
const tmpDir = join(root, "build", ".native-linux-tmp");

const electronVersion = JSON.parse(await readFile(join(root, "node_modules", "electron", "package.json"), "utf8")).version;
const betterSqliteVersion = JSON.parse(await readFile(join(root, "node_modules", "better-sqlite3", "package.json"), "utf8")).version;
const sqliteVecVersion = JSON.parse(await readFile(join(root, "node_modules", "sqlite-vec", "package.json"), "utf8")).version;
const electronAbi = getAbi(electronVersion, "electron");

const betterSqliteArchive = `better-sqlite3-v${betterSqliteVersion}-electron-v${electronAbi}-linux-x64.tar.gz`;
const betterSqliteUrl = `https://registry.npmmirror.com/-/binary/better-sqlite3/v${betterSqliteVersion}/${betterSqliteArchive}`;
const sqliteVecUrl = `https://registry.npmjs.org/sqlite-vec-linux-x64/-/sqlite-vec-linux-x64-${sqliteVecVersion}.tgz`;

async function download(url, dest) {
	console.log(`[prepare-linux-native] download ${url}`);
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
	const { writeFile } = await import("node:fs/promises");
	await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
}

async function extract(archive, args) {
	await execFileAsync("tar", ["-xzf", archive, ...args]);
}

await rm(tmpDir, { recursive: true, force: true });
await rm(outDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });
await mkdir(outDir, { recursive: true });

try {
	const betterArchivePath = join(tmpDir, betterSqliteArchive);
	await download(betterSqliteUrl, betterArchivePath);
	await extract(betterArchivePath, ["-C", outDir, "--strip-components=2", "build/Release/better_sqlite3.node"]);

	const vecArchivePath = join(tmpDir, `sqlite-vec-linux-x64-${sqliteVecVersion}.tgz`);
	await download(sqliteVecUrl, vecArchivePath);
	await extract(vecArchivePath, ["-C", outDir, "--strip-components=1", "package/vec0.so"]);

	// Both files are ELF shared objects; verify the 4-byte magic (\x7fELF).
	for (const file of ["better_sqlite3.node", "vec0.so"]) {
		const bytes = await readFile(join(outDir, file));
		if (!(bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)) {
			throw new Error(`${file} is not an ELF binary`);
		}
		console.log(`[prepare-linux-native] ready ${file} (${bytes.length} bytes)`);
	}
} finally {
	await rm(tmpDir, { recursive: true, force: true });
}
