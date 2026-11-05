/**
 * Owner→page ownership + consent lifecycle.
 *
 * Two failures this guards against, both observed in the field:
 *  1. A task being handed ANOTHER task's tab. A global "current page" selector is
 *     how two clients navigate/close each other's tabs (Playwright #42961).
 *  2. Credential copies surviving consent revocation. Turning real-profile
 *     browsing OFF must delete the snapshots (Hermes does the same:
 *     "revoking consent actually removes the credential copies").
 */
import { existsSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { PageOwnership } from "../src/browser/shared-session.ts";
import {
	CONSENT_COPY,
	SNAPSHOT_ROOT,
	applyConsentChange,
	deleteSnapshots,
	ensureSnapshotRoot,
	listSnapshots,
	snapshotRoot,
	sweepSnapshots,
} from "../src/browser/real-profile-consent.ts";

// --- fake Page surface (only what the registry touches) -------------------
function fakePage(name) {
	let closed = false;
	return {
		name,
		// Playwright's Page.isClosed() is a METHOD, not a property.
		isClosed() {
			return closed;
		},
		close() {
			closed = true;
			return Promise.resolve();
		},
	};
}

// --- registry -------------------------------------------------------------
const reg = new PageOwnership();
const a = fakePage("a");
const b = fakePage("b");

reg.set("owner-A", a);
reg.set("owner-B", b);
assert.equal(reg.get("owner-A"), a);
assert.equal(reg.get("owner-B"), b);
assert.notEqual(reg.get("owner-A"), reg.get("owner-B"), "owners must never share a page");
assert.equal(reg.get("owner-unknown"), undefined, "an unknown owner gets a fresh page, not somebody else's");
assert.deepEqual(reg.owners().sort(), ["owner-A", "owner-B"]);
assert.equal(reg.ownedBy(a), "owner-A");
assert.equal(reg.ownedBy(fakePage("stranger")), null, "an unowned page is recognised as foreign");

// A page that died on its own must be forgotten, never handed out.
await a.close();
assert.equal(reg.get("owner-A"), undefined, "a closed page is not returned");
assert.deepEqual(reg.owners(), ["owner-B"], "the dead owner is dropped from the registry");

// forgetByPage drops whoever owned it (used when a tab closes via the UI).
reg.forgetByPage(b);
assert.deepEqual(reg.owners(), [], "closing a tab clears its owner");

// takeover() = TRANSFER, not share: switching to another owner's tab drops the
// previous owner's pointer — one tab, one live owner, ever.
const t1 = fakePage("t1");
const t2 = fakePage("t2");
reg.set("A", t1);
reg.set("B", t2);
const prev = reg.takeover("A", t2);
assert.equal(prev, "B", "takeover reports the previous owner");
assert.equal(reg.get("A"), t2, "A now drives the taken tab");
assert.equal(reg.get("B"), undefined, "B must NOT still hold the same tab");
reg.clear();

// clear() is used on browser shutdown.
reg.set("x", fakePage("x"));
reg.clear();
assert.deepEqual(reg.owners(), []);

// --- consent lifecycle ---------------------------------------------------
const profileDir = join(tmpdir(), `ve-consent-test-${process.pid}`);
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });

assert.equal(snapshotRoot(profileDir), join(profileDir, SNAPSHOT_ROOT));
assert.deepEqual(listSnapshots(profileDir), [], "no snapshots before consent");

const root = ensureSnapshotRoot(profileDir);
const snap1 = join(root, "snap-1");
const snap2 = join(root, "snap-2");
mkdirSync(snap1, { recursive: true });
mkdirSync(snap2, { recursive: true });
assert.equal(listSnapshots(profileDir).length, 2);

// Consent ON keeps them.
let res = applyConsentChange(profileDir, true);
assert.deepEqual(res.removed, [], "enabling consent removes nothing");
assert.equal(listSnapshots(profileDir).length, 2);

// Consent OFF deletes every copy — this is the whole point of the switch.
res = applyConsentChange(profileDir, false);
assert.equal(res.removed.length, 2, "revoking consent deletes the credential copies");
assert.deepEqual(res.failed, []);
assert.deepEqual(listSnapshots(profileDir), [], "nothing left on disk after revocation");
assert.ok(!existsSync(snap1) && !existsSync(snap2));

// deleteSnapshots is idempotent (called at startup and at exit).
assert.deepEqual(deleteSnapshots(profileDir), { removed: [], failed: [] });

// sweepSnapshots must respect age and must NOT delete fresh snapshots.
const fresh = join(ensureSnapshotRoot(profileDir), "snap-fresh");
mkdirSync(fresh, { recursive: true });
const old = join(root, "snap-old");
mkdirSync(old, { recursive: true });
const ancient = Date.now() - 48 * 60 * 60 * 1000;
utimesSync(old, ancient / 1000, ancient / 1000);
const swept = sweepSnapshots(profileDir, 24 * 60 * 60 * 1000);
assert.equal(swept.removed.length, 1, "only the stale snapshot is swept");
assert.deepEqual(swept.failed, [], "sweeping a removable dir reports no failures");
assert.ok(existsSync(fresh), "a fresh snapshot survives the sweep");
assert.ok(!existsSync(old), "the stale snapshot is gone");
// The sweep's prefix/age rule must come from the same place as creation — the
// browser-use 14GB leak came from a mismatch there (issue #5422).
assert.ok(statSync(fresh).isDirectory());

// Consent copy is user-facing and must mention deletion on revoke.
assert.ok(CONSENT_COPY.body.includes("删除") || CONSENT_COPY.revokeNote.includes("删除"),
	"the consent text must tell the user the copies get deleted");

rmSync(profileDir, { recursive: true, force: true });

// --- BrowserService: a page creation that COMPLETES after an ownership change
// must not override it (review P1, reproduced with a delayed newPage()).
{
	const { build } = await import("esbuild");
	// Under the repo's node_modules so the external "playwright" import resolves.
	const bdir = join(repoRoot, "node_modules", `.bs-race-test-${process.pid}`);
	rmSync(bdir, { recursive: true, force: true });
	mkdirSync(bdir, { recursive: true });
	await build({
		entryPoints: [join(repoRoot, "src/browser/browser-service.ts")],
		outfile: join(bdir, "bs.mjs"), bundle: true, platform: "node", format: "esm",
		packages: "external", logLevel: "silent",
	});
	const { BrowserService } = await import(pathToFileURL(join(bdir, "bs.mjs")).href);

	function page2(name) {
		let closed = false;
		return {
			name, url: () => `https://x/${name}`,
			isClosed: () => closed,
			close: () => { closed = true; return Promise.resolve(); },
			setDefaultNavigationTimeout() {}, on() {}, title: async () => name,
		};
	}
	const pending = [];   // resolvers for deferred newPage() calls
	const open = [];
	const fakeContext = {
		pages: () => [...open],
		on() {},
		newPage: () => new Promise((resolve) => pending.push(resolve)),
	};
	const config = { all: () => ({ browser: { headless: true, allowedDomains: [], useRealProfile: false } }) };
	const bs = new BrowserService(config, bdir);
	// Bypass launch(): the race is in ownership, not Chromium.
	bs.context = fakeContext;

	// RACE 1 — pending getPage("A") + switchPage("A", 0): the takeover must win.
	const target = page2("target");
	open.push(target);
	const pA = bs.getPage("A");
	await Promise.resolve();   // let getPage reach the newPage() await
	await bs.switchPage("A", 0);   // A takes over the (unowned) target tab
	assert.equal(bs.pages.get("A"), target, "takeover registered before creation finished");
	const late = page2("late");
	pending[0](late);
	const got = await pA;
	assert.equal(got, target, "the takeover must win over the stale creation");
	assert.ok(late.isClosed(), "the stale page must be closed, not leaked");
	assert.equal(bs.pages.get("A"), target, "registry still points at the takeover target");
	assert.equal(bs.pages.get("B"), undefined);

	// RACE 2 — pending getPage + releasePage: the released owner must NOT be resurrected.
	const pA2 = bs.getPage("A2");
	await Promise.resolve();
	await bs.releasePage("A2");
	const late2 = page2("late2");
	pending[1](late2);
	await assert.rejects(pA2, /过期/, "a creation that raced a release must fail honestly, not resurrect");
	assert.ok(late2.isClosed(), "the resurrected page must be closed");
	assert.equal(bs.pages.get("A2"), undefined, "the released owner stays released");

	rmSync(bdir, { recursive: true, force: true });
}

console.log("test-browser-shared-session: OK");
