/**
 * REAL-install probe for the upgraded pi runtime lock (not a stub).
 * Runs ensurePiRuntime with the shipped lockDir and the SAME registry chain
 * electron/main.ts uses (npmmirror → gitee-mirror → npmjs), real `npm ci`, real
 * `--version` self-check, into a temp dir — proving the box's upgrade path.
 *
 * Two deliberate differences from production, so the claim stays honest:
 *  - a user-configured `general.piRegistryUrl` override is NOT exercised (the
 *    default chain is);
 *  - `process.execPath` here is plain node, not Electron-as-Node, so the
 *    ELECTRON_RUN_AS_NODE spawn leg is not covered (the bootstrap's own 30s
 *    timeout + fall-back-to-legacy containment covers that in production).
 *
 * Manual only: scripts/run-all-tests.mjs auto-discovers `test-*.mjs`, so this
 * network-touching probe never runs in the suite. Writes only to os.tmpdir().
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = await mkdtemp(join(tmpdir(), "pi-runtime-probe-"));
let ensurePiRuntime;
try {
	const bundle = join(work, "bootstrap.mjs");
	await build({
		entryPoints: [join(root, "src/runtime/bootstrap.ts")],
		outfile: bundle,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
	});
	({ ensurePiRuntime } = await import(pathToFileURL(bundle).href));
} catch (err) {
	// A bundling/import failure must not leak the temp dir either.
	console.log(`[probe] cannot load bootstrap: ${err instanceof Error ? err.message : String(err)}`);
	await rm(work, { recursive: true, force: true });
	process.exit(1);
}

const targetDir = join(work, "pi-runtime");
const lockDir = join(root, "resources/pi-runtime-lock");
let expected;
try {
	expected = JSON.parse(await readFile(join(lockDir, "package.json"), "utf8")).dependencies["@earendil-works/pi-coding-agent"];
} catch (err) {
	console.log(`[probe] cannot read the shipped lock: ${err instanceof Error ? err.message : String(err)}`);
	await rm(work, { recursive: true, force: true });
	process.exit(1);
}
if (typeof expected !== "string") {
	console.log("[probe] lock does not pin pi-coding-agent");
	await rm(work, { recursive: true, force: true });
	process.exit(1);
}
console.log(`[probe] lock pins pi-coding-agent ${expected}`);
console.log(`[probe] installing into ${targetDir} (real npm ci, production registry chain)`);

const t0 = Date.now();
const result = await ensurePiRuntime({
	lockDir,
	targetDir,
	registries: ["https://registry.npmmirror.com", "https://registry.gitee-mirror.com", "https://registry.npmjs.org"],
	log: (l) => console.log(l),
});
console.log(`[probe] elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("[probe] result:", JSON.stringify({ status: result.status, version: result.version, source: result.source, fresh: result.fresh, attempted: result.attempted, errors: result.errors }, null, 1));

if (result.status !== "ready") {
	console.log("[probe] FAILED — the box would fall back to the legacy kernel");
	await rm(work, { recursive: true, force: true });
	process.exit(1);
}
// Prove the installed tree really is the pinned version, and that the native
// compaction fixes are present in the runtime the box will load.
let installedPkg;
let utils;
let comp;
try {
	const base = join(targetDir, "node_modules/@earendil-works/pi-coding-agent");
	installedPkg = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
	utils = await readFile(join(base, "dist/core/compaction/utils.js"), "utf8");
	comp = await readFile(join(base, "dist/core/compaction/compaction.js"), "utf8");
} catch (err) {
	console.log(`[probe] installed tree unreadable: ${err instanceof Error ? err.message : String(err)}`);
	await rm(work, { recursive: true, force: true });
	process.exit(1);
}
console.log(`[probe] installed pi-coding-agent: ${installedPkg.version}`);
// NOTE: the thinking check is a REGRESSION GUARD, not upgrade proof — 1.2.0's
// dist already omitted thinking. The discriminative checks are the version
// equality above and the #9512 cap below (present in 1.2.0, gone in 1.5.2).
console.log(`[probe] native thinking-omission: ${utils.includes("[Assistant thinking]") ? "NO (still serializes thinking)" : "YES"}`);
console.log(`[probe] native #9512 output-limit fix: ${comp.includes("0.8 * reserveTokens") ? "NO (cap still present)" : "YES"}`);
const ok = installedPkg.version === expected && !utils.includes("[Assistant thinking]") && !comp.includes("0.8 * reserveTokens");
console.log(ok ? "[probe] PASS — runtime installs, verifies, and carries both compaction fixes natively" : "[probe] CHECK FAILED");
await rm(work, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
