/**
 * Probe: SSE failure paths around the heartbeat.
 * A. runtime.subscribe throws (outside the try) → process crash? heartbeat leak?
 * B. client aborts + send hangs > 15s → heartbeat writes to destroyed socket → crash?
 * C. runtime.send throws inside SSE → error frame + interval cleared (interval count).
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = "/Users/jason/projects/opensource/pi-virtual-employee";
const dir = mkdtempSync(join(tmpdir(), "widget-hb-"));
const bundle = join(dir, "t.mjs");
await build({
	stdin: { contents: `export * from "./src/widget/widget-service.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { startWidgetServer } = await import(pathToFileURL(bundle).href);

const TOKEN = "token-abc";
const SECRET = "secret-xyz";
const mode = process.argv[2] ?? "A";

function makeRuntime() {
	if (mode === "A") {
		return {
			isReadOnlyConversation: () => false,
			getOrCreateSession: () => ({
				subscribe: () => { throw new Error("subscribe exploded"); },
			}),
			send: async () => ({ reply: "never" }),
		};
	}
	if (mode === "B") {
		return {
			isReadOnlyConversation: () => false,
			getOrCreateSession: () => ({ subscribe: () => () => {} }),
			send: async () => { await new Promise((r) => setTimeout(r, 20_000)); return { reply: "late" }; },
		};
	}
	return {
		isReadOnlyConversation: () => false,
		getOrCreateSession: () => ({ subscribe: () => () => {} }),
		send: async () => { throw new Error("boom"); },
	};
}

const unhandled = [];
process.on("unhandledRejection", (e) => { unhandled.push(String(e)); console.error("UNHANDLED REJECTION:", e); });

const { port, server } = await startWidgetServer({
	config: () => ({ title: "t", suggestions: [], disclaimer: "d", token: TOKEN, allowedOrigins: [], secret: SECRET, maxRole: "admin" }),
	runtime: makeRuntime(),
	tickets: undefined,
	expose: "loopback",
	port: 0,
	log: () => {},
});
const base = `http://127.0.0.1:${port}`;
const sess = await fetch(base + "/api/widget/session", {
	method: "POST",
	headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-secret": SECRET },
	body: JSON.stringify({ user: "u1", role: "viewer", origin: "https://oa.example.com" }),
}).then((r) => r.json());
const tk = sess.ticket;
if (!tk) { console.error("no ticket", sess); process.exit(2); }

if (mode === "A") {
	const res = await fetch(base + "/api/widget/chat", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
		body: JSON.stringify({ message: "hi" }),
	});
	console.log("A: status", res.status);
	console.log("A: body", await res.text());
	await new Promise((r) => setTimeout(r, 500));
	console.log("A RESULT: unhandled rejections =", unhandled.length, unhandled.length ? "→ PROCESS-WIDE BUG (async turn rejects with no catcher)" : "none");
	server.closeAllConnections?.();
	server.close();
	process.exit(0);
}

if (mode === "B") {
	const controller = new AbortController();
	const res = await fetch(base + "/api/widget/chat", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
		body: JSON.stringify({ message: "hi" }),
		signal: controller.signal,
	});
	console.log("B: stream opened, aborting client now");
	controller.abort();
	await res.text().catch(() => {});
	// wait past TWO heartbeat ticks while send is still hanging
	await new Promise((r) => setTimeout(r, 16_500));
	console.log("B RESULT: server still alive after heartbeat tick(s) on destroyed socket; unhandled =", unhandled.length);
	server.closeAllConnections?.();
	server.close();
	process.exit(0);
}

// C
{
	const res = await fetch(base + "/api/widget/chat", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
		body: JSON.stringify({ message: "hi" }),
	});
	const text = await res.text();
	const frames = text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
	console.log("C: frames:", JSON.stringify(frames.map((f) => f.type)));
	console.log("C RESULT:", frames.some((f) => f.type === "error") ? "error frame delivered" : "NO error frame");
	await new Promise((r) => setTimeout(r, 16_500));
	console.log("C heartbeat tail: if the interval leaked, pings would appear; unhandled =", unhandled.length);
	server.closeAllConnections?.();
	server.close();
	process.exit(0);
}
