#!/usr/bin/env node
/**
 * Crash-recovery CHILD process — killed by the parent test to prove recovery.
 *
 * Run twice by `test-durable-recovery-crash.mjs`:
 *   phase=start  → executes step 1 (safe), then blocks inside step 2 (unsafe)
 *                  so the parent can SIGKILL the process mid-tool.
 *   phase=resume → reopens the SAME storage and reports what the runtime did
 *                  with the interrupted work.
 *
 * Not a test file itself (node --test would run it): it is spawned.
 */
import { appendFileSync } from "node:fs";

const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { createModels } = await import("@earendil-works/pi-ai/models");
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(
	"@earendil-works/pi-ai/providers/faux"
);
const { Harness, createRegistry, defineExtension, defineTool } = await import(
	"@earendil-works/pi-durable"
);
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { Type } = await import("typebox");

const [dbPath, phase, eventsPath] = process.argv.slice(2);
const record = (name) => appendFileSync(eventsPath, `${name}\n`);

const completed = defineTool({
	name: "completed",
	description: "safe step",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		record("completed");
		return { output: [{ type: "text", text: "step-1-done" }] };
	},
});
const external = defineTool({
	name: "external",
	description: "unsafe external write",
	parameters: Type.Object({}),
	// replay defaults to unsafe: a rerun may repeat the effect
	execute: async () => {
		record("external");
		// Block forever: the parent kills this process while the call is in flight,
		// which is exactly "the effect may or may not have landed". A never-resolving
		// promise is correct HERE (inside a tool call, not a top-level await).
		await new Promise(() => {});
		return { output: [{ type: "text", text: "never" }] };
	},
});

const registry = createRegistry();
registry.install(defineExtension({ name: "probe", tools: [completed, external] }));
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

const harness = await Harness.open(await openNodeSqliteStorage(dbPath), { models, registry }, BACKGROUND_CONTEXT);
const root = await harness.root(BACKGROUND_CONTEXT, {
	agent: { model: { provider: "faux", modelId: "faux-1" } },
});

if (phase === "start") {
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("completed", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("external", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("should never be reached before the kill"),
	]);
	void root.submit({ type: "input", content: "do step 1 then step 2" }, BACKGROUND_CONTEXT);
	// Keep the event loop alive WITHOUT an unsettled top-level await: the test
	// runner waits for the module's promise to settle, and `run-all-tests.mjs`
	// waits for stdio to close — a bare `await new Promise(() => {})` hung both.
	setInterval(() => {}, 1 << 30);
} else {
	// Resume: the runtime decides what to do with the interrupted call.
	faux.setResponses([fauxAssistantMessage("recovered")]);
	// Record the pre-resume state FIRST: it is what proves the process came back to
	// an unfinished run rather than to a clean slate. (Asserting only on the final
	// settled status was vacuous — submission.wait() itself starts scheduling, so a
	// mutant without resume() produced identical output; verified by mutation.)
	const before = await harness.inspect(BACKGROUND_CONTEXT);
	record(`pre-resume-pending:${before.submissions.length}`);
	harness.resume();
	const pending = await harness.inspect(BACKGROUND_CONTEXT);
	record(`pending-submissions:${pending.submissions.length}`);
	for (const item of pending.submissions) {
		const submission = await harness.submission(item.id, BACKGROUND_CONTEXT);
		const settled = await submission?.wait(BACKGROUND_CONTEXT).catch(() => ({ status: "failed" }));
		record(`settled:${settled?.status ?? "unknown"}`);
	}
	// Prove the recovery carried the interrupted call's outcome into the model's
	// context. Without this, "recovered" could mean "quietly dropped".
	try {
		const entries = await root.entries({}, 20, undefined, BACKGROUND_CONTEXT);
		record(`entries:${entries.items.map((entry) => entry.kind).join(",")}`);
		const interruptedSeen = entries.items.some((entry) => {
			const text = JSON.stringify(entry);
			return text.includes("interrupted") || text.includes("may have partially run");
		});
		record(`interrupted-in-context:${interruptedSeen}`);
	} catch (err) {
		record(`entries-error:${err instanceof Error ? err.message : String(err)}`);
	}
	await harness.close(BACKGROUND_CONTEXT);
	process.exit(0);
}
