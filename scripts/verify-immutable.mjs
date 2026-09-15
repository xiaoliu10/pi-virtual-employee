#!/usr/bin/env node
/**
 * Immutable-core tripwire.
 *
 * The self-improvement plan has a specific failure mode worth designing against:
 * a change that "improves" the system by loosening its own guardrails — weakening
 * the always-on prompt red lines, the RBAC checks, the confirmation gate, the
 * auto-update circuit breaker, the test assertions that pin those, or the release
 * upload target. Behaviour changes are supposed to pass tests; guardrail changes
 * are supposed to be *noticed*.
 *
 * So the regions listed in docs/immutable.manifest.json are hashed and compared
 * before anything is published. A mismatch fails the release unless a human sets
 * IMMUTABLE_ACK="<reason>" — and that reason is printed and recorded, never silent.
 *
 * HONEST LIMIT: this is a tripwire, not a cryptographic boundary. Whoever can
 * edit the guarded files can also edit the manifest, and whoever can edit this
 * script can move the pin (MANIFEST_SHA256) — which is exactly why the manifest's
 * own hash is pinned here too, and why `--update` refuses to run without an
 * acknowledgement. The real backstop is human review of the diff; this exists so
 * that a guardrail change cannot slip through *unnoticed* in normal operation.
 *
 * Usage:
 *   node scripts/verify-immutable.mjs             # check (used by publish)
 *   node scripts/verify-immutable.mjs --update    # recompute hashes (needs IMMUTABLE_ACK)
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifestPath = join(root, "docs", "immutable.manifest.json");

/**
 * sha256 of docs/immutable.manifest.json as committed. Editing the manifest —
 * including "just updating a hash" — fails the check until this constant is
 * updated too, which is the most conspicuous diff possible.
 */
const MANIFEST_SHA256 = "d727be9a5ab9e72266ec4cbef47b019d3f9d7af3a93deb96941c78ec94354e43";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Stable text for hashing: LF endings, no trailing whitespace on any line. */
const normalize = (text) => text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");

/**
 * Extract a marked region. Regions are delimited by
 * `// #region immutable:<id>` / `// #endregion immutable:<id>` comments, which
 * keeps the boundary visible in the source itself instead of living only in a
 * manifest somewhere (a reader of prompt.ts sees that this block is load-bearing).
 */
function regionOf(source, id, path) {
	const start = `// #region immutable:${id}`;
	const end = `// #endregion immutable:${id}`;
	const from = source.indexOf(start);
	const to = source.indexOf(end);
	if (from < 0 || to < 0 || to < from) throw new Error(`region ${id} not found or malformed in ${path}`);
	return normalize(source.slice(from + start.length, to).trim());
}

async function digestOf(entry) {
	const source = await readFile(join(root, entry.path), "utf8");
	return entry.kind === "file" ? sha256(normalize(source)) : sha256(regionOf(source, entry.id, entry.path));
}

const manifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const ack = (process.env.IMMUTABLE_ACK ?? "").trim();
const update = process.argv.includes("--update");

// The manifest can only be rewritten by a human who states a reason.
if (update && !ack) {
	console.error(
		"[immutable] refusing to rewrite the manifest without a reason.\n" +
			'            Re-run as: IMMUTABLE_ACK="why this guardrail changed" npm run verify:immutable -- --update',
	);
	process.exit(1);
}

const drifted = [];
const missing = [];
for (const entry of manifest.entries) {
	let actual;
	try {
		actual = await digestOf(entry);
	} catch (err) {
		missing.push({ entry, error: err.message });
		continue;
	}
	if (actual !== entry.sha256) drifted.push({ entry, actual });
}

if (update) {
	for (const { entry, actual } of drifted) {
		entry.sha256 = actual;
	}
	const next = `${JSON.stringify(manifest, null, "\t")}\n`;
	await writeFile(manifestPath, next);
	let script = await readFile(fileURLToPath(import.meta.url), "utf8");
	script = script.replace(/const MANIFEST_SHA256 = "[0-9a-f]{64}";|const MANIFEST_SHA256 = "[^"]*";/,
		`const MANIFEST_SHA256 = "${sha256(normalize(next))}";`);
	await writeFile(fileURLToPath(import.meta.url), script);
	console.log(`[immutable] manifest updated: ${drifted.length} entr${drifted.length === 1 ? "y" : "ies"} re-hashed.`);
	console.log(`[immutable] reason recorded: ${ack}`);
	console.log("[immutable] NOTE: the manifest's own hash pin was rewritten — that is the change a reviewer must see.");
	process.exit(0);
}

if (sha256(normalize(manifestText)) !== MANIFEST_SHA256) {
	console.error("[immutable] the manifest itself changed since it was pinned.");
	console.error("            A guardrail list edit must be deliberate: re-run with --update and IMMUTABLE_ACK.");
	if (!ack) process.exit(1);
	console.error(`            IMMUTABLE_ACK="${ack}" — continuing, loudly.`);
}

if (missing.length) {
	console.error("[immutable] a guarded region is gone:");
	for (const { entry, error } of missing) console.error(`  · ${entry.id} (${entry.path}) — ${error}`);
	process.exit(1);
}

if (drifted.length === 0) {
	console.log(`[immutable] ${manifest.entries.length} guarded regions unchanged.`);
	process.exit(0);
}

console.error("[immutable] GUARDRAIL CHANGE DETECTED — these are the parts of the system that must not drift silently:");
for (const { entry } of drifted) {
	console.error(`  · ${entry.id} (${entry.path}) — ${entry.why}`);
}
if (!ack) {
	console.error(
		"\n[immutable] Refusing to continue. If this change is intentional and reviewed, re-run with a stated reason:\n" +
			'            IMMUTABLE_ACK="为什么改这条护栏" npm run release',
	);
	process.exit(1);
}
console.error(`\n[immutable] proceeding with IMMUTABLE_ACK="${ack}" — this reason must appear in the release notes.`);
process.exit(0);
