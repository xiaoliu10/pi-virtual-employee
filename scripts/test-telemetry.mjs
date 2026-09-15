/**
 * Telemetry + self-inspection tests. Run with `npm run test:telemetry`.
 *
 * This is the feedback signal the whole self-improvement idea depends on, so the
 * things worth pinning are: the counters actually reflect what happened, the
 * weak "user corrected me" label is narrow enough to be trustworthy, the error
 * samples are truncated, and the tool's scope rule really is admin-only for the
 * cross-conversation view (it exposes other people's failures).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.telemetry-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "telemetry.mjs");
await build({
	stdin: {
		contents: `
			export { ConfigStore } from "./src/db/config-store.ts";
			export { TelemetryStore, looksLikeCorrection, MAX_ERROR_LEN } from "./src/db/telemetry-store.ts";
			export { createMyStatsTool, formatSummary } from "./src/engine/tools/telemetry.ts";
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
const { ConfigStore, TelemetryStore, looksLikeCorrection, MAX_ERROR_LEN, createMyStatsTool, formatSummary } =
	await import(pathToFileURL(bundle).href);

/** In-memory DB with the two telemetry tables (schema mirrored from sqlite.ts). */
function stores(t, seed = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
			ok INTEGER NOT NULL DEFAULT 1, refused INTEGER NOT NULL DEFAULT 0, error TEXT
		);
	`);
	t.after(() => db.close());
	const config = new ConfigStore(db);
	if (Object.keys(seed).length) config.replaceAll(seed);
	return { config, telemetry: new TelemetryStore(db) };
}

const actor = (senderId, chatType = "single", text = "") => ({ senderId, chatType, channel: "dingtalk", text });

/** One finished turn with sensible defaults; override what the case is about. */
const turn = (id, over = {}) => ({
	turnId: id,
	conversationId: "dt:group:prod",
	origin: "im",
	actorId: "alice",
	channel: "dingtalk",
	chatType: "group",
	startedAt: Date.now() - 5_000,
	durationMs: 5_000,
	status: "ok",
	replyLen: 120,
	...over,
});

test("counters reflect what actually happened in a turn", (t) => {
	const { telemetry } = stores(t);
	telemetry.recordTurn(turn("t1"));
	telemetry.recordTurn(turn("t2", { status: "error", error: "429 rate limit from provider" }));
	telemetry.recordTurn(turn("t3", { retries: 1, stepCapHit: true, emptyReply: true, status: "empty_reply" }));
	telemetry.recordTurn(turn("t4", { status: "aborted", abortReason: "watchdog" }));
	telemetry.recordTurn(turn("t5", { correction: true }));
	telemetry.recordTurn(turn("t6", { conversationId: "dt:other" }));

	const all = telemetry.summary({ hours: 24 });
	assert.equal(all.turns, 6);
	assert.deepEqual(all.byStatus, { ok: 3, error: 1, empty_reply: 1, aborted: 1 });
	assert.deepEqual(all.trouble, { retried: 1, stepCapHit: 1, emptyReply: 1, deterministicFailure: 0, aborted: 1, correction: 1 });
	assert.equal(all.avgDurationMs, 5_000);
	assert.deepEqual(all.recentErrors, ["429 rate limit from provider"]);
	assert.equal(all.scopedToConversation, false);

	// Scoped to one chat, only that chat's turns count — this is what a non-admin sees.
	const scoped = telemetry.summary({ hours: 24, conversationId: "dt:group:prod" });
	assert.equal(scoped.turns, 5);
	assert.equal(scoped.scopedToConversation, true);
});

test("tool failures and RBAC refusals are separated in the ranking", (t) => {
	const { telemetry } = stores(t);
	telemetry.recordTurn(turn("t1"));
	for (let i = 0; i < 3; i += 1) telemetry.recordTool({ conversationId: "dt:group:prod", turnId: "t1", name: "run_command", durationMs: 10, ok: false, refused: true });
	telemetry.recordTool({ conversationId: "dt:group:prod", turnId: "t1", name: "browser_open", durationMs: 900, ok: false, error: "net::ERR_NAME_NOT_RESOLVED" });
	telemetry.recordTool({ conversationId: "dt:group:prod", turnId: "t1", name: "search_knowledge_base", durationMs: 40, ok: true });

	const s = telemetry.summary({ hours: 24 });
	const byName = Object.fromEntries(s.failingTools.map((x) => [x.name, x]));
	assert.equal(byName.run_command.refused, 3, "a refusal is friction the agent must be able to see");
	assert.equal(byName.run_command.failed, 3);
	assert.equal(byName.browser_open.failed, 1);
	assert.equal(byName.browser_open.refused, 0);
	assert.equal(byName.search_knowledge_base, undefined, "healthy tools are not listed");
	assert.ok(s.recentErrors.some((e) => e.includes("ERR_NAME_NOT_RESOLVED")), "tool error text is available as a sample");
});

test("stored error text is truncated so a failure can't dump a page into the DB", (t) => {
	const { telemetry } = stores(t);
	telemetry.recordTurn(turn("t1", { status: "error", error: "x".repeat(5_000) }));
	const s = telemetry.summary({ hours: 24 });
	assert.equal(s.recentErrors.length, 1);
	assert.ok(s.recentErrors[0].length <= MAX_ERROR_LEN + 1, `expected ≤ ${MAX_ERROR_LEN} chars, got ${s.recentErrors[0].length}`);
});

test("the correction label is narrow: real corrections yes, ordinary chatter no", () => {
	for (const text of ["不对，我要的是上周的", "你又说错了", "我不是说了按门店汇总吗", "这个数字又错了", "that's wrong", "not what I asked"]) {
		assert.equal(looksLikeCorrection(text), true, `should be flagged: ${text}`);
	}
	for (const text of [
		"帮我把上周的订单汇总一下",
		"这个月的对账做完了吗",
		"好的，谢谢",
		"确认",
		"", // empty
		"这是一段很长的说明".repeat(60), // over the length bound → ignored, not scanned
	]) {
		assert.equal(looksLikeCorrection(text), false, `should NOT be flagged: ${text.slice(0, 20)}`);
	}
});

test("my_stats: any operator may read their own chat; the cross-chat view is admin-only", async (t) => {
	const { config, telemetry } = stores(t, {
		security: { adminStaffIds: ["boss"], people: [{ staffId: "op", role: "operator" }] },
	});
	telemetry.recordTurn(turn("t1", { conversationId: "dt:group:prod", error: undefined }));
	telemetry.recordTurn(turn("t2", { conversationId: "dt:secret", status: "error", error: "other chat failure detail" }));

	const toolFor = (who, conversationId) =>
		createMyStatsTool({ config, resolveActor: () => who, conversationId, telemetry });

	const op = toolFor(actor("op", "group"), "dt:group:prod");
	let res = await op.execute("s1", {});
	assert.equal(res.details.scope, "conversation");
	assert.equal(res.details.turns, 1, "only this chat");
	assert.doesNotMatch(res.content[0].text, /other chat failure detail/, "another chat's failure text must not leak");

	res = await op.execute("s2", { scope: "all" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /仅管理员可查/);

	const admin = toolFor(actor("boss", "single"), "dt:boss");
	res = await admin.execute("s3", { scope: "all" });
	assert.equal(res.details.refused, undefined);
	assert.equal(res.details.scope, "all");
	assert.equal(res.details.turns, 2);
	assert.match(res.content[0].text, /other chat failure detail/);

	// Window is clamped rather than trusted.
	res = await admin.execute("s4", { hours: 100_000, scope: "all" });
	assert.equal(res.details.hours, 720);
	res = await admin.execute("s5", { hours: 0, scope: "all" });
	assert.equal(res.details.hours, 1);
});

test("an empty window is reported as no data, never as good news", (t) => {
	const { telemetry } = stores(t);
	const text = formatSummary(telemetry.summary({ hours: 24 }));
	assert.match(text, /没有任何回合记录/);
	assert.match(text, /不是"表现正常"，是"没有数据"/);
});

test("pruning bounds growth", (t) => {
	const { telemetry } = stores(t);
	const old = Date.now() - 200 * 86_400_000;
	telemetry.recordTurn(turn("ancient", { startedAt: old }));
	telemetry.recordTurn(turn("fresh"));
	assert.equal(telemetry.summary({ hours: 24 * 365 }).turns, 2);
	const removed = telemetry.prune(90);
	assert.equal(removed, 1, "only the row past retention goes");
	assert.equal(telemetry.summary({ hours: 24 * 365 }).turns, 1);
});
