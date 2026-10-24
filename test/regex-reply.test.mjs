/**
 * regex-reply 插件单元测试
 *
 * ## 边界
 *
 * **不启后端、不连 QQ、不调模型、不发真实消息。** 所有 `sendText` 都是假的，
 * 只记录"被调用了什么"。这样每个用例都能在毫秒级跑完，也能断言
 * "发送被调用了 0 次 / 1 次"这种最关键的边界 —— 而真实发送根本没法这么断言。
 *
 * ## 与宿主行为测试的分工
 *
 * 这个文件只测**插件自己**：判定顺序、模板、范围、冷却、限频、超时降级。
 * 宿主侧的 messagePriority 派发顺序、validateConfig 的落盘时机、
 * ConfirmRegistry 接线在 `test/regex-reply-host.test.mjs`。
 *
 * ## 为什么 evt 要手写形状
 *
 * 不用 `normalizeEvent` 造事件：那样测试就依赖了宿主的解析逻辑，
 * 一旦解析层改了字段名，插件测试会连着一起红 —— 而插件关心的只是
 * "宿主交给我的 evt 长什么样"。所以这里按 docs 里的形状直写，
 * 它同时也是"插件对外部输入的假设"的一份可执行文档。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import plugin from '../plugins/regex-reply/index.mjs';

/* ------------------------------------------------------------------ 工具 */

/**
 * 造一条与宿主一致的 `evt`。
 *
 * @param {string} text
 * @param {Record<string, any>} [over]
 * @returns {object}
 */
function makeEvt(text, over = {}) {
  return {
    kind: 'message',
    convKey: 'group:1001',
    isGroup: true,
    messageId: 'm1',
    sender: { userId: '2001', nickname: '小明' },
    text,
    atSelf: false,
    ...over,
  };
}

/** 默认 gate：全部放行、非自己、无待确认。 */
function makeGate(over = {}) {
  return { whitelisted: true, silenced: false, confirmPending: false, selfId: '9999', ...over };
}

/**
 * 把规则数组序列化成配置里的 `rules` 文本。
 *
 * @param {object[]} rules
 * @returns {string}
 */
function rulesJson(rules) {
  return JSON.stringify(rules);
}

/**
 * 造一个插件实例：临时 dataDir + 假 sendText + 收集日志。
 *
 * ## 为什么每个用例都要 init 再 dispose
 *
 * 插件内部是**模块级单例**（worker / 冷却表 / 限频器都是进程级资源）。
 * 不 dispose 的话，上一个用例的冷却记录会漏进下一个用例 ——
 * 那会让"冷却测试"变成偶发失败，而且失败原因完全看不出来。
 * 用 `t.after()` 保证即使断言失败也会收尾。
 *
 * @param {NodeJS.TestContext} t
 * @param {Record<string, any>} [overrides]
 * @returns {Promise<{
 *   ctx: object,
 *   sent: Array<{convKey: string, text: string}>,
 *   logs: Array<[string, string]>,
 *   sendText: (convKey: string, text: string) => Promise<any>,
 *   initResult: any,
 *   setSend: (fn: any) => void,
 * }>}
 */
async function makePlugin(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'regex-reply-test-'));

  /** @type {Array<{convKey: string, text: string}>} */
  const sent = [];
  /** @type {Array<[string, string]>} */
  const logs = [];

  /**
   * 当前的发送实现。测试可以在 init 之后替换它（例如模拟发送失败），
   * 而不必重建插件 —— 发送器不是 init 的一部分。
   *
   * @type {(convKey: string, text: string) => Promise<any>}
   */
  let sender = async (convKey, text) => {
    sent.push({ convKey, text });
    return { ok: true, messageId: `mid-${sent.length}` };
  };

  const config = {
    rules: '[]',
    enabled: true,
    defaultCooldownMs: 0,
    maxRepliesPerMinute: 6,
    maxRepliesPerHour: 60,
    maxInputLength: 500,
    matchTimeoutMs: 50,
    multiMatch: 'priority',
    replyOnSendFail: false,
    ...overrides,
  };

  const ctx = {
    plugin: {
      id: 'regex-reply',
      name: '正则回复',
      version: '1.0.0',
      dir: path.resolve('plugins/regex-reply'),
      dataDir,
      runtime: 'in-process',
    },
    config,
    secrets: {},
    dataDir,
    signal: new AbortController().signal,
    log: (level, message) => logs.push([String(level), String(message)]),
    /**
     * 兼容宿主给 init 的 ctx 上也带 sendText（见 PluginContext）。
     * 真正用哪个由用例传进 handleMessage 的那份决定。
     */
    sendText: (convKey, text) => sender(convKey, text),
  };

  const initResult = await plugin.init(ctx);

  t.after(async () => {
    await plugin.dispose(ctx);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  return {
    ctx,
    sent,
    logs,
    initResult,
    /** 每次 handleMessage 都要传的发送函数（这样测试能控制返回值） */
    sendText: (convKey, text) => sender(convKey, text),
    /** 替换发送实现（模拟失败/抛错） */
    setSend(fn) {
      sender = async (convKey, text) => {
        // 仍然记录"尝试发送过"，否则"失败时是否重试"就断言不了
        sent.push({ convKey, text });
        return fn(convKey, text);
      };
    },
  };
}

/* ---------------------------------------------------------------- 基础 */

test('命中规则：回复正确文本、返回 true、sendText 只调用一次', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
  });
  assert.equal(p.initResult.ok, true);

  const handled = await plugin.handleMessage({
    evt: makeEvt('你好'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, true);
  assert.deepEqual(p.sent, [{ convKey: 'group:1001', text: '你好呀' }]);
});

test('不命中：返回 false，sendText 一次都没被调用', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('随便聊聊'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, false);
  assert.equal(p.sent.length, 0);
});

/* ------------------------------------------------------------ 模板渲染 */

test('★ 捕获组替换：{1} {2} 命名组 {0} 与内置 {user}', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      {
        id: 'grp',
        pattern: '^echo (\\w+) (\\w+)$',
        // 一次覆盖四种写法，任何一处错位都会让整条断言失败
        reply: '1={1} 2={2} 0={0} user={user}',
      },
      {
        id: 'named',
        pattern: '^点歌 (?<song>.+)$',
        reply: '点了《{song}》，来自 {user}',
      },
    ]),
  });

  await plugin.handleMessage({
    evt: makeEvt('echo foo bar'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(p.sent[0].text, '1=foo 2=bar 0=echo foo bar user=小明');

  await plugin.handleMessage({
    evt: makeEvt('点歌 晴天'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(p.sent[1].text, '点了《晴天》，来自 小明');
});

test('越界捕获组与未知变量渲染成空串，且不会出现字面量 "undefined"', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      { id: 'gap', pattern: '^x$', reply: 'a={5} b={nosuch} c=[{0}]' },
      // (a)|(b) 匹配 a 时第 2 组是 undefined —— 必须变空串
      { id: 'alt', pattern: '^(a)|(b)$', reply: 'g1=[{1}] g2=[{2}]' },
    ]),
  });

  await plugin.handleMessage({
    evt: makeEvt('x'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(p.sent[0].text, 'a= b= c=[x]');

  await plugin.handleMessage({
    evt: makeEvt('a'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(p.sent[1].text, 'g1=[a] g2=[]');
});

test('{{ 与 }} 转义成字面量大括号', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'brace', pattern: '^b$', reply: '{{user}} 是字面量，{user} 才是变量' }]),
  });

  await plugin.handleMessage({
    evt: makeEvt('b'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(p.sent[0].text, '{user} 是字面量，小明 才是变量');
});

/* ---------------------------------------------------------------- 优先级 */

test('优先级：两条都命中时默认只回最高优先级那条', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      { id: 'low', pattern: '^hello$', reply: '来自低优先级', priority: 0 },
      { id: 'high', pattern: '^hello$', reply: '来自高优先级', priority: 100 },
    ]),
    multiMatch: 'priority',
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('hello'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, true);
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].text, '来自高优先级');
});

test('multiMatch: all 时按优先级顺序各回一条', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      { id: 'ra', pattern: '^hello$', reply: 'A', priority: 1 },
      { id: 'rb', pattern: '^hello$', reply: 'B', priority: 50 },
      { id: 'rc', pattern: '^hello$', reply: 'C', priority: 10 },
    ]),
    multiMatch: 'all',
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('hello'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, true);
  assert.deepEqual(
    p.sent.map((s) => s.text),
    ['B', 'C', 'A'],
  );
});

test('multiMatch: all 超过 3 条时按优先级截断到前 3 条', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      { id: 'r1', pattern: '^hello$', reply: 'R1', priority: 50 },
      { id: 'r2', pattern: '^hello$', reply: 'R2', priority: 40 },
      { id: 'r3', pattern: '^hello$', reply: 'R3', priority: 30 },
      { id: 'r4', pattern: '^hello$', reply: 'R4', priority: 20 },
      { id: 'r5', pattern: '^hello$', reply: 'R5', priority: 10 },
    ]),
    multiMatch: 'all',
  });

  await plugin.handleMessage({
    evt: makeEvt('hello'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.deepEqual(
    p.sent.map((s) => s.text),
    ['R1', 'R2', 'R3'],
  );
  // 被截断的事实必须留痕，否则"我配了五条怎么只回三条"无从排查
  assert.ok(
    p.logs.some(([level, msg]) => level === 'info' && msg.includes('r4') && msg.includes('r5')),
    '截断应当记一条 info 日志并列出被忽略的规则 id',
  );
});

/* ---------------------------------------------------------------- 范围 */

test('范围：scope.kinds 只允许 group 时私聊不命中', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      { id: 'only-group', pattern: '^hi$', reply: '群里才回', scope: { kinds: ['group'] } },
    ]),
  });

  const inGroup = await plugin.handleMessage({
    evt: makeEvt('hi'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(inGroup, true);

  const inPrivate = await plugin.handleMessage({
    evt: makeEvt('hi', { convKey: 'private:2001', isGroup: false }),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(inPrivate, false);
  assert.equal(p.sent.length, 1, '私聊那次一次都不该发');
});

test('范围：scope.ids 限定群号，其它群不命中', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'one-group', pattern: '^hi$', reply: '只在 1001', scope: { ids: ['1001'] } }]),
  });

  assert.equal(
    await plugin.handleMessage({
      evt: makeEvt('hi', { convKey: 'group:1001' }),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate(),
    }),
    true,
  );
  assert.equal(
    await plugin.handleMessage({
      evt: makeEvt('hi', { convKey: 'group:2002' }),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate(),
    }),
    false,
  );
  assert.equal(p.sent.length, 1);
});

test('范围：excludeIds 优先排除', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      // 全群生效，但排除 2002 —— 这正是"1 个群不开"的推荐写法
      { id: 'all-but-one', pattern: '^hi$', reply: 'hi', scope: { excludeIds: ['2002'] } },
    ]),
  });

  assert.equal(
    await plugin.handleMessage({
      evt: makeEvt('hi', { convKey: 'group:1001' }),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate(),
    }),
    true,
  );
  assert.equal(
    await plugin.handleMessage({
      evt: makeEvt('hi', { convKey: 'group:2002' }),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate(),
    }),
    false,
  );
  assert.equal(p.sent.length, 1);
});

test('范围：adminOnly 只在宿主明确给出 isAdmin === true 时生效（fail-closed）', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'admin', pattern: '^sudo$', reply: '管理员好', scope: { adminOnly: true } }]),
  });

  // gate 里没有 isAdmin（当前宿主就是这种形状）→ 不许生效
  assert.equal(
    await plugin.handleMessage({
      evt: makeEvt('sudo'),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate(),
    }),
    false,
  );

  // 明确不是管理员 → 不生效
  assert.equal(
    await plugin.handleMessage({
      evt: makeEvt('sudo'),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate({ isAdmin: false }),
    }),
    false,
  );

  // 明确是管理员 → 生效
  assert.equal(
    await plugin.handleMessage({
      evt: makeEvt('sudo'),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate({ isAdmin: true }),
    }),
    true,
  );
  assert.equal(p.sent.length, 1);
});

/* ---------------------------------------------------------------- 冷却 */

test('★ 冷却：同规则同会话第二条被跳过，不同会话/不同规则不受影响', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      { id: 'cd', pattern: '^hi$', reply: 'hi', cooldownMs: 60000 },
      { id: 'other', pattern: '^hi$', reply: 'other', priority: -10, cooldownMs: 60000 },
    ]),
    // 默认只回最高优先级那条；把 other 的优先级压到 -10，保证第一条回的是 cd
    multiMatch: 'priority',
  });

  const first = await plugin.handleMessage({
    evt: makeEvt('hi', { convKey: 'group:1001' }),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(first, true);
  assert.equal(p.sent.length, 1);

  // 同规则 + 同会话：冷却中 → 被跳过，且没有别的候选 → false
  const second = await plugin.handleMessage({
    evt: makeEvt('hi', { convKey: 'group:1001' }),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(second, false);
  assert.equal(p.sent.length, 1, '冷却期内不应再发');

  // 不同会话：不受影响
  const third = await plugin.handleMessage({
    evt: makeEvt('hi', { convKey: 'group:3003' }),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(third, true);
  assert.equal(p.sent.length, 2);
});

test('冷却：默认 defaultCooldownMs 生效（规则自己没写 cooldownMs）', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'cd', pattern: '^hi$', reply: 'hi' }]),
    defaultCooldownMs: 60000,
  });

  assert.equal(
    await plugin.handleMessage({ evt: makeEvt('hi'), sendText: p.sendText, ctx: p.ctx, gate: makeGate() }),
    true,
  );
  assert.equal(
    await plugin.handleMessage({ evt: makeEvt('hi'), sendText: p.sendText, ctx: p.ctx, gate: makeGate() }),
    false,
  );
  assert.equal(p.sent.length, 1);
});

test('冷却：只有发送成功才占用冷却位（失败不白吃冷却）', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'cd', pattern: '^hi$', reply: 'hi', cooldownMs: 60000 }]),
  });
  p.setSend(async () => ({ ok: false, code: 'E2030', message: '限流' }));

  const first = await plugin.handleMessage({
    evt: makeEvt('hi'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  // 发送失败也算已接管（不回退 AI）
  assert.equal(first, true);

  // 冷却位没被占 → 下一次仍然会尝试发送。
  // 这条断言直接钉住"失败不计入冷却"这个取舍。
  p.setSend(async () => ({ ok: true, messageId: 'x' }));
  const second = await plugin.handleMessage({
    evt: makeEvt('hi'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(second, true);
  assert.equal(p.sent.length, 2, '第一次失败不该占用冷却位');
});

/* ------------------------------------------------------------ 无效规则 */

test('★ 无效规则：validateConfig 指出第 2 条，init 也失败', async (t) => {
  const badRules = rulesJson([
    { id: 'ok', pattern: '^a$', reply: 'ok' },
    // 第 2 条：无 u 模式下合法、u 模式下非法的 identity escape
    { id: 'broken', pattern: '^a\\-b$', reply: 'x' },
    { id: 'ok2', pattern: '^c$', reply: 'ok2' },
  ]);

  const verdict = plugin.validateConfig({ rules: badRules });
  assert.equal(verdict.ok, false, '应判定为无效');
  assert.match(verdict.message, /第 2 条/, `message 必须能定位到第几条，实际：${verdict.message}`);
  assert.match(verdict.message, /broken/, 'message 还应带上规则的 id');

  // init 同样要失败，并且用 E4062（配置值不合法）
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'regex-reply-test-'));
  const ctx = {
    plugin: { id: 'regex-reply', name: '正则回复', version: '1.0.0', dir: '.', dataDir, runtime: 'in-process' },
    config: { rules: badRules },
    secrets: {},
    dataDir,
    signal: new AbortController().signal,
    log: () => {},
  };
  const r = await plugin.init(ctx);
  t.after(async () => {
    await plugin.dispose(ctx);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4062');
  assert.match(r.message, /第 2 条/);
});

test('无效规则：规则不是 JSON 时也明确报错（不是抛异常）', () => {
  const verdict = plugin.validateConfig({ rules: '{ 这不是 JSON' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /规则配置无效/);
});

test('validateConfig：数值项越界时独立报错', () => {
  const base = { rules: rulesJson([{ id: 'aa', pattern: '^a$', reply: 'a' }]) };

  const tooSmall = plugin.validateConfig({ ...base, maxRepliesPerMinute: 0 });
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.message, /maxRepliesPerMinute/);

  const tooBig = plugin.validateConfig({ ...base, matchTimeoutMs: 9999 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.message, /matchTimeoutMs/);

  const notInt = plugin.validateConfig({ ...base, maxInputLength: 1.5 });
  assert.equal(notInt.ok, false);
  assert.match(notInt.message, /整数/);

  const badEnum = plugin.validateConfig({ ...base, multiMatch: 'some' });
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.message, /multiMatch/);

  // 合法配置必须放行，且 message 里有条数
  const good = plugin.validateConfig(base);
  assert.equal(good.ok, true);
  assert.match(good.message, /规则 1 条/);
});

test('testConnection：不依赖 init，能报告条数与编译结果', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'regex-reply-test-'));
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));

  const ctx = {
    plugin: { id: 'regex-reply', name: '正则回复', version: '1.0.0', dir: '.', dataDir, runtime: 'in-process' },
    config: {
      rules: rulesJson([
        { id: 'aa', pattern: '^a$', reply: 'A' },
        { id: 'bb', pattern: '^b$', reply: 'B', enabled: false },
        { id: 'cc', pattern: '^c$', reply: 'C' },
      ]),
    },
    secrets: {},
    dataDir,
    signal: new AbortController().signal,
    log: () => {},
  };

  const r = await plugin.testConnection(ctx);
  assert.equal(r.ok, true);
  assert.equal(r.details.rules, 3);
  assert.equal(r.details.enabledRules, 2);
  assert.match(r.message, /启用 2 条/);

  // 空规则也是"能用"，但要明确告诉用户不会回任何消息
  const empty = await plugin.testConnection({ ...ctx, config: { rules: '[]' } });
  assert.equal(empty.ok, true);
  assert.match(empty.message, /规则为空/);
});

/* ----------------------------------------------------- 超时与有界匹配 */

test('★ 灾难性回溯：30ms 内返回 false、worker 重建后仍可用、同规则第二次被跳过表短路', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      // priority 更高，先跑，第一条消息就会卡在它上面
      { id: 'boom', pattern: '^(a+)+$', reply: '不该发出', priority: 100 },
      // 同一批里的正常规则，用来证明"重建之后还能工作"
      { id: 'ping', pattern: '^ping$', reply: 'pong' },
    ]),
    matchTimeoutMs: 30,
    maxRepliesPerMinute: 60,
    maxRepliesPerHour: 600,
  });

  const input = 'a'.repeat(40) + 'b';
  const startedAt = Date.now();
  const handled = await plugin.handleMessage({
    evt: makeEvt(input),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(handled, false, '超时必须降级为未命中');
  assert.ok(elapsed < 1000, `超时用例必须在 1s 内返回，实际 ${elapsed}ms`);
  assert.equal(p.sent.length, 0);
  assert.ok(
    p.logs.some(([level, msg]) => level === 'warn' && msg.includes('超时')),
    '超时必须有 warn 日志',
  );

  /*
   * 1) worker 已被 terminate 并重建：后续一条普通消息仍然正常工作。
   *
   * 这条断言防的是"超时之后插件彻底哑掉"——那比卡死更容易被忽略，
   * 因为初期只表现为"偶尔不回"。
   */
  const after = await plugin.handleMessage({
    evt: makeEvt('ping'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(after, true, 'worker 重建后应能正常工作');
  assert.equal(p.sent.at(-1).text, 'pong');

  /*
   * 2) 跳过表：同一条耗时规则第二次**不经过 worker** 就被跳过。
   *
   * 阈值取 30ms 是刻意的：如果没有跳过表，这一次仍会跑满超时预算
   * （≥30ms）；有跳过表时它应该几乎瞬时返回。
   */
  const againStart = Date.now();
  const again = await plugin.handleMessage({
    evt: makeEvt(input),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  const againElapsed = Date.now() - againStart;
  assert.equal(again, false);
  assert.ok(againElapsed < 30, `第二次应被跳过表短路（不经过 worker），实际 ${againElapsed}ms`);
});

/* ------------------------------------------------------------ 各种闸门 */

test('静音：gate.silenced 为 true 时返回 false 且不发送', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('你好'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate({ silenced: true }),
  });

  assert.equal(handled, false);
  assert.equal(p.sent.length, 0);
});

test('白名单：gate.whitelisted 为 false 时返回 false 且不发送', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('你好'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate({ whitelisted: false }),
  });

  assert.equal(handled, false);
  assert.equal(p.sent.length, 0);
});

test('自消息：sender.userId === gate.selfId 时返回 false', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('你好', { sender: { userId: '9999', nickname: '机器人自己' } }),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, false);
  assert.equal(p.sent.length, 0);
});

test('插件内 enabled: false 时静默（不发送、不接管）', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
    enabled: false,
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('你好'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, false);
  assert.equal(p.sent.length, 0);
});

test('★ 审批不被抢：confirmPending + 文本 "1" → false；同样的文本在没有待确认时命中 → true', async (t) => {
  const p = await makePlugin(t, {
    // 规则特意写成能匹配 "1"，用来证明是 gate 在起作用、不是规则写不出来
    rules: rulesJson([{ id: 'one', pattern: '^1$', reply: '收到 1' }]),
  });

  const blocked = await plugin.handleMessage({
    evt: makeEvt('1'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate({ confirmPending: true }),
  });
  assert.equal(blocked, false, '有待确认时不能抢确认形回复');
  assert.equal(p.sent.length, 0);

  const allowed = await plugin.handleMessage({
    evt: makeEvt('1'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate({ confirmPending: false }),
  });
  assert.equal(allowed, true, '没有待确认时同一条规则应当命中');
  assert.equal(p.sent.length, 1);
});

test('审批不被抢：有待确认但文本不像确认回复时仍正常工作', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^签到$', reply: '签到成功' }]),
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('签到'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate({ confirmPending: true }),
  });

  // 放宽只针对"形似确认"的文本：否则一张挂着的确认卡会让插件整体停摆
  assert.equal(handled, true);
  assert.equal(p.sent.length, 1);
});

test('★ 审批不被抢：DSH 审批形文本（是/否/yes/ok/3 同意）在有确认时也不接管', async (t) => {
  /*
   * 这条钉住的是"词表要覆盖两边用语"。
   *
   * 宿主 `gate.confirmPending` 只反映宿主确认表，而 dsh-bridge 在
   * "多条待审批、用户没带编号"时会把消息放回（返回 false），消息就落到
   * 本插件。如果词表只认 1/2/同意/拒绝，那么一条 `^是$` 的规则会把
   * 审批回复吃掉，用户以为批准了、实际什么都没发生。
   *
   * 这条断言在修复前会失败：`是` / `yes` / `ok` / `3 同意` 都不在旧词表里，
   * 规则命中并发送后返回 true。
   */
  const p = await makePlugin(t, {
    rules: rulesJson([
      { id: 'yes-no', pattern: '^(?:是|否|yes|no|ok)$', reply: '收到', priority: 10 },
      { id: 'num-verb', pattern: '^\\d+\\s*同意$', reply: '收到', priority: 10 },
    ]),
  });

  for (const text of ['是', '否', 'yes', 'no', 'ok', '3 同意', '同意 3']) {
    const handled = await plugin.handleMessage({
      evt: makeEvt(text),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate({ confirmPending: true }),
    });
    assert.equal(handled, false, `有待确认时不能接管「${text}」`);
  }
  assert.equal(p.sent.length, 0, '审批形文本一条都不能被正则回掉');

  // 没有待确认时，同样的文本仍按普通规则命中（证明拦截来自 gate，而不是规则写错）
  const allowed = await plugin.handleMessage({
    evt: makeEvt('是'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate({ confirmPending: false }),
  });
  assert.equal(allowed, true);
  assert.equal(p.sent.length, 1);
});

/* ------------------------------------------------------------ 发送失败 */

test('发送失败：返回 true（已接管，不回退 AI），且只调用一次（不重试）', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
  });
  p.setSend(async () => ({ ok: false, code: 'E2030', message: '发送过快' }));

  const handled = await plugin.handleMessage({
    evt: makeEvt('你好'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, true, '发送失败也算已接管：回退 AI 会导致用户收到两条');
  assert.equal(p.sent.length, 1, '不重试');
  assert.ok(
    p.logs.some(([level, msg]) => level === 'error' && msg.includes('E2030')),
    '失败必须记 error 日志（含闸门 code）',
  );
});

test('发送抛异常：同样返回 true、不重试', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
  });
  p.setSend(async () => {
    throw new Error('QQ 掉线了');
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('你好'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, true);
  assert.equal(p.sent.length, 1);
  assert.ok(p.logs.some(([level]) => level === 'error'));
});

test('replyOnSendFail: true 时补一条提示（仍然只算一次重试——其实是提示）', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
    replyOnSendFail: true,
  });
  let call = 0;
  p.setSend(async () => {
    call += 1;
    // 第一次（正文）失败，第二次（提示）成功
    return call === 1 ? { ok: false, code: 'E2020', message: '审计拦截' } : { ok: true, messageId: 'x' };
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('你好'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, true);
  assert.equal(p.sent.length, 2);
  assert.match(p.sent[1].text, /未发出/);
  assert.match(p.sent[1].text, /E2020/);
});

/* ---------------------------------------------------------------- 限频 */

test('限频：maxRepliesPerMinute 为 2 时第 3 条被跳过', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]),
    maxRepliesPerMinute: 2,
    maxRepliesPerHour: 100,
  });

  // 用不同的 convKey 绕开"规则级冷却"（默认 0，本来也不会拦），
  // 这样被拦下的只可能是全局限频
  const convKeys = ['group:1001', 'group:1002', 'group:1003'];
  /** @type {boolean[]} */
  const results = [];
  for (const convKey of convKeys) {
    results.push(
      await plugin.handleMessage({
        evt: makeEvt('你好', { convKey }),
        sendText: p.sendText,
        ctx: p.ctx,
        gate: makeGate(),
      }),
    );
  }

  assert.deepEqual(results, [true, true, false]);
  assert.equal(p.sent.length, 2);
  // 限频是"整条消息交给 AI"，不是静默丢弃 —— 日志里要能看出来
  assert.ok(p.logs.some(([, msg]) => msg.includes('E2030')));
});

/* ------------------------------------------------------------ 长度边界 */

test('回复超长：模板产出 > 4000 字时被截断且长度 ≤ 4000', async (t) => {
  /*
   * 怎么造出"超长回复"而又不违反模板本身的 1000 字上限：
   * 用 `{0}`（整条匹配）重复 20 次，模板自身只有 80 个字符，
   * 而输入 400 个 x 一渲染就是 8000 字。
   *
   * 直接写一段 5000 字的 reply 会被 parseRules 以 E_RULE_TEMPLATE 拒掉 ——
   * 那样测的就不是"截断"而是"校验"了。
   */
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'long', pattern: '^x+$', reply: '{0}'.repeat(20) }]),
    // 让 400 字的输入能进匹配
    maxInputLength: 500,
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('x'.repeat(400)),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, true);
  assert.equal(p.sent.length, 1);
  const sentText = p.sent[0].text;
  assert.ok(sentText.length <= 4000, `发送长度必须 ≤ 4000，实际 ${sentText.length}`);
  assert.ok(sentText.endsWith('…'), '截断要有可见痕迹');
  // 8000 → 4000，确实发生了截断
  assert.ok(sentText.length >= 3900, `截断应接近上限，实际 ${sentText.length}`);
});

test('输入超长：超过 maxInputLength 时不匹配', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'any', pattern: '\\d+', reply: '有数字' }]),
    maxInputLength: 20,
  });

  const short = await plugin.handleMessage({
    evt: makeEvt('123'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(short, true);

  const long = await plugin.handleMessage({
    // 里面有数字，但整条太长 → 不参与匹配
    evt: makeEvt(`${'a'.repeat(30)}123`),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });
  assert.equal(long, false);
  assert.equal(p.sent.length, 1);
});

/* ------------------------------------------------------------ 其它边界 */

test('非消息事件与空文本一律不接管', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'any', pattern: '.', reply: '不该发' }]),
  });

  assert.equal(
    await plugin.handleMessage({
      evt: makeEvt('你好', { kind: 'self-sent' }),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate(),
    }),
    false,
  );
  assert.equal(
    await plugin.handleMessage({
      evt: makeEvt('   '),
      sendText: p.sendText,
      ctx: p.ctx,
      gate: makeGate(),
    }),
    false,
  );
  assert.equal(p.sent.length, 0);
});

test('规则停用（enabled: false）时该条不参与，其它条正常', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([
      { id: 'off', pattern: '^hi$', reply: '停用的', priority: 100, enabled: false },
      { id: 'on', pattern: '^hi$', reply: '启用的', priority: 1 },
    ]),
  });

  const handled = await plugin.handleMessage({
    evt: makeEvt('hi'),
    sendText: p.sendText,
    ctx: p.ctx,
    gate: makeGate(),
  });

  assert.equal(handled, true);
  assert.deepEqual(
    p.sent.map((s) => s.text),
    ['启用的'],
  );
});

test('全部候选都因冷却被跳过时返回 false（交回 AI）', async (t) => {
  const p = await makePlugin(t, {
    rules: rulesJson([{ id: 'cd', pattern: '^hi$', reply: 'hi', cooldownMs: 60000 }]),
  });

  assert.equal(
    await plugin.handleMessage({ evt: makeEvt('hi'), sendText: p.sendText, ctx: p.ctx, gate: makeGate() }),
    true,
  );
  assert.equal(
    await plugin.handleMessage({ evt: makeEvt('hi'), sendText: p.sendText, ctx: p.ctx, gate: makeGate() }),
    false,
  );
});

test('dispose 之后 handleMessage 安全返回 false（不抛错）', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'regex-reply-test-'));
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));

  const ctx = {
    plugin: { id: 'regex-reply', name: '正则回复', version: '1.0.0', dir: '.', dataDir, runtime: 'in-process' },
    config: { rules: rulesJson([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]) },
    secrets: {},
    dataDir,
    signal: new AbortController().signal,
    log: () => {},
  };
  await plugin.init(ctx);
  await plugin.dispose(ctx);

  const handled = await plugin.handleMessage({
    evt: makeEvt('你好'),
    sendText: async () => ({ ok: true }),
    ctx,
    gate: makeGate(),
  });
  assert.equal(handled, false);
});
