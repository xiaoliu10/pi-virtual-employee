/**
 * Auto skill distillation — the review prompt and the writer it drives.
 *
 * Field 2026-11-03: a scheduled task wrote a working script on one run; a later
 * manual run rewrote it from scratch, because the procedure lived only in the
 * run's transcript — the one store no future session reads. The fix distills
 * each run's tail into a skill (with the script under `scripts/`) so the next
 * run reads the skill and invokes it.
 *
 * Ported from NousResearch/hermes-agent agent/background_review.py. The
 * invariants below are the ones that keep the library usable rather than a
 * hoard of near-duplicate one-run skills.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.skill-review-probe");
mkdirSync(outDir, { recursive: true });

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		bundle: true, format: "esm", platform: "node",
		outfile: join(outDir, outfile),
		packages: "external",
		logLevel: "silent",
	});
	return import(pathToFileURL(join(outDir, outfile)).href + `?t=${Date.now()}`);
}

const review = await bundle("src/engine/skills/skill-review.ts", "review.mjs");
const { buildSkillReviewPrompt, isNoNewSkillReply, NO_NEW_SKILL_MARK, SKILL_SCRIPTS_DIR } = review;

test("the review prompt carries the reuse-first preference order", () => {
	const p = buildSkillReviewPrompt({ taskTitle: "平阳数币每日对账", outcome: "ok" });
	// The ORDER is load-bearing: patch-in-play → extend umbrella → support file → create.
	assert.ok(p.indexOf("UPDATE THE SKILL THAT WAS IN PLAY") < p.indexOf("UPDATE AN EXISTING SKILL"), "patch-in-play precedes umbrella");
	assert.ok(p.indexOf("UPDATE AN EXISTING SKILL") < p.indexOf("ADD A SUPPORT FILE"), "umbrella precedes support file");
	assert.ok(p.indexOf("ADD A SUPPORT FILE") < p.indexOf("CREATE A NEW SKILL"), "support file precedes create");
});

test("scripts are the preferred support file (the thing that makes the next run fast)", () => {
	const p = buildSkillReviewPrompt({ taskTitle: "t", outcome: "ok" });
	assert.ok(p.includes(`\`${SKILL_SCRIPTS_DIR}/<name>.<ext>\``), "scripts/ named as the support file");
	assert.ok(/收进技能自己的\s*`scripts\/`/.test(p) || p.includes("收进技能自己的"), "explicit instruction to collect the script into the skill");
	assert.ok(p.includes("不要重写") || p.includes("不必重写") || p.includes("从零写"), "states the payoff: next run need not rewrite");
});

test("read-before-write is required", () => {
	const p = buildSkillReviewPrompt({ taskTitle: "t", outcome: "ok" });
	assert.match(p, /Read-before-write/);
	assert.match(p, /MUST read that file first|必须先读/);
});

test("the do-not-capture list blocks the failure shapes that harden into constraints", () => {
	const p = buildSkillReviewPrompt({ taskTitle: "t", outcome: "ok" });
	assert.match(p, /Environment-dependent failures/);
	assert.match(p, /Negative claims about tools/);
	assert.match(p, /Unresolved failures/);
});

test("an errored run is told NOT to write up dead ends as a workflow", () => {
	const p = buildSkillReviewPrompt({ taskTitle: "t", outcome: "error" });
	assert.match(p, /未走通的方法不得写成「可靠流程」/);
});

test("an ok run does not carry the unresolved-failure warning", () => {
	const p = buildSkillReviewPrompt({ taskTitle: "t", outcome: "ok" });
	assert.doesNotMatch(p, /未走通的方法不得写成/);
});

test("available skills are listed so patch-first is actionable", () => {
	const withList = buildSkillReviewPrompt({ taskTitle: "t", outcome: "ok", availableSkills: ["退款处理", "handle-refund"] });
	assert.match(withList, /「退款处理」/);
	const without = buildSkillReviewPrompt({ taskTitle: "t", outcome: "ok", availableSkills: [] });
	assert.doesNotMatch(without, /本次运行中可用的技能/);
});

test("'nothing to save' is offered but must not be the default", () => {
	const p = buildSkillReviewPrompt({ taskTitle: "t", outcome: "ok" });
	assert.ok(p.includes(NO_NEW_SKILL_MARK));
	assert.match(p, /不要为了沉淀而沉淀/);
});

test("isNoNewSkillReply tolerates markdown emphasis and whitespace", () => {
	assert.equal(isNoNewSkillReply("无新技能"), true);
	assert.equal(isNoNewSkillReply("**无新技能**"), true);
	assert.equal(isNoNewSkillReply("  无 新 技 能  "), true);
	assert.equal(isNoNewSkillReply("已更新技能「对账」的 scripts/run.py"), false);
});

// ---- SkillWriter: scripts/ support files + read-before-write ----
const writer = await bundle("src/engine/skills/skill-writer.ts", "writer.mjs");
const loader = await bundle("src/engine/skills/skill-loader.ts", "loader.mjs");

function makeWriter() {
	const dir = mkdtempSync(join(tmpdir(), "ve-skill-writer-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a verified script is written under the skill's scripts/ dir", async () => {
	const { dir, cleanup } = makeWriter();
	try {
		const skillLoader = new loader.SkillLoader(join(dir, "builtin"), join(dir, "user"));
		const w = new writer.SkillWriter(skillLoader, join(dir, "user"));
		const created = await w.upsert({
			name: "对账",
			description: "每日对账流程",
			content: "# 对账\n\n跑 scripts/spay_sum.py。",
		});
		assert.equal(created.outcome, "created");

		const written = await w.writeSupportFile({ skill: "对账", path: "scripts/spay_sum.py", content: "print('hi')" });
		assert.equal(written.outcome, "created");
		const onDisk = readFileSync(join(dir, "user", "对账", "scripts", "spay_sum.py"), "utf8");
		assert.equal(onDisk, "print('hi')");
	} finally { cleanup(); }
});

test("writeSupportFile refuses paths outside scripts/references/templates", async () => {
	const { dir, cleanup } = makeWriter();
	try {
		const skillLoader = new loader.SkillLoader(join(dir, "builtin"), join(dir, "user"));
		const w = new writer.SkillWriter(skillLoader, join(dir, "user"));
		await w.upsert({ name: "对账", description: "d", content: "c" });
		for (const bad of ["../evil.py", "/etc/passwd", "SKILL.md", "x.py"]) {
			const r = await w.writeSupportFile({ skill: "对账", path: bad, content: "x" });
			assert.equal(r.outcome, "rejected", `must reject ${bad}`);
		}
		// Nothing escaped.
		assert.equal(existsSync(join(dir, "user", "evil.py")), false);
	} finally { cleanup(); }
});

test("writeSupportFile refuses an unknown skill (no orphan dirs)", async () => {
	const { dir, cleanup } = makeWriter();
	try {
		const skillLoader = new loader.SkillLoader(join(dir, "builtin"), join(dir, "user"));
		const w = new writer.SkillWriter(skillLoader, join(dir, "user"));
		const r = await w.writeSupportFile({ skill: "不存在", path: "scripts/a.py", content: "x" });
		assert.equal(r.outcome, "rejected");
		assert.equal(existsSync(join(dir, "user", "不存在")), false);
	} finally { cleanup(); }
});

test("readSkillFile supports read-before-write", async () => {
	const { dir, cleanup } = makeWriter();
	try {
		const skillLoader = new loader.SkillLoader(join(dir, "builtin"), join(dir, "user"));
		const w = new writer.SkillWriter(skillLoader, join(dir, "user"));
		await w.upsert({ name: "对账", description: "d", content: "# 对账\n\n步骤一" });
		const read = await w.readSkillFile("对账");
		assert.equal(read.ok, true);
		assert.match(read.content ?? "", /步骤一/);
		const missing = await w.readSkillFile("不存在");
		assert.equal(missing.ok, false);
	} finally { cleanup(); }
});
