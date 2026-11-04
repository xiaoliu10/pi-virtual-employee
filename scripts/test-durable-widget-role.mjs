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
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
const dir = await mkdtemp(join(process.cwd(), 'node_modules/.durable-widget-role-'));
after(() => rm(dir, { recursive: true, force: true }));
await build({ stdin: { contents: 'export { DurableRuntime, Route } from "./src/engine/durable/runtime.ts"; export { HistoryStore } from "./src/db/history-store.ts"; export { checkPermission, effectiveActorRole } from "./src/security/permissions.ts";', resolveDir: process.cwd(), loader: 'ts' }, outfile: join(dir, 'runtime.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { DurableRuntime, Route, HistoryStore, checkPermission, effectiveActorRole } = await import(pathToFileURL(join(dir, 'runtime.mjs')));

function setup(t, name) {
 const db = new DatabaseSync(':memory:');
 db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT,model_supplier_id TEXT,model_model_id TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at INTEGER);');
 t.after(() => db.close());
 const faux = fauxProvider();
 const sessions = new Map();
 const model = faux.provider.getModels()[0];
 const session = id => {
  if (!sessions.has(id)) sessions.set(id, new Agent({ streamFn: faux.provider.streamSimple, sessionId: id, initialState: { model, systemPrompt: 'test' } }));
  return sessions.get(id);
 };
 let currentActor;
 let security = { adminStaffIds: [], ownerStaffIds: [], defaultRole: 'viewer', people: [], conversations: [] };
 const config = { all: () => ({ security }) };
 const observations = [];
 const tool = { name: 'access_probe', label: 'access', description: 'Check actual tool authority', parameters: Type.Object({}), execute: async () => {
  const actor = currentActor;
  observations.push({ actor, role: effectiveActorRole(config, actor), shell: checkPermission(config, actor, 'widget:test', 'shell').ok });
  return { content: [{ type: 'text', text: 'checked' }] };
 } };
 const opts = { userDataDir: join(dir, name), history: new HistoryStore(db), session, tools: () => [tool], mcpTools: () => [{ ...tool, name: 'mcp_access_probe' }],
  stream: (_id, options, messages) => faux.provider.streamSimple(model, { messages }, options),
  withActor: async (_id, ctx, _text, run) => { currentActor = ctx.actor; try { return await run(); } finally { currentActor = undefined; } }, onRecovered: async () => {} };
 return { faux, session, opts, observations, setSecurity: value => { security = { ...security, ...value }; } };
}

for (const role of ['viewer', 'operator', 'admin']) {
 test(`durable real tool receives ticket ${role}, including RBAC shell decision`, async t => {
  const p = setup(t, role);
  p.faux.setResponses([fauxAssistantMessage(fauxToolCall('access_probe', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('done')]);
  const runtime = await DurableRuntime.open(p.opts);
  try {
   const result = await runtime.send(p.session(`widget:${role}`), 'check', { actor: { senderId: `widget-user-${role}`, channel: 'widget', chatType: 'single', verifiedRole: role } });
   assert.equal(result.reply, 'done');
   assert.equal(p.observations.length, 1);
   assert.equal(p.observations[0].role, role);
   assert.equal(p.observations[0].actor.verifiedRole, role);
   // shell 的 capability 门槛是 operator（CAPABILITY_MIN），viewer 拒、operator/admin 通过
   assert.equal(p.observations[0].shell, role !== 'viewer');
  } finally { await runtime.close(); }
 });
}

test('MCP registrations also receive the persisted widget grant', async t => {
 const p = setup(t, 'mcp');
 p.faux.setResponses([fauxAssistantMessage(fauxToolCall('mcp_access_probe', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('done')]);
 const runtime = await DurableRuntime.open(p.opts);
 try {
  await runtime.send(p.session('widget:mcp'), 'check', { actor: { senderId: 'widget-user-mcp', channel: 'widget', chatType: 'single', verifiedRole: 'admin' } });
  assert.equal(p.observations.length, 1);
  assert.equal(p.observations[0].role, 'admin');
 } finally { await runtime.close(); }
});

test('close/reopen uses persisted role without liveContexts; old/invalid records fail closed', async t => {
 const p = setup(t, 'restart');
 let runtime = await DurableRuntime.open(p.opts);
 let cid;
 try {
  p.faux.setResponses([fauxAssistantMessage('initial')]);
  await runtime.send(p.session('widget:restart'), 'check', { actor: { senderId: 'widget-user-restart', channel: 'widget', chatType: 'single', verifiedRole: 'admin' } });
  [cid] = [...runtime.routes.keys()];
 } finally { await runtime.close(); }

 // 新进程：没有任何 live ticket 上下文，权限只能来自持久化的 route。
 runtime = await DurableRuntime.open(p.opts);
 try {
  assert.equal(runtime.liveContexts.size, 0, 'new process has no live ticket context');
  const conv = await runtime.host.harness.conversation(cid, context);

  // 每个探测回合都要有一条真实输入，模型才会去调工具（空 continue 不会）。
  const probe = async (expected) => {
   const before = p.observations.length;
   p.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('access_probe', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
   ]);
   const submission = await conv.submit({ type: 'input', content: 'probe access' }, context);
   await submission.wait(context);
   assert.equal(p.observations.length, before + 1, 'the probe tool must have run');
   assert.equal(p.observations.at(-1).role, expected);
   return p.observations.at(-1);
  };

  // 持久化的 admin 授权在重启后依然生效。
  const admin = await probe('admin');
  assert.equal(admin.actor.verifiedRole, 'admin', 'grant restored from the route document');
  assert.equal(admin.shell, true);

  // 缺失或非法的授权必须失败关闭为 viewer —— 绝不猜成更高角色。
  for (const value of [undefined, '', 'owner', 'bogus']) {
   await conv.commit(async tx => {
    const route = await tx.doc(Route, cid);
    if (value === undefined) delete route.verifiedRole;
    else route.verifiedRole = value;
   }, context);
   runtime.routes.set(cid, await runtime.host.harness.snapshot(Route, cid, context));
   const observed = await probe('viewer');
   assert.equal(observed.actor.verifiedRole, undefined, `${String(value)} must not become a grant`);
   assert.equal(observed.shell, false, `${String(value)} must not pass the operator floor`);
  }
 } finally { await runtime.close(); }
});

test('IM verifiedRole is not persisted as a grant and current config revocation takes effect', async t => {
 const p = setup(t, 'im');
 p.setSecurity({ adminStaffIds: ['person'] });
 p.faux.setResponses([fauxAssistantMessage(fauxToolCall('access_probe', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('done')]);
 const runtime = await DurableRuntime.open(p.opts);
 try {
  await runtime.send(p.session('dt:im'), 'check', { actor: { senderId: 'person', channel: 'dingtalk', chatType: 'single', verifiedRole: 'admin' } });
  assert.equal(p.observations.at(-1).role, 'admin');
  assert.equal(p.observations.at(-1).actor.verifiedRole, undefined);
  const [cid] = [...runtime.routes.keys()];
  const conv = await runtime.host.harness.conversation(cid, context);
  p.setSecurity({ adminStaffIds: [] });
  p.faux.setResponses([fauxAssistantMessage(fauxToolCall('access_probe', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('done')]);
  const before = p.observations.length;
  await (await conv.submit({ type: 'input', content: 'probe after revocation' }, context)).wait(context);
  assert.equal(p.observations.length, before + 1, 'the probe tool must have run');
  assert.equal(p.observations.at(-1).role, 'viewer', 'revoked admin falls back to the current config role');
 } finally { await runtime.close(); }
});
