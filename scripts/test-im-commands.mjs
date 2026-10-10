/**
 * Inbound command recognition tests. Run with `npm run test:im-commands`.
 *
 * Reported twice from the field as "群聊里 @机器人 /new 不生效". The old code
 * compared `text.trim() === "/new"` after a narrow mention strip, so every
 * serialization it had not anticipated fell through to the model as ordinary
 * chat — the user saw the employee *talking about* /new instead of clearing the
 * session. These cases pin the whole shape of the problem, including the
 * negative cases (a slash word we do not know must not hijack the message).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.im-commands-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "commands.mjs");
await build({
	stdin: {
		contents: 'export { parseCommand, normalizeInboundText, looksLikeCommandAttempt, isCancelPhrase, QUEUE_BYPASS_COMMANDS } from "./src/im/commands.ts";',
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { parseCommand, normalizeInboundText, looksLikeCommandAttempt, isCancelPhrase, QUEUE_BYPASS_COMMANDS } = await import(pathToFileURL(bundle).href);

test("/new is recognised however the client serializes the mention", () => {
	const variants = [
		"/new",
		" /new ",
		"\n/new\n",
		"@小派 /new", // mention + space (the common case)
		"@小派/new", // mention glued to the command
		"@小派\u3000/new", // ideographic space (CJK keyboard)
		"@小派\u00a0/new", // non-breaking space
		"@小派 @张三 /new", // several mentions
		"@机器人  @小派   /new", // messy whitespace
		"／new", // FULL-WIDTH slash from a Chinese IME
		"@小派 ／new",
		"/new\n上下文太长了", // extra text on the following line is not part of the command
		"/NEW", // case-insensitive
	];
	for (const text of variants) {
		assert.equal(parseCommand(text)?.name, "new", `must parse as /new: ${JSON.stringify(text)}`);
	}
});

test("the full command set parses, and /model keeps its argument", () => {
	const cases = [
		["/stop", "stop", undefined],
		["@小派 /stop", "stop", undefined],
		["/help", "help", undefined],
		["/?", "help", undefined],
		["/compact", "compact", undefined],
		["@小派 /perm", "perm", undefined],
		["/whoami", "perm", undefined],
		["/version", "version", undefined],
		["/ver", "version", undefined],
		["/models", "models", undefined],
		["/model", "models", undefined],
		["/model 3", "model", "3"],
		["@小派 /model qwen-max", "model", "qwen-max"],
		["／restart", "restart", undefined],
	];
	for (const [text, name, arg] of cases) {
		const parsed = parseCommand(text);
		assert.equal(parsed?.name, name, `must parse as /${name}: ${JSON.stringify(text)}`);
		assert.equal(parsed?.arg, arg, `argument mismatch for ${JSON.stringify(text)}`);
	}
});

test("ordinary text is never mistaken for a command", () => {
	const text = [
		"帮我看看 /new 这个命令是怎么实现的",
		"/news", // not a command word
		"/新的一轮", // ambiguous-looking, but not one of ours
		"请 /new 一下",
		"列一下 /models 里的模型", // slash word not at the start of the line
		"@小派 你好",
		"",
		"   ",
		"/",
		"/ ",
		"@小派",
	];
	for (const t of text) {
		assert.equal(parseCommand(t), null, `must NOT be a command: ${JSON.stringify(t)}`);
	}
	// Only unknown command WORDS count as attempts worth logging; prose does not.
	assert.equal(looksLikeCommandAttempt("/news"), true, "an unknown slash word is worth a diagnostic line");
	assert.equal(looksLikeCommandAttempt("@小派 /new"), false);
	assert.equal(looksLikeCommandAttempt("帮我看看 /new 的实现"), false, "a slash mid-sentence is content");
	assert.equal(looksLikeCommandAttempt("@小派 你好"), false);
});

test("normalizeInboundText only touches the start, and leaves prose alone", () => {
	assert.equal(normalizeInboundText("@小派 /new"), "/new");
	assert.equal(normalizeInboundText("@小派/new"), "/new");
	assert.equal(normalizeInboundText("／help"), "/help");
	assert.equal(normalizeInboundText("联系 @张三 处理"), "联系 @张三 处理", "a mention later in the sentence is content");
	assert.equal(normalizeInboundText("  @小派   把昨天订单汇总一下"), "把昨天订单汇总一下");
	assert.equal(normalizeInboundText(""), "");
});

// ── steer + cancel phrases (field 2026-10-10: a long task blocked the queue,
//    so the user's "取消任务" never reached the model) ──

test("/steer parses with and without a payload", () => {
	assert.deepEqual(parseCommand("/steer 先保存结果收尾"), { name: "steer", arg: "先保存结果收尾" });
	assert.deepEqual(parseCommand("/steer"), { name: "steer", arg: undefined });
	assert.deepEqual(parseCommand("@机器人 /steer 别做了"), { name: "steer", arg: "别做了" });
	// A slash word we do not know must NOT be mistaken for steer.
	assert.equal(parseCommand("/steering"), null);
});

test("steer bypasses the per-conversation queue (like /new and /stop)", () => {
	assert.ok(QUEUE_BYPASS_COMMANDS.includes("steer"), "steer must bypass the queue");
	assert.ok(QUEUE_BYPASS_COMMANDS.includes("stop"));
	assert.ok(QUEUE_BYPASS_COMMANDS.includes("new"));
});

test("plain cancel phrases are recognised so a live turn can be steered", () => {
	for (const text of ["取消", "取消任务", "取消这个任务", "停止", "停下", "先停一下", "别做了", "终止当前任务", "现在停止执行", "给我取消"]) {
		assert.ok(isCancelPhrase(text), `cancel phrase: ${text}`);
	}
});

test("cancel detection is narrow: instructions and questions are NOT cancels", () => {
	for (const text of [
		"取消一下昨天的订单然后重新提交",     // an instruction, not a bare cancel
		"先取消这个，然后把剩下的跑完",     // continues the task
		"取消是什么意思",                   // a question
		"帮我看下为什么停了",               // asks about a stop
		"不用取消，继续",                   // explicitly NOT a cancel
		"今天的对账取消了吗",               // asks about state
		"/stop",                            // slash commands have their own path
		"停",                               // too short/ambiguous alone
	]) {
		assert.ok(!isCancelPhrase(text), `not a cancel: ${text}`);
	}
});

test("mention/full-width-slash variants of a cancel phrase still count", () => {
	assert.ok(isCancelPhrase("@机器人 取消任务"));
	assert.ok(isCancelPhrase("取消任务。"));
});
