/**
 * better-sqlite3 SMOKE for the CCL ledger (review P2-3, 2026-11-09).
 *
 * Every ContextStore suite runs on node:sqlite (the better-sqlite3 addon in a
 * dev checkout is rebuilt for ELECTRON's ABI by postinstall and cannot load
 * under plain node). This script is the opposite: it opens a REAL
 * better-sqlite3 handle through the app's own openDatabase() path (WAL,
 * migrate) and drives ContextStore appendNext / listTurns / replaceHead
 * round-trips against the driver production actually uses — the SQL dialect
 * and transaction behavior differ between drivers, and the suites never see
 * that half.
 *
 * Run:
 *   npm run smoke:context-store-native
 * (plain `node` works when the addon matches node's ABI, e.g. after
 * `npx prebuild-install -r node -t <nodever>` in node_modules/better-sqlite3;
 * with the stock electron-ABI addon run it as
 * `ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-context-store-native.mjs`.)
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// The bundle lives INSIDE node_modules so the external "better-sqlite3"
// import resolves against the project's own addon (tmpdir would break
// bare-specifier resolution).
const dir = join(root, "node_modules/.ccl-native-smoke-");
rmSync(dir, { recursive: true, force: true });
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
// A real FILE db (not :memory:) so the WAL checkpoint + reopen leg below is the
// production shape.
const dbDir = mkdtempSync(join(tmpdir(), "ve-ccl-native-smoke-"));
process.on("exit", () => { try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const bundle = join(dir, "ccl-native.mjs");
await build({
	stdin: {
		contents: `
			export { ContextStore } from "./src/context/store.ts";
			export { openDatabase, closeDatabase } from "./src/db/sqlite.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	// better-sqlite3 stays EXTERNAL: the whole point is loading the real native
	// addon, not a bundled stub.
	packages: "external",
});
const { ContextStore, openDatabase, closeDatabase } = await import(pathToFileURL(bundle).href);

let failed = 0;
const ok = (name, condition, detail = "") => {
	if (condition) console.log(`  ✔ ${name}`);
	else { failed += 1; console.error(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("[smoke] opening a real better-sqlite3 handle via openDatabase()…");
const dbFile = join(dbDir, "pi-employee.sqlite");
let db;
try {
	db = openDatabase(dbFile);
} catch (err) {
	console.error(`[smoke] FAILED to load the native addon (${err.message.split("\n")[0]})`);
	console.error("[smoke] the checkout's better-sqlite3 is likely rebuilt for Electron's ABI.");
	console.error("[smoke] run this script under ELECTRON_RUN_AS_NODE=1 electron, or rebuild the addon for node ABI first.");
	process.exit(1);
}

const store = new ContextStore(db);
console.log("[smoke] journal_mode:", db.pragma("journal_mode", { simple: true }));

// 1. appendNext: atomic seq allocation under loop attempts.
const seqs = [];
for (let i = 0; i < 200; i++) seqs.push(store.appendNext("work:smoke", { conversationId: "work:smoke", kind: "request", text: `第${i}轮扫描`, ts: 1_700_000_000_000 + i }).seq);
ok("appendNext allocates 1..200 consecutively", JSON.stringify(seqs) === JSON.stringify(Array.from({ length: 200 }, (_, i) => i + 1)));

// 2. digest round-trip through the REAL driver's JSON columns.
store.appendNext("work:smoke", {
	conversationId: "work:smoke", kind: "tool-digest", text: "", ts: 1_700_000_300_000,
	toolDigest: { name: "get_current_time", argsBrief: "{}", resultBrief: "当前北京时间：2026-11-09 12:00:00（周一）", durationMs: 2 },
});
const digest = store.listTurns("work:smoke", { limit: 1 })[0];
ok("tool digest round-trips", digest?.toolDigest?.name === "get_current_time" && digest.toolDigest.durationMs === 2);

// 3. replaceHead: compact-style diff lands as ONE transaction.
const records = store.listTurns("work:smoke");
const head = { conversationId: "work:smoke", seq: records[0].seq - 1, kind: "system", text: "【上文摘要】\n此前完成了 200 轮扫描，全部正常", ts: 1_700_000_400_000 };
const rebuilt = [head, ...records.slice(-10)];
const kept = new Set(rebuilt);
store.replaceHead("work:smoke", records.filter((r) => !kept.has(r)).map((r) => r.seq), rebuilt.filter((r) => !records.includes(r)));
const after = store.listTurns("work:smoke");
ok("replaceHead swaps head + tail (11 rows)", after.length === 11 && after[0].text.startsWith("【上文摘要】"), `got ${after.length} rows`);
ok("kept rows keep their seqs", after.slice(1).every((r, i) => r.seq === records[records.length - 10 + i].seq));

// 4. transactionality: a colliding insert rolls the whole write-back back.
const before = store.listTurns("work:smoke");
let threw = false;
try {
	// Delete seq A, then insert a row at KEPT seq B (B is NOT in the delete
	// list) — the insert must violate UNIQUE inside the transaction.
	store.replaceHead("work:smoke", [after[1].seq], [{ ...after[2], kind: "system", text: "撞号" }]);
} catch {
	threw = true;
}
ok("a colliding replacement throws", threw);
const rollback = store.listTurns("work:smoke");
ok("the failed write-back left the ledger byte-identical", JSON.stringify(rollback.map((r) => [r.seq, r.kind, r.text])) === JSON.stringify(before.map((r) => [r.seq, r.kind, r.text])));

// 5. lastSeq / pruneOlderThan / partition delete on the real driver.
ok("lastSeq reads MAX(seq)", store.lastSeq("work:smoke") === after.at(-1).seq);
store.appendNext("work:other", { conversationId: "work:other", kind: "request", text: "别的分区", ts: 1 });
store.pruneOlderThan(Number.MAX_SAFE_INTEGER);
ok("pruneOlderThan wipes by age across partitions", store.listTurns("work:smoke").length === 0 && store.listTurns("work:other").length === 0);

// 6. Persistence through the REAL handle: close (WAL checkpoint) + reopen.
store.appendNext("work:smoke", { conversationId: "work:smoke", kind: "reply", text: "重启前的最后一行", ts: 1_700_000_500_000 });
closeDatabase(db);
const db2 = openDatabase(dbFile);
const reopened = new ContextStore(db2);
const survived = reopened.listTurns("work:smoke");
ok("rows survive closeDatabase + reopen (WAL checkpoint)", survived.length === 1 && survived[0].text === "重启前的最后一行");
reopened.deleteConversation("work:smoke");
ok("deleteConversation clears the partition", reopened.listTurns("work:smoke").length === 0);
closeDatabase(db2);

if (failed > 0) {
	console.error(`[smoke] ${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("[smoke] all checks passed — ContextStore behaves identically on real better-sqlite3");
