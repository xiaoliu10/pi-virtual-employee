#!/usr/bin/env node
/**
 * Child for the UPGRADE acceptance run.
 *
 *   upgrade  starts a run that blocks inside a tool, then calls `close()` exactly
 *            like `prepareToInstall` does — a deliberate, graceful shutdown of a
 *            runtime with work in flight (the update path, not a crash).
 *   resume   the newly installed version opens the same directory and must
 *            continue that run by itself.
 *
 * The point: an update is a CLOSE, not a kill. If close() quietly settled the
 * in-flight run (or reported it done), the work would be lost without a crash to
 * blame — so recovery must treat "closed with work in flight" as resumable.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dir, phase, eventsPath, bundlePath] = process.argv.slice(2);
appendFileSync(eventsPath, "");
const record = (line) => appendFileSync(eventsPath, `${line}\n`);

const { DurableRuntime, HistoryStore } = await import(pathToFileURL(bundlePath).href);
const { Agent } = await import("@earendil-works/pi-agent-core");
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
const { Type } = await import("typebox");

mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(join(dir, "ui.sqlite"));
db.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT);
	CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);`);
const history = new HistoryStore(db);

const CONV = "chat:upgrade";
const faux = fauxProvider();
const model = faux.provider.getModels()[0];
const sessions = new Map();
const session = (id) => {
	if (!sessions.has(id)) sessions.set(id, new Agent({ streamFn: faux.provider.streamSimple, sessionId: id, initialState: { model, systemPrompt: "t" } }));
	return sessions.get(id);
};
const responses = [];
const tools = () => [
	{
		name: "safe_step", label: "safe", description: "safe", parameters: Type.Object({}),
		execute: async () => { record("safe:step"); return { content: [{ type: "text", text: "safe-done" }] }; },
	},
	{
		name: "unsafe_step", label: "unsafe", description: "blocks", executionMode: "sequential", parameters: Type.Object({}),
		execute: async () => {
			if (phase === "upgrade") {
				record("blocked");
				await new Promise(() => {}); // the update closes the runtime underneath us
			}
			record("unsafe-rerun:must-not-happen");
			return { content: [{ type: "text", text: "unsafe-done" }] };
		},
	},
];

const recovered = [];
const runtime = await DurableRuntime.open({
	userDataDir: dir,
	history,
	session,
	tools,
	stream: (id, options, messages) => {
		const next = responses.shift();
		if (!next) throw new Error(`no scripted reply left for ${id}`);
		faux.setResponses([next]);
		return faux.provider.streamSimple(model, { messages }, options);
	},
	withActor: async (_id, _ctx, _text, run) => run(),
	onRecovered: async (conversationId, result) => {
		recovered.push(conversationId);
		record(`recovered:${conversationId}:${result.reply}`);
	},
});

if (phase === "upgrade") {
	responses.push(
		fauxAssistantMessage(fauxToolCall("safe_step", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("unsafe_step", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("升级后继续完成"),
	);
	void runtime.send(session(CONV), "做一件事", {
		actor: { senderId: "person-upgrade", channel: "dingtalk", chatType: "single" },
	}).catch((err) => record(`send-error:${err.message}`));
	// Wait until the run is genuinely inside the tool, then shut down the way the
	// updater does. A bounded race mirrors production's 8s close budget.
	while (!readFileSync(eventsPath, "utf8").includes("blocked\n")) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	record("close-called");
	await Promise.race([runtime.close(), new Promise((resolve) => setTimeout(resolve, 8_000))]);
	process.exit(0);
} else {
	responses.push(fauxAssistantMessage("升级后继续完成"));
	const deadline = Date.now() + 20_000;
	while (recovered.length < 1 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	record(`recovered-count:${recovered.length}`);
	const rows = history.listMessages(CONV);
	record(`history:${CONV}:${rows.map((row) => row.role).join(",")}`);
	await runtime.close();
	process.exit(0);
}
