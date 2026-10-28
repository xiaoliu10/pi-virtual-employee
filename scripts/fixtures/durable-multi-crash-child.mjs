#!/usr/bin/env node
/**
 * TWO conversations, killed mid-tool, reopened — the acceptance run for
 * "upgrade interrupted my tasks".
 *
 * Why a separate fixture from `durable-crash-child.mjs`: that one exercises a
 * bare Harness with hand-made tools. This one goes through `DurableRuntime`, the
 * code VE actually runs (`EmployeeEngine.send` → durable), so it can fail for
 * reasons a bare-Harness probe cannot see:
 *
 *   - route/identity documents must be restored BEFORE scheduling starts,
 *   - each recovered conversation must resolve its own sender, not a shared one,
 *   - the answer must be projected exactly once into the UI transcript,
 *   - an unsafe tool interrupted mid-flight must NOT run again,
 *   - a completed tool must NOT run again.
 *
 * phases:
 *   start   two conversations, each calls safe-then-unsafe; both block in the
 *           unsafe call so the parent can SIGKILL the whole process.
 *   resume  reopen the same directory; every unfinished conversation must
 *           finish on its own and report to its OWN conversation.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dir, phase, eventsPath, bundlePath] = process.argv.slice(2);
const record = (line) => appendFileSync(eventsPath, `${line}\n`);
let mod;
try { mod = await import(pathToFileURL(bundlePath).href); }
catch (err) { record(`import-error:${err.message}`); throw err; }
const { DurableRuntime, HistoryStore } = mod;
const { Agent } = await import("@earendil-works/pi-agent-core");
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(
	"@earendil-works/pi-ai/providers/faux"
);
const { Type } = await import("typebox");

mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(join(dir, "ui.sqlite"));
db.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT);
	CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);`);
const history = new HistoryStore(db);
const faux = fauxProvider();
const model = faux.provider.getModels()[0];
const sessions = new Map();
const session = (id) => {
	if (!sessions.has(id)) sessions.set(id, new Agent({ streamFn: faux.provider.streamSimple, sessionId: id, initialState: { model, systemPrompt: "test" } }));
	return sessions.get(id);
};
const CHATS = [
	{ id: "dingtalk:alpha", sender: "person-alpha" },
	{ id: "dingtalk:beta", sender: "person-beta" },
];
// One toolname → one call per conversation; the unsafe one blocks in `start`.
const toolsFor = (id) => [
	{
		name: "safe_step", label: "safe", description: "records a safe step", parameters: Type.Object({}),
		execute: async () => { record(`safe:${id}`); return { content: [{ type: "text", text: "safe-done" }] }; },
	},
	{
		name: "unsafe_step", label: "unsafe", description: "an external write", parameters: Type.Object({}),
		execute: async () => {
			record(`unsafe-start:${id}`);
			if (phase === "start") { await new Promise(() => {}); }
			record(`unsafe-rerun:${id}`); // reaching this in `resume` means it RAN AGAIN
			return { content: [{ type: "text", text: "unsafe-done" }] };
		},
	},
];
const recovered = [];
const responses = new Map();
let runtime;
try { runtime = await DurableRuntime.open({
	userDataDir: dir,
	history,
	session,
	tools: (id) => toolsFor(id),
	stream: (id, options, messages) => {
		record(`stream:${id}`);
		// Per-conversation scripted replies: a shared faux queue let one chat
		// consume the other's turns, so "both interrupted" was never true.
		const replies = responses.get(id) ?? [];
		const next = replies.shift();
		if (!next) throw new Error(`no scripted reply left for ${id}`);
		faux.setResponses([next]);
		return faux.provider.streamSimple(model, { messages }, options);
	},
	withActor: async (_id, _ctx, _text, run) => run(),
	onRecovered: async (conversationId, result, occurrenceId) => {
		record(`recovered:${conversationId}|${result.reply}|${occurrenceId}`);
		recovered.push(conversationId);
		// Re-delivery must land in the SAME conversation, exactly once.
		record(`redeliver:${conversationId}`);
	},
	});
} catch (err) { record(`open-error:${err.message}`); throw err; }

if (phase === "start") {
	// Both conversations start; the first one blocks inside its unsafe call, and
	// the second must ALSO have started (two live runs at kill time).
	for (const chat of CHATS) {
		responses.set(chat.id, [
			fauxAssistantMessage(fauxToolCall("safe_step", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("unsafe_step", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
	}
	const runs = CHATS.map((chat) =>
		runtime.send(session(chat.id), `task for ${chat.sender}`, {
			actor: { senderId: chat.sender, channel: "dingtalk", chatType: "single" },
		}).catch((err) => record(`send-error:${chat.id}:${err.message}`)),
	);
	// Keep the event loop alive; the parent SIGKILLs during the unsafe calls.
	void Promise.allSettled(runs);
	record("started");
	setInterval(() => {}, 1 << 30);
} else {
	for (const chat of CHATS) {
		responses.set(chat.id, [fauxAssistantMessage("recovered done")]);
	}
	// Reopen: any unfinished run must continue by itself. Do NOT call send() and
	// do NOT call submission.wait() — either would start scheduling and hide a
	// runtime that never resumes on its own (the exact false positive this run
	// exists to catch).
	record(`pre-resume-recovered:${recovered.length}`);
	const deadline = Date.now() + 15_000;
	while (recovered.length < CHATS.length && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	record(`recovered-count:${recovered.length}`);
	for (const chat of CHATS) {
		const rows = history.listMessages(chat.id);
		record(`history:${chat.id}:${rows.map((row) => row.role).join(",")}`);
		record(`answer:${chat.id}:${rows.filter((row) => row.role === "assistant").map((row) => row.content).join("|")}`);
	}
	await runtime.close();
	process.exit(0);
}
