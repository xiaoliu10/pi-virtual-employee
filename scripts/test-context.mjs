/**
 * Context-window tests. Run with `npm run test:context`.
 *
 * Field incident this file exists for: a qwen relay rejected a request at its
 * 204800-token limit (`ContextWindowExceededError`) and the whole turn was lost,
 * because the app's size estimate divided characters by 4 — an English heuristic
 * that under-counts Chinese by 3–5×. Compaction therefore never fired, and a
 * conversation the app judged "~50k tokens" was really over the model's limit.
 *
 * So the pinned properties are: the estimate must not under-count CJK, the
 * provider's rejection must be recognised however it is worded, and the
 * last-resort truncation must actually free room while keeping a usable tail.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.context-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "context.mjs");
await build({
	stdin: {
		contents: `
			export { estimateTokensSafe, estimateMessageTokens, isContextOverflowError, truncateToFit, findCompactionCut, findForcedCompactionCut, stripDanglingAssistant, stripStaleUsage, progressContextSlice, FALLBACK_CONTEXT_WINDOW } from "./src/engine/context.ts";
			export { estimateTokens } from "@earendil-works/pi-agent-core";
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
const { estimateTokensSafe, estimateMessageTokens, isContextOverflowError, truncateToFit, findCompactionCut, findForcedCompactionCut, stripDanglingAssistant, stripStaleUsage, progressContextSlice, FALLBACK_CONTEXT_WINDOW, estimateTokens } = await import(pathToFileURL(bundle).href);

const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });

test("Chinese text is not under-counted the way pi's English heuristic does", () => {
	const cn = "这是一段中文内容，用来验证估算不会严重低估。".repeat(50); // 1100 chars
	const mine = estimateMessageTokens(user(cn));
	const theirs = estimateTokens(user(cn));
	assert.ok(mine > theirs * 2, `CJK must be counted far higher than chars/4 (got ${mine} vs ${theirs})`);
	assert.ok(mine >= cn.length * 0.9, "a Chinese character is roughly one token, so the estimate must be near the char count");

	// English still tracks the usual ~4 chars/token.
	const en = "The quick brown fox jumps over the lazy dog. ".repeat(20);
	const enMine = estimateMessageTokens(user(en));
	const enTheirs = estimateTokens(user(en));
	assert.ok(enMine >= enTheirs && enMine <= enTheirs * 1.4, `English should stay near pi's estimate (${enMine} vs ${enTheirs})`);

	// Mixed content, and the aggregate never below pi's own number.
	const messages = [user(cn), assistant(en), user("混合 mixed 内容")];
	assert.ok(estimateTokensSafe(messages) >= estimateTokens(messages.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : 0), 0) / 4));
	assert.ok(estimateTokensSafe(messages) >= 1100, "the CJK block dominates and must show up");
});

test("tool call arguments and results are counted, not just prose", () => {
	// A single tool result can be the thing that blows the window (page dumps,
	// file reads, logs), so it must not be invisible to the estimate.
	const huge = { role: "toolResult", content: [{ type: "text", text: "数据".repeat(2000) }] };
	const small = user("好的");
	assert.ok(estimateMessageTokens(huge) > 3000, `a big tool result must weigh (got ${estimateMessageTokens(huge)})`);
	assert.ok(estimateMessageTokens(huge) > estimateMessageTokens(small) * 100);
	const withArgs = { role: "assistant", content: [{ type: "toolCall", name: "read_file", arguments: { path: "/tmp/x", body: "字".repeat(500) } }] };
	assert.ok(estimateMessageTokens(withArgs) > 400, "tool-call arguments count too");
});

test("every way a relay words 'too long' is recognised", () => {
	const samples = [
		'litemllm.ContextWindowExceededError: This model\'s maximum context length is 204800 tokens',
		'{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
		"400 Bad Request: context_length_exceeded",
		"Error code: 400 - context length exceeded, reduce the length of the input prompt",
		"the prompt is too long",
		"too many tokens in the request",
	];
	for (const text of samples) assert.equal(isContextOverflowError(text), true, `must recognise: ${text}`);
	for (const text of ["ECONNRESET", "429 rate limit exceeded", "invalid api key", "内容太长"]) {
		assert.equal(isContextOverflowError(text), false, `must NOT claim: ${text}`);
	}
});

test("last-resort truncation frees room and keeps a usable tail on a turn boundary", () => {
	// 30 turns of Chinese, each ~2k tokens → far past a small window.
	const messages = [];
	for (let i = 0; i < 30; i += 1) {
		messages.push(user(`第 ${i} 个问题：请汇总这批数据。` + "数据".repeat(900)));
		messages.push(assistant("好的，这是汇总结果。" + "结果".repeat(900)));
	}
	const agent = { state: { messages } };
	const before = estimateTokensSafe(messages);
	assert.ok(before > 40_000, `fixture must be big (got ${before})`);

	const dropped = truncateToFit(agent, 8_000);
	assert.ok(dropped > 0, "something must be dropped");
	const after = estimateTokensSafe(agent.state.messages);
	assert.ok(after < before / 2, `must actually free room (${before} → ${after})`);
	assert.equal(agent.state.messages[0].role, "compactionSummary", "the cut is disclosed, not silent");
	assert.match(agent.state.messages[0].summary, /上下文超出模型上限/);
	assert.equal(agent.state.messages[1].role, "user", "the kept tail starts on a user turn (providers require clean turn order)");

	// Too short to split → honest null rather than an empty transcript.
	const tiny = { state: { messages: [user("你好"), assistant("你好，有什么可以帮你？")] } };
	assert.equal(truncateToFit(tiny, 1), null);
	assert.equal(tiny.state.messages.length, 2, "nothing was destroyed");
});

// Field incident 2026-09-17: the fallback window was 128k while a litellm-relayed
// qwen really has 204800 — the budget gate drew its line on the fake figure and
// never let the conversation breathe. The default is now 200k (relay models can
// set the per-model override higher still).
test("fallback context window is 200k, not the old English-heuristic-era 128k", () => {
	assert.equal(FALLBACK_CONTEXT_WINDOW, 200_000);
});

// Field incident 2026-09-17: a 112k conversation whose final turn's own tool
// results filled the keep-recent tail had NO user boundary in the tail, so
// compaction returned "nothing to do" forever while the budget gate kept
// tripping every turn — every task ended as a forced mid-task summary.
test("cut point falls back to the last user turn when the tail is inside the final turn", () => {
	const messages = [user("旧任务")];
	for (let i = 0; i < 20; i += 1) messages.push(assistant("历史内容。" + "案".repeat(2200))); // past 20k tail
	messages.push(user("本轮请求"));
	// Final turn's tool result — huge, and followed only by assistant text, so
	// the naive forward scan for a user boundary runs off the transcript end.
	messages.push(assistant("正在查询…"));
	messages.push({ role: "toolResult", content: "结果" + "账".repeat(30_000), timestamp: Date.now() });
	messages.push(assistant("汇总：查询到很多数据。"));

	const cut = findCompactionCut(messages, 20_000);
	assert.ok(cut > 0, "must find a cut point, not give up");
	assert.equal(messages[cut].role, "user", "tail must start on a user turn");
	assert.equal(cut, messages.length - 4, "cut must rewind to the LAST user message");
	assert.ok(estimateTokensSafe(messages.slice(0, cut)) > 20_000, "the summarizable head is not empty");

	// Ordinary case unchanged: short final turn keeps the naive behaviour —
	// everything fits in the tail ⇒ nothing to summarize (cut 0).
	const small = [user("hi"), assistant("同样是回答，内容很短"), user("好"), assistant("好")];
	assert.equal(findCompactionCut(small, 20_000), 0);

	// No user message at all anywhere → 0 (nothing summarizable before a boundary).
	const roleless = [assistant("只有一条助手消息，且很长。" + "长".repeat(30_000))];
	assert.equal(findCompactionCut(roleless, 20_000), 0);
});

// Field request 2026-09-17: the heartbeat's raw snippet ("检查表格当前行状态")
// gave no sense of task position, so the heartbeat now summarizes a side-channel
// slice: the TASK statement plus a recent tail.
test("progress context keeps the task goal in view alongside the recent tail", () => {
	const goal = user("任务：对账 7 月渠道账单，核对每笔退款");
	const filler = [];
	for (let i = 0; i < 30; i += 1) filler.push(assistant("中间步骤。" + "步".repeat(2400)));
	const recent = [user("继续"), assistant("正在核对第 3 批退款明细。")];
	const messages = [goal, ...filler, ...recent];

	const slice = progressContextSlice(messages, 20_000);
	assert.equal(slice[0], goal, "the task statement must always be in view");
	assert.ok(slice.includes(recent[0]) && slice.includes(recent[1]), "the recent tail must be included");
	assert.ok(slice.length < messages.length, "the middle bulk is not needed for a progress report");

	// Short transcript where the tail already covers the goal — no duplicate.
	const small = [user("任务 A"), assistant("做了一半")];
	const sliceSmall = progressContextSlice(small, 20_000);
	assert.equal(sliceSmall.length, small.length);
	assert.equal(sliceSmall[0], small[0]);

	assert.deepEqual(progressContextSlice([], 20_000), []);
});

// Field request 2026-09-18: an explicit /compact must EXECUTE, not refuse.
// Single-turn sessions (one task statement + a huge execution trace) had no
// user boundary to cut on — now the forced path keeps the task statement and
// summarizes the middle.
test("forced cut handles single-turn transcripts: keep the task, summarize the middle", () => {
	const task = user("任务：对账 7 月渠道账单，逐商户下载对账文件");
	const messages = [task];
	// One long turn: alternating assistant narration and tool results.
	for (let i = 0; i < 30; i += 1) {
		messages.push(assistant(`执行第 ${i} 步。` + "执".repeat(2000)));
		messages.push({ role: "toolResult", content: "结果" + "果".repeat(600), timestamp: Date.now() });
	}

	const forced = findForcedCompactionCut(messages, 20_000);
	assert.ok(forced, "a 40k+ single-turn session must yield a forced cut");
	assert.equal(forced.keepIndex, 0, "the task statement is the kept anchor");
	assert.ok(forced.cut > 1 && forced.cut < messages.length, "middle content exists on both sides");
	assert.equal(messages[forced.cut].role, "assistant", "tail must not open on an orphaned toolResult");

	// Summarizable middle is substantial.
	const middle = messages.slice(1, forced.cut);
	assert.ok(estimateTokensSafe(middle) > 10_000, "the summarized middle must actually free room");

	// Tiny sessions still refuse: nothing outside the keep window.
	const tiny = [user("hi"), assistant("hello")];
	assert.equal(findForcedCompactionCut(tiny, 20_000), null);
});

// Field incident 2026-09-18: "Cannot continue from message role: assistant".
// An aborted/interrupted request leaves a trailing assistant message (empty, or
// carrying toolCalls whose results never arrived); continuing from it throws.
test("stripDanglingAssistant removes the un-resumable tail but keeps completed replies", () => {
	const toolCall = (id) => ({ role: "assistant", content: [{ type: "text", text: "查一下" }, { type: "toolCall", id, name: "x", arguments: {} }], timestamp: Date.now() });

	// Empty assistant tail (stream died before any text) → removed.
	let msgs = [user("任务"), assistant("")];
	assert.equal(stripDanglingAssistant(msgs), 1);
	assert.equal(msgs.length, 1);

	// Assistant with toolCalls but no toolResult (watchdog aborted the loop) → removed.
	msgs = [user("任务"), toolCall("c1")];
	assert.equal(stripDanglingAssistant(msgs), 1);
	assert.equal(msgs.length, 1);

	// Completed final reply (text, no tool calls) → preserved.
	msgs = [user("任务"), assistant("已完成：结果是 42。")];
	assert.equal(stripDanglingAssistant(msgs), 0);
	assert.equal(msgs.length, 2);

	// Trailing toolResult or user → nothing to strip.
	msgs = [user("任务"), toolCall("c2"), { role: "toolResult", content: "ok", timestamp: Date.now() }];
	assert.equal(stripDanglingAssistant(msgs), 0);
	msgs = [user("任务")];
	assert.equal(stripDanglingAssistant(msgs), 0);
});

// Field incident 2026-09-18 (16:26 北京时间): the budget gate ran a compaction
// that SUCCEEDED ("compacted 434 turns → summary") yet immediately ruled
// "~188760 ≥ 188416 — could not free room" and killed the turn. Cause: the
// kept tail's last usage record described the PRE-compaction request, and
// estimateTokensSafe trusts that floor — so a freshly compacted transcript
// still estimated at its old size. Stripping the stale record must drop the
// estimate back to char counting.
test("stale usage floor must not survive a compaction cut", () => {
	const withUsage = (text, total) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { totalTokens: total },
		stopReason: "stop",
		timestamp: Date.now(),
	});

	// Floor active: a usage record pins the estimate at the provider's number.
	const floored = [withUsage("hello world", 188760)];
	assert.equal(estimateTokensSafe(floored), 188760);

	// After stripping: falls back to char-based estimation (tiny here).
	const stripped = floored.map(stripStaleUsage);
	assert.ok(estimateTokensSafe(stripped) < 1000, `expected char-based estimate, got ${estimateTokensSafe(stripped)}`);
	assert.equal(stripped[0].usage, undefined);

	// Non-assistant and usage-less messages pass through untouched.
	const u = user("任务");
	const plain = assistant("回答");
	assert.equal(stripStaleUsage(u), u);
	assert.equal(stripStaleUsage(plain), plain);
});
