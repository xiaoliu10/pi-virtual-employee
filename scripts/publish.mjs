#!/usr/bin/env node
/**
 * Publish the Windows installer and update feed to the Gitee `latest` release.
 *
 * Flow:
 *   1. require electron-builder's output under release/ (exe, latest.yml and
 *      .blockmap). Fail fast if anything's missing — partial
 *      uploads are the failure mode we can least afford (auto-update would
 *      see a latest.yml pointing at a not-yet-uploaded asset).
 *   2. explicitly move the remote `latest` Git tag to HEAD, then delete the
 *      existing release (the user-chosen "rebuild latest" strategy).
 *   3. create a fresh `latest` release targeting the current HEAD commit.
 *   4. upload every artifact to the new release.
 *   5. re-fetch the release and verify every asset's browser_download_url is
 *      reachable (HEAD) so we never advertise a dead link.
 *
 * Auth: GITEE_TOKEN env (personal access token). Dry-run: --dry-run lists
 * what would be uploaded without touching Gitee.
 */
import { readFile, stat } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const releaseDir = join(root, "release");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const notesPath = join(root, "docs", "releases", `v${version}.md`);
const releaseNotes = await readFile(notesPath, "utf8").catch((err) => {
	if (err.code === "ENOENT") return `Windows x64 v${version} 安装包与自动更新文件。`;
	throw err;
});

/**
 * Load .env (git-ignored) so `npm run release` works without exporting env
 * vars each time. Plain KEY=VALUE parser: ignores comments (#) and blank lines;
 * does NOT interpolate or unquote — the token has no special chars. Process env
 * already set on the command line wins (we never overwrite an existing value).
 */
async function loadDotEnv() {
	let text;
	try { text = await readFile(join(root, ".env"), "utf8"); } catch { return; }
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		if (!(key in process.env)) process.env[key] = val;
	}
}

await loadDotEnv();

// Gitee target — keep in sync with package.json build.publish and updater.ts.
// #region immutable:publish-target
const OWNER = "xiaoliu10";
const REPO = "pi-virtual-employee";
const TAG = "latest";
// #endregion immutable:publish-target
const API = "https://gitee.com/api/v5";

const token = process.env.GITEE_TOKEN;
const dryRun = process.argv.includes("--dry-run");
if (!token && !dryRun) {
	console.error("[publish] GITEE_TOKEN not found. Put it in .env (see .env.example) or pass GITEE_TOKEN=xxx npm run release.");
	process.exit(1);
}

/** The artifacts a complete release needs: build outputs + their yml + blockmap. */
async function collectArtifacts() {
	// Windows only: Gitee caps a single release asset at 100 MB, and the Linux
	// AppImage (~135 MB) / tar.gz (~111 MB) both exceed it. Linux distribution
	// will move to GitHub Releases (no such cap) — for now this release carries
	// the Windows installer + its auto-update feed only.
	const expect = {
		win: [
			`Pi-Virtual-Employee-Setup-${version}-x64.exe`,
			`Pi-Virtual-Employee-Setup-${version}-x64.exe.blockmap`,
			`latest.yml`,
		],
	};
	const out = [];
	for (const group of Object.values(expect)) {
		for (const name of group) {
			const p = join(releaseDir, name);
			try {
				const s = await stat(p);
				out.push({ name, path: p, size: s.size });
			} catch {
				console.error(`[publish] missing artifact: ${name} (run package:win first)`);
				process.exit(1);
			}
		}
	}
	return out;
}

/** Resolve the existing `latest` release id (or null).
 *
 * Gitee quirk: a release that doesn't exist for the tag returns HTTP 200 with
 * a literal `null` body (NOT 404). So we must treat `j == null` as "not found"
 * after a 200, not just a 404 status. */
async function findLatestRelease() {
	if (dryRun) { console.log(`[publish] (dry-run) would look up existing ${TAG} release`); return null; }
	const url = `${API}/repos/${OWNER}/${REPO}/releases/tags/${TAG}?access_token=${encodeURIComponent(token)}`;
	const r = await fetch(url);
	if (r.status === 404) return null;
	if (!r.ok) throw new Error(`findLatestRelease: ${r.status} ${await r.text()}`);
	const j = await r.json();
	if (!j || typeof j.id !== "number") return null; // 200 + null body = no release for this tag
	return j.id;
}

/** HEAD-commitish Gitee will target the new release at. */
function headSha() {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

/** Gitee may reuse an old tag despite target_commitish; update the Git ref first. */
function syncLatestTag() {
	const sha = headSha();
	if (dryRun) { console.log(`[publish] (dry-run) would move remote ${TAG} tag to ${sha.slice(0, 8)}`); return; }
	const ref = `refs/tags/${TAG}`;
	const current = execFileSync("git", ["ls-remote", "origin", ref], { cwd: root, encoding: "utf8" }).trim().split(/\s+/)[0];
	// An empty expected value only permits creating a missing tag. A changed
	// remote value refuses the push rather than overwriting a concurrent release.
	execFileSync("git", ["push", `--force-with-lease=${ref}:${current}`, "origin", `${sha}:${ref}`], { cwd: root, stdio: "inherit" });
	const updated = execFileSync("git", ["ls-remote", "origin", ref], { cwd: root, encoding: "utf8" }).trim().split(/\s+/)[0];
	if (updated !== sha) throw new Error(`remote ${TAG} tag does not match release source`);
}

async function deleteRelease(releaseId) {
	if (dryRun) { console.log(`[publish] (dry-run) would delete release ${releaseId}`); return; }
	const r = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/${releaseId}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
	if (!r.ok) throw new Error(`delete release ${releaseId} returned ${r.status}`);
}

async function createLatestRelease() {
	const sha = headSha();
	const body = {
		access_token: token,
		tag_name: TAG,
		name: `最新版 v${version}`,
		body: releaseNotes,
		target_commitish: sha,
		prerelease: false,
	};
	if (dryRun) { console.log(`[publish] (dry-run) would create release tag=${TAG} target=${sha.slice(0,8)}`); return { id: "dry-run", assets: [] }; }
	const r = await fetch(`${API}/repos/${OWNER}/${REPO}/releases`, {
		method: "POST",
		headers: { "Content-Type": "application/json;charset=UTF-8" },
		body: JSON.stringify(body),
	});
	if (!r.ok) throw new Error(`createRelease: ${r.status} ${await r.text()}`);
	const j = await r.json();
	console.log(`[publish] created release ${j.id} tag=${TAG} target=${sha.slice(0,8)}`);
	return j;
}

/** Upload one asset via the attach_files multipart endpoint. */
async function uploadAsset(releaseId, artifact) {
	if (dryRun) { console.log(`[publish] (dry-run) would upload ${artifact.name} (${artifact.size} bytes)`); return; }
	const form = new FormData();
	form.append("access_token", token);
	form.append("file", new Blob([await readFile(artifact.path)]), artifact.name);
	const r = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/${releaseId}/attach_files`, {
		method: "POST",
		body: form,
	});
	if (!r.ok) throw new Error(`upload ${artifact.name}: ${r.status} ${await r.text()}`);
	const j = await r.json();
	const url = j.browser_download_url;
	console.log(`[publish] uploaded ${artifact.name} → ${url}`);
}

/** Re-fetch the release and HEAD-check every asset URL is live. */
async function verifyAssets(releaseId, artifacts) {
	if (dryRun) { console.log("[publish] (dry-run) skipping verification"); return; }
	const r = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/${releaseId}?access_token=${encodeURIComponent(token)}`);
	if (!r.ok) throw new Error(`verify: re-fetch release ${r.status}`);
	const j = await r.json();
	if (j.target_commitish !== headSha()) throw new Error(`verify: release source does not match HEAD (${j.target_commitish})`);
	const got = new Set((j.assets || []).map((a) => a.name));
	for (const a of artifacts) {
		if (!got.has(a.name)) throw new Error(`verify: ${a.name} missing from release assets`);
		const asset = j.assets.find((x) => x.name === a.name);
		const hr = await fetch(asset.browser_download_url, { method: "HEAD", redirect: "manual" });
		// Gitee redirects to its CDN (302) — that's a live asset.
		if (!hr.ok && hr.status !== 302) throw new Error(`verify: ${a.name} HEAD ${hr.status}`);
		console.log(`[publish] verified ${a.name} (${hr.status === 302 ? "302→cdn" : hr.status})`);
	}
}

/**
 * Publish gates. Two independent things must hold before a single byte goes out:
 *
 *  1. the guarded regions (prompt red lines, RBAC enforcement, tool gates, update
 *     breakers, upload target, and the test assertions that pin them) must be
 *     UNCHANGED — a guardrail change has to be explicit, see verify-immutable.mjs;
 *  2. every test suite must pass. This is the gate self-modifying changes have to
 *     pass: before it existed, publishing required only "typecheck + artifacts
 *     exist", so nothing stopped a change that broke behaviour.
 *
 * Both are skipped in --dry-run (which touches nothing anyway).
 */
function gate(label, command, args) {
	if (dryRun) {
		console.log(`[publish] (dry-run) would run gate: ${command} ${args.join(" ")}`);
		return;
	}
	console.log(`[publish] gate: ${label} …`);
	const res = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
	if (res.status !== 0) {
		console.error(`\n[publish] REFUSING TO PUBLISH: ${label} failed (exit ${res.status}).`);
		console.error("[publish] Nothing was uploaded. Fix the failure, or (for a reviewed guardrail change) state a reason via IMMUTABLE_ACK=\"…\".");
		process.exit(1);
	}
}

gate("immutable core unchanged", process.execPath, [join(here, "verify-immutable.mjs")]);
gate("all test suites", process.execPath, [join(here, "run-all-tests.mjs")]);

const artifacts = await collectArtifacts();
console.log(`[publish] ${artifacts.length} artifacts to publish (${dryRun ? "DRY RUN" : "LIVE"}):`);
for (const a of artifacts) console.log(`  ${a.name}  ${(a.size / 1048576).toFixed(1)} MiB`);

const existing = await findLatestRelease();
syncLatestTag();
if (existing) {
	console.log(`[publish] found existing ${TAG} release (id=${existing}); rebuilding`);
	await deleteRelease(existing);
}
const rel = await createLatestRelease();
for (const a of artifacts) await uploadAsset(rel.id, a);
await verifyAssets(rel.id, artifacts);

/**
 * Rollback targets. The `latest` release is rebuilt on every publish (the feed
 * URL must always carry the newest latest.yml), which means the previous
 * installer's URL dies with it — no way back to the version that worked, and no
 * stable link to hand anyone. So each publish ALSO leaves a version-tagged
 * release holding the same assets, and older ones are swept beyond KEEP.
 *
 * Deliberately non-fatal: the feed is what users run on, so a failure here must
 * never leave a half-published release. It is reported, not fatal.
 */
async function retainVersionRelease() {
	const tag = `v${version}`;
	try {
		const q = await fetch(`${API}/repos/${OWNER}/${REPO}/releases?access_token=${encodeURIComponent(token)}&per_page=40`);
		if (!q.ok) throw new Error(`list releases: ${q.status}`);
		const all = await q.json();
		if (all.some((r) => r.tag_name === tag)) {
			console.log(`[publish] version release ${tag} already exists — keeping it`);
		} else {
			const sha = headSha();
			const cr = await fetch(`${API}/repos/${OWNER}/${REPO}/releases`, {
				method: "POST",
				headers: { "Content-Type": "application/json;charset=UTF-8" },
				body: JSON.stringify({
					access_token: token,
					tag_name: tag,
					name: `v${version}`,
					body: releaseNotes,
					target_commitish: sha,
					prerelease: false,
				}),
			});
			if (!cr.ok) throw new Error(`create ${tag}: ${cr.status} ${await cr.text()}`);
			const release = await cr.json();
			for (const a of artifacts) await uploadAsset(release.id, a);
			console.log(`[publish] retained rollback release ${tag} (id=${release.id})`);
		}
		// Sweep older version releases, keeping the newest KEEP.
		// The list above was fetched BEFORE this version's release was created, so the
		// current tag must be included explicitly — otherwise each publish keeps
		// KEEP+1 (measured: v0.2.65–68 were all still present while KEEP=3).
		const versioned = all
			.map((r) => ({ id: r.id, tag: r.tag_name }))
			.filter((r) => /^v\d+\.\d+\.\d+$/.test(r.tag))
			.concat([{ id: -1, tag }])
			.sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
		const doomed = versioned.slice(0, Math.max(0, versioned.length - KEEP_VERSION_RELEASES));
		for (const r of doomed) {
			await deleteRelease(r.id);
			console.log(`[publish] swept old rollback release ${r.tag}`);
		}
	} catch (err) {
		console.warn(`[publish] WARNING: could not retain a rollback release: ${err instanceof Error ? err.message : String(err)}`);
		console.warn("[publish] the feed itself is fine; version history is best-effort.");
	}
}

const KEEP_VERSION_RELEASES = 3;
if (!dryRun) await retainVersionRelease();
else console.log("[publish] (dry-run) would retain a version-tagged rollback release");

console.log("[publish] done. Auto-update feed now serves:");
console.log(`  ${API.replace("api/v5", "")}${OWNER}/${REPO}/releases/download/${TAG}/latest.yml`);
