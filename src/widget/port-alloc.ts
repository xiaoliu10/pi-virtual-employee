/**
 * Widget port allocation across profiles.
 *
 * Why this exists: a machine can run several profiles at once
 * (`--profile Nova`, `--profile Orion`, …). Each profile keeps its own config,
 * and every one of them defaulted to port 17880 — so the second profile to
 * start the widget silently failed with EADDRINUSE while the settings page
 * happily showed "enabled" (review 2026-10-31: multi-profile port collision).
 *
 * The console transport dodges this with `port: 0` (OS picks a free port), but
 * the widget CANNOT: business systems embed a literal URL, so the address has
 * to be stable. The compromise is to pick a free port once, persist it into
 * that profile's config, and keep it thereafter.
 *
 * Probe semantics: we bind-test the exact (host, port) pair the widget will
 * use, so "free" means "free for THIS expose mode" — a port held on 127.0.0.1
 * is reported busy for loopback, and 0.0.0.0 correctly conflicts with both.
 */
import { createServer } from "node:net";

/** First port tried. Below the IANA ephemeral range, so a later OS-assigned
 *  listen port will not collide with an already-allocated widget port. */
export const WIDGET_PORT_BASE = 17880;
export const WIDGET_PORT_ATTEMPTS = 20;

export interface PortProbe {
	/** Port is bindable on the given host right now. */
	free: boolean;
	/** Reason the bind failed (EADDRINUSE / EACCES / …), for the UI. */
	reason?: string;
}

/** Bind-test one host:port without keeping the listener. */
export function probePort(host: string, port: number): Promise<PortProbe> {
	return new Promise((resolve) => {
		const probe = createServer();
		const done = (result: PortProbe) => {
			try {
				probe.close();
			} catch { /* already closed */ }
			resolve(result);
		};
		probe.once("error", (err: NodeJS.ErrnoException) => done({ free: false, reason: err.code ?? err.message }));
		probe.listen(port, host, () => done({ free: true }));
	});
}

/**
 * Is this port usable for the widget on THIS machine?
 *
 * Naively probing the widget's own bind host is wrong: measured on macOS, a
 * listener on 0.0.0.0 does NOT stop a later bind on 127.0.0.1 (SO_REUSEADDR
 * semantics, verified 2026-10-31) — so a loopback-mode profile would happily
 * "claim" a port a lan-mode profile already owns, and the two would share it.
 * We therefore treat a port as taken when ANY interface holds it: probe 0.0.0.0
 * first (it fails for holders on any interface), then the widget's own host.
 */
export async function probePortAnywhere(
	expose: "loopback" | "lan",
	port: number,
): Promise<PortProbe> {
	const wildcard = await probePort("0.0.0.0", port);
	if (!wildcard.free) return wildcard;
	const own = await probePort(bindHostFor(expose), port);
	return own;
}

/** Host the widget binds for a given expose mode. */
export function bindHostFor(expose: "loopback" | "lan"): string {
	return expose === "lan" ? "0.0.0.0" : "127.0.0.1";
}

/**
 * Pick a port for this profile: `preferred` when free, otherwise the first
 * free port in [WIDGET_PORT_BASE, WIDGET_PORT_BASE + WIDGET_PORT_ATTEMPTS).
 */
export async function allocateWidgetPort(
	expose: "loopback" | "lan",
	preferred: number,
	base = WIDGET_PORT_BASE,
	attempts = WIDGET_PORT_ATTEMPTS,
): Promise<{ port: number; changed: boolean; reason?: string }> {
	const first = await probePortAnywhere(expose, preferred);
	if (first.free) return { port: preferred, changed: false };
	for (let i = 0; i < attempts; i += 1) {
		const candidate = base + i;
		if (candidate === preferred) continue;
		if (candidate > 65_535) break;
		const probe = await probePortAnywhere(expose, candidate);
		if (probe.free) return { port: candidate, changed: true, reason: first.reason };
	}
	// Nothing free in the window: report the original failure instead of
	// silently binding an unpredictable port.
	return { port: preferred, changed: false, reason: first.reason };
}
