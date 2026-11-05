/**
 * DevToolsActivePort endpoint discovery + no-port-race guarantees.
 *
 * Field context: Chromium allows ONE process per user-data-dir (the loser dies
 * with exitCode 21 = RESULT_CODE_PROFILE_IN_USE), so sharing a logged-in browser
 * needs a CDP endpoint. "Find a free port now, pass it to the child later" races;
 * `--remote-debugging-port=0` + Chromium's own DevToolsActivePort file does not
 * (Hermes uses exactly this).
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
	DEVTOOLS_ACTIVE_PORT_FILE,
	devToolsFlags,
	degradedBrowserNote,
	parseDevToolsActivePort,
	profileBusyNote,
	readDevToolsEndpoint,
	waitForDevToolsEndpoint,
} from "../src/browser/devtools-endpoint.ts";

const dir = join(tmpdir(), `ve-devtools-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// --- parsing ---------------------------------------------------------------
const ok = parseDevToolsActivePort("52312\n/devtools/browser/abc-123\n");
assert.ok(ok, "two-line file must parse");
assert.equal(ok.port, 52312);
assert.equal(ok.browserPath, "devtools/browser/abc-123");
assert.equal(ok.httpBase, "http://127.0.0.1:52312");
assert.equal(ok.wsUrl, "ws://127.0.0.1:52312/devtools/browser/abc-123");

// Chromium truncates+rewrites this file, so a concurrent read can see it half
// written. A partial read must be "not ready", never a dead endpoint.
assert.equal(parseDevToolsActivePort(""), null, "empty file is not ready");
assert.equal(parseDevToolsActivePort("52312"), null, "port-only file is not ready");
assert.equal(parseDevToolsActivePort("52312\n"), null, "trailing-newline-only is not ready");
assert.equal(parseDevToolsActivePort("0\n/devtools/browser/x"), null, "port 0 is never a real endpoint");
assert.equal(parseDevToolsActivePort("abc\n/devtools/browser/x"), null, "non-numeric port is invalid");
assert.equal(parseDevToolsActivePort("70000\n/devtools/browser/x"), null, "out-of-range port is invalid");
assert.equal(parseDevToolsActivePort("52312\n/page/1"), null, "a non-browser path is rejected");
// Blank lines are skipped, so a file with leading newlines still parses.
assert.equal(parseDevToolsActivePort("\n\n52312\n/devtools/browser/x\n")?.port, 52312);

// --- reading from a directory ---------------------------------------------
assert.equal(readDevToolsEndpoint(dir), null, "missing file -> null");
writeFileSync(join(dir, DEVTOOLS_ACTIVE_PORT_FILE), "40001\n/devtools/browser/xyz\n");
const read = readDevToolsEndpoint(dir);
assert.ok(read && read.port === 40001, "file read must produce the endpoint");

// --- waiting: appears late, and times out deterministically ---------------
// A launch that never publishes an endpoint must resolve null so the caller can
// kill the child (browser-use leaked an orphan exactly here).
writeFileSync(join(dir, DEVTOOLS_ACTIVE_PORT_FILE), "");
const timeoutResult = await waitForDevToolsEndpoint(dir, { timeoutMs: 40, intervalMs: 5 });
assert.equal(timeoutResult, null, "no endpoint within the deadline -> null");

const lateDir = join(dir, "late");
mkdirSync(lateDir, { recursive: true });
writeFileSync(join(lateDir, DEVTOOLS_ACTIVE_PORT_FILE), "41111\n/devtools/browser/late\n");
const late = await waitForDevToolsEndpoint(lateDir, { timeoutMs: 500, intervalMs: 5 });
assert.ok(late && late.port === 41111, "endpoint published before the deadline must be found");

// A STALE file (from a crashed previous run) must not read as "ready": otherwise
// the caller connects to a dead port and the failure gets misdiagnosed as anything
// but a stale artifact (review P2-5).
const staleDir = join(dir, "stale");
mkdirSync(staleDir, { recursive: true });
writeFileSync(join(staleDir, DEVTOOLS_ACTIVE_PORT_FILE), "49999\n/devtools/browser/stale\n");
const old = new Date(Date.now() - 60 * 60 * 1000);
utimesSync(join(staleDir, DEVTOOLS_ACTIVE_PORT_FILE), old, old);
const spawnedAt = Date.now();
const stale = await waitForDevToolsEndpoint(staleDir, {
	timeoutMs: 60, intervalMs: 10, writtenAfterMs: spawnedAt,
});
assert.equal(stale, null, "a file older than the child's spawn time must NOT be accepted");

// ...but a file written after spawn is accepted.
const freshDir = join(dir, "fresh");
mkdirSync(freshDir, { recursive: true });
writeFileSync(join(freshDir, DEVTOOLS_ACTIVE_PORT_FILE), "48888\n/devtools/browser/fresh\n");
const t0 = Date.now();
const fresh = await waitForDevToolsEndpoint(freshDir, { timeoutMs: 500, intervalMs: 10, writtenAfterMs: t0 - 1000 });
assert.ok(fresh && fresh.port === 48888, "a file written at/after spawn is accepted");

// abort short-circuits instead of spinning for the full timeout
const controller = new AbortController();
controller.abort();
const aborted = await waitForDevToolsEndpoint(dir, { timeoutMs: 5000, intervalMs: 5, signal: controller.signal });
assert.equal(aborted, null, "aborted wait returns null immediately");

// --- flags ----------------------------------------------------------------
const flags = devToolsFlags();
assert.ok(flags.includes("--remote-debugging-port=0"), "must let Chromium pick the port (no race)");
assert.ok(!flags.some((f) => /^--remote-debugging-pipe/.test(f)), "pipe must not coexist (it hides the TCP endpoint)");
assert.ok(!flags.some((f) => f.startsWith("--password-store") || f === "--use-mock-keychain"),
	"must keep the OS keychain path intact or the profile's cookies stop decrypting");
assert.ok(!flags.includes("--disable-hang-monitor"), "hang monitor must stay ON for an unattended browser");

// --- notes the model/operator sees ---------------------------------------
const busy = profileBusyNote("C:/x/spay_profile", 4242);
assert.ok(busy.includes("4242"), "busy note names the holder");
assert.ok(busy.includes("不要按进程名批量结束浏览器"), "busy note must forbid the taskkill /IM move that caused the incident");
const degraded = degradedBrowserNote("profile 副本准备失败。");
assert.ok(degraded.includes("没有登录态的新浏览器"), "degradation is stated, never silent");
assert.ok(degraded.includes("告知用户"), "model is told to inform the user");

rmSync(dir, { recursive: true, force: true });
console.log("test-browser-devtools-endpoint: OK");
