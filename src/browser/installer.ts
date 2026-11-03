/**
 * Real installer for the bundled Playwright Chromium binary.
 *
 * It runs the Playwright CLI that ships INSIDE app.asar using the app's OWN
 * Electron binary as a Node runtime (`ELECTRON_RUN_AS_NODE=1`). This means:
 *   - no standalone node is required on the machine (the 2026-11-02 box had a
 *     broken node shim and `npx playwright install` was impossible),
 *   - the CLI version always matches the bundled Playwright, so the installed
 *     revision is exactly the one the app will launch,
 *   - reading the script from inside app.asar works because Electron's Node
 *     understands the asar virtual filesystem.
 *
 * Download host override (PLAYWRIGHT_DOWNLOAD_HOST) provides a retry mirror when
 * the official CDN is blocked from the operator's network.
 */
import { spawn } from "node:child_process";
import { parseProgress, type InstallResult, type InstallRunner } from "./runtime.js";

export interface InstallerPaths {
	/** Electron executable to run as Node. Packaged: app.getPath('exe'). */
	electronExe: string;
	/** Absolute path to the bundled playwright cli.js (inside app.asar when packaged). */
	playwrightCli: string;
	/** Keep old browser revisions in the shared cache (other apps may use them). */
	skipGc?: boolean;
	/** Hard timeout for one download attempt (ms). */
	timeoutMs?: number;
}

/**
 * npmmirror mirrors Playwright's CDN build layout. Official host is tried first
 * (entry `undefined`); the mirror is the automatic fallback.
 */
export const DEFAULT_DOWNLOAD_HOSTS: (string | undefined)[] = [
	undefined,
	"https://cdn.npmmirror.com/binaries/playwright",
];

export function createInstallRunner(paths: InstallerPaths): InstallRunner {
	const timeoutMs = paths.timeoutMs ?? 20 * 60_000;
	return (onProgress, host) => runPlaywrightInstall(paths, host, timeoutMs, onProgress);
}

function runPlaywrightInstall(
	paths: InstallerPaths,
	host: string | undefined,
	timeoutMs: number,
	onProgress: (percent: number) => void,
): Promise<InstallResult> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			// Install BOTH chromium and the headless shell (`install chromium`
			// pulls both in modern Playwright). Do not prune old revisions: the
			// shared ms-playwright cache may serve a different Playwright (e.g.
			// a Python one) on the same machine.
			PLAYWRIGHT_SKIP_BROWSER_GC: paths.skipGc === false ? "0" : "1",
			PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "30000",
		};
		if (host) env.PLAYWRIGHT_DOWNLOAD_HOST = host;
		else delete env.PLAYWRIGHT_DOWNLOAD_HOST;

		let child;
		try {
			child = spawn(paths.electronExe, [paths.playwrightCli, "install", "chromium"], {
				env,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			resolve({ ok: false, tail: `failed to launch installer: ${(err as Error).message}` });
			return;
		}

		let combined = "";
		let pct = 0;
		let settled = false;
		const append = (chunk: Buffer): void => {
			const text = chunk.toString();
			combined = (combined + text).slice(-8000);
			const next = parseProgress(text, pct);
			if (next !== pct) {
				pct = next;
				onProgress(pct);
			}
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);

		const timer = setTimeout(() => {
			if (settled) return;
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
			finish(false, combined + `\n[installer] timed out after ${Math.round(timeoutMs / 1000)}s`);
		}, timeoutMs);

		const finish = (ok: boolean, tail: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok, tail });
		};

		child.on("error", (err) => finish(false, combined + `\n${err.message}`));
		child.on("close", (code) => finish(code === 0, combined));
	});
}

/** Extract the wanted revision label from the bundled chromium path. */
export function revisionFromExecutablePath(executablePath: string): string {
	const m = /chromium-(\d+)/.exec(executablePath.replace(/\\/g, "/"));
	return m ? m[1] : "";
}
