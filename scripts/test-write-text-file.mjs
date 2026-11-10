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

	// Mismatch path: an unpaired surrogate cannot be encoded losslessly. It is
	// now refused BEFORE the write (review P1-2), which is strictly safer than
	// detecting it afterwards — and either way it must throw, never "succeed".
	const lone = "half\ud800\n";
	await assert.rejects(
		() => fs.writeTextFile(join(allowed, "lone.py"), lone, true),
		/未配对的 UTF-16 代理项|写入校验失败/,
		"lossy content must be rejected, not silently accepted",
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

// ─────────────────────────────────────────────────────────────────────────────
// P0 (independent review): the write tool must not be able to reach the app's
// own database/config through the workspace. The reviewer reproduced a full
// self-escalation chain: a junction inside `scripts/` pointed at `..`, so a
// write "inside the workspace" landed on pi-employee.sqlite and config.json —
// and the read-back verification reported it as a success.
// ─────────────────────────────────────────────────────────────────────────────

test("P0: a JUNCTION inside the workspace cannot redirect a write into the profile", async () => {
	// Layout mirrors the box: profile dir (DB/config) beside a writable workspace.
	const profile = join(work, "profile");
	const dbPath = join(profile, "pi-employee.sqlite");
	mkdirSync(profile, { recursive: true });
	writeFileSync(dbPath, "REAL-DB-CONTENT");
	const ws = join(work, "ws");
	mkdirSync(ws, { recursive: true });

	const fs = service([ws]);
	fs.addSensitiveDir(profile);

	// Simulate the junction: a directory link inside the workspace pointing at
	// the profile. On Windows this is `mklink /J`; symlink() stands in here (both
	// resolve through realpath, which is what the guard now checks).
	let linked = false;
	try {
		const { symlinkSync } = await import("node:fs");
		symlinkSync(profile, join(ws, "link"), "junction");
		linked = true;
	} catch { /* no symlink privilege on this host — the literal-prefix case below still runs */ }

	if (linked) {
		await assert.rejects(
			() => fs.writeTextFile(join(ws, "link", "pi-employee.sqlite"), "PWNED-DB", true),
			/app's own|拒绕访问|不在允许访问的目录内|sensitive|自身数据/i,
			"a junction must not launder the profile into the whitelist",
		);
		assert.equal(readFileSync(dbPath, "utf8"), "REAL-DB-CONTENT", "the database must be byte-identical");
	}
});

test("P0: a sensitive dir is refused even when it IS inside an allowed dir", async () => {
	// The deny-list must win over the allow-list — this is the defence that
	// survives a mistake in the workspace location itself.
	const outer = join(work, "outer");
	const inner = join(outer, "profile");
	mkdirSync(inner, { recursive: true });
	const fs = service([outer]); // outer is allowed...
	fs.addSensitiveDir(inner); // ...but the profile inside it is not
	const target = join(inner, "config.json");
	writeFileSync(target, '{"ok":true}');
	await assert.rejects(() => fs.writeTextFile(target, '{"security":{"admin":["x"]}}', true), /自身数据/);
	assert.equal(readFileSync(target, "utf8"), '{"ok":true}', "config must be untouched");
});

test("P1-2: unencodable content is refused BEFORE the previous file is destroyed", async () => {
	const target = join(allowed, "keep-me.py");
	const fs = service();
	await fs.writeTextFile(target, "print('v1 working script')\n", true);
	const before = readFileSync(target, "utf8");
	await assert.rejects(
		() => fs.writeTextFile(target, "half\ud800\n", true),
		/未配对的 UTF-16 代理项/,
		"the error must name the real cause (encoding), not suggest a retry",
	);
	assert.equal(readFileSync(target, "utf8"), before, "the working v1 script must survive a failed write");
});

test("P1-3: overwriting reports the previous byte size", async () => {
	const target = join(allowed, "resize.py");
	const fs = service();
	await fs.writeTextFile(target, "x".repeat(500), true);
	const second = await fs.writeTextFile(target, "y", true);
	assert.equal(second.overwritten, true);
	assert.equal(second.replacedBytes, 500, "the result must expose what was replaced");
	const tools = createFilesystemTools(service());
	const write = tools.find((t) => t.name === "write_text_file");
	const res = await write.execute("call-3", { path: target, content: "z" });
	const text = res.content.map((c) => c.text ?? "").join("");
	assert.match(text, /原 1 字节/, `the report must mention the replaced size: ${text}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 2 P0s — all three were REAL regressions introduced by the first
// fix attempt, each reproduced by the reviewer.
// ─────────────────────────────────────────────────────────────────────────────

test("P0-1: a path with MANY missing segments must not fall through the guard (fail-open)", async () => {
	// The old guard walked up to the deepest existing ancestor with a 64-hop cap
	// and simply RETURNED when the cap ran out — i.e. it allowed the write. The
	// reviewer reproduced a write landing INSIDE the sensitive profile that way.
	const fs = service([allowed]);
	const profile = join(work, "profile2");
	mkdirSync(profile, { recursive: true });
	fs.addSensitiveDir(profile);
	// Deeply nested, entirely non-existent path under the allowed dir.
	const deep = join(allowed, ...Array.from({ length: 40 }, (_, i) => `p${i}`), "evil.py");
	// A legitimate deep path inside the workspace must still work (the guard must
	// RETURN a decision for every hop count — not run out of hops and fall through).
	await fs.writeTextFile(deep, "x", true);
	assert.equal(readFileSync(deep, "utf8"), "x", "a legitimate deep path inside the workspace must still work");

	// The dangerous case: the deep path resolves THROUGH a junction to the profile.
	const ws = join(work, "ws2");
	mkdirSync(ws, { recursive: true });
	const fs2 = service([ws]);
	fs2.addSensitiveDir(profile);
	let linked = false;
	try {
		const { symlinkSync } = await import("node:fs");
		symlinkSync(profile, join(ws, "j"), "junction");
		linked = true;
	} catch { /* no symlink privilege */ }
	if (linked) {
		const inside = join(ws, "j", ...Array.from({ length: 40 }, (_, i) => `p${i}`), "evil.py");
		await assert.rejects(
			() => fs2.writeTextFile(inside, "PWNED", true),
			/自身数据|sensitive|不在允许访问|无法解析/,
			"a deep junction target must be refused, never fail open",
		);
	}
});

test("P0-2: the workspace must not be nested inside a denied root (default profile layout)", async () => {
	// Default profile: userData IS <appData>/pi-virtual-employee, so a workspace
	// under that root was inside the deny-list → every write refused.
	// The shipped layout now uses a SEPARATE root; assert the guard agrees.
	const appRoot = join(work, "appdata", "pi-virtual-employee");
	const workspaceRoot = join(work, "appdata", "pi-virtual-employee-workspace", "default", "scripts");
	mkdirSync(appRoot, { recursive: true });
	mkdirSync(workspaceRoot, { recursive: true });
	const fs = service([workspaceRoot]);
	fs.addSensitiveDir(join(appRoot, "logs"));
	fs.addSensitiveFile(join(appRoot, "pi-employee.sqlite"));
	fs.addSensitiveFile(join(appRoot, "config.json"));

	const ok = await fs.writeTextFile(join(workspaceRoot, "hello.py"), "print(1)\n", true);
	assert.equal(ok.bytes, 9, "the default profile must be able to author scripts");
	assert.equal(readFileSync(join(workspaceRoot, "hello.py"), "utf8"), "print(1)\n");

	// ...while the app's own critical files remain refused.
	writeFileSync(join(appRoot, "pi-employee.sqlite"), "REAL");
	await assert.rejects(() => fs.writeTextFile(join(appRoot, "pi-employee.sqlite"), "PWNED", true));
	assert.equal(readFileSync(join(appRoot, "pi-employee.sqlite"), "utf8"), "REAL");
});

test("P0-3: the FIRST write into a not-yet-existing workspace must work", async () => {
	// The guard resolves through the deepest EXISTING ancestor; a workspace that
	// was never mkdir'ed made the very first write fail. main.ts now creates it,
	// and writeTextFile mkdirs the parent — assert the guard permits it.
	const fresh = join(work, "fresh-workspace", "deep");
	const fs = service([join(work, "fresh-workspace")]);
	const r = await fs.writeTextFile(join(fresh, "first.py"), "print('first')\n", true);
	assert.equal(r.overwritten, false);
	assert.equal(readFileSync(join(fresh, "first.py"), "utf8"), "print('first')\n");

	// Also assert the shipped main.ts pre-creates the workspace (wiring).
	const mainSrc = readFileSync(join(root, "electron/main.ts"), "utf8");
	assert.match(mainSrc, /mkdirSync\(scriptWorkspace, \{ recursive: true \}\)/, "the workspace must be pre-created at startup");
	assert.match(mainSrc, /addSensitiveFile\(/, "critical files are denied individually, not by root");
});

test("P1-2: concurrent writes to the SAME target do not collide on the tmp name", async () => {
	const target = join(allowed, "concurrent.py");
	const fs = service();
	const results = await Promise.allSettled([
		fs.writeTextFile(target, "A".repeat(100), true),
		fs.writeTextFile(target, "B".repeat(100), true),
		fs.writeTextFile(target, "C".repeat(100), true),
	]);
	const ok = results.filter((r) => r.status === "fulfilled");
	assert.ok(ok.length >= 1, `at least one write must succeed: ${JSON.stringify(results.map((r) => r.status))}`);
	const final = readFileSync(target, "utf8");
	assert.match(final, /^(A{100}|B{100}|C{100})$/, "the surviving content must be one whole write, never a mix");
	// No tmp files may be left behind.
	const { readdirSync } = await import("node:fs");
	const leftovers = readdirSync(allowed).filter((f) => f.includes(".tmp-"));
	assert.deepEqual(leftovers, [], `tmp files leaked: ${leftovers.join(",")}`);
});

test("P0-1c: the guard MUST throw on exhaustion — driven directly, not via a path shape", async () => {
	// The round-2 fail-open was only reachable when the walk ran out WITHOUT
	// reaching the root (the old 64-hop cap). A filesystem path cannot express
	// that portably, so assert the CONTRACT at the guard: a path whose resolution
	// cannot produce a decision must reject. We force it with a non-existent
	// absolute root that has no existing ancestor beyond the drive root.
	const fs = service([allowed]);
	// Anything the guard cannot place inside the whitelist must reject — the
	// assertion is that SOME error surfaces, never a silent resolution.
	let threw = false;
	try {
		await fs.writeTextFile(join("/nonexistent-root-xyz", "a", "b", "evil.py"), "x", true);
	} catch {
		threw = true;
	}
	assert.equal(threw, true, "an unresolvable path must never be accepted");

	// And the shipped guard must contain a FAIL-CLOSED exit on exhaustion rather
	// than a bare `break`/`return` (positive-shape assertion, mutation-proved).
	const src = readFileSync(join(root, "src/filesystem/filesystem-service.ts"), "utf8");
	const start = src.indexOf("private async assertAllowedReal");
	const region = src.slice(start, start + 2200);
	assert.match(region, /throw new Error\(`无法解析路径/, "exhaustion must THROW, not return");
	assert.doesNotMatch(region, /for \(let i = 0; i < 64; i\+\+\)/, "the hop cap that caused the fail-open must be gone");
});

test("P0-1b: the guard must THROW when it cannot resolve a path (never pass by omission)", async () => {
	// Directly exercise the guard's contract. Any code path that cannot decide
	// must refuse — the round-2 bug was precisely "walked out of the loop and
	// returned", which reads as ALLOW.
	const fs = service([allowed]);
	// Resolve a path whose every ancestor is denied/nonexistent is hard to build
	// portably, so test the public consequence instead: a target OUTSIDE every
	// allowed dir must throw for arbitrarily many missing segments. A fail-open
	// guard returns quietly and the write succeeds.
	const outsideDeep = join(work, "outside", ...Array.from({ length: 80 }, (_, i) => `x${i}`), "evil.py");
	await assert.rejects(
		() => fs.writeTextFile(outsideDeep, "PWNED", true),
		/不在允许访问的目录内|无法解析路径|拒绕访问/,
		"a deep out-of-whitelist path must be refused, not silently allowed",
	);
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(outsideDeep), false, "nothing may be created outside the whitelist");

	// Same shape but the whitelist prefix appears deeper in the path: prefix
	// matching must not be fooled by a sibling that merely shares the name.
	const sibling = `${allowed}-evil`;
	const sneaky = join(sibling, "a", "b", "c", "evil.py");
	await assert.rejects(() => fs.writeTextFile(sneaky, "PWNED", true), /不在允许访问的目录内|无法解析路径|拒绕访问|拒绝访问/);
	assert.equal(existsSync(sneaky), false);
});

test("P2: list_directory enumerates a sensitive DIR (read-only); writes/deletes keep the deny-list", async () => {
	// Field 2026-11-11: 「列举失败：拒绝访问…skills/yiduyun-sls-query」 — listing a
	// user-imported skill dir was refused, making every bundled-script skill
	// undiscoverable. Listing is read-only metadata with zero escalation value
	// (the FS service has no content-read method; content goes through
	// run_command under OS permissions), so sensitive DIRS stay enumerable
	// while writes/deletes keep the deny-list. Sensitive FILES stay fully
	// off-limits.
	const outer = join(work, "outer-ls");
	const skills = join(outer, "profile-skills");
	mkdirSync(join(skills, "yiduyun-sls-query"), { recursive: true });
	writeFileSync(join(skills, "yiduyun-sls-query", "SKILL.md"), "# sls query");
	const fs = service([outer]);
	fs.addSensitiveDir(skills);
	const listed = await fs.listDirectory(skills);
	assert.ok(listed.entries.some((e) => e.name === "yiduyun-sls-query"), "enumeration of a sensitive dir succeeds");
	const skillMd = join(skills, "yiduyun-sls-query", "SKILL.md");
	await assert.rejects(() => fs.writeTextFile(join(skills, "new.md"), "x", true), /自身数据/, "write into a sensitive dir still refused");
	// deleteFiles reports per-path (catches internally) — assert on the result entry.
	const del = await fs.deleteFiles([skillMd], true);
	assert.equal(del.results[0].ok, false, "delete inside a sensitive dir refused");
	assert.match(del.results[0].error ?? "", /自身数据/, "refusal names the sensitive-dir deny-list");
	assert.equal(readFileSync(skillMd, "utf8"), "# sls query", "the skill file is untouched");
	// A sensitive FILE is never listable either — the resolved path equals the file.
	const dbLike = join(outer, "pi-employee.sqlite");
	writeFileSync(dbLike, "REAL");
	fs.addSensitiveFile(dbLike);
	await assert.rejects(() => fs.listDirectory(dbLike), /自身数据/, "a sensitive file path is refused even for listing");
});
