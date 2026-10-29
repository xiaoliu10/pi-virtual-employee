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
 * Pinned properties: bounded steps never fail the install, an aborted
 * preparation records no failure, and the pending marker is dropped so the next
 * startup cannot double count.
 *
 * The module under test is the REAL electron/updater.ts, bundled with `electron`
 * and `electron-updater` replaced by stubs (same harness pattern as
 * test-update-check.mjs).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.setMaxListeners(0);

// Must match electron/updater.ts FAILURE_FILE — a wrong name silently reads
// "no failures" and the assertions pass vacuously.
const FAILURE_FILE = "update-failures.json";

/** Fresh updater module instance with its own stub app + harness. */
async function makeUpdater({ prepareTimeoutMs = 120, replyFlushMs = 20, getVersion = () => "0.2.170" } = {}) {
	const workDir = mkdtempSync(join(root, "node_modules/.install-preflight-test-"));
	process.on("exit", () => { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ } });
	const electronStub = join(workDir, "electron-stub.mjs");
	writeFileSync(
		electronStub,
		`export const app = { isPackaged: true, getVersion: () => ${getVersion.toString()}, getPath: () => ${JSON.stringify(workDir)}, quit() {} };\nexport class BrowserWindow {}\n`,
	);
	const updaterStub = join(workDir, "electron-updater-stub.mjs");
	writeFileSync(
		updaterStub,
		`
import { EventEmitter } from "node:events";
class AutoUpdaterStub extends EventEmitter {
	autoDownload = false;
	autoInstallOnAppQuit = false;
	disableWebInstaller = false;
	async checkForUpdates() { return null; }
	async downloadUpdate() { return []; }
	quitAndInstall() {}
	setFeedURL() {}
}
const autoUpdater = new AutoUpdaterStub();
globalThis.__autoUpdaterRef = autoUpdater;
export default { autoUpdater };
`,
	);
	const { build } = await import("esbuild");
	await build({
		stdin: { contents: `export * from "${join(root, "electron/updater.ts")}";`, resolveDir: root, loader: "ts" },
		outfile: join(workDir, "updater.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		alias: { electron: electronStub, "electron-updater": updaterStub },
	});
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	const originalTimeout = process.env.VE_INSTALL_PREPARE_TIMEOUT_MS;
	const originalFlush = process.env.VE_INSTALL_REPLY_FLUSH_MS;
	// enabled() reads process.platform at CALL time, so win32 must stay in place
	// for the whole test (restored explicitly by the caller).
	const restorePlatform = () => {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	};
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	process.env.VE_INSTALL_PREPARE_TIMEOUT_MS = String(prepareTimeoutMs);
	process.env.VE_INSTALL_REPLY_FLUSH_MS = String(replyFlushMs);
	let mod;
	try {
		mod = await import(pathToFileURL(join(workDir, "updater.mjs")).href + `?t=${Math.random()}`);
	} catch (err) {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		throw err;
	} finally {
		if (originalTimeout === undefined) delete process.env.VE_INSTALL_PREPARE_TIMEOUT_MS;
		else process.env.VE_INSTALL_PREPARE_TIMEOUT_MS = originalTimeout;
		if (originalFlush === undefined) delete process.env.VE_INSTALL_REPLY_FLUSH_MS;
		else process.env.VE_INSTALL_REPLY_FLUSH_MS = originalFlush;
	}
	return { mod, workDir, failurePath: join(workDir, FAILURE_FILE), restorePlatform };
}

function readFailures(path) {
	if (!existsSync(path)) return { versions: {}, consecutiveFailures: 0 };
	return JSON.parse(readFileSync(path, "utf8"));
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("bounded cleanup steps: hang → timeout outcome, throw → failed, fast → ok", async () => {
	const { runCleanupStep, CLEANUP_BUDGETS } = await import(pathToFileURL(join(root, "electron/install-cleanup.ts")).href)
		.catch(async () => {
			// Plain .ts is not importable by node; bundle it the same way.
			const dir = mkdtempSync(join(root, "node_modules/.cleanup-step-test-"));
			process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
			const { build } = await import("esbuild");
			await build({
				stdin: { contents: `export * from "${join(root, "electron/install-cleanup.ts")}";`, resolveDir: root, loader: "ts" },
				outfile: join(dir, "cleanup.mjs"),
				bundle: true, platform: "node", format: "esm", packages: "external",
			});
			return import(pathToFileURL(join(dir, "cleanup.mjs")).href);
		});
	const warnings = [];
	const warn = (message, detail) => warnings.push(`${message} ${detail ?? ""}`.trim());
	assert.equal(await runCleanupStep("fast", 200, () => {}, warn), "ok", "a fast step reports ok");
	assert.equal(await runCleanupStep("rejects", 200, async () => { throw new Error("nope"); }, warn), "failed", "a throwing step is contained, never fatal");
	const startedAt = Date.now();
	assert.equal(await runCleanupStep("hangs", 60, () => new Promise(() => {}), warn), "timeout", "a wedged step reports timeout");
	assert.ok(Date.now() - startedAt < 1_000, "a wedged step must not block the caller past its budget");
	assert.ok(warnings.some((w) => w.includes("hangs") && w.includes("continuing")), "a timeout is logged so the next report names the culprit");
	// The outer ceiling must stay above the sum of the per-step budgets, or the
	// starvation this module fixes comes straight back.
	const sum = Object.values(CLEANUP_BUDGETS).reduce((a, b) => a + b, 0);
	assert.ok(sum < 35_000, `per-step budgets sum to ${sum}ms — raise PREPARE_INSTALL_TIMEOUT_MS or trim budgets`);
});
const fakeWindow = { webContents: { send() {}, isDestroyed: () => false } };

test("a cleanup step that hangs is abandoned, not fatal, and the install still proceeds", async (t) => {
	const { mod, workDir, restorePlatform } = await makeUpdater({ prepareTimeoutMs: 100 });
	t.after(restorePlatform);
	// Prepare never settles: the pre-fix code rejected at 10s → 「安装失败」.
	// The installer must still be handed over: exit releases the rest.
	let drained = false;
	mod.setupUnattended({
		enabled: () => true,
		installBlocked: () => false,
		notifyReady: () => {},
		isIdle: () => true,
		beginDrain: () => { drained = true; },
		endDrain: () => { drained = false; },
		prepareToInstall: () => new Promise(() => {}),
	});
	mod.quitAndInstall();
	// 20ms flush + 100ms teardown ceiling + watchdog arm: 300ms is generous.
	await settle(400);
	const failures = readFailures(join(workDir, FAILURE_FILE));
	assert.equal(failures.consecutiveFailures ?? 0, 0, "a slow teardown must never count as an install failure");
	// The handover ran: drain began AND the aborted teardown did not re-open it.
	// (endDrain only runs in the catch, which proceeding past the timeout skips.)
	assert.ok(drained, "install proceeded past the abandoned teardown (still draining)");
});

test("an aborted preparation records no failure and drops the pending marker", async (t) => {
	const { mod, failurePath, restorePlatform } = await makeUpdater({ prepareTimeoutMs: 5_000 });
	t.after(restorePlatform);
	mod.setupUnattended({
		enabled: () => true,
		installBlocked: () => false,
		notifyReady: () => {},
		isIdle: () => true,
		// beginDrain throwing aborts the attempt BEFORE any quit: the only path
		// that can still abandon an install in-process (teardown itself can no
		// longer fail it). Realistic — it is main.ts's IM drain callback.
		beginDrain: () => { throw new Error("drain exploded"); },
		endDrain: () => {},
		prepareToInstall: async () => {},
	});
	mod.quitAndInstall();
	await settle(300);
	const failures = readFailures(failurePath);
	assert.equal(failures.consecutiveFailures ?? 0, 0, "an aborted preparation is not an install failure");
	assert.equal(failures.versions?.["0.2.170"]?.attempts ?? 0, 0, "per-version counter must stay clean");
	assert.equal(failures.pending, undefined, "pending marker must be dropped so startup cannot recount the same abort");
});

test("a real failed install (came back on the old version) still counts exactly once", async (t) => {
	// The counter must stay honest in the other direction: a pending marker that
	// survives to next startup IS a real failed install and must be counted.
	const workDir = mkdtempSync(join(root, "node_modules/.install-preflight-test-"));
	t.after(() => rmSync(workDir, { recursive: true, force: true }));
	writeFileSync(
		join(workDir, FAILURE_FILE),
		JSON.stringify({
			versions: {},
			consecutiveFailures: 0,
			pending: { target: "0.2.172", fromVersion: "0.2.170", at: new Date().toISOString() },
		}),
	);
	const { mod, restorePlatform } = await makeUpdaterWithDataDir(workDir, "0.2.170");
	// setupAutoUpdater arms a non-unref'd interval; without this the runner waits
	// for the event loop forever (that is how a red suite showed up as a 37s
	// "pending promise" instead of a clean assertion failure).
	t.after(() => { try { mod.stopUpdater(); } catch { /* already stopped */ } });
	t.after(restorePlatform);
	// Startup reconciliation runs from setupAutoUpdater (needs a window-shaped
	// object, not a real BrowserWindow). A fake is enough: push() only calls
	// webContents.send when a window exists.
	mod.setupAutoUpdater({ webContents: { send() {}, isDestroyed: () => false } });
	const failures = readFailures(join(workDir, FAILURE_FILE));
	assert.equal(failures.consecutiveFailures, 1, "one real failed install counts once");
	assert.equal(failures.pending, undefined, "marker consumed by reconciliation");
});

/** Same harness, but pointing at an existing userData dir (startup reconciliation). */
async function makeUpdaterWithDataDir(workDir, version) {
	const electronStub = join(workDir, "electron-stub.mjs");
	writeFileSync(
		electronStub,
		`export const app = { isPackaged: true, getVersion: () => ${JSON.stringify(version)}, getPath: () => ${JSON.stringify(workDir)}, quit() {} };\nexport class BrowserWindow {}\n`,
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
	quitAndInstall() {}
	setFeedURL() {}
}
export default { autoUpdater: new AutoUpdaterStub() };
`,
	);
	const { build } = await import("esbuild");
	await build({
		stdin: { contents: `export * from "${join(root, "electron/updater.ts")}";`, resolveDir: root, loader: "ts" },
		outfile: join(workDir, "updater-reconcile.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		alias: { electron: electronStub, "electron-updater": updaterStub },
	});
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	return {
		mod: await import(pathToFileURL(join(workDir, "updater-reconcile.mjs")).href + `?t=${Math.random()}`),
		restorePlatform: () => { if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform); },
	};
}
