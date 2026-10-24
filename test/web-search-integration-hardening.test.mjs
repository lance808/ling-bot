import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginManager, runtimeSecretsFor } from '../src/plugins/manager.mjs';
import { InProcessRuntime } from '../src/plugins/runtime-inprocess.mjs';
import { ProcessRuntime } from '../src/plugins/runtime-process.mjs';
import { createToolRunner } from '../src/tools/executor.mjs';
import { defineTool, removeToolsOfPlugin, _clearToolsForTest } from '../src/tools/registry.mjs';
import { runTurn, MAX_STEPS } from '../src/llm/agent-loop.mjs';

const manifest = { id: 'web-search', name: '搜索测试', version: '1.0.0', runtime: 'in-process', trusted: true, tools: [], entry: 'index.mjs' };
const runtimeOptions = (extra = {}) => ({ manifest, config: {}, secrets: {}, dir: '.', dataDir: '.', log: () => {}, ...extra });
const tool = (extra = {}) => ({ name: 'plugin_web_search', kind: 'host', risk: 'R1', confirm: 'never', origins: ['owner-private', 'console'], params: {}, plugin: 'web-search', run: async () => '结果', ...extra });
const context = (extra = {}) => ({ origin: 'console', convKey: 'private:0', ...extra });
const llmCalls = (count) => Array.from({ length: count }, (_, n) => ({ id: `c${n}`, name: 'plugin_web_search', arguments: '{}' }));

test('只有 web-search 插件能获取宿主联网工厂', () => {
  let created = 0;
  const manager = Object.create(PluginManager.prototype);
  manager.makeNet = () => { created++; return (input) => input; };
  manager.log = () => {};
  assert.equal(manager.netFactoryFor('echo', {}, {}), undefined);
  assert.equal(manager.netFactoryFor('other-qq-tool', {}, {}), undefined);
  assert.equal(created, 0);
  const make = manager.netFactoryFor('web-search', {}, { apiKey: 'fake-only' });
  assert.equal(typeof make, 'function');
  assert.equal(created, 1);
  assert.equal(make({ allowRequests: false }).allowRequests, false);
});

test('搜索 Key 从运行时 secrets 剥离，其他插件凭据契约不变', () => {
  const secrets = { apiKey: 'fake-key', token: 'other-token' };
  assert.deepEqual(runtimeSecretsFor('web-search', secrets), { token: 'other-token' });
  assert.deepEqual(runtimeSecretsFor('echo', secrets), secrets);
  assert.equal(secrets.apiKey, 'fake-key', '不能修改宿主仍要绑定到闭包的凭据');
  const rt = new InProcessRuntime(runtimeOptions({ secrets }));
  assert.equal(rt.makeContext().secrets.apiKey, undefined);
});

test('子进程 init payload 不含搜索 Key，netFacts 明确禁止请求', async () => {
  const key = 'fake-key-only-in-host';
  let payload;
  const calls = [];
  const rt = new ProcessRuntime(runtimeOptions({
    secrets: { apiKey: key, token: 'other' },
    makeNet: (input) => { calls.push(input); return { available: true, enabled: true, provider: 'tavily', configured: true }; },
  }));
  rt.spawnChild = async () => ({ ok: true });
  rt.request = async (message) => { payload = message; return { type: 'ready' }; };
  assert.equal((await rt.init()).ok, true);
  assert.equal(JSON.stringify(payload).includes(key), false);
  assert.equal(payload.payload.secrets.token, 'other');
  assert.equal(payload.payload.netFacts.configured, true);
  assert.deepEqual(calls[0], { invocation: null, allowRequests: false });
});

test('同进程生命周期注入只读事实，工具调用传可信上下文', () => {
  const calls = [];
  const rt = new InProcessRuntime(runtimeOptions({ makeNet: (input) => { calls.push(input); return {}; } }));
  rt.makeContext();
  assert.equal(calls[0].allowRequests, false);
  const invocation = { tool: 'plugin_web_search', origin: 'console' };
  rt.makeCallContext({ invocation });
  assert.equal(calls.at(-1).invocation, invocation);
});

test('同进程工具超时中止该调用信号，不停用实例', async () => {
  let observed;
  let calls = 0;
  const rt = new InProcessRuntime(runtimeOptions());
  rt.instance = { callTool: ({ signal }) => {
    calls++;
    if (calls > 1) return '后续调用正常';
    observed = signal;
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve('迟到结果'), { once: true }));
  } };
  // 保持事件循环存活；运行时自己的超时定时器允许 unref。
  const keepAlive = setInterval(() => {}, 100);
  try {
    const first = await rt.callTool({ tool: 'web_search', args: {}, timeoutMs: 15 });
    assert.equal(first.code, 'E4065');
    assert.equal(observed.aborted, true);
    assert.equal(rt.controller.signal.aborted, false);
    const second = await rt.callTool({ tool: 'web_search', args: {}, timeoutMs: 100 });
    assert.equal(second.ok, true);
    assert.equal(second.value, '后续调用正常');
  } finally { clearInterval(keepAlive); }
});

test('子进程超时同步中止父进程代发网络调用', async () => {
  let observed;
  let killed = false;
  const rt = new ProcessRuntime(runtimeOptions());
  rt.child = {};
  rt.request = async (_message, _ms, _expect, _error, options) => {
    observed = rt.callContexts.values().next().value.signal;
    return new Promise((resolve) => options.signal.addEventListener('abort', () => resolve({ ok: false, code: 'E4070' }), { once: true }));
  };
  rt.kill = () => { killed = true; };
  const result = await rt.callTool({ tool: 'web_search', args: {}, timeoutMs: 15 });
  assert.equal(result.code, 'E4065');
  assert.equal(observed.aborted, true);
  assert.equal(killed, true);
});

test('executor deadline 取消慢请求并透传实际 signal', async () => {
  let signal;
  const runner = createToolRunner({ tools: [tool({ run: (input) => {
    signal = input.signal;
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve('迟到'), { once: true }));
  } })], context: context() });
  const result = await runner.run('plugin_web_search', {}, { deadline: Date.now() + 15 });
  assert.equal(result.code, 'E4070');
  assert.equal(signal.aborted, true);
});

test('审批等待也受预算约束，批准迟到不会执行工具', async () => {
  let approve;
  let ran = false;
  const runner = createToolRunner({ tools: [tool({ confirm: 'always', run: async () => { ran = true; } })], context: context({ askConfirm: () => new Promise((resolve) => { approve = resolve; }) }) });
  const result = await runner.run('plugin_web_search', {}, { deadline: Date.now() + 15 });
  assert.equal(result.code, 'E4070');
  approve('allow');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ran, false);
});

test('停用插件后旧 runner 不得回退到缓存工具', async () => {
  _clearToolsForTest();
  let ran = false;
  defineTool(tool({ run: async () => { ran = true; } }));
  const runner = createToolRunner({ context: context() });
  assert.equal(runner.availableTools().length, 1);
  removeToolsOfPlugin('web-search');
  assert.equal(runner.availableTools().length, 0);
  assert.equal((await runner.run('plugin_web_search', {})).code, 'E4032');
  assert.equal(ran, false);
  _clearToolsForTest();
});

test('单次模型返回大量工具调用时仍最多执行八步', async () => {
  let runs = 0;
  const result = await runTurn({ messages: [], llm: { chat: async () => ({ text: '', toolCalls: llmCalls(20) }) }, runner: { availableTools: () => [tool()], run: async () => { runs++; return { ok: true, result: '结果' }; } }, toOpenAiTools: (value) => value });
  assert.equal(result.steps, MAX_STEPS);
  assert.equal(runs, MAX_STEPS);
  assert.equal(result.truncated, true);
});

test('每轮重新获取工具面，关闭后下一次模型请求不带搜索工具', async () => {
  let available = true;
  let rounds = 0;
  const result = await runTurn({ messages: [], llm: { chat: async (input) => {
    rounds++;
    if (rounds === 1) { assert.equal(input.tools.length, 1); return { text: '', toolCalls: llmCalls(1) }; }
    assert.equal(input.tools, undefined);
    return { text: '本轮不能再搜', toolCalls: [] };
  } }, runner: { availableTools: () => available ? [tool()] : [], run: async () => { available = false; return { ok: true, result: '结果' }; } }, toOpenAiTools: (value) => value });
  assert.equal(result.text, '本轮不能再搜');
});

test('回合预算到期硬取消慢搜索，并在预算内结束等待', async () => {
  let observed;
  const runner = createToolRunner({ tools: [tool({ run: ({ signal }) => {
    observed = signal;
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve('不回灌的迟到结果'), { once: true }));
  } })], context: context() });
  const started = Date.now();
  const result = await runTurn({ budgetMs: 30, messages: [], llm: { chat: async () => ({ text: '', toolCalls: llmCalls(1) }) }, runner, toOpenAiTools: (value) => value });
  assert.equal(result.truncated, true);
  assert.equal(result.cancelled, false);
  assert.equal(observed.aborted, true);
  assert.ok(Date.now() - started < 1000);
});
