/**
 * Behavioral tests for the self-healing Playwright Chromium runtime.
 *
 * The state machine (src/browser/runtime.ts) is driven with an in-memory
 * filesystem and a fake installer, so every network/version/retry path is
 * exercised deterministically. Also covers the BrowserService wiring: a
 * not-ready runtime must abort launch BEFORE Playwright is touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.browser-runtime-probe");
mkdirSync(outDir, { recursive: true });

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		bundle: true, format: "esm", platform: "node",
		outfile: join(outDir, outfile),
		external: ["playwright", "electron"],
		logLevel: "silent",
	});
	return import(pathToFileURL(join(outDir, outfile)).href + `?t=${Date.now()}`);
}

const rt = await bundle("src/browser/runtime.ts", "runtime.mjs");
const { BrowserRuntime, parseProgress, summarizeError } = rt;

/** Harness: an in-memory set of "existing" chromium paths + a scripted runner. */
function makeHarness(opts = {}) {
	const present = new Set(opts.initiallyPresent ?? []);
	// Wanted revision can change mid-test to simulate an app upgrade.
	let rev = opts.rev ?? 1234;
	const exePath = () => `/ms-playwright/chromium-${rev}/chrome-win64/chrome.exe`;
	const calls = [];
	// Script: array of { ok, addFile?, host?, delayPct? } results, or a fn.
	const script = opts.script ?? [];
	let idx = 0;
	const runner = async (onProgress, host) => {
		const step = typeof script === "function" ? script(idx, host) : script[idx++];
		calls.push({ host, step });
		if (step?.progress) for (const p of step.progress) onProgress(p);
		if (step?.ok && step.addFile !== false) present.add(exePath());
		return { ok: !!step?.ok, tail: step?.tail ?? "" };
	};
	const runtime = new BrowserRuntime({
		executablePath: exePath,
		exists: (f) => present.has(f),
		revision: () => String(rev),
		runner,
		hosts: opts.hosts ?? [undefined, "https://mirror.example/playwright"],
	});
	return {
		runtime, calls,
		setRev: (r) => { rev = r; },
		manuallyInstall: () => present.add(exePath()),
	};
}

test("already installed → ready without invoking the installer", async () => {
	const h = makeHarness({ initiallyPresent: ["/ms-playwright/chromium-1234/chrome-win64/chrome.exe"] });
	const s = await h.runtime.ensure();
	assert.equal(s.phase, "ready");
	assert.equal(h.calls.length, 0);
});

test("missing binary → install once from the official CDN and become ready", async () => {
	const h = makeHarness({ script: [{ ok: true }] });
	const s = await h.runtime.ensure();
	assert.equal(s.phase, "ready");
	assert.equal(s.progress, 100);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].host, undefined);
});

test("official CDN fails → automatic retry through the mirror, then ready", async () => {
	const h = makeHarness({ script: [{ ok: false, tail: "ETIMEDOUT cdn.playwright.dev" }, { ok: true }] });
	const s = await h.runtime.ensure();
	assert.equal(s.phase, "ready");
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[0].host, undefined);
	assert.equal(h.calls[1].host, "https://mirror.example/playwright");
});

test("all hosts fail → phase error with an actionable message", async () => {
	const h = makeHarness({ script: [{ ok: false, tail: "ETIMEDOUT official" }, { ok: false, tail: "ECONNREFUSED mirror" }] });
	const s = await h.runtime.ensure();
	assert.equal(s.phase, "error");
	assert.match(s.error, /ECONNREFUSED|ETIMEDOUT/);
});

test("installer exits 0 but the binary is still absent (AV quarantine) → not ready", async () => {
	const h = makeHarness({ script: [{ ok: true, addFile: false, tail: "" }, { ok: true, addFile: false, tail: "" }] });
	const s = await h.runtime.ensure();
	assert.equal(s.phase, "error");
});

test("concurrent ensure() calls are single-flighted (one installer run)", async () => {
	// Resolve the installer only after both callers are waiting.
	let resolveInstall;
	const runner = () => new Promise((res) => { resolveInstall = () => res({ ok: true, tail: "" }); });
	const present = new Set();
	const exePath = () => "/x/chromium-1/chrome.exe";
	const runtime = new BrowserRuntime({
		executablePath: exePath, exists: (f) => present.has(f), revision: () => "1",
		runner: async (onP) => { const r = await runner(); present.add(exePath()); return r; },
		hosts: [undefined],
	});
	const runs = [];
	const p1 = runtime.ensure().then((s) => runs.push(["a", s.phase]));
	const p2 = runtime.ensure().then((s) => runs.push(["b", s.phase]));
	await new Promise((r) => setTimeout(r, 20));
	resolveInstall();
	await Promise.all([p1, p2]);
	assert.equal(runs.filter(([, ph]) => ph === "ready").length, 2);
});

test("APP UPGRADE: wanted revision changes → an old on-disk binary is not 'ready' and the new one installs", async () => {
	// The regression behind the field incident: box had chromium-1217, upgraded
	// app wanted chromium-1234. Old binary present must NOT short-circuit.
	const h = makeHarness({ rev: 1217, script: [] });
	h.manuallyInstall(); // old revision present
	assert.equal(h.runtime.isReady(), true);
	h.setRev(1234); // app upgrade changes the wanted path
	assert.equal(h.runtime.isReady(), false, "old revision must not satisfy the new wanted path");
	const h2 = makeHarness({ rev: 1234, script: [{ ok: true }] });
	const s = await h2.runtime.ensure();
	assert.equal(s.phase, "ready");
	assert.equal(s.revision, "1234");
});

test("status listeners receive progress and terminal states", async () => {
	const h = makeHarness({ script: [{ ok: true, progress: [10, 55, 100] }] });
	const seen = [];
	h.runtime.onChange((s) => seen.push(`${s.phase}:${s.progress}`));
	await h.runtime.ensure();
	assert.ok(seen.some((x) => x === "installing:55"), `got ${JSON.stringify(seen)}`);
	assert.ok(seen[seen.length - 1].startsWith("ready:"), `last=${seen[seen.length - 1]}`);
});

test("parseProgress reads the last percentage in a Playwright progress chunk", () => {
	assert.equal(parseProgress("|███  | 42% of 191.8 MiB", 0), 42);
	assert.equal(parseProgress("noise", 37), 37);
	assert.equal(parseProgress("10% of x then 90% of x", 0), 90);
});

test("summarizeError strips ANSI/progress bars and picks the error line", () => {
	const out = "\x1b[2m|████| 80% of 100 MiB\x1b[0m\nError: ECONNREFUSED 1.2.3.4:443";
	assert.match(summarizeError(out), /ECONNREFUSED/);
	assert.doesNotMatch(summarizeError(out), /\x1b/);
});

// ---- BrowserService wiring: a not-ready runtime aborts before Playwright ----
test("BrowserService launch aborts with BrowserRuntimeUnavailableError when runtime not ready", async () => {
	const bs = await bundle("src/browser/browser-service.ts", "browser-service.mjs");
	const fakeConfig = { all: () => ({ browser: { headless: true } }) };
	const notReadyRuntime = { ensure: async () => ({ phase: "error", error: "download failed" }) };
	const service = new bs.BrowserService(fakeConfig, "/tmp/fake-profile", notReadyRuntime);
	// getPage() is the first public entry that calls the private launch path.
	// The runtime check runs before Playwright is touched, so it must reject.
	await assert.rejects(
		() => service.getPage("owner-1"),
		(err) => err.name === "BrowserRuntimeUnavailableError" || /download failed/.test(err.message),
	);
});

// ---- P2 fixes from independent review ----
const inst = await bundle("src/browser/installer.ts", "installer.mjs");

test("headlessShellPath derives the separate headless-shell binary per platform", () => {
	const win = "C:/Users/x/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
	assert.equal(
		inst.headlessShellPath(win, "win32"),
		"C:/Users/x/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe",
	);
	const macArm = "/c/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
	assert.match(inst.headlessShellPath(macArm, "darwin"), /chromium_headless_shell-1234\/chrome-headless-shell-mac-arm64\/chrome-headless-shell$/);
	assert.match(inst.headlessShellPath("/c/ms-playwright/chromium-1234/chrome-linux/chrome", "linux"), /chromium_headless_shell-1234\/chrome-headless-shell-linux64\/chrome-headless-shell$/);
	assert.equal(inst.headlessShellPath("garbage", "win32"), "");
});

test("headless readiness requires BOTH chromium and headless-shell (partial install not ready)", () => {
	const full = "/ms/chromium-1234/chrome-win64/chrome.exe";
	const shell = inst.headlessShellPath(full, "win32");
	const present = new Set([full]); // full present, headless-shell missing
	const runtime = new BrowserRuntime({
		executablePath: () => full,
		exists: (f) => present.has(f),
		revision: () => "1234",
		requiredPaths: () => [full, shell],
		runner: async () => ({ ok: false, tail: "n/a" }),
		hosts: [undefined],
	});
	assert.equal(runtime.isReady(), false, "headless launch would fail without headless-shell");
	present.add(shell);
	assert.equal(runtime.isReady(), true, "both present → ready");
});

test("ensure() never throws: a rejecting runner lands in phase=error", async () => {
	const runtime = new BrowserRuntime({
		executablePath: () => "/x/chromium-1/chrome.exe",
		exists: () => false,
		revision: () => "1",
		runner: async () => { throw new Error("spawn ENOENT"); },
		hosts: [undefined],
	});
	const s = await runtime.ensure();
	assert.equal(s.phase, "error");
	assert.match(s.error, /ENOENT/);
});

test("ensure() never throws: a throwing hosts() lands in phase=error", async () => {
	const runtime = new BrowserRuntime({
		executablePath: () => "/x/chromium-1/chrome.exe",
		exists: () => false,
		revision: () => "1",
		runner: async () => ({ ok: false, tail: "" }),
		hosts: () => { throw new Error("config boom"); },
	});
	const s = await runtime.ensure();
	assert.equal(s.phase, "error");
	assert.match(s.error, /config boom/);
});
