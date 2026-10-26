/**
 * Regression: an update check that HANGS (no resolve, no reject, no terminal
 * event) used to leave the `checking` flag true forever, and every later check
 * — the manual button or the 6h schedule — early-returned the frozen 「检查中」
 * state (field 2026-10-26: a 0.2.153 client sat on the stuck button for days
 * while the feed itself was fine). checkNow now races a hard deadline and
 * resets the flag in a finally.
 *
 * The module under test is the REAL electron/updater.ts, bundled with `electron`
 * and `electron-updater` replaced by controllable stubs. Each test builds its
 * OWN module instance (own stub emitter, own harness, own state) so leftover
 * hung promises or armed retry timers from one case cannot pollute another.
 * Timings are injected through env at instance creation; everything runs in
 * well under a second.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Build a fresh updater instance with its own stub autoUpdater + harness. */
async function makeUpdater({ checkTimeoutMs = 300, retryDelayMs = 150 } = {}) {
	const workDir = mkdtempSync(join(root, "node_modules/.update-check-test-"));
	// Per-instance harness key: leftover timers from an older instance must only
	// touch THEIR harness — a shared global harness lets a previous case's armed
	// retry call THIS case's stub and pollute its call counts.
	const harnessKey = JSON.stringify(workDir);
	process.on("exit", () => { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ } });
	const electronStub = join(workDir, "electron-stub.mjs");
	writeFileSync(electronStub, `export const app = { isPackaged: true, getVersion: () => "0.2.153", getPath: () => ${JSON.stringify(workDir)}, quit() {} };\nexport class BrowserWindow {}\n`);
	const updaterStub = join(workDir, "electron-updater-stub.mjs");
	writeFileSync(
		updaterStub,
		`
import { EventEmitter } from "node:events";
class AutoUpdaterStub extends EventEmitter {
	autoDownload = false;
	autoInstallOnAppQuit = false;
	disableWebInstaller = false;
	async checkForUpdates() {
		const h = globalThis.__autoUpdaterHarnesses[${harnessKey}];
		h.calls.push("check");
		return h.check(h);
	}
	async downloadUpdate() {
		const h = globalThis.__autoUpdaterHarnesses[${harnessKey}];
		h.calls.push("download");
		return [];
	}
	quitAndInstall() {}
	setFeedURL() {}
}
const autoUpdater = new AutoUpdaterStub();
globalThis.__autoUpdater = autoUpdater;
export default { autoUpdater };
`,
	);
	const { build } = await import("esbuild"); // dynamic: esbuild resolves its binary by process.platform at call time
	await build({
		stdin: { contents: `export * from "${join(root, "electron/updater.ts")}";`, resolveDir: root, loader: "ts" },
		outfile: join(workDir, "updater.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		alias: { electron: electronStub, "electron-updater": updaterStub },
	});
	// Fake packaged-Windows and inject the test timings AFTER the esbuild call
	// (platform-dependent binary resolution) and BEFORE importing the bundle
	// (the updater reads the timings at module load).
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	const originalTimeoutEnv = process.env.VE_UPDATE_CHECK_TIMEOUT_MS;
	const originalRetryEnv = process.env.VE_UPDATE_RETRY_DELAY_MS;
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	process.env.VE_UPDATE_CHECK_TIMEOUT_MS = String(checkTimeoutMs);
	process.env.VE_UPDATE_RETRY_DELAY_MS = String(retryDelayMs);
	const updater = await import(pathToFileURL(join(workDir, "updater.mjs")).href + `?t=${Math.random()}`);
	updater.initUpdaterEventsForTest();
	const harness = { calls: [], check: () => new Promise(() => {}) };
	globalThis.__autoUpdaterHarnesses ??= {};
	globalThis.__autoUpdaterHarnesses[workDir] = harness;
	const autoUpdater = globalThis.__autoUpdater;
	const settle = (ms) => new Promise((r) => setTimeout(r, ms));
	// Leave the process as we found it: this file relies on node's per-file
	// process isolation today, but a future single-process glob runner must not
	// inherit a faked platform or injected timings.
	process.on("exit", () => {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		if (originalTimeoutEnv === undefined) delete process.env.VE_UPDATE_CHECK_TIMEOUT_MS;
		else process.env.VE_UPDATE_CHECK_TIMEOUT_MS = originalTimeoutEnv;
		if (originalRetryEnv === undefined) delete process.env.VE_UPDATE_RETRY_DELAY_MS;
		else process.env.VE_UPDATE_RETRY_DELAY_MS = originalRetryEnv;
	});
	return { updater, harness, autoUpdater, settle, callsOf: (name) => harness.calls.filter((c) => c === name).length };
}

test("a hung check times out, reports an error, and does NOT wedge the checking flag", async () => {
	const { updater, harness, callsOf } = await makeUpdater();
	harness.check = () => new Promise(() => {}); // never settles, no events
	const s1 = await updater.checkNow();
	assert.equal(s1.phase, "error", "the deadline must convert a silent hang into an error state");
	assert.match(s1.message ?? "", /timeout/, "the message must carry the transient-failure keyword so the bounded retry picks it up");
	// The regression: before the fix, `checking` stayed true and every later
	// check early-returned the frozen state. The follow-up check must actually
	// reach electron-updater again (>=1: armed auto-retries may add calls too).
	const before = callsOf("check");
	await updater.checkNow();
	assert.ok(callsOf("check") >= before + 1, `a follow-up check must not be blocked (before=${before}, after=${callsOf("check")})`);
	assert.equal(updater.getUpdateState().phase, "error");
});

test("a normal check still ends in a terminal phase and leaves the flag clear", async () => {
	const { updater, harness, autoUpdater } = await makeUpdater();
	harness.check = () => {
		queueMicrotask(() => {
			autoUpdater.emit("checking-for-update");
			queueMicrotask(() => autoUpdater.emit("update-not-available"));
		});
		return Promise.resolve();
	};
	const s = await updater.checkNow();
	assert.equal(s.phase, "none", "update-not-available must land on the none phase");
	// And another check right after is allowed (the flag did not stick).
	await updater.checkNow();
	assert.equal(harness.calls.filter((c) => c === "check").length, 2);
});

test("a transient feed failure still arms the bounded auto-retry (2 extra attempts)", async () => {
	const { updater, harness, settle, callsOf } = await makeUpdater();
	const t0 = Date.now();
	const timeline = [];
	harness.check = () => {
		timeline.push(Date.now() - t0);
		return Promise.reject(new Error("HTTP 404: not found"));
	};
	await updater.checkNow();
	await settle(700);
	assert.equal(callsOf("check"), 3, `expected initial + 2 bounded retries, got ${callsOf("check")} at ${JSON.stringify(timeline)}`);
	const s = updater.getUpdateState();
	assert.equal(s.phase, "error");
});

test("a zombie update-available (window closed) records but does NOT auto-download", async () => {
	const { updater, harness, autoUpdater, settle, callsOf } = await makeUpdater();
	// The check hangs past the deadline, then reports an update LATER. Unattended
	// mode is the dangerous case: without the window gate this would start a 97MB
	// download minutes after the user was told the check timed out.
	updater.setupUnattended({ enabled: () => true, isIdle: () => true });
	harness.check = () => new Promise((resolve) => {
		setTimeout(() => {
			autoUpdater.emit("checking-for-update");
			autoUpdater.emit("update-available", { version: "9.9.9" });
			resolve();
		}, 450);
	});
	await updater.checkNow(); // times out at 300ms
	await settle(450); // beyond the zombie at ~450ms
	assert.equal(callsOf("download"), 0, "a closed window must never auto-start a download");
	// The information itself is real and kept (better than hiding it).
	const state = updater.getUpdateState();
	assert.ok(["available", "error"].includes(state.phase), `unexpected phase ${state.phase}`);
	assert.notEqual(state.phase, "checking");
});

test("a zombie check error (window closed) leaves a live download's state intact", async () => {
	const { updater, harness, autoUpdater, settle } = await makeUpdater();
	// Simulate: check times out → a real download is running → the abandoned
	// check finally errors. That late error must not clear download state.
	harness.check = () => new Promise((resolve, reject) => {
		setTimeout(() => reject(new Error("HTTP 500: zombie")), 450);
	});
	await updater.checkNow(); // times out at 300ms → error state
	// Pretend a download is in flight (the state machine's view).
	autoUpdater.emit("download-progress", { percent: 40 });
	const before = updater.getUpdateState();
	assert.equal(before.phase, "downloading", "fixture: a download is in progress");
	await settle(400); // zombie error lands at ~450ms
	assert.equal(updater.getUpdateState().phase, "downloading", "a zombie check error must not clobber the download state");
});

test("a late zombie event cannot resurrect the checking phase", async () => {
	const { updater, harness, autoUpdater, settle } = await makeUpdater();
	// A check that hangs past the deadline, then eventually settles with
	// terminal events: the abandoned call's late events must still produce a
	// self-consistent state, never 「检查中」.
	harness.check = () => new Promise((resolve) => {
		setTimeout(() => {
			autoUpdater.emit("checking-for-update");
			autoUpdater.emit("update-not-available");
			resolve();
		}, 450);
	});
	await updater.checkNow(); // times out at 300ms → error
	await settle(700); // let the zombie settle at ~450ms (2.3x margin, not 1.5x)
	assert.notEqual(updater.getUpdateState().phase, "checking", "no path may leave the renderer stuck on 「检查中」");
});
