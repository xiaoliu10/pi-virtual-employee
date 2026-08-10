// Dev orchestrator:
//   1. Vite dev server for the React renderer (HMR)
//   2. esbuild (watch) bundling Electron main (ESM) + preload (CJS) → dist-electron/
//   3. Launch Electron pointing at the bundled main, with VITE_DEV_SERVER_URL set
import { spawn } from "node:child_process";
import esbuild from "esbuild";
import { createServer } from "vite";
import electronPath from "electron";
import { mainOptions, preloadOptions } from "./esbuild-shared.mjs";

const vite = await createServer({ configFile: "vite.config.ts", clearScreen: false });
await vite.listen();
const devUrl = vite.resolvedUrls.local[0];
console.log(`[dev] renderer dev server: ${devUrl}`);

const mainCtx = await esbuild.context(mainOptions);
const preCtx = await esbuild.context(preloadOptions);
await Promise.all([mainCtx.watch(), preCtx.watch()]);
console.log("[dev] electron main + preload watching…");

// Forward any --profile <name> arg so `npm run dev -- --profile alice` isolates a
// profile. (PI_PROFILE env is also honored by the main process via process.env.)
const profileArgs = (() => {
	const i = process.argv.indexOf("--profile");
	return i >= 0 && process.argv[i + 1] ? ["--profile", process.argv[i + 1]] : [];
})();

const child = spawn(String(electronPath), [".", "--no-sandbox", ...profileArgs], {
	stdio: "inherit",
	env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
});

child.on("exit", async (code) => {
	await Promise.all([mainCtx.dispose(), preCtx.dispose()]);
	await vite.close();
	process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => child.kill(sig));
}
