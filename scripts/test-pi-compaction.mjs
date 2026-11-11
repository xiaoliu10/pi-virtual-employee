/**
 * Vendored compaction primitives — upstream backport regression pins.
 *
 * Field incident 2026-11-10 (box Nova, qwen relay, 204800 hard limit): a
 * day-long browser-automation worker "compacted" three times yet measured
 * 198936 → 199722 → 210321 tokens, each pass taking ~80s, and the turn died on
 * the provider wall. Root cause was NOT the cut point or the budget gate — the
 * summarization request itself was broken in the vendored 1.1.0 snapshot:
 *
 *   1. serializeConversation emitted `[Assistant thinking]: …`, feeding 280
 *      turns of full reasoning chains into the summarizer. Upstream (1.2.0+,
 *      still in 1.5.0) omits thinking precisely because "including it can make
 *      the summarization request larger than the context it summarizes".
 *   2. generateSummaryWithUsage capped output at min(0.8 * reserveTokens,
 *      model.maxTokens) = 13107 tokens. On a reasoning model the thinking alone
 *      consumes that cap → stopReason "length" → getSummarizationFailure throws
 *      → compaction can never succeed on exactly the transcripts that need it.
 *      Upstream #9512 removed the cap: summaries use the model's output limit.
 *
 * pi-desktop does not hand-roll any of this: it runs pi-coding-agent 1.5.0's
 * AgentSession, which owns the whole compaction lifecycle. VE vendors the
 * primitives (bundle-size cap) and drives them itself, so the fixes must be
 * backported explicitly — these tests pin them.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.pi-compaction-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "pi-compaction.mjs");
await build({
	stdin: {
		contents: `
			export { serializeConversation, generateSummaryWithUsage, getSummarizationFailure, convertToLlm, SUMMARIZATION_SYSTEM_PROMPT } from "./src/engine/pi-compaction.ts";
			export { estimateTokensSafe } from "./src/engine/context.ts";
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
const { serializeConversation, generateSummaryWithUsage, getSummarizationFailure, estimateTokensSafe } = await import(pathToFileURL(bundle).href);

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistantWithThinking = (thinking, text, toolName) => ({
	role: "assistant",
	content: [
		{ type: "thinking", thinking },
		...(text ? [{ type: "text", text }] : []),
		...(toolName ? [{ type: "toolCall", id: "c1", name: toolName, arguments: { path: "/tmp/x" } }] : []),
	],
	stopReason: "toolUse",
	timestamp: Date.now(),
});
const toolResult = (text) => ({ role: "toolResult", toolCallId: "c1", toolName: "browser_evaluate", content: [{ type: "text", text }], timestamp: Date.now() });

// ── 1. thinking is omitted from the summarization request ──

test("serializeConversation omits thinking blocks (upstream 1.2.0+ backport — the incident root cause)", () => {
	const THINKING = "推理链内容不应进入摘要请求。".repeat(200);
	const messages = [
		user("查一下这笔流水的支付渠道下单日志"),
		assistantWithThinking(THINKING, "我先打开订单系统。", "browser_navigate"),
		toolResult("页面已加载"),
	];
	const out = serializeConversation(messages);
	assert.ok(!out.includes("推理链内容"), "thinking text must never reach the summarizer");
	assert.ok(!out.includes("[Assistant thinking]"), "the thinking section label is gone");
	assert.ok(out.includes("[User]: 查一下这笔流水"), "the user request survives");
	assert.ok(out.includes("[Assistant]: 我先打开订单系统。"), "visible assistant text survives");
	assert.ok(out.includes("browser_navigate(path="), "tool calls survive (they record what happened)");
	assert.ok(out.includes("[Tool result]: 页面已加载"), "tool results survive");
});

test("a thinking-only assistant turn contributes nothing but its tool calls", () => {
	const messages = [assistantWithThinking("纯思考，没有正文。".repeat(500), "", "run_command")];
	const out = serializeConversation(messages);
	assert.ok(!out.includes("纯思考"), "no thinking leakage");
	assert.ok(!out.includes("[Assistant]:"), "no empty visible-text section");
	assert.ok(out.includes("[Assistant tool calls]: run_command"), "the action is still recorded");
});

// ── 2. tool results stay truncated (pre-existing guard, pinned) ──

test("tool results are truncated to 2000 chars for summarization", () => {
	const huge = "DOM 快照内容。".repeat(2000); // ~14000 chars
	const out = serializeConversation([toolResult(huge)]);
	assert.ok(out.length < 2600, `a single tool result must stay bounded (got ${out.length})`);
	assert.ok(out.includes("more characters truncated]"), "the truncation marker is present");
});

// ── 3. the incident shape: the request must be SMALLER than the context ──

test("a worker-shaped transcript serializes to a fraction of its own size (request < context it summarizes)", () => {
	const THINKING = "这是一段很长的模型推理链，记录了每一步的思考过程。".repeat(120); // ~3600 chars/turn
	const DOM = "页面 DOM 与日志输出内容。".repeat(500); // ~6000 chars/result
	const messages = [user("帮我查一下这笔流水：0422026111000000654 的支付渠道下单日志")];
	for (let i = 0; i < 60; i++) {
		messages.push(assistantWithThinking(THINKING, `第 ${i} 步完成。`, "browser_evaluate"));
		messages.push(toolResult(DOM));
	}
	const transcriptTokens = estimateTokensSafe(messages);
	const serialized = serializeConversation(messages);
	const requestTokens = estimateTokensSafe([user(serialized)]);
	assert.ok(transcriptTokens > 100_000, `fixture must resemble the field transcript (got ${transcriptTokens})`);
	assert.ok(
		requestTokens < transcriptTokens / 3,
		`the summarization request must be far smaller than the context it summarizes (request ${requestTokens} vs transcript ${transcriptTokens})`,
	);
	assert.ok(!serialized.includes("模型推理链"), "none of the 60 thinking chains leaked into the request");
});

// ── 4. summaries use the model's output limit, not 0.8 * reserve (#9512) ──

test("generateSummaryWithUsage does not cap output at a fraction of the compaction reserve (upstream #9512)", async () => {
	let seenOptions;
	const model = { id: "qwen", name: "qwen", reasoning: true, maxTokens: 32768, contextWindow: 204800, input: ["text"], api: "openai-completions", baseUrl: "https://relay.example.com/v1" };
	const streamFn = async (_model, _context, options) => {
		seenOptions = options;
		return {
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "## Goal\n查流水\n## Progress\n### Done\n- [x] 已定位" }],
				stopReason: "stop",
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
			}),
		};
	};
	const { text } = await generateSummaryWithUsage(
		[user("查流水"), assistantWithThinking("思考", "开始查", "run_command")],
		model,
		16384, // the shipped reserve: the old code capped output at 0.8 * 16384 = 13107
		undefined, undefined, undefined, undefined, undefined, undefined,
		streamFn, undefined, undefined, undefined, "session-1",
	);
	assert.ok(text.includes("## Goal"), "the summary text is returned");
	assert.equal(
		seenOptions.maxTokens,
		undefined,
		"no explicit output cap: the request must use the model's own output limit (the 13107 cap starved reasoning models)",
	);
	assert.equal(seenOptions.cacheRetention, "none", "one-off summaries must not write the prompt cache");
});

test("a declared thinking level is forwarded, and 'off' is not", async () => {
	const model = { id: "qwen", reasoning: true, maxTokens: 32768, contextWindow: 204800, input: ["text"], api: "openai-completions", baseUrl: "https://relay.example.com/v1" };
	const seen = [];
	const streamFn = async (_m, _c, options) => {
		seen.push(options.reasoning);
		return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "## Goal\nok" }], stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 } }) };
	};
	await generateSummaryWithUsage([user("x")], model, 16384, undefined, undefined, undefined, undefined, undefined, "high", streamFn, undefined, undefined, undefined, "s");
	await generateSummaryWithUsage([user("x")], model, 16384, undefined, undefined, undefined, undefined, undefined, "off", streamFn, undefined, undefined, undefined, "s");
	assert.deepEqual(seen, ["high", undefined], "off must not request reasoning; a real level is forwarded");
});

// ── 5. an incomplete summary must never become a checkpoint ──

test("getSummarizationFailure rejects length/error/aborted summaries (host hardening)", () => {
	const base = { role: "assistant", content: [{ type: "text", text: "部分摘要" }] };
	assert.match(getSummarizationFailure({ ...base, stopReason: "length" }, "Summarization"), /token cap/);
	assert.match(getSummarizationFailure({ ...base, stopReason: "error", errorMessage: "boom" }, "Summarization"), /boom/);
	assert.match(getSummarizationFailure({ ...base, stopReason: "aborted" }, "Summarization"), /Aborted/);
	assert.equal(getSummarizationFailure({ ...base, stopReason: "stop" }, "Summarization"), undefined);
});

test("a length-truncated summary throws instead of silently replacing the transcript", async () => {
	const model = { id: "qwen", reasoning: true, maxTokens: 32768, contextWindow: 204800, input: ["text"], api: "openai-completions", baseUrl: "https://relay.example.com/v1" };
	const streamFn = async () => ({
		result: async () => ({ role: "assistant", content: [{ type: "text", text: "## Goal\n被截断的半个摘要" }], stopReason: "length", usage: { input: 1, output: 1, totalTokens: 2 } }),
	});
	await assert.rejects(
		() => generateSummaryWithUsage([user("x")], model, 16384, undefined, undefined, undefined, undefined, undefined, undefined, streamFn, undefined, undefined, undefined, "s"),
		/token cap/,
	);
});
