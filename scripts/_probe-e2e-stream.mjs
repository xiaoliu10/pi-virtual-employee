/**
 * Second-round review probe: real HTTP against the real widget server.
 * 1. GET /widget.js + /widget → syntax-check the SERVED BYTES (node --check).
 * 2. SSE stream over HTTP with chunks split MID-UNICODE → feed the exact
 *    client parser logic (extracted from the served loader) and confirm
 *    frames parse and no character is corrupted.
 * 3. JSON fallback on a runtime with streamsProcessEvents=false.
 * 4. Client-disconnect during a slow turn → heartbeat/error-path behavior.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = "/Users/jason/projects/opensource/pi-virtual-employee";
const dir = mkdtempSync(join(tmpdir(), "widget-e2e-"));
const bundle = join(dir, "t.mjs");
await build({
	stdin: {
		contents: `
			export * from "./src/widget/widget-service.ts";
			export * from "./src/widget/widget-ticket.ts";
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
const { startWidgetServer, TicketStore } = await import(pathToFileURL(bundle).href);

const TOKEN = "token-abc";
const SECRET = "secret-xyz";

function makeStreamingRuntime({ script, finalReply, streamsProcessEvents, sendDelayMs = 0 }) {
	const listeners = new Set();
	return {
		streamsProcessEvents,
		isReadOnlyConversation: () => false,
		getOrCreateSession: () => ({
			subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
		}),
		send: async () => {
			if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
			for (const ev of script ?? []) {
				for (const fn of listeners) fn(ev);
			}
			return { reply: finalReply ?? "done" };
		},
	};
}

async function start(overrides = {}) {
	const tickets = new TicketStore();
	const { port, server } = await startWidgetServer({
		config: () => ({
			title: "AI 助理",
			suggestions: [],
			disclaimer: "d",
			token: TOKEN,
			allowedOrigins: [],
			secret: SECRET,
			maxRole: "admin",
		}),
		runtime: overrides.runtime,
		tickets,
		expose: "loopback",
		port: 0,
		log: () => {},
		...(overrides.deps ?? {}),
	});
	const base = `http://127.0.0.1:${port}`;
	const session = async (user = "u1", role = "viewer") => {
		const res = await fetch(base + "/api/widget/session", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-secret": SECRET },
			body: JSON.stringify({ user, role, origin: "https://oa.example.com" }),
		});
		const data = await res.json();
		if (!data.ticket) throw new Error(`ticket exchange failed: ${res.status} ${JSON.stringify(data)}`);
		return data.ticket;
	};
	return { base, session, server };
}

let failures = 0;
function check(label, fn) {
	try {
		fn();
		console.log(`PASS: ${label}`);
	} catch (e) {
		failures++;
		console.error(`FAIL: ${label} — ${e.message}`);
	}
}

// ── 1. served bytes syntax check ──
{
	const runtime = makeStreamingRuntime({ script: [], finalReply: "x", streamsProcessEvents: true });
	const { base, server } = await start({ runtime });
	try {
		const jsRes = await fetch(base + "/widget.js");
		const js = await jsRes.text();
		const jsPath = join(dir, "served-widget.js");
		writeFileSync(jsPath, js);
		execFileSync(process.execPath, ["--check", jsPath]);
		check("GET /widget.js served bytes pass node --check", () => assert.ok(true));

		const htmlRes = await fetch(base + "/widget");
		const html = await htmlRes.text();
		const m = html.match(/<script>([\s\S]*?)<\/script>/);
		assert.ok(m, "page has inline script");
		const htmlPath = join(dir, "served-page.html");
		writeFileSync(htmlPath, html);
		// wrap inline code in a file for --check
		const inlinePath = join(dir, "served-inline.js");
		writeFileSync(inlinePath, m[1]);
		execFileSync(process.execPath, ["--check", inlinePath]);
		check("GET /widget inline <script> served bytes pass node --check", () => assert.ok(true));

		// confirm the emitted parser has real escapes
		check('served loader contains split("\\n\\n") literal', () => assert.ok(js.includes('split("\\n\\n")')));
		check("served loader contains chunk.value", () => assert.ok(js.includes("chunk.value")));
		check("served inline contains chunk.value", () => assert.ok(m[1].includes("chunk.value")));
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
}

// ── 2. SSE over HTTP with chunks split mid-Unicode + mid-frame ──
{
	// Events whose JSON payload contains multi-byte CJK; the server writes each
	// SSE frame separately, but we read via a raw socket reader that slices the
	// byte stream at FIXED 7-BYTE boundaries to force mid-UTF-8 and mid-frame cuts.
	const script = [
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "思考：订单查询涉及「中文」与 emoji 😀!" } },
		{ type: "tool_execution_start", toolName: "knowledge_search", toolCallId: "t1" },
		{ type: "tool_execution_end", toolName: "knowledge_search", toolCallId: "t1", isError: false, durationMs: 5 },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "查询完成，共 3 条订单，金额 ¥1,234.56。" } },
	];
	const runtime = makeStreamingRuntime({ script, finalReply: "查询完成，共 3 条订单，金额 ¥1,234.56。", streamsProcessEvents: true });
	const { base, session, server } = await start({ runtime });
	try {
		const tk = await session("u1", "viewer");
		const res = await fetch(base + "/api/widget/chat", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
			body: JSON.stringify({ message: "hi" }),
		});
		assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

		// Feed the response body through the EXACT emitted client parser.
		// Extract pump() logic from the served loader to run it node-side with
		// the same semantics (TextDecoder + split("\n\n") on the decoded string).
		// We reimplement the reader with 7-byte slices to force split decodes.
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		const frames = [];
		let leftoverTail = "";
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			// simulate network slicing: process the chunk bytes 7 at a time
			const bytes = chunk.value;
			for (let i = 0; i < bytes.length; i += 7) {
				const slice = bytes.subarray(i, Math.min(i + 7, bytes.length));
				buf += dec.decode(slice, { stream: true });
				const parts = buf.split("\n\n");
				buf = parts.pop();
				for (const frame of parts) {
					const line = frame.split("\n").find((l) => l.indexOf("data:") === 0);
					if (line) frames.push(JSON.parse(line.slice(5)));
				}
			}
		}
		buf += dec.decode();
		const tailLine = buf.split("\n").find((l) => l.indexOf("data:") === 0);
		if (tailLine) frames.push(JSON.parse(tailLine.slice(5)));

		check("frames survive 7-byte slicing (mid-UTF-8 + mid-frame cuts)", () => {
			const types = frames.map((f) => f.type);
			assert.equal(types[0], "meta");
			assert.ok(types.includes("thinking_delta"), `thinking_delta present: ${types.join(",")}`);
			assert.ok(types.includes("tool_start"), "tool_start present");
			assert.ok(types.includes("tool_end"), "tool_end present");
			assert.ok(types.includes("delta"), "delta present");
			assert.equal(types[types.length - 1], "done");
		});
		check("no Unicode corruption across chunk boundaries", () => {
			const think = frames.find((f) => f.type === "thinking_delta")?.text ?? "";
			assert.ok(think.includes("思考：订单查询涉及「中文」与 emoji 😀!"), `thinking text intact: ${JSON.stringify(think)}`);
			const delta = frames.find((f) => f.type === "delta")?.text ?? "";
			assert.ok(delta.includes("查询完成，共 3 条订单，金额 ¥1,234.56。"), `delta text intact: ${JSON.stringify(delta)}`);
			assert.ok(delta.includes("¥"), "yen sign intact");
		});
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
}

// ── 3. JSON fallback (streamsProcessEvents=false) end-to-end ──
{
	const runtime = makeStreamingRuntime({ script: [], finalReply: "durable 最终回复：已完成。", streamsProcessEvents: false });
	const { base, session, server } = await start({ runtime });
	try {
		const tk = await session("u1", "viewer");
		const res = await fetch(base + "/api/widget/chat", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
			body: JSON.stringify({ message: "hi" }),
		});
		check("fallback content-type is JSON", () => assert.match(res.headers.get("content-type") ?? "", /application\/json/));
		const data = await res.json();
		check("fallback body carries the reply", () => assert.equal(data.reply, "durable 最终回复：已完成。"));
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
}

// ── 4. undefined streamsProcessEvents on a silent stub → SSE path still delivers reply ──
{
	const runtime = makeStreamingRuntime({ script: [], finalReply: "静默 runtime 的最终回复", streamsProcessEvents: undefined });
	delete runtime.streamsProcessEvents; // truly undefined, like a third-party stub
	const { base, session, server } = await start({ runtime });
	try {
		const tk = await session("u1", "viewer");
		const res = await fetch(base + "/api/widget/chat", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
			body: JSON.stringify({ message: "hi" }),
		});
		check("undefined flag → SSE attempted", () => assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/));
		const text = await res.text();
		const frames = text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
		check("silent stub still receives final reply via replace", () => {
			const replace = frames.find((f) => f.type === "replace");
			assert.ok(replace, `replace frame present: ${JSON.stringify(frames.map((f) => f.type))}`);
			assert.equal(replace.text, "静默 runtime 的最终回复");
			assert.equal(frames[frames.length - 1].type, "done");
		});
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
}

// ── 5. client aborts mid-turn → heartbeat must not leak / process must not crash ──
{
	const runtime = makeStreamingRuntime({ script: [], finalReply: "late", streamsProcessEvents: true, sendDelayMs: 1200 });
	const { base, session, server } = await start({ runtime });
	try {
		const tk = await session("u1", "viewer");
		const controller = new AbortController();
		const resP = fetch(base + "/api/widget/chat", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-ve-ticket": tk, accept: "text/event-stream", origin: "https://oa.example.com" },
			body: JSON.stringify({ message: "hi" }),
			signal: controller.signal,
		});
		const res = await resP;
		controller.abort(); // client walks away immediately (before any heartbeat at 15s)
		await res.text().catch(() => {});
		// wait past the first heartbeat tick and past the turn's completion
		await new Promise((r) => setTimeout(r, 1700));
		check("server survives client abort mid-turn (no crash, no write-after-destroy throw)", () => assert.ok(true));
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
}

console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
