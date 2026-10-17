/**
 * The ONLY module in this repo allowed to resolve and load pi-coding-agent at
 * runtime. Everything else goes through the accessors here, so:
 *
 *  - the packaged app carries NO pi dependency tree (the runtime is installed
 *    under userData by src/runtime/bootstrap.ts and loaded via dynamic import);
 *  - development and tests use the devDependency copy via require.resolve;
 *  - test suites can inject a stub without touching the filesystem;
 *  - upstream moving module boundaries is absorbed in exactly one file.
 *
 * Type imports below are `import type` — erased at build, so the bundler never
 * pulls the CLI dependency tree into the app.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import type { AgentSession as PiAgentSession, SessionManager as PiSessionManager, SettingsManager as PiSettingsManager, DefaultResourceLoader as PiDefaultResourceLoader } from "@earendil-works/pi-coding-agent";

/** The subset of the pi-coding-agent module VE actually consumes. */
export interface PiRuntimeModule {
	AgentSession: typeof PiAgentSession;
	SessionManager: typeof PiSessionManager;
	SettingsManager: typeof PiSettingsManager;
	DefaultResourceLoader: typeof PiDefaultResourceLoader;
	/** Distro of the package (diagnostics only). */
	version: string;
}

let runtime: PiRuntimeModule | null = null;
let stub: PiRuntimeModule | null = null;

/** Test seam: inject a stub module (call getPiRuntime after this). */
export function __setPiRuntimeStub(injected: PiRuntimeModule | null): void {
	stub = injected;
}

/**
 * Resolve and load the pi-coding-agent module. Order:
 *  1. explicit dir (userData/pi-runtime installed by the bootstrap)
 *  2. devDependency (@earendil-works/pi-coding-agent) — dev machines and tests
 * Idempotent; concurrent calls share one resolution.
 */
/**
 * Walk node_modules upward from THIS file for the devDependency copy. The
 * package's exports map does not expose ./package.json (require.resolve of
 * the subpath throws) and "." is import-condition-only, so the standard
 * resolver can't give us a file path — a manual walk is the honest answer.
 */
function resolveDevRuntimeEntry(): string | null {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

let initPromise: Promise<PiRuntimeModule> | undefined;
export function initPiRuntime(explicitDir?: string): Promise<PiRuntimeModule> {
	if (runtime) return Promise.resolve(runtime);
	initPromise ??= (async () => {
		const candidates: string[] = [];
		if (explicitDir) candidates.push(join(explicitDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
		const devEntry = resolveDevRuntimeEntry();
		if (devEntry) candidates.push(devEntry);
			for (const candidate of candidates) {
				if (!existsSync(candidate)) continue;
				const mod = (await import(pathToFileURL(candidate).href)) as Partial<PiRuntimeModule> & { VERSION?: string };
				if (typeof mod.AgentSession !== "function" || typeof mod.SessionManager !== "function"
					|| typeof mod.SettingsManager !== "function" || typeof mod.DefaultResourceLoader !== "function") continue;
				const resolved: PiRuntimeModule = {
					AgentSession: mod.AgentSession,
					SessionManager: mod.SessionManager,
					SettingsManager: mod.SettingsManager,
					DefaultResourceLoader: mod.DefaultResourceLoader,
					version: mod.VERSION ?? "unknown",
				};
				runtime = resolved;
				return resolved;
			}
			throw new Error(
				"pi-coding-agent runtime not found. Install it (settings → pi runtime, or general.piRegistryUrl) "
				+ "or switch the kernel back to legacy (general.engineKernel).",
			);
		})();
	initPromise.catch(() => { initPromise = undefined; });
	return initPromise;
}

/** Sync accessor — call only after initPiRuntime resolved (main does it at startup). */
export function getPiRuntime(): PiRuntimeModule {
	if (stub) return stub;
	if (!runtime) throw new Error("pi-coding-agent runtime not initialized — call initPiRuntime() first");
	return runtime;
}

/** True when the resolved runtime is the test stub (suites assert on it). */
export function isPiRuntimeStubbed(): boolean {
	return stub !== null;
}
