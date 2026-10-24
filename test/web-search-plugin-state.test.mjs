/**
 * 插件与执行链的**状态口径** —— 内层失败不能被记成成功
 *
 * ## 为什么这一层要单独测
 *
 * `ctx.net` 的拒绝（E4070 / E4080）是**合法的工具结果**，不是异常：
 * 插件把 `{ok:false, code}` 交回宿主，模型需要看到"为什么没搜到"。
 *
 * 但"合法结果"不等于"调用成功"。如果执行链把内层失败记成成功：
 *
 *   · 调用流水与统计里看不到真实失败率（排查时永远"没有失败"）；
 *   · agent-loop 的 toolTrace 显示 ok，界面会把"被拒绝"画成绿色；
 *   · 取消（E4070）会被误当成完成，用户以为"点了停止，它还在跑"。
 *
 * 同时要守住**另一侧**：取消不能把插件标成 crashed、不能撤掉工具
 * （点一次停止不该把插件点坏），而一般业务错误也不该混进取消分支。
 *
 * 这里用真实 `PluginManager` 装配一个临时插件（清单从真实 web-search
 * 清单派生），只有插件行为是桩 —— 不联网、不读真实凭据、不碰 data/。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PluginManager } from '../src/plugins/manager.mjs';
import { createToolRunner } from '../src/tools/executor.mjs';
import { defineTool, getTool, removeToolsOfPlugin, _clearToolsForTest } from '../src/tools/registry.mjs';
import { ORIGIN } from '../src/guard/origin.mjs';
import { runTurn } from '../src/llm/agent-loop.mjs';
import { toOpenAiTools } from '../src/guard/tool-gate.mjs';
import { disabledNetTools } from '../src/net/view.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 真实清单（工具声明、参数形状直接复用，避免测试自定义一套假形状） */
const BASE_MANIFEST = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins/web-search/plugin.json'), 'utf8'));

/** 可信调用上下文（与 executor 的 makeInvocation 同形状） */
function invocationOf(tool) {
  return {
    pluginId: 'web-search',
    tool,
    origin: 'owner-private',
    convKey: 'private:10001',
    isGroup: false,
    requester: { id: '10001', nickname: '管理员' },
    messageId: null,
    replyToMessageId: null,
    callId: 'call_state_test',
    at: 1_700_000_000_000,
  };
}

/** 按脚本回话的假 LLM */
function scriptedLlm(steps) {
  /** @type {any[]} */
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(req) {
      calls.push({ messages: JSON.parse(JSON.stringify(req.messages)), tools: req.tools });
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return {
        text: step.text ?? '',
        toolCalls: step.toolCalls ?? [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false },
        model: 'fake',
        cancelled: false,
      };
    },
  };
}

/**
 * 在临时目录里铺一个"总是返回内层失败"的插件。
 *
 * @param {{root: string}} ws
 * @param {{id: string, toolName: string, toolIndex: number, code: string, message: string}} spec
 */
async function writeFixturePlugin(ws, spec) {
  const dir = path.join(ws.root, 'plugins', spec.id);
  await fs.mkdir(dir, { recursive: true });

  const tool = { ...BASE_MANIFEST.tools[spec.toolIndex], name: spec.toolName };
  const manifest = {
    ...BASE_MANIFEST,
    id: spec.id,
    name: `状态测试插件 ${spec.id}`,
    version: '1.0.0',
    description: '测试用插件：callTool 固定返回内层失败，不联网。',
    entry: 'index.mjs',
    // 配置与校验都置空：本测试只关心工具调用的状态口径
    config: [],
    validateConfig: false,
    tools: [tool],
  };
  delete manifest.notes;

  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    [
      'export default {',
      '  async init() { return { ok: true }; },',
      `  async callTool() { return { ok: false, code: ${JSON.stringify(spec.code)}, message: ${JSON.stringify(spec.message)} }; },`,
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

/**
 * 铺两个插件并真的加载起来：
 *   · cancel-fixture（工具 plugin_web_search）→ 内层 E4070
 *   · failure-fixture（工具 plugin_web_fetch）→ 内层 E4080
 */
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-web-state-'));
  const ws = { root };
  await writeFixturePlugin(ws, {
    id: 'cancel-fixture',
    toolName: 'web_search',
    toolIndex: 0,
    code: 'E4070',
    message: '这次调用已取消',
  });
  await writeFixturePlugin(ws, {
    id: 'failure-fixture',
    toolName: 'web_fetch',
    toolIndex: 1,
    code: 'E4080',
    message: '联网已关闭（测试用业务失败）',
  });

  const manager = new PluginManager({
    pluginsDir: path.join(root, 'plugins'),
    userDataRoot: path.join(root, 'user-data'),
    secretsPath: path.join(root, 'secrets.json'), // 不存在 = 空保险箱，不触发 DPAPI
    getConfig: () => ({
      network: { enabled: true },
      plugins: { enabled: ['cancel-fixture', 'failure-fixture'], config: {}, allowDangerous: false },
    }),
    persistConfig: async () => {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });

  _clearToolsForTest();
  const loaded = await manager.loadAll();
  assert.deepEqual(loaded.failed, [], `临时插件必须加载成功：${JSON.stringify(loaded)}`);
  return { ws, manager };
}

/** 清理：运行时、注册表、临时目录 */
async function teardown({ ws, manager }) {
  try {
    await manager.disposeAll();
  } catch {
    /* 忽略 */
  }
  _clearToolsForTest();
  await fs.rm(ws.root, { recursive: true, force: true });
}

/** 一个记录流水的最小 executor 上下文 */
function makeRunner(records) {
  return createToolRunner({
    policy: {},
    context: {
      origin: ORIGIN.OWNER_PRIVATE,
      convKey: 'private:10001',
      newCallId: () => 'call_state_test',
      onRecord: (rec) => records.push(rec),
      askConfirm: async () => 'allow', // R1 需要确认：这里模拟管理员点了同意
    },
  });
}

test.afterEach(() => {
  _clearToolsForTest();
});

test('★ 插件内层 E4070：manager 包装后 tool.run 外层是 {ok:false, code:E4070}', async () => {
  const ctx = await setup();
  try {
    const tool = getTool('plugin_web_search');
    assert.ok(tool, '临时插件应登记出 plugin_web_search');

    // 直接观察 manager 包装层的返回值（executor 拿到的就是它）
    const wrapped = await tool.run({
      args: { query: 'x' },
      origin: ORIGIN.OWNER_PRIVATE,
      convKey: 'private:10001',
      invocation: invocationOf('plugin_web_search'),
    });
    assert.equal(wrapped.ok, false, '内层取消必须提升成外层失败（不能是"成功但结果是失败"）');
    assert.equal(wrapped.code, 'E4070', `外层应带内层码 E4070，实际 ${wrapped.code}`);

    // 走完整执行链：不得记成成功
    const records = [];
    const runner = makeRunner(records);
    const out = await runner.run('plugin_web_search', { query: 'x' });
    const payload = out.ok === true ? out.result : out;
    assert.equal(payload?.ok, false, '执行链最终结果不得是 ok:true');
    assert.equal(payload?.code, 'E4070');

    const rec = records.at(-1);
    assert.ok(rec, '必须有调用记录');
    assert.ok(rec.failed === true || rec.cancelled === true, '调用记录不得记成成功（应有 failed/cancelled 标记）');
    assert.equal(String(rec.code ?? ''), 'E4070', '调用记录应带 E4070');

    const record = ctx.manager.records.get('cancel-fixture');
    assert.equal(record.status, 'ready', '取消不该把插件标成 crashed');
    assert.equal(getTool('plugin_web_search') !== undefined, true, '取消不该撤掉工具');
  } finally {
    await teardown(ctx);
  }
});

test('★ 插件一般业务错误（E4080）：记录标 failed + 带内层码，但不进取消分支', async () => {
  const ctx = await setup();
  try {
    const records = [];
    const runner = makeRunner(records);
    const out = await runner.run('plugin_web_fetch', { url: 'https://example.com/' });
    const payload = out.ok === true ? out.result : out;
    assert.equal(payload?.ok, false, '业务失败不得被包装成成功结果');
    assert.equal(payload?.code, 'E4080', '内层码必须保留给模型');

    const rec = records.at(-1);
    assert.equal(rec.failed, true, '一般业务错误要标 failed');
    assert.equal(rec.code, 'E4080');
    assert.equal(rec.cancelled ?? false, false, '业务错误不是取消');

    const record = ctx.manager.records.get('failure-fixture');
    assert.equal(record.status, 'ready', '业务错误不该把插件标成 crashed');
  } finally {
    await teardown(ctx);
  }
});

test('★ agent-loop 的 toolTrace 必须把业务失败记为 ok:false 且带内层码', async () => {
  const ctx = await setup();
  try {
    const runner = makeRunner([]);
    const llm = scriptedLlm([
      { toolCalls: [{ id: 'c1', name: 'plugin_web_fetch', arguments: JSON.stringify({ url: 'https://example.com/' }) }] },
      { text: '这次没能联网。' },
    ]);
    const res = await runTurn({
      llm,
      runner,
      toOpenAiTools,
      messages: [{ role: 'user', content: '读一下这个网页' }],
      budgetMs: 5000,
    });

    assert.equal(res.steps, 1);
    assert.equal(res.toolTrace.length, 1);
    assert.equal(res.toolTrace[0].ok, false, 'toolTrace 不得把业务失败记成成功');
    assert.equal(res.toolTrace[0].code, 'E4080', 'toolTrace 的 code 应为内层码');

    // 回灌的消息里也要让模型看到错误码
    const toolMsg = llm.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '失败同样要回灌 tool 消息');
    assert.match(String(toolMsg.content), /E4080/, 'tool 消息应包含内层错误码');
  } finally {
    await teardown(ctx);
  }
});

test('★ 同一个 runner 内关闸后：下一次 availableTools 为空（policy 现算）', async () => {
  _clearToolsForTest();
  defineTool({
    name: 'plugin_web_search',
    description: '联网搜索（测试用）',
    kind: 'host',
    risk: 'R1',
    confirm: 'never',
    origins: [ORIGIN.OWNER_PRIVATE, ORIGIN.CONSOLE],
    params: { query: { type: 'string', required: true } },
    plugin: 'web-search',
    run: async () => ({ ok: true, results: [] }),
  });

  /** policy 是普通对象：runner 每次可用性判定都必须**现读**它 */
  const policy = {};
  const runner = makeRunner([]);
  const dynamic = createToolRunner({
    policy,
    context: { origin: ORIGIN.OWNER_PRIVATE, convKey: 'private:1', newCallId: () => 'c', onRecord: () => {} },
  });
  assert.equal(dynamic.availableTools().length, 1, '开闸时工具可见');

  // 关闸：把联网工具加进禁用名单（与 index.mjs 的 toolPolicy 同一份语义）
  policy.disabledTools = disabledNetTools({ network: { enabled: false } });
  assert.equal(dynamic.availableTools().length, 0, '同一个 runner 内关闸后，下一次调用必须看不到工具（policy 现算）');

  const out = await dynamic.run('plugin_web_search', { query: 'x' });
  assert.equal(out.ok, false, '关闸后即使硬调也拒绝');
  assert.equal(out.code, 'E4032');

  // 同一个 runner 还在，开闸应恢复（不需要重建 runner）
  policy.disabledTools = null;
  assert.equal(dynamic.availableTools().length, 1, '开闸后同一 runner 应恢复可见');

  assert.ok(runner, 'sanity');
  _clearToolsForTest();
});

test('★ 停用插件后旧 runner 立刻看不到工具、也调不到', async () => {
  const ctx = await setup();
  try {
    const records = [];
    const runner = makeRunner(records);
    assert.deepEqual(
      runner.availableTools().map((t) => t.name).sort(),
      ['plugin_web_fetch', 'plugin_web_search'],
      '停用前两个工具都可见',
    );

    await ctx.manager.disable('cancel-fixture');
    assert.equal(getTool('plugin_web_search'), undefined, '停用后工具必须从注册表注销');
    assert.deepEqual(
      runner.availableTools().map((t) => t.name),
      ['plugin_web_fetch'],
      '旧 runner 不得回退到已停用插件的工具',
    );

    const out = await runner.run('plugin_web_search', { query: 'x' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'E4032', '停用后的旧名字应按"工具不存在"拒绝');
  } finally {
    await teardown(ctx);
  }
});
