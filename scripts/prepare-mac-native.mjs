#!/usr/bin/env node
/**
 * Copy the darwin-arm64 better-sqlite3 native binding (built by
 * electron-rebuild during npm install) into build/native-mac/ so
 * electron-builder's mac.extraResources picks it up as Resources/native/.
 *
 * Windows and Linux both have prepare-native scripts that download prebuilt
 * binaries; on Mac the node_modules build is already correct (the dev
 * machine IS darwin-arm64), so this is just a copy. Without it the packaged
 * app cannot find better_sqlite3.node and dies on startup (field 2026-09-29:
 * 0.2.97 Mac dmg "打不开" — app crashed with MODULE_NOT_FOUND on
 * Resources/native/better_sqlite3.node).
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "build", "native-mac");
const src = join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

try {
	await stat(src);
} catch {
	console.error("[prepare-mac-native] better_sqlite3.node not found at", src);
	console.error("               run: npx electron-rebuild -f -w better-sqlite3");
	process.exit(1);
}

await mkdir(outDir, { recursive: true });
await copyFile(src, join(outDir, "better_sqlite3.node"));
const size = (await stat(src)).size;
console.log(`[prepare-mac-native] ready better_sqlite3.node (${size} bytes)`);
