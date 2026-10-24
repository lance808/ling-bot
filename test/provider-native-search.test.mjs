/**
 * 服务商原生联网 —— 协议与证据判定（本地模拟，不联网、不花钱）
 *
 * ## 这个文件守什么
 *
 * 原生联网最危险的失败不是报错，而是**看起来成功了**：
 * 中转把不认识的字段静默丢掉，HTTP 200、回答流畅，用户以为查了最新资料。
 * 所以这里断言的不是"请求发出去了"，而是：
 *
 *   1. 请求字段是否**按服务商协议**精确出现（智谱 tools / OpenAI web_search_options）；
 *   2. 关闭或独立 API 模式下是否**零联网声明**；
 *   3. 200 但没有引用/来源时，状态必须是 unknown（不是 searched）；
 *   4. 有引用/来源时能否解析成结构化来源；
 *   5. 上游明确拒绝时是否自动降级一次、并如实标 rejected；
 *   6. 原生模式下插件搜索工具是否结构性不可见（避免重复消耗）。
 *
 * 全部用本地 127.0.0.1 假 SSE/HTTP 服务端，Key 用假值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { LlmClient } from '../src/llm/client.mjs';
import { runTurn } from '../src/llm/agent-loop.mjs';
import {
  NATIVE_PROVIDERS,
  resolveNativeSearch,
  collectInlineRefs,
  looksLikeNativeSearchRejection,
} from '../src/llm/provider-search.mjs';
import { buildNetView, disabledNetTools, NET_TOOL_NAMES } from '../src/net/view.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../src/config/schema.mjs';

/* ------------------------------------------------------------ 工具 */

/**
 * 起一个本地 SSE 服务端，记录每次请求体。
 *
 * @param {(body: any, index: number) => {status?: number, chunks?: any[], body?: string, headers?: Record<string,string>}} handler
 */
async function sseServer(handler) {
  /** @type {any[]} */
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const buf = [];
    for await (const c of req) buf.push(c);
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(buf).toString('utf8'));
    } catch {
      body = null;
    }
    bodies.push(body);
    const out = handler(body, bodies.length - 1) ?? {};
    if (out.status && out.status !== 200) {
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(out.body ?? '{"error":{"message":"bad request"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of out.chunks ?? []) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = /** @type {any} */ (server.address()).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

/** 构造一个带现读解析器的客户端 */
function mkClient(baseUrl, config, extra = {}) {
  return new LlmClient({
    baseUrl,
    model: 'test-model',
    apiKey: 'sk-test-native',
    timeoutMs: 5000,
    maxRetries: 0,
    webSearch: () => {
      const r = resolveNativeSearch(config);
      return r.active ? r.plan : null;
    },
    ...extra,
  });
}

/** 基础配置：总闸开、原生模式、指定服务商 */
function nativeConfig(provider, overrides = {}) {
  return {
    network: {
      enabled: true,
      mode: 'native',
      native: { provider, maxResults: 5 },
      ...overrides,
    },
  };
}

/* ------------------------------------------------------------ 1. 配置与三态 */

test('三态解析：关 / 独立 API / 原生联网，且总闸优先', () => {
  const off = resolveNativeSearch({ network: { enabled: false, mode: 'native', native: { provider: 'zhipu' } } });
  assert.equal(off.effectiveMode, 'off');
  assert.equal(off.active, false, '总闸关着时绝不 active');
  assert.ok(off.plan === null);

  const api = resolveNativeSearch({ network: { enabled: true, mode: 'api', native: { provider: 'zhipu' } } });
  assert.equal(api.effectiveMode, 'api');
  assert.equal(api.active, false);
  assert.equal(api.storedMode, 'api');

  const native = resolveNativeSearch(nativeConfig('zhipu'));
  assert.equal(native.effectiveMode, 'native');
  assert.equal(native.active, true);
  assert.equal(native.providerKnown, true);
  assert.ok(native.plan, '原生模式应给出请求计划');
  assert.equal(native.plan.provider, 'zhipu');
});

test('未选择 / 未适配的服务商：不 active、不按别家协议发送', () => {
  for (const provider of ['', 'unknown-vendor']) {
    const r = resolveNativeSearch(nativeConfig(provider));
    assert.equal(r.providerKnown, false);
    assert.equal(r.active, false, `provider=${provider || '(空)'} 不能 active`);
    assert.equal(r.plan, null);
    assert.match(r.limitsText, /没有适配|尚未适配/);
  }
});

test('配置默认值：老配置能通过校验，并且默认仍是独立搜索 API', () => {
  const kept = validateConfig({});
  assert.equal(kept.network.mode, 'api');
  assert.equal(kept.network.native.provider, '');
  assert.equal(kept.network.native.maxResults, 5);
  // 只写 enabled 的老配置也必须能起来
  const old = validateConfig({ network: { enabled: false } });
  assert.equal(old.network.enabled, false);
  assert.equal(old.network.mode, 'api');
  assert.ok(DEFAULT_CONFIG.network.native);
});

test('配置校验：非法 mode / native 形状硬失败（不静默当成 api）', () => {
  assert.throws(() => validateConfig({ network: { enabled: true, mode: 'auto' } }), /network\.mode/);
  assert.throws(() => validateConfig({ network: { enabled: true, native: [] } }), /network\.native/);
  assert.throws(
    () => validateConfig({ network: { enabled: true, native: { provider: '', maxResults: 99 } } }),
    /maxResults/,
  );
});

/* ------------------------------------------------------------ 2. 请求字段 */

test('智谱：请求体带 tools[type=web_search]，count 取配置上限，且不丢 function tools', async () => {
  const s = await sseServer(() => ({ chunks: [{ choices: [{ delta: { content: '好' } }] }] }));
  try {
    const c = mkClient(s.baseUrl, nativeConfig('zhipu', { native: { provider: 'zhipu', maxResults: 7 } }));
    await c.chat({
      messages: [{ role: 'user', content: 'hi' }],
      // 模拟插件 function tool 同时存在：原生工具必须**追加**而不是覆盖
      tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object' } } }],
    });
    const body = s.bodies[0];
    assert.equal(body.tools.length, 2, 'function tool 与原生工具必须都在');
    assert.equal(body.tools[0].function.name, 'echo');
    const ws = body.tools.find((t) => t.type === 'web_search');
    assert.ok(ws, '必须带智谱的 web_search 工具声明');
    assert.equal(ws.web_search.enable, true);
    assert.equal(ws.web_search.search_result, true);
    assert.equal(ws.web_search.count, 7);
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.web_search_options, undefined, '不能把 OpenAI 字段发给智谱');
  } finally {
    await s.close();
  }
});

test('OpenAI：请求体带 web_search_options，且不塞服务端工具', async () => {
  const s = await sseServer(() => ({ chunks: [{ choices: [{ delta: { content: '好' } }] }] }));
  try {
    const c = mkClient(s.baseUrl, nativeConfig('openai'));
    await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const body = s.bodies[0];
    assert.deepEqual(body.web_search_options, { search_context_size: 'medium' });
    assert.equal(body.tools, undefined, 'OpenAI Chat 这条路径不追加 tools');
  } finally {
    await s.close();
  }
});

test('关闭 / 独立 API 模式：请求里零联网声明（不是"发了但忽略"）', async () => {
  const cases = [
    { name: '总闸关', config: { network: { enabled: false, mode: 'native', native: { provider: 'zhipu' } } } },
    { name: '独立 API', config: { network: { enabled: true, mode: 'api', native: { provider: 'zhipu' } } } },
    { name: '未适配服务商', config: nativeConfig('unknown-vendor') },
  ];
  for (const one of cases) {
    const s = await sseServer(() => ({ chunks: [{ choices: [{ delta: { content: '好' } }] }] }));
    try {
      const c = mkClient(s.baseUrl, one.config);
      const r = await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
      const raw = JSON.stringify(s.bodies[0]);
      assert.ok(!raw.includes('web_search'), `${one.name}：不能出现 web_search`);
      assert.ok(!raw.includes('web_search_options'), `${one.name}：不能出现 web_search_options`);
      assert.ok(!raw.includes('enable_search'), `${one.name}：不能出现 enable_search`);
      assert.equal(r.webSearch, null, `${one.name}：没有请求原生联网就不该有证据对象`);
    } finally {
      await s.close();
    }
  }
});

/* ------------------------------------------------------------ 3. 证据解析 */

test('★ 智谱：200 且正文带 [来源：ref_1] → searched；但来源列表仍为空（流式不返回结构化来源）', async () => {
  const s = await sseServer(() => ({
    chunks: [
      { choices: [{ delta: { content: '据资料，' } }] },
      { choices: [{ delta: { content: '台风已登陆。[来源：ref_1]' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ],
  }));
  try {
    const c = mkClient(s.baseUrl, nativeConfig('zhipu'));
    const r = await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.webSearch.status, 'searched');
    assert.equal(r.webSearch.kind, 'inline_ref');
    assert.deepEqual(r.webSearch.inlineRefs, ['ref_1']);
    assert.equal(r.webSearch.sources.length, 0, '不能假装拿到了结构化来源');
  } finally {
    await s.close();
  }
});

test('智谱：chunk 顶层 web_search 数组（若中转返回）能解析成结构化来源', async () => {
  const s = await sseServer(() => ({
    chunks: [
      {
        web_search: [
          { title: '来源 A', link: 'https://example.com/a', content: '摘要 A', publish_date: '2026-10-01' },
          { title: '坏来源', link: 'file:///C:/Windows/win.ini' },
        ],
      },
      { choices: [{ delta: { content: '答案' } }] },
    ],
  }));
  try {
    const c = mkClient(s.baseUrl, nativeConfig('zhipu'));
    const r = await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.webSearch.status, 'searched');
    assert.equal(r.webSearch.sources.length, 1, '坏 URL 必须单条丢弃');
    assert.equal(r.webSearch.sources[0].url, 'https://example.com/a');
  } finally {
    await s.close();
  }
});

test('★ OpenAI：200 但没有 annotations → unknown（绝不把 200 当联网成功）', async () => {
  const s = await sseServer(() => ({
    chunks: [
      { choices: [{ delta: { content: '今天天气不错。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ],
  }));
  try {
    const c = mkClient(s.baseUrl, nativeConfig('openai'));
    const r = await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.webSearch.status, 'unknown');
    assert.equal(r.webSearch.sources.length, 0);
    assert.match(r.webSearch.detail, /无法确认/);
  } finally {
    await s.close();
  }
});

test('★ OpenAI：delta.annotations 的 url_citation → searched + 结构化来源（去重、只认 http(s)）', async () => {
  const s = await sseServer(() => ({
    chunks: [
      {
        choices: [{
          delta: {
            content: '据资料，',
            annotations: [
              { type: 'url_citation', url_citation: { url: 'https://example.com/a', title: '来源 A' } },
              { type: 'url_citation', url_citation: { url: 'https://example.com/a', title: '来源 A（重复）' } },
              { type: 'url_citation', url_citation: { url: 'http://user:pw@evil.test/x', title: '带凭据' } },
              { type: 'some_other_type', url: 'https://example.com/ignored' },
            ],
          },
        }],
      },
      { choices: [{ delta: { content: '已登陆。' } }] },
    ],
  }));
  try {
    const c = mkClient(s.baseUrl, nativeConfig('openai'));
    const r = await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.webSearch.status, 'searched');
    assert.equal(r.webSearch.kind, 'url_citation');
    assert.equal(r.webSearch.sources.length, 1);
    assert.equal(r.webSearch.sources[0].url, 'https://example.com/a');
    assert.equal(r.webSearch.sources[0].title, '来源 A');
  } finally {
    await s.close();
  }
});

test('正文角标解析：只认 [来源：ref_N]，不误认 [1] / [来源]', () => {
  assert.deepEqual(collectInlineRefs('a [来源：ref_1] b [来源:ref_2]'), ['ref_1', 'ref_2']);
  assert.deepEqual(collectInlineRefs('见 [1] 与 [来源] 与 [来源：某网站]'), []);
});

/* ------------------------------------------------------------ 4. 上游拒绝与降级 */

test('拒绝判定：只认 400/404/422 + 联网关键词，普通 400/5xx 不算', () => {
  assert.equal(looksLikeNativeSearchRejection(400, 'unknown field: web_search_options'), true);
  assert.equal(looksLikeNativeSearchRejection(422, '不支持该参数：enable_search'), true);
  assert.equal(looksLikeNativeSearchRejection(500, 'web_search_options failed'), false, '5xx 不是"不支持"');
  assert.equal(looksLikeNativeSearchRejection(400, 'max_tokens too large'), false, '普通 400 不能被误判');
  assert.equal(looksLikeNativeSearchRejection(401, 'web_search_options'), false);
});

test('★ 上游明确拒绝 → 自动去掉联网参数重试一次，并标 rejected（不是静默成功）', async () => {
  const s = await sseServer((body, index) => {
    if (index === 0) {
      assert.ok(body.web_search_options, '第一次请求应带联网参数');
      return { status: 400, body: '{"error":{"message":"unknown field web_search_options"}}' };
    }
    assert.equal(body.web_search_options, undefined, '重试必须去掉联网参数');
    return { chunks: [{ choices: [{ delta: { content: '降级后的回答' } }] }] };
  });
  try {
    const c = mkClient(s.baseUrl, nativeConfig('openai'));
    const r = await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.text, '降级后的回答', '降级重试要能正常出答案');
    assert.equal(s.bodies.length, 2);
    assert.equal(r.webSearch.status, 'rejected');
    assert.equal(r.webSearch.fallback, true);
    assert.match(r.webSearch.detail, /没有使用原生联网/);
  } finally {
    await s.close();
  }
});

test('拒绝降级只发生在"明确拒绝"：普通 400 照常抛错，不吞掉原因', async () => {
  const s = await sseServer(() => ({
    status: 400,
    body: '{"error":{"message":"messages[0] role invalid"}}',
  }));
  try {
    const c = mkClient(s.baseUrl, nativeConfig('openai'));
    await assert.rejects(
      () => c.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      /messages\[0\] role invalid|模型返回 400/,
    );
    assert.equal(s.bodies.length, 1, '普通 400 不应重试');
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------------------ 5. 回合与工具面 */

test('agent-loop：证据跨多次模型调用合并，并在最终结果里带出', async () => {
  let round = 0;
  const llm = {
    chat: async () => {
      round += 1;
      if (round === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: false },
          model: 'x',
          cancelled: false,
          webSearch: { provider: 'zhipu', status: 'unknown', kind: 'none', sources: [], inlineRefs: [], rounds: 1, detail: '无证据' },
        };
      }
      return {
        text: '最终回答',
        reasoning: '',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: false },
        model: 'x',
        cancelled: false,
        webSearch: {
          provider: 'zhipu', status: 'searched', kind: 'inline_ref', sources: [],
          inlineRefs: ['ref_1'], rounds: 1, detail: '有角标',
        },
      };
    },
  };
  const runner = {
    availableTools: () => [{ name: 'echo', description: '', parameters: {} }],
    run: async () => ({ ok: true, result: { content: 'ok' } }),
  };
  const res = await runTurn({
    llm,
    runner,
    toOpenAiTools: (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, parameters: t.parameters } })),
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
  });
  assert.equal(res.text, '最终回答');
  assert.equal(res.nativeSearch.status, 'searched');
  assert.deepEqual(res.nativeSearch.inlineRefs, ['ref_1']);
  assert.equal(res.nativeSearch.rounds, 2, '两轮调用的证据要合并计数');
});

test('★ 原生模式：插件搜索工具结构性不可见（避免两条通道重复消耗）', () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    network: { enabled: true, mode: 'native', native: { provider: 'zhipu', maxResults: 5 } },
    plugins: {
      ...DEFAULT_CONFIG.plugins,
      enabled: ['web-search'],
      config: {
        ...DEFAULT_CONFIG.plugins.config,
        'web-search': { provider: 'tavily', baseUrl: 'https://api.tavily.com', maxResults: 5, allowFetch: true },
      },
    },
  };
  const view = buildNetView({
    config: cfg,
    plugin: { enabled: true, status: 'ready', config: [] },
    hasSecret: true,
    nativeRuntime: { last: null, stats: { requests: 2, evidence: 1, noEvidence: 1, rejected: 0, lastAt: 3 } },
  });
  assert.equal(view.mode, 'native');
  assert.equal(view.effectiveMode, 'native');
  assert.equal(view.effective, 'native');
  assert.deepEqual(view.tools, [], '原生模式不暴露插件搜索/抓取工具');
  assert.equal(view.native.providerKnown, true);
  assert.equal(view.native.active, true);
  assert.match(view.native.offPolicy.text, /不发送/);
  assert.deepEqual(disabledNetTools(cfg), [...NET_TOOL_NAMES], '回合级禁用也要拦住两个工具');
});

test('原生模式但未选服务商：effective=native-needs-config，且零工具', () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    network: { enabled: true, mode: 'native', native: { provider: '', maxResults: 5 } },
  };
  const view = buildNetView({ config: cfg, plugin: null, hasSecret: false });
  assert.equal(view.effective, 'native-needs-config');
  assert.equal(view.native.providerKnown, false);
  assert.match(view.effectiveText, /还没有选择|未配置|不会发送/);
  assert.deepEqual(view.tools, []);
});

test('独立 API 模式保持旧行为：总闸开 + 插件就绪 + 有 Key → on 且工具可见', () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    network: { enabled: true, mode: 'api', native: { provider: '', maxResults: 5 } },
    plugins: {
      ...DEFAULT_CONFIG.plugins,
      enabled: ['web-search'],
      config: {
        ...DEFAULT_CONFIG.plugins.config,
        'web-search': { provider: 'tavily', baseUrl: 'https://api.tavily.com', maxResults: 5, allowFetch: true },
      },
    },
  };
  const view = buildNetView({
    config: cfg,
    plugin: { enabled: true, status: 'ready', config: [] },
    hasSecret: true,
    toolVisible: () => true,
  });
  assert.equal(view.mode, 'api');
  assert.equal(view.effective, 'on');
  assert.deepEqual(view.tools, [...NET_TOOL_NAMES]);
  assert.equal(disabledNetTools(cfg), null);
});

/* ------------------------------------------------------------ 6. 证据不污染既有链路 */

test('保留既有字段：原生联网不改变 text / reasoning / toolCalls / usage 的形状', async () => {
  const s = await sseServer(() => ({
    chunks: [
      { choices: [{ delta: { reasoning_content: '想一下', content: '答' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'echo', arguments: '{"a":1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ],
  }));
  try {
    const c = mkClient(s.baseUrl, nativeConfig('openai'));
    const r = await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.text, '答');
    assert.equal(r.reasoning, '想一下');
    assert.deepEqual(r.toolCalls, [{ id: 't1', name: 'echo', arguments: '{"a":1}' }]);
    assert.equal(r.usage.totalTokens, 5);
    assert.ok(r.webSearch, '额外字段可以有，但不能挤掉既有字段');
  } finally {
    await s.close();
  }
});

test('原生联网服务商注册表：只包含本轮明确适配的两家', () => {
  assert.deepEqual(Object.keys(NATIVE_PROVIDERS).sort(), ['openai', 'zhipu']);
  assert.ok(NATIVE_PROVIDERS.zhipu.requestFields.includes('web_search'));
  assert.ok(NATIVE_PROVIDERS.openai.requestFields.includes('web_search_options'));
});
