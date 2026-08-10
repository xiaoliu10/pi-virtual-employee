import esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mainOptions, preloadOptions } from "./esbuild-shared.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Bundle main + preload, then copy the built-in skills into dist so the
// packaged app can read them without relying on the source tree.
await Promise.all([esbuild.build(mainOptions), esbuild.build(preloadOptions)]);

const skillsSrc = join(root, "resources", "skills");
const skillsDest = join(root, "dist-electron", "resources", "skills");
await rm(skillsDest, { recursive: true, force: true });
await mkdir(skillsDest, { recursive: true });
await cp(skillsSrc, skillsDest, { recursive: true }).catch(() => {
	/* resources/skills optional */
});

console.log("[build-electron] done → dist-electron/");
