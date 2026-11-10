/**
 * Process-hygiene built-ins (feat: scan/kill_pid two-step kill + dangerous-
 * cleanup execution gate; 2026-11-10 kill_pw_chrome.ps1 incident).
 *
 * Pins:
 *  - verdictFor hold-check ORDER and short-circuit (debug channel → parent
 *    alive → age unknown → young → contract → CANDIDATE);
 *  - ticket lifecycle: expiry, pid-not-in-ticket, TOCTOU re-judge refusals;
 *  - detectDangerousKill: the incident shape (ms-playwright + kill loop),
 *    by-name killers, and the taskkill /pid exemption — no false positives on
 *    innocent text containing "skill"/"kill";
 *  - platform scanners: Linux via an injected mock /proc dir, Windows via
 *    fixture CIM output (parse + DMTF dates);
 *  - contract register→scan SKIP→remove→CANDIDATE round-trip;
 *  - the run_command/run_script gate intercepts incident-shaped script files
 *    while a benign command still runs.
 *
 * Run with `node --test scripts/test-process-hygiene.mjs`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Bundle lands inside the repo so `packages: "external"` can resolve workspace deps.
const workDir = await mkdtemp(join(root, "node_modules/.hygiene-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { ConfigStore } from "./src/db/config-store.ts";
			export { createRunCommandTool, createManageProcessTool, disposeShellCommands } from "./src/engine/tools/shell.ts";
			export { guardTool } from "./src/engine/definition.ts";
			export { SCRIPT_EXTENSIONS } from "./src/engine/tools/run-script.ts";
			export {
				verdictFor, detectDangerousKill, matchesPattern, hasDebugChannel, processNameOf,
				parseProcessStartTime, parseWin32CimProcessList, scanLinuxProcesses, parentAliveOn,
				handleProcessHygieneAction, gateDangerousKillForCommand, extractScriptPaths,
				TICKET_TTL_MS,
			} from "./src/engine/tools/process-hygiene.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(workDir, "hygiene.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const {
	ConfigStore, createRunCommandTool, createManageProcessTool, disposeShellCommands,
	guardTool, SCRIPT_EXTENSIONS,
	verdictFor, detectDangerousKill, matchesPattern, hasDebugChannel, processNameOf,
	parseProcessStartTime, parseWin32CimProcessList, scanLinuxProcesses, parentAliveOn,
	handleProcessHygieneAction, gateDangerousKillForCommand, extractScriptPaths,
	TICKET_TTL_MS,
} = await import(pathToFileURL(join(workDir, "hygiene.mjs")).href);

const MINUTE = 60_000;

// ── verdictFor: order + short-circuit ────────────────────────────────────────

test("verdict: pipe debug channel is a SKIP even when old, parentless and unregistered", () => {
	const v = verdictFor({ debug_channel: true, parent_alive: false, age_min: 999, contract_registered: false, min_age_min: 10 });
	assert.equal(v.verdict, "SKIP");
	assert.match(v.reason, /调试通道/);
});

test("verdict order: debug channel wins over contract and age", () => {
	const v = verdictFor({ debug_channel: true, parent_alive: true, age_min: 0, contract_registered: true, min_age_min: 10 });
	assert.equal(v.verdict, "SKIP");
	assert.match(v.reason, /调试通道/, "the authority order must short-circuit at debug channel");
});

test("verdict: parent alive is a SKIP and outranks the contract check", () => {
	const parentOnly = verdictFor({ debug_channel: false, parent_alive: true, age_min: 999, contract_registered: false, min_age_min: 10 });
	assert.equal(parentOnly.verdict, "SKIP");
	assert.match(parentOnly.reason, /父进程存活/);
	const parentAndContract = verdictFor({ debug_channel: false, parent_alive: true, age_min: 999, contract_registered: true, min_age_min: 10 });
	assert.match(parentAndContract.reason, /父进程存活/, "parent alive must short-circuit before the contract check");
});

test("verdict: age unknown is a SKIP — never drifts toward kill", () => {
	const v = verdictFor({ debug_channel: false, parent_alive: false, age_min: null, contract_registered: false, min_age_min: 10 });
	assert.equal(v.verdict, "SKIP");
	assert.match(v.reason, /年龄未知|不可读/);
});

test("verdict: young process is a SKIP with the age in the reason", () => {
	const v = verdictFor({ debug_channel: false, parent_alive: false, age_min: 3.2, contract_registered: false, min_age_min: 10 });
	assert.equal(v.verdict, "SKIP");
	assert.match(v.reason, /启动仅/);
	assert.match(v.reason, /10/);
});

test("verdict: contract-registered old orphan is a SKIP", () => {
	const v = verdictFor({ debug_channel: false, parent_alive: false, age_min: 600, contract_registered: true, min_age_min: 10 });
	assert.equal(v.verdict, "SKIP");
	assert.match(v.reason, /契约/);
});

test("verdict: old orphan with no holds is a CANDIDATE", () => {
	const v = verdictFor({ debug_channel: false, parent_alive: false, age_min: 35, contract_registered: false, min_age_min: 10 });
	assert.deepEqual(v, { verdict: "CANDIDATE", reason: "疑似残留" });
});

// ── pattern matching / debug channel / names ─────────────────────────────────

test("matchesPattern: chrome* wildcard covers chrome AND chrome-headless-shell, not node", () => {
	const chrome = { exe_path: "C:\\x\\ms-playwright\\chrome.exe", command_line: "chrome --x" };
	const shell = { exe_path: "/root/ms-playwright/chrome-headless-shell", command_line: "" };
	const node = { exe_path: "/usr/bin/node", command_line: "node server.js" };
	assert.equal(matchesPattern("chrome*", chrome), true);
	assert.equal(matchesPattern("chrome*", shell), true);
	assert.equal(matchesPattern("chrome*", node), false);
});

test("matchesPattern: non-wildcard is a substring over name/path/cmdline (case-insensitive)", () => {
	assert.equal(matchesPattern("ms-playwright", { exe_path: "C:\\X\\MS-Playwright\\chrome.exe", command_line: "" }), true);
	assert.equal(matchesPattern("spay_do_login", { exe_path: null, command_line: "python spay_do_login.py --x" }), true);
	assert.equal(matchesPattern("nomatch", { exe_path: "/a/b", command_line: "c" }), false);
});

test("hasDebugChannel matches port AND pipe (pipe is Playwright's default)", () => {
	assert.equal(hasDebugChannel("chrome --remote-debugging-pipe"), true);
	assert.equal(hasDebugChannel("chrome --remote-debugging-port=9222"), true);
	assert.equal(hasDebugChannel("chrome --headless"), false);
});

test("processNameOf falls back to the command line when exe is unreadable", () => {
	assert.equal(processNameOf({ exe_path: "/a/b/chrome-headless-shell", command_line: "" }), "chrome-headless-shell");
	assert.equal(processNameOf({ exe_path: null, command_line: "C:\\x\\chrome.exe --flag" }), "chrome.exe");
});

// ── detectDangerousKill: incident shapes vs innocent text ───────────────────

const INCIDENT_PS1 = `
$procs = Get-Process chrome -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    if ($p.Path -like '*ms-playwright*') { $p.Kill() }
}
`;

test("detectDangerousKill: the incident script (ms-playwright + Kill loop) is refused with why + how", () => {
	const reason = detectDangerousKill(INCIDENT_PS1);
	assert.ok(reason, "the incident shape must be refused");
	assert.match(reason, /2026-11-10/, "refusal must cite the incident (why)");
	assert.match(reason, /scan/, "refusal must point at the tool path (how)");
	assert.match(reason, /kill_pid/);
});

test("detectDangerousKill: chrome-headless-shell + Stop-Process is refused", () => {
	const reason = detectDangerousKill("Get-ChildItem chrome-headless-shell | Stop-Process");
	assert.ok(reason);
});

test("detectDangerousKill: by-name killers refused without any marker", () => {
	for (const cmd of [
		"killall chrome",
		"pkill chrome",
		"pkill -9 chrome",
		"pkill -f ms-playwright",
		"powershell -Command \"Stop-Process -Name chrome\"",
		"Get-Process chrome | Stop-Process",
		"Get-Process chrome | % { $_.Kill() }",
		"Get-Process chrome | ForEach-Object { $PSItem.Kill() }",
		"taskkill /im chrome.exe",
		"taskkill /F /IM chrome.exe",
		"taskkill /pid 5 /t",
	]) {
		const reason = detectDangerousKill(cmd);
		assert.ok(reason, `expected refusal for: ${cmd}`);
		assert.match(reason, /scan/);
	}
});

test("detectDangerousKill: refusal text carries the read-only-diagnostic guidance (P2-3 误伤面声明式取舍)", () => {
	const reason = detectDangerousKill("dir ms-playwright && schtasks /query | findstr taskkill");
	assert.ok(reason, "read-only diagnostics mentioning a killer stay blocked (precision-first)");
	assert.match(reason, /只读排查/);
	assert.match(reason, /taskkill \/pid/);
});

test("extractScriptPaths covers every run_script runtime incl. .js/.mjs/.cjs, and never mistakes .json (P2-3)", () => {
	for (const ext of SCRIPT_EXTENSIONS) {
		assert.ok(extractScriptPaths(`run f${ext}`).includes(`f${ext}`), `bare token f${ext} must be found`);
		assert.deepEqual(extractScriptPaths(`run "dir with spaces/f${ext}"`), [`dir with spaces/f${ext}`], `quoted f${ext} must be found`);
	}
	assert.deepEqual(extractScriptPaths("python job.py --params-file p.json").filter((p) => p.endsWith(".json")), [], "params.json must NOT be read as a .js script");
});

test("extractScriptPaths supports single-quoted paths (P3-1)", () => {
	assert.deepEqual(extractScriptPaths("bash '/tmp/a b/killer.sh'"), ["/tmp/a b/killer.sh"]);
	const reason = gateDangerousKillForCommand("bash '/tmp/a b/killer.sh'", {
		readFile: (p) => (p === "/tmp/a b/killer.sh" ? "killall chrome\n" : null),
	});
	assert.ok(reason, "single-quoted script content must be scanned, not silently skipped");
});

test("detectDangerousKill: explicit taskkill /pid <n> (no /im, no /t) is exempt", () => {
	assert.equal(detectDangerousKill("taskkill /pid 19060"), null);
	assert.equal(detectDangerousKill("taskkill /pid 19060 /f"), null);
	assert.equal(detectDangerousKill("taskkill /PID 19060 /F"), null, "case-insensitive exemption");
});

test("detectDangerousKill: exemption only covers the /pid form — mixed /im still refused", () => {
	assert.ok(detectDangerousKill("taskkill /pid 5 /im chrome.exe"));
});

test("detectDangerousKill: innocent text is not harmed (skill / kill as words, marker-only content)", () => {
	assert.equal(detectDangerousKill("这个 skill 计划包含 kill 流程说明"), null, "no marker, no by-name killer");
	assert.equal(detectDangerousKill("skill"), null);
	assert.equal(
		detectDangerousKill("report the browser path: C:\\Users\\me\\AppData\\Local\\ms-playwright\\chrome.exe"),
		null,
		"marker without any kill primitive is a read, not a kill",
	);
	assert.equal(
		detectDangerousKill("taskkill /pid 4242 # cleanup helper next to ms-playwright path mentions"),
		null,
		"targeted /pid kill next to playwright content stays allowed",
	);
});

test("detectDangerousKill: python os.kill shape is caught as a kill primitive", () => {
	const py = `
import glob, os
for d in glob.glob(os.path.expanduser("~/x/ms-playwright/*")):
    os.kill(int(open(d + "/pidfile").read()), 9)
`;
	assert.ok(detectDangerousKill(py));
});

// ── extractScriptPaths + the full gate ───────────────────────────────────────

test("extractScriptPaths finds quoted and bare script tokens", () => {
	const paths = extractScriptPaths('powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\a b\\kill.ps1" -ParamsFile "x.json"');
	assert.deepEqual(paths, ["C:\\a b\\kill.ps1"]);
	assert.deepEqual(extractScriptPaths("python job.py --params-file p.json"), ["job.py", "p.json"].filter((p) => p.endsWith(".py")));
});

test("gate scans the CONTENT of the referenced script file (the real incident shape)", () => {
	const cleanCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\scripts\\clean.ps1";
	const reason = gateDangerousKillForCommand(cleanCommand, {
		readFile: (p) => (p.endsWith("clean.ps1") ? INCIDENT_PS1 : null),
	});
	assert.ok(reason, "a kill loop hidden inside the .ps1 must be caught even though the command line is clean");
	assert.match(reason, /clean\.ps1/, "the refusal should name the offending file");
	assert.equal(gateDangerousKillForCommand(cleanCommand, { readFile: () => "Write-Host ok" }), null);
});

test("gate resolves relative script paths against workingDir", () => {
	const reason = gateDangerousKillForCommand("sh clean.sh", {
		workingDir: "/opt/ve",
		readFile: (p) => (p === "/opt/ve/clean.sh" ? "killall chrome\n" : null),
	});
	assert.ok(reason);
	assert.equal(gateDangerousKillForCommand("sh clean.sh", { workingDir: "/opt/ve", readFile: () => null }), null, "unreadable → skip (宁漏勿误伤)");
});

// ── Windows parse fixtures ───────────────────────────────────────────────────

test("parseProcessStartTime: PS 5.1 /Date(epochMs)/ is FIRST priority (the System32 powershell reality)", () => {
	assert.equal(parseProcessStartTime("/Date(1794217736983)/"), 1794217736983);
	assert.equal(parseProcessStartTime("\\/Date(1794217736983)\\/"), 1794217736983, "double-escaped JSON survives");
	assert.equal(parseProcessStartTime("/Date(1794217736983+0800)/"), 1794217736983, "serialization offset is metadata; the number is already epoch ms");
});

const ISO_EXPECTED = Date.UTC(2026, 10, 9, 22, 50, 53, 745) - 8 * 3600_000;
test("parseProcessStartTime: PS7 ISO-8601 → epoch ms", () => {
	assert.equal(parseProcessStartTime("2026-11-09T22:50:53.745805+08:00"), ISO_EXPECTED);
	assert.equal(parseProcessStartTime("2026-11-09T14:50:53.745Z"), Date.UTC(2026, 10, 9, 14, 50, 53, 745));
});

test("parseProcessStartTime: DMTF compact with offset → epoch ms", () => {
	const ms = parseProcessStartTime("20261109080000.123456+480");
	assert.equal(ms, Date.UTC(2026, 10, 9, 8, 0, 0) - 480 * MINUTE);
	const neg = parseProcessStartTime("20261109030000.000000-300");
	assert.equal(neg, Date.UTC(2026, 10, 9, 3, 0, 0) + 300 * MINUTE);
});

test("parseProcessStartTime: garbage → null (drifts to 年龄未知 SKIP, never toward kill)", () => {
	assert.equal(parseProcessStartTime(null), null);
	assert.equal(parseProcessStartTime(""), null);
	assert.equal(parseProcessStartTime("not-a-date"), null);
});

test("parseWin32CimProcessList: array form, single-object form, empty output, all three date formats", () => {
	const arr = JSON.stringify([
		{ ProcessId: 4242, ParentProcessId: 88, CommandLine: "chrome --remote-debugging-pipe", ExecutablePath: "C:\\x\\ms-playwright\\chrome.exe", CreationDate: "\\/Date(1794217736983)\\/" },
		{ ProcessId: 5, ParentProcessId: 0, CommandLine: null, ExecutablePath: null, CreationDate: "bogus" },
	]);
	const rows = parseWin32CimProcessList(arr);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].pid, 4242);
	assert.equal(rows[0].ppid, 88);
	assert.equal(rows[0].started_at_ms, 1794217736983, "PS 5.1 \/Date()\/ is the primary deployment format");
	assert.equal(rows[1].ppid, null, "ppid 0 → null");
	assert.equal(rows[1].command_line, "");
	assert.equal(rows[1].started_at_ms, null);

	const iso = parseWin32CimProcessList(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, CommandLine: "a", ExecutablePath: "b", CreationDate: "2026-11-09T22:50:53.745805+08:00" }));
	assert.equal(iso.length, 1, "ConvertTo-Json unwraps 1-element arrays");
	assert.equal(iso[0].started_at_ms, ISO_EXPECTED, "PS7 ISO-8601 parses");

	const dmtf = parseWin32CimProcessList(JSON.stringify({ ProcessId: 9, ParentProcessId: 1, CommandLine: "a", ExecutablePath: "b", CreationDate: "20261109080000.000000+480" }));
	assert.equal(dmtf[0].started_at_ms, Date.UTC(2026, 10, 9, 8, 0, 0) - 480 * MINUTE, "raw DMTF parses");

	assert.deepEqual(parseWin32CimProcessList("   "), [], "no output → no processes");
	assert.throws(() => parseWin32CimProcessList("{broken"), "bad JSON must throw (caller refuses honestly)");
});

// ── Linux scan via an injected mock /proc dir ────────────────────────────────

let procDir;

function writeProcProc(pid, opts) {
	const dir = join(procDir, String(pid));
	mkdirSync(dir, { recursive: true });
	if (opts.exe) {
		try { symlinkSync(opts.exe, join(dir, "exe")); } catch { /* platform may not allow */ }
	}
	writeFileSync(join(dir, "cmdline"), opts.cmdline.split(" ").join("\0"));
	const ppid = opts.ppid ?? 1;
	const comm = "chrome";
	writeFileSync(join(dir, "stat"), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304`);
	const ageMs = opts.ageMin === undefined ? 60 * MINUTE : opts.ageMin * MINUTE;
	const t = new Date(Date.now() - ageMs);
	utimesSync(dir, t, t);
}

before(() => {
	procDir = mkdtempSync(join(tmpdir(), "pve-hygiene-proc-"));
	// POSIX 孤儿被 init/subreaper 收养（ppid 重挂到 1）——这是 Linux 现实语义
	// （review 05421c05 P2-2：旧 mock 用 ppid 9999 是把 Windows 语义错编进 Linux 路径）。
	// 101: old adopted orphan playwright chrome → CANDIDATE (ppid=1 means DEAD parent)
	writeProcProc(101, { exe: "/root/.cache/ms-playwright/chrome-123/chrome", cmdline: "chrome --type=renderer", ppid: 1, ageMin: 35 });
	// 102: pipe debug channel → SKIP even though old and parentless
	writeProcProc(102, { exe: "/root/.cache/ms-playwright/chrome-123/chrome", cmdline: "chrome --remote-debugging-pipe", ppid: 1, ageMin: 200 });
	// 103: parent 101 is alive in the snapshot → SKIP
	writeProcProc(103, { exe: "/root/.cache/ms-playwright/chrome-123/chrome", cmdline: "chrome --type=gpu", ppid: 101, ageMin: 200 });
	// 104: young adopted orphan → SKIP 启动仅 N 分钟
	writeProcProc(104, { exe: "/root/.cache/ms-playwright/chrome-123/chrome", cmdline: "chrome --x", ppid: 1, ageMin: 2 });
	// 105: does not match chrome* → filtered out
	writeProcProc(105, { exe: "/usr/bin/node", cmdline: "node server.js", ppid: 1, ageMin: 200 });
	// 106: ppid points to a pid ABSENT from the snapshot (subreaper died without
	// re-parenting visible) → dead parent on every platform → CANDIDATE
	writeProcProc(106, { exe: "/root/.cache/ms-playwright/chrome-123/chrome", cmdline: "chrome --y", ppid: 9999, ageMin: 40 });
});

after(() => rm(procDir, { recursive: true, force: true }));

test("scanLinuxProcesses: verdicts follow the authority order over a mock /proc", async () => {
	const records = await scanLinuxProcesses(procDir);
	const byPid = new Map(records.map((r) => [r.pid, r]));
	assert.equal(records.filter((r) => matchesPattern("chrome*", r)).length, 5, "node must be filtered by the pattern check");
	assert.equal(byPid.get(101).ppid, 1, "ppid parsed from stat field 4 (after the comm paren)");
	assert.ok(byPid.get(101).started_at_ms, "dir mtime used as the start time");

	// The verdict plumbing must use parentAliveOn with the LINUX semantics.
	const mk = (r) => verdictFor({
		debug_channel: hasDebugChannel(r.command_line),
		parent_alive: parentAliveOn("linux", r, records),
		age_min: r.started_at_ms === null ? null : (Date.now() - r.started_at_ms) / MINUTE,
		contract_registered: false,
		min_age_min: 10,
	});
	assert.deepEqual(mk(byPid.get(101)).verdict, "CANDIDATE", "adopted orphan (ppid=1) is NOT a live parent on POSIX");
	assert.match(mk(byPid.get(102)).reason, /调试通道/, "pipe must be caught (Playwright default)");
	assert.match(mk(byPid.get(103)).reason, /父进程存活/);
	assert.match(mk(byPid.get(104)).reason, /启动仅/);
	assert.deepEqual(mk(byPid.get(106)).verdict, "CANDIDATE", "parent pid absent from the snapshot = dead parent");
});

test("parentAliveOn: platform split — pid-1 re-parenting is POSIX-only (review P2-2)", () => {
	const rec = { pid: 10, ppid: 1, command_line: "chrome", exe_path: "/x", started_at_ms: 1 };
	const snap = [rec]; // pid 1 itself is NOT in the snapshot here
	assert.equal(parentAliveOn("linux", rec, snap), false, "ppid=1 on Linux = adopted orphan");
	assert.equal(parentAliveOn("darwin", rec, snap), false);
	assert.equal(parentAliveOn("win32", { ...rec, ppid: 9999 }, [{ ...rec, pid: 9999 }]), true, "win32 keeps literal PPID semantics");
});

test("handler-level: Linux orphan ppid=1 comes back as a CANDIDATE with a ticket (probe B2 regression)", async () => {
	const { deps } = hygieneDeps();
	const nowMs = 7_000_000;
	const orphan = { pid: 4242, ppid: 1, command_line: "chrome --type=renderer", exe_path: "/root/.cache/ms-playwright/chrome", started_at_ms: nowMs - 60 * MINUTE };
	const scan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner: async () => [orphan], now: () => nowMs, platform: "linux" });
	const row = scan.details.rows.find((r) => r.pid === 4242);
	assert.equal(row.verdict, "CANDIDATE", "ppid=1 must NOT read as 父进程存活 on linux");
	assert.equal(row.parent_alive, false);
	assert.ok(scan.details.ticket, "the Linux orphan must yield a kill ticket");
	assert.doesNotMatch(scan.content[0].text, /父进程存活/);
});

// ── handleProcessHygieneAction: tickets, TOCTOU, contracts ──────────────────

function hygieneDeps(contractsPath) {
	const config = new ConfigStore(new DatabaseSync(":memory:"));
	return {
		config,
		deps: {
			config,
			resolveActor: () => ({ channel: "dingtalk", chatType: "single", senderId: "test-admin", text: "" }),
			onConfigChanged: () => {},
			conversationId: "test:hygiene",
			processContractsPath: contractsPath,
		},
	};
}

const CANDIDATE = (pid, nowMs) => ({
	pid, ppid: 9999, command_line: "chrome --type=renderer", exe_path: "/root/.cache/ms-playwright/chrome",
	started_at_ms: nowMs - 60 * MINUTE,
});

test("scan mints a ticket; kill_pid refuses an expired ticket", async () => {
	const { deps } = hygieneDeps();
	let t = 1_000_000;
	const now = () => t;
	const scanner = async () => [CANDIDATE(4242, t)];
	const scan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner, now });
	assert.match(scan.content[0].text, /CANDIDATE/);
	assert.match(scan.content[0].text, /凭 ticket|kill_pid/);
	const ticket = scan.details.ticket;
	assert.ok(ticket, "a scan with candidates must mint a ticket");
	assert.equal(scan.details.expires_at - t, TICKET_TTL_MS);

	t += TICKET_TTL_MS + 1_000; // past expiry
	const expired = await handleProcessHygieneAction(deps, { action: "kill_pid", ticket, pid: 4242 }, { scanner, now });
	assert.match(expired.content[0].text, /过期|不存在/);
});

test("kill_pid refuses a pid outside the ticket", async () => {
	const { deps } = hygieneDeps();
	let t = 2_000_000;
	const now = () => t;
	const scanner = async () => [CANDIDATE(4242, t)];
	const scan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner, now });
	const offList = await handleProcessHygieneAction(deps, { action: "kill_pid", ticket: scan.details.ticket, pid: 777 }, { scanner, now });
	assert.match(offList.content[0].text, /不在该 ticket 名单/);
});

test("TOCTOU: a process that gains a debug channel between scan and kill is refused", async () => {
	const { deps } = hygieneDeps();
	let t = 3_000_000;
	const now = () => t;
	const clean = CANDIDATE(4242, t);
	let snapshot = [clean];
	const scanner = async () => snapshot;
	const scan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner, now });
	snapshot = [{ ...clean, command_line: "chrome --remote-debugging-pipe" }]; // a driver attached!
	const refused = await handleProcessHygieneAction(deps, { action: "kill_pid", ticket: scan.details.ticket, pid: 4242 }, { scanner, now });
	assert.match(refused.content[0].text, /状态已变化/);
	assert.match(refused.content[0].text, /调试通道/);
});

test("TOCTOU: a contract registered after the scan is refused at kill time", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-contracts-"));
	const after = async () => rm(dir, { recursive: true, force: true });
	try {
		const { deps } = hygieneDeps(join(dir, "process-contracts.json"));
		let t = 4_000_000;
		const now = () => t;
		const scanner = async () => [CANDIDATE(4242, t)];
		const scan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner, now });
		const reg = await handleProcessHygieneAction(deps, { action: "register_contract", pid: 4242, purpose: "保活任务" }, { now });
		assert.ok(reg.content[0].text);
		const refused = await handleProcessHygieneAction(deps, { action: "kill_pid", ticket: scan.details.ticket, pid: 4242 }, { scanner, now });
		assert.match(refused.content[0].text, /状态已变化/);
		assert.match(refused.content[0].text, /契约/);
	} finally {
		await after();
	}
});


test("P2-1 PID reuse: a different process behind the same pid is refused (probe B1 regression)", async () => {
	const { deps } = hygieneDeps();
	const t0 = 8_000_000;
	let t = t0;
	const now = () => t;
	const chrome = CANDIDATE(4242, t0);
	const scan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner: async () => [chrome], now });
	// PID 4242 got reused by a young orphan mysqldump with no holds — still
	// INSIDE the ticket TTL (the reuse window, not expiry, is what's under test).
	const impostor = { pid: 4242, ppid: 1, command_line: "mysqldump --single-transaction", exe_path: "/usr/bin/mysqldump", started_at_ms: t0 + 5 * MINUTE };
	t = t0 + 6 * MINUTE;
	const refused = await handleProcessHygieneAction(deps, { action: "kill_pid", ticket: scan.details.ticket, pid: 4242 }, {
		scanner: async () => [impostor], now,
		kill: { terminate: async () => { throw new Error("must not reach terminate"); }, escalate: async () => { throw new Error("must not reach escalate"); }, isAlive: async () => false },
	});
	assert.equal(refused.details.refused, true, `text: ${refused.content[0].text}`);
	assert.match(refused.content[0].text, /身份不符|PID 复用/);
	assert.match(refused.content[0].text, /mysqldump|重新 scan/);
});

test("P2-1 identity match: the SAME process passes the anchor and kill proceeds (stub ops)", async () => {
	const { deps } = hygieneDeps();
	const t0 = 9_000_000;
	let t = t0;
	const now = () => t;
	const chrome = CANDIDATE(4242, t0);
	const scan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner: async () => [chrome], now });
	const calls = [];
	const killed = await handleProcessHygieneAction(deps, { action: "kill_pid", ticket: scan.details.ticket, pid: 4242 }, {
		scanner: async () => [{ ...chrome }], now, // identical identity snapshot
		kill: {
			terminate: async (pid) => { calls.push(["terminate", pid]); return { ok: true, detail: "已发送" }; },
			escalate: async (pid) => { calls.push(["escalate", pid]); return { ok: true, detail: "已发送" }; },
			isAlive: async () => false, // gone right after TERM
		},
	});
	assert.equal(killed.details.ok, true, `text: ${killed.content[0].text}`);
	assert.equal(killed.details.escalated, false, "identity-matching pid dies on TERM without escalation");
	assert.deepEqual(calls, [["terminate", 4242]]);
});

test("P2-4 corrupted ledger: scan warns in the first line, register/kill refuse (probe C1 regression)", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-corrupt-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const contractsPath = join(dir, "process-contracts.json");
	const { deps } = hygieneDeps(contractsPath);
	const t0 = 10_000_000;
	const now = () => t0;
	const scanner = async () => [CANDIDATE(4242, t0)];
	// Half-written JSON (the crash-while-saving shape).
	writeFileSync(contractsPath, '[{"pid": 5000, "purpose": "trunc', "utf8");

	const scan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner, now });
	assert.equal(scan.details.contracts_corrupted, true);
	assert.match(scan.content[0].text.split("\n")[0], /契约台账损坏/, "the warning must be the FIRST line");
	assert.equal(scan.details.candidate_count, 1, "protection degraded but verdicts still flow (with the warning)");
	assert.ok(scan.details.ticket);

	const reg = await handleProcessHygieneAction(deps, { action: "register_contract", pid: 4242, purpose: "x" }, { now });
	assert.equal(reg.details.refused, true, "must not append to an unknown-state ledger");
	assert.match(reg.content[0].text, /损坏/);
	const rem = await handleProcessHygieneAction(deps, { action: "remove_contract", pid: 5000 }, { now });
	assert.equal(rem.details.refused, true, "blind remove on a corrupt ledger refused");
	const list = await handleProcessHygieneAction(deps, { action: "list_contracts" }, { now });
	assert.match(list.content[0].text, /损坏/);
});

test("P2-4 corrupted ledger at kill time: contract hold-state unknown → refuse", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-corrupt-kill-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const contractsPath = join(dir, "process-contracts.json");
	const { deps } = hygieneDeps(contractsPath);
	const t0 = 11_000_000;
	const now = () => t0;
	const scanner = async () => [CANDIDATE(4242, t0)];
	const scan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner, now });
	writeFileSync(contractsPath, "not json at all", "utf8");
	const refused = await handleProcessHygieneAction(deps, { action: "kill_pid", ticket: scan.details.ticket, pid: 4242 }, {
		scanner, now,
		kill: { terminate: async () => { throw new Error("must not reach terminate"); }, escalate: async () => ({ ok: true, detail: "" }), isAlive: async () => false },
	});
	assert.equal(refused.details.refused, true, `text: ${refused.content[0].text}`);
	assert.match(refused.content[0].text, /台账损坏/);
});

test("P2-4 atomic write: no .tmp residue after register (crash-safe rename)", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-atomic-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const contractsPath = join(dir, "process-contracts.json");
	const { deps } = hygieneDeps(contractsPath);
	const reg = await handleProcessHygieneAction(deps, { action: "register_contract", pid: 4242, purpose: "atomic" }, {});
	assert.match(reg.content[0].text, /已登记/);
	assert.ok(existsSync(contractsPath));
	assert.equal(existsSync(`${contractsPath}.tmp`), false, "tmp file must be renamed away, not left behind");
});

test("P3-3 audits: already_gone and scan-failure paths leave audit lines (gate-silence lesson)", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-audit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const auditPath = join(dir, "shell-audit.log");
	const config = new ConfigStore(new DatabaseSync(":memory:"));
	const deps = {
		config, resolveActor: () => ({ channel: "dingtalk", chatType: "single", senderId: "test-admin", text: "" }),
		onConfigChanged: () => {}, conversationId: "test:hygiene-audit", auditLogPath: auditPath,
	};
	const t0 = 12_000_000;
	const now = () => t0;
	const emptyScan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner: async () => [CANDIDATE(4242, t0)], now });
	await handleProcessHygieneAction(deps, { action: "kill_pid", ticket: emptyScan.details.ticket, pid: 4242 }, { scanner: async () => [], now });
	const failScan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner: async () => { throw new Error("boom"); }, now });
	assert.equal(failScan.details.refused, true);
	const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(lines.some((l) => l.event === "hygiene_kill_pid" && l.already_gone === true), "vanished-pid kill must be audited");
	assert.ok(lines.some((l) => l.event === "hygiene_scan" && l.ok === false), "scan failure must be audited");
});

test("kill_pid: vanished pid is an honest no-op; real kill escalates past a TERM-ignoring child (posix)", { skip: process.platform === "win32" }, async (t) => {
	const { deps } = hygieneDeps();
	let clock = 5_000_000;
	const now = () => clock;
	// Vanished pid: the re-scan finds nothing → honest report, not an error.
	const emptyScan = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner: async () => [CANDIDATE(4242, clock)], now });
	const gone = await handleProcessHygieneAction(deps, { action: "kill_pid", ticket: emptyScan.details.ticket, pid: 4242 }, { scanner: async () => [], now });
	assert.match(gone.content[0].text, /已退出/);
	assert.equal(gone.details.already_gone, true);

	// Real kill: child ignores SIGTERM → the 5s escalation must finish it.
	const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	t.after(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } });
	assert.ok(child.pid);
	const childScan = await handleProcessHygieneAction(deps, { action: "scan" }, {
		scanner: async () => [{ pid: child.pid, ppid: null, command_line: "chrome", exe_path: "/root/.cache/ms-playwright/chrome", started_at_ms: clock - 60 * MINUTE }],
		now,
	});
const killed = await handleProcessHygieneAction(deps, { action: "kill_pid", ticket: childScan.details.ticket, pid: child.pid }, {
	// The kill-time re-judge must still SEE the child (it dies only at the kill
	// itself); liveness from here on goes through the real posix ops.
	scanner: async () => [{ pid: child.pid, ppid: null, command_line: "chrome", exe_path: "/root/.cache/ms-playwright/chrome", started_at_ms: clock - 60 * MINUTE }],
	now,
});
	assert.equal(killed.details.ok, true, `kill result text: ${killed.content[0].text}`);
	assert.equal(killed.details.escalated, true, "a TERM-ignoring child must need the force-kill escalation");
	await new Promise((resolve) => setTimeout(resolve, 300));
	const childAlive = (() => { try { process.kill(child.pid, 0); return true; } catch { return false; } })();
	assert.equal(childAlive, false, "child must be dead after the kill");
});

// ── contract ledger round-trip through scan verdicts ─────────────────────────

test("contracts: register → scan SKIP(在册) → remove → CANDIDATE", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-contracts-"));
	try {
		const contractsPath = join(dir, "process-contracts.json");
		const { deps } = hygieneDeps(contractsPath);
		let t = 6_000_000;
		const now = () => t;
		const scanner = async () => [CANDIDATE(4242, t)];

		const reg = await handleProcessHygieneAction(deps, { action: "register_contract", pid: 4242, purpose: "spay 保活", expectedMinutes: 90, killConditions: "任务失败时" }, { now });
		assert.match(reg.content[0].text, /已登记/);
		assert.ok(existsSync(contractsPath), "contract file must exist after register");
		const raw = JSON.parse(readFileSync(contractsPath, "utf8"));
		assert.deepEqual(Object.keys(raw[0]).sort(), ["expected_minutes", "kill_conditions", "pid", "purpose", "registered_at"], "file schema per task spec");

		const scanRegistered = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner, now });
		const row = scanRegistered.details.rows.find((r) => r.pid === 4242);
		assert.equal(row.verdict, "SKIP");
		assert.match(row.reason, /契约/);
		assert.equal(scanRegistered.details.ticket, null, "a fully-SKIP scan must NOT mint a ticket");
		assert.match(scanRegistered.content[0].text, /没有可清理的候选/);

		// duplicate register refused; list works; remove works
		const dup = await handleProcessHygieneAction(deps, { action: "register_contract", pid: 4242, purpose: "x" }, { now });
		assert.match(dup.content[0].text, /已有登记/);
		const list = await handleProcessHygieneAction(deps, { action: "list_contracts" }, { now });
		assert.match(list.content[0].text, /4242/);
		const rem = await handleProcessHygieneAction(deps, { action: "remove_contract", pid: 4242 }, { now });
		assert.match(rem.content[0].text, /已注销/);
		const scanAfter = await handleProcessHygieneAction(deps, { action: "scan" }, { scanner, now });
		assert.equal(scanAfter.details.rows.find((r) => r.pid === 4242).verdict, "CANDIDATE");
		assert.ok(scanAfter.details.ticket, "unregistered orphan must come back as a ticketed candidate");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ── manage_process wiring: union + dispatch through the real tool object ────

function toolFixture(contractsPath) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	cleanupConfigs.push({ db, config });
	config.replaceAll({
		security: { adminStaffIds: ["test-admin"] },
		capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
	});
	const deps = {
		config,
		resolveActor: () => ({ channel: "dingtalk", chatType: "single", senderId: "test-admin", text: "确认" }),
		onConfigChanged: () => {},
		conversationId: "test:hygiene-tool",
		processContractsPath: contractsPath,
	};
	return { db, config, deps, processTool: createManageProcessTool(deps) };
}


test("P1-2 kill_pid needs the message confirmation at EVERY role — operator without 确认 is refused", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-confirm-"));
	try {
		const contractsPath = join(dir, "process-contracts.json");
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const config = new ConfigStore(db);
		cleanupConfigs.push({ db, config });
		config.replaceAll({
			security: { adminStaffIds: [], people: [{ staffId: "op", role: "operator" }], defaultRole: "viewer" },
			capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
		});
		let actor = { channel: "dingtalk", chatType: "single", senderId: "op", text: "帮我清理一下残留" };
		const deps = {
			config, resolveActor: () => actor, onConfigChanged: () => {},
			conversationId: "test:hygiene-confirm", processContractsPath: contractsPath,
		};
		const processTool = createManageProcessTool(deps);
		const t0 = 13_000_000;
		const scanner = async () => [CANDIDATE(4242, t0)];

		// scan is read-only recon: operator needs NO confirmation (P1-2 ruling).
		// The darwin platform check would refuse AFTER the gates; what matters here
		// is that the refusal is NOT the confirmation gate.
		const scan = await processTool.execute("t", { action: "scan" });
		assert.doesNotMatch(scan.content[0].text, /需要当前消息中明确确认/);

		// NOTE: the confirmation gate runs BEFORE the handler dispatch — the kill
		// itself is never reached here (and could not run anyway: darwin platform check).
		const refused = await processTool.execute("t", { action: "kill_pid", ticket: "whatever", pid: 4242 });
		assert.equal(refused.details.refused, true, `text: ${refused.content[0].text}`);
		assert.match(refused.content[0].text, /确认/);

		// admin is NOT exempt either (parent ruling): switch the same actor to admin.
		config.replaceAll({
			security: { adminStaffIds: ["op"], people: [], defaultRole: "viewer" },
			capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
		});
		const refusedAdmin = await processTool.execute("t", { action: "kill_pid", ticket: "whatever", pid: 4242 });
		assert.equal(refusedAdmin.details.refused, true, "admin without 确认 must also be refused");
		assert.match(refusedAdmin.content[0].text, /任何角色/);

		// With the confirmation in the message, the operator path proceeds past
		// the gate (and dies honestly on darwin's platform check, NOT on the gate).
		actor = { ...actor, text: "确认终止这个残留进程" };
		const platformGate = await processTool.execute("t", { action: "kill_pid", ticket: "whatever", pid: 4242 });
		assert.doesNotMatch(platformGate.content[0].text, /需要当前消息中明确确认/, "确认 in the message must clear the confirmation gate");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("P1-2 shell.enabled=false: scan/kill_pid refused while list keeps working (session bookkeeping contract)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-disabled-"));
	try {
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const config = new ConfigStore(db);
		cleanupConfigs.push({ db, config });
		config.replaceAll({
			security: { adminStaffIds: ["test-admin"] },
			capabilities: { shell: { enabled: false, allowedCommands: ["node"] } },
		});
		const deps = {
			config,
			resolveActor: () => ({ channel: "dingtalk", chatType: "single", senderId: "test-admin", text: "确认" }),
			onConfigChanged: () => {}, conversationId: "test:hygiene-disabled",
		};
		const processTool = createManageProcessTool(deps);
		const scan = await processTool.execute("t", { action: "scan" });
		assert.equal(scan.details.refused, true, `text: ${scan.content[0].text}`);
		assert.match(scan.content[0].text, /shell\.enabled/);
		const kill = await processTool.execute("t", { action: "kill_pid", ticket: "x", pid: 1 });
		assert.equal(kill.details.refused, true);
		const list = await processTool.execute("t", { action: "list" });
		assert.doesNotMatch(list.content[0].text, /shell\.enabled/, "list/poll/log/keep must keep their off-switch contract");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("P1-2 guarded(\"shell\"): viewer hits the RBAC gate before anything else (floors live)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-rbac-"));
	try {
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const config = new ConfigStore(db);
		cleanupConfigs.push({ db, config });
		config.replaceAll({
			security: { adminStaffIds: [], people: [], defaultRole: "viewer" },
			capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
		});
		const deps = {
			config,
			resolveActor: () => ({ channel: "dingtalk", chatType: "single", senderId: "someone", text: "确认" }),
			onConfigChanged: () => {}, conversationId: "test:hygiene-rbac",
			processContractsPath: join(dir, "process-contracts.json"),
		};
		const guardedTool = guardTool("shell", createManageProcessTool(deps), {
			config, conversationId: deps.conversationId, resolveActor: deps.resolveActor,
		});
		const refused = await guardedTool.execute("t", { action: "register_contract", pid: 4242, purpose: "x" });
		assert.equal(refused.details.refused, true);
		assert.match(refused.content[0].text, /权限/, `viewer must see the RBAC refusal: ${refused.content[0].text}`);

		config.replaceAll({
			security: { adminStaffIds: [], people: [{ staffId: "someone", role: "operator" }], defaultRole: "viewer" },
			capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
		});
		const ok = await guardedTool.execute("t", { action: "register_contract", pid: 4242, purpose: "x" });
		assert.match(ok.content[0].text, /已登记/, "operator passes the RBAC floor");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("manage_process accepts the new actions end-to-end (union + dispatch wiring)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-wiring-"));
	try {
		const { processTool } = toolFixture(join(dir, "process-contracts.json"));
		const reg = await processTool.execute("t", { action: "register_contract", pid: 4242, purpose: "wiring test" });
		assert.match(reg.content[0].text, /已登记/);
		const list = await processTool.execute("t", { action: "list_contracts" });
		assert.match(list.content[0].text, /4242/);
		const rem = await processTool.execute("t", { action: "remove_contract", pid: 4242 });
		assert.match(rem.content[0].text, /已注销/);
		const bad = await processTool.execute("t", { action: "explode" });
		assert.match(bad.content[0].text, /action 必须是/);
	} finally {
		await after();
	}
});

// ── run_command gate: intercepts incident scripts, lets benign commands run ──

function runCommandFixture(extra = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	config.replaceAll({
		security: { adminStaffIds: ["test-admin"] },
		capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
	});
	cleanupConfigs.push({ db, config });
	const deps = {
		config,
		resolveActor: () => ({ channel: "dingtalk", chatType: "single", senderId: "test-admin", text: "确认" }),
		onConfigChanged: () => {},
		conversationId: "test:hygiene-gate",
		...extra,
	};
	return { tool: createRunCommandTool(deps), deps, config };
}

const cleanupConfigs = [];

after(() => {
	for (const { db, config } of cleanupConfigs) {
		try { disposeShellCommands(config); } catch { /* already gone */ }
		try { db.close(); } catch { /* already closed */ }
	}
});


test("P3-2 gate ordering: a viewer with a dangerous command sees the ROLE refusal, not the incident narrative", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-order-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const scriptPath = join(dir, "kill_pw_chrome.ps1");
	writeFileSync(scriptPath, INCIDENT_PS1, "utf8");
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	cleanupConfigs.push({ db, config });
	config.replaceAll({
		security: { adminStaffIds: [], people: [], defaultRole: "viewer" },
		capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
	});
	const deps = {
		config,
		resolveActor: () => ({ channel: "dingtalk", chatType: "single", senderId: "whoever", text: "确认" }),
		onConfigChanged: () => {}, conversationId: "test:hygiene-order",
	};
	const refused = await createRunCommandTool(deps).execute("t", { command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"` });
	assert.equal(refused.details.refused, true);
	assert.match(refused.content[0].text, /命令执行权限/, `viewer sees the role refusal: ${refused.content[0].text}`);
	assert.doesNotMatch(refused.content[0].text, /2026-11-10/, "the incident narrative must NOT leak below the role gate");
});

test("P3-1 unreadable script files are audited, not silently skipped", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-unreadable-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const auditPath = join(dir, "shell-audit.log");
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	cleanupConfigs.push({ db, config });
	config.replaceAll({
		security: { adminStaffIds: ["test-admin"] },
		capabilities: { shell: { enabled: true, allowedCommands: ["node"] } },
	});
	const deps = {
		config, auditLogPath: auditPath,
		resolveActor: () => ({ channel: "dingtalk", chatType: "single", senderId: "test-admin", text: "确认" }),
		onConfigChanged: () => {}, conversationId: "test:hygiene-unreadable",
	};
	// admin + whitelisted node → passes role/enabled/gate → whitelist ok → runs.
	const result = await createRunCommandTool(deps).execute("t", { command: `node "/nonexistent/killer.js"` });
	const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(lines.some((l) => l.event === "hygiene_gate_script_unreadable" && String(l.path).endsWith("killer.js")), `audit lines: ${JSON.stringify(lines.map((l) => l.event))}`);
	assert.ok(!lines.some((l) => l.event === "hygiene_gate_reject"), "unreadable ≠ dangerous: no rejection");
});

test("run_command refuses a script file carrying the incident pattern, then a benign command still runs", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-gate-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const scriptPath = join(dir, "kill_pw_chrome.ps1");
	writeFileSync(scriptPath, INCIDENT_PS1, "utf8");
	const { tool } = runCommandFixture();

	const refused = await tool.execute("t", { command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"` });
	assert.equal(refused.details.refused, true);
	assert.match(refused.content[0].text, /2026-11-10/, "gate refusal cites the incident");
	assert.match(refused.content[0].text, /kill_pid/, "gate refusal points at the tool path");

	const benign = await tool.execute("t", { command: `node -e "console.log('gate-ok')"` });
	assert.match(benign.content[0].text, /gate-ok/, "a benign command must pass the gate and actually run");
});

test("run_script-style command (python script content) is gated too", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pve-hygiene-gate-py-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const pyPath = join(dir, "cleanup.py");
	writeFileSync(pyPath, "import os\n# 清理 ms-playwright 残留浏览器\nos.kill(1234, 9)\n", "utf8");
	const { tool } = runCommandFixture();
	const paramsFile = join(dir, "params.json");
	writeFileSync(paramsFile, "{}", "utf8");
	const refused = await tool.execute("t", { command: `python "${pyPath}" --params-file "${paramsFile}"` });
	assert.equal(refused.details.refused, true);
	assert.match(refused.content[0].text, /scan/);
});
