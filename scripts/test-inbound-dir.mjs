/**
 * Inbound file location tests (field 2026-09-18): received files landed in OS
 * Temp (pi-ve-inbound), OUTSIDE the filesystem allowlist, so structured reads
 * of a just-sent xlsx were refused. The app now stores them under
 * <userData>/inbound and allowlists that dir automatically.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.inbound-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
await build({
	stdin: {
		contents: `
			import { ConfigStore } from "./src/db/config-store.ts";
			export { ConfigStore };
			export { FileSystemService } from "./src/filesystem/filesystem-service.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(workDir, "inbound.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { ConfigStore, FileSystemService } = await import(pathToFileURL(join(workDir, "inbound.mjs")).href);

function service(t) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	t.after(() => db.close());
	return new FileSystemService(new ConfigStore(db));
}

test("app-registered inbound dir is accessible alongside configured allowlist", (t) => {
	const fs = service(t);
	const inbound = join("/tmp", "fake-profile", "inbound");
	fs.addAllowedDir(inbound);
	const dirs = fs.allowedDirs();
	assert.ok(dirs.includes(inbound));
	// Nested file is inside the allowlist; a sibling dir is not.
	const nested = join(inbound, "sub", "a.xlsx");
	assert.ok(dirs.some((d) => nested === d || nested.startsWith(d + "/") || nested.startsWith(d + "\\")));
	const sibling = join("/tmp", "fake-profile", "other");
	assert.ok(!dirs.some((d) => sibling === d || sibling.startsWith(d + "/") || sibling.startsWith(d + "\\")));
});

test("addAllowedDir is idempotent and ignores empty values", (t) => {
	const fs = service(t);
	fs.addAllowedDir("/x");
	fs.addAllowedDir("/x");
	fs.addAllowedDir(undefined);
	fs.addAllowedDir("");
	assert.deepEqual(fs.allowedDirs().filter((d) => d === "/x"), ["/x"]);
});
