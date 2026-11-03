/**
 * Windows script-execution fixes (2026-11-03).
 *
 * Field: running `python spay_do_login.py <5 args>` failed repeatedly, for
 * reasons unrelated to the script —
 *
 *   1. QUOTING   — `cmd.exe /d /s /c` re-tokenizes, so a space inside an
 *                  argument splits it; `Start-Process` without quotes gave
 *                  `Cannot find module '...\Pi'`.
 *   2. ENCODING  — Chinese Windows writes CP936 to a pipe; `chcp 65001` does
 *                  not change that (it only affects the console), so every
 *                  Chinese path came out as mojibake.
 *   3. ESCAPING  — quoting for PowerShell AND escaping for the layer above.
 *
 * Two fixes, both tested here against REAL decoders / REAL files:
 *   - `src/engine/chunk-decoder.ts`: probe strict UTF-8, fall back to GBK, and
 *     HOLD an incomplete UTF-8 tail instead of misreading it as GBK.
 *   - `src/engine/tools/run-script.ts`: arguments go into a JSON file, so the
 *     command line carries no user data at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.run-script-probe");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: {
		contents: `export { createChunkDecoder, utf8State, isUtf8 } from "./src/engine/chunk-decoder.ts";
			export { createRunScriptTool, buildCommand, inferRuntime, paramDirName } from "./src/engine/tools/run-script.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { createChunkDecoder, utf8State, createRunScriptTool, buildCommand, inferRuntime, paramDirName } =
	await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

// Real byte sequences: 「中文」 in GBK and in UTF-8.
const GBK = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
const UTF8 = Buffer.from("中文", "utf8");
const drain = (chunks) => {
	const d = createChunkDecoder();
	let out = "";
	for (const c of chunks) out += d.write(c);
	return out + d.end();
};

// ---- Encoding ----

test("GBK output decodes to real Chinese (the mojibake fix)", () => {
	assert.equal(drain([GBK]), "中文");
});

test("UTF-8 output is untouched (no regression for our own shells)", () => {
	assert.equal(drain([UTF8]), "中文");
});

test("an ASCII banner does not lock the stream to UTF-8 before GBK arrives", () => {
	assert.equal(drain([Buffer.from("ok "), GBK]), "ok 中文");
});

test("a UTF-8 character split across chunks is HELD, not misread as GBK", () => {
	// This is the trap: a 2-byte prefix of a 3-byte character is not valid UTF-8,
	// and the naive probe therefore classified every chunk-split UTF-8 stream as
	// GBK, turning it into garbage.
	assert.equal(utf8State(UTF8.subarray(0, 2)), "incomplete");
	assert.equal(drain([UTF8.subarray(0, 2), UTF8.subarray(2)]), "中文");
	assert.equal(drain([...UTF8].map((b) => Buffer.from([b]))), "中文");
});

test("a GBK character split across chunks decodes correctly", () => {
	assert.equal(drain([GBK.subarray(0, 3), GBK.subarray(3)]), "中文");
	assert.equal(drain([...GBK].map((b) => Buffer.from([b]))), "中文");
});

test("a GBK character with a completion byte that also looks like a UTF-8 tail", () => {
	// 0xB4 0x0F is not a UTF-8 continuation, so this cannot be UTF-8 at all.
	const mixed = Buffer.concat([Buffer.from("C:\\"), Buffer.from([0xd6, 0xd0])]);
	assert.equal(utf8State(mixed), "invalid");
	assert.equal(drain([mixed]), "C:\\中");
});

// ---- run_script ----

test("inferRuntime maps every supported extension", () => {
	assert.equal(inferRuntime(".py"), "python");
	assert.equal(inferRuntime(".PS1"), "powershell");
	assert.equal(inferRuntime(".cjs"), "node");
	assert.equal(inferRuntime(".bat"), "cmd");
	assert.equal(inferRuntime(".sh"), "sh");
});

test("the command line carries the two PATHS but no parameter data", () => {
	const cmd = buildCommand("python", "C:\\Users\\me\\my job\\login.py", "C:\\ud\\script-params\\login\\params.json");
	// Note: the rendered command has SINGLE backslashes (they are path separators,
	// not escapes), so the regex needs one escaped pair each.
	assert.equal(cmd, 'python "C:\\Users\\me\\my job\\login.py" --params-file "C:\\ud\\script-params\\login\\params.json"');
	// The whole point: a value with a space/quote never reaches argv.
	assert.ok(!cmd.includes("secret-value"));
});

test("run_script writes params.json (UTF-8) and passes ONLY its path", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "ve-run-script-"));
	const script = join(userDataDir, "job.py");
	const writes = [];
	try {
		let seen = null;
		const tool = createRunScriptTool({
			userDataDir,
			config: {}, resolveActor: () => ({}), onConfigChanged: () => {}, conversationId: "dt:x",
			runCommand: async (input) => { seen = input; return { text: "ok" }; },
		});
		const result = await tool.execute("c1", {
			script,
			params: { account: "user name with spaces", note: 'he said "hi"', n: 3 },
		});
		const text = result.content.map((c) => c.text).join("\n");
		assert.match(text, /参数已写入/);

		// The parameter file exists and round-trips EXACTLY — quotes and spaces
		// included, which is impossible to guarantee through argv.
		// The directory carries a hash of the full script path so same-named
		// scripts in different folders never share a params file.
		const dirName = paramDirName(script);
		assert.match(dirName, /^job-[0-9a-f]{8}$/, `param dir must be stem+hash, got ${dirName}`);
		const file = join(userDataDir, "script-params", dirName, "params.json");
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(parsed, { account: "user name with spaces", note: 'he said "hi"', n: 3 });

		// And the command line references the file, not the values.
		assert.ok(seen, "run_command must be invoked");
		assert.ok(seen.command.includes(file), `command must point at the param file: ${seen.command}`);
		assert.ok(!seen.command.includes("user name with spaces"), "values must not reach argv");
		void writes;
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});

test("run_script refuses a relative path and an unsupported extension", async () => {
	const tool = createRunScriptTool({
		userDataDir: tmpdir(),
		config: {}, resolveActor: () => ({}), onConfigChanged: () => {}, conversationId: "dt:x",
		runCommand: async () => ({ text: "should not run" }),
	});
	const rel = await tool.execute("c1", { script: "job.py" });
	assert.match(rel.content.map((c) => c.text).join(""), /绝对路径/);
	const exe = await tool.execute("c2", { script: "/usr/bin/whatever.exe" });
	assert.match(exe.content.map((c) => c.text).join(""), /不支持的脚本扩展名/);
});

test("run_script accepts a pre-serialized JSON string but rejects invalid JSON", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "ve-run-script-2-"));
	try {
		let ran = 0;
		const tool = createRunScriptTool({
			userDataDir,
			config: {}, resolveActor: () => ({}), onConfigChanged: () => {}, conversationId: "dt:x",
			runCommand: async () => { ran += 1; return { text: "ok" }; },
		});
		await tool.execute("c1", { script: join(userDataDir, "a.py"), params: '{"x":1}' });
		assert.equal(ran, 1);
		const bad = await tool.execute("c2", { script: join(userDataDir, "a.py"), params: "{not json" });
		assert.match(bad.content.map((c) => c.text).join(""), /合法 JSON/);
		assert.equal(ran, 1, "invalid JSON must not reach execution");
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});

test("paramDirName keeps same-named scripts in different folders apart", () => {
	const a = paramDirName("/work/a/job.py");
	const b = paramDirName("/work/b/job.py");
	const winA = paramDirName("C:\\work\\a\\job.py");
	const winB = paramDirName("C:\\work\\b\\job.py");
	assert.notEqual(a, b, "different folders must not share a params file");
	assert.notEqual(winA, winB);
	// Windows separators must not leak into the name (the lastIndexOf("/") bug).
	assert.match(winA, /^job-[0-9a-f]{8}$/, `windows path must yield stem+hash, got ${winA}`);
	assert.ok(!winA.includes("C_"), "the full path must not become the directory name");
});

test("a script always gets a non-empty, hash-suffixed directory", () => {
	for (const p of ["/x/a.py", "C:\\x\\a.py", "/x/no-ext", "/x/.hidden"]) {
		const n = paramDirName(p);
		assert.match(n, /^[\w.-]+-[0-9a-f]{8}$/, `unexpected dir name for ${p}: ${n}`);
	}
});

test("a script path containing shell metacharacters is refused (injection guard)", async () => {
	// `q()` escapes quotes the cmd way, but cmd treats & | < > ^ % ( ) as syntax
	// outside quotes and as expansion triggers inside them — quoting alone cannot
	// make an arbitrary path safe.
	const tool = createRunScriptTool({
		userDataDir: tmpdir(),
		config: {}, resolveActor: () => ({}), onConfigChanged: () => {}, conversationId: "dt:x",
		runCommand: async () => { throw new Error("must not execute"); },
	});
	// POSIX-absolute paths so `isAbsolute` does not reject them first on the
	// machine running these tests; the metacharacter guard is what must fire.
	for (const bad of [
		"/tmp/job.py & calc.exe",
		"/tmp/job|whoami.py",
		"/tmp/job>out.py",
		"/tmp/job%PATH%.py",
		"/tmp/job^(1).py",
		"/tmp/job\r\n.py",
	]) {
		const r = await tool.execute("c", { script: bad });
		assert.match(r.content.map((c) => c.text).join(""), /元字符/, `must refuse: ${bad}`);
	}
	// A normal path with spaces and Chinese is still fine — those are common.
	// Use a permissive stub: the point is that the GUARD does not fire.
	const okTool = createRunScriptTool({
		userDataDir: mkdtempSync(join(tmpdir(), "ve-run-script-ok-")),
		config: {}, resolveActor: () => ({}), onConfigChanged: () => {}, conversationId: "dt:x",
		runCommand: async () => ({ text: "ok" }),
	});
	const ok = await okTool.execute("c2", { script: "/tmp/我的 脚本/job.py" });
	assert.ok(!/元字符/.test(ok.content.map((c) => c.text).join("")), "spaces and CJK must remain allowed");
});
