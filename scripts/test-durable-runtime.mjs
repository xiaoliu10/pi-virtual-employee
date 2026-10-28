import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { Agent } from '@earendil-works/pi-agent-core';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import { Harness } from '@earendil-works/pi-durable';
const dir=await mkdtemp(join(process.cwd(),'node_modules/.durable-runtime-'));
after(()=>rm(dir,{recursive:true,force:true}));
await build({stdin:{contents:'export { DurableRuntime } from "./src/engine/durable/runtime.ts"; export { HistoryStore } from "./src/db/history-store.ts";',resolveDir:process.cwd(),loader:'ts'},outfile:join(dir,'runtime.mjs'),bundle:true,platform:'node',format:'esm',packages:'external'});
const {DurableRuntime,HistoryStore}=await import(pathToFileURL(join(dir,'runtime.mjs')));
test('VE durable runtime executes a real adapted tool and projects one answer',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);`);
 const history=new HistoryStore(db);
 const faux=fauxProvider();
 const sessions=new Map();
 const session=id=>{ if(!sessions.has(id)) sessions.set(id,new Agent({streamFn:faux.provider.streamSimple,sessionId:id,initialState:{model:faux.provider.getModels()[0],systemPrompt:'test'}})); return sessions.get(id); };
 let calls=0,actor;
 const tools=()=>[{name:'get_current_time',label:'clock',description:'clock',parameters:Type.Object({}),execute:async(callId,args,signal)=>{ calls++;assert.ok(callId);return {content:[{type:'text',text:'2026-10-28'}]}; }}];
 faux.setResponses([fauxAssistantMessage(fauxToolCall('get_current_time',{}),{stopReason:'toolUse'}),fauxAssistantMessage('done today')]);
 const runtime=await DurableRuntime.open({userDataDir:dir,history,session,tools,stream:(id,opts,messages)=>faux.provider.streamSimple(faux.provider.getModels()[0],{messages},opts),withActor:async(id,ctx,text,run)=>{actor=ctx.actor;return run();},onRecovered:async()=>{}});
 try{
 const result=await runtime.send(session('dingtalk:test'),'what day?',{actor:{senderId:'person-a',channel:'dingtalk',chatType:'single'}});
 assert.equal(result.reply,'done today');assert.equal(calls,1);assert.equal(actor.senderId,'person-a');
 assert.deepEqual(history.listMessages('dingtalk:test').map(x=>x.role),['user','assistant']);
 }finally{await runtime.close();db.close();}
});

test('failed startup scan closes its host before rejecting and never resumes work', async () => {
 const originalOpen = Harness.open;
 let closed = 0, resumed = 0;
 const faux = fauxProvider();
 const session = id => new Agent({streamFn:faux.provider.streamSimple,sessionId:id,initialState:{model:faux.provider.getModels()[0],systemPrompt:'test'}});
 const opts = {userDataDir:join(dir,'failed-open'),history:{},session,tools:()=>[],stream:()=>{throw new Error('must not call model');},withActor:async(id,ctx,text,run)=>run(),onRecovered:async()=>{throw new Error('must not recover');}};
 Harness.open = async (storage, ...args) => {
  const host = await originalOpen.call(Harness, storage, ...args);
  const close = host.close.bind(host), resume = host.resume.bind(host);
  host.close = async (...closeArgs) => {await close(...closeArgs);closed++;};
  host.resume = () => {resumed++;return resume();};
  storage.scanSubmissions = async () => {throw new Error('injected startup scan failure');};
  return host;
 };
 try {
  await assert.rejects(()=>DurableRuntime.open(opts), /injected startup scan failure/);
  assert.equal(closed,1,'failed-open host must close before open rejects');
  assert.equal(resumed,0,'a failed scan must never start scheduling');
 } finally {Harness.open = originalOpen;}
 const reopened = await DurableRuntime.open(opts);
 await reopened.close();
});
