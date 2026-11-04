/**
 * Widget session-ticket TTL.
 *
 * Field 2026-11-04 (business system: ETC 智能核查系统): the embedded assistant
 * mints ONE ticket when the panel opens and reuses it for the whole session. The
 * old 5-minute default expired mid-conversation — a user asking a second or
 * third question (especially after a slow model turn) got
 * "会话票据已过期，请重新获取". Default is now 30 minutes and configurable.
 *
 * These drive the REAL exchange endpoint, so they fail if the default, the
 * config wiring, or the per-mint resolution regress.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.widget-ticket-ttl-test-"));
process.on("exit", () => { rm(dir, { recursive: true, force: true }).catch(() => {}); });

const bundle = join(dir, "w.mjs");
await build({
	stdin: { contents: 'export { startWidgetServer } from "./src/widget/widget-service.ts"; export { TicketStore } from "./src/widget/widget-ticket.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { startWidgetServer, TicketStore } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

const runtime = {
	profileId: "p", modelId: "m",
	getOrCreateSession: () => ({ subscribe: () => () => {}, abort() {} }),
	dropSession: () => false, activeSessionCount: () => 0,
	isReadOnlyConversation: () => false,
	supportsAgentSubscription: () => false,
	send: async () => ({ text: "ok" }),
};

/** Start a widget server whose config returns `snapshot`. */
async function start(t, snapshot) {
	// Every /api/widget/* route below the asset line requires the Bearer access
	// token (widget-service.ts). Real deployments set one; the tests must too, or
	// they would be asserting on a 401.
	const cfg = { enabled: true, port: 0, token: "access-token", allowedOrigins: [], secret: "s3cret", maxRole: "admin", ticketTtlSec: 30 * 60, ...snapshot };
	const started = await startWidgetServer({ runtime, config: () => cfg, log: () => {} });
	t.after(() => new Promise((r) => started.server.close(r)));
	return { port: started.port, cfg };
}

async function exchange(port) {
	const res = await fetch(`http://127.0.0.1:${port}/api/widget/session`, {
		method: "POST",
		// TWO gates on /api/widget/session (widget-service.ts):
		//  - Authorization: Bearer <access token> — the route sits below the asset
		//    line, which requires the token for everything under /api/widget/*.
		//  - X-VE-Secret — the exchange credential the BUSINESS BACKEND holds.
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer access-token",
			"X-VE-Secret": "s3cret",
		},
		body: JSON.stringify({ user: "u1", role: "viewer", origin: "https://ccrm.wengine.cn" }),
	});
	return { status: res.status, body: await res.json() };
}

test("default TTL is 30 minutes (the old 5 min expired mid-conversation)", () => {
	const store = new TicketStore();
	assert.equal(store.ttlMs(), 30 * 60_000);
});

test("the exchange endpoint reports expiresIn = 1800 with the default config", async (t) => {
	const { port } = await start(t, {});
	const { status, body } = await exchange(port);
	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(body.expiresIn, 1800, `expected 30 min, got ${body.expiresIn}`);
});

test("widget.ticketTtlSec drives the minted TTL", async (t) => {
	const { port } = await start(t, { ticketTtlSec: 5 * 60 });
	const { body } = await exchange(port);
	assert.equal(body.expiresIn, 300);
});

test("a config change applies to the NEXT ticket without a restart", async (t) => {
	const { port, cfg } = await start(t, { ticketTtlSec: 60 });
	assert.equal((await exchange(port)).body.expiresIn, 60);
	cfg.ticketTtlSec = 1800; // admin edits the setting
	assert.equal((await exchange(port)).body.expiresIn, 1800, "TTL must follow live config, not construction time");
});

test("ticketTtlSec 0 falls back to the built-in default (never an instant expiry)", async (t) => {
	// 0 means "use the default". Treating it literally would mint an
	// already-expired ticket and look exactly like the bug we are fixing.
	const { port } = await start(t, { ticketTtlSec: 0 });
	assert.equal((await exchange(port)).body.expiresIn, 1800);
});

test("a nonsense TTL (negative/NaN) also falls back instead of minting a dead ticket", () => {
	assert.equal(new TicketStore({ ttlMs: -5000 }).ttlMs(), 30 * 60_000);
	assert.equal(new TicketStore({ ttlMs: Number.NaN }).ttlMs(), 30 * 60_000);
	assert.equal(new TicketStore({ ttlMs: () => undefined }).ttlMs(), 30 * 60_000);
});

test("extending TTL does not weaken the address/origin binding", async (t) => {
	const { port } = await start(t, {});
	const { body } = await exchange(port);
	assert.ok(body.ticket, "ticket minted");
	// Redeem from a different Origin must still be refused — the longer window
	// must not have loosened the binding.
	const res = await fetch(`http://127.0.0.1:${port}/api/widget/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer access-token", "X-VE-Ticket": body.ticket, Origin: "https://evil.example" },
		body: JSON.stringify({ message: "hi" }),
	});
	assert.notEqual(res.status, 200, "a mismatched origin must not redeem");
});
