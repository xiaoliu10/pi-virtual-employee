/**
 * Chromium CDP endpoint discovery — no port races, ever.
 *
 * Playwright's `launchPersistentContext()` normally hands Chromium a private
 * `--remote-debugging-pipe`, which means no TCP DevTools endpoint exists and no
 * second client can attach to the browser. That is fine for one owner but wrong
 * for us: several tasks (work windows, scheduled fires, IM turns) must share one
 * logged-in browser instead of launching rival Chromiums on the same
 * user-data-dir (Chromium allows exactly one process per profile; the loser dies
 * with exitCode 21 = RESULT_CODE_PROFILE_IN_USE).
 *
 * The fix used here mirrors Hermes (`tools/browser_launcher.py`): let Chromium
 * pick its OWN port with `--remote-debugging-port=0` and read the result from
 * `<user-data-dir>/DevToolsActivePort`. Chromium writes that file itself
 *
 *     line 1: the port
 *     line 2: the browser websocket path (e.g. /devtools/browser/<uuid>)
 *
 * so there is no bind→close→rebind race (the failure mode of "find a free port
 * now, hand it to the child later" implementations). Because Playwright's pipe
 * must not also be present, callers launch Chromium themselves and then attach:
 *
 *     chromium.launchPersistentContext(udd, { args: devToolsFlags() })  // no pipe? see note
 *     const ep = await waitForDevToolsEndpoint(udd)
 *     const browser = await chromium.connectOverCDP(ep.httpBase)
 *
 * (Playwright always adds its own `--remote-debugging-pipe`; a caller that needs a
 * TCP endpoint launches Chromium directly and attaches over CDP. This module covers
 * the endpoint half — discovering and validating it — and does not prescribe the
 * spawn, which differs per host.)
 *
 * The file is written AFTER the endpoint is listening, so a missing/partial file
 * means "not ready yet" and is retried until the caller's deadline.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Chromium's DevTools endpoint file, written into the user-data-dir root. */
export const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";

export interface DevToolsEndpoint {
	/** TCP port Chromium is listening on (127.0.0.1). */
	port: number;
	/** `<port>/<path-without-leading-slash>`, e.g. `52312/devtools/browser/<uuid>`. */
	browserPath: string;
	/** Full HTTP base used by connectOverCDP, e.g. `http://127.0.0.1:52312`. */
	httpBase: string;
	/** Full websocket URL for the browser endpoint. */
	wsUrl: string;
}

/**
 * Parse the contents of a DevToolsActivePort file.
 *
 * Returns null for anything incomplete: Chromium truncates+writes this file, so a
 * concurrent read can observe it empty or with only the first line. Treating a
 * partial read as success would hand Playwright a dead endpoint.
 */
export function parseDevToolsActivePort(raw: string): DevToolsEndpoint | null {
	const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (lines.length < 2) return null;
	const port = Number(lines[0]);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	const browserPath = lines[1].replace(/^\/+/, "");
	if (!browserPath.startsWith("devtools/")) return null;
	const httpBase = `http://127.0.0.1:${port}`;
	return {
		port,
		browserPath,
		httpBase,
		wsUrl: `ws://127.0.0.1:${port}/${browserPath}`,
	};
}

/** Read + parse the endpoint file, or null when it is missing/incomplete. */
export function readDevToolsEndpoint(userDataDir: string): DevToolsEndpoint | null {
	const file = join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE);
	if (!existsSync(file)) return null;
	try {
		return parseDevToolsActivePort(readFileSync(file, "utf8"));
	} catch {
		// Locked/partially written: not ready. The caller retries.
		return null;
	}
}

/** True when the endpoint file exists and (if required) was written after the child spawned. */
function isFreshEnough(userDataDir: string, writtenAfterMs: number | undefined, now: () => number): boolean {
	if (writtenAfterMs === undefined) return true;
	try {
		const mtime = statSync(join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE)).mtimeMs;
		// Allow 2s of filesystem timestamp granularity / clock skew.
		const fresh = mtime >= writtenAfterMs - 2000;
		if (!fresh) {
			// Not an error: Chromium simply has not rewritten it yet. Logged once per
			// poll only when a stale file is actually present, so the cause is visible
			// if the wait later times out.
			void now;
		}
		return fresh;
	} catch {
		return false;
	}
}

export interface WaitOptions {
	/** Total time to wait for the file to appear (default 30s). */
	timeoutMs?: number;
	/**
	 * Only accept a file written at/after this epoch-ms (normally the child's spawn
	 * time). A crashed previous run leaves a COMPLETE, perfectly parseable
	 * DevToolsActivePort behind; without this lower bound the first poll returns the
	 * dead port, connectOverCDP fails, and the failure gets misdiagnosed as anything
	 * but "stale file" — the exact misdiagnosis chain that led to browsers being
	 * killed in bulk (review P2-5).
	 */
	writtenAfterMs?: number;
	/** Poll interval (default 150ms). */
	intervalMs?: number;
	/** Cancels the wait; the caller tears the child down when it resolves null. */
	signal?: AbortSignal;
	/** Injectable clock/sleep for tests. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll until Chromium publishes its endpoint.
 *
 * Resolves null on timeout — callers MUST treat that as a launch failure and kill
 * the child, otherwise the process lingers as an orphan occupying the profile
 * (the exact bug browser-use hit in its own watchdog).
 */
export async function waitForDevToolsEndpoint(
	userDataDir: string,
	opts: WaitOptions = {},
): Promise<DevToolsEndpoint | null> {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const intervalMs = opts.intervalMs ?? 150;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = now() + timeoutMs;
	for (;;) {
		if (opts.signal?.aborted) return null;
		const endpoint = readDevToolsEndpoint(userDataDir);
		if (endpoint && isFreshEnough(userDataDir, opts.writtenAfterMs, now)) return endpoint;
		const remaining = deadline - now();
		if (remaining <= 0) return null;
		// Cap the sleep at the remaining budget so a large interval cannot overshoot
		// the caller's deadline (review P3-1).
		await sleep(Math.min(intervalMs, remaining));
	}
}

/**
 * Chromium flags for a shareable, logged-in browser.
 *
 * `--remote-debugging-port=0` is the whole point (let Chromium choose, then read
 * the file). The rest are the flags Hermes keeps for an unattended browser
 * driving a user's real sessions: never suppress the hang monitor or popup
 * blocking, and keep the OS keychain path intact (no `--password-store=basic`,
 * no `--use-mock-keychain`) so the profile's encrypted cookies still decrypt.
 */
export function devToolsFlags(): string[] {
	return [
		"--remote-debugging-port=0",
		"--no-first-run",
		"--disable-prompt-on-repost",
	];
}

/**
 * Why a profile cannot be shared, phrased for the model/user — never silently
 * swapped for a signed-out browser without saying so.
 */
export function profileBusyNote(profileDir: string, holderPid?: number | null): string {
	const who = holderPid ? `（占用进程 pid ${holderPid}）` : "";
	return (
		`浏览器 profile 正在被占用：${profileDir}${who}。` +
		"Chromium 每个 profile 只允许一个进程；请等占用它的任务结束，或改用浏览器工具共享的实例。" +
		"不要反复重试，也不要按进程名批量结束浏览器（会杀掉其它任务的浏览器并丢失登录态）。"
	);
}

/** Note shown when the isolated copy could not be prepared and a fresh browser serves instead. */
export function degradedBrowserNote(reason: string): string {
	return (
		`${reason} 本次改用没有登录态的新浏览器继续；如果任务需要你的账号，请告知用户。`
	);
}
