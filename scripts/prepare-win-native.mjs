import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAbi } from "node-abi";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "build", "native-win");
const tmpDir = join(root, "build", ".native-win-tmp");

const electronVersion = JSON.parse(await readFile(join(root, "node_modules", "electron", "package.json"), "utf8")).version;
const betterSqliteVersion = JSON.parse(await readFile(join(root, "node_modules", "better-sqlite3", "package.json"), "utf8")).version;
const sqliteVecVersion = JSON.parse(await readFile(join(root, "node_modules", "sqlite-vec", "package.json"), "utf8")).version;
const electronAbi = getAbi(electronVersion, "electron");

const betterSqliteArchive = `better-sqlite3-v${betterSqliteVersion}-electron-v${electronAbi}-win32-x64.tar.gz`;
const betterSqliteUrl = `https://registry.npmmirror.com/-/binary/better-sqlite3/v${betterSqliteVersion}/${betterSqliteArchive}`;
const sqliteVecUrl = `https://registry.npmjs.org/sqlite-vec-windows-x64/-/sqlite-vec-windows-x64-${sqliteVecVersion}.tgz`;

async function download(url, dest) {
	console.log(`[prepare-win-native] download ${url}`);
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
	await BunCompatWrite(dest, new Uint8Array(await response.arrayBuffer()));
}

async function BunCompatWrite(path, bytes) {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(path, bytes);
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

	const vecArchivePath = join(tmpDir, `sqlite-vec-windows-x64-${sqliteVecVersion}.tgz`);
	await download(sqliteVecUrl, vecArchivePath);
	await extract(vecArchivePath, ["-C", outDir, "--strip-components=1", "package/vec0.dll"]);

	for (const file of ["better_sqlite3.node", "vec0.dll"]) {
		const bytes = await readFile(join(outDir, file));
		if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
			throw new Error(`${file} is not a Windows PE binary`);
		}
		console.log(`[prepare-win-native] ready ${file} (${bytes.length} bytes)`);
	}
} finally {
	await rm(tmpDir, { recursive: true, force: true });
}
