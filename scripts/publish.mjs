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
 *   6. push the version tag to GitHub and create/update the GitHub release
 *      with the Windows installer + macOS dmg (both REQUIRED; see
 *      publishToGitHub below).
 *
 * Auth: GITEE_TOKEN env (personal access token). Dry-run: --dry-run lists
 * what would be uploaded without touching Gitee.
 */
import { createHash } from "node:crypto";
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
				// Every artifact carries its own sha512 so verification can compare
				// PUBLISHED bytes against local bytes — the HEAD-302 check missed a
				// CDN bad-body for 20 minutes on 2026-11-03 and wedged auto-update.
				const sha512 = createHash("sha512").update(await readFile(p)).digest("base64");
				out.push({ name, path: p, size: s.size, sha512 });
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
	if (process.env.PUBLISH_SKIP_GATES === "1") {
		// Release proxy has no repo: accept the override target so the Gitee
		// release still records the true source commit.
		const forced = process.env.PUBLISH_SOURCE_SHA ?? "";
		if (!/^[0-9a-f]{40}$/i.test(forced)) throw new Error("PUBLISH_SKIP_GATES=1 requires PUBLISH_SOURCE_SHA=<40-hex commit>");
		return forced;
	}
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

/** Gitee may reuse an old tag despite target_commitish; update the Git ref first. */
function syncLatestTag() {
	if (process.env.PUBLISH_SKIP_GATES === "1") {
		// No git repo on a release proxy; the build machine pushes tags.
		console.log("[publish] tag sync SKIPPED (PUBLISH_SKIP_GATES=1) — build machine owns git refs");
		return;
	}
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

/** Re-fetch the release and verify every asset BYTE-FOR-BYTE.
 *
 * History (field 2026-11-03): the old check was a HEAD per asset, treating
 * Gitee's 302→CDN as "live". That night the CDN served a TRUNCATED/STALE body
 * for the `latest`-ref asset (94.7 MB instead of 99.3 MB) for roughly the
 * first 20 minutes after publishing — HEAD still returned 302, so publish
 * declared victory while every auto-update download on the box failed its
 * sha512 check, wedging three profiles into an update-retry loop exactly when
 * an incident response was restarting them. The only reliable check is to
 * download the published bytes back and compare digests; a mismatch re-uploads
 * (bounded retries) and re-verifies, so a silent CDN bad-body can no longer
 * ship as a "verified" release.
 */
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
		if (a.sha512) {
			await verifyAssetBytes(asset, a, releaseId);
		} else {
			// No digest recorded for this artifact (e.g. the feed yml): a live
			// URL is the best we can do — but say so, loudly.
			const hr = await fetch(asset.browser_download_url, { method: "HEAD", redirect: "manual" });
			if (!hr.ok && hr.status !== 302) throw new Error(`verify: ${a.name} HEAD ${hr.status}`);
			console.log(`[publish] verified ${a.name} (URL-only, no digest: ${hr.status === 302 ? "302→cdn" : hr.status})`);
		}
	}
}

/** Download the published asset back and compare its sha512 to the local file.
 * Gitee's CDN has served truncated/stale bodies right after an upload (field
 * 2026-11-03): a mismatch triggers one re-upload + re-verify before failing
 * the release. Large artifacts need a generous read timeout. */
async function verifyAssetBytes(asset, local, releaseId) {
	const maxAttempts = 2;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let digest = "";
		let size = 0;
		try {
			// Follow the 302 manually: fetch() follows redirects by default, but
			// explicit handling keeps the CDN hop visible in the log.
			const res = await fetch(asset.browser_download_url, { redirect: "follow" });
			if (!res.ok) throw new Error(`GET ${res.status}`);
			const buf = Buffer.from(await res.arrayBuffer());
			size = buf.length;
			digest = createHash("sha512").update(buf).digest("base64");
		} catch (err) {
			console.warn(`[publish] verify ${asset.name}: download failed (${err instanceof Error ? err.message : err})`);
		}
		if (digest && digest === local.sha512) {
			console.log(`[publish] verified ${asset.name} (bytes ${(size / 1_048_576).toFixed(1)}MB sha512 match)`);
			return;
		}
		console.warn(`[publish] verify ${asset.name}: BYTE MISMATCH (got ${size}B vs local ${local.size}B) — attempt ${attempt}/${maxAttempts}`);
		if (attempt < maxAttempts) {
			await reuploadAsset(asset, local, releaseId);
			continue;
		}
	}
	throw new Error(
		`verify: ${asset.name} content mismatch after ${maxAttempts} attempts — the published bytes do not match the local file. ` +
		`This is the exact failure that wedged the box's auto-update on 2026-11-03; fix the CDN/upload before publishing.`,
	);
}

/** Delete + re-upload one asset on the release (Gitee API v5). */
async function reuploadAsset(asset, local, releaseId) {
	const del = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/assets/${asset.id}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
	if (!del.ok && del.status !== 404) console.warn(`[publish] re-upload: delete old asset ${del.status} (continuing)`);
	const buf = await readFile(local.path);
	const form = new FormData();
	form.append("file", new Blob([buf]), asset.name);
	const up = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/${releaseId}/files?access_token=${encodeURIComponent(token)}`, {
		method: "POST", body: form,
	});
	if (!up.ok) throw new Error(`re-upload ${asset.name} failed: ${up.status}`);
	console.log(`[publish] re-uploaded ${asset.name}`);
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
	// Release-proxy mode: the artifacts were gated on the build machine and this
	// host only uploads them (field 2026-11-03 — build box had no Gitee route).
	// Loud, explicit, and opt-in; never set it where the gates have not run.
	if (process.env.PUBLISH_SKIP_GATES === "1") {
		console.log(`[publish] gate SKIPPED (PUBLISH_SKIP_GATES=1): ${label}`);
		return;
	}
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

/**
 * GitHub release: the same version tag on GitHub carries the Windows installer
 * AND the macOS dmg. Gitee stays Windows-only — it is the auto-update feed the
 * Windows box pulls from, and its 100 MB asset cap makes big artifacts a poor
 * fit. BOTH packages are required here: a GitHub release missing the mac dmg
 * is exactly the half-published state the artifact gate exists to prevent.
 * Uploads go through the `gh` CLI (pre-authenticated); the version tag is
 * pushed first so the release points at the released commit.
 */
const GH_REMOTE = "github";
const GH_REPO = `${OWNER}/${REPO}`;
const GH_TAG = `v${version}`;

async function publishToGitHub(artifacts) {
	const dmgName = `Pi-Virtual-Employee-Mac-${version}-arm64.dmg`;
	const dmgPath = join(releaseDir, dmgName);
	let dmgSize;
	try {
		dmgSize = (await stat(dmgPath)).size;
	} catch {
		console.error(`[publish] missing artifact: ${dmgName} (run package:mac first — GitHub releases need the Windows AND macOS packages)`);
		process.exit(1);
	}
	// latest.yml is the Gitee feed's metadata (its URLs point at Gitee) — not
	// part of the GitHub release.
	const ghArtifacts = [
		...artifacts.filter((a) => a.name !== "latest.yml"),
		{ name: dmgName, path: dmgPath, size: dmgSize },
	];
	if (dryRun) {
		console.log(`[publish] (dry-run) would push ${GH_TAG} to ${GH_REMOTE} and create the GitHub release with:`);
		for (const a of ghArtifacts) console.log(`  ${a.name}  ${(a.size / 1048576).toFixed(1)} MiB`);
		return;
	}

	console.log(`[publish] pushing ${GH_TAG} to ${GH_REMOTE} …`);
	execFileSync("git", ["push", GH_REMOTE, `refs/tags/${GH_TAG}`], { cwd: root, stdio: "inherit" });

	const ghArgs = ["release", "--repo", GH_REPO];
	const existing = spawnSync("gh", [...ghArgs, "view", GH_TAG, "--json", "name"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const paths = ghArtifacts.map((a) => a.path);
	if (existing.status === 0) {
		console.log(`[publish] GitHub release ${GH_TAG} exists; uploading assets (clobber)`);
		execFileSync("gh", [...ghArgs, "upload", GH_TAG, "--clobber", ...paths], { cwd: root, stdio: "inherit" });
	} else {
		console.log(`[publish] creating GitHub release ${GH_TAG}`);
		execFileSync("gh", [...ghArgs, "create", GH_TAG, "--title", `v${version}`, "--notes", releaseNotes, ...paths], { cwd: root, stdio: "inherit" });
	}

	const check = JSON.parse(spawnSync("gh", [...ghArgs, "view", GH_TAG, "--json", "assets"], { encoding: "utf8" }).stdout ?? "{}");
	const got = new Set((check.assets ?? []).map((a) => a.name));
	for (const a of ghArtifacts) {
		if (!got.has(a.name)) throw new Error(`verify: ${a.name} missing from GitHub release assets`);
		console.log(`[publish] verified on GitHub: ${a.name}`);
	}
}

if (process.env.PUBLISH_GITEE_ONLY === "1") {
	console.log("[publish] PUBLISH_GITEE_ONLY=1 — skipping the GitHub leg (publish it later from a host with GitHub access; the Gitee feed is live)");
} else if (!dryRun) {
	try {
		await publishToGitHub(artifacts);
	} catch (err) {
		console.error(`[publish] GITHUB PUBLISH FAILED: ${err instanceof Error ? err.message : String(err)}`);
		console.error("[publish] The Gitee feed above is already live; re-run `npm run release` after fixing (it safely rebuilds both).");
		process.exit(1);
	}
} else {
	await publishToGitHub(artifacts);
}

console.log("[publish] done. Auto-update feed now serves:");
console.log(`  ${API.replace("api/v5", "")}${OWNER}/${REPO}/releases/download/${TAG}/latest.yml`);
