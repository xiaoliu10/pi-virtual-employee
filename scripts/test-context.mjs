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
			export { estimateTokensSafe, estimateMessageTokens, isContextOverflowError, truncateToFit } from "./src/engine/context.ts";
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
const { estimateTokensSafe, estimateMessageTokens, isContextOverflowError, truncateToFit, estimateTokens } = await import(pathToFileURL(bundle).href);

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
