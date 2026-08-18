#!/usr/bin/env node
/**
 * Publish Windows + Linux installers to the Gitee `latest` release.
 *
 * Flow:
 *   1. require electron-builder's output under release/ (exe, AppImage, both
 *      latest*.yml + .blockmap). Fail fast if anything's missing — partial
 *      uploads are the failure mode we can least afford (auto-update would
 *      see a latest.yml pointing at a not-yet-uploaded asset).
 *   2. delete the existing `latest` release + tag on Gitee (the user-chosen
 *      "rebuild latest" strategy — latest.yml always matches the newest build).
 *   3. create a fresh `latest` release targeting the current HEAD commit.
 *   4. upload every artifact to the new release.
 *   5. re-fetch the release and verify every asset's browser_download_url is
 *      reachable (HEAD) so we never advertise a dead link.
 *
 * Auth: GITEE_TOKEN env (personal access token). Dry-run: --dry-run lists
 * what would be uploaded without touching Gitee.
 */
import { readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const releaseDir = join(root, "release");

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
const OWNER = "xiaoliu10";
const REPO = "pi-virtual-employee";
const TAG = "latest";
const API = "https://gitee.com/api/v5";

const token = process.env.GITEE_TOKEN;
const dryRun = process.argv.includes("--dry-run");
if (!token && !dryRun) {
	console.error("[publish] GITEE_TOKEN not found. Put it in .env (see .env.example) or pass GITEE_TOKEN=xxx npm run release.");
	process.exit(1);
}

/** The artifacts a complete release needs: build outputs + their yml + blockmap. */
async function collectArtifacts() {
	const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
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
				console.error(`[publish] missing artifact: ${name} (run package:win + package:linux first)`);
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

async function deleteRelease(releaseId) {
	if (dryRun) { console.log(`[publish] (dry-run) would delete release ${releaseId}`); return; }
	const r = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/${releaseId}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
	if (!r.ok) console.warn(`[publish] delete release ${releaseId} returned ${r.status} (continuing)`);
	// Tag may linger even after the release is gone; delete it so create doesn't 409.
	const rt = await fetch(`${API}/repos/${OWNER}/${REPO}/tags/${TAG}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
	if (!rt.ok && rt.status !== 404) console.warn(`[publish] delete tag ${TAG} returned ${rt.status} (continuing)`);
}

async function createLatestRelease() {
	const sha = headSha();
	const body = {
		access_token: token,
		tag_name: TAG,
		name: `最新版 (自动发布)`,
		body: `由 scripts/publish.mjs 自动发布的最新安装包。Windows 与 Linux 版本同步。`,
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

const artifacts = await collectArtifacts();
console.log(`[publish] ${artifacts.length} artifacts to publish (${dryRun ? "DRY RUN" : "LIVE"}):`);
for (const a of artifacts) console.log(`  ${a.name}  ${(a.size / 1048576).toFixed(1)} MiB`);

const existing = await findLatestRelease();
if (existing) {
	console.log(`[publish] found existing ${TAG} release (id=${existing}); rebuilding`);
	await deleteRelease(existing);
}
const rel = await createLatestRelease();
for (const a of artifacts) await uploadAsset(rel.id, a);
await verifyAssets(rel.id, artifacts);
console.log("[publish] done. Auto-update feed now serves:");
console.log(`  ${API.replace("api/v5", "")}${OWNER}/${REPO}/releases/download/${TAG}/latest.yml`);
