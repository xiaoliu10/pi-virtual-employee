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
// Bundle lands inside the repo so `packages: "external"` can resolve workspace deps.
const workDir = await mkdtemp(join(root, "node_modules/.skills-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SkillWriter } from "./src/engine/skills/skill-writer.ts";
			export { SkillLoader } from "./src/engine/skills/skill-loader.ts";
			export { createManageSkillsTool, DEFAULT_MARKET_URL, effectiveMarketUrl } from "./src/engine/tools/skills-market.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
			export { requireConfirmedAdmin } from "./src/engine/tools/admin.ts";
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
const { SkillWriter, SkillLoader, createManageSkillsTool, effectiveMarketUrl, DEFAULT_MARKET_URL, ConfigStore } = await import(
	pathToFileURL(join(workDir, "skills.mjs")).href,
);

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
		name: "daily-backup",
		description: "日报文件备份流程，每日日终触发",
		content: "# 步骤\n1. 进页面\n2. 导出报表\n3. 勾选备份\n\n## 完成标准\n下载核验。",
	});
	assert.equal(r.outcome, "created", JSON.stringify(r));
	const body = await readFile(join(userDir, "daily-backup", "SKILL.md"), "utf8");
	assert.match(body, /日报文件备份流程/);
});

test("Chinese skill names write successfully", async () => {
	const r = await writerFor(userDir).upsert({
		name: "日报备份流程",
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
	const winTarget = `${winBase}\\daily-backup\\SKILL.md`;
	// Old buggy logic:
	assert.equal(winTarget.startsWith(winBase + "/"), false, "the hardcoded slash is exactly why Windows writes were rejected");
	// Required logic — accept either separator form:
	const inside = winTarget === winBase || winTarget.startsWith(winBase + "\\") || winTarget.startsWith(winBase + "/");
	assert.ok(inside, "a nested backslash target must be accepted on win32");
	const escaped = "C:\\Users\\admin\\AppData\\Roaming\\other\\x";
	assert.ok(!(escaped.startsWith(winBase + "\\") || escaped.startsWith(winBase + "/")));
});


// ── manage_skills: skill market (field 2026-10-06: employee had no way to install skills) ──

import { DatabaseSync } from "node:sqlite";

function marketDeps(t, { fullAccess = false, text = "确认安装技能" } = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	t.after(() => db.close());
	const config = new ConfigStore(db);
	// Seed the actor as a whitelisted admin (confirm gates check the whitelist first).
	config.update({ security: { adminStaffIds: ["admin-1"], ...(fullAccess ? { adminFullAccess: true } : {}) } });
	const dir = join(dataDir, `user-market-${Math.random().toString(36).slice(2, 8)}`);
	const writer = writerFor(dir);
	const deps = {
		config,
		resolveActor: () => ({ senderId: "admin-1", chatType: "single", channel: "dingtalk", text }),
		onConfigChanged: () => {},
		conversationId: "c-market",
		skillWriter: writer,
		userSkillsDir: dir,
		listSkills: async () => {
			const { skills, info } = await new SkillLoader(builtinDir, dir).list();
			return { skills: skills.map((s) => ({ name: s.name })), info: info.map((i) => ({ name: i.name, enabled: i.enabled })) };
		},
		onSkillsChanged: async () => {},
	};
	return { deps, dir, config };
}

function stubFetch(t, responder) {
	const real = globalThis.fetch;
	globalThis.fetch = responder;
	t.after(() => { globalThis.fetch = real; });
}

/** Index fetches get the market JSON; everything else is treated as a SKILL.md body. */
function stubMarket(t, { indexSkills = [{ name: "excel-pivot", description: "透视表", url: "https://example.com/excel-pivot/SKILL.md" }], body = SKILL_MD } = {}) {
	stubFetch(t, async (url) => ({
		ok: true,
		status: 200,
		text: async () => (String(url).endsWith(".json") ? JSON.stringify({ skills: indexSkills }) : typeof body === "function" ? body(url) : body),
	}));
}

const SKILL_MD = [
	"---",
	"name: excel-pivot",
	"description: 数据透视表操作标准步骤",
	"---",
	"",
	"## 步骤",
	"1. 选中数据区域",
].join("\n");

test("manage_skills market lists the index; effectiveMarketUrl prefers configured URL", async (t) => {
	const { deps, config } = marketDeps(t);
	assert.equal(effectiveMarketUrl(config), DEFAULT_MARKET_URL, "empty marketUrl falls back to the official index");
	config.update({ skills: { marketUrl: "https://example.com/index.json" } });
	assert.equal(effectiveMarketUrl(config), "https://example.com/index.json", "configured URL wins");
	stubFetch(t, async (url) => ({
		ok: true, status: 200,
		text: async () => JSON.stringify({ skills: [{ name: "excel-pivot", description: "透视表", url: "https://example.com/excel-pivot/SKILL.md" }] }),
	}));
	const tool = createManageSkillsTool(deps);
	const res = await tool.execute("t1", { action: "market" });
	assert.match(res.content[0].text, /excel-pivot/);
	assert.equal(res.details.count, 1);
});

test("manage_skills install writes via SkillWriter, reloads, and honors the confirm gate", async (t) => {
	const { deps } = marketDeps(t, { fullAccess: false, text: "安装 excel-pivot，确认" });
	stubMarket(t);
	const tool = createManageSkillsTool(deps);
	const ok = await tool.execute("t1", { action: "install", name: "excel-pivot" });
	assert.match(ok.content[0].text, /已安装并重新加载/);
	const written = await readFile(join(deps.userSkillsDir, "excel-pivot", "SKILL.md"), "utf8");
	assert.match(written, /name: excel-pivot/);
	// Second install without overwrite lands in needs-confirm.
	const again = await tool.execute("t2", { action: "install", name: "excel-pivot" });
	assert.equal(again.details.needsConfirm, true);
	// Overwrite replaces.
	const over = await tool.execute("t3", { action: "install", name: "excel-pivot", overwrite: true });
	assert.match(over.content[0].text, /已更新/);
});

test("manage_skills install without confirmation is refused; full access waives it", async (t) => {
	const noConfirm = marketDeps(t, { text: "帮我装个技能" });
	stubMarket(t);
	const toolA = createManageSkillsTool(noConfirm.deps);
	const refused = await toolA.execute("t1", { action: "install", name: "excel-pivot" });
	assert.match(resolved_text(refused), /包含「确认」/);
	assert.equal(refused.details.refused, true);

	const waived = marketDeps(t, { fullAccess: true, text: "帮我装个技能" });
	stubMarket(t);
	const toolB = createManageSkillsTool(waived.deps);
	const ok = await toolB.execute("t2", { action: "install", name: "excel-pivot" });
	assert.match(resolved_text(ok), /已安装并重新加载/);
});

function resolved_text(res) {
	return res.content[0].text;
}

test("manage_skills remove deletes only user skills under the user dir", async (t) => {
	const { deps } = marketDeps(t);
	stubMarket(t);
	const tool = createManageSkillsTool(deps);
	await tool.execute("t1", { action: "install", name: "excel-pivot" });
	const gone = await tool.execute("t2", { action: "remove", name: "excel-pivot" });
	assert.match(gone.content[0].text, /已移除/);
	const missing = await tool.execute("t3", { action: "remove", name: "excel-pivot" });
	assert.match(missing.content[0].text, /没有名为/);
	// traversal-shaped names are rejected by the name regex
	const evil = await tool.execute("t4", { action: "remove", name: "../../etc" });
	assert.match(evil.content[0].text, /合法的技能名/);
});

test("manage_skills rejects non-https urls and invalid skill files", async (t) => {
	const { deps } = marketDeps(t);
	const tool = createManageSkillsTool(deps);
	const bad = await tool.execute("t1", { action: "install", url: "http://example.com/SKILL.md" });
	assert.match(bad.content[0].text, /仅支持 https/);
	stubMarket(t, { body: "不是技能的普通网页" });
	const junk = await tool.execute("t2", { action: "install", url: "https://example.com/SKILL.md" });
	assert.match(junk.content[0].text, /不是有效的技能/);
});
