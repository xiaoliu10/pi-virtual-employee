import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
const root = "/tmp/ve-merge-0198";
const tmp = await mkdtemp(join(root, "node_modules/.probe3-"));
after(() => rm(tmp, { recursive: true, force: true }));
buildSync({ stdin: { contents: 'export * from "./src/scheduler/work-service.ts"; export * from "./src/db/work-item-store.ts";', resolveDir: root, loader: "ts" }, outfile: join(tmp, "s.mjs"), bundle: true, platform: "node", format: "esm", packages: "external" });
const { WorkService, WorkItemStore } = await import(pathToFileURL(join(tmp, "s.mjs")));
const schema = (await readFile(join(root, "src/db/sqlite.ts"), "utf8")).match(/CREATE TABLE IF NOT EXISTS work_items \([\s\S]*?\);/)[0];
const flush = async () => { for (let i=0;i<6;i++) await new Promise(r=>setImmediate(r)); };
function Clock(){ this.time=new Date("2026-10-01T10:00:00").getTime(); this.timers=new Map(); this.seq=0; this.now=()=>this.time;
 this.setTimeout=(fn,ms)=>{const id=++this.seq;this.timers.set(id,{fn,at:this.time+ms});return id;}; this.clearTimeout=id=>this.timers.delete(id);
 this.advance=async ms=>{const end=this.time+ms;for(;;){const n=[...this.timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!n)break;this.time=n[1].at;this.timers.delete(n[0]);n[1].fn();await flush();}this.time=end;await flush();};}
function mk(t,sendImpl){
 const db=new DatabaseSync(":memory:"); db.exec(schema);
 if(!db.prepare("PRAGMA table_info(work_items)").all().some(c=>c.name==="answer")) db.exec("ALTER TABLE work_items ADD COLUMN answer TEXT");
 const clock=new Clock(); const store=new WorkItemStore({prepare:s=>db.prepare(s)}); const h={db,clock,store,counter:new Map(),log:[]};
 const svc=new WorkService({store,clock,budget:{maxTurns:3,maxMinutes:30},isAdmin:id=>id==="admin",
  open:(item,cid)=>({id:item.id,cid,abort:()=>{}}), send:async(s,m)=>{h.log.push("send");return sendImpl(h,s,m);},
  release:async()=>{},push:async(c,t)=>{h.log.push("push:"+t.slice(0,26));},learn:()=>{},reclaimBackground:()=>{},onError:e=>h.log.push("onError:"+e.message.slice(0,40)),
  runawayCount:cid=>h.counter.get(cid)??0, clearRunawayStops:cid=>{h.log.push("CLEAR");h.counter.delete(cid);}});
 h.svc=svc; h.create=(e={})=>store.create({title:"T",goal:"G",status:"queued",createdBy:"admin",originConversation:"dt:src",...e});
 t.after(async()=>{await svc.stop();await svc.whenIdle();await flush();db.close();}); return h;}

test("PROBE F: REALISTIC soft-stop — engine aborts turn mid-window, then send THROWS/returns error. Does the gate ever run?", async t=>{
 let n=0; const h=mk(t,(hh)=>{ n++;
   if(n===1){ hh.counter.set(`work:${hh.itemId}`,1); return { reply:"", error:"durable submission unanswered" }; } // watchdog killed the turn -> error
   return { reply:"进度\n[[NEXT_CHECK]]: 30m" }; });
 // itemId not known yet; use closure trick
 const item=h.create(); h.itemId=item.id;
 h.log.push("cid=work:"+item.id);
 await h.svc.start(); await flush(); await h.svc.whenIdle();
 const row=h.store.get(item.id);
 console.log("F: status=",row.status,"q=",(row.question||"").slice(0,50));
 console.log("F: log=",h.log.join(" | "));
 assert.ok(true);
});
