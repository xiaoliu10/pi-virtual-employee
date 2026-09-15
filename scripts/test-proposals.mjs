/**
 * Improvement-proposal tests. Run with `npm run test:proposals`.
 *
 * The loop's value depends entirely on these properties: the same problem must
 * NOT pile up as ten files, a proposal must carry evidence that came from real
 * statistics, a closed problem must not be re-reported forever, and re-opening a
 * "fixed" problem must be surfaced rather than silently accepted. Each of those is
 * one test below.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.proposals-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "proposals.mjs");
await build({
	stdin: {
		contents: `
			export { ProposalStore, slugify } from "./src/engine/proposals.ts";
			export { createProposeImprovementTool } from "./src/engine/tools/proposals.ts";
			export { TelemetryStore } from "./src/db/telemetry-store.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { ProposalStore, slugify, createProposeImprovementTool, TelemetryStore } = await import(pathToFileURL(bundle).href);

/** Temp proposals dir + a telemetry store with a couple of real failures in it. */
async function harness(t, { withFailures = true } = {}) {
	const dir = await mkdtemp(join(workDir, "proposals-"));
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE turn_events (
			id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'console',
			actor_id TEXT, channel TEXT, chat_type TEXT, started_at INTEGER NOT NULL,
			duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error TEXT,
			tool_calls INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0,
			step_cap_hit INTEGER NOT NULL DEFAULT 0, empty_reply INTEGER NOT NULL DEFAULT 0,
			deterministic INTEGER NOT NULL DEFAULT 0, abort_reason TEXT,
			correction INTEGER NOT NULL DEFAULT 0, reply_len INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE tool_events (
			id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT, name TEXT NOT NULL,
			started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0,
			ok INTEGER NOT NULL DEFAULT 1, refused INTEGER NOT NULL DEFAULT 0,
			refused_capability TEXT, error TEXT
		);
	`);
	t.after(() => db.close());
	t.after(() => rm(dir, { recursive: true, force: true }));
	const telemetry = new TelemetryStore(db);
	if (withFailures) {
		telemetry.recordTurn({ turnId: "t1", conversationId: "dt:group:prod", origin: "im", startedAt: Date.now() - 1000, durationMs: 1200, status: "ok", replyLen: 40 });
		telemetry.recordTool({ conversationId: "dt:group:prod", turnId: "t1", name: "run_command", durationMs: 5, ok: false, refused: true, refusedCapability: "shell" });
	}
	const store = new ProposalStore(dir);
	const tool = createProposeImprovementTool({ proposals: store, telemetry, proposalsDir: dir });
	return { dir, store, telemetry, tool };
}

const good = {
	action: "file",
	problem: "生产群里 operator 反复被拒绝执行 run_command",
	impact: "值班同学每天要离线找人代跑巡检脚本，平均耽误 20 分钟",
	proposal: "把该群的 shell 门槛从 admin 降为 operator，并保留白名单限制",
	verification: "my_stats focus=failures 中「权限被拒/shell」聚类降为 0，且无新增的越权告警",
};

test("a filed proposal is a real file with the four review questions answered", async (t) => {
	const { tool, dir } = await harness(t);
	const res = await tool.execute("p1", good);
	assert.equal(res.details.created, true);
	assert.equal(res.details.id, slugify(good.problem));
	const text = await readFile(res.details.path, "utf8");
	for (const heading of ["## 问题", "## 证据（来自运行统计，非估计）", "## 影响", "## 拟改动", "## 如何验证有效", "## 处置"]) {
		assert.ok(text.includes(heading), `proposal must answer: ${heading}`);
	}
	assert.equal((await readdir(dir)).length, 1);
});

test("evidence comes from statistics, not from the model's prose", async (t) => {
	const { tool } = await harness(t);
	// No evidence passed → the tool attaches a snapshot it read itself.
	let res = await tool.execute("p1", good);
	let text = await readFile(res.details.path, "utf8");
	assert.match(text, /近 168 小时：\d+ 回合/, "a real window is attached");
	assert.match(text, /主要失败聚类：/, "…including the clusters");
	assert.match(text, /「shell」|shell/, "the actual refusal is visible in the evidence");
	assert.match(text, /my_stats/, "and the source is labelled");

	// Even when the caller supplies evidence, the source label is recorded — a
	// proposal's numbers must be traceable.
	const dir2 = await mkdtemp(join(workDir, "proposals2-"));
	const store2 = new ProposalStore(dir2);
	const tool2 = createProposeImprovementTool({ proposals: store2, telemetry: (await harness(t)).telemetry, proposalsDir: dir2 });
	res = await tool2.execute("p2", { ...good, problem: "另一件事", evidence: "手动摘录：3 次超时", source: "my_stats focus=failures hours=24" });
	text = await readFile(res.details.path, "utf8");
	assert.match(text, /来源：my_stats focus=failures hours=24/);
	assert.match(text, /手动摘录：3 次超时/);
});

test("the same problem appends a detection instead of piling up files", async (t) => {
	const { tool, dir } = await harness(t);
	await tool.execute("p1", good);
	const second = await tool.execute("p2", good);
	assert.equal(second.details.created, false);
	assert.equal(second.details.detections, 2);
	assert.equal((await readdir(dir)).length, 1, "still ONE file");
	const text = await readFile(second.details.path, "utf8");
	assert.match(text, /第 2 次检测到/);
	assert.equal((text.match(/^detections: 2$/m) ?? []).length, 1, "the header keeps up with the detections");

	const third = await tool.execute("p3", good);
	assert.equal(third.details.detections, 3);
	assert.equal((await readdir(dir)).length, 1);
});

test("resolve closes it, and a recurrence is reported as a broken fix", async (t) => {
	const { tool, store } = await harness(t);
	await tool.execute("p1", good);
	const listed = await tool.execute("l1", { action: "list" });
	assert.match(listed.content[0].text, /待处理/);

	const done = await tool.execute("r1", { action: "resolve", id: slugify(good.problem), reason: "已按提案改门槛，观察一周无复现" });
	assert.equal(done.details.ok, true);
	assert.equal((await store.list())[0].status, "resolved");

	// A closed problem that shows up again must NOT slide back in silently.
	const again = await tool.execute("p2", good);
	assert.equal(again.details.refused, true);
	assert.match(again.content[0].text, /此前已标记解决/);
	assert.match(again.content[0].text, /修复是否失效/);

	const listed2 = await tool.execute("l2", { action: "list" });
	assert.match(listed2.content[0].text, /已关闭/);
	assert.equal(listed2.details.open, 0);
});

test("incomplete proposals are refused rather than filed half-formed", async (t) => {
	const { tool, dir } = await harness(t);
	for (const missing of ["problem", "impact", "proposal", "verification"]) {
		const res = await tool.execute("x", { ...good, [missing]: "   " });
		assert.equal(res.details.refused, true, `empty ${missing} must be refused`);
		assert.match(res.content[0].text, /缺少/);
	}
	const long = await tool.execute("y", { ...good, problem: "很长的问题".repeat(500) });
	assert.equal(long.details.refused, true);
	assert.match(long.content[0].text, /过长/);
	assert.deepEqual(await readdir(dir), [], "nothing was written");

	const noId = await tool.execute("z", { action: "resolve", reason: "反正关掉" });
	assert.equal(noId.details.refused, true);
	assert.match(noId.content[0].text, /缺少 id/);
});

test("list starts empty with instructions, and names the directory either way", async (t) => {
	const { tool, dir } = await harness(t, { withFailures: false });
	let res = await tool.execute("l1", { action: "list" });
	assert.equal(res.details.count, 0);
	assert.match(res.content[0].text, /还没有任何提案/);
	assert.match(res.content[0].text, /my_stats focus=failures/, "it points at how to find something worth proposing");
	assert.ok(res.content[0].text.includes(dir));

	await tool.execute("p1", good);
	res = await tool.execute("l2", { action: "list" });
	assert.equal(res.details.count, 1);
	assert.equal(res.details.open, 1);
	assert.match(res.content[0].text, /检测 1 次/);
	assert.ok(res.content[0].text.includes(dir), "the path is always shown so a human can open it");
});

test("slugify is stable and filesystem-safe for Chinese problem statements", () => {
	assert.equal(slugify("生产群里 operator 反复被拒绝执行 run_command"), "生产群里-operator-反复被拒绝执行-run-command");
	assert.equal(slugify("  ?? ///  "), "proposal");
	assert.equal(slugify("A".repeat(200)).length, 48);
	// Same statement, same id — that is what makes dedupe work.
	assert.equal(slugify("同一句话"), slugify("同一句话 "));
});
