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
await build({stdin:{contents:'export { DurableRuntime } from "./src/engine/durable/runtime.ts"; export { HistoryStore } from "./src/db/history-store.ts"; export { NARRATION_GUARD_NOTICE } from "./src/engine/task-planner.ts";',resolveDir:process.cwd(),loader:'ts'},outfile:join(dir,'runtime.mjs'),bundle:true,platform:'node',format:'esm',packages:'external'});
const {DurableRuntime,HistoryStore,NARRATION_GUARD_NOTICE}=await import(pathToFileURL(join(dir,'runtime.mjs')));

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

test('memory anchors survive the durable identity round-trip (context-management P0-1)',async()=>{
 // Field basis: a worker/scheduler round runs on a scratch conversation, but its
 // memory scope must resolve to the ORIGINATING conversation. The anchor rides
 // ctx.actor into the RouteDoc and comes back out of actorContext() for every
 // tool call — including ones after a crash+recovery (persisted, not in-memory).
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);`);
 const history=new HistoryStore(db);
 const faux=fauxProvider();
 const sessions=new Map();
 const session=id=>{ if(!sessions.has(id)) sessions.set(id,new Agent({streamFn:faux.provider.streamSimple,sessionId:id,initialState:{model:faux.provider.getModels()[0],systemPrompt:'test'}})); return sessions.get(id); };
 let toolActor;
 const tools=()=>[{name:'peek_scope',label:'peek',description:'peek',parameters:Type.Object({}),execute:async()=>{return {content:[{type:'text',text:'ok'}]}; }}];
 faux.setResponses([fauxAssistantMessage(fauxToolCall('peek_scope',{}),{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
 const runtime=await DurableRuntime.open({userDataDir:join(dir,'mem-anchor'),history,session,tools,
  stream:(id,opts,messages)=>faux.provider.streamSimple(faux.provider.getModels()[0],{messages},opts),
  withActor:async(id,ctx,text,run)=>{ toolActor=ctx.actor; return run(); },
  onRecovered:async()=>{}});
 try{
  await runtime.send(session('sched:job-1'),'do the thing',{actor:{senderId:'person-a',channel:'scheduler',chatType:'single',memoryConversationId:'dt:group:abc123',memoryChannel:'dingtalk'}});
  assert.ok(toolActor,'the durable tool ran inside withActor');
  assert.equal(toolActor.memoryConversationId,'dt:group:abc123','conversation memory anchor must survive RouteDoc round-trip');
  assert.equal(toolActor.memoryChannel,'dingtalk','memory channel must survive RouteDoc round-trip');
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
 history.appendMessage('conv-notice','assistant',NARRATION_GUARD_NOTICE); // 叙述守卫的如实说明也是投递通知
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
  assert(!tx.includes('已尝试继续执行但模型没有实际动作'),'narration-guard notice must not be imported');
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
 store.appendMessage('c1','assistant',NARRATION_GUARD_NOTICE); // 叙述守卫通知同属投递通知类
 assert.equal(store.sweepSyntheticFallbackReplies(),3);
 assert.equal(store.sweepSyntheticFallbackReplies(),0,'idempotent');
 assert.deepEqual(store.listMessages('c1').map(m=>m.content),['问题','正常答复：已完成'],'user question and real reply survive');
 db.close();
});

// ── abort() must cross background boundaries (field 2026-11-06, the box) ─────
// The box spun at ~18 LLM calls/minute for half an hour: an autonomous/work-window
// run repeated the same two tool calls forever, and every watchdog soft-stop was a
// NO-OP. pi-durable's Conversation.abort(context, options?) skips background nodes
// unless options.background is set, and autonomous runs hang off exactly those
// nodes. The call site had dropped the options argument, so abortConversation
// marked nothing. This pins the message, because the failure is SILENT — abort
// "succeeds", nothing dies, and only the LLM bill reveals it.
test("durable abort passes background:true so watchdog soft-stops actually kill autonomous runs", async () => {
	const { readFile } = await import("node:fs/promises");
	const src = await readFile(join(process.cwd(), "src/engine/durable/runtime.ts"), "utf8");
	// Only REAL call sites: skip comment lines (the incident note quotes the buggy
	// form verbatim, and matching that would make this test lie in the safe direction).
	const calls = src
		.split("\n")
		.filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
		.flatMap((line) => [...line.matchAll(/conv\.abort\(([^)]*)\)/g)].map((m) => m[1]));
	assert.ok(calls.length > 0, "the runtime must abort conversations through conv.abort");
	for (const args of calls) {
		assert.match(args, /background:\s*true/, `conv.abort(${args}) must request background:true — without it every autonomous/work-window run survives the abort`);
		assert.match(args, /^context\s*,/, `conv.abort must receive context FIRST (signature is abort(context, options?))`);
	}
});

// ── A finished run must report its REAL answer (field 2026-11-06, the box) ───
// A run can complete its work and die before its submission settles. Recovery
// then saw no `answer` id and pushed "执行已暂停，请检查恢复状态。" for a task that
// had actually finished ("登录成功" was already in the transcript). The real
// reply lives in the conversation entries; the fallback must read it, and only
// for the LAST assistant entry, skipping synthetic delivery notices.
test("durable result() reports the last real assistant text instead of the paused fallback", async () => {
	const { readFile } = await import("node:fs/promises");
	const src = await readFile(join(process.cwd(), "src/engine/durable/runtime.ts"), "utf8");
	// The no-answer branch must consult the transcript BEFORE the paused fallback.
	const body = src.slice(src.indexOf("private async result("));
	const idxFallback = body.indexOf('"执行已暂停，请检查恢复状态。"');
	const idxTranscriptScan = body.indexOf("for (const item of [...entries.items].reverse())");
	assert.ok(idxFallback > 0 && idxTranscriptScan > 0, "both the scan and the fallback must exist");
	assert.ok(idxTranscriptScan < idxFallback, "the transcript scan must run BEFORE falling back to 执行已暂停");
	// Synthetic notices must be excluded, or the model learns to imitate them.
	assert.match(body.slice(idxTranscriptScan, idxFallback), /isSyntheticFallbackReply/, "synthetic delivery notices must be skipped");
});

// ── Recovery occurrence id must be PER RUN (field 2026-11-06, the box) ───────
// The push ledger dedupes on occurrenceId. `durable:<convId>:answer` is constant
// for every turn of a conversation, so the recovery answer of a chat's SECOND
// message hit the first message's row and was dropped as "occurrence already
// delivered" — the bot answered once and then went mute in that chat. The log
// proved it: "delivery skipped (occurrence already delivered):
// durable:278410:answer → dt:group:..." twice for two different runs.
test("recovered delivery occurrence id varies per submission", async () => {
	const { readFile } = await import("node:fs/promises");
	const src = await readFile(join(process.cwd(), "src/engine/durable/runtime.ts"), "utf8");
	const call = src.match(/this\.opts\.onRecovered\(([^;]*)\);/);
	assert.ok(call, "the recovery push must go through onRecovered");
	const args = call[1];
	assert.match(args, /state\?\.id|\$\{state/, `the occurrence id must include the per-run submission id, got: ${args}`);
	assert.doesNotMatch(args, /`durable:\$\{conv\.id\}:answer`/, "a constant per-conversation key would dedupe every later turn away");
});

// ── Narration guard (field 2026-11-09) ──────────────────────────────────────
// 「继续 登录生产后台管理」 was answered with pure process narration and ZERO
// tool calls; the run settled done and nothing executed ("先检查一下当前环境
// 可用的工具" then silence). A task-shaped zero-tool turn must force exactly
// ONE continue; if the continuation still takes no action, the delivered text
// carries the honest notice. Never a loop (flood-loop lesson).

/** Task-shaped entry message: 登录 (task verb) + 然后 (multi-step evidence). */
const NARRATION_TASK = '登录生产后台管理系统，然后检查环境并验证登录状态';

function narrationSetup(t, subdir, responses, tools = () => []) {
	const history = makeHistory(t);
	const faux = fauxProvider();
	const sessions = new Map();
	const session = id => { if (!sessions.has(id)) sessions.set(id, new Agent({streamFn:faux.provider.streamSimple,sessionId:id,initialState:{model:faux.provider.getModels()[0],systemPrompt:'test'}})); return sessions.get(id); };
	let modelCalls = 0;
	faux.setResponses(responses);
	const opened = DurableRuntime.open({userDataDir:join(dir,subdir),history,session,tools,
		stream:(id,opts,messages)=>{modelCalls++;return faux.provider.streamSimple(faux.provider.getModels()[0],{messages},opts);},
		withActor:async(id,ctx,text,run)=>run(),onRecovered:async()=>{}});
	return { history, session, opened, calls: () => modelCalls };
}

test('narration guard: zero-tool task turn forces ONE nudge; still zero tools → new answer + honest notice', async t => {
	const { history, session, opened, calls } = narrationSetup(t, 'narrate-once', [
		fauxAssistantMessage('我来尝试登录生产后台管理。先检查一下当前环境可用的工具。'),
		fauxAssistantMessage('我需要先了解当前环境，然后再继续。'),
	]);
	const runtime = await opened;
	try {
		const result = await runtime.send(session('conv-narrate-once'), NARRATION_TASK);
		assert.ok(result.reply.startsWith('我需要先了解当前环境'), 'the continuation answer replaces the first narration');
		assert.ok(result.reply.endsWith(NARRATION_GUARD_NOTICE), 'a continuation with zero tool calls carries the honest notice — a success claim without tool evidence is exactly the field bug');
		assert.equal(calls(), 2, 'exactly one nudge even when the continuation narrates again — never a loop');
		assert.deepEqual(history.listMessages('conv-narrate-once').filter(m=>m.role==='assistant').map(m=>m.content), [result.reply], 'only the final delivered text is projected into history');
	} finally { await runtime.close(); }
});

test('narration guard: a continuation that USES tools delivers without the notice (per-run evidence)', async t => {
	const tools = () => [{name:'get_current_time',label:'clock',description:'clock',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'2026-11-09'}]})}];
	const { session, opened, calls } = narrationSetup(t, 'narrate-then-tool', [
		fauxAssistantMessage('我来尝试登录，先检查当前可用的工具。'),
		fauxAssistantMessage(fauxToolCall('get_current_time',{}),{stopReason:'toolUse'}),
		fauxAssistantMessage('登录完成，时间已核对。'),
	], tools);
	const runtime = await opened;
	try {
		const result = await runtime.send(session('conv-narrate-then-tool'), NARRATION_TASK);
		assert.equal(result.reply, '登录完成，时间已核对。');
		assert.ok(!result.reply.includes(NARRATION_GUARD_NOTICE), 'the continuation earned tool evidence — no notice');
		assert.equal(calls(), 3, 'first round + continuation tool round + final answer, nothing more');
	} finally { await runtime.close(); }
});

test('narration guard: a turn that already used tools is never continued', async t => {
	let toolCalls = 0;
	const tools = () => [{name:'get_current_time',label:'clock',description:'clock',parameters:Type.Object({}),execute:async()=>{toolCalls++;return {content:[{type:'text',text:'2026-11-09'}]};}}];
	const { session, opened, calls } = narrationSetup(t, 'narrate-with-tools', [
		fauxAssistantMessage(fauxToolCall('get_current_time',{}),{stopReason:'toolUse'}),
		fauxAssistantMessage('登录完成，时间已核对。'),
	], tools);
	const runtime = await opened;
	try {
		const result = await runtime.send(session('conv-narrate-with-tools'), NARRATION_TASK);
		assert.equal(result.reply, '登录完成，时间已核对。');
		assert.equal(toolCalls, 1);
		assert.equal(calls(), 2, 'tool evidence in the first round must not trigger the guard');
	} finally { await runtime.close(); }
});

test('narration guard: a bare single-step command is not task-shaped — no forced continue', async t => {
	const { session, opened, calls } = narrationSetup(t, 'narrate-not-task', [
		fauxAssistantMessage('登录入口在设置页。'),
	]);
	const runtime = await opened;
	try {
		// looksLikeTask("登录") is false (single verb, no multi-step evidence):
		// the guard must not fire on quick commands/questions.
		const result = await runtime.send(session('conv-narrate-not-task'), '登录');
		assert.equal(result.reply, '登录入口在设置页。');
		assert.equal(calls(), 1, 'no continuation for a non-task-shaped message');
	} finally { await runtime.close(); }
});
