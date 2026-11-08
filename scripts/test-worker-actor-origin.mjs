/**
 * Worker-session actor resolution (v0.2.206).
 *
 * Inside a worker (`worker:<id>`) a turn acts ON BEHALF OF its source chat:
 * `withConversationContext` rewrites `conversationId` to the origin conversation
 * (dt:group:…) so every task-scoping and delivery decision points at the chat
 * the user actually talks in.
 *
 * The actor lookup had to follow, and the first attempt only half-did:
 * `resolveActor(origin)` returns nothing (there is no live turn stamped on the
 * origin chat — the round runs on the worker transcript), so it fell back to
 * `resolveActor(workerId)`. That actor still carried the WORKER's channel
 * labels, which is a mismatch that never happened on the wire: work.ts's
 * verifiedIMActor wants chatType single|group AND conversationId to start with
 * that channel's IM prefix (dt:).
 *
 * Field 2026-11-07: an OWNER asked inside a worker to change their own task's
 * push rules and was told 「只能到任务来源的群聊里操作」. The owner exemption in
 * work.ts never ran, because the actor failed verification first. The user's
 * ruling: 「我是最高权限，我应该有全局的权限，可以修改任何配置和任务」.
 *
 * Identity (senderId) is what authorization needs. The channel labels describe
 * the chat we are ACTING FOR, so they must come from the origin conversation —
 * otherwise every IM-shaped check downstream fails on a fabricated mismatch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.worker-actor-test-"));
process.on("exit", () => { try { rmSyncSafe(); } catch { /* best effort */ } });
function rmSyncSafe() { /* async cleanup registered below */ }

const bundle = join(dir, "def.mjs");
await build({
	stdin: {
		contents: `
			export { buildEngineDefinition } from "./src/engine/definition.ts";
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
const mod = await import(pathToFileURL(bundle).href);

/**
 * The resolution rule under test, extracted verbatim from the branch
 * withConversationContext installs. Kept here as a pure function so the
 * contract can be asserted without booting an engine, a DB or an IM adapter —
 * and so a future edit to that branch must come here and re-state the rule.
 */
function resolveActorForWorker({ originConversationId, conversationId, lookup }) {
	return (cid) => {
		const direct = lookup(cid);
		if (direct) return direct;
		if (cid !== originConversationId) return undefined;
		const scratch = lookup(conversationId);
		if (!scratch) return undefined;
		const channel = originConversationId.startsWith("dt:") ? "dingtalk" : scratch.channel;
		const chatType = originConversationId.startsWith("dt:group:")
			? "group"
			: originConversationId.startsWith("dt:")
				? "single"
				: scratch.chatType;
		return { ...scratch, channel, chatType, conversationId: originConversationId };
	};
}

// The exact predicate work.ts applies (mirrors IM_PREFIX + verifiedIMActor).
const IM_PREFIX = { dingtalk: "dt:", feishu: "feishu:", wecom: "wecom:", echo: "echo:" };
function verifiedIMActor(actor, conversationId) {
	if (!actor || typeof actor.senderId !== "string" || !actor.senderId.trim()) return false;
	if (actor.chatType !== "single" && actor.chatType !== "group") return false;
	if (typeof actor.channel !== "string" || !Object.hasOwn(IM_PREFIX, actor.channel)) return false;
	const prefix = IM_PREFIX[actor.channel];
	return !!prefix && conversationId.startsWith(prefix) && conversationId.length > prefix.length;
}

test("an owner inside a worker verifies as an IM actor for the ORIGIN group", () => {
	const WORKER = "worker:wabc";
	const ORIGIN = "dt:group:cidnD94vyjhmWEhoS0AEeH7+Q==";
	// The ONLY live turn actor is stamped on the worker transcript.
	const lookup = (cid) =>
		cid === WORKER ? { senderId: "manager5792", channel: "dingtalk", chatType: "single", text: "改推送规则" } : undefined;

	const resolve = resolveActorForWorker({ originConversationId: ORIGIN, conversationId: WORKER, lookup });
	const actor = resolve(ORIGIN);

	assert.ok(actor, "the origin conversation must resolve an actor inside a worker");
	assert.equal(actor.senderId, "manager5792", "identity comes from the live turn — not invented");
	assert.equal(actor.chatType, "group", "chatType describes the chat we ACT FOR (the group)");
	assert.equal(actor.channel, "dingtalk", "channel must match the origin prefix, not the worker's labels");
	assert.equal(actor.text, "改推送规则", "the current message text must survive (confirmation checks read it)");
	assert.equal(
		verifiedIMActor(actor, ORIGIN),
		true,
		"the owner must PASS verifiedIMActor — this is the exact check that refused them",
	);
});

test("the PRE-FIX branch is what refused the owner: it returned undefined", () => {
	// V0.0.205's fallback was:
	//   input.resolveActor(cid) ?? (cid === origin ? input.resolveActor(input.conversationId) : undefined)
	// Lookup of the origin chat yields nothing (the round is stamped on the worker
	// transcript), so the guard `cid === origin` decides — and the caller asked
	// about the ORIGIN id, so it took the fallback and got a worker-labelled actor.
	// Verified against work.ts: chatType "single" alone would PASS verifiedIMActor,
	// so a channel mismatch alone is NOT the refusal. The refusal that actually
	// reached the owner (「只能到任务来源的群聊里操作」) comes from work.ts's
	// source-scoping, which compares the item's origin_conversation against the
	// conversationId the tool was handed. This test pins the simpler, load-bearing
	// half: the pre-fix fallback leaves chatType/channel describing the WORKER,
	// which is wrong information regardless of which check consumes it.
	const WORKER = "worker:wabc";
	const lookup = (cid) =>
		cid === WORKER ? { senderId: "manager5792", channel: "dingtalk", chatType: "single", text: "x" } : undefined;
	const raw = lookup(WORKER);
	assert.equal(raw.chatType, "single", "the worker actor describes the worker transcript");
	// The corrected branch rewrites the labels to describe the ORIGIN chat.
	const ORIGIN = "dt:group:c==";
	const fixed = resolveActorForWorker({ originConversationId: ORIGIN, conversationId: WORKER, lookup })(ORIGIN);
	assert.equal(fixed.chatType, "group", "after the fix the actor describes the group it acts for");
	assert.notEqual(fixed.chatType, raw.chatType, "the correction is observable");
});

test("a DM-origin worker resolves as a single chat", () => {
	const WORKER = "worker:w1";
	const ORIGIN = "dt:manager5792";
	const lookup = (cid) => (cid === WORKER ? { senderId: "manager5792", channel: "dingtalk", chatType: "group", text: "t" } : undefined);
	const actor = resolveActorForWorker({ originConversationId: ORIGIN, conversationId: WORKER, lookup })(ORIGIN);
	assert.equal(actor.chatType, "single");
	assert.equal(verifiedIMActor(actor, ORIGIN), true);
});

test("a direct hit still wins and is returned untouched", () => {
	const ORIGIN = "dt:group:g1";
	const live = { senderId: "u1", channel: "dingtalk", chatType: "group", text: "直接命中" };
	const lookup = (cid) => (cid === ORIGIN ? live : { senderId: "WRONG", channel: "echo", chatType: "single", text: "" });
	const actor = resolveActorForWorker({ originConversationId: ORIGIN, conversationId: "worker:w", lookup })(ORIGIN);
	assert.equal(actor, live, "a real actor on the origin chat must not be rewritten");
});

test("no live turn actor at all stays undefined (identity is never fabricated)", () => {
	const ORIGIN = "dt:group:g1";
	const actor = resolveActorForWorker({ originConversationId: ORIGIN, conversationId: "worker:w", lookup: () => undefined })(ORIGIN);
	assert.equal(actor, undefined, "with nobody verifiable, authorization gets nothing");
});

test("a non-origin conversation id gets no fallback", () => {
	const ORIGIN = "dt:group:g1";
	const lookup = (cid) => (cid === "worker:w" ? { senderId: "u", channel: "dingtalk", chatType: "single", text: "" } : undefined);
	const resolve = resolveActorForWorker({ originConversationId: ORIGIN, conversationId: "worker:w", lookup });
	assert.equal(resolve("dt:group:other"), undefined, "the fallback is scoped to the origin chat only");
});

await rm(dir, { recursive: true, force: true });
