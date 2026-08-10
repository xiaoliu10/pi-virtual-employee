// esbuild options for the Electron main + preload.
//
// Two builds with DIFFERENT formats:
//   - main:    ESM  (pi-ai is ESM-only; Electron 33 main supports ESM)
//   - preload: CJS  (Electron loads preload as CommonJS — it CANNOT load ESM
//                    preload, which is what broke window.api / caused white screens)
//
// node_modules (incl. native better-sqlite3 and the pi-* / dingtalk-stream
// packages) are externalized, loaded from node_modules at runtime. The ESM main
// gets a banner restoring the CJS-only globals (__dirname/__filename/require)
// that bundled code may reference; the CJS preload needs none (they're native).

export const ESM_SHIM = [
	"import { createRequire as __cjsRequire } from 'node:module';",
	"import { fileURLToPath as __fileURLToPath } from 'node:url';",
	"import { dirname as __pathDirname } from 'node:path';",
	"const require = __cjsRequire(import.meta.url);",
	"const __filename = __fileURLToPath(import.meta.url);",
	"const __dirname = __pathDirname(__filename);",
	"",
].join("\n");

export const mainOptions = {
	entryPoints: ["electron/main.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	packages: "external",
	outdir: "dist-electron",
	sourcemap: true,
	logLevel: "info",
	banner: { js: ESM_SHIM },
};

export const preloadOptions = {
	entryPoints: ["electron/preload.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	packages: "external",
	outdir: "dist-electron",
	outExtension: { ".js": ".cjs" },
	sourcemap: true,
	logLevel: "info",
};
