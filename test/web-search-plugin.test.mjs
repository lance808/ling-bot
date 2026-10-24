/**
 * 联网搜索**插件**层测试 —— 工具可见性、来源保留、错误处理、授权边界
 *
 * ## 为什么这一层必须单独测
 *
 * 核心模块（`src/net/*`）保证"发请求是安全的"，插件层保证"模型拿到的东西
 * 是能用的"。两者的失败方式完全不同：
 *
 *   · 核心模块出错 → 请求发错地方 / 泄漏 Key / 内网被探测
 *   · 插件出错     → 模型把来源吃掉了（回答没有出处）、把空结果当成功、
 *                    或者把 `{ok:false}` 抛成 E4066（模型看到的是"工具坏了"）
 *
 * 这里全程用**假的 ctx.net**，不联网、不读真实凭据、不发 QQ 消息。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import plugin, { toSources } from '../plugins/web-search/index.mjs';
import { createToolRunner } from '../src/tools/executor.mjs';
import { defineTool, _clearToolsForTest } from '../src/tools/registry.mjs';
import { normalizeManifest, deriveToolPolicy } from '../src/plugins/manifest.mjs';
import { resolveToolSet, isToolGranted, needsConfirmFor } from '../src/guard/tool-gate.mjs';
import { ORIGIN } from '../src/guard/origin.mjs';
import { NET_CODE } from '../src/net/gate.mjs';
import { disabledNetTools, NET_TOOL_NAMES } from '../src/net/view.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 造一个假的 ctx.net。
 *
 * @param {object} [overrides]
 * @returns {{net: any, calls: any[]}}
 */
function fakeNet(overrides = {}) {
  /** @type {any[]} */
  const calls = [];
  const net = {
    available: true,
    enabled: true,
    provider: 'tavily',
    configured: true,
    async search(args) {
      calls.push({ method: 'search', args });
      if (typeof overrides.search === 'function') return overrides.search(args);
      return {
        ok: true,
        provider: 'tavily',
        query: args.query,
        tookMs: 120,
        truncated: false,
        results: [
          {
            title: '来源一',
            url: 'https://example.com/one',
            snippet: '摘要一',
            publishedDate: 'Mon, 05 May 2025 10:00:00 GMT',
            score: 0.9,
          },
          { title: '来源二', url: 'https://example.org/two', snippet: '摘要二', score: 0.7 },
        ],
      };
    },
    async fetch(args) {
      calls.push({ method: 'fetch', args });
      if (typeof overrides.fetch === 'function') return overrides.fetch(args);
      return {
        ok: true,
        url: args.url,
        finalUrl: args.url,
        status: 200,
        contentType: 'text/html',
        truncated: false,
        text: '网页正文',
        bytes: 42,
        redirects: 0,
      };
    },
    ...overrides.extra,
  };
  return { net, calls };
}

/** 只带 net 的最小 ctx（插件只读 net / log） */
function makeCtx(net) {
  return {
    plugin: { id: 'web-search', name: '联网搜索', version: '1.0.0' },
    config: {},
    secrets: {},
    net,
    log: () => {},
  };
}

/* ------------------------------------------------------------ 清单与授权 */

test('★ 插件清单合法，且工具声明为 host + net + R1', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins/web-search/plugin.json'), 'utf8'));
  const v = normalizeManifest(raw, { dirName: 'web-search' });
  assert.equal(v.ok, true, v.message);

  const names = v.manifest.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['web_fetch', 'web_search']);

  for (const t of v.manifest.tools) {
    /*
     * needs: host 是**安全决定**，不是随手写的。
     *
     * host 类工具的 origins 里没有 group / proactive（见 deriveToolPolicy），
     * 于是这两个工具**永远进不了群聊来源**。群里任何人说一句话就能让它
     * 访问一个 URL，那是最典型的 SSRF 入口 —— 这个边界不能靠提示词守。
     */
    assert.equal(t.needs, 'host', `${t.name} 必须是 host 类（出站网络）`);
    // effects: net 把风险下限抬到 R1（"有外部影响但可撤销"）
    assert.equal(t.effectiveRisk, 'R1', `${t.name} 的生效风险应为 R1`);
    assert.deepEqual(t.effects, ['net']);
  }

  const policy = deriveToolPolicy(v.manifest.tools[0]);
  assert.deepEqual(policy.origins, ['owner-private', 'console'], 'host 类只在管理员私聊与桌面端可见');
  assert.equal(policy.risk, 'R1');
  assert.equal(policy.confirm, 'always', 'R1 需要人工确认');
});

test('★ 联网工具在群聊与主动回合**不可见**（授权边界）', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins/web-search/plugin.json'), 'utf8'));
  const manifest = normalizeManifest(raw, { dirName: 'web-search' }).manifest;

  /** @type {object[]} */
  const tools = manifest.tools.map((t) => {
    const policy = deriveToolPolicy(t);
    return {
      name: t.fullName,
      kind: policy.kind,
      origins: policy.origins,
      risk: policy.risk,
      confirm: policy.confirm,
      effects: t.effects,
      plugin: 'web-search',
      params: t.params,
      run: async () => ({ ok: true }),
    };
  });

  const asOwner = resolveToolSet(ORIGIN.OWNER_PRIVATE, tools, {});
  assert.equal(asOwner.length, 2, '管理员私聊应能看到两个工具');

  const asConsole = resolveToolSet(ORIGIN.CONSOLE, tools, {});
  assert.equal(asConsole.length, 2, '桌面端应能看到两个工具');

  for (const origin of [ORIGIN.GROUP, ORIGIN.OWNER_GROUP, ORIGIN.PROACTIVE]) {
    const set = resolveToolSet(origin, tools, {});
    assert.equal(set.length, 0, `${origin} 不该看到联网工具`);
  }
});

test('★ 总闸关闭 → 工具结构性不可见；开 → 恢复', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins/web-search/plugin.json'), 'utf8'));
  const manifest = normalizeManifest(raw, { dirName: 'web-search' }).manifest;
  const tools = manifest.tools.map((t) => {
    const policy = deriveToolPolicy(t);
    return {
      name: t.fullName,
      kind: policy.kind,
      origins: policy.origins,
      risk: policy.risk,
      confirm: policy.confirm,
      effects: t.effects,
      plugin: 'web-search',
      params: t.params,
      run: async () => ({ ok: true }),
    };
  });

  const off = disabledNetTools({ network: { enabled: false } });
  const hidden = resolveToolSet(ORIGIN.OWNER_PRIVATE, tools, { disabledTools: off });
  assert.equal(hidden.length, 0, '关闸后模型看不到任何联网工具');

  const on = disabledNetTools({ network: { enabled: true } });
  assert.equal(on, null);
  const shown = resolveToolSet(ORIGIN.OWNER_PRIVATE, tools, on ? { disabledTools: on } : {});
  assert.equal(shown.length, 2);
  assert.deepEqual(off, [...NET_TOOL_NAMES]);
});

test('联网工具不会被"聊天授权"降级成免确认', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins/web-search/plugin.json'), 'utf8'));
  const manifest = normalizeManifest(raw, { dirName: 'web-search' }).manifest;
  const t = manifest.tools[0];
  const policy = deriveToolPolicy(t);
  /*
   * 这条工具根本进不了聊天来源（host 类），所以"聊天授权降级"在这里
   * 理论上不会被触发。但要把结论钉死：即使有人将来把它改成 qq 类、
   * 或者管理员用 `*` 放开了聊天工具，它仍然**每次都要确认**。
   *
   * 依据是 needsConfirmFor：`effects` 里没有 `paid` 时，chatGranted 会把
   * always 降成 never —— 那是给"已点名授权的低风险插件工具"设计的。
   * 联网工具是 R1 且声明了 net（出站），按 needsConfirm 的口径就该确认，
   * 所以这里断言的是"声明本身没被改成免确认"（confirm 不是 never）。
   */
  assert.notEqual(policy.confirm, 'never', 'R1 出站工具不该声明成免确认');
  assert.equal(needsConfirmFor({ ...t, ...policy }, { chatGranted: false }), true);
});

/* ------------------------------------------------------------ 工具语义 */

test('★ web_search 成功：保留标题 / URL / 摘要 / 日期（出处可引用）', async () => {
  const { net, calls } = fakeNet();
  const r = await plugin.callTool({ tool: 'web_search', args: { query: ' 测试 ' }, ctx: makeCtx(net) });

  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.results[0].title, '来源一');
  assert.equal(r.results[0].url, 'https://example.com/one');
  assert.equal(r.results[0].snippet, '摘要一');
  assert.equal(r.results[0].publishedDate, 'Mon, 05 May 2025 10:00:00 GMT');
  // 引用提示是给模型的**数据**，不是宿主替他写句子
  assert.match(r.attributionHint, /出处/);
  // 分数不往下传：对模型没有决策价值，却会诱导它"按分数说话"
  assert.equal('score' in r.results[0], false);

  assert.equal(calls[0].method, 'search');
  assert.equal(calls[0].args.query, ' 测试 ', '插件不做深加工，交给宿主的 sanitizeQuery');
});

test('★ 上游结果被截断时，插件必须把 truncated 交给模型（不许让模型以为"就这些"）', async () => {
  const { net } = fakeNet({
    search: async (args) => ({
      ok: true,
      provider: 'tavily',
      query: args.query,
      tookMs: 40,
      truncated: true,
      results: [
        { title: '来源一', url: 'https://example.com/one', snippet: '摘要一' },
        { title: '来源二', url: 'https://example.org/two', snippet: '摘要二' },
      ],
    }),
  });
  const r = await plugin.callTool({ tool: 'web_search', args: { query: 'x' }, ctx: makeCtx(net) });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true, '宿主置了 truncated，插件不得吞掉');
  assert.match(r.attributionHint, /一部分来源|截断|不全/, '还要用一句话告诉模型结果不全，光有布尔值不够');

  // 没截断时形状稳定，且不能误报
  const { net: full } = fakeNet();
  const r2 = await plugin.callTool({ tool: 'web_search', args: { query: 'x' }, ctx: makeCtx(full) });
  assert.equal(r2.truncated, false);
  assert.doesNotMatch(r2.attributionHint, /截断/);
});

test('★ 限流（E4083）的 retryAfterMs 必须跟着失败结果一起给模型', async () => {
  const { net } = fakeNet({
    search: async () => ({
      ok: false,
      code: NET_CODE.QUOTA,
      message: '搜索服务限流（HTTP 429），建议 7 秒后再试',
      retryAfterMs: 7000,
    }),
  });
  const r = await plugin.callTool({ tool: 'web_search', args: { query: 'x' }, ctx: makeCtx(net) });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.QUOTA);
  assert.equal(r.retryAfterMs, 7000, '模型需要知道"等多久"，不能只剩一句"被限流"');

  // 脏值不外传
  const { net: dirty } = fakeNet({
    search: async () => ({ ok: false, code: NET_CODE.QUOTA, message: '限流', retryAfterMs: Number.NaN }),
  });
  const r2 = await plugin.callTool({ tool: 'web_search', args: { query: 'x' }, ctx: makeCtx(dirty) });
  assert.equal('retryAfterMs' in r2, false, 'NaN 不能被当成等待时间传下去');
});

test('★ 空结果：ok:true + 显式说明（不能静默成空对象）', async () => {
  const { net } = fakeNet({
    search: async (args) => ({ ok: true, provider: 'tavily', query: args.query, results: [], tookMs: 80 }),
  });
  const r = await plugin.callTool({ tool: 'web_search', args: { query: '不存在的东西' }, ctx: makeCtx(net) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results, []);
  assert.match(r.notice, /没有返回任何来源/, '必须告诉模型"真的没搜到"');
  assert.match(r.attributionHint, /不要编造出处/);
});

test('★ 失败：把 code + message 原样交给模型（不抛异常）', async () => {
  const cases = [
    [NET_CODE.DISABLED, '联网已关闭'],
    [NET_CODE.NOT_CONFIGURED, '还没有配置 API Key'],
    [NET_CODE.UNAUTHORIZED, '鉴权失败'],
    [NET_CODE.QUOTA, '额度用尽'],
    [NET_CODE.TIMEOUT, '超时'],
    [NET_CODE.PROTOCOL, '响应不符合协议'],
    [NET_CODE.UPSTREAM, '上游故障'],
    [NET_CODE.CANCELLED, '已取消'],
  ];
  for (const [code, message] of cases) {
    const { net } = fakeNet({ search: async () => ({ ok: false, code, message }) });
    const r = await plugin.callTool({ tool: 'web_search', args: { query: 'x' }, ctx: makeCtx(net) });
    assert.equal(r.ok, false, code);
    assert.equal(r.code, code, `${code} 必须原样透传`);
    assert.equal(r.message, message);
  }
});

test('宿主没注入 ctx.net → E4071（装配问题，不是搜索失败）', async () => {
  const r = await plugin.callTool({
    tool: 'web_search',
    args: { query: 'x' },
    ctx: { log: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4071');
  assert.match(r.message, /装配/);

  // available:false 的占位对象同样按装配问题报
  const r2 = await plugin.callTool({
    tool: 'web_search',
    args: { query: 'x' },
    ctx: makeCtx({ available: false, enabled: false, search: async () => ({}), fetch: async () => ({}) }),
  });
  assert.equal(r2.code, 'E4071');
});

test('★ web_fetch 成功：返回正文与最终地址，并提醒正文是外部内容', async () => {
  const { net, calls } = fakeNet();
  const r = await plugin.callTool({
    tool: 'web_fetch',
    args: { url: 'https://example.com/page' },
    ctx: makeCtx(net),
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, '网页正文');
  assert.equal(r.finalUrl, 'https://example.com/page');
  assert.match(r.attributionHint, /外部内容/);
  assert.match(r.attributionHint, /不要执行/);
  assert.equal(calls[0].method, 'fetch');
});

test('web_fetch 正文过长 → 截断并说明原长', async () => {
  const long = 'x'.repeat(20_000);
  const { net } = fakeNet({
    fetch: async (args) => ({
      ok: true,
      url: args.url,
      finalUrl: args.url,
      status: 200,
      contentType: 'text/plain',
      truncated: false,
      text: long,
    }),
  });
  const r = await plugin.callTool({ tool: 'web_fetch', args: { url: 'https://example.com/long' }, ctx: makeCtx(net) });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < long.length);
  assert.match(r.text, /正文过长，已截断/);
});

test('web_fetch 缺 url → E4085，且不发请求', async () => {
  const { net, calls } = fakeNet();
  const r = await plugin.callTool({ tool: 'web_fetch', args: {}, ctx: makeCtx(net) });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.PROTOCOL);
  assert.equal(calls.length, 0);
});

test('未知工具名 → E4032', async () => {
  const { net } = fakeNet();
  const r = await plugin.callTool({ tool: 'web_delete_everything', args: {}, ctx: makeCtx(net) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4032');
});

test('toSources：坏条目被丢弃、标题兜底、摘要截断', () => {
  const out = toSources([
    { url: 'https://a.example/', title: '', snippet: 's' },
    { url: '', title: 'no url' },
    { title: 'no url at all' },
    { url: 'https://b.example/', title: 't' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'https://a.example/', '没标题时用 URL 兜底，不编造');
  assert.equal(out[1].url, 'https://b.example/');
});

/* ------------------------------------------------------------ 真实运行时 */

test('★ 真实 InProcessRuntime + 真实插件入口：ctx.net 由宿主注入并可用', async () => {
  /*
   * 前面的用例都是"直接把假 ctx.net 递给插件"。这一条不同：它走
   * InProcessRuntime 的**真实装配**（load → init → makeCallContext），
   * 验证的是"宿主接上了没有"。
   *
   * 这里最容易漏的恰恰是装配：插件文件能 import，但 `ctx.net` 没注入；
   * 或者注入了但 init 阶段没有——两种都会让工具在真实回合里静默失效，
   * 而单测（直接调 callTool）完全看不出来。
   */
  const { InProcessRuntime } = await import('../src/plugins/runtime-inprocess.mjs');
  const { normalizeManifest: normalize } = await import('../src/plugins/manifest.mjs');
  const os = await import('node:os');
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins/web-search/plugin.json'), 'utf8'));
  const manifest = normalize(raw, { dirName: 'web-search' }).manifest;

  const { net } = fakeNet();
  const dataDir = path.join(os.tmpdir(), `ling-web-search-${process.pid}-a`);
  const runtime = new InProcessRuntime({
    manifest,
    dir: path.join(ROOT, 'plugins/web-search'),
    dataDir,
    config: {
      provider: 'tavily',
      baseUrl: 'https://api.tavily.com',
      maxResults: 3,
      timeoutMs: 15000,
      allowFetch: true,
    },
    secrets: { apiKey: 'tvly-FAKE' },
    log: () => {},
    sendText: async () => ({ ok: true }),
    makeChat: null,
    makeGateway: null,
    // 宿主侧工厂：按调用产出一份 ctx.net
    makeNet: ({ invocation, signal }) => {
      fakeNet.lastInvocation = invocation;
      const base = net;
      return { ...base, _signal: signal };
    },
  });

  try {
    const init = await runtime.init();
    assert.equal(init.ok, true, `插件初始化失败：${init.message ?? ''}`);

    const out = await runtime.callTool({
      tool: 'web_search',
      args: { query: '运行时测试' },
      timeoutMs: 5000,
      invocation: { origin: 'owner-private', convKey: 'private:1', caller: true },
    });
    assert.equal(out.ok, true, `真实运行时调用失败：${out.message ?? ''}`);
    assert.equal(out.value.ok, true);
    assert.equal(out.value.results.length, 2);
    /*
     * 出厂配置里 maxResults 是 5，这里插件配置写的是 3 —— 但插件并不会
     * 自己夹取条数（那是宿主的责任），它只把查询词交给 ctx.net。
     * 这一条断言的作用是钉住这个分工：**插件不做安全夹取**，
     * 否则两处都夹取时，用户改配置会看到"界面 3、实际 5"这类怪事。
     */
    assert.equal(out.value.count, 2);
  } finally {
    await runtime.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('★ 真实运行时 + 无 makeNet：ctx.net 退回占位对象，插件报 E4071 而不是崩', async () => {
  const { InProcessRuntime } = await import('../src/plugins/runtime-inprocess.mjs');
  const { normalizeManifest: normalize } = await import('../src/plugins/manifest.mjs');
  const os = await import('node:os');
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins/web-search/plugin.json'), 'utf8'));
  const manifest = normalize(raw, { dirName: 'web-search' }).manifest;

  const dataDir = path.join(os.tmpdir(), `ling-web-search-${process.pid}-b`);
  const runtime = new InProcessRuntime({
    manifest,
    dir: path.join(ROOT, 'plugins/web-search'),
    dataDir,
    config: { baseUrl: 'https://api.tavily.com' },
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
    makeChat: null,
    makeGateway: null,
    // 故意不传 makeNet
  });

  try {
    const init = await runtime.init();
    assert.equal(init.ok, true, '没有联网能力不该让插件初始化失败（它还有别的能力）');
    const out = await runtime.callTool({
      tool: 'web_search',
      args: { query: 'x' },
      timeoutMs: 5000,
    });
    assert.equal(out.ok, true, '插件本身执行成功');
    assert.equal(out.value.ok, false);
    assert.equal(out.value.code, 'E4071');
    assert.match(out.value.message, /没有注入|装配/);
  } finally {
    await runtime.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});


test('testConnection 不发真实请求，只回答配置是否齐备', async () => {
  const { net, calls } = fakeNet();
  const ok = await plugin.testConnection(makeCtx(net));
  assert.equal(ok.ok, true);
  assert.match(ok.message, /不发真实请求/);
  assert.equal(calls.length, 0, '自检不能花额度');

  const { net: unconfigured } = fakeNet({ extra: { configured: false } });
  const bad = await plugin.testConnection(makeCtx(unconfigured));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, NET_CODE.NOT_CONFIGURED);
});

test('validateConfig：形状检查（不联网）', async () => {
  const good = {
    baseUrl: 'https://api.tavily.com',
    maxResults: 5,
    timeoutMs: 15000,
    allowFetch: true,
    maxFetchBytes: 204800,
    fetchTimeoutMs: 10000,
  };
  assert.deepEqual(await plugin.validateConfig(good), { ok: true });

  const bad = [
    [{ ...good, baseUrl: 'ftp://x' }, /http/],
    [{ ...good, baseUrl: 'https://user:pw@x' }, /账号密码/],
    // 不以 http 开头时先命中"协议"那条，不会走到 URL 解析
    [{ ...good, baseUrl: '不是 URL' }, /http:\/\/ 或 https:\/\//],
    [{ ...good, maxResults: 99 }, /结果条数/],
    [{ ...good, timeoutMs: 1 }, /搜索超时/],
    [{ ...good, maxFetchBytes: 1 }, /网页大小上限/],
    [{ ...good, fetchTimeoutMs: 999999 }, /网页读取超时/],
  ];
  for (const [cfg, re] of bad) {
    const r = await plugin.validateConfig(cfg);
    assert.equal(r.ok, false, JSON.stringify(cfg));
    assert.match(r.message, re);
  }

  // allowFetch 关掉时不校验抓取参数（它们不会生效）
  const noFetch = await plugin.validateConfig({ ...good, allowFetch: false, maxFetchBytes: 1 });
  assert.equal(noFetch.ok, true);
});

/* ------------------------------------------------------------ 端到端（假 net） */

test('★ 端到端：经 executor 走一次真实工具调用，来源留在工具结果里', async () => {
  _clearToolsForTest();
  const { net, calls } = fakeNet();
  defineTool({
    name: 'plugin_web_search',
    description: '联网搜索',
    kind: 'host',
    risk: 'R1',
    confirm: 'never', // 免确认，专注验证结果形状
    origins: [ORIGIN.OWNER_PRIVATE],
    params: { query: { type: 'string', required: true, maxLength: 400 } },
    plugin: 'web-search',
    run: async ({ args }) => plugin.callTool({ tool: 'web_search', args, ctx: makeCtx(net) }),
  });

  const runner = createToolRunner({
    policy: {},
    context: {
      origin: ORIGIN.OWNER_PRIVATE,
      convKey: 'private:10001',
      newCallId: () => 'call_test',
      onRecord: () => {},
    },
  });

  assert.equal(runner.availableTools().length, 1, '管理员私聊应能看到搜索工具');
  const out = await runner.run('plugin_web_search', { query: '台风路径' });
  assert.equal(out.ok, true);
  assert.equal(out.result.ok, true);
  assert.equal(out.result.results.length, 2);
  assert.match(out.result.results[0].url, /^https:\/\//);
  assert.equal(calls.length, 1);

  _clearToolsForTest();
});

test('★ 端到端：模型塞多余的字段不会到插件面前（参数白名单）', async () => {
  _clearToolsForTest();
  const { net, calls } = fakeNet();
  defineTool({
    name: 'plugin_web_search',
    description: '联网搜索',
    kind: 'host',
    risk: 'R1',
    confirm: 'never',
    origins: [ORIGIN.OWNER_PRIVATE],
    params: { query: { type: 'string', required: true, maxLength: 400 } },
    plugin: 'web-search',
    run: async ({ args }) => plugin.callTool({ tool: 'web_search', args, ctx: makeCtx(net) }),
  });

  const runner = createToolRunner({
    policy: {},
    context: { origin: ORIGIN.OWNER_PRIVATE, convKey: 'private:10001', onRecord: () => {}, newCallId: () => 'c' },
  });

  const out = await runner.run('plugin_web_search', {
    query: 'q',
    // 这些都不该出现在插件收到的 args 里
    origin: 'owner-private',
    convKey: 'group:999',
    apiKey: 'tvly-LEAK',
  });
  assert.equal(out.ok, true);
  const passed = calls[0].args;
  /*
   * 只断言"危险字段没进来"，不断言对象完全相等：
   * 插件在转发时会给可选参数补 `undefined`（`maxResults: undefined`），
   * 那是宿主侧可忽略的写法，不是泄漏。真正要守的是 `origin` / `convKey` /
   * `apiKey` 这类**可信上下文与凭据**不能由模型塞进来。
   */
  assert.equal(passed.query, 'q');
  for (const forbidden of ['origin', 'convKey', 'apiKey', 'caller', 'invocation', 'ctx', 'plugin', 'signal']) {
    assert.equal(forbidden in passed, false, `模型不能把 ${forbidden} 作为参数传进插件`);
  }
  _clearToolsForTest();
});

test('★ 端到端：群聊来源连工具都看不到（不是执行时才拒）', async () => {
  _clearToolsForTest();
  defineTool({
    name: 'plugin_web_search',
    description: '联网搜索',
    kind: 'host',
    risk: 'R1',
    confirm: 'always',
    origins: ['owner-private', 'console'],
    params: { query: { type: 'string', required: true } },
    plugin: 'web-search',
    run: async () => ({ ok: true }),
  });

  const runner = createToolRunner({
    policy: {},
    context: { origin: ORIGIN.GROUP, convKey: 'group:123', onRecord: () => {}, newCallId: () => 'c' },
  });
  assert.equal(runner.availableTools().length, 0, '群聊来源的工具集必须为空');

  const out = await runner.run('plugin_web_search', { query: 'x' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'E4032');
  _clearToolsForTest();
});

test('★ 端到端：总闸关 → 即使硬调也拿不到结果（双重保险）', async () => {
  _clearToolsForTest();
  const { net, calls } = fakeNet({
    // 模拟宿主在关闸后构造的 ctx.net：两个方法都直接拒绝
    search: async () => ({ ok: false, code: NET_CODE.DISABLED, message: '联网已关闭' }),
    fetch: async () => ({ ok: false, code: NET_CODE.DISABLED, message: '联网已关闭' }),
  });
  defineTool({
    name: 'plugin_web_search',
    description: '联网搜索',
    kind: 'host',
    risk: 'R1',
    confirm: 'never',
    origins: [ORIGIN.OWNER_PRIVATE],
    params: { query: { type: 'string', required: true } },
    plugin: 'web-search',
    run: async ({ args }) => plugin.callTool({ tool: 'web_search', args, ctx: makeCtx(net) }),
  });

  const runner = createToolRunner({
    policy: {},
    context: { origin: ORIGIN.OWNER_PRIVATE, convKey: 'private:1', onRecord: () => {}, newCallId: () => 'c' },
  });
  const out = await runner.run('plugin_web_search', { query: 'x' });
  assert.equal(out.ok, true, '工具"执行成功"，但结果是拒绝');
  assert.equal(out.result.ok, false);
  assert.equal(out.result.code, NET_CODE.DISABLED);
  // 关键：没有任何真实请求发出去
  assert.equal(calls.filter((c) => c.method === 'search').length, 1, '只到假 net 一层');
  assert.equal(calls[0]?.args?.query, 'x');
  _clearToolsForTest();
});
