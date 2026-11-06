import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
const root = "/tmp/ve-merge-0198";
const tmp = await mkdtemp(join(root, "node_modules/.probe2-"));
after(() => rm(tmp, { recursive: true, force: true }));
buildSync({ stdin: { contents: 'export * from "./src/scheduler/work-service.ts"; export * from "./src/db/work-item-store.ts";', resolveDir: root, loader: "ts" }, outfile: join(tmp, "s.mjs"), bundle: true, platform: "node", format: "esm", packages: "external" });
const { WorkService, WorkItemStore } = await import(pathToFileURL(join(tmp, "s.mjs")));
const schema = (await readFile(join(root, "src/db/sqlite.ts"), "utf8")).match(/CREATE TABLE IF NOT EXISTS work_items \([\s\S]*?\);/)[0];
const flush = async () => { for (let i=0;i<6;i++) await new Promise(r=>setImmediate(r)); };
function Clock(){ this.time=new Date("2026-10-01T10:00:00").getTime(); this.timers=new Map(); this.seq=0; this.now=()=>this.time;
 this.setTimeout=(fn,ms)=>{const id=++this.seq;this.timers.set(id,{fn,at:this.time+ms});return id;}; this.clearTimeout=id=>this.timers.delete(id);
 this.advance=async ms=>{const end=this.time+ms;for(;;){const n=[...this.timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!n)break;this.time=n[1].at;this.timers.delete(n[0]);n[1].fn();await flush();}this.time=end;await flush();};}

function mk(t, sendImpl){
 const db=new DatabaseSync(":memory:"); db.exec(schema);
 if(!db.prepare("PRAGMA table_info(work_items)").all().some(c=>c.name==="answer")) db.exec("ALTER TABLE work_items ADD COLUMN answer TEXT");
 const clock=new Clock(); const store=new WorkItemStore({prepare:s=>db.prepare(s)});
 const h={db,clock,store,counter:new Map(),log:[]};
 const svc=new WorkService({store,clock,budget:{maxTurns:3,maxMinutes:30},isAdmin:id=>id==="admin",
  open:(item,cid)=>({id:item.id,cid,abort:()=>{}}),
  send:async(s,m)=>{h.log.push("send:"+m.slice(0,20));return sendImpl(h,s,m);},
  release:async()=>{},push:async(cid,text)=>{h.log.push("push:"+text.slice(0,30));},
  learn:()=>{},reclaimBackground:()=>{},onError:e=>console.log("ERR",e.message),
  runawayCount:cid=>h.counter.get(cid)??0,
  clearRunawayStops:cid=>{h.log.push("CLEAR:"+cid);h.counter.delete(cid);}});
 h.svc=svc; h.create=(e={})=>store.create({title:"T",goal:"G",status:"queued",createdBy:"admin",originConversation:"dt:src",...e});
 t.after(async()=>{await svc.stop();await svc.whenIdle();await flush();db.close();});
 return h;
}

test("PROBE C: does a scheduled (non-gate) close ever clear the counter? normal NEXT_CHECK", async t=>{
 const h=mk(t,()=>({reply:"进度\n[[NEXT_CHECK]]: 30m"}));
 const item=h.create(); const cid=`work:${item.id}`;
 h.counter.set(cid,3); // stale counter from long ago (e.g. planted before this window)
 await h.svc.start(); await flush(); await h.svc.whenIdle();
 console.log("C: status=",h.store.get(item.id).status,"counter-after-window=",h.counter.get(cid),"log=",h.log.join(" | "));
 assert.ok(true);
});

test("PROBE D: order — gate demotes -> CLEAR still called? (does the reset clause leak?)", async t=>{
 const h=mk(t,()=>({reply:"进度\n[[NEXT_CHECK]]: 30m"}));
 const item=h.create(); const cid=`work:${item.id}`;
 h.counter.set(cid,1);
 await h.svc.start(); await flush(); await h.svc.whenIdle();
 console.log("D: status=",h.store.get(item.id).status,"counter=",h.counter.get(cid),"log=",h.log.join(" | "));
 assert.ok(true);
});

test("PROBE E: SECOND strike after gate demotion + admin resume", async t=>{
 const h=mk(t,()=>({reply:"进度\n[[NEXT_CHECK]]: 30m"}));
 const item=h.create(); const cid=`work:${item.id}`;
 h.counter.set(cid,1);
 await h.svc.start(); await flush(); await h.svc.whenIdle();
 console.log("E1: status=",h.store.get(item.id).status,"counter=",h.counter.get(cid));
 // admin resumes
 h.store.setStatus(item.id,"scheduled","",h.clock.now()+1000,"resume");
 h.counter.set(cid,2); // watchdog kills again
 await h.clock.advance(2000); await h.svc.whenIdle();
 console.log("E2: status=",h.store.get(item.id).status,"q=",(h.store.get(item.id).question||"").slice(0,50),"counter=",h.counter.get(cid));
 assert.ok(true);
});
