/**
 * 联网搜索**安全专项** —— 可信调用、配置上限、服务商拒绝、Key 回显
 *
 * ## 这个文件守什么
 *
 * 前面几个联网测试证明"能搜"；这一份证明"不能被人借道"：
 *
 *   1. **可信 invocation**：只有宿主在工具调用里构造的那份上下文才算数。
 *      没有上下文、工具名不匹配、来源是群聊 —— 一律 `E4071` 且**零请求**。
 *   2. **revoke**：一次调用结束后，插件即使偷偷把 `ctx.net` 存下来也不能再用。
 *   3. **配置上限**：`maxResults` 只能被模型**减少**，不能被它增大（否则
 *      "配置里写 2"变成一句空话，额度按模型心情烧）。
 *   4. **服务商拒绝**：provider 不是 tavily 时必须明确拒绝，不能"偷偷按
 *      Tavily 发出去" —— 那会让用户以为配的中转被用上了。
 *   5. **Key 回显**：恶意/蹩脚上游把 Key 回显在错误体、标题、摘要、URL、
 *      query 里时，返回值、错误消息、统计、日志四处都不得出现 Key 明文
 *      （含 URL 编码与 JSON 转义写法）。
 *
 * 全程假 Key、假 transport、不发任何真实请求。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createNetFactory } from '../src/net/host-net.mjs';
import { NET_CODE } from '../src/net/gate.mjs';
import { containsKey, normalizeBaseUrl } from '../src/net/search.mjs';

/** 假 Key：够长、带前缀，出现的任何一处都是泄漏 */
const KEY = 'tvly-SENTINEL-KEY-DO-NOT-ECHO-0001';
const BASE = 'https://api.tavily.com';

/**
 * 造一份**可信** invocation（形状与 src/tools/executor.mjs 的 makeInvocation 一致）。
 *
 * @param {object} [over]
 * @returns {object}
 */
function invocation(over = {}) {
  return {
    pluginId: 'web-search',
    tool: 'plugin_web_search',
    origin: 'owner-private',
    convKey: 'private:10001',
    isGroup: false,
    requester: { id: '10001', nickname: '管理员' },
    messageId: null,
    replyToMessageId: null,
    callId: 'call_security_test',
    at: 1_700_000_000_000,
    ...over,
  };
}

/** 一份正常的 Tavily 响应体 */
function okBody(overrides = {}) {
  return JSON.stringify({
    query: '测试查询',
    results: [{ title: '结果一', url: 'https://example.com/a', content: '摘要一', score: 0.9 }],
    ...overrides,
  });
}

/**
 * 假搜索传输层。
 *
 * @param {(input: any) => any} handler
 * @returns {{calls: any[], transport: (input: any) => Promise<any>}}
 */
function fakeTransport(handler) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    transport: async (input) => {
      calls.push(input);
      return handler(input);
    },
  };
}

/**
 * 假网页传输层（只给"可信调用可以正常 fetch"的基线用）。
 *
 * @returns {{calls: any[], requestOnce: Function, resolveHost: Function}}
 */
function fakeWeb() {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    requestOnce: async (input) => {
      calls.push(input);
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        buffer: Buffer.from('网页正文'),
        truncated: false,
        contentType: 'text/plain',
      };
    },
    resolveHost: async () => ['93.184.216.34'],
  };
}

/**
 * 造工厂 + 绑好插件身份。
 *
 * @param {object} [opts]
 * @returns {{factory: any, make: Function, logs: string[]}}
 */
function build(opts = {}) {
  /** @type {string[]} */
  const logs = [];
  const factory = createNetFactory({
    getEnabled: () => opts.enabled !== false,
    log: (level, message, fields) => {
      logs.push(`${String(level)} ${String(message)}${fields ? ` ${JSON.stringify(fields)}` : ''}`);
    },
    deps: {
      transport: opts.transport,
      requestOnce: opts.requestOnce,
      resolveHost: opts.resolveHost,
    },
  });
  const make = factory.makeFor({
    pluginId: 'web-search',
    config: { baseUrl: BASE, ...(opts.config ?? {}) },
    secrets: { apiKey: opts.apiKey ?? KEY },
  });
  return { factory, make, logs };
}

/**
 * 断言一段文本里没有任何形式的 Key。
 *
 * @param {unknown} haystack
 * @param {string} secret
 * @param {string} why
 */
function assertNoSecret(haystack, secret, why) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack ?? null);
  const forms = [...new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])];
  for (const form of forms) {
    assert.equal(
      text.includes(form),
      false,
      `${why}：不得出现 Key 明文（含 URL 编码 / JSON 转义形式）`,
    );
  }
}

/* ------------------------------------------------------------ 1. 可信 invocation */

test('★ 没有可信 invocation → E4071，且一个请求都不发', async () => {
  const cases = [
    ['完全没有调用上下文', undefined],
    ['空对象', {}],
    ['pluginId 不是 web-search', invocation({ pluginId: 'echo' })],
    ['invocation.tool 是 web_fetch（却调 search）', invocation({ tool: 'plugin_web_fetch' })],
    ['来源是群聊', invocation({ origin: 'group' })],
    ['来源是主动回合', invocation({ origin: 'proactive' })],
    ['来源是未知值', invocation({ origin: 'admin' })],
  ];
  for (const [why, inv] of cases) {
    const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
    const { make } = build({ transport: fake.transport });
    const net = make({ invocation: inv });
    const r = await net.search({ query: '今天天气' });
    assert.equal(r.ok, false, `${why}：必须拒绝`);
    assert.equal(r.code, 'E4071', `${why}：应报 E4071（宿主能力拒绝），实际 ${r.code}: ${r.message}`);
    assert.equal(fake.calls.length, 0, `${why}：被拒绝时零请求`);
  }
});

test('★ search / fetch 只能由各自的工具发起（工具名精确匹配）', async () => {
  // plugin_web_search 不得调 fetch
  {
    const web = fakeWeb();
    const { make } = build({ requestOnce: web.requestOnce, resolveHost: web.resolveHost });
    const net = make({ invocation: invocation({ tool: 'plugin_web_search' }) });
    const r = await net.fetch({ url: 'https://example.com/page' });
    assert.equal(r.ok, false, 'search 工具不能调 fetch');
    assert.equal(r.code, 'E4071');
    assert.equal(web.calls.length, 0, '工具名不匹配时零请求');
  }
  // plugin_web_fetch 不得调 search
  {
    const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
    const { make } = build({ transport: fake.transport });
    const net = make({ invocation: invocation({ tool: 'plugin_web_fetch' }) });
    const r = await net.search({ query: 'x' });
    assert.equal(r.ok, false, 'fetch 工具不能调 search');
    assert.equal(r.code, 'E4071');
    assert.equal(fake.calls.length, 0);
  }
});

test('可信 invocation（owner-private / console）下 search 与 fetch 都能正常用', async () => {
  for (const origin of ['owner-private', 'console']) {
    const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
    const web = fakeWeb();
    const { make } = build({ transport: fake.transport, requestOnce: web.requestOnce, resolveHost: web.resolveHost });

    const searchNet = make({ invocation: invocation({ origin }) });
    const s = await searchNet.search({ query: '正常查询' });
    assert.equal(s.ok, true, `${origin}：可信来源应能搜索`);
    assert.equal(s.results.length, 1);

    const fetchNet = make({ invocation: invocation({ origin, tool: 'plugin_web_fetch' }) });
    const f = await fetchNet.fetch({ url: 'https://example.com/page' });
    assert.equal(f.ok, true, `${origin}：可信来源应能读网页`);
    assert.equal(f.text, '网页正文');
  }
});

test('★ revoke() 之后 search / fetch 一律 E4071，且零请求', async () => {
  const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
  const web = fakeWeb();
  const { make } = build({ transport: fake.transport, requestOnce: web.requestOnce, resolveHost: web.resolveHost });

  const searchNet = make({ invocation: invocation() });
  assert.equal(typeof searchNet.revoke, 'function', 'ctx.net 必须提供 revoke()（调用结束即失效）');

  // revoke 之前能用
  assert.equal((await searchNet.search({ query: '之前' })).ok, true);
  assert.equal(fake.calls.length, 1);

  searchNet.revoke();
  const after = await searchNet.search({ query: '之后' });
  assert.equal(after.ok, false, 'revoke 后不得再搜索');
  assert.equal(after.code, 'E4071', 'revoke 后应报 E4071');
  assert.equal(fake.calls.length, 1, 'revoke 后零请求');

  const fetchNet = make({ invocation: invocation({ tool: 'plugin_web_fetch' }) });
  assert.equal((await fetchNet.fetch({ url: 'https://example.com/a' })).ok, true);
  const fetchCallsBefore = web.calls.length;
  fetchNet.revoke();
  const af = await fetchNet.fetch({ url: 'https://example.com/b' });
  assert.equal(af.ok, false, 'revoke 后不得再抓网页');
  assert.equal(af.code, 'E4071');
  assert.equal(web.calls.length, fetchCallsBefore, 'revoke 后零请求');

  // 幂等：重复 revoke 不抛
  fetchNet.revoke();
});

/* ------------------------------------------------------------ 2. 配置上限 */

test('★ maxResults：配置是上限，模型参数只能减少不能增大', async () => {
  const cases = [
    ['配置 2、模型要 20 → 上游收到 2', { maxResults: 2 }, { maxResults: 20 }, 2],
    ['配置 5、模型要 2 → 上游收到 2（允许减少）', { maxResults: 5 }, { maxResults: 2 }, 2],
    ['配置 5、模型不填 → 上游收到 5', { maxResults: 5 }, {}, 5],
    ['配置 20、模型要 999 → 协议上限 20', { maxResults: 20 }, { maxResults: 999 }, 20],
    ['配置写 999（脏值）→ 归一成 20', { maxResults: 999 }, {}, 20],
    ['配置 3、模型要 0 → 至少 1', { maxResults: 3 }, { maxResults: 0 }, 1],
  ];
  for (const [why, config, args, want] of cases) {
    const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: JSON.stringify({ results: [] }) }));
    const { make } = build({ transport: fake.transport, config });
    const net = make({ invocation: invocation() });
    const r = await net.search({ query: 'q', ...args });
    assert.equal(r.ok, true, why);
    assert.equal(fake.calls.length, 1, why);
    assert.equal(fake.calls[0].body.max_results, want, `${why}（实际上游收到 ${fake.calls[0].body.max_results}）`);
  }
});

/* ------------------------------------------------------------ 3. 服务商与地址 */

test('★ provider 不是 tavily → configured:false，搜索 E4081 且零请求', async () => {
  for (const provider of ['bing', 'google', 'serper', 'BING']) {
    const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
    const { make } = build({ transport: fake.transport, config: { provider } });
    const net = make({ invocation: invocation() });
    assert.equal(net.configured, false, `provider=${provider} 时不得声称已配置`);
    assert.equal(String(net.provider).toLowerCase(), provider.toLowerCase(), 'provider 原值应如实回报');

    const r = await net.search({ query: 'x' });
    assert.equal(r.ok, false, `provider=${provider} 必须拒绝`);
    assert.equal(r.code, NET_CODE.NOT_CONFIGURED, `provider=${provider} 应报 E4081，实际 ${r.code}`);
    assert.match(r.message, /tavily|不支持的服务类型/i, '错误消息应说明只支持 tavily');
    assert.equal(fake.calls.length, 0, `provider=${provider} 时绝不能按 Tavily 偷偷发请求`);
  }
});

test('★ baseUrl 非法（查询串/片段/凭据/非 http(s)/明文远程）→ configured:false + E4081 + 零请求', async () => {
  const bad = [
    ['带查询串', 'https://api.tavily.com/?x=1'],
    ['带片段', 'https://api.tavily.com/#frag'],
    ['带账号密码', 'https://user:pw@api.tavily.com'],
    ['非 http(s)', 'ftp://api.tavily.com'],
    ['明文远程 http', 'http://api.tavily.com'],
    ['不是 URL', '不是 URL'],
    ['空串', ''],
  ];
  for (const [why, baseUrl] of bad) {
    const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
    const { make } = build({ transport: fake.transport, config: { baseUrl } });
    const net = make({ invocation: invocation() });
    assert.equal(net.configured, false, `${why}：不得声称已配置`);
    const r = await net.search({ query: 'x' });
    assert.equal(r.ok, false, `${why}：必须拒绝`);
    assert.equal(r.code, NET_CODE.NOT_CONFIGURED, `${why}：应报 E4081，实际 ${r.code}: ${r.message}`);
    assert.equal(fake.calls.length, 0, `${why}：零请求`);
  }

  // 归一化层面也钉一次：非法地址归一成空串，**不回退**官方地址
  for (const [, baseUrl] of bad) {
    const r = normalizeBaseUrl(baseUrl);
    assert.equal(r.ok, false, `${baseUrl} 应被 normalizeBaseUrl 拒绝`);
    assert.equal(r.code, NET_CODE.NOT_CONFIGURED);
  }
});

/* ------------------------------------------------------------ 4. Key 回显防护 */

test('★ 上游在 401 响应体里回显 Key → 结果/统计/日志都不得出现 Key', async () => {
  const leak = JSON.stringify({
    detail: { error: `Unauthorized: invalid api key ${KEY} (encoded=${encodeURIComponent(KEY)})` },
  });
  const fake = fakeTransport(() => ({ statusCode: 401, headers: {}, body: leak }));
  const { make, factory, logs } = build({ transport: fake.transport });
  const net = make({ invocation: invocation() });

  const r = await net.search({ query: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.UNAUTHORIZED, '401 应报 E4082');
  assert.match(r.message, /鉴权失败/, '错误消息应保留人话部分');
  assertNoSecret(r, KEY, '401 返回值');
  assertNoSecret(r.message, KEY, '401 错误消息');
  assertNoSecret(factory.stats, KEY, '统计 lastError');
  assertNoSecret(logs.join('\n'), KEY, '日志');
  assert.equal(containsKey(JSON.stringify(r), KEY), false);
});

test('★ 上游在 429 / 5xx 长错误体里回显 Key → 脱敏且保留错误码与 Retry-After', async () => {
  const cases = [
    ['429 限流', 429, { 'retry-after': '7' }, NET_CODE.QUOTA],
    ['500 上游故障', 500, {}, NET_CODE.UPSTREAM],
    ['432 配额', 432, {}, NET_CODE.QUOTA],
  ];
  for (const [why, status, headers, want] of cases) {
    const leak = JSON.stringify({ detail: { error: `${'x'.repeat(3000)} key=${KEY}` } });
    const fake = fakeTransport(() => ({ statusCode: status, headers, body: leak }));
    const { make, factory, logs } = build({ transport: fake.transport });
    const net = make({ invocation: invocation() });

    const r = await net.search({ query: 'x' });
    assert.equal(r.ok, false, why);
    assert.equal(r.code, want, `${why}：错误分类`);
    assertNoSecret(r, KEY, why);
    assertNoSecret(r.message, KEY, `${why} 错误消息`);
    assertNoSecret(factory.stats, KEY, `${why} 统计`);
    assertNoSecret(logs.join('\n'), KEY, `${why} 日志`);
    if (status === 429) {
      assert.equal(r.retryAfterMs, 7000, 'Retry-After: 7 应解析为 7000ms');
      assert.match(r.message, /7 秒/, '错误消息应告诉模型多久后再试');
    }
  }
});

test('★ 200 但响应体不是 JSON（且回显 Key）→ E4085，不回显响应前缀', async () => {
  const fake = fakeTransport(() => ({
    statusCode: 200,
    headers: {},
    body: `<html>gateway error: authorization: Bearer ${KEY}</html>`,
  }));
  const { make, factory, logs } = build({ transport: fake.transport });
  const net = make({ invocation: invocation() });

  const r = await net.search({ query: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.PROTOCOL, '非 JSON 的 200 应报 E4085');
  assert.match(r.message, /JSON/, '错误消息应说明不是合法 JSON');
  assertNoSecret(r, KEY, '非 JSON 响应');
  assertNoSecret(factory.stats, KEY, '统计');
  assertNoSecret(logs.join('\n'), KEY, '日志');
});

test('★ results / query 里回显 Key → 字段脱敏；URL 含脱敏占位符不作为来源返回', async () => {
  const body = JSON.stringify({
    query: `查询 ${KEY}`,
    results: [
      // 标题与摘要回显 Key：脱敏后保留该条（URL 本身是干净的）
      { title: `标题 ${KEY}`, url: 'https://example.com/clean', content: `摘要 ${KEY}` },
      // URL 里带 Key：脱敏后 URL 不可引用，整条丢弃
      { title: '带 Key 的地址', url: `https://example.com/?token=${KEY}`, content: 'x' },
      // URL 用 URL 编码写 Key
      { title: '编码写法的 Key', url: `https://example.org/?t=${encodeURIComponent(KEY)}`, content: 'y' },
      { title: '正常来源', url: 'https://example.net/ok', content: '正常摘要' },
    ],
  });
  const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body }));
  const { make, logs } = build({ transport: fake.transport });
  const net = make({ invocation: invocation() });

  const r = await net.search({ query: 'x' });
  assert.equal(r.ok, true, '能正常解析时不该因为个别坏条目整单失败');
  assertNoSecret(r, KEY, '搜索返回值');
  for (const one of r.results) {
    assert.equal(one.url.includes('[REDACTED]'), false, 'URL 含脱敏占位符就不能当作可引用来源');
  }
  assert.equal(r.results.length, 2, '两条 URL 带 Key 的来源必须丢弃，另外两条保留');
  assert.deepEqual(
    r.results.map((x) => x.url).sort(),
    ['https://example.com/clean', 'https://example.net/ok'],
  );
  assert.match(r.results[0].title, /\[REDACTED\]/, '标题里的 Key 应替换成脱敏占位符');
  assertNoSecret(logs.join('\n'), KEY, '日志');
});

test('★ 所有来源都因回显 Key 被丢弃 → E4085，不是"空结果"', async () => {
  /*
   * 上游给了结果，但每条 URL 都带明文 Key（或被网关塞进了 Key）。
   * 这些 URL 一条都不能当来源返回；但"一条都不返回"也**不等于**"没搜到" ——
   * 报成 ok:true + 空数组会让模型理直气壮地回答"查不到"，
   * 而真实原因是上游在回显密钥（协议/网关问题）。
   */
  const body = JSON.stringify({
    results: [
      { title: '第一条', url: `https://example.com/?token=${KEY}`, content: 'x' },
      { title: '第二条', url: `https://example.org/?t=${encodeURIComponent(KEY)}`, content: 'y' },
    ],
  });
  const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body }));
  const { make, logs } = build({ transport: fake.transport });
  const net = make({ invocation: invocation() });

  const r = await net.search({ query: 'x' });
  assert.equal(r.ok, false, '上游给了结果却一条都不敢返回时，不能伪装成空结果');
  assert.equal(r.code, NET_CODE.PROTOCOL, `应报 E4085，实际 ${r.code}: ${r.message}`);
  assert.match(r.message, /密钥|丢弃|不是空结果/);
  assert.equal('results' in r, false, '失败结果不该带 results 数组');
  assertNoSecret(r, KEY, '错误结果');
  assertNoSecret(logs.join('\n'), KEY, '日志');
});

test('★ JSON 转义写法的 Key 与 URL 编码写法的 Key 都要脱敏', async () => {
  // 带引号的 Key：JSON.stringify 后会出现 \" 转义写法，只按原样替换会漏掉
  const tricky = 'tvly-QUOTE"KEY-0002';
  const leak = JSON.stringify({ detail: { error: `bad key ${tricky}` } });
  assert.ok(JSON.stringify(tricky).slice(1, -1) !== tricky, '前置条件：该 Key 的 JSON 转义写法与原文不同');

  const fake = fakeTransport(() => ({ statusCode: 401, headers: {}, body: leak }));
  const { make, factory, logs } = build({ transport: fake.transport, apiKey: tricky });
  const net = make({ invocation: invocation() });

  const r = await net.search({ query: 'x' });
  assert.equal(r.code, NET_CODE.UNAUTHORIZED);
  assertNoSecret(r, tricky, '引号 Key 的返回值');
  assertNoSecret(r.message, tricky, '引号 Key 的错误消息');
  assertNoSecret(factory.stats, tricky, '引号 Key 的统计');
  assertNoSecret(logs.join('\n'), tricky, '引号 Key 的日志');
});

test('Key 只出现在传输层的 authorization 字段，不进 URL / 请求体 / 日志', async () => {
  const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
  const { make, logs } = build({ transport: fake.transport });
  const net = make({ invocation: invocation() });
  const query = '一个不该进日志的私密问题';
  const r = await net.search({ query });
  assert.equal(r.ok, true);

  const sent = fake.calls[0];
  assert.equal(sent.apiKey, KEY, 'Key 由宿主在传输层单独传（不进请求体）');
  assert.equal(sent.url.includes(KEY), false, 'URL 里不得出现 Key');
  assert.equal(JSON.stringify(sent.body).includes(KEY), false, '请求体里不得出现 Key');
  assert.equal(logs.join('\n').includes(query), false, '日志不该成为第二份聊天记录（交接文档 §B）');
});
