/**
 * pi runtime bootstrap — install/verify the pi-coding-agent runtime under
 * userData (docs/design/ve-pi-session-migration.md §6).
 *
 * The packaged app ships only a LOCKFILE (resources/pi-runtime-lock/); the
 * runtime tree itself is installed on the user's machine from a source chain
 * (npmmirror → Gitee → npmjs by default; configurable). Discipline:
 *
 *  - version-locked: npm ci against a shipped package-lock.json — the tree is
 *    exactly what VE was built and tested against;
 *  - verified: a headless `--version` self-check through VE's own Electron
 *    binary (ELECTRON_RUN_AS_NODE), with the version-lie env vars scrubbed
 *    (desktop's prepare-runtime lesson: PI_PACKAGE_DIR makes the bundled CLI
 *    report the GLOBAL version);
 *  - atomic: runtime.json lands via tmp+rename, so a crash mid-install can
 *    never present a half-written runtime as ready;
 *  - honest: any failure surfaces as { status: "failed" } — the caller must
 *    not start the pi-session kernel without a verified runtime.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeManifest {
	platform: NodeJS.Platform;
	arch: string;
	pi: string;
	installedAt: number;
	source: string;
}

export interface EnsureRuntimeOptions {
	/** Directory holding the shipped lockfile (package.json + package-lock.json). */
	lockDir: string;
	/** Install target (userData/pi-runtime). */
	targetDir: string;
	/** Registries tried in order; first one that installs cleanly wins. */
	registries: string[];
	/** Injectable for tests — default spawns the real npm. */
	runInstall?: (cwd: string, registry: string) => Promise<{ ok: boolean; output: string }>;
	/** Injectable for tests — default spawns Electron-as-Node for --version. */
	runVersionCheck?: (cliPath: string, expected: string) => Promise<{ ok: boolean; output: string }>;
	/** Log sink (main process log). */
	log?: (line: string) => void;
}

export type EnsureRuntimeResult =
	| { status: "ready"; dir: string; version: string; source: string; fresh: boolean }
	| { status: "failed"; attempted: string[]; errors: string[] };

const VERSION_LIE_ENV_VARS = ["PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"];

function defaultInstall(cwd: string, registry: string): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const child = spawn(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--registry", registry], {
			cwd,
			env: process.env,
			shell: process.platform === "win32",
		});
		let output = "";
		child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
		child.stderr?.on("data", (c: Buffer) => { output += c.toString(); });
		child.on("error", (err) => resolve({ ok: false, output: `${output}\nspawn error: ${err.message}` }));
		child.on("close", (code) => resolve({ ok: code === 0, output }));
	});
}

/** Headless --version check through VE's own Electron binary (no node download). */
function defaultVersionCheck(execPath: string, cliPath: string, expected: string, log?: (l: string) => void): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
		for (const key of VERSION_LIE_ENV_VARS) delete env[key];
		const child = spawn(execPath, [cliPath, "--version"], { env, shell: false });
		let output = "";
		const timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
			resolve({ ok: false, output: `${output}\nversion check timed out` });
		}, 30_000);
		child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
		child.stderr?.on("data", (c: Buffer) => { output += c.toString(); });
		child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, output: err.message }); });
		child.on("close", (code) => {
			clearTimeout(timer);
			const actual = output.trim().split("\n").pop()?.trim() ?? "";
			const ok = code === 0 && actual === expected;
			if (!ok) log?.(`[runtime] version check: expected ${expected}, got ${actual || "(empty)"} (exit ${code})`);
			resolve({ ok, output });
		});
	});
}

/** Read the pi version the shipped lockfile pins. */
function lockVersion(lockDir: string): string | null {
	try {
		const pkg = JSON.parse(readFileSync(join(lockDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
		const version = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
		return typeof version === "string" ? version.replace(/^[^0-9]*/, "") : null;
	} catch {
		return null;
	}
}

export async function ensurePiRuntime(opts: EnsureRuntimeOptions): Promise<EnsureRuntimeResult> {
	const { lockDir, targetDir, registries } = opts;
	const log = opts.log ?? ((l: string) => console.log(l));
	const runInstall = opts.runInstall ?? defaultInstall;
	const execPath = process.execPath;
	const runVersionCheck = opts.runVersionCheck ?? ((cli, expected) => defaultVersionCheck(execPath, cli, expected, log));

	const expected = lockVersion(lockDir);
	if (!expected) {
		return { status: "failed", attempted: [], errors: [`lockfile missing or unreadable in ${lockDir}`] };
	}

	const manifestPath = join(targetDir, "runtime.json");
	const cliPath = join(targetDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	const indexPath = join(targetDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");

	// 1. Already installed at the pinned version → verify cheaply and pass.
	if (existsSync(manifestPath) && existsSync(indexPath)) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
			if (manifest.pi === expected && manifest.platform === process.platform) {
				const check = await runVersionCheck(cliPath, expected);
				if (check.ok) return { status: "ready", dir: targetDir, version: expected, source: manifest.source, fresh: false };
				log(`[runtime] installed runtime failed verification — reinstalling`);
			}
		} catch {
			log(`[runtime] manifest unreadable — reinstalling`);
		}
	}

	// 2. Install from the source chain. Each source gets a clean slate: a torn
	// npm ci under registry A must not be "completed" by registry B.
	const attempted: string[] = [];
	const errors: string[] = [];
	for (const registry of registries) {
		attempted.push(registry);
		try {
			rmSync(targetDir, { recursive: true, force: true });
			mkdirSync(targetDir, { recursive: true });
			copyFileSync(join(lockDir, "package.json"), join(targetDir, "package.json"));
			try { copyFileSync(join(lockDir, "package-lock.json"), join(targetDir, "package-lock.json")); } catch { /* lock optional for test fixtures */ }
			const install = await (opts.runInstall ? opts.runInstall!(targetDir, registry) : runInstall(targetDir, registry));
			if (!install.ok) {
				errors.push(`${registry}: install failed: ${install.output.slice(-400)}`);
				continue;
			}
			if (!existsSync(indexPath)) {
				errors.push(`${registry}: install finished but pi entry is missing`);
				continue;
			}
			const check = await runVersionCheck(cliPath, expected);
			if (!check.ok) {
				errors.push(`${registry}: version check failed: ${check.output.slice(-200)}`);
				continue;
			}
			// 3. Atomic manifest — tmp+rename so a crash never leaves a plausible
			// but incomplete runtime.json behind.
			const manifest: RuntimeManifest = { platform: process.platform, arch: process.arch, pi: expected, installedAt: Date.now(), source: registry };
			const tmp = `${manifestPath}.tmp`;
			writeFileSync(tmp, JSON.stringify(manifest, null, 2));
			renameSync(tmp, manifestPath);
			return { status: "ready", dir: targetDir, version: expected, source: registry, fresh: true };
		} catch (err) {
			errors.push(`${registry}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { status: "failed", attempted, errors };
}
