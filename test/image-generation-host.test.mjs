import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PluginManager } from '../src/plugins/manager.mjs';
import { InProcessRuntime } from '../src/plugins/runtime-inprocess.mjs';
import { ProcessRuntime } from '../src/plugins/runtime-process.mjs';
import { createMediaDelivery } from '../src/plugins/delivery.mjs';
import { normalizeManifest, deriveToolPolicy } from '../src/plugins/manifest.mjs';
import { chatGrantAllows } from '../src/guard/chat-grant.mjs';
import { chatGrantAllows as pluginChatGrantAllows, normalizeChatTools } from '../src/plugins/chat-tools.mjs';
import { resolveToolSet } from '../src/guard/tool-gate.mjs';
import { createToolRunner } from '../src/tools/executor.mjs';
import { getTool, removeToolsOfPlugin } from '../src/tools/registry.mjs';
import { ConfirmRegistry, normalizeMessageId, parseConfirmReply } from '../src/guard/confirm.mjs';

// 全部为本地夹具：保险箱、发送出口、DSH HTTP 与发现文件均用模拟替代。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifestRaw = (over = {}) => ({
  id: 'image-host-fixture', name: '生图宿主夹具', version: '1.0.0', apiVersion: '1',
  description: '仅用于本地宿主集成测试', runtime: 'in-process', trusted: true,
  tools: [{ name: 'image_host_fixture', description: '提交收费生成请求', needs: 'qq',
    risk: 'R2', effects: ['paid', 'net', 'data.write', 'chat.send', 'chat.send.media'], approval: 'plugin' }],
  ...over,
});
function normalized(over = {}) {
  const r = normalizeManifest(manifestRaw(over), { dirName: 'image-host-fixture' });
  assert.equal(r.ok, true, r.message);
  return r.manifest;
}
function declaration() {
  const t = normalized().tools[0];
  return { name: t.fullName, plugin: 'image-host-fixture', effects: t.effects, ...deriveToolPolicy(t) };
}
function grant(channel = 'group', overrides = {}) {
  return { channel, rule: { enabled: true, tools: [declaration().name], allowPaid: true, ...overrides } };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-image-host-'));
  t.after(async () => {
    assert.ok(path.basename(dir).startsWith('ling-image-host-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('收费例外：只允许点名的插件自审 R2，两个授权入口保持同一策略', () => {
  const tool = declaration();
  for (const allows of [chatGrantAllows, pluginChatGrantAllows]) {
    for (const channel of ['group', 'private']) assert.equal(allows(tool, grant(channel)).ok, true);
    for (const g of [grant('group', { tools: ['*'] }), grant('group', { allowPaid: false }),
      grant('group', { tools: [] }), grant('proactive')]) {
      assert.equal(allows(tool, g).ok, false);
    }
    for (const over of [{ risk: 'R3' }, { risk: 'R9' }, { risk: 'R2', approval: 'host' },
      { risk: 'R2', effects: [] }, { plugin: '' }, { kind: 'host' },
      { effects: ['paid', 'exec'] }, { approval: 'host', effects: ['paid', 'data.write'] },
      { risk: 'R1', effects: ['data.write'] },
      { effects: ['paid', 'qq.account.write'] }]) {
      assert.equal(allows({ ...tool, ...over }, grant()).ok, false, JSON.stringify(over));
    }
    assert.equal(allows({ ...tool, approval: 'host', risk: 'R1', effects: [] }, grant()).ok, true);
  }
  const chatTools = normalizeChatTools({
    group: grant().rule, private: grant('private').rule, proactive: grant('proactive').rule,
  }).value;
  const policy = { chatTools, allowR3Default: true };
  for (const convKey of ['group:10001', 'private:10002']) {
    assert.equal(resolveToolSet('group', [tool], policy, { convKey }).length, 1);
  }
  assert.equal(resolveToolSet('proactive', [tool], policy, { convKey: 'group:10001' }).length, 0);
  assert.equal(resolveToolSet('group', [{ ...tool, risk: 'R3' }], policy, { convKey: 'group:10001' }).length, 0);
});

test('真实生图清单的持久化effects不阻断精确授权，通配及主动来源仍被拦', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins/image-generation/plugin.json'), 'utf8'));
  const result = normalizeManifest(raw, { dirName: 'image-generation' });
  assert.equal(result.ok, true, result.message);
  const declared = result.manifest.tools.find((t) => t.name === 'image_generate');
  assert.ok(declared.effects.includes('data.write'));
  const tool = { name: declared.fullName, plugin: raw.id, effects: declared.effects, ...deriveToolPolicy(declared) };
  const exact = { channel: 'group', rule: { enabled: true, tools: [tool.name], allowPaid: true } };
  for (const allows of [chatGrantAllows, pluginChatGrantAllows]) {
    assert.equal(allows(tool, exact).ok, true);
    assert.equal(allows(tool, { ...exact, channel: 'private' }).ok, true);
    assert.equal(allows(tool, { ...exact, channel: 'proactive' }).ok, false);
    assert.equal(allows(tool, { ...exact, rule: { ...exact.rule, tools: ['*'] } }).ok, false);
  }
});

test('清单准入：process / 非trusted / 非paid 不得委托插件审批', () => {
  for (const over of [{ runtime: 'process' }, { trusted: false }, {
    tools: [{ ...manifestRaw().tools[0], effects: ['chat.send.media'] }],
  }]) {
    assert.equal(normalizeManifest(manifestRaw(over), { dirName: 'image-host-fixture' }).ok, false);
  }
});

test('真实 manager 注册保留 approval；群聊与普通私聊执行不产生宿主通用审批', async (t) => {
  const root = await temp(t);
  const dir = path.join(root, 'plugin');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'index.mjs'), `export default {
    init(ctx) { this.saved = ctx; return {ok:true}; },
    callTool({ctx}) { return {ok:true, pendingPluginApproval:true, convKey:ctx.caller.convKey,
      background: typeof this.saved.deliverMedia === 'function'}; }
  };`);
  const manager = new PluginManager({ pluginsDir: root, userDataRoot: root,
    secretsPath: path.join(root, 'never-read.json'), getConfig: () => ({ plugins: {} }),
    persistConfig: async () => {}, log: () => {}, sendText: async () => { throw Error('不得发消息'); } });
  manager.store.readSecrets = async () => ({ ok: true, values: {} });
  const record = { id: 'image-host-fixture', dir, manifest: normalized(), logs: [] };
  t.after(async () => { await record.runtime?.dispose(); removeToolsOfPlugin(record.id); });
  assert.equal((await manager.startOne(record, { allowDangerous: false })).ok, false);
  assert.equal(getTool(declaration().name), undefined, '未放行R2不可注册');
  const understated = { id: record.id, dir, logs: [], manifest: normalized({
    tools: [{ ...manifestRaw().tools[0], risk: 'R0' }],
  }) };
  assert.equal(understated.manifest.tools[0].effectiveRisk, 'R2');
  assert.equal((await manager.startOne(understated, { allowDangerous: false })).ok, false,
    '声明R0但paid推为R2仍需高风险开关');
  assert.equal(understated.runtime, undefined, '权限检查在初始化与后台能力注入之前');
  assert.equal((await manager.startOne(record, { allowDangerous: true })).ok, true);
  const tool = getTool(declaration().name);
  assert.equal(tool.approval, 'plugin');
  assert.equal(tool.risk, 'R2');
  assert.ok(tool.effects.includes('paid'));
  let genericApprovals = 0;
  const chatTools = normalizeChatTools({ group: grant().rule, private: grant('private').rule }).value;
  for (const convKey of ['group:10001', 'private:10002']) {
    const runner = createToolRunner({ tools: [tool], policy: { chatTools }, context: {
      origin: 'group', convKey, requester: { id: '10002' },
      askConfirm: async () => { genericApprovals++; return 'deny'; },
    } });
    assert.equal(runner.availableTools().length, 1);
    const result = await runner.run(tool.name, {});
    assert.equal(result.ok, true, result.message);
    assert.equal(result.result.pendingPluginApproval, true);
    assert.equal(result.result.convKey, convKey);
    assert.equal(result.result.background, true);
  }
  assert.equal(genericApprovals, 0);
});

test('manager 初始化失败同样dispose并撤销插件已保存的后台ctx', async (t) => {
  const root = await temp(t);
  const dir = path.join(root, 'failed-init');
  await fs.mkdir(dir);
  const entry = path.join(dir, 'index.mjs');
  await fs.writeFile(entry, `export let saved; export let disposed = false; export default {
    init(ctx) { saved = ctx; return {ok:false,code:'E4064',message:'local-init-failure'}; },
    callTool() {}, dispose() { disposed = true; }
  };`);
  const manager = new PluginManager({ pluginsDir: root, userDataRoot: root,
    secretsPath: path.join(root, 'never-read.json'), getConfig: () => ({ plugins: {} }),
    persistConfig: async () => {}, log: () => {}, sendText: async () => { throw Error('不得发消息'); } });
  manager.store.readSecrets = async () => ({ ok: true, values: {} });
  let captured;
  const original = manager.deliverMedia;
  manager.deliverMedia = async (input) => { throw Error('失效ctx不可抵达投递'); };
  // 捕获运行时真实加载的模块，不依赖时间戳import缓存键。
  const originalDispose = InProcessRuntime.prototype.dispose;
  t.mock.method(InProcessRuntime.prototype, 'dispose', async function () {
    if (this.dir === dir) captured = this;
    return originalDispose.call(this);
  });
  const record = { id: 'image-host-fixture', dir, manifest: normalized(), logs: [] };
  const r = await manager.startOne(record, { allowDangerous: true });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'local-init-failure');
  assert.equal(record.runtime, null);
  assert.equal(captured.disposed, true);
  assert.equal(captured.mod.disposed, true);
  assert.equal(captured.mod.saved.signal.aborted, true);
  assert.equal((await captured.mod.saved.deliverMedia({ convKey: 'group:10001', path: 'late.png' })).code, 'E4067');
  manager.deliverMedia = original;
});

test('后台接口只对可信in-process暴露，旧ctx在停用后拒绝，任务signal与生命周期组合', async () => {
  const received = [];
  const opts = { manifest: normalized(), dir: '', dataDir: '', config: {}, secrets: {}, log: () => {},
    deliverMedia: async (input) => { received.push(input); return { ok: true }; } };
  const runtime = new InProcessRuntime(opts);
  const ctx = runtime.makeContext();
  const task = new AbortController();
  const turn = new AbortController();
  const callCtx = runtime.makeCallContext({ signal: turn.signal });
  turn.abort();
  assert.equal((await callCtx.deliverMedia({ convKey: 'group:10001', path: 'one.png', signal: task.signal })).ok, true);
  assert.equal(received[0].signal.aborted, false, '短暂工具调用结束不取消后台任务');
  task.abort();
  assert.equal(received[0].signal.aborted, true);
  assert.equal((await ctx.deliverMedia({ signal: task.signal })).code, 'E4070');
  await runtime.dispose();
  assert.equal((await ctx.deliverMedia({ isActive: () => true })).code, 'E4067');
  assert.equal(received.length, 1);
  for (const over of [{ runtime: 'process' }, { trusted: false }]) {
    const other = new InProcessRuntime({ ...opts, manifest: { ...opts.manifest, ...over } });
    assert.equal('deliverMedia' in other.makeContext(), false);
    await other.dispose();
  }
});

test('统一媒体队列在真正执行时重新检查停用与取消；有效发送仍走同一出口', async (t) => {
  const dir = await temp(t);
  await fs.writeFile(path.join(dir, 'image.png'), Buffer.from('local-image-fixture'));
  const queued = [];
  const sent = [];
  const delivery = createMediaDelivery({
    sequencer: { run: (key, send) => { const pending = deferred(); queued.push({ key, send, pending }); return pending.promise; } },
    sendSegments: async (input) => { sent.push(input); return { ok: true, messageId: 'sent-1' }; },
  });
  const input = { pluginId: 'image-host-fixture', dataDir: dir, convKey: 'group:10001', path: 'image.png' };
  let active = true;
  const task = new AbortController();
  const a = delivery({ ...input, isActive: () => active });
  const b = delivery({ ...input, signal: task.signal });
  const c = delivery(input);
  // 等文件校验完成、三项真正入队，不用固定时间sleep。
  while (queued.length < 3) await new Promise(setImmediate);
  active = false;
  task.abort();
  for (const entry of queued) entry.pending.resolve(await entry.send());
  assert.equal((await a).code, 'E4067');
  assert.equal((await b).code, 'E4070');
  assert.equal((await c).ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].convKey, input.convKey);
  assert.equal(sent[0].segments[0].type, 'image');
  assert.equal((await delivery({ ...input, signal: task.signal })).code, 'E4070');
  assert.equal((await delivery({ ...input, path: '../outside.png' })).code, 'E4075');
});

test('主入口真实装配共享AI会话队列并转传任务signal，出站前取消不会发送', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src/index.mjs'), 'utf8');
  const managerStart = source.indexOf('plugins = new PluginManager({');
  const gatewayStart = source.indexOf('makeGateway:', managerStart);
  const opts = source.slice(managerStart, gatewayStart);
  assert.match(opts, /sequencer:\s*replySequencer/,
    'manager级sequencer不能漏传，gateway内部的配置不能替代');
  const wire = opts.match(/sendSegments:\s*(\(input\)\s*=>\s*sendSegments\([^\n]+\)),/);
  assert.ok(wire, '真实发送包装可读取');
  const captured = [];
  const forward = new Function('sendSegments', `return (${wire[1]});`)((...args) => { captured.push(args); });
  const task = new AbortController();
  forward({ convKey: 'group:10001', segments: [], auditText: 'fixture', signal: task.signal });
  assert.equal(captured[0][3], task.signal, '转传原始任务signal');

  const start = source.indexOf('async function sendSegments(convKey,');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start > 0 && end > start);
  let gates = 0;
  let outgoing = 0;
  let abortInGate = false;
  const send = new Function('passSendGate', 'config', 'resolveAdminQqs', 'auditOutbound', 'limiter',
    'log', 'client', 'requestOneBotAction', `${source.slice(start, end)}; return sendSegments;`)(
    () => { gates++; if (abortInGate) task.abort(); return { ok: true }; }, {}, () => [], () => {}, {},
    { warn() {} }, {}, async () => { outgoing++; return { message_id: 'mock-sent' }; });
  const stopped = new AbortController(); stopped.abort();
  assert.equal((await send('group:10001', [], 'fixture', stopped.signal)).code, 'E4070');
  assert.equal(gates, 0);
  abortInGate = true;
  assert.equal((await send('group:10001', [], 'fixture', task.signal)).code, 'E4070');
  assert.equal(gates, 1);
  assert.equal(outgoing, 0);
  abortInGate = false;
  assert.equal((await send('group:10001', [], 'fixture', new AbortController().signal)).ok, true);
  assert.equal(outgoing, 1);
});

test('process 无后台函数且伪造deliverMedia host-call仍被拒绝', async () => {
  const rt = new ProcessRuntime({ manifest: { ...normalized(), runtime: 'process' }, dir: '', dataDir: '',
    config: {}, secrets: {}, log: () => {}, deliverMedia: async () => { throw Error('不得被调用'); } });
  const replies = [];
  rt.write = (msg) => { replies.push(msg); return true; };
  rt.callContexts.set(1, { invocation: { convKey: 'group:10001' }, signal: new AbortController().signal });
  assert.equal(rt.deliverMedia, undefined);
  await rt.handleHostCall({ id: 2, callId: 1, method: 'deliverMedia', args: { convKey: 'group:99999' } });
  assert.equal(replies[0].result.ok, false);
  assert.equal(replies[0].result.code, 'E4071');
  const childSource = await fs.readFile(path.join(ROOT, 'src/plugins/child-runner.mjs'), 'utf8');
  assert.equal(childSource.includes('deliverMedia'), false);
});

test('真实宿主非引用审批入口拒绝所有显式引用，不能在插件交回后兜底误批', async (t) => {
  // 只提取产品函数，避免import主入口启动后端；函数逻辑未经复刻。
  const source = await fs.readFile(path.join(ROOT, 'src/index.mjs'), 'utf8');
  const start = source.indexOf('async function tryHandleUnquotedConfirm(evt) {');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start > 0 && end > start);
  const confirms = new ConfirmRegistry();
  t.after(() => confirms.cancelAll('test-cleanup'));
  const request = confirms.register({ tool: 'fixture', risk: 'R2', args: {}, convKey: 'private:10001',
    replyConvKey: 'private:10001', allowedSenders: ['10001'] });
  const reports = [];
  const handle = new Function('normalizeMessageId', 'parseConfirmReply', 'confirms', 'reportConfirmResult',
    'sendConfirmReply', `${source.slice(start, end)}; return tryHandleUnquotedConfirm;`)(
    normalizeMessageId, parseConfirmReply, confirms, async (...args) => reports.push(args),
    async () => { throw Error('引用不应发送兜底通知'); });
  const evt = { convKey: 'private:10001', sender: { userId: '10001' }, text: '1' };
  for (const messageId of ['dsh-card', 'image-card', 'expired-image-card', 'unknown-card', -12345]) {
    assert.equal(await handle({ ...evt, replyTo: { messageId } }), false);
    assert.equal(await handle({ ...evt, replyToMessageId: messageId }), false);
    assert.equal(confirms.size, 1);
    assert.equal(reports.length, 0);
  }
  assert.equal(await handle(evt), true, '无引用原有唯一待确认语义保留');
  assert.equal(await request.promise, 'allow');
  assert.equal(reports.length, 1);
});

const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
test('真实 dsh-bridge onMessage 与宿主/生图引用互不抢占（无HTTP、无发现文件写入）', async (t) => {
  const bridgeURL = pathToFileURL(path.join(ROOT, 'plugins/dsh-bridge/lib/bridge.mjs')).href;
  const fakeURL = dataModule(`import {DshBridge as Base} from ${JSON.stringify(bridgeURL)};
    export let latest; export const DEFAULT_PORT = 3458;
    export class DshBridge extends Base { constructor(opts) { super(opts); latest = this; } }
    export async function serve() { return {port:3458,close:async()=>{latest.shutdown();}}; }`);
  const stub = await import(fakeURL);
  const indexPath = path.join(ROOT, 'plugins/dsh-bridge/index.mjs');
  const source = (await fs.readFile(indexPath, 'utf8'))
    .replace("'./lib/bridge.mjs'", JSON.stringify(fakeURL))
    .replace("'./lib/discovery.mjs'", JSON.stringify(dataModule('export async function writeDiscovery(){return true;} export async function clearDiscovery(){}')))
    .replace(/'\.\/lib\/([^']+)'/g, (_, file) => JSON.stringify(pathToFileURL(path.join(ROOT, 'plugins/dsh-bridge/lib', file)).href));
  const plugin = (await import(dataModule(source))).default;
  const pushed = [];
  const ctx = { config: { admins: '10001', port: 3458 }, secrets: { token: 'local-simulated-token' },
    log: () => {}, sendText: async (_, text) => { pushed.push(text); return { ok: true, messageId: 'dsh-card' }; } };
  assert.equal((await plugin.init(ctx)).ok, true);
  t.after(() => plugin.dispose(ctx));
  const started = stub.latest.askStart({ toolName: 'local-fixture', reason: '模拟审批' });
  await new Promise(setImmediate);
  assert.equal(pushed.length, 1);
  const host = new ConfirmRegistry();
  t.after(() => host.cancelAll('test-cleanup'));
  const request = host.register({ tool: 'host-fixture', risk: 'R2', args: {}, convKey: 'private:10001',
    replyConvKey: 'private:10001', allowedSenders: ['10001'] });
  host.bindMessage(request.id, 'host-card');
  const evt = (messageId) => ({ isGroup: false, convKey: 'private:10001', sender: { userId: '10001' }, text: '1', replyTo: { messageId } });
  for (const quote of ['host-card', 'image-approval-card', 'unrelated-card']) {
    assert.equal(await plugin.handleMessage({ evt: evt(quote), ctx }), false, `DSH不可抢${quote}`);
    assert.equal(stub.latest.listPending().length, 1);
    assert.equal(host.size, 1);
  }
  assert.equal(host.resolveByQuote({ messageId: 'image-approval-card', convKey: 'private:10001', senderId: '10001', allow: true }).handled, false);
  assert.equal(host.resolveByQuote({ messageId: 'dsh-card', convKey: 'private:10001', senderId: '10001', allow: true }).handled, false);
  assert.equal(await plugin.handleMessage({ evt: evt('dsh-card'), ctx }), true);
  assert.equal((await stub.latest.awaitResult(String(started.id))).outcome, 'allowed-once');
  assert.equal(host.size, 1);
  assert.equal(host.resolveByQuote({ messageId: 'host-card', convKey: 'private:10001', senderId: '10001', allow: true }).handled, true);
  assert.equal(await request.promise, 'allow');
});
