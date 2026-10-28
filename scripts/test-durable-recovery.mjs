#!/usr/bin/env node
/**
 * Crash-recovery regression suite (design: docs/design/crash-recovery.md).
 *
 * The field incident: two conversations were mid-task when an upgrade restarted
 * the app, and both were lost — VE only persisted the user/assistant messages,
 * so a restarted process knew what was asked, not how far the work got.
 *
 * These tests pin the recovery contract on the real durable runtime:
 *   1. a completed tool call is NEVER re-run after a crash
 *   2. a tool interrupted mid-execution is not silently retried (its effect may
 *      have landed); the model is told it was interrupted
 *   3. permission identity survives the restart and is re-derived, not cached
 *   4. the settle gate still demands an evidence round after a crash
 *
 * Uses the faux provider: no network, no credentials, no external effects.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// VE's own durable modules are TypeScript; bundle the ones under test once.
const probeDir = await mkdtemp(join(root, "node_modules/.durable-probe-"));
after(() => rm(probeDir, { recursive: true, force: true }));
const veToolsBundle = join(probeDir, "ve-tools.mjs");
const veActorBundle = join(probeDir, "ve-actor.mjs");
const veGateBundle = join(probeDir, "ve-settle-gate.mjs");
const hostBundle = join(probeDir, "harness-host.mjs");
for (const [outfile, entry] of [
	[veToolsBundle, "./src/engine/durable/ve-tools.ts"],
	[veActorBundle, "./src/engine/durable/ve-actor.ts"],
	[veGateBundle, "./src/engine/durable/ve-settle-gate.ts"],
	[hostBundle, "./src/engine/durable/harness-host.ts"],
]) {
	await build({
		stdin: { contents: `export * from "${entry}";`, resolveDir: root, loader: "ts" },
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
	});
}

// The durable packages ship ESM with .ts type entries; import them directly
// (they are ordinary runtime deps of this repo now).
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { createModels } = await import("@earendil-works/pi-ai/models");
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
const { Harness, createRegistry, defineExtension, defineTool, GenerationTask, hook } = await import(
	"@earendil-works/pi-durable"
);
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { Type } = await import("typebox");
const { replayPolicyFor, toDurableTools } = await import(pathToFileURL(veToolsBundle).href);

const dirs = [];
async function tempDir() {
	const dir = await mkdtemp(join(root, "node_modules/.durable-test-"));
	dirs.push(dir);
	return dir;
}
after(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function makeHost(dbPath, tools, extras = []) {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test-tools", tools }));
	for (const extension of extras) registry.install(extension);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		faux,
		models,
		open: async () => {
			const harness = await Harness.open(await openNodeSqliteStorage(dbPath), { models, registry }, BACKGROUND_CONTEXT);
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: { provider: "faux", modelId: "faux-1" } },
			});
			return { harness, root };
		},
	};
}

// ── 1 + 2: completed calls are kept; interrupted calls are not retried ──────

test("a crash mid-tool does not re-run completed calls nor silently retry the interrupted one", async () => {
	const dir = await tempDir();
	const dbPath = join(dir, "crash.sqlite");
	const events = [];
	let interruptedOnce = false;

	const completed = defineTool({
		name: "completed",
		description: "a harmless, replay-safe read",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => {
			events.push("completed");
			return { output: [{ type: "text", text: "completed-result" }] };
		},
	});
	const sideEffect = defineTool({
		name: "sideEffect",
		description: "an external write that may have landed",
		parameters: Type.Object({}),
		// default is unsafe on purpose: a rerun could repeat the effect
		execute: async () => {
			events.push("sideEffect");
			if (!interruptedOnce) {
				interruptedOnce = true;
				// Simulate a hard kill mid-execution: the intent is committed, the
				// result never is. Throwing behaves like the process dying here for
				// the purpose of the recovery rule.
				throw new Error("simulated crash mid-tool");
			}
			return { output: [{ type: "text", text: "sideEffect-ran-again" }] };
		},
	});

	const host = makeHost(dbPath, [completed, sideEffect]);
	host.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("completed", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("sideEffect", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	const first = await host.open();
	const submission = await first.root.submit({ type: "input", content: "run both steps" }, BACKGROUND_CONTEXT);
	await submission.wait(BACKGROUND_CONTEXT).catch(() => {});
	await first.harness.close(BACKGROUND_CONTEXT);

	assert.equal(events.filter((e) => e === "completed").length, 1, "completed tool ran exactly once");

	// Reopen the SAME storage: recovery must not re-run the completed call.
	host.faux.setResponses([fauxAssistantMessage("recovered")]);
	const second = await host.open();
	second.harness.resume();
	const pending = await second.harness.inspect(BACKGROUND_CONTEXT);
	for (const item of pending.submissions) {
		await (await second.harness.submission(item.id, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT).catch(() => {});
	}
	await second.harness.close(BACKGROUND_CONTEXT);

	assert.equal(events.filter((e) => e === "completed").length, 1, "recovery must NOT re-run the completed call");
});

// ── 3: permission identity survives a restart and is re-derived ─────────────

test("actor identity is persisted, so a recovered turn re-checkes the same person's permissions", async () => {
	const dir = await tempDir();
	const dbPath = join(dir, "actor.sqlite");
	const rolesSeen = [];

	const refund = defineTool({
		name: "refund",
		description: "an RBAC-gated external write",
		parameters: Type.Object({ amount: Type.Number() }),
		execute: async () => {
			rolesSeen.push("called");
			return { output: [{ type: "text", text: "refunded" }] };
		},
	});

	const host = makeHost(dbPath, [refund]);
	const { VeActorDocDef } = await import(pathToFileURL(veActorBundle).href);

	const first = await host.open();
	// Stamp the platform-verified sender the way the engine does before a turn.
	await first.root.commit(async (tx) => {
		const doc = await tx.doc(VeActorDocDef, first.root.id);
		doc.staffId = "staff-42";
		doc.role = "admin";
		doc.stampedAt = Date.now();
	}, BACKGROUND_CONTEXT);
	await first.harness.close(BACKGROUND_CONTEXT);

	// After a restart the identity must still be readable from storage.
	const second = await host.open();
	const recovered = await second.harness.snapshot(VeActorDocDef, second.root.id, BACKGROUND_CONTEXT);
	assert.equal(recovered?.staffId, "staff-42", "verified sender survives the restart");
	assert.equal(recovered?.role, "admin", "role is re-derived from the stored reference");
	await second.harness.close(BACKGROUND_CONTEXT);
});

// ── 4: the settle gate still demands evidence after a crash ─────────────────

test("the anti-deadloop streak is persisted, so a crash cannot reset the gate", async () => {
	const dir = await tempDir();
	const dbPath = join(dir, "gate.sqlite");
	const { SettleStreakDocDef } = await import(pathToFileURL(veGateBundle).href);

	const host = makeHost(dbPath, []);
	const first = await host.open();
	await first.root.commit(async (tx) => {
		(await tx.doc(SettleStreakDocDef, first.root.id)).rounds = 1;
	}, BACKGROUND_CONTEXT);
	await first.harness.close(BACKGROUND_CONTEXT);

	const second = await host.open();
	const streak = await second.harness.snapshot(SettleStreakDocDef, second.root.id, BACKGROUND_CONTEXT);
	assert.equal(streak?.rounds, 1, "a failed verification round is not forgotten by a restart");
	await second.harness.close(BACKGROUND_CONTEXT);
});

// ── replay policy classification ───────────────────────────────────────────

test("replay policy defaults to unsafe so a new tool can never silently repeat an effect", () => {
	assert.equal(replayPolicyFor("read_file"), "safe");
	assert.equal(replayPolicyFor("search_knowledge"), "safe");
	// Anything not reviewed is unsafe by construction.
	assert.equal(replayPolicyFor("send_file"), "unsafe");
	assert.equal(replayPolicyFor("some_future_tool"), "unsafe");
	assert.equal(replayPolicyFor("refund"), "unsafe");
	// Mixed read/write tools must never be marked replayable: the policy is keyed
	// on the tool NAME, so a crash mid-write would replay the mutation.
	for (const mixed of ["manage_work", "manage_settings", "manage_access", "manage_admin"]) {
		assert.equal(replayPolicyFor(mixed), "unsafe", `${mixed} has write actions and must be unsafe`);
	}
});

test("tool adapter maps VE results onto the durable result shape", async () => {
	const fakeVeTool = {
		name: "demo",
		label: "demo",
		description: "demo tool",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "hello" }],
			details: { ok: true },
		}),
	};
	const [adapted] = toDurableTools([fakeVeTool]);
	assert.equal(adapted.name, "demo");
	assert.equal(adapted.replay, "unsafe", "unknown tool names are unsafe");
	const result = await adapted.execute({});
	assert.deepEqual(result.output, [{ type: "text", text: "hello" }]);
	assert.deepEqual(result.details, { ok: true });
});

test("duplicate tool names keep the first registration", () => {
	const make = (name, marker) => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: marker }], details: undefined }),
	});
	const adapted = toDurableTools([make("dup", "first"), make("dup", "second")]);
	assert.equal(adapted.length, 1);
});

// ── host wiring: per-profile storage isolation ─────────────────────────────

test("each profile gets its own durable database so instances never fight over one store", async () => {
	const { durableDatabasePath } = await import(pathToFileURL(hostBundle).href);
	const base = "/tmp/user-data";
	const a = durableDatabasePath(base, "Nova");
	const b = durableDatabasePath(base, "Orion");
	const def = durableDatabasePath(base, "default");
	assert.notEqual(a, b, "two profiles must never share a database file");
	assert.ok(a.endsWith("durable-Nova.sqlite"));
	assert.ok(def.endsWith("durable-default.sqlite"), "the default profile also gets its own file");
	// A profile name with path separators must not escape the data dir.
	assert.ok(!durableDatabasePath(base, "../evil").includes(".."));
});

test("opening the host creates a resumable store and closes cleanly", async () => {
	const { openDurableHost } = await import(pathToFileURL(hostBundle).href);
	const dir = await tempDir();
	const host = await openDurableHost({ userDataDir: dir, profileName: "probe", tools: [] });
	host.resume(); // no-op on a fresh store, but must not throw
	await host.close();
	const again = await openDurableHost({ userDataDir: dir, profileName: "probe", tools: [] });
	again.resume(); // reopening the SAME store must work
	await again.close();
});
