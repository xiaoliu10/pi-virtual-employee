#!/usr/bin/env node
/**
 * Run every test suite, sequentially, and fail on the first failure.
 *
 * Why a script instead of a long `npm run a && npm run b && …` chain: this is the
 * gate a self-modifying change has to pass (publish.mjs runs it), so it must
 * itself be readable and must report *which* suite failed and how — a wall of
 * interleaved npm output is not a gate anyone can act on.
 *
 * Usage:
 *   node scripts/run-all-tests.mjs            # all suites
 *   node scripts/run-all-tests.mjs prompt     # only suites whose name contains "prompt"
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Suites that spawn real processes/browsers run last: they are the slow ones. */
const ORDER = ["prompt", "permissions", "scheduler", "telemetry", "shell", "browser", "computer"];

async function suites() {
	const files = await readdir(here);
	return files
		.filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
		.map((f) => f.replace(/^test-/, "").replace(/\.mjs$/, ""))
		// Standalone probes that need live credentials are not part of the gate.
		.filter((name) => !["dingtalk-card"].includes(name))
		.sort((a, b) => {
			const ia = ORDER.indexOf(a);
			const ib = ORDER.indexOf(b);
			return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
		});
}

function run(file) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--test", join("scripts", file)], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { out += d; });
		child.on("close", (code) => resolve({ code, out }));
	});
}

const filter = process.argv[2];
const names = (await suites()).filter((n) => !filter || n.includes(filter));
if (names.length === 0) {
	console.error(`[tests] no suite matched "${filter}"`);
	process.exit(1);
}

const failed = [];
const started = Date.now();
for (const name of names) {
	const file = `test-${name}.mjs`;
	process.stdout.write(`[tests] ${name} … `);
	const { code, out } = await run(file);
	const pass = /^ℹ pass (\d+)/m.exec(out)?.[1] ?? "?";
	const fail = /^ℹ fail (\d+)/m.exec(out)?.[1] ?? "?";
	if (code === 0) {
		console.log(`ok (${pass} passed)`);
		continue;
	}
	console.log(`FAILED (${pass} passed, ${fail} failed)`);
	failed.push({ name, out });
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length === 0) {
	console.log(`[tests] all ${names.length} suites passed in ${seconds}s`);
	process.exit(0);
}
console.error(`\n[tests] ${failed.length} of ${names.length} suites FAILED — nothing may be published.\n`);
for (const { name, out } of failed) {
	console.error(`──── ${name} ────`);
	// Keep the failure detail but drop the runner's boilerplate.
	const lines = out.split("\n").filter((l) => !/^ℹ (tests|suites|cancelled|skipped|todo|duration_ms)/.test(l));
	console.error(lines.join("\n").trim());
	console.error("");
}
process.exit(1);
