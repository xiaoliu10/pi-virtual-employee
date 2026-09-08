/** Isolated MCP subprocess integration tests; never inspect or control the real desktop. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = await mkdtemp(join(root, "node_modules/.computer-test-"));
after(() => rm(work, { recursive: true, force: true }));
await build({ stdin: { contents: `
export { ConfigStore } from './src/db/config-store.ts';
export { ComputerService, appAllowed } from './src/computer/computer-service.ts';
export { createComputerTools } from './src/engine/tools/computer.ts';
export { createManageSettingsTool } from './src/engine/tools/settings.ts';
export { createManageCapabilitiesTool } from './src/engine/tools/capabilities.ts';
export { verifyDriverArchive } from './src/computer/driver-install.ts';
`, resolveDir: root, loader: "ts" }, outfile: join(work, "bundle.mjs"), bundle: true, platform: "node", format: "esm", packages: "external" });
const { ConfigStore, ComputerService, appAllowed, createComputerTools, createManageSettingsTool, createManageCapabilitiesTool, verifyDriverArchive } = await import(pathToFileURL(join(work, "bundle.mjs")));

async function fixture(t, { windows = false } = {}) {
 const dir = await mkdtemp(join(work, "case-"));
 const log = join(dir, "calls.jsonl");
 const driver = join(dir, process.platform === "win32" ? "cua-driver.cmd" : "cua-driver.mjs");
 const serverFile = process.platform === "win32" ? join(dir, "fixture-server.mjs") : driver;
 await writeFile(serverFile, `#!/usr/bin/env node
import { Server } from '${pathToFileURL(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"))}';
import { StdioServerTransport } from '${pathToFileURL(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))}';
import { ListToolsRequestSchema, CallToolRequestSchema } from '${pathToFileURL(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"))}';
import { appendFileSync } from 'node:fs';
const tools = ['list_apps','list_windows','get_window_state','launch_app','click','double_click','right_click','type_text','press_key','hotkey','scroll','drag','set_value','end_session','set_config','clipboard_read'];
const server = new Server({name:'fixture-cua',version:'0.24.0'}, {capabilities:{tools:{}}});
// Window/input shapes follow the real 0.24.0 MCP tools/list contract. In
// particular set_value has no delivery_mode, while drag requires from/to.
const target=['pid','window_id','element_index','element_token','snapshot_id','session'];
const fields={
 list_apps:[],list_windows:['pid','on_screen_only'],
 get_window_state:[...target,'include_screenshot','include_accessibility_tree','max_elements','query'],
 launch_app:${JSON.stringify(windows ? ['name','bundle_id','aumid','path','launch_path'] : ['name','bundle_id'])},
 click:[...target,'delivery_mode','x','y'],double_click:[...target,'delivery_mode','x','y'],right_click:[...target,'delivery_mode','x','y'],
 type_text:[...target,'delivery_mode','text','delay_ms'],press_key:[...target,'delivery_mode','key','modifiers'],hotkey:[...target,'delivery_mode','keys'],
 scroll:[...target,'delivery_mode','direction','amount','by','x','y'],
 drag:['pid','window_id','session','delivery_mode','from_x','from_y','to_x','to_y','duration_ms','steps','button','modifier'],
 set_value:[...target,'value'],end_session:['session']
};
const required={get_window_state:['pid','window_id'],type_text:['text'],press_key:['key'],hotkey:['keys'],scroll:['direction'],drag:['from_x','from_y','to_x','to_y'],set_value:['pid','value']};
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:tools.map(name=>({name,description:name,inputSchema:{type:'object',properties:Object.fromEntries((fields[name]??[]).map(k=>[k,{}])),required:required[name]??[],additionalProperties:false}}))}));
server.setRequestHandler(CallToolRequestSchema, async request=>{
 const { name, arguments: args={} }=request.params;
 appendFileSync(${JSON.stringify(log)}, JSON.stringify({name,args,at:Date.now()})+'\\n');
 if(args.text==='slow') await new Promise(resolve=>setTimeout(resolve,1400));
 if(args.text==='brief') await new Promise(resolve=>setTimeout(resolve,180));
 let data={ok:true};
 if(name==='list_apps') data={apps:${JSON.stringify(windows ? [
  {pid:111,name:'Notepad',bundle_id:'notepad.exe',launch_path:'"C:\\Windows\\System32\\notepad.exe" /A'},
  {pid:333,name:'Calculator',bundle_id:'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',launch_path:'shell:appsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'},
 ] : [{pid:111,name:'Notepad',exe_name:'notepad.exe'},{pid:222,name:'Private App',exe_name:'private.exe'}])}};
 if(name==='list_windows') data={windows:[{pid:111,window_id:10,title:'Allowed'},{pid:222,window_id:20,title:'Private'}]};
 if(name==='get_window_state') data={snapshot_id:'snap-1',elements:[{element_index:1,element_token:'token-1',role:'input',label:'Editor'}]};
 return {content:[{type:'text',text:'ok'},...(name==='get_window_state'?[{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='}]:[])],structuredContent:data};
});
await server.connect(new StdioServerTransport());
`);
 if (process.platform === "win32") await writeFile(driver, '@"'+process.execPath+'" "'+serverFile+'"\r\n');
 else await chmod(driver, 0o755);
 const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
 const config = new ConfigStore(db);
 // Give a cold Node + SDK subprocess enough startup time under concurrent CI
 // load; action timeout tests configure their own deliberately short limit.
 config.update({security:{adminStaffIds:["admin"]},computer:{enabled:true,driverPath:driver,allowedApps:["notepad.exe"],actionTimeoutSec:2,connectTimeoutSec:10}});
 const service = new ComputerService(config, dir);
 let actor = {channel:"dingtalk",chatType:"single",senderId:"admin",text:"请操作记事本"};
 const deps = {config,computer:service,conversationId:"one",resolveActor:()=>actor,onConfigChanged:()=>{},isVisionModel:()=>true,screenshotDir:async()=>dir};
 const [manage,tool] = createComputerTools(deps);
 t.after(async()=>{ await service.close(); db.close(); });
 const calls = async()=>{try{return (await readFile(log,"utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);}catch{return [];}};
 return {config,service,dir,driver,deps,tool,manage,calls,actor,
  run:(action,args={},owner="one",signal)=>service.execute(action,args,owner,signal),
  state:(owner="one")=>service.execute("get_window_state",{pid:111,window_id:10},owner),
  setActor:value=>{actor=value;},
 };
}

test("config migration, normalization, persistence and imports preserve desktop settings", async t=>{
 const f=await fixture(t);
 f.config.update({computer:{enabled:'yes',actionTimeoutSec:-1,connectTimeoutSec:0,allowedApps:['notepad.exe','notepad.exe','',2],sessionTimeoutSec:0}});
 assert.deepEqual(f.config.all().computer.allowedApps,['notepad.exe']);
 assert.equal(f.config.all().computer.enabled,false); assert.equal(f.config.all().computer.actionTimeoutSec,120); assert.equal(f.config.all().computer.connectTimeoutSec,1);
 const exported=f.config.all(); f.config.replaceAll({}); assert.equal(f.config.all().computer.enabled,false); assert.equal(f.config.all().computer.sessionTimeoutSec,0);
 f.config.replaceAll(exported); assert.equal(f.config.all().computer.driverPath,f.driver);
});

test("real stdio handshake returns only permitted desktop tool schemas", async t=>{
 const f=await fixture(t); const tools=await f.service.toolCatalog();
 assert.ok(tools.some(v=>v.name==='click')); assert.ok(!tools.some(v=>v.name==='set_config'||v.name==='clipboard_read'));
 assert.ok(!('session' in tools.find(v=>v.name==='click').inputSchema.properties));
 assert.equal((await f.service.status()).serverVersion,'0.24.0');
});

test("admin chat gate rejects ordinary users, groups and unauthenticated conversations before connecting", async t=>{
 const f=await fixture(t);
 for(const actor of [undefined,{...f.actor,senderId:'other'},{...f.actor,chatType:'group'}]){
  f.setActor(actor); const result=await f.tool.execute('id',{action:'list_apps'}); assert.equal(result.details.isError,true);
 }
 assert.deepEqual(await f.calls(),[]);
});

test("scheduled desktop work needs the live admin identity and a separate opt-in",async t=>{
 const f=await fixture(t); f.setActor({...f.actor,channel:'scheduler'});
 assert.equal((await f.tool.execute('id',{action:'list_apps'})).details.isError,true);
 f.config.update({computer:{allowScheduled:true}});
 assert.equal((await f.tool.execute('id',{action:'list_apps'})).details.isError,false);
 f.config.update({security:{adminStaffIds:['other']}});
 assert.equal((await f.tool.execute('id',{action:'list_apps'})).details.isError,true);
});

test("app allowlist filters windows and blocks unapproved PIDs and ambiguous launches",async t=>{
 const f=await fixture(t); const windows=await f.run('list_windows');
 assert.deepEqual(windows.structuredContent.windows.map(v=>v.pid),[111]);
 await assert.rejects(()=>f.run('get_window_state',{pid:222,window_id:20}),/允许列表/);
 await assert.rejects(()=>f.run('launch_app',{name:'Notepad',bundle_id:'private.exe'}),/一个应用标识/);
 await assert.rejects(()=>f.run('launch_app',{name:'Private App'}),/允许列表/);
 assert.equal(appAllowed({exe_name:'NOTEPAD.EXE'},['notepad.exe']),true);
});

test("Windows launches round-trip discovered executable paths and packaged app IDs",async t=>{
 const f=await fixture(t,{windows:true});
 f.config.update({computer:{allowedApps:['notepad.exe','Microsoft.WindowsCalculator_8wekyb3d8bbwe!App']}});
 await f.run('launch_app',{name:'Notepad'});await f.run('launch_app',{name:'Calculator'});
 const launches=(await f.calls()).filter(v=>v.name==='launch_app');
 assert.deepEqual(launches[0].args,{launch_path:'"C:\\Windows\\System32\\notepad.exe" /A'});
 assert.deepEqual(launches[1].args,{aumid:'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'});
});

test("every input requires a current window observation and foreground permission",async t=>{
 const f=await fixture(t); const input={pid:111,window_id:10,element_token:'token-1'};
 await assert.rejects(()=>f.run('click',input),/get_window_state/);
 await f.state(); await assert.rejects(()=>f.run('click',{...input,delivery_mode:'foreground'}),/前台/);
 await f.run('click',input); await assert.rejects(()=>f.run('click',input),/get_window_state/);
 assert.equal((await f.calls()).find(v=>v.name==='click').args.delivery_mode,'background');
});

test("driver control, path writes and injected session parameters cannot pass through",async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>f.run('set_config',{}),/不允许/);
 await assert.rejects(()=>f.run('get_window_state',{pid:111,window_id:10,session:'other'}),/不允许/);
 await assert.rejects(()=>f.run('click',{pid:111,window_id:10,debug_image_out:'/tmp/escape'}),/不允许/);
});

test("native drag, scroll, typing and accessibility value schemas remain usable",async t=>{
 const f=await fixture(t);const target={pid:111,window_id:10};
 const actions=[['drag',{from_x:10,from_y:20,to_x:50,to_y:60,duration_ms:300,steps:5}],['scroll',{direction:'down',by:'page',amount:1}],['type_text',{text:'hello',delay_ms:10}],['set_value',{element_token:'token-1',value:'updated'}]];
 for(const [action,args] of actions){await f.state();await f.run(action,{...target,...args});}
 const calls=await f.calls();
 assert.equal(calls.find(v=>v.name==='drag').args.to_y,60);
 assert.equal(calls.find(v=>v.name==='scroll').args.by,'page');
 assert.equal(calls.find(v=>v.name==='type_text').args.delay_ms,10);
 assert.ok(!('delivery_mode' in calls.find(v=>v.name==='set_value').args));
});

test("session stays alive between actions and other conversations wait until the turn releases it",async t=>{
 const f=await fixture(t); await f.state();
 let done=false; const second=f.state('two').then(()=>{done=true;}); await delay(70); assert.equal(done,false);
 await f.service.release('one'); await second;
 const calls=await f.calls(); const shots=calls.filter(v=>v.name==='get_window_state');
 assert.notEqual(shots[0].args.session,shots[1].args.session);
 assert.ok(calls.some(v=>v.name==='end_session'));
});

test("aborting a queued task never executes its desktop request",async t=>{
 const f=await fixture(t); await f.state();const abort=new AbortController();
 const second=f.state('two'); // queue one regular task too
 const cancelled=f.run('list_windows',{},'cancelled',abort.signal); abort.abort(new Error('cancel queued'));
 await assert.rejects(cancelled,/cancel queued/); await f.service.release('one'); await second;
 assert.ok(!(await f.calls()).some(v=>v.name==='list_windows'));
});

test("same-conversation parallel actions are serialized and cannot reuse one observation",async t=>{
 const f=await fixture(t);await f.state();
 const results=await Promise.allSettled([f.run('type_text',{pid:111,window_id:10,text:'brief'}),f.run('click',{pid:111,window_id:10,element_token:'token-1'})]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.ok(!(await f.calls()).some(v=>v.name==='click'));
});

test("manual stop cancels an in-flight action and permits a fresh conversation afterward",async t=>{
 const f=await fixture(t);await f.state();
 const pending=f.run('type_text',{pid:111,window_id:10,text:'slow'});
 const rejected=assert.rejects(pending);
 while(!(await f.calls()).some(v=>v.name==='type_text')) await delay(10);
 await f.service.disconnect();await rejected;
 assert.equal((await f.service.status()).connected,false);
 await assert.rejects(()=>f.state(),/已停止/);
 await f.state('two');assert.equal((await f.service.status()).connected,true);
});

test("administrator revocation while waiting prevents the queued desktop action",async t=>{
 const f=await fixture(t);await f.state();
 const otherTools=createComputerTools({...f.deps,conversationId:'two'});
 const queued=otherTools[1].execute('id',{action:'get_window_state',arguments:{pid:111,window_id:10}});
 await delay(50);f.config.update({security:{adminStaffIds:['other']}});
 await f.service.release('one');const result=await queued;
 assert.equal(result.details.isError,true);
 assert.equal((await f.calls()).filter(v=>v.name==='get_window_state').length,1);
});

test("action timeout closes the owned process and prevents blind retry during the same turn",async t=>{
 const f=await fixture(t);f.config.update({computer:{actionTimeoutSec:1}});await f.state();
 await assert.rejects(()=>f.run('type_text',{pid:111,window_id:10,text:'slow'}),/结果可能/);
 assert.equal((await f.service.status()).connected,false);
 await assert.rejects(()=>f.state(),/已停止/);
 await f.service.release('one'); await f.state();
});

test("admin settings update timeout and policy, and disabling cancels the current lease",async t=>{
 const f=await fixture(t);f.actor.text='调整桌面动作超时为 600 秒，确认';const settings=createManageSettingsTool(f.deps);
 const updated=await settings.execute('id',{action:'set',path:'computer.actionTimeoutSec',value:600});assert.equal(updated.details.newValue,600);
 await f.state(); f.config.update({computer:{enabled:false}}); await f.service.syncConfig();assert.equal((await f.service.status()).connected,false);
 await assert.rejects(()=>f.state(),/未开启/);
});

test("confirmed admin chat can enable and disable computer use without the settings UI",async t=>{
 const f=await fixture(t);f.config.update({computer:{enabled:false}});
 const capabilities=createManageCapabilitiesTool({...f.deps,playwrightCliPath:()=>''});
 const params={action:'set',capability:'computer',enabled:true};
 for(const actor of [{...f.actor,text:'开启桌面控制'},{...f.actor,senderId:'other',text:'确认开启桌面控制'},{...f.actor,chatType:'group',text:'确认开启桌面控制'},{...f.actor,channel:'scheduler',text:'确认开启桌面控制'}]){
  f.setActor(actor);assert.equal((await capabilities.execute('id',params)).details.refused,true);assert.equal(f.config.all().computer.enabled,false);
 }
 f.setActor({...f.actor,text:'确认，开启 Computer Use'});
 const enabled=await capabilities.execute('id',params);
 assert.equal(enabled.details.capabilities.computer,true);assert.equal(f.config.all().computer.enabled,true);
 assert.ok(enabled.content[0].text.includes('无需打开设置页'));
 assert.equal((await f.tool.execute('id',{action:'list_apps'})).details.isError,false);
 const disabled=await capabilities.execute('id',{...params,enabled:false});await f.service.syncConfig();
 assert.equal(disabled.details.capabilities.computer,false);assert.equal((await f.service.status()).connected,false);
});

test("every computer setting can be changed and read back from confirmed administrator chat",async t=>{
 const f=await fixture(t);f.setActor({...f.actor,text:'确认，配置 Cua 的全部相关设置'});
 const settings=createManageSettingsTool(f.deps);
 const values={enabled:false,driverPath:f.driver,allowedApps:['notepad.exe','Calculator'],allowForeground:true,allowScheduled:true,connectTimeoutSec:90,actionTimeoutSec:600,sessionTimeoutSec:840};
 for(const [key,value] of Object.entries(values)){
  const updated=await settings.execute('id',{action:'set',path:'computer.'+key,value});
  assert.deepEqual(updated.details.newValue,value);assert.deepEqual(f.config.all().computer[key],value);
 }
 const readback=await settings.execute('id',{action:'get',path:'computer'});
 assert.deepEqual(JSON.parse(readback.content[0].text.slice('computer = '.length)),values);
 const snapshot=f.config.all();f.config.replaceAll({});f.config.replaceAll(snapshot);assert.deepEqual(f.config.all().computer,values);
 f.setActor({...f.actor,senderId:'other',text:'确认，开启前台操作'});
 assert.equal((await settings.execute('id',{action:'set',path:'computer.allowForeground',value:false})).details.refused,true);
});

test("desktop management remains available while disabled and installation requires confirmed admin chat",async t=>{
 const f=await fixture(t);f.config.update({computer:{enabled:false}});
 assert.equal((await f.manage.execute('id',{action:'status'})).details.enabled,false);
 assert.equal((await f.manage.execute('id',{action:'install'})).details.refused,true);
 const connected=await f.manage.execute('id',{action:'connect'});assert.equal(connected.details.connected,true);
 const tools=await f.manage.execute('id',{action:'tools',tool:'click'});assert.ok(tools.content[0].text.includes('click'));
 assert.equal((await f.manage.execute('id',{action:'disconnect'})).details.connected,false);
});

test("screenshots reach vision models, persist for send_image and degrade to the tree for text models",async t=>{
 const f=await fixture(t);
 let result=await f.tool.execute('id',{action:'get_window_state',arguments:{pid:111,window_id:10}});
 assert.ok(result.content.some(v=>v.type==='image'));assert.ok(result.content.some(v=>v.text?.includes('截图已保存')));
 const tools=createComputerTools({...f.deps,isVisionModel:()=>false});result=await tools[1].execute('id',{action:'get_window_state',arguments:{pid:111,window_id:10}});
 assert.ok(!result.content.some(v=>v.type==='image'));assert.ok(result.content.some(v=>v.text?.includes('snap-1')));
});

test("whole-task timeout includes gaps between calls and cannot silently start a fresh lease",async t=>{
 const f=await fixture(t);f.config.update({computer:{sessionTimeoutSec:1}});await f.state();await delay(1100);
 await assert.rejects(()=>f.state(),/已停止/);
});

test("downloaded executable archives are rejected when the pinned hash does not match",()=>{
 assert.throws(()=>verifyDriverArchive(Buffer.from('tampered'),'0'.repeat(64)),/SHA-256/);
});
