/**
 * Regression: 「安装失败：安装前清理超过 10 秒」 → 「已连续 2 次自动安装失败（跨版本）」
 * (field 2026-10-29, box running 0.2.170).
 *
 * Three defects compounded:
 *  1. the teardown ran its steps sequentially under ONE 10s ceiling while the
 *     durable-host close alone was allowed 8s — one slow step starved the rest;
 *  2. the resulting abort was recorded with recordFailure() even though NSIS
 *     never started, inflating the per-version AND machine-wide breakers;
 *  3. the pre-written pending-install marker was left behind, so startup
 *     reconciliation counted the SAME aborted attempt a second time — a single
 *     abort reached the machine breaker threshold of 2 and disabled
 *     auto-install on a perfectly healthy box.
 *
 * Harness notes (both are load-bearing, learned from review):
 *  - `VE_INSTALL_EXIT_GRACE_MS` is raised for every case. The updater's hard-exit
 *    timer calls `process.exit(0)` IN-PROCESS; left at 10s it silently kills the
 *    test runner, turning later failures into a green run.
 *  - a stubbed `app.quit` records the handover, so "the install proceeded" is an
 *    assertion about behaviour, not about a flag we set ourselves.
 *
 * The module under test is the REAL electron/updater.ts, bundled with `electron`
 * and `electron-updater` replaced by stubs (same pattern as test-update-check).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.setMaxListeners(0);

/** Must match electron/updater.ts FAILURE_FILE — a wrong name reads "no
 *  failures" and every assertion below would pass vacuously. */
const FAILURE_FILE = "update-failures.json";

/** Bundles a module under test with the electron stubs, for one test case. */
async function bundleWithStubs({ workDir, version, entry }) {
	const electronStub = join(workDir, "electron-stub.mjs");
	writeFileSync(
		electronStub,
		`export const app = { isPackaged: true, getVersion: () => ${JSON.stringify(version)},
			getPath: () => ${JSON.stringify(workDir)}, quit() { globalThis.__appQuitCalls = (globalThis.__appQuitCalls ?? 0) + 1; } };
		export class BrowserWindow {}\n`,
	);
	const updaterStub = join(workDir, "electron-updater-stub.mjs");
	writeFileSync(
		updaterStub,
		`
import { EventEmitter } from "node:events";
class AutoUpdaterStub extends EventEmitter {
	autoDownload = false; autoInstallOnAppQuit = false; disableWebInstaller = false;
	async checkForUpdates() { return null; }
	async downloadUpdate() { return []; }
	quitAndInstall() { globalThis.__legacyHandovers = (globalThis.__legacyHandovers ?? 0) + 1; }
	setFeedURL() {}
}
export default { autoUpdater: new AutoUpdaterStub() };
`,
	);
	const { build } = await import("esbuild");
	const outfile = join(workDir, `bundle-${Math.random().toString(36).slice(2)}.mjs`);
	await build({
		stdin: { contents: `export * from ${JSON.stringify(entry)};`, resolveDir: root, loader: "ts" },
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		alias: { electron: electronStub, "electron-updater": updaterStub },
	});
	return import(pathToFileURL(outfile).href);
}

/** Fresh updater instance with its own userData dir and timing overrides. */
async function makeUpdater({ prepareTimeoutMs = 120, replyFlushMs = 20, getVersion = () => "0.2.170" } = {}) {
	const workDir = mkdtempSync(join(root, "node_modules/.install-preflight-test-"));
	const env = {
		VE_INSTALL_PREPARE_TIMEOUT_MS: String(prepareTimeoutMs),
		VE_INSTALL_REPLY_FLUSH_MS: String(replyFlushMs),
		// Far above the hard-exit timer: an in-process process.exit(0) would kill
		// the runner and silently "pass" every later case (review P1-1).
		VE_INSTALL_EXIT_GRACE_MS: "600000",
		// Reclaim window for the legacy fallback (electron-updater's install()
		// swallows errors without quitting). Short here so the reclaimer is
		// observable inside the test.
		VE_INSTALL_LEGACY_RECOVERY_MS: "150",
	};
	const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	globalThis.__appQuitCalls = 0;
	globalThis.__legacyHandovers = 0;
	let mod;
	try {
		mod = await bundleWithStubs({
			workDir,
			version: getVersion(),
			entry: join(root, "electron/updater.ts"),
		});
	} catch (err) {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		throw err;
	}
	const cleanup = () => {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try { mod.stopUpdater(); } catch { /* stopUpdater lives here so the non-unref'd idle interval cannot hold the runner */ }
		rmSync(workDir, { recursive: true, force: true });
	};
	return { mod, workDir, failurePath: join(workDir, FAILURE_FILE), cleanup };
}

function readFailures(path) {
	if (!existsSync(path)) return { versions: {}, consecutiveFailures: 0 };
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Every recorded attempt count, regardless of key: the pre-fix code keyed
 *  failures by TARGET version while the old assertions looked up the CURRENT
 *  one, so the check was vacuous (review P2-1). */
function totalAttempts(failures) {
	return Object.values(failures.versions ?? {}).reduce((sum, record) => sum + (record?.attempts ?? 0), 0);
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the teardown sequence is bounded per step, ordered, and cannot fail the install", async () => {
	const workDir = mkdtempSync(join(root, "node_modules/.install-cleanup-test-"));
	try {
		const [cleanupMod, updaterMod] = await Promise.all([
			bundleWithStubs({ workDir, version: "0.2.172", entry: join(root, "electron/install-cleanup.ts") }),
			bundleWithStubs({ workDir, version: "0.2.172", entry: join(root, "electron/updater.ts") }),
		]);
		const { CLEANUP_BUDGETS, installTeardownSteps, runCleanupStep, runInstallTeardown } = cleanupMod;
		// The ceiling comes from the module that actually enforces it, so changing
		// one side without the other cannot pass (review P2-2).
		const PREPARE_CEILING_FOR_TEST = updaterMod.PREPARE_INSTALL_TIMEOUT_MS;
		assert.ok(Number.isFinite(PREPARE_CEILING_FOR_TEST), "the updater must export its prepare ceiling for this invariant");
		const order = [];
		const warnings = [];
		const warn = (message, detail) => warnings.push(`${message} ${detail ?? ""}`.trim());

		// A wedged step must report timeout, not hang, and not stop the rest.
		const startedAt = Date.now();
		const hung = await runCleanupStep("hangs", 60, () => new Promise(() => {}), warn);
		assert.equal(hung, "timeout", "a wedged step reports timeout");
		assert.ok(Date.now() - startedAt < 1_000, "a wedged step must not block past its budget");
		assert.equal(await runCleanupStep("rejects", 200, async () => { throw new Error("nope"); }, warn), "failed", "a throwing step is contained");
		assert.equal(await runCleanupStep("fast", 200, () => { order.push("fast"); }, warn), "ok", "a fast step reports ok");

		// The whole teardown: one wedged closer must not skip the ones after it.
		const deps = {
			stopWork: () => { order.push("stopWork"); },
			closeDurable: () => new Promise(() => {}),
			stopScheduler: () => { order.push("stopScheduler"); },
			disposeShell: () => { order.push("disposeShell"); },
			stopIm: () => { order.push("stopIm"); },
			closeBrowser: () => { throw new Error("browser already gone"); },
			closeComputer: () => { order.push("closeComputer"); },
			closeHttp: () => { order.push("closeHttp"); },
		};
		const declared = installTeardownSteps(deps);
		const result = await runInstallTeardown(deps, warn);
		assert.deepEqual(
			order.filter((n) => n !== "fast"),
			["stopWork", "stopScheduler", "disposeShell", "stopIm", "closeComputer", "closeHttp"],
			"every step runs, in declared order, even after a timeout and a throw",
		);
		assert.equal(result.outcomes["browser close"], "failed", "a throwing closer is reported, not propagated");
		assert.equal(result.outcomes["durable host close"], "timeout", "the wedged closer is reported as timeout");
		assert.ok(result.elapsedMs < 15_000, `teardown took ${result.elapsedMs}ms — per-step budgets must bound the whole run`);

		// The invariant that actually prevents starvation: the outer ceiling must
		// exceed the sum of the step budgets. Both sides come from the real
		// modules, so changing either one without the other fails here
		// (review P2-2: the old assertion hardcoded 35_000 and could not notice).
		const sum = Object.values(CLEANUP_BUDGETS).reduce((a, b) => a + b, 0);
		assert.ok(PREPARE_CEILING_FOR_TEST > sum, `outer ceiling ${PREPARE_CEILING_FOR_TEST}ms must exceed the step-budget sum ${sum}ms`);
		// And the declarations must agree with the budgets (a step silently given a
		// different budget than CLEANUP_BUDGETS documents is the same defect).
		for (const step of declared.steps) {
			const budget = CLEANUP_BUDGETS[{ "stop work windows": "stopWork", "durable host close": "durableClose", "im stopAll": "imStopAll", "browser close": "browserClose", "computer close": "computerClose", "http server close": "httpClose" }[step.name]];
			assert.equal(step.budgetMs, budget, `${step.name} uses its declared budget`);
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("a wedged teardown still hands the install over, records no failure, and drops the pending marker", async (t) => {
	const { mod, failurePath, cleanup } = await makeUpdater({ prepareTimeoutMs: 100 });
	t.after(cleanup);
	let draining = false;
	mod.setupUnattended({
		enabled: () => true,
		installBlocked: () => false,
		notifyReady: () => {},
		isIdle: () => true,
		beginDrain: () => { draining = true; },
		endDrain: () => { draining = false; },
		// Never settles: the pre-fix code rejected at its ceiling and aborted.
		prepareToInstall: () => new Promise(() => {}),
	});
	mod.quitAndInstall();
	// Tie the wait to the injected ceiling instead of a magic number: the
	// timeout must actually fire before we judge the outcome.
	await settle(100 + 250);
	const failures = readFailures(failurePath);
	assert.equal(totalAttempts(failures), 0, "a slow teardown must never be recorded as an install failure");
	assert.equal(failures.consecutiveFailures ?? 0, 0, "the machine streak must stay clean");
	assert.equal(failures.pending, undefined, "the attempt never reached the installer, so no marker may survive to be recounted");
	// The watchdog is stubbed to "failed" here, so the handover goes through the
	// legacy fallback; that stub records the attempt (app.quit is only called on
	// the watchdog path).
	assert.ok((globalThis.__legacyHandovers ?? 0) >= 1 || (globalThis.__appQuitCalls ?? 0) >= 1, "the install was actually handed over");
	// electron-updater's install() swallowed its error without quitting → the
	// reclaimer must reclaim the app AND drop the phantom marker (review P2-3).
	await settle(200);
	assert.equal(readFailures(failurePath).pending, undefined, "a handover that never quit is reclaimed, not left as a phantom failure");
	assert.equal(draining, false, "the reclaimer turns the drain back off so the robot answers again");
});

test("a rejected teardown still installs", async (t) => {
	const { mod, failurePath, cleanup } = await makeUpdater({ prepareTimeoutMs: 5_000 });
	t.after(cleanup);
	mod.setupUnattended({
		enabled: () => true,
		installBlocked: () => false,
		notifyReady: () => {},
		isIdle: () => true,
		beginDrain: () => {},
		endDrain: () => {},
		prepareToInstall: async () => { throw new Error("teardown exploded"); },
	});
	mod.quitAndInstall();
	await settle(400);
	const failures = readFailures(failurePath);
	assert.equal(totalAttempts(failures), 0, "a failed teardown is not a failed install");
	assert.ok((globalThis.__legacyHandovers ?? 0) >= 1 || (globalThis.__appQuitCalls ?? 0) >= 1, "the install proceeded despite the teardown error");
});

test("an attempt aborted BEFORE any handover is not counted, and the marker is dropped", async (t) => {
	const { mod, failurePath, cleanup } = await makeUpdater({ prepareTimeoutMs: 5_000 });
	t.after(cleanup);
	mod.setupUnattended({
		enabled: () => true,
		installBlocked: () => false,
		notifyReady: () => {},
		isIdle: () => true,
		// beginDrain throwing aborts the attempt in-process, before any quit or
		// watchdog arm: the one remaining path where a pending marker could be
		// orphaned (teardown itself can no longer fail the install).
		beginDrain: () => { throw new Error("drain exploded"); },
		endDrain: () => {},
		prepareToInstall: async () => {},
	});
	mod.quitAndInstall();
	await settle(400);
	const failures = readFailures(failurePath);
	assert.equal(totalAttempts(failures), 0, "an aborted preparation is not an install failure");
	assert.equal(failures.consecutiveFailures ?? 0, 0, "the machine streak must stay clean");
	assert.equal(failures.pending, undefined, "no marker may survive to be recounted at startup");
	assert.equal(globalThis.__appQuitCalls ?? 0, 0, "nothing was handed over");
});

test("an abort AFTER the watchdog took ownership keeps the marker (a real attempt must be counted)", async (t) => {
	// The arm-success + app.quit-throws path cannot be driven through the stub
	// harness, so the rule itself is pinned: dropping the marker while a watchdog
	// owns the attempt would lose that failure and leave the breaker blind
	// (subagent review P1-3).
	const workDir = mkdtempSync(join(root, "node_modules/.install-pending-rule-test-"));
	const failurePath = join(workDir, FAILURE_FILE);
	writeFileSync(failurePath, JSON.stringify({
		versions: {},
		consecutiveFailures: 0,
		pending: { target: "0.2.172", fromVersion: "0.2.170", at: new Date().toISOString() },
	}));
	let mod;
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	try {
		mod = await bundleWithStubs({ workDir, version: "0.2.170", entry: join(root, "electron/updater.ts") });
	} finally {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	}
	t.after(() => { try { mod.stopUpdater(); } catch { /* ignore */ } rmSync(workDir, { recursive: true, force: true }); });

	assert.equal(mod.dropPendingMarkerForAbort(true), false, "an armed handover must NOT drop the marker");
	assert.ok(readFailures(failurePath).pending, "the marker survives, so startup reconciliation counts the real attempt");
	assert.equal(mod.dropPendingMarkerForAbort(false), true, "an unhanded abort DOES drop the marker");
	assert.equal(readFailures(failurePath).pending, undefined, "no double count for an attempt that never reached the installer");
});

test("a real failed install (came back on the old version) still counts exactly once", async (t) => {
	// The counter must stay honest in the other direction: a pending marker that
	// survives to next startup IS a real failed install and must be counted —
	// including when the watchdog owned the attempt (app.quit threw after arm).
	const workDir = mkdtempSync(join(root, "node_modules/.install-reconcile-test-"));
	writeFileSync(
		join(workDir, FAILURE_FILE),
		JSON.stringify({
			versions: {},
			consecutiveFailures: 0,
			pending: { target: "0.2.172", fromVersion: "0.2.170", at: new Date().toISOString() },
		}),
	);
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	const mod = await bundleWithStubs({ workDir, version: "0.2.170", entry: join(root, "electron/updater.ts") });
	t.after(() => {
		// Restored AFTER setupAutoUpdater: enabled() reads platform at call time.
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		try { mod.stopUpdater(); } catch { /* ignore */ }
		rmSync(workDir, { recursive: true, force: true });
	});
	// Startup reconciliation runs from setupAutoUpdater; a window-shaped object
	// is enough (push() only calls webContents.send when a window exists).
	mod.setupAutoUpdater({ webContents: { send() {}, isDestroyed: () => false } });
	const failures = readFailures(join(workDir, FAILURE_FILE));
	assert.equal(failures.consecutiveFailures, 1, "one real failed install counts once");
	assert.equal(totalAttempts(failures), 1, "and exactly once in the per-version map");
	assert.equal(failures.pending, undefined, "marker consumed by reconciliation");
});
