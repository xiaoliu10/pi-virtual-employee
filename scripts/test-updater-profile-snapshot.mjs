/**
 * Update-watchdog profile snapshot: a main process WITHOUT --profile must not
 * automatically count as the default profile.
 *
 * Field defect (10.188.130.144, first visible 2026-09-30, still live 2026-11-04):
 * every watchdog log read `profiles=[Nova,]` (later `[Nova,,Synapse]`) — an
 * EMPTY entry on every single update. A launch through a shortcut or a mangled
 * PowerShell Start-Process strips the --profile flag while the app still
 * redirects userData into profiles/<name>, so wmic shows a main process with no
 * profile argument. The old snapshot treated that as "default", and the
 * watchdog relaunched it bare (`Start-Process $appExe` with no args) — an
 * instance with NO identity, plus a fresh empty entry for the next snapshot.
 *
 * The fix recovers the identity from a CHILD process: Electron children carry
 * `--user-data-dir="...profiles\<name>"`, which is the authoritative identity
 * the app itself uses (electron/main.ts redirects userData there).
 *
 * Fixtures below are REAL wmic `/value` output captured on the box, not a
 * reconstruction — including the quoted exe path and quoted --user-data-dir.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// updater.ts is an Electron main-process module (imports `electron`); tests run
// under plain node, so extract the pure parser the same way other suites in this
// repo bundle a single function out of an otherwise unimportable module.
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = mkdtempSync(join(root, "node_modules/.wmic-probe-"));
process.on("exit", () => { try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ } });
// updater.ts imports `electron` / `electron-updater` at module scope; the parser
// under test uses neither, but the bundle still has to resolve them.
const electronStub = join(outDir, "electron-stub.mjs");
writeFileSync(electronStub, `export const app = { isPackaged: true, getVersion: () => "0.2.0", getPath: () => ${JSON.stringify(outDir)}, quit() {} };\nexport class BrowserWindow {}\n`);
const updaterStub = join(outDir, "electron-updater-stub.mjs");
writeFileSync(updaterStub, `class AutoUpdaterStub { async checkForUpdates() { return {}; } async downloadUpdate() { return []; } quitAndInstall() {} setFeedURL() {} }\nexport const autoUpdater = new AutoUpdaterStub();\nexport default { autoUpdater };\n`);
const bundle = join(outDir, "updater.mjs");
await build({
	stdin: {
		contents: `export { parseRunningProfilesFromWmic } from "./electron/updater.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { electron: electronStub, "electron-updater": updaterStub },
	logLevel: "silent",
});
const { parseRunningProfilesFromWmic } = await import(pathToFileURL(bundle).href);

/** Row builder matching wmic `/value` field order, exactly as captured. */
function row(cmd, pid, ppid) {
	return `CommandLine=${cmd}\r\nParentProcessId=${ppid}\r\nProcessId=${pid}\r\n`;
}
const EXE = `"C:\\Users\\hspcadmin\\AppData\\Local\\Programs\\Pi Virtual Employee\\Pi Virtual Employee.exe"`;
const child = (pid, ppid, profile) => {
	const dir = profile
		? `"C:\\Users\\hspcadmin\\AppData\\Roaming\\pi-virtual-employee\\profiles\\${profile}"`
		: `"C:\\Users\\hspcadmin\\AppData\\Roaming\\pi-virtual-employee"`;
	return row(`${EXE} --type=gpu-process --user-data-dir=${dir} --gpu-preferences=UAAAA --field-trial-handle=1 /prefetch:2`, pid, ppid);
};
const mainWithProfile = (name, pid, ppid = 1000) => row(`${EXE} --profile ${name} `, pid, ppid);
const mainBare = (pid, ppid = 1000) => row(`${EXE} `, pid, ppid);

test("REAL field table: [Nova,,Synapse] becomes [Nova,Orion,Synapse]", () => {
	// Verbatim shape of the 2026-11-04 04:59 snapshot that relaunched the box:
	// Nova and Synapse carried --profile, the middle instance (pid 12336) did not,
	// yet every one of its children pointed at profiles\Orion.
	const text =
		mainWithProfile("Nova", 23944) +
		mainBare(12336) +
		mainWithProfile("Synapse", 25728) +
		child(14768, 12336, "Orion") +
		child(2560, 25728, "Synapse") +
		child(25680, 12336, "Orion") +
		child(24892, 25728, "Synapse") +
		child(23732, 23944, "Nova") +
		child(19288, 23944, "Nova");
	const profiles = parseRunningProfilesFromWmic(text);
	assert.ok(profiles.includes("Orion"), `identity lost: ${JSON.stringify(profiles)}`);
	assert.ok(profiles.includes("Nova") && profiles.includes("Synapse"));
	assert.ok(!profiles.includes(""), `empty entry survives → a bare relaunch: ${JSON.stringify(profiles)}`);
	assert.equal(profiles.length, 3, `expected exactly 3 instances: ${JSON.stringify(profiles)}`);
});

test("WMIC redirected CRCRLF output preserves every running profile", () => {
	// WMIC writes CRCRLF when captured through Node spawnSync on Windows.
	// Splitting only /\r?\n/ leaves a trailing CR in every field: the anchored
	// field regex then matches nothing and the installer restores only itself.
	const table = mainWithProfile("Nova", 1100)
		+ mainWithProfile("Orion", 1200)
		+ mainWithProfile("Synapse", 1300)
		+ child(1101, 1100, "Nova")
		+ child(1201, 1200, "Orion")
		+ child(1301, 1300, "Synapse");
	for (const ending of ["\r\r\n", "\r\n", "\n", "\r"]) {
		const captured = table.replace(/\r\n/g, ending);
		assert.deepEqual(parseRunningProfilesFromWmic(captured).sort(), ["Nova", "Orion", "Synapse"], `line ending ${JSON.stringify(ending)}`);
	}
});

test("WMIC CRCRLF preserves child evidence for a main with stripped profile args", () => {
	const table = mainWithProfile("Nova", 1400) + mainBare(1500)
		+ child(1501, 1500, "Orion") + child(1502, 1500, "Orion");
	assert.deepEqual(parseRunningProfilesFromWmic(table.replace(/\r\n/g, "\r\r\n")).sort(), ["Nova", "Orion"]);
});

test("a REAL default-profile instance still yields the empty entry", () => {
	// Distinguishing "real default" from "named profile with stripped args" is
	// the whole point: a real default's children point at the app root, not at
	// profiles\<name>.
	const text = mainBare(500) + child(501, 500) + mainWithProfile("Nova", 600);
	const profiles = parseRunningProfilesFromWmic(text);
	assert.deepEqual([...profiles].sort(), ["", "Nova"], `got ${JSON.stringify(profiles)}`);
});

test("a bare main process with NO children yet stays conservative", () => {
	// A process that started milliseconds ago may have no children in the table.
	// Guessing would be worse than the old behaviour, so it stays "".
	const profiles = parseRunningProfilesFromWmic(mainBare(700));
	assert.deepEqual(profiles, [""]);
});

test("children are never counted as instances themselves", () => {
	// The 0.2.x field bug `profiles=[b,,a]`: children carry no --profile, so a
	// parser that only filters the exe path invents an empty entry per child.
	const text = mainWithProfile("Nova", 800) + child(801, 800, "Nova") + child(802, 800, "Nova");
	assert.deepEqual(parseRunningProfilesFromWmic(text), ["Nova"]);
});

test("unquoted --user-data-dir and --profile=Name forms are handled", () => {
	const text =
		row(`${EXE} --profile=Orion `, 900) +
		mainBare(901) +
		// No quotes around the directory (Electron only quotes when needed).
		row(`${EXE} --type=utility --user-data-dir=C:\\Users\\x\\AppData\\Roaming\\pi-virtual-employee\\profiles\\Nova --lang=zh-CN`, 902, 901) +
		row(`${EXE} --type=gpu-process --user-data-dir=C:\\Users\\x\\AppData\\Roaming\\pi-virtual-employee\\profiles\\Nova --field-trial-handle=1`, 903, 901);
	assert.deepEqual([...parseRunningProfilesFromWmic(text)].sort(), ["Nova", "Orion"]);
});

test("P1-1: an ORPHANED child whose ppid was reused must NOT confer identity", () => {
	// Independent review: a single child cannot be distinguished from an orphan
	// left behind by a dead named instance whose ppid value now collides with
	// this (real default) main process. Recovering there would relaunch the
	// instance with the WRONG identity and hold the real profile's lock/DB.
	const text = mainBare(300) + child(301, 300, "Orion");
	assert.deepEqual(parseRunningProfilesFromWmic(text), [""], "a single child is not enough evidence");
});

test("P1-1: children DISAGREEING on the profile must NOT confer identity", () => {
	const text = mainBare(310) + child(311, 310, "Orion") + child(312, 310, "Nova");
	assert.deepEqual(parseRunningProfilesFromWmic(text), [""], "conflicting evidence stays conservative");
});

test("P2-2: a differently-cased `Profiles` directory still recovers", () => {
	// Windows paths are case-insensitive; only the app-written spelling differs.
	const text =
		mainBare(320) +
		row(`${EXE} --type=gpu-process --user-data-dir="C:\\Users\\x\\AppData\\Roaming\\pi-virtual-employee\\Profiles\\Orion"`, 321, 320) +
		row(`${EXE} --type=utility --user-data-dir="C:\\Users\\x\\AppData\\Roaming\\pi-virtual-employee\\Profiles\\Orion" --lang=zh-CN`, 322, 320);
	assert.deepEqual(parseRunningProfilesFromWmic(text), ["Orion"]);
});

test("P2-1: a profile value must end at a boundary (no silent truncation)", () => {
	// `--profile a.b` used to parse as "a" — a DIFFERENT legal name rather than
	// a refusal. main.ts only allows [A-Za-z0-9_-], so anything else in the
	// argument means the value is malformed, not a name to truncate into.
	const text = row(`${EXE} --profile a.b `, 330) + child(331, 330, "RealName") + child(332, 330, "RealName");
	assert.deepEqual(parseRunningProfilesFromWmic(text), ["RealName"], "the malformed flag must not truncate into a wrong name");
});

test("an unrelated process row is ignored, and a partial row cannot crash it", () => {
	const text =
		mainWithProfile("Nova", 1000) +
		row(`"C:\\Other\\app.exe" --profile Evil`, 1001) +
		// wmic can be truncated mid-row if a process exits during enumeration.
		`CommandLine=${EXE} --profile Ghost\r\nParentProcessId=1000\r\n`;
	assert.deepEqual(parseRunningProfilesFromWmic(text), ["Nova"]);
});

test("the shipped updater.ts actually uses the parser (wiring)", () => {
	// A parser that is never called fixes nothing. The wiring assertion is
	// positive-shape (the new query must ask for pid/ppid), not a negative scan.
	const src = readFileSync(join(root, "electron/updater.ts"), "utf8");
	const start = src.indexOf("function snapshotRunningProfiles()");
	assert.ok(start > 0);
	const region = src.slice(start, start + 1800);
	assert.match(region, /"commandline,processid,parentprocessid"/, "wmic must fetch pid+ppid, or the parser has no evidence");
	assert.match(region, /parseRunningProfilesFromWmic\(out\.stdout/, "the snapshot must delegate to the tested parser");
});
