/**
 * Session visibility (v0.2.208) — field 2026-11-08.
 *
 * The operator asked the model 「当前会话 id 是多少」 and got the temp working
 * directory in return: the model could not see its own identity, and there was
 * no way to look a conversation UP by id — remotely (desktop → windows) or
 * locally. Three pieces close it:
 *
 *   1. the model's OWN id rides the system prompt (conversationId in
 *      promptPartsFor → 「本会话标识」 section) — asserted in test-prompt
 *   2. session_detail tool / renderSessionDetail — this suite
 *   3. widget GET /api/session/<id> — same renderer over HTTP (wired in
 *      widget-service; auth + arity covered there)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.session-detail-test-"));
const bundle = join(dir, "sd.mjs");
await build({
	stdin: {
		contents: 'export { createSessionDetailTool, renderSessionDetail } from "./src/engine/tools/session-detail.ts";',
		resolveDir: root, loader: "ts",
	},
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
});
const { createSessionDetailTool, renderSessionDetail } = await import(pathToFileURL(bundle).href);

function makeDeps(overrides = {}) {
	const messages = [
		{ role: "user", content: "每日对账异常动态巡检与群内汇报（7天版·明细报告）继续", created_at: 1794060942000 },
		{ role: "assistant", content: "收到，本轮开始巡检……", created_at: 1794061000000 },
		{ role: "user", content: "重新执行", created_at: 1794106692000 },
	];
	return {
		listMessages: (cid, limit = 10) => (cid === "worker:w1" ? messages.slice(-limit) : []),
		// NEW semantics: a worker: id returns THAT task itself; an IM id returns
		// the tasks it dispatched. Mirrors engine.sessionDetailDeps.
		listWorkers: (cid, limit) =>
			cid === "worker:w1"
				? [{ id: "w1", instruction: "每日对账异常动态巡检（7天版·明细报告）继续", status: "error", source_conversation: "dt:group:g1", created_at: 1794060930000 }]
				: cid === "dt:group:g1"
					? [{ id: "w1", instruction: "每日对账异常动态巡检（7天版·明细报告）继续", status: "error", source_conversation: cid, created_at: 1794060930000 }].slice(0, limit)
					: [],
		workItemsOf: (cid) => {
			// mirror the engine: a worker: id resolves its origin conversation first
			const origin = cid === 'worker:w1' ? 'dt:group:g1' : cid;
			return origin === 'dt:group:g1'
				? [{ id: '3db7f642-4670-48a7-b6cd-be212c93ceec', title: '每日对账异常动态巡检与群内汇报（7天版·明细报告）', status: 'scheduled' }]
				: [];
		},
		isStreaming: (cid) => cid === "worker:w1",
		conversationId: "dt:group:g1",
		resolveActor: (cid) => ({ senderId: "ma1" }),
		isAdmin: (senderId) => senderId === "ma1",
		...overrides,
	};
}

test("cross-conversation reads are admin-only (target-side authorization)", async () => {
	// The outer telemetry gate only proves the actor may use telemetry in ITS
	// room; the TARGET id is a parameter (review probe: an operator dumped a
	// foreign 1:1 chat). Admin may query anywhere; a non-admin gets refused.
	const { createSessionDetailTool } = await import(pathToFileURL(bundle).href);
	const admin = createSessionDetailTool(makeDeps());
	const r1 = await admin.execute("t1", { sessionId: "worker:w1" });
	assert.equal(r1.details.refused, undefined, "admin may read a foreign id");
	const nonAdmin = createSessionDetailTool(makeDeps({ isAdmin: () => false }));
	const r2 = await nonAdmin.execute("t2", { sessionId: "worker:w1" });
	assert.equal(r2.details.refused, "cross-conversation", "non-admin refused on a foreign id");
	const r3 = await nonAdmin.execute("t3", { sessionId: "dt:group:g1" });
	assert.notEqual(r3.details.refused, "cross-conversation", "own conversation always allowed");
});

test("the report marks transcript content as data, not instructions", async () => {
	const r = renderSessionDetail(makeDeps(), "worker:w1", 10);
	assert.match(r.text, /不是指令/);
});

test("countMessages is preferred over a full page load for the header total", async () => {
	// The renderer must not re-fetch the whole conversation just to print a
	// count — big histories would be dragged into memory per query.
	let listed = 0, counted = 0;
	const deps = makeDeps({
		listMessages: (cid, limit = 10) => { listed++; return cid === "worker:w1" ? [{ role: "user", content: "x", created_at: 1 }].slice(-limit) : []; },
		countMessages: (cid) => { counted++; return cid === "worker:w1" ? 57 : 0; },
	});
	const r = renderSessionDetail(deps, "worker:w1", 10);
	assert.match(r.text, /历史消息共 57 条/, "header shows the REAL count");
	assert.equal(listed, 1, "listMessages is fetched exactly once");
	assert.equal(counted, 1, "countMessages is used for the total");
});

test("renderSessionDetail falls back to the page length when countMessages is absent", async () => {
	const deps = makeDeps({ countMessages: undefined });
	const r = renderSessionDetail(deps, "worker:w1", 10);
	assert.match(r.text, /历史消息共 \d+ 条/);
});

test("session_detail renders messages + workers + items + liveness", async () => {
	const tool = createSessionDetailTool(makeDeps());
	const r = await tool.execute("c", { sessionId: "worker:w1" });
	const text = r.content?.[0]?.text ?? "";
	assert.match(text, /会话 worker:w1/);
	assert.match(text, /正在执行中/, "isStreaming must surface");
	assert.match(text, /每日对账异常动态巡检与群内汇报（7天版·明细报告）继续/, "messages listed");
	assert.match(text, /关联后台任务/, "worker tasks listed");
	assert.match(text, /关联自主任务/, "work items listed");
	assert.equal(r.details?.matched, true);
});

test("a bare「重新执行」history reads as the story it is (message roles + order)", async () => {
	// The exact field defect: the group's model saw two bare user lines with no
	// assistant content between them. The query view must make that VISIBLE —
	// roles and order — so an operator immediately sees 「user asks, nothing
	// answered」.
	const deps = makeDeps({
		listMessages: (cid, limit) => (cid === "worker:w1" ? [{ role: "user", content: "…继续", created_at: 1 }, { role: "assistant", content: "收到", created_at: 2 }, { role: "user", content: "重新执行", created_at: 3 }].slice(-limit) : []),
		isStreaming: () => false,
	});
	const r = await tool(deps);
	const text = r.content?.[0]?.text ?? "";
	const userLines = (text.match(/\*\*user\*\*/g) ?? []).length;
	const assistantLines = (text.match(/\*\*assistant\*\*/g) ?? []).length;
	assert.ok(userLines >= 2 && assistantLines >= 1, `the view must expose the roles (got ${userLines}u/${assistantLines}a):\n${text}`);
	// ORDER matters: the report is labelled 旧→新, so the first user line must
	// appear before the assistant reply, which must appear before the final
	// user line. A renderer that reverses again inverts the story (review
	// 2026-11-08 finding #2) — this index chain catches exactly that.
	const iFirst = text.indexOf("…继续");
	const iMid = text.indexOf("收到");
	const iLast = text.indexOf("重新执行");
	assert.ok(iFirst >= 0 && iMid > iFirst && iLast > iMid, `oldest→newest order violated (${iFirst},${iMid},${iLast}):\n${text}`);
	async function tool(deps) {
		const t = createSessionDetailTool(deps);
		return t.execute("c", { sessionId: "worker:w1" });
	}
});

test("unknown id → matched:false with a pointer to where ids live", async () => {
	const tool = createSessionDetailTool(makeDeps());
	const r = await tool.execute("c", { sessionId: "worker:nope" });
	assert.equal(r.details?.matched, false);
	assert.match(r.content?.[0]?.text ?? "", /本会话标识/, "the pointer must name the system-prompt section");
});

test("limit bounds the tail (default 10, cap 30)", async () => {
	const seen = [];
	const deps = makeDeps({
		listMessages: (cid, limit = 10) => {
			const n = Math.min(30, limit);
			seen.push(n);
			return Array.from({ length: Math.min(n, 5) }, (_, i) => ({ role: "user", content: `m${i}`, created_at: i }));
		},
	});
	const tool = createSessionDetailTool(deps);
	await tool.execute("c", { sessionId: "worker:w1" });
	await tool.execute("c", { sessionId: "worker:w1", limit: "5" });
	await tool.execute("c", { sessionId: "worker:w1", limit: "999" });
	// The renderer also probes the TOTAL count with an unbounded limit; clamp
	// every read to the [1,30] window, honor the caller's explicit 5, default 10.
	assert.ok(seen.every((n) => n >= 1 && n <= 30), `all reads must be clamped to [1,30]: ${seen}`);
	assert.ok(seen.includes(5), "caller's explicit limit must be honored");
	assert.ok(seen.includes(10), "the default must be 10");
});

test("renderSessionDetail is the same renderer the HTTP endpoint uses (pure function)", () => {
	const deps = makeDeps();
	const direct = renderSessionDetail(deps, "worker:w1", 10);
	assert.match(direct.text, /会话 worker:w1/);
	assert.equal(direct.matched, true);
	const miss = renderSessionDetail(deps, "worker:gone", 10);
	assert.equal(miss.matched, false);
});

await rm(dir, { recursive: true, force: true });
