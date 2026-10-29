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

function makeHistory(t){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);`);
 const history=new HistoryStore(db);
 t.after(()=>db.close());
 return history;
}
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

test('existing-conversation history without usage must not fault the generation (box 5/5 repro)', async t => {
 const history = makeHistory(t);
 // 存量对话：assistant 历史消息不带 usage（history 表本来就不存）——正是盒子上的形态
 history.ensureConversation('conv-legacy-history','旧对话');
 history.appendMessage('conv-legacy-history','user','上一轮的问题');
 history.appendMessage('conv-legacy-history','assistant','上一轮的回答');
 const faux=fauxProvider();
 const sessions=new Map();
 const session=id=>{ if(!sessions.has(id)) sessions.set(id,new Agent({streamFn:faux.provider.streamSimple,sessionId:id,initialState:{model:faux.provider.getModels()[0],systemPrompt:'test'}})); return sessions.get(id); };
 const tools=()=>[];
 faux.setResponses([fauxAssistantMessage('新的回答')]);
 const runtime=await DurableRuntime.open({userDataDir:dir,history,session,tools,stream:(id,opts,messages)=>faux.provider.streamSimple(faux.provider.getModels()[0],{messages},opts),withActor:async(id,ctx,text,run)=>run(),onRecovered:async()=>{}});
 try{
  const result=await runtime.send(session('conv-legacy-history'),'新消息');
  assert.equal(result.reply,'新的回答');
  assert.equal(result.error,undefined,'submission must reach done, not the unanswered fallback');
 }finally{await runtime.close();}
});

test('provider response without usage is normalized to zero-spend instead of faulting', async t => { const history = makeHistory(t);
 const faux=fauxProvider();
 const sessions=new Map();
 const session=id=>{ if(!sessions.has(id)) sessions.set(id,new Agent({streamFn:faux.provider.streamSimple,sessionId:id,initialState:{model:faux.provider.getModels()[0],systemPrompt:'test'}})); return sessions.get(id); };
 const tools=()=>[];
 // 模拟网关忽略 include_usage：剥掉响应里的 usage（openai-completions 在无 usage chunk 时就是 undefined）
 const stripped = async (model,opts,messages)=>{ const response = await faux.provider.streamSimple(model,{messages},opts); const outcome = await response.result(); const {usage, ...rest} = outcome; return { async *[Symbol.asyncIterator](){}, result: async () => rest }; };
 faux.setResponses([fauxAssistantMessage('无用量回答')]);
 const runtime=await DurableRuntime.open({userDataDir:dir,history,session,tools,stream:stripped,withActor:async(id,ctx,text,run)=>run(),onRecovered:async()=>{}});
 try{
  const result=await runtime.send(session('conv-no-usage'),'你好');
  assert.equal(result.reply,'无用量回答');
  assert.equal(result.error,undefined);
 }finally{await runtime.close();}
});

test('empty completion is re-asked once, then delivered honestly instead of the paused fallback', async t => {
 const history=makeHistory(t);
 const faux=fauxProvider();
 const sessions=new Map();
 const session=id=>{ if(!sessions.has(id)) sessions.set(id,new Agent({streamFn:faux.provider.streamSimple,sessionId:id,initialState:{model:faux.provider.getModels()[0],systemPrompt:'test'}})); return sessions.get(id); };
 const tools=()=>[];
 // 第一轮空 completion（盒子形态：done, output=1, content=[]）；第二轮正常
 faux.setResponses([fauxAssistantMessage('',{stopReason:'stop'}),fauxAssistantMessage('重问后的答复')]);
 const runtime=await DurableRuntime.open({userDataDir:dir,history,session,tools,stream:(id,opts,messages)=>faux.provider.streamSimple(faux.provider.getModels()[0],{messages},opts),withActor:async(id,ctx,text,run)=>run(),onRecovered:async()=>{}});
 try{
  const result=await runtime.send(session('conv-empty-then-ok'),'你好');
  assert.equal(result.reply,'重问后的答复','settle-gate must re-ask an empty completion before delivering');
  assert.equal(result.error,undefined);
 }finally{await runtime.close();}
});

test('a second empty completion settles with the honest empty-answer notice', async t => {
 const history=makeHistory(t);
 const faux=fauxProvider();
 const sessions=new Map();
 const session=id=>{ if(!sessions.has(id)) sessions.set(id,new Agent({streamFn:faux.provider.streamSimple,sessionId:id,initialState:{model:faux.provider.getModels()[0],systemPrompt:'test'}})); return sessions.get(id); };
 const tools=()=>[];
 faux.setResponses([fauxAssistantMessage('',{stopReason:'stop'}),fauxAssistantMessage('',{stopReason:'stop'})]);
 const runtime=await DurableRuntime.open({userDataDir:dir,history,session,tools,stream:(id,opts,messages)=>faux.provider.streamSimple(faux.provider.getModels()[0],{messages},opts),withActor:async(id,ctx,text,run)=>run(),onRecovered:async()=>{}});
 try{
  const result=await runtime.send(session('conv-empty-twice'),'你好');
  assert.match(result.reply,/模型没有返回任何内容/,'must not report the paused/interrupted diagnosis for a finished run');
  assert.equal(result.error,'durable empty answer');
 }finally{await runtime.close();}
});

test('persisted fallback notices are not replayed into the durable transcript', async t => {
 const history=makeHistory(t);
 history.ensureConversation('conv-notice','带通知的会话');
 history.appendMessage('conv-notice','user','帮我查对账');
 history.appendMessage('conv-notice','assistant','执行已暂停，请检查恢复状态。'); // 历史里的投递通知
 history.appendMessage('conv-notice','assistant','本轮执行已结束，但模型没有返回任何内容（网关可能中断了响应）。请重新描述你的需求，我会再执行一次。');
 const faux=fauxProvider();
 const sessions=new Map();
 const session=id=>{ if(!sessions.has(id)) sessions.set(id,new Agent({streamFn:faux.provider.streamSimple,sessionId:id,initialState:{model:faux.provider.getModels()[0],systemPrompt:'test'}})); return sessions.get(id); };
 const tools=()=>[];
 faux.setResponses([fauxAssistantMessage('对账结果：3 条异常')]);
 const runtime=await DurableRuntime.open({userDataDir:dir,history,session,tools,stream:(id,opts,messages)=>{
  // transcript 里不得出现投递通知（否则模型会模仿）
  const tx=JSON.stringify(messages);
  assert(!tx.includes('执行已暂停，请检查恢复状态'),'fallback notice must not be imported');
  assert(!tx.includes('模型没有返回任何内容'),'empty-answer notice must not be imported');
  assert(tx.includes('帮我查对账'),'the user question must stay');
  return faux.provider.streamSimple(faux.provider.getModels()[0],{messages},opts);
 },withActor:async(id,ctx,text,run)=>run(),onRecovered:async()=>{}});
 try{
  const result=await runtime.send(session('conv-notice'),'再查一次');
  assert.equal(result.reply,'对账结果：3 条异常');
  assert.ok(!result.reply.includes('执行已暂停'),'the model must not imitate the swept notice');
 }finally{await runtime.close();}
});

test('sweepSyntheticFallbackReplies removes persisted notices idempotently', t => {
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);`);
 const store=new HistoryStore(db);
 store.ensureConversation('c1','会话一');
 store.appendMessage('c1','user','问题');
 store.appendMessage('c1','assistant','执行已暂停，请检查恢复状态。');
 store.appendMessage('c1','assistant','正常答复：已完成');
 store.appendMessage('c1','assistant','\n\n执行已暂停，请检查恢复状态。'); // 带空白的同一句
 assert.equal(store.sweepSyntheticFallbackReplies(),2);
 assert.equal(store.sweepSyntheticFallbackReplies(),0,'idempotent');
 assert.deepEqual(store.listMessages('c1').map(m=>m.content),['问题','正常答复：已完成'],'user question and real reply survive');
 db.close();
});
