/**
 * Credential snapshot under a LIVE database writer.
 *
 * The realistic case is not "copy while the browser is closed" — it is "the
 * operator's browser is open when we need a logged-in copy". A plain file copy
 * then fails on Windows with WinError 32; SQLite's online backup succeeds because
 * SQLite coordinates with the writer. This test opens a real SQLite database,
 * holds it (a live connection, WAL), and proves the snapshot still captures rows.
 *
 * It also pins the degrration contract: locked non-cookie data is SKIPPED (not a
 * hard failure) so the caller can keep the login and merely report freshness.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import {
	AUTH_DB_FILES,
	AUTH_PLAIN_FILES,
	snapshotAuthInto,
	snapshotHasCookies,
	staleSnapshotNote,
} from "../src/browser/auth-snapshot.ts";

const root = join(tmpdir(), `ve-authsnap-${process.pid}`);
rmSync(root, { recursive: true, force: true });
const master = join(root, "master");
const snap = join(root, "snap");
mkdirSync(join(master, "Default", "Network"), { recursive: true });

// A realistic cookie-shaped database.
const cookiesPath = join(master, "Default", "Network", "Cookies");
const live = new DatabaseSync(cookiesPath);
live.exec("PRAGMA journal_mode=WAL");
live.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT)");
live.exec("INSERT INTO cookies VALUES ('spay.zjzwfw.gov.cn', 'SESSION', 'logged-in-token')");

// HOLD the database open: this is the production condition (browser running).
writeFileSync(join(master, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: "abc" } }));
writeFileSync(join(master, "Default", "Preferences"), "{}");

const outcome = snapshotAuthInto(master, snap, { cookiesBudgetMs: 5000, otherBudgetMs: 200 });
assert.ok(outcome.copied.includes("Default/Network/Cookies"),
	`the cookie DB must be captured while the writer is live (copied=${outcome.copied.join(",")})`);
assert.ok(outcome.copied.includes("Local State"), "Local State holds the decryption key and must be copied");
assert.deepEqual(outcome.failed, [], `no hard failures expected, got ${JSON.stringify(outcome.failed)}`);

// The snapshot must actually contain the row — a file that exists but is empty
// would look like "logged out" and send the model hunting for cookies.
assert.ok(snapshotHasCookies(snap), "snapshot must contain a usable cookie DB");
const copied = new DatabaseSync(join(snap, "Default", "Network", "Cookies"), { readOnly: true });
const rows = copied.prepare("SELECT host_key, name, value FROM cookies").all();
copied.close();
assert.equal(rows.length, 1, "the row must survive the backup");
assert.equal(String(rows[0].value), "logged-in-token", "the login token must be intact");

// The live writer keeps working (we must not disturb the operator's browser).
live.exec("INSERT INTO cookies VALUES ('spay.zjzwfw.gov.cn', 'SECOND', 'v2')");
assert.equal(live.prepare("SELECT count(*) AS n FROM cookies").get().n, 2, "the live DB stays usable");

// Missing files are simply absent, never errors.
const emptyOut = snapshotAuthInto(join(root, "does-not-exist"), join(root, "empty"), {});
assert.deepEqual(emptyOut.copied, []);
assert.deepEqual(emptyOut.failed, []);

// Freshness must be stated, not implied: the note carries an age and the path.
const note = staleSnapshotNote("/tmp/snap", 3 * 60 * 60 * 1000);
assert.ok(note.includes("3"), "the note states how old the reused login is");
assert.ok(note.includes("复用"), "the note says we reused a previous snapshot");

// Constants used by the snapshot path stay honest about what carries a login.
assert.ok(AUTH_DB_FILES.some((f) => f.endsWith("Cookies")), "cookies must be in the auth set");
assert.ok(AUTH_PLAIN_FILES.includes("Local State"), "Local State must be in the plain-copy set");

// --- the two contracts the mutations above tried to break ------------------

// (1) A cookie DB that fails for a NON-lock reason must be REPORTED, not silently
// skipped: skipping means "reuse an older login", whereas a corrupt DB means the
// snapshot is unusable and the caller must say so.
const corruptRoot = join(root, "corrupt");
mkdirSync(join(corruptRoot, "Default", "Network"), { recursive: true });
writeFileSync(join(corruptRoot, "Default", "Network", "Cookies"), "this is not a sqlite database at all");
const corruptOut = snapshotAuthInto(corruptRoot, join(root, "corrupt-snap"), { cookiesBudgetMs: 1000 });
assert.equal(corruptOut.failed.length, 1,
	`a corrupt cookie DB must be reported as failed, got copied=${JSON.stringify(corruptOut.copied)} skipped=${JSON.stringify(corruptOut.skipped)}`);
assert.equal(corruptOut.failed[0].file, "Default/Network/Cookies");
assert.ok(!corruptOut.copied.includes("Default/Network/Cookies"), "a corrupt DB must not be counted as copied");

// (2) An EMPTY cookie DB is not a login. Treating it as valid is exactly how a
// task ends up silently signed out while everything "succeeds".
const emptySnapRoot = join(root, "empty-snap");
mkdirSync(join(emptySnapRoot, "Default", "Network"), { recursive: true });
const emptyDb = new DatabaseSync(join(emptySnapRoot, "Default", "Network", "Cookies"));
emptyDb.exec("CREATE TABLE cookies (host_key TEXT)");
emptyDb.close();
assert.equal(snapshotHasCookies(emptySnapRoot), false,
	"a zero-byte cookie DB must NOT count as a usable login");
assert.equal(snapshotHasCookies(join(root, "no-such-snap")), false, "a missing snapshot has no cookies");

live.close();
rmSync(root, { recursive: true, force: true });
console.log("test-browser-auth-snapshot: OK");
