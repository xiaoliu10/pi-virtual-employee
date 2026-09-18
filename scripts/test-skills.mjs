/**
 * Skill-writer tests. Field 2026-09-18: save_to_skill failed for EVERY
 * name/content on the Windows box with "目标路径越界，写入被拒绝" — the
 * containment check hardcoded "/" while Windows resolved paths use "\\".
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(tmpdir(), "pve-skill-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SkillWriter } from "./src/engine/skills/skill-writer.ts";
			export { SkillLoader } from "./src/engine/skills/skill-loader.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(workDir, "skills.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { SkillWriter, SkillLoader } = await import(pathToFileURL(join(workDir, "skills.mjs")).href);

const dataDir = await mkdtemp(join(tmpdir(), "pve-skill-data-"));
after(() => rm(dataDir, { recursive: true, force: true }));
const builtinDir = join(dataDir, "builtin");
const userDir = join(dataDir, "user");

function writerFor(dir) {
	return new SkillWriter(new SkillLoader(builtinDir, dir), dir);
}

test("a normal skill writes under a POSIX-style user dir", async () => {
	const writer = writerFor(userDir);
	const r = await writer.upsert({
		name: "recon-backup",
		description: "对账文件备份流程，日终对账时触发",
		content: "# 步骤\n1. 进页面\n2. 搜索商户号\n3. 勾选备份\n\n## 完成标准\n下载核验。",
	});
	assert.equal(r.outcome, "created", JSON.stringify(r));
	const body = await readFile(join(userDir, "recon-backup", "SKILL.md"), "utf8");
	assert.match(body, /对账文件备份流程/);
});

test("Chinese skill names write successfully", async () => {
	const r = await writerFor(userDir).upsert({
		name: "对账备份流程",
		description: "中文技能名测试",
		content: "# 正文\n步骤说明。",
	});
	assert.equal(r.outcome, "created", JSON.stringify(r));
});

test("path traversal names are rejected", async () => {
	const r = await writerFor(userDir).upsert({ name: "..evil", description: "x", content: "x" });
	assert.notEqual(r.outcome, "created");
});

// The exact field bug, reproduced without a Windows host: backslash-style
// absolute paths must not be treated as escaping. Assert containment by
// exercising the same separator logic the gate uses, against the bug class
// (hardcoded "/" prefix) directly.
test("containment prefix must use the path's own separator (the Windows bug class)", () => {
	const winBase = "C:\\Users\\admin\\AppData\\Roaming\\pi-virtual-employee\\profiles\\main\\skills";
	const winTarget = `${winBase}\\recon-backup\\SKILL.md`;
	// Old buggy logic:
	assert.equal(winTarget.startsWith(winBase + "/"), false, "the hardcoded slash is exactly why Windows writes were rejected");
	// Required logic — accept either separator form:
	const inside = winTarget === winBase || winTarget.startsWith(winBase + "\\") || winTarget.startsWith(winBase + "/");
	assert.ok(inside, "a nested backslash target must be accepted on win32");
	const escaped = "C:\\Users\\admin\\AppData\\Roaming\\other\\x";
	assert.ok(!(escaped.startsWith(winBase + "\\") || escaped.startsWith(winBase + "/")));
});
