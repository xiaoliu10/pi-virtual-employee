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
import { join } from "node:path";
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
console.log("test-browser-shared-session: OK");
