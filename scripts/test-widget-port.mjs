/**
 * Multi-profile widget port allocation (v0.2.177).
 *
 * Field context: a machine runs several profiles at once (--profile Nova,
 * --profile Orion, …). Each keeps its own config and all defaulted to 17880, so
 * the second profile to enable the widget silently died on EADDRINUSE while the
 * settings page still showed "enabled". These tests pin the fix:
 *   1. a free configured port is kept as-is (address stability matters — business
 *      systems embed a literal URL);
 *   2. a taken port is walked forward to the next free one;
 *   3. the walk respects the expose mode (a 127.0.0.1 listener does not block a
 *      0.0.0.0 bind for a DIFFERENT port, and 0.0.0.0 is correctly reported busy);
 *   4. exhaustion returns the original failure reason instead of a random port;
 *   5. startWidgetServer surfaces a readable "port busy" reason, not a bare code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "widget-port-"));
const bundle = join(dir, "p.mjs");
await build({
	stdin: {
		contents: `
			export { allocateWidgetPort, probePort, probePortAnywhere, bindHostFor, WIDGET_PORT_BASE } from "./src/widget/port-alloc.ts";
			export { startWidgetServer } from "./src/widget/widget-service.ts";
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
const { allocateWidgetPort, probePort, probePortAnywhere, bindHostFor, WIDGET_PORT_BASE, startWidgetServer } = await import(
	pathToFileURL(bundle).href
);

/** Occupy a port on a host and hand back a closer. */
function occupy(host, port) {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(port, host, () => resolve(s));
	});
}

/** Ask the OS for a free port on loopback, then release it. */
async function ephemeralPort() {
	const s = await occupy("127.0.0.1", 0);
	const { port } = s.address();
	await new Promise((r) => s.close(r));
	return port;
}

test("a free configured port is kept so the embed URL stays stable", async () => {
	const preferred = await ephemeralPort();
	const alloc = await allocateWidgetPort("loopback", preferred);
	assert.equal(alloc.changed, false, "no reassignment when the configured port is free");
	assert.equal(alloc.port, preferred, "the configured port is what business systems embed");
});

test("a port already held by another profile is walked forward", async () => {
	const base = await ephemeralPort();
	const held = await occupy("127.0.0.1", base);
	try {
		// preferred = base (busy); the walk starts at `base` and skips it.
		const alloc = await allocateWidgetPort("loopback", base, base, 5);
		assert.equal(alloc.changed, true, "a busy port must trigger reassignment");
		assert.notEqual(alloc.port, base, "must not return the busy port");
		assert.equal(alloc.reason, "EADDRINUSE", "the failure reason is preserved for the UI");
		// And the returned port is genuinely bindable.
		const probe = await probePort("127.0.0.1", alloc.port);
		assert.equal(probe.free, true, "the allocated port is actually free");
	} finally {
		await new Promise((r) => held.close(r));
	}
});

test("the probe respects the bind host of the expose mode", async () => {
	assert.equal(bindHostFor("lan"), "0.0.0.0");
	assert.equal(bindHostFor("loopback"), "127.0.0.1");
	const port = await ephemeralPort();
	// MEASURED 2026-10-31: on macOS a 0.0.0.0 holder does NOT make a later
	// 127.0.0.1 bind fail (SO_REUSEADDR semantics). So the naive per-host probe
	// would let a loopback profile claim a port a lan profile already owns. The
	// regression is pinned below: raw probe says "free", probePortAnywhere says
	// "busy" — that difference is exactly why the widget uses the latter.
	const heldAll = await occupy("0.0.0.0", port);
	try {
		assert.equal((await probePort("0.0.0.0", port)).free, false, "lan probe sees the 0.0.0.0 holder");
		assert.equal((await probePortAnywhere("loopback", port)).free, false,
			"a loopback profile MUST still see a 0.0.0.0 holder (see raw-probe note above)");
		assert.equal((await probePortAnywhere("lan", port)).free, false, "lan profile sees it too");
	} finally {
		await new Promise((r) => heldAll.close(r));
	}
});

test("exhausting the window reports the original reason instead of guessing", async () => {
	const base = await ephemeralPort();
	const held = [await occupy("127.0.0.1", base)];
	try {
		// Window of 1 with the only candidate busy.
		const alloc = await allocateWidgetPort("loopback", base, base, 1);
		assert.equal(alloc.changed, false, "no reassignment possible");
		assert.equal(alloc.port, base, "returns the configured port, not a random one");
		assert.equal(alloc.reason, "EADDRINUSE", "the caller can explain WHY");
	} finally {
		for (const h of held) await new Promise((r) => h.close(r));
	}
});

test("an occupied port is reported in words when the forward window is also closed", async () => {
	// v0.2.177 semantics: a taken port is retried forward, so a bare single
	// collision no longer fails. The readable message still has to appear when
	// NOTHING in the window is bindable (window of 1 = no forward room).
	const port = await ephemeralPort();
	const held = await occupy("0.0.0.0", port);
	try {
		await assert.rejects(
			startWidgetServer({
				config: () => ({ title: "t", suggestions: [], disclaimer: "d", token: "tok", allowedOrigins: [] }),
				runtime: { isReadOnlyConversation: () => false, getOrCreateSession: () => ({}), send: async () => ({ reply: "" }) },
				expose: "lan",
				port,
				portBase: port,
				portAttempts: 0,
				log: () => {},
			}),
			(err) => {
				assert.equal(err.code, "EADDRINUSE", "the code is preserved for programmatic use");
				assert.match(err.message, /已被占用/, "the message is human-readable for the settings page");
				assert.match(err.message, new RegExp(String(port)), "it names the port");
				return true;
			},
		);
	} finally {
		await new Promise((r) => held.close(r));
	}
});

test("the default window starts at 17880 (documented default, not a magic number)", () => {
	assert.equal(WIDGET_PORT_BASE, 17880);
});

// ── code review P2-1 / P2-2 (commit 8c53a4a) ──

test("bind-time retry: losing the probe race still ends up listening (P2-1)", async () => {
	// The old design probed, then bound. Another profile could win the port in
	// between and the loser just failed with EADDRINUSE. Now the BIND retries
	// forward, so the loser still comes up — on a different port.
	const base = await ephemeralPort();
	// macOS quirk (measured): a 0.0.0.0 holder does NOT stop a later 127.0.0.1
	// bind. To create a REAL collision for a loopback listener, hold both.
	const winnerAll = await occupy("0.0.0.0", base);
	const winnerLo = await occupy("127.0.0.1", base);
	const rt = { isReadOnlyConversation: () => false, getOrCreateSession: () => ({}), send: async () => ({ reply: "" }) };
	try {
		const { port, server } = await startWidgetServer({
			config: () => ({ title: "t", suggestions: [], disclaimer: "d", token: "tok", allowedOrigins: [] }),
			runtime: rt,
			expose: "loopback",
			port: base,
			portBase: base,
			portAttempts: 5,
			log: () => {},
		});
		assert.notEqual(port, base, "the taken port is not the one reported");
		assert.ok(port > base && port <= base + 5, "forward within the window, got " + port);
		const url = "http://127.0.0.1:" + port + "/api/widget/config";
		const res = await fetch(url, { headers: { authorization: "Bearer tok" } });
		assert.equal(res.status, 200, "the recovered listener actually serves");
		server.closeAllConnections?.();
		server.close();
	} finally {
		await new Promise((r) => winnerLo.close(r));
		await new Promise((r) => winnerAll.close(r));
	}
});

test("bind-time retry gives up with a reason after the window is exhausted (P2-1)", async () => {
	const base = await ephemeralPort();
	const winners = [];
	for (let i = 0; i <= 2; i += 1) {
		winners.push(await occupy("0.0.0.0", base + i));
		winners.push(await occupy("127.0.0.1", base + i));
	}
	try {
		await assert.rejects(
			startWidgetServer({
				config: () => ({ title: "t", suggestions: [], disclaimer: "d", token: "tok", allowedOrigins: [] }),
				runtime: { isReadOnlyConversation: () => false, getOrCreateSession: () => ({}), send: async () => ({ reply: "" }) },
				expose: "loopback",
				port: base,
				portBase: base,
				portAttempts: 2,
				log: () => {},
			}),
			(err) => {
				assert.equal(err.code, "EADDRINUSE");
				assert.match(err.message, /自动顺延/, "the message says the forward attempts also failed");
				return true;
			},
		);
	} finally {
		for (const w of winners) await new Promise((r) => w.close(r));
	}
});

test("a non-collision error is NOT retried: exactly ONE bind attempt", async () => {
	// THE PROVABLE FORM: count bind attempts. An EADDRINUSE walk retries; any other
	// error must stop at the first attempt. This distinguishes the two behaviours
	// regardless of which error code finally surfaces.
	const attempts = [];
	let err;
	try {
		await startWidgetServer({
			config: () => ({ title: "t", suggestions: [], disclaimer: "d", token: "tok", allowedOrigins: [] }),
			runtime: { isReadOnlyConversation: () => false, getOrCreateSession: () => ({}), send: async () => ({ reply: "" }) },
			expose: "loopback",
			port: 17880,
			portBase: 17880,
			portAttempts: 20,
			log: () => {},
			onBindAttempt: (p) => attempts.push(p),
			// @ts-expect-error test-only override: TEST-NET-3 (RFC 5737) is never
			// assigned locally, so bind fails with EADDRNOTAVAIL — not a collision.
			_bindHostOverride: "203.0.113.1",
		});
	} catch (e) {
		err = e;
	}
	if (!err) return; // environment allowed it — nothing to assert
	assert.equal(attempts.length, 1, "a non-collision error must not walk the port window");
	assert.doesNotMatch(err.message, /已被占用/, "it must not be misreported as a busy port");
});
