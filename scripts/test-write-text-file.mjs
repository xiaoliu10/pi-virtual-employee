/**
 * `write_text_file` — the structural fix for the Windows escaping nightmare.
 *
 * Field history (repeated, costly): to create a script the agent had no tool,
 * so it wrote files through `run_command`, which stacks THREE escaping layers —
 * the JSON tool argument, the shell's own quoting, and the target language's
 * string syntax (`python -c`, PowerShell `-Command`, cmd `echo >`). Each one
 * failed in a different way (literal `\n`, swallowed quotes, mangled Chinese,
 * `Cannot find module '...\Pi'`) and none of it had anything to do with the
 * user's actual task.
 *
 * `write_text_file` takes the file body as an ordinary argument, so there is no
 * shell in the path at all. These tests exercise the REAL filesystem (temp
 * dirs), not a mock, because the whole point is what actually lands on disk.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = mkdtempSync(join(root, "node_modules/.write-text-probe-"));
process.on("exit", () => { try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const bundle = join(outDir, "fs.mjs");
await build({
	stdin: {
		contents: `export { FileSystemService } from "./src/filesystem/filesystem-service.ts";\n\t\t\texport { createFilesystemTools } from "./src/engine/tools/filesystem.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
});
const { FileSystemService, createFilesystemTools } = await import(pathToFileURL(bundle).href);

const work = mkdtempSync(join(tmpdir(), "ve-write-"));
process.on("exit", () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } });
const allowed = join(work, "scripts");
mkdirSync(allowed, { recursive: true });

/** A ConfigStore stub: only the fields the filesystem service reads. */
function service(allowedDirs = [allowed]) {
	return new FileSystemService({ all: () => ({ filesystem: { allowedDirs } }) });
}

const PY = `import sys
def main():
    print("你好")  # 中文注释
    s = 'quotes: "double" and \\'single\\''
    print(s)
if __name__ == "__main__":
    main()
`;

test("writes the content VERBATIM — quotes, backslashes, newlines, Chinese", async () => {
	const target = join(allowed, "job.py");
	const fs = service();
	const result = await fs.writeTextFile(target, PY, true);
	assert.equal(readFileSync(target, "utf8"), PY, "byte-for-byte identical to what the model asked for");
	assert.equal(result.bytes, Buffer.byteLength(PY, "utf8"));
	assert.equal(result.overwritten, false);
	assert.match(result.firstLine, /^import sys/);
});

test("writes UTF-8 WITHOUT a BOM", async () => {
	const target = join(allowed, "nobom.py");
	await service().writeTextFile(target, "print('中文')\n", true);
	const buf = readFileSync(target);
	assert.notEqual(buf[0], 0xef, "a BOM must not be prepended");
	assert.equal(buf.subarray(3).length > 0, true);
	assert.equal(buf.toString("utf8"), "print('中文')\n");
});

test("creates missing parent directories (the caller need not pre-mkdir)", async () => {
	const target = join(allowed, "deep", "nested", "run.ps1");
	await service().writeTextFile(target, "Write-Host 'ok'\n", true);
	assert.equal(readFileSync(target, "utf8"), "Write-Host 'ok'\n");
});

test("overwriting is opt-out, and the flag is honoured", async () => {
	const target = join(allowed, "twice.py");
	await service().writeTextFile(target, "v1\n", true);
	const second = await service().writeTextFile(target, "v2\n", true);
	assert.equal(readFileSync(target, "utf8"), "v2\n");
	assert.equal(second.overwritten, true, "the result must say it replaced an existing file");

	await assert.rejects(
		() => service().writeTextFile(target, "v3\n", false),
		/已存在且未允许覆盖/,
		"overwrite:false must refuse instead of clobbering",
	);
	assert.equal(readFileSync(target, "utf8"), "v2\n", "the refused write must not touch the file");
});

test("refuses paths outside the allowed directories — including via ..", async () => {
	const outside = join(work, "secret.txt");
	writeFileSync(outside, "untouched\n");
	await assert.rejects(() => service().writeTextFile(outside, "pwned", true), /不在允许访问的目录内/);
	assert.equal(readFileSync(outside, "utf8"), "untouched\n", "the file must be byte-identical");

	const escape = join(allowed, "..", "secret.txt");
	await assert.rejects(() => service().writeTextFile(escape, "pwned", true), /不在允许访问的目录内/);
	assert.equal(readFileSync(outside, "utf8"), "untouched\n");
});

test("an EMPTY allowedDirs list refuses everything (fail closed)", async () => {
	await assert.rejects(
		() => service([]).writeTextFile(join(allowed, "x.py"), "x", true),
		/不在允许访问的目录内/,
	);
});

test("the tool returns a report the model can rely on (not a bare ok)", async () => {
	const tools = createFilesystemTools(service());
	const write = tools.find((t) => t.name === "write_text_file");
	assert.ok(write, "write_text_file must be registered");
	const res = await write.execute("call-1", { path: join(allowed, "report.py"), content: PY });
	const text = res.content.map((c) => c.text ?? "").join("");
	assert.match(text, /读回校验一致/);
	assert.match(text, /report\.py/);
	assert.equal(res.details?.ok, true);
});

test("a NON-string content is refused rather than silently stringified", async () => {
	const tools = createFilesystemTools(service());
	const write = tools.find((t) => t.name === "write_text_file");
	const res = await write.execute("call-2", { path: join(allowed, "bad.py"), content: { not: "text" } });
	const text = res.content.map((c) => c.text ?? "").join("");
	assert.match(text, /content 必须是字符串/);
	assert.equal(res.details?.ok, false);
});

test("read-back verification rejects a file that does not match the request", async () => {
	// Same class of guard as the release-asset verification: an "ok" must mean
	// the bytes on disk are the bytes requested, not that a syscall returned.
	// Force the mismatch deterministically by making the write itself silently
	// truncate (a half-written tool argument is exactly how this happens in the
	// field).
	const target = join(allowed, "trunc.py");
	const fs = service();

	const ok = await fs.writeTextFile(target, "good\n", true);
	assert.equal(ok.bytes, 5);
	assert.equal(readFileSync(target, "utf8"), "good\n");

	// Mismatch path: a surrogate-half string cannot be encoded losslessly, so
	// read-back returns a DIFFERENT string than requested → must throw.
	const lone = "half\ud800\n";
	await assert.rejects(
		() => fs.writeTextFile(join(allowed, "lone.py"), lone, true),
		/写入校验失败/,
		"lossy content must be rejected by read-back, not silently accepted",
	);
});

test("the tool is wired into the filesystem tool set and gated", async () => {
	const tools = createFilesystemTools(service());
	assert.deepEqual(
		tools.map((t) => t.name).sort(),
		["delete_files", "list_directory", "write_text_file"],
		"write must ship alongside list/delete",
	);
	// Every tool must carry a schema the harness can hand to the model.
	for (const t of tools) assert.ok(t.parameters, `${t.name} has no parameters schema`);
});
