/**
 * Guards for the guard: the immutable-core tripwire must not be quietly
 * defanged. Run with `npm run test:immutable` (and inside `test:all`).
 *
 * verify-immutable.mjs fails a release when a pinned region changes. The way
 * that protection dies is not a hash mismatch — it is someone *deleting the
 * entry* ("this file churns too much, drop it"), or dropping the marker comments
 * mid-refactor so the region silently stops resolving, or moving the manifest's
 * own pin. Those are the cases pinned here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "docs", "immutable.manifest.json");
const verifierPath = join(root, "scripts", "verify-immutable.mjs");

const normalize = (text) => text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const manifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);

test("the guarded set still covers every load-bearing guardrail", () => {
	// Deleting an entry is the cheap way to make the tripwire pass; this list is
	// the minimum that must stay guarded.
	const required = [
		"prompt-red-lines", // credentials must never leak into replies
		"prompt-integrity", // no fabricated business data (user's red line)
		"rbac-gate", // the permission verdict itself
		"rbac-defaults", // default policy table
		"rbac-trust-boundary", // console-vs-remote trust
		"tool-gates", // single-chat + 「确认」 gates
		"updater-breakers", // circuit breakers under a bad release
		"publish-target", // where releases are uploaded
		"test-prompt", // the assertions pinning the red lines
		"test-permissions", // the assertions pinning RBAC
	];
	const ids = manifest.entries.map((e) => e.id);
	for (const id of required) {
		assert.ok(ids.includes(id), `manifest no longer guards "${id}" — if that is intentional it is a guardrail change`);
	}
	for (const entry of manifest.entries) {
		assert.ok(entry.why && entry.why.length > 8, `${entry.id} must say WHY it is guarded (a reviewer needs the reason)`);
	}
});

test("every guarded region resolves and matches its recorded hash", async () => {
	for (const entry of manifest.entries) {
		const source = await readFile(join(root, entry.path), "utf8");
		let digest;
		if (entry.kind === "file") {
			digest = sha256(normalize(source));
		} else {
			const start = `// #region immutable:${entry.id}`;
			const end = `// #endregion immutable:${entry.id}`;
			const from = source.indexOf(start);
			const to = source.indexOf(end);
			assert.ok(from >= 0 && to > from, `region ${entry.id} is missing from ${entry.path} (markers dropped in a refactor?)`);
			digest = sha256(normalize(source.slice(from + start.length, to).trim()));
		}
		assert.equal(digest, entry.sha256, `${entry.id} drifted — run verify-immutable to see it reported`);
	}
});

test("the verifier still pins the manifest's own hash", async () => {
	// Moving this pin is how the tripwire gets bypassed wholesale; it must track
	// the committed manifest exactly.
	const script = await readFile(verifierPath, "utf8");
	const pinned = /const MANIFEST_SHA256 = "([0-9a-f]{64})"/.exec(script);
	assert.ok(pinned, "verify-immutable.mjs no longer pins MANIFEST_SHA256");
	assert.equal(pinned[1], sha256(normalize(manifestText)), "the manifest changed without going through --update");
});

test("publish refuses to upload unless both gates are wired in", async () => {
	// A release path that skips the gates is the end of the whole idea.
	const script = await readFile(join(root, "scripts", "publish.mjs"), "utf8");
	assert.match(script, /verify-immutable\.mjs/, "publish must run the immutable check");
	assert.match(script, /run-all-tests\.mjs/, "publish must run the test suites");
	assert.match(script, /REFUSING TO PUBLISH/, "…and must refuse loudly when a gate fails");
});
