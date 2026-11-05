/**
 * Browser profile isolation — "copy the login profile out, then use the copy".
 *
 * FIELD 2026-11-04: two work windows shared one persistent Chromium profile and
 * the second died with exitCode=21 (SingletonLock). The model's workaround was
 * hand-writing shutil.copytree into ad-hoc scripts, which left TWELVE stale
 * spay_profile* dirs on the box and still raced. This pins the real behaviour.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const out = join(mkdtempSync(join(root, "node_modules/.profile-iso-test-")), "iso.mjs");
await build({
	stdin: { contents: 'export * from "./src/browser/profile-isolation.ts";', resolveDir: root, loader: "ts" },
	outfile: out, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { cloneBrowserProfile, cloneDirName, removeClone, sweepClones, defaultCloneRoot } =
	await import(pathToFileURL(out).href + `?t=${Date.now()}`);

/** Build a fake master profile with login state + Chromium lock files. */
function makeMaster() {
	const dir = mkdtempSync(join(tmpdir(), "ve-master-"));
	mkdirSync(join(dir, "Default"), { recursive: true });
	writeFileSync(join(dir, "Default", "Cookies"), "SESSION-COOKIE");
	writeFileSync(join(dir, "Local State"), '{"profile":{}}');
	// Chromium leaves these behind when it was killed — the exact landmine.
	writeFileSync(join(dir, "SingletonLock"), "HOST-12345");
	writeFileSync(join(dir, "SingletonCookie"), "123");
	writeFileSync(join(dir, "SingletonSocket"), "sock");
	return dir;
}

test("each clone gets its OWN directory (two runs can never share a user-data-dir)", () => {
	const master = makeMaster();
	const rootDir = mkdtempSync(join(tmpdir(), "ve-clones-"));
	const a = cloneBrowserProfile({ source: master, root: rootDir, label: "conv-111" });
	const b = cloneBrowserProfile({ source: master, root: rootDir, label: "conv-222" });
	assert.notEqual(a.profileDir, b.profileDir, "different runs must not collide on one profile");
	assert.ok(existsSync(a.profileDir) && existsSync(b.profileDir));
});

test("THE FIELD BUG: the clone carries the login state but NOT the singleton locks", () => {
	const master = makeMaster();
	const rootDir = mkdtempSync(join(tmpdir(), "ve-clones-"));
	const { profileDir } = cloneBrowserProfile({ source: master, root: rootDir, label: "c1" });

	// Login state must survive, or every run starts logged out.
	assert.ok(existsSync(join(profileDir, "Default", "Cookies")), "cookies must be copied");
	assert.ok(existsSync(join(profileDir, "Local State")));

	// The locks MUST be gone: a copy carrying SingletonLock is what produced
	// "exitCode=21 — persistent lock issue" when a second window started.
	for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
		assert.equal(existsSync(join(profileDir, f)), false, `${f} must NOT be copied`);
	}
});

test("the master profile is never written to", () => {
	const master = makeMaster();
	const rootDir = mkdtempSync(join(tmpdir(), "ve-clones-"));
	cloneBrowserProfile({ source: master, root: rootDir, label: "c2" });
	// The master keeps its locks; only copies are stripped.
	assert.ok(existsSync(join(master, "SingletonLock")), "we must not mutate the template");
});

test("a missing master fails loudly instead of silently starting logged out", () => {
	assert.throws(
		() => cloneBrowserProfile({ source: join(tmpdir(), "does-not-exist-" + Date.now()), root: mkdtempSync(join(tmpdir(), "ve-")), label: "x" }),
		/浏览器 profile 模板不存在/,
	);
});

test("reuse without force, fresh clone with force", () => {
	const master = makeMaster();
	const rootDir = mkdtempSync(join(tmpdir(), "ve-clones-"));
	const first = cloneBrowserProfile({ source: master, root: rootDir, label: "c3" });
	assert.equal(first.reused, false);
	const second = cloneBrowserProfile({ source: master, root: rootDir, label: "c3" });
	assert.equal(second.reused, true, "same label reuses the existing copy");
	const third = cloneBrowserProfile({ source: master, root: rootDir, label: "c3", force: true });
	assert.equal(third.reused, false, "force re-copies from the master");
});

test("labels are sanitized into safe directory names", () => {
	assert.equal(cloneDirName("conv/111"), "ve-browser-conv_111");
	assert.equal(cloneDirName("dt:group:abc=="), "ve-browser-dt_group_abc");
	assert.equal(cloneDirName(""), "ve-browser-default", "empty label must still be usable");
	assert.ok(!cloneDirName("../../etc/passwd").includes(".."), "no traversal");
});

test("removeClone deletes just that copy", () => {
	const master = makeMaster();
	const rootDir = mkdtempSync(join(tmpdir(), "ve-clones-"));
	const a = cloneBrowserProfile({ source: master, root: rootDir, label: "keep" });
	const b = cloneBrowserProfile({ source: master, root: rootDir, label: "drop" });
	removeClone(b.profileDir);
	assert.equal(existsSync(b.profileDir), false);
	assert.ok(existsSync(a.profileDir), "the other run is untouched");
});

test("sweepClones reclaims stale copies (field: 12 orphaned dirs) but keeps fresh ones", () => {
	const rootDir = mkdtempSync(join(tmpdir(), "ve-clones-"));
	mkdirSync(join(rootDir, "ve-browser-old"), { recursive: true });
	const fresh = join(rootDir, "ve-browser-fresh");
	mkdirSync(fresh, { recursive: true });
	mkdirSync(join(rootDir, "not-ours"), { recursive: true });

	// Sweep with a point 2h in the FUTURE so both existing dirs are "old"...
	const removed = sweepClones(rootDir, 0, Date.now() + 7_200_000);
	assert.equal(removed.length, 2, "both ve-browser-* copies reclaimed");
	assert.ok(existsSync(join(rootDir, "not-ours")), "never touches directories we did not create");
	assert.equal(readdirSync(rootDir).filter((n) => n.startsWith("ve-browser-")).length, 0);
});

test("sweepClones keeps copies younger than the limit", () => {
	const rootDir = mkdtempSync(join(tmpdir(), "ve-clones-"));
	mkdirSync(join(rootDir, "ve-browser-active"), { recursive: true });
	const removed = sweepClones(rootDir, 60 * 60_000, Date.now());
	assert.deepEqual(removed, [], "an in-use copy must survive the sweep");
});

test("default root is under the OS temp dir, not the app profile", () => {
	assert.ok(defaultCloneRoot().startsWith(tmpdir()));
});
