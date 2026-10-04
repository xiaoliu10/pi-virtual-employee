/**
 * FileCredentialStore tests: real files in a temp agent dir, no Electron.
 *
 * Covers: persistence + reload, modify read-modify-write semantics, in-process
 * AND cross-file-lock write serialization (no lost updates), corrupt/BOM file
 * tolerance, stale + live lock handling, lock timeout, delete, and the 0600/0700
 * permission story (posix only).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.credstore-test-"));
after(() => rm(dir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/engine/credential-store.ts")],
	outfile: join(dir, "credential-store.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { FileCredentialStore, resolveAgentDir, resolveAuthPath } = await import(pathToFileURL(join(dir, "credential-store.mjs")));

const oauth = (access = "at-1") => ({ type: "oauth", access, refresh: "rt-1", expires: Date.now() + 3600_000 });

/** Fresh store on its own auth.json, cleaned up with the test. */
function store(t, name, opts = {}) {
	const file = join(dir, `${name}.json`);
	const s = new FileCredentialStore({ authPath: file, lockTimeoutMs: 5_000, lockStaleMs: 30_000, ...opts });
	t.after(() => {
		try {
			rmSync(join(file + ".lock"), { force: true });
		} catch { /* best effort */ }
	});
	return s;
}

/** Spawn a child process that holds `lockPath` for `holdMs` (a REAL cross-process lock), then releases it. */
function holdLockInChild(lockPath, holdMs) {
	return spawn(process.execPath, [
		"-e",
		`const fs=require("node:fs");const p=process.env.LOCK;const fd=fs.openSync(p,"wx");
		 fs.writeSync(fd,JSON.stringify({pid:process.pid,at:Date.now()}));
		 setTimeout(()=>{try{fs.unlinkSync(p)}catch{}},Number(process.env.HOLD_MS));`,
	], { env: { ...process.env, LOCK: lockPath, HOLD_MS: String(holdMs) }, stdio: "ignore" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred()` is truthy, bounded. Replaces blind sleeps when waiting
 * on a child process: cold start (node boot + fs) can take hundreds of ms, and
 * assuming the lock already exists is exactly the race that makes tests flaky. */
async function waitFor(pred, timeoutMs = 2_000, everyMs = 20) {
	const end = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > end) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
		await sleep(everyMs);
	}
}

test("agent dir resolves from PI_CODING_AGENT_DIR else ~/.pi", () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-test";
		assert.equal(resolveAgentDir(), "/tmp/pi-agent-test");
		assert.equal(resolveAuthPath(), join("/tmp/pi-agent-test", "auth.json"));
		delete process.env.PI_CODING_AGENT_DIR;
		assert.ok(resolveAgentDir().endsWith(".pi"), `expected ~/.pi default, got ${resolveAgentDir()}`);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	}
});

test("modify persists; a fresh instance reloads from the same file", async (t) => {
	const file = join(dir, "reload.json");
	const a = new FileCredentialStore({ authPath: file });
	await a.modify("anthropic", async () => oauth("at-abc"));
	const b = new FileCredentialStore({ authPath: file });
	assert.equal((await b.read("anthropic")).access, "at-abc");
	assert.deepEqual(await b.list(), [{ providerId: "anthropic", type: "oauth" }]);
	// On-disk content is valid JSON keyed by provider id.
	const disk = JSON.parse(await readFile(file, "utf8"));
	assert.equal(disk.anthropic.access, "at-abc");
});

test("modify passes current to fn; undefined leaves the entry unchanged", async (t) => {
	const s = store(t, "rmw");
	let seen;
	await s.modify("p1", async (current) => {
		seen = current;
		return oauth("v1");
	});
	assert.equal(seen, undefined);
	const result = await s.modify("p1", async (current) => {
		assert.equal(current.access, "v1");
		return undefined; // explicit no-op
	});
	assert.equal(result.access, "v1");
	assert.equal((await s.read("p1")).access, "v1");
});

test("concurrent modify calls serialize — no lost update (single + two instances)", async (t) => {
	const file = join(dir, "serial.json");
	const a = new FileCredentialStore({ authPath: file, lockTimeoutMs: 10_000 });
	const b = new FileCredentialStore({ authPath: file, lockTimeoutMs: 10_000 });
	await a.modify("counter", async () => ({ type: "api_key", key: "0" }));
	const bump = (store) => store.modify("counter", async (cur) => ({ type: "api_key", key: String(Number(cur.key) + 1) }));
	await Promise.all([
		...Array.from({ length: 20 }, () => bump(a)),
		...Array.from({ length: 20 }, () => bump(b)),
	]);
	assert.equal((await a.read("counter")).key, "40");
});

test("read/list survive corrupt json and invalid entries (warn, not throw)", async (t) => {
	const file = join(dir, "corrupt.json");
	await writeFile(file, "{ this is not json");
	const s = new FileCredentialStore({ authPath: file });
	assert.equal(await s.read("anthropic"), undefined);
	assert.deepEqual(await s.list(), []);
	// modify rewrites the file cleanly from the empty view.
	await s.modify("zai", async () => ({ type: "api_key", key: "zk" }));
	assert.equal((await s.read("zai")).key, "zk");

	// Shape-invalid entries are dropped individually; valid ones survive.
	const mixed = join(dir, "mixed.json");
	await writeFile(mixed, JSON.stringify({
		good: oauth("ok"),
		bad: { type: "junk" },
		alsobad: "string",
	}));
	const s2 = new FileCredentialStore({ authPath: mixed });
	assert.deepEqual(await s2.list(), [{ providerId: "good", type: "oauth" }]);
	assert.equal(await s2.read("bad"), undefined);
});

test("BOM-prefixed files (pi CLI style) parse fine", async (t) => {
	const file = join(dir, "bom.json");
	await writeFile(file, "\uFEFF" + JSON.stringify({ kimi: oauth() }));
	const s = new FileCredentialStore({ authPath: file });
	assert.equal((await s.read("kimi")).type, "oauth");
});

test("delete removes the entry; deleting a missing entry is a no-op", async (t) => {
	const s = store(t, "delete");
	await s.modify("x", async () => oauth());
	await s.delete("x");
	assert.equal(await s.read("x"), undefined);
	await s.delete("x"); // no throw
	assert.deepEqual(await s.list(), []);
});

test("stale lock (dead pid) is reclaimed immediately", async (t) => {
	const file = join(dir, "stalelock.json");
	// A pid far beyond any real pid on mac/linux: dead by construction.
	writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2_000_000_000, at: Date.now() }));
	const s = new FileCredentialStore({ authPath: file, lockTimeoutMs: 3_000 });
	await s.modify("p", async () => oauth());
	assert.equal((await s.read("p")).type, "oauth");
	assert.ok(!existsSync(`${file}.lock`), "lock released after modify");
});

test("stale lock (old mtime, unknown pid format) is reclaimed", async (t) => {
	const file = join(dir, "oldlock.json");
	writeFileSync(`${file}.lock`, "not-json-but-old");
	const longAgo = new Date(Date.now() - 60_000);
	utimesSync(`${file}.lock`, longAgo, longAgo);
	const s = new FileCredentialStore({ authPath: file, lockTimeoutMs: 3_000, lockStaleMs: 30_000 });
	await s.modify("p", async () => oauth());
	assert.ok(!existsSync(`${file}.lock`));
});

// ── double-hold races (review H2): content checks on reclaim/verify/release ──

test("reclaim re-reads before unlink: a lock swapped in after the stale verdict is NOT stolen", async (t) => {
	const file = join(dir, "reclaim-race.json");
	const lockPath = `${file}.lock`;
	writeFileSync(lockPath, JSON.stringify({ pid: 2_000_000_000, at: Date.now() })); // stale (dead pid)
	const s = new FileCredentialStore({ authPath: file, lockTimeoutMs: 600 });
	// Instrument the staleness verdict: right after it fires, swap the lock for
	// a LIVE one (our own pid, fresh mtime) — simulating another waiter that
	// observed the same stale lock, unlinked it and recreated its own in the
	// gap between our verdict and our unlink. The re-read must see the content
	// changed (≠ observed) and skip the unlink.
	const orig = s.lockIsStale.bind(s);
	let swapped = false;
	s.lockIsStale = () => {
		const verdict = orig();
		if (verdict && !swapped) {
			swapped = true;
			writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
		}
		return verdict;
	};
	t.after(() => rmSync(lockPath, { force: true }));
	// The swapped-in LIVE lock must survive untouched: we never acquire, and
	// the budget runs out with the clear timeout error.
	await assert.rejects(() => s.modify("p", async () => oauth()), /凭证锁获取超时/);
	assert.ok(swapped, "the stale verdict should have fired exactly once");
	const survivor = JSON.parse(readFileSync(lockPath, "utf8"));
	assert.equal(survivor.pid, process.pid, "the recreated live lock must not be deleted by the racy reclaimer");
});

test("post-create verification: a lock swapped in after O_EXCL create is not treated as held", async (t) => {
	const file = join(dir, "verify-race.json");
	const lockPath = `${file}.lock`;
	// Start from a stale (dead-pid) lock so the first attempt takes the reclaim path.
	writeFileSync(lockPath, JSON.stringify({ pid: 2_000_000_000, at: Date.now() }));
	const s = new FileCredentialStore({ authPath: file, lockStaleMs: 50, lockTimeoutMs: 5_000 });
	// First verification of our own freshly created lock reports a FOREIGN
	// holder — simulating a waiter that unlinked our just-created lock and
	// recreated its own between our create and our verification read.
	const orig = s.readLockPayload.bind(s);
	let forged = false;
	s.readLockPayload = () => {
		const real = orig();
		if (real && real.pid === process.pid && !forged) {
			forged = true;
			return { pid: 1_900_000_000, at: Date.now(), token: "foreign" };
		}
		return real;
	};
	t.after(() => rmSync(lockPath, { force: true }));
	// The forged verification must NOT count as held: the store retries, and
	// the modify still completes once the lock is honestly (re)acquired.
	await s.modify("p", async () => oauth("v"));
	assert.ok(forged, "verification should have seen the forged foreign payload");
	assert.equal((await s.read("p")).access, "v");
	assert.ok(!existsSync(lockPath), "lock released after modify");
});

test("releaseLock only removes its own lock — a recreated lock survives the previous holder's release", async (t) => {
	const file = join(dir, "release-race.json");
	const lockPath = `${file}.lock`;
	// A: default staleness (a legitimate holder). B: 1ms — A's lock goes stale
	// for B while A's fn runs, so B reclaims and recreates the lock.
	const a = new FileCredentialStore({ authPath: file, lockTimeoutMs: 5_000 });
	const b = new FileCredentialStore({ authPath: file, lockStaleMs: 1, lockTimeoutMs: 5_000 });
	const atOf = () => {
		try {
			return JSON.parse(readFileSync(lockPath, "utf8")).at;
		} catch {
			return undefined; // lock momentarily absent (reclaim window)
		}
	};
	let letBFinish;
	const bGate = new Promise((resolve) => { letBFinish = resolve; });
	const aDone = a.modify("p", async () => {
		const mineAt = atOf(); // A's own lock
		// Wait until B has recreated the lock (different `at`), so A's upcoming
		// release runs against B's lock, not its own.
		await waitFor(() => {
			const at = atOf();
			return at !== undefined && at !== mineAt;
		}, 3_000, 5);
		return oauth("from-a");
	});
	const bDone = b.modify("p", async () => {
		// Hold the lock until A's release has happened.
		await bGate;
		return oauth("from-b");
	});
	await aDone; // A finished: wrote, then released — against B's lock
	// A's release must have been a no-op: B's recreated lock is still there.
	assert.ok(existsSync(lockPath), "B's recreated lock must survive A's release");
	letBFinish();
	const result = await bDone;
	assert.equal(result.access, "from-b");
	assert.ok(!existsSync(lockPath), "lock released after B finishes");
});

test("live lock held by another process is waited out, not stolen", async (t) => {
	const file = join(dir, "waitlock.json");
	const lockPath = `${file}.lock`;
	mkdirSync(dirname(lockPath), { recursive: true });
	const child = holdLockInChild(lockPath, 400);
	t.after(() => {
		child.kill();
		try {
			rmSync(lockPath, { force: true });
		} catch { /* best effort */ }
	});
	await waitFor(() => existsSync(lockPath)); // child cold start — never assume
	assert.ok(existsSync(lockPath));
	const started = Date.now();
	const s = new FileCredentialStore({ authPath: file, lockTimeoutMs: 5_000 });
	await s.modify("p", async () => oauth());
	assert.ok(Date.now() - started >= 200, `should have waited for the live lock (took ${Date.now() - started}ms)`);
	assert.equal((await s.read("p")).type, "oauth");
});

test("lock acquisition gives up after the timeout with a clear error", async (t) => {
	const file = join(dir, "busy.json");
	const lockPath = `${file}.lock`;
	mkdirSync(dirname(lockPath), { recursive: true });
	const child = holdLockInChild(lockPath, 5_000); // held far longer than the budget below
	t.after(() => {
		child.kill();
		try {
			rmSync(lockPath, { force: true });
		} catch { /* best effort */ }
	});
	// Wait until the child has ACTUALLY created the lock (spawn + cold start can
	// take hundreds of ms — a blind sleep(50) raced the child and the store
	// acquired the (nonexistent) lock immediately, so no rejection ever fired).
	await waitFor(() => existsSync(lockPath));
	const s = new FileCredentialStore({ authPath: file, lockTimeoutMs: 150 });
	await assert.rejects(
		() => s.modify("p", async () => oauth()),
		/凭证锁获取超时/,
	);
});

test("credential file is 0600 and its dir 0700 (posix)", { skip: process.platform === "win32" }, async (t) => {
	const file = join(dir, "perm.json");
	const s = new FileCredentialStore({ authPath: file });
	await s.modify("p", async () => oauth());
	const mode = (f) => statSync(f).mode & 0o777;
	assert.equal(mode(file), 0o600, `auth.json mode: ${mode(file).toString(8)}`);
	assert.equal(mode(dirname(file)), 0o700, `dir mode: ${mode(dirname(file)).toString(8)}`);
	// A pre-existing world-readable file is rewritten 0600 by the next modify.
	const loose = join(dir, "loose.json");
	writeFileSync(loose, JSON.stringify({ p: oauth() }));
	chmodSync(loose, 0o644);
	await new FileCredentialStore({ authPath: loose }).modify("q", async () => oauth());
	assert.equal(mode(loose), 0o600);
});

test("aborting modify before it runs leaves the file untouched", async (t) => {
	const s = store(t, "abort");
	await s.modify("p", async () => oauth());
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => s.modify("p", async () => oauth("at-2"), { signal: controller.signal }),
	);
	assert.equal((await s.read("p")).access, "at-1");
});

test("write failures propagate but keep the lock released", async (t) => {
	const s = store(t, "faily");
	await assert.rejects(() => s.modify("p", async () => {
		throw new Error("fn exploded");
	}), /fn exploded/);
	assert.ok(!existsSync(`${s.authPath}.lock`), "lock must be released after a failed fn");
	// And the store still works afterwards.
	await s.modify("p", async () => oauth());
	assert.equal((await s.read("p")).type, "oauth");
});
