import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
const root = "/tmp/ve-merge-0198";
const tmp = await mkdtemp(join(root, "node_modules/.probe-gate-"));
after(() => rm(tmp, { recursive: true, force: true }));
buildSync({ stdin: { contents: 'export * from "./src/scheduler/work-service.ts"; export * from "./src/db/work-item-store.ts"; export * from "./src/engine/engine.ts";', resolveDir: root, loader: "ts" }, outfile: join(tmp, "s.mjs"), bundle: true, platform: "node", format: "esm", packages: "external" });
const mod = await import(pathToFileURL(join(tmp, "s.mjs")));
const { WorkService, WorkItemStore } = mod;
const schema = (await readFile(join(root, "src/db/sqlite.ts"), "utf8")).match(/CREATE TABLE IF NOT EXISTS work_items \([\s\S]*?\);/)[0];
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

function Clock() { this.time = new Date("2026-10-01T10:00:00").getTime(); this.timers = new Map(); this.seq = 0; this.now = () => this.time;
  this.setTimeout = (fn, ms) => { const id = ++this.seq; this.timers.set(id, { fn, at: this.time + ms }); return id; };
  this.clearTimeout = id => this.timers.delete(id);
  this.advance = async (ms) => { const end = this.time + ms; for(;;){ const n=[...this.timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!n) break; this.time=n[1].at; this.timers.delete(n[0]); n[1].fn(); await flush(); } this.time=end; await flush(); };
}

function mk(t, opts, sendImpl) {
  const db = new DatabaseSync(":memory:"); db.exec(schema);
  if (!db.prepare("PRAGMA table_info(work_items)").all().some(c=>c.name==="answer")) db.exec("ALTER TABLE work_items ADD COLUMN answer TEXT");
  const clock = new Clock();
  const h = { db, clock, sends: [], pushes: [], counter: new Map() };
  const store = new WorkItemStore({ prepare: sql => db.prepare(sql) });
  // REAL engine-like counter: keyed by cid, reset by clearRunawayStops only.
  h.service = new WorkService({ store, clock, budget: { maxTurns: 3, maxMinutes: 30 },
    isAdmin: id => id === "admin",
    open: (item, cid) => ({ id: item.id, cid, abort: () => {} }),
    send: async (session, message) => { h.sends.push(message); return sendImpl(h, session, message); },
    release: async () => {}, push: async (cid, text) => { h.pushes.push({cid,text}); },
    learn: () => {}, reclaimBackground: () => {}, onError: e => { console.log("ERR", e.message); },
    runawayCount: (cid) => h.counter.get(cid) ?? 0,
    clearRunawayStops: (cid) => { h.counter.delete(cid); },
  });
  h.store = store;
  h.create = (extra={}) => store.create({ title: "T", goal: "G", status: "queued", createdBy: "admin", originConversation: "dt:src", ...extra });
  t.after(async () => { await h.service.stop(); await h.service.whenIdle(); await flush(); db.close(); });
  return h;
}

test("PROBE A: transient soft-stop then a later healthy window — is it demoted forever?", async (t) => {
  const h = mk(t, {}, () => ({ reply: "进度\n[[NEXT_CHECK]]: 30m" }));
  const item = h.create();
  await h.service.start();
  await flush(); await h.service.whenIdle();
  const cid = `work:${item.id}`;
  console.log("A: after window1 status=", h.store.get(item.id).status, "counter=", h.counter.get(cid));
  // window2: simulate a transient watchdog soft-stop that was NOT gate-demoted
  // (e.g. the watchdog fired on the LAST tool of a window that then closed normally)
  h.counter.set(cid, 1);
  h.clock.time += 31 * 60_000; // window expires
  await h.clock.advance(31 * 60_000);
  await h.service.whenIdle();
  console.log("A: after window2 status=", h.store.get(item.id).status, "q=", (h.store.get(item.id).question||"").slice(0,40), "counter=", h.counter.get(cid));
  assert.ok(true);
});

test("PROBE B: TIMEOUT defer with a stale watchdog counter — legit defer demoted?", async (t) => {
  const h = mk(t, {}, () => ({ reply: "进度\n[[NEXT_CHECK]]: 30m" }));
  const item = h.create();
  const cid = `work:${item.id}`;
  h.counter.set(cid, 1); // a soft-stop happened at some earlier point, never reset
  await h.service.start();
  // make the window hit its wall-clock cap: send never returns
  h.service.opts.send = async () => new Promise(() => {});
  await flush();
  h.clock.time += 31 * 60_000;
  await h.clock.advance(31 * 60_000);
  await h.service.whenIdle();
  const row = h.store.get(item.id);
  console.log("B: TIMEOUT-defer outcome status=", row.status, "next=", row.next_check_at, "q=", (row.question||"").slice(0,60));
  assert.ok(true);
});
