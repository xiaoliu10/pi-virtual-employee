/**
 * Runtime bootstrap tests (migration doc §6): source-chain fallback, version
 * verification gate, atomic manifest, and the already-installed fast path.
 * npm/Electron spawns are INJECTED — no network, no real installs here; the
 * spawn shapes themselves are covered by the Phase 1 real-machine checklist.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePiRuntime } from "../src/runtime/bootstrap.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
import { pathToFileURL } from "node:url";
// bootstrap.ts is plain TS with only node: imports — load through a tiny esbuild
// bundle so the .ts extension resolves the same way the other suites do.
const { build } = await import("esbuild");
const dir = mkdtempSync(join(tmpdir(), "rt-bootstrap-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
const bundle = join(dir, "bootstrap.mjs");
await build({
	stdin: { contents: 'export * from "./src/runtime/bootstrap.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { ensurePiRuntime: ensure } = await import(pathToFileURL(bundle).href);

function makeLock(lockDir, version = "1.2.0") {
	mkdirSync(lockDir, { recursive: true });
	writeFileSync(join(lockDir, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": `^${version}` } }));
	writeFileSync(join(lockDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
}

function fakeTarget(targetDir, version = "1.2.0") {
	const cli = join(targetDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
	const idx = join(targetDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
	mkdirSync(cli, { recursive: true });
	writeFileSync(join(cli, "cli.js"), "#!/usr/bin/env node");
	mkdirSync(idx, { recursive: true });
	writeFileSync(join(idx, "index.js"), `export const VERSION = "${version}";`);
}

test("fresh install: first registry wins, manifest is atomic, version self-check gates readiness", async () => {
	const lockDir = join(dir, "lock-a");
	const targetDir = join(dir, "target-a");
	makeLock(lockDir);
	const installed = [];
	const result = await ensure({
		lockDir,
		targetDir,
		registries: ["https://registry.npmmirror.com", "https://registry.npmjs.org"],
		runInstall: async (cwd, registry) => {
			installed.push(registry);
			fakeTarget(cwd);
			return { ok: true, output: "added 1 package" };
		},
		runVersionCheck: async (_cli, expected) => ({ ok: expected === "1.2.0", output: expected }),
	});
	assert.equal(result.status, "ready");
	assert.deepEqual(installed, ["https://registry.npmmirror.com"], "the first source installs; the second is never touched");
	assert.equal(result.version, "1.2.0");
	assert.ok(existsSync(join(targetDir, "runtime.json")), "manifest written");
	assert.ok(!existsSync(`${join(targetDir, "runtime.json")}.tmp`), "no tmp residue (atomic rename)");
});

test("source chain: a failing registry falls through to the next, in order", async () => {
	const lockDir = join(dir, "lock-b");
	const targetDir = join(dir, "target-b");
	makeLock(lockDir);
	const attempted = [];
	const result = await ensure({
		lockDir,
		targetDir,
		registries: ["https://a.invalid", "https://b.invalid", "https://c.invalid"],
		runInstall: async (cwd, registry) => {
			attempted.push(registry);
			if (registry === "https://c.invalid") fakeTarget(cwd);
			return registry === "https://c.invalid" ? { ok: true, output: "" } : { ok: false, output: "E404" };
		},
		runVersionCheck: async () => ({ ok: true, output: "1.2.0" }),
	});
	assert.equal(result.status, "ready");
	assert.deepEqual(attempted, ["https://a.invalid", "https://b.invalid", "https://c.invalid"], "chain walked in order");
	if (result.status === "ready") assert.equal(result.source, "https://c.invalid");
});

test("a version-mismatched install is rejected and walks the chain (bad mirror guard)", async () => {
	const lockDir = join(dir, "lock-c");
	const targetDir = join(dir, "target-c");
	makeLock(lockDir, "1.2.0");
	let lastSource = "";
	const result = await ensure({
		lockDir,
		targetDir,
		registries: ["https://shady-mirror", "https://registry.npmmirror.com"],
		runInstall: async (cwd, registry) => {
			lastSource = registry;
			fakeTarget(cwd);
			return { ok: true, output: "" };
		},
		runVersionCheck: async (_cli, expected) => {
			// The first registry serves a WRONG version (mirror lag / tampering):
			// the self-check must catch it and push the chain to the next source.
			const actual = lastSource === "https://shady-mirror" ? "1.1.0" : expected;
			return { ok: actual === expected, output: actual };
		},
	});
	assert.equal(result.status, "ready");
	if (result.status === "ready") assert.equal(result.source, "https://registry.npmmirror.com", "the bad mirror was rejected");
});

test("all registries fail → status failed with every error surfaced", async () => {
	const lockDir = join(dir, "lock-d");
	const targetDir = join(dir, "target-d");
	makeLock(lockDir);
	const result = await ensure({
		lockDir,
		targetDir,
		registries: ["https://x.invalid", "https://y.invalid"],
		runInstall: async () => ({ ok: false, output: "network down" }),
		runVersionCheck: async () => ({ ok: false, output: "" }),
	});
	assert.equal(result.status, "failed");
	if (result.status === "failed") {
		assert.equal(result.attempted.length, 2);
		assert.equal(result.errors.length, 2, "both errors surfaced for diagnostics");
	}
	assert.ok(!existsSync(join(targetDir, "runtime.json")), "no manifest on failure — never half-ready");
});

test("already-installed runtime at the pinned version: no reinstall, just the cheap check", async () => {
	const lockDir = join(dir, "lock-e");
	const targetDir = join(dir, "target-e");
	makeLock(lockDir);
	fakeTarget(targetDir);
	writeFileSync(join(targetDir, "runtime.json"), JSON.stringify({ platform: process.platform, arch: process.arch, pi: "1.2.0", installedAt: 1, source: "prior" }));
	let installs = 0;
	const result = await ensure({
		lockDir,
		targetDir,
		registries: ["https://registry.npmmirror.com"],
		runInstall: async () => { installs += 1; return { ok: true, output: "" }; },
		runVersionCheck: async () => ({ ok: true, output: "1.2.0" }),
	});
	assert.equal(result.status, "ready");
	if (result.status === "ready") assert.equal(result.fresh, false, "fast path reports not-fresh");
	assert.equal(installs, 0, "no reinstall on the fast path");
});
