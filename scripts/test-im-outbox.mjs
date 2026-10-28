#!/usr/bin/env node
/**
 * IM delivery ledger + outbox tests (docs/design/delivery-reliability.md S1).
 *
 * Pins the ONLY promise the ledger makes: a push carrying an occurrence identity
 * is delivered at most once, while the same occurrence stays retryable after a
 * failure and a new occurrence is never suppressed. Pushed through the real
 * manager entry point (pushToConversation) against a fake proactive adapter, on a
 * REAL sqlite file in a temp dir — no Electron, and the DB is reopened mid-test to
 * prove the skip survives a restart.
 *
 * Regression guard the other way round: a push with NO occurrence id must never
 * touch the ledger (backward compatibility for every caller that predates S1).
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.im-outbox-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const bundle = join(dir, "outbox.mjs");
await build({
	stdin: {
		contents: `
			export { DeliveryLedger, scheduledOccurrenceId, chatOccurrenceId } from "./src/im/delivery-ledger.ts";
			export { IMAdapterManager } from "./src/im/manager.ts";
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
const { DeliveryLedger, IMAdapterManager, scheduledOccurrenceId, chatOccurrenceId } = await import(pathToFileURL(bundle).href);

/** A real sqlite file per test — the ledger must survive closing/reopening it. */
async function dbFile(t) {
	const d = await mkdtemp(join(tmpdir(), "ve-outbox-"));
	t.after(() => rm(d, { recursive: true, force: true }));
	return join(d, "pi-employee.sqlite");
}

/** Manager wired to one fake DingTalk-capable adapter; records every send. */
function fakeManager({ fail = () => false } = {}) {
	const manager = Object.create(IMAdapterManager.prototype);
	const sent = [];
	let calls = 0;
	const fake = {
		channel: "dingtalk",
		metadata: { displayName: "假钉钉", capabilities: { streaming: true, proactive: true, groupMention: true, media: true } },
		push: async (conversationId, text) => {
			calls += 1;
			if (fail(calls, text)) return { ok: false, error: "平台拒收（模拟）" };
			sent.push({ conversationId, text });
			return { ok: true };
		},
	};
	manager.active = new Map([["dingtalk-1", fake]]);
	manager.adapterFor = () => fake; // shadow the dt:-prefix router
	return { manager, sent, calls: () => calls };
}

function useLedger(t, manager, file, now) {
	const db = new DatabaseSync(file);
	t.after(() => { try { db.close(); } catch { /* already closed */ } });
	const ledger = new DeliveryLedger(db, now);
	manager.deps = { ledger };
	return { db, ledger };
}

test("same occurrence pushed twice: second push is skipped, not sent", async (t) => {
	const file = await dbFile(t);
	const { manager, sent, calls } = fakeManager();
	const { ledger } = useLedger(t, manager, file);
	const occ = scheduledOccurrenceId("task-1", 1_700_000_000_000);

	const first = await manager.pushToConversation("dt:staff-1", "⏰ 定时任务完成", { occurrenceId: occ, kind: "scheduled" });
	const second = await manager.pushToConversation("dt:staff-1", "⏰ 定时任务完成", { occurrenceId: occ, kind: "scheduled" });

	assert.deepEqual(first, { ok: true }, "first push delivers");
	assert.equal(second.ok, true, "a skip is not a failure for the caller");
	assert.equal(second.skipped, true, "second push is reported as skipped");
	assert.equal(calls(), 1, "adapter.push invoked exactly once");
	assert.equal(sent.length, 1);
	assert.equal(ledger.get(occ).status, "delivered");
	assert.equal(ledger.get(occ).attempts, 1);
});

test("delivered occurrence still skipped after a restart (DB reopened)", async (t) => {
	const file = await dbFile(t);
	const occ = scheduledOccurrenceId("task-2", 1_700_000_100_000);

	// ── process #1: deliver, then "crash" (db closed) ──────────────────────
	{
		const { manager, sent } = fakeManager();
		const db = new DatabaseSync(file);
		manager.deps = { ledger: new DeliveryLedger(db) };
		const r = await manager.pushToConversation("dt:group:cid", "✅ 完成", { occurrenceId: occ });
		assert.equal(r.ok, true);
		assert.equal(sent.length, 1);
		db.close();
	}

	// ── process #2: fresh open of the same file, same occurrence ───────────
	const { manager, sent, calls } = fakeManager();
	const db = new DatabaseSync(file);
	t.after(() => { try { db.close(); } catch { /* closed */ } });
	const reopened = new DeliveryLedger(db);
	manager.deps = { ledger: reopened };

	const again = await manager.pushToConversation("dt:group:cid", "✅ 完成", { occurrenceId: occ });
	assert.equal(again.skipped, true, "restart does not forget a delivered occurrence");
	assert.equal(calls(), 0, "nothing was sent after the restart");
	assert.equal(sent.length, 0);
	assert.equal(reopened.get(occ).status, "delivered");
});

test("failed push is retryable under the same occurrence and then delivers", async (t) => {
	const file = await dbFile(t);
	// First attempt fails at the platform, everything after succeeds.
	const { manager, sent, calls } = fakeManager({ fail: (n) => n === 1 });
	const { ledger } = useLedger(t, manager, file);
	const occ = scheduledOccurrenceId("task-3", 1_700_000_200_000);

	const failed = await manager.pushToConversation("dt:staff-9", "报告", { occurrenceId: occ });
	assert.equal(failed.ok, false);
	assert.match(failed.error, /平台拒收/);
	assert.equal(ledger.get(occ).status, "failed", "a failed attempt is recorded, not delivered");

	const retried = await manager.pushToConversation("dt:staff-9", "报告", { occurrenceId: occ });
	assert.deepEqual(retried, { ok: true }, "same occurrence retries successfully");
	assert.equal(sent.length, 1);
	assert.equal(calls(), 2, "one failed attempt + one successful retry");
	const row = ledger.get(occ);
	assert.equal(row.status, "delivered");
	assert.equal(row.attempts, 2);

	const third = await manager.pushToConversation("dt:staff-9", "报告", { occurrenceId: occ });
	assert.equal(third.skipped, true, "after success the occurrence is permanently closed");
	assert.equal(calls(), 2);
});

test("restart with a row left mid-flight (attempting) does not re-push on its own; the same occurrence may retry", async (t) => {
	const file = await dbFile(t);
	const occ = scheduledOccurrenceId("task-4", 1_700_000_300_000);

	// Simulate a crash between claim and the platform ACK: the row is attempting.
	{
		const db = new DatabaseSync(file);
		new DeliveryLedger(db).claim(occ, "dt:group:crashed");
		db.close();
	}

	const { manager, sent, calls } = fakeManager();
	const { ledger } = useLedger(t, manager, file);
	assert.equal(calls(), 0, "boot alone pushes nothing (no auto re-push of unknown outcomes)");

	const retried = await manager.pushToConversation("dt:group:crashed", "报告", { occurrenceId: occ });
	assert.equal(retried.ok, true);
	assert.equal(retried.recovered, true, "the caller is told this delivery may be a duplicate");
	assert.equal(sent.length, 1);
	assert.equal(ledger.get(occ).status, "delivered");
	assert.equal(ledger.get(occ).attempts, 2, "the crashed claim counted as attempt 1");
});

test("no occurrence id: pushes are not recorded in the ledger (backward compatible)", async (t) => {
	const file = await dbFile(t);
	const { manager, sent } = fakeManager();
	const { ledger } = useLedger(t, manager, file);

	const a = await manager.pushToConversation("dt:staff-1", "同样的文本");
	const b = await manager.pushToConversation("dt:staff-1", "同样的文本");
	assert.deepEqual(a, { ok: true });
	assert.deepEqual(b, { ok: true });
	assert.equal(b.skipped, undefined, "no skip is reported without an occurrence");
	assert.equal(sent.length, 2, "identical text without an occurrence still sends every time");
	assert.deepEqual(ledger.counts(), { pending: 0, attempting: 0, delivered: 0, failed: 0 }, "ledger untouched");
});

test("without a configured ledger an occurrence id changes nothing (legacy behaviour)", async () => {
	const { manager, sent } = fakeManager();
	// deps empty: no ledger injected
	manager.deps = {};
	const occ = scheduledOccurrenceId("task-5", 1);
	const a = await manager.pushToConversation("dt:staff-1", "x", { occurrenceId: occ });
	const b = await manager.pushToConversation("dt:staff-1", "x", { occurrenceId: occ });
	assert.equal(a.ok && b.ok, true);
	assert.equal(b.skipped, undefined);
	assert.equal(sent.length, 2);
});

test("a different occurrence of the same task/chat still delivers", async (t) => {
	const file = await dbFile(t);
	const { manager, sent } = fakeManager();
	const { ledger } = useLedger(t, manager, file);
	const fireA = scheduledOccurrenceId("task-6", 1_700_000_400_000);
	const fireB = scheduledOccurrenceId("task-6", 1_700_003_600_000); // next day's fire

	await manager.pushToConversation("dt:staff-2", "日报", { occurrenceId: fireA });
	const next = await manager.pushToConversation("dt:staff-2", "日报", { occurrenceId: fireB });
	assert.deepEqual(next, { ok: true });
	assert.equal(sent.length, 2, "recurring runs are never deduped against each other");
	assert.equal(ledger.counts().delivered, 2);
});

test("occurrence id helpers: same identity ⇒ same string, chat ids carry the message id", () => {
	assert.equal(scheduledOccurrenceId("t1", 42), scheduledOccurrenceId("t1", 42));
	assert.notEqual(scheduledOccurrenceId("t1", 42), scheduledOccurrenceId("t1", 43));
	assert.equal(chatOccurrenceId("dingtalk", "msg-7"), chatOccurrenceId("dingtalk", "msg-7"));
	assert.notEqual(chatOccurrenceId("dingtalk", "msg-7"), chatOccurrenceId("dingtalk", "msg-8"));
});

test("ledger bookkeeping never turns a succeeded delivery into a failure (closed ledger)", async (t) => {
	const file = await dbFile(t);
	const { manager, sent } = fakeManager();
	const { ledger } = useLedger(t, manager, file);
	ledger.close(); // e.g. the profile DB closed during install
	const occ = scheduledOccurrenceId("task-7", 1);
	const r = await manager.pushToConversation("dt:staff-3", "hello", { occurrenceId: occ });
	assert.equal(r.ok, true, "delivery still happens");
	assert.equal(sent.length, 1);
});
