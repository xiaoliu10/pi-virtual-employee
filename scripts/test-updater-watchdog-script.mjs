/**
 * Update-watchdog install script contract (0.2.194).
 *
 * Field failure 2026-11-05: upgrading the cloud box 0.2.191 → 0.2.193 recorded
 * FAILED and the app stayed on 0.2.191. Watchdog log:
 *
 *   phase1: app exited; killing stale installers and running the update silently
 *   phase1: rename of old install dir failed (locked?) — installing in place:
 *           对路径"...\Pi Virtual Employee"的访问被拒绝。
 *   phase1: silent install exited code=2
 *   startup: pending install 0.2.191 -> 0.2.193 FAILED (still running 0.2.191)
 *
 * Restart Manager named the holder: the app's OWN process held
 * `resources\app.asar` (all three copies, including two months-old .old-*
 * backups). Cause: phase1 terminated the instance with
 * `Stop-Process -Force`, which kills the MAIN process only — Electron's
 * renderer/gpu/utility children outlive it for a moment and keep the file
 * mapping alive. Two seconds later the rename is refused, so NSIS drops onto
 * the in-place path that exits 2.
 *
 * These tests drive the REAL generated script (no PowerShell execution) and pin
 * the three properties that make the upgrade survive that race.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

const root = process.cwd();
const outDir = mkdtempSync(join(root, "node_modules/.wd-script-"));
process.on("exit", () => { try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ } });

// updater.ts imports electron/electron-updater at module scope; the script
// builder uses neither, but the bundle must still resolve them.
const electronStub = join(outDir, "electron-stub.mjs");
writeFileSync(electronStub, `export const app = { isPackaged: true, getVersion: () => "0.2.0", getPath: () => ${JSON.stringify(outDir)}, quit() {} };\nexport class BrowserWindow {}\n`);
const updaterStub = join(outDir, "electron-updater-stub.mjs");
writeFileSync(updaterStub, `class S { async checkForUpdates() { return {}; } async downloadUpdate() { return []; } quitAndInstall() {} setFeedURL() {} }\nexport const autoUpdater = new S();\nexport default { autoUpdater };\n`);
const bundle = join(outDir, "updater.mjs");
await build({
	stdin: { contents: `export { buildWatchdogScript } from "./electron/updater.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { electron: electronStub, "electron-updater": updaterStub },
	logLevel: "silent",
});
const { buildWatchdogScript } = await import(pathToFileURL(bundle).href);

const script = () => buildWatchdogScript({
	updaterLogPath: "C:\\Users\\u\\AppData\\Roaming\\pi-virtual-employee\\profiles\\Nova\\logs\\updater.log",
	appExe: "C:\\Users\\u\\AppData\\Local\\Programs\\Pi Virtual Employee\\Pi Virtual Employee.exe",
	markerPath: "C:\\Users\\u\\AppData\\Roaming\\pi-virtual-employee\\profiles\\Nova\\update-watchdog\\completed.txt",
	relaunch: "'--profile','Nova'",
	installerCopy: "C:\\Users\\u\\AppData\\Roaming\\pi-virtual-employee\\profiles\\Nova\\update-watchdog\\setup.exe",
	armPid: 4242,
	failureFileName: "update-failures.json",
	watchdogTaskName: "PiVirtualEmployee-Update-Watchdog",
});

test("phase1 kills the PROCESS TREE, not just the main process (the 2026-11-05 root cause)", () => {
	const s = script();
	// The old code was `Get-Process -Name $exeName | Stop-Process -Force`, which
	// leaves Electron's children holding app.asar.
	assert.match(s, /taskkill\.exe \/pid \$killed \/t \/f/, "phase1 must taskkill the tree (/t)");
	// The ORIGINAL one-liner must be gone: it was the only kill, so children
	// survived. (A per-PID Stop-Process fallback AFTER taskkill /t is fine — it
	// only runs when the main process somehow outlived its own tree kill.)
	assert.doesNotMatch(
		s,
		/^Get-Process -Name \$exeName -ErrorAction SilentlyContinue \| Stop-Process -Force$/m,
		"the bare pipeline-as-only-kill must be gone — it orphans renderer children",
	);
	// The kill must be driven per instance so /pid can carry the tree flag.
	assert.match(s, /Get-Process -Name \$exeName -ErrorAction SilentlyContinue \| ForEach-Object \{/, "must iterate instances to tree-kill each");
});

test("phase1 waits for the exe set to DRAIN instead of guessing a fixed sleep", () => {
	const s = script();
	assert.match(s, /\$drain = \(Get-Date\)\.AddSeconds\(15\)/, "must bound a drain wait");
	assert.match(s, /while \(\(Get-Date\) -lt \$drain -and \(Get-Process -Name \$exeName/, "must poll until no instance remains");
});

test("the rename is RETRIED — one transient refusal must not force the wedging in-place path", () => {
	const s = script();
	assert.match(s, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/, "rename must be attempted up to 3 times");
	assert.match(s, /if \(\$attempt -lt 3\) \{ Start-Sleep -Seconds 3 \}/, "attempts must be spaced");
	// The in-place fallback still exists — a genuinely locked dir must not hang.
	assert.match(s, /rename failed after 3 attempts/, "must log the final reason after exhausting retries");
});

test("the script still carries the rest of the install contract (no accidental surgery)", () => {
	const s = script();
	// phase0a: wait for the arming PID, stand down if it never exits.
	assert.match(s, /watchdog phase0a: waiting for app to exit/);
	assert.match(s, /\$armPid = 4242/, "the arming PID must be the one passed in");
	// NSIS silent install + wedge detection + rollback.
	assert.match(s, /Start-Process -FilePath \$installerCopy -ArgumentList '\/S' -PassThru/);
	assert.match(s, /silent install wedged; killing it and bumping failure count/);
	assert.match(s, /rolling back to the renamed old install dir/);
	// Relaunch carries the profile identity (0.2.x field defect).
	assert.match(s, /\$profileLaunch = @\('--profile','Nova'\)/);
	// Failure bookkeeping target.
	assert.match(s, /update-failures\.json/);
});
