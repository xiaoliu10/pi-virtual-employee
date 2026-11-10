// Build-environment guard, run as the FIRST step of every package:* script.
//
// Why this exists (v0.2.215 incident, 2026-11-10): the release worktree's
// node_modules was a symlink to the main checkout. electron-builder's
// node-module collector shells out to `npm list -a`, which mis-resolves a
// symlinked node_modules and reports thousands of bogus
// "missing:/extraneous" entries. The collector's production graph collapses
// (depCount=27 instead of several hundred) and the packaged app.asar ships
// with only a fraction of runtime dependencies (1563 files vs ~12k). The
// installed app then dies at startup with "Cannot find module 'bindings'"
// and sits on an invisible error dialog — indistinguishable from a hang on
// an unattended machine. Same tree, same builder version, same command:
// the ONLY variable was the symlinked node_modules.
//
// Guard: refuse to package from a directory whose node_modules is a symlink.
import { lstat, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(join(here, ".."));
const nmPath = join(root, "node_modules");

let st;
try {
	st = await lstat(nmPath);
} catch {
	console.error("[check-build-env] node_modules does not exist — run `npm ci` first.");
	process.exit(1);
}

if (st.isSymbolicLink()) {
	const target = await realpath(nmPath);
	console.error("[check-build-env] REFUSING to package: node_modules is a symlink.");
	console.error(`[check-build-env]   ${nmPath} -> ${target}`);
	console.error("[check-build-env] electron-builder's npm-list collector produces a broken");
	console.error("[check-build-env] app.asar on symlinked node_modules (v0.2.215 startup-freeze");
	console.error("[check-build-env] incident). Package from a checkout with a real node_modules:");
	console.error("[check-build-env]   - build in the main repo checkout, or");
	console.error("[check-build-env]   - run `npm ci` in this worktree to materialise a real tree.");
	process.exit(1);
}

console.log("[check-build-env] ok: node_modules is a real directory");
