#!/usr/bin/env node
/**
 * Child for the revocation acceptance run.
 *
 *   start   two admins call a guarded tool, then block in an unsafe step.
 *   resume  the config has been edited in between: `demoted-person` is gone from
 *           the admin list. Each recovered run must re-derive its role from the
 *           CURRENT config before the guarded tool executes.
 *
 * The awaited `.wait()` is deliberately NEVER used here for recovery — the
 * runtime must continue on its own (see the multi-crash fixture for rationale).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dir, phase, eventsPath, bundlePath] = process.argv.slice(2);
appendFileSync(eventsPath, "");
const record = (line) => appendFileSync(eventsPath, `${line}\n`);
const { DurableRuntime, HistoryStore, ConfigStore, checkPermission, resolveRole } = await import(
	pathToFileURL(bundlePath).href
);
const { Agent } = await import("@earendil-works/pi-agent-core");
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
const { Type } = await import("typebox");

mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(join(dir, "ui.sqlite"));
db.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT);
	CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);
	CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

const history = new HistoryStore(db);
const config = new ConfigStore(db);
const PEOPLE = [
	{ id: "dingtalk:demoted", sender: "demoted-person" },
	{ id: "dingtalk:still", sender: "still-admin" },
];

/** Write the security config for this phase — this is the operator's demotion. */
const applySecurity = () => {
	const admins = phase === "start" ? ["demoted-person", "still-admin"] : ["still-admin"];
	config.update({ security: { ...config.all().security, adminStaffIds: admins } });
};

const faux = fauxProvider();
const model = faux.provider.getModels()[0];
const sessions = new Map();
const session = (id) => {
	if (!sessions.has(id)) sessions.set(id, new Agent({ streamFn: faux.provider.streamSimple, sessionId: id, initialState: { model, systemPrompt: "t" } }));
	return sessions.get(id);
};
const responses = new Map();

/**
 * The guarded tool. It re-checks the role at EXECUTION time from the live config,
 * which is what a real VE tool's `guarded()` wrapper does.
 */
/**
 * The guarded tool. Its authority comes from the actor the RUNTIME injects —
 * `withActor` below sets `currentActor`, exactly as `engine.buildToolSetFor`'s
 * `resolveActor` does in production. The check itself is the real
 * `checkPermission` against the live config, so a stale cached role fails here.
 */
let currentActor = new Map();
const actorOf = (conversationId) => currentActor.get(conversationId)?.senderId ?? "";
const toolsFor = (conversationId) => [
	{
		name: "guarded_write",
		label: "guarded",
		description: "requires admin",
		parameters: Type.Object({}),
		execute: async () => {
			const gate = checkPermission(config, currentActor.get(conversationId), conversationId, "admin");
			const role = resolveRole(config, actorOf(conversationId));
			record(`role:${actorOf(conversationId)}:${role}`);
			record(gate.ok ? `allowed:${actorOf(conversationId)}` : `denied:${actorOf(conversationId)}`);
			return { content: [{ type: "text", text: gate.ok ? "wrote" : "refused" }] };
		},
	},
	{
		name: "unsafe_step",
		label: "unsafe",
		description: "blocks in start",
		executionMode: "sequential",
		parameters: Type.Object({}),
		execute: async () => {
			if (phase === "start") {
				record(`blocked:${actorOf(conversationId)}`);
				await new Promise(() => {});
			}
			return { content: [{ type: "text", text: "ok" }] };
		},
	},
];


let runtime;
try {
	runtime = await DurableRuntime.open({
		userDataDir: dir,
		history,
		session,
		tools: (id) => toolsFor(id),
		stream: (id, options, messages) => {
			const queue = responses.get(id) ?? [];
			const next = queue.shift();
			if (!next) throw new Error(`no reply left for ${id}`);
			faux.setResponses([next]);
			return faux.provider.streamSimple(model, { messages }, options);
		},
		// THE seam under test: the runtime must inject the CURRENT actor for the
		// conversation. If a recovered run ever fed a stale identity, the guarded
		// check above would see the wrong person.
		withActor: async (id, ctx, _text, run) => {
			if (ctx.actor) currentActor.set(id, ctx.actor);
			else currentActor.delete(id);
			try { return await run(); } finally { currentActor.delete(id); }
		},
		onRecovered: async (conversationId, result) => record(`recovered:${conversationId}:${result.reply}`),
	});
} catch (err) {
	record(`open-error:${err.message}`);
	throw err;
}

applySecurity();

if (phase === "start") {
	for (const person of PEOPLE) {
		// The BLOCKING step comes FIRST, so the guarded call is still AHEAD of the
		// crash: only then does "does the demoted person get denied" mean anything
		// (a guarded call completed before the crash is never re-run — by design).
		responses.set(person.id, [
			fauxAssistantMessage(fauxToolCall("unsafe_step", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("guarded_write", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
	}
	const runs = PEOPLE.map((person) =>
		runtime.send(session(person.id), "write it", { actor: { senderId: person.sender, channel: "dingtalk", chatType: "single" } }).catch((err) => record(`send-error:${person.id}:${err.message}`)),
	);
	void Promise.allSettled(runs);
	record("blocked");
	setInterval(() => {}, 1 << 30);
} else {
	for (const person of PEOPLE) {
		// The recovered run resumes mid-turn; its next model response is the one that
		// asks for the guarded write (the step the crash had not reached yet).
		responses.set(person.id, [fauxAssistantMessage(fauxToolCall("guarded_write", {}), { stopReason: "toolUse" }), fauxAssistantMessage("finished")]);
	}
	// Let the recovered runs drive themselves; recovery is reported via onRecovered.
	const deadline = Date.now() + 25_000;
	let done = 0;
	const original = record;
	while (done < PEOPLE.length && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 30));
		const text = (() => { try { return readFileSync(eventsPath, "utf8"); } catch { return ""; } })();
		done = (text.match(/^recovered:/gm) ?? []).length;
	}
	void original;
	await runtime.close();
	process.exit(0);
}
