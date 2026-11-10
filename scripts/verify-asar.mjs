// Post-package integrity gate for app.asar, run as the LAST step of every
// package:* script (electron-builder output must pass before an artifact is
// considered real).
//
// Why this exists (v0.2.215 incident, 2026-11-10): electron-builder's
// node-module collector silently produced an app.asar with only ~1500 files
// (missing zod, bindings, @aws-sdk/*, @babel/runtime, … — every transitive
// dependency). The app froze at startup on an invisible error dialog and the
// release reached production. Nothing failed loudly: collector logged just a
// debug line (`depCount=27`). This gate makes that failure mode impossible
// to ship: a broken asar fails the package:* chain right at build time.
//
// Checks, per asar:
//   1. total file count >= MIN_FILES      (healthy ~12k, broken ~1.5k)
//   2. top-level node_modules packages >= MIN_TOP_PACKAGES
//   3. every MUST_EXIST file/dir is present (runtime-critical modules)
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const releaseDir = join(root, "release");

// --- thresholds & invariant list (see header comment for provenance) ---
const MIN_FILES = 6000;
const MIN_TOP_PACKAGES = 40;
const MUST_EXIST = [
	// runtime-critical transitive deps lost in the v0.2.215 incident
	// (NOTE: @aws-sdk/* is deliberately excluded from the asar by the files
	// glob — pi-ai requires the bedrock SDK lazily — so it must NOT be listed)
	"node_modules/bindings",
	"node_modules/zod",
	"node_modules/@babel/runtime",
	"node_modules/accepts",
	"node_modules/@protobufjs/base64",
	// engine kernel packages (all four are production deps)
	"node_modules/@earendil-works/pi-ai/dist",
	"node_modules/@earendil-works/pi-agent-core",
	"node_modules/@earendil-works/pi-durable",
	"node_modules/@earendil-works/pi-schema",
	// first-party runtime essentials
	"node_modules/better-sqlite3/package.json",
	"node_modules/electron-updater",
	"node_modules/dingtalk-stream",
	"node_modules/ali-oss",
	"node_modules/playwright",
	"node_modules/xlsx",
	"node_modules/marked",
	// app code
	"dist-electron/main.js",
];

// --- locate every packaged app.asar under release/ ---
// Freshness filter: auto-discovery only accepts asars written after this
// script started (review 3ecfae79 P3-2). release/ keeps dmgs/apps from older
// releases; without the filter a fresh healthy package:win chain could fail
// on a stale broken asar left by another platform's earlier build.
const startedAtMs = Date.now();
function findAsars(dir, out = []) {
	if (!existsSync(dir)) return out;
	const asarPath = join(dir, "resources", "app.asar");
	if (existsSync(asarPath)) {
		out.push(asarPath);
		return out; // an unpacked app dir has exactly one asar
	}
	const { readdirSync, statSync } = require("node:fs");
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		try {
			if (statSync(full).isDirectory()) findAsars(full, out);
		} catch {
			// unreadable symlink target etc — skip
		}
	}
	return out;
}

let targets;
const discovered = findAsars(releaseDir);
if (process.argv.slice(2).length) {
	targets = process.argv.slice(2);
} else {
	// argv = explicit debugging entry point: no freshness filter applied there.
	targets = [];
	for (const path of discovered) {
		try {
			const mtimeMs = require("node:fs").statSync(path).mtimeMs;
			if (mtimeMs >= startedAtMs - 1000) targets.push(path);
			else console.log(`[verify-asar] skip stale asar (predates this build): ${path}`);
		} catch {
			console.log(`[verify-asar] skip unreadable asar: ${path}`);
		}
	}
}

if (targets.length === 0) {
	console.error("[verify-asar] no app.asar found under release/ (pass a path or run after electron-builder).");
	process.exit(1);
}

let failed = false;
for (const archive of targets) {
	const problems = [];
	let listing;
	try {
		listing = asar.listPackage(archive).map((p) => String(p).replaceAll("\\", "/"));
	} catch (err) {
		// review 3ecfae79 P3-3: argv is the documented debugging entry point —
		// a missing/unreadable archive must fail with a clear line, not a raw stack.
		console.error(`[verify-asar] FAIL ${archive}: ${err && err.message ? err.message : err}`);
		failed = true;
		continue;
	}

	// 1. total volume
	if (listing.length < MIN_FILES) {
		problems.push(`file count ${listing.length} < ${MIN_FILES} (transitive deps likely missing)`);
	}

	// 2. top-level packages: distinct first segments under /node_modules/
	const topPkgs = new Set();
	for (const p of listing) {
		const m = p.match(/^\/node_modules\/((?:@[^/]+\/[^/]+)|[^/]+)/);
		if (m) topPkgs.add(m[1]);
	}
	if (topPkgs.size < MIN_TOP_PACKAGES) {
		problems.push(`top-level node_modules packages ${topPkgs.size} < ${MIN_TOP_PACKAGES}`);
	}

	// 3. invariant list — asar listPackage dirs have no trailing slash
	const listed = new Set(listing.map((p) => p.replace(/\/+$/, "")));
	for (const rel of MUST_EXIST) {
		if (!listed.has(`/${rel}`)) {
			problems.push(`missing: /${rel}`);
		}
	}

	if (problems.length > 0) {
		failed = true;
		console.error(`[verify-asar] FAIL ${archive}`);
		for (const p of problems) console.error(`[verify-asar]   - ${p}`);
		console.error("[verify-asar] a broken asar must never ship: it installs fine, then the app");
		console.error("[verify-asar] dies at startup on an invisible error dialog (v0.2.215 incident).");
		console.error("[verify-asar] usual cause: electron-builder ran against a symlinked node_modules,");
		console.error("[verify-asar] or the npm dependency tree was dirty — see scripts/check-build-env.mjs.");
	} else {
		console.log(`[verify-asar] ok ${archive} (files=${listing.length}, top-level packages=${topPkgs.size})`);
	}
}

process.exit(failed ? 1 : 0);
