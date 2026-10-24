/**
 * 联网核心模块 —— 本地模拟 API 测试
 *
 * ## 这个文件守什么
 *
 * 联网是最容易"看起来能用、其实很危险"的一类能力。所以这里的断言分成四组：
 *
 *   1. **开关**：关掉之后零请求（不是"请求了但丢弃结果"）
 *   2. **协议**：只实现 Tavily 的 POST /search；200 但格式不对 ≠ 空结果
 *   3. **限制**：URL / 重定向 / 大小 / 类型 / 时间五道闸门
 *   4. **取消**：用户点停止、或总闸由开到关时，在途请求真的停下
 *
 * 全程不联网、不使用真实 Key、不发任何外部请求 —— 所有传输都替换成
 * `transport` / `requestOnce` / `resolveHost` 测试接缝。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { networkEnabledFrom, networkDisabledResult, NET_CODE } from '../src/net/gate.mjs';
import {
  sanitizeQuery,
  normalizeBaseUrl,
  normalizeResult,
  describeErrorBody,
  classifyStatus,
  parseRetryAfter,
  searchOnce,
  containsKey,
  SEARCH_DEPTHS,
  MAX_RESULTS_LIMIT,
} from '../src/net/search.mjs';
import {
  htmlToText,
  decodeEntities,
  contentTypeOf,
  isAllowedContentType,
  fetchText,
  ALLOWED_CONTENT_TYPES,
  FETCH_LIMITS,
} from '../src/net/http.mjs';
import { createNetFactory, normalizeNetConfig, NET_DEFAULTS } from '../src/net/host-net.mjs';
import { buildNetView, resolveNetEffective, disabledNetTools, createNetStats, NET_TOOL_NAMES } from '../src/net/view.mjs';

/* ------------------------------------------------------------ 工具 */

/**
 * 造一个"服务商"。
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

/** 一份正常的 Tavily 响应 */
function okBody(overrides = {}) {
  return JSON.stringify({
    query: '测试查询',
    results: [
      {
        title: '结果一',
        url: 'https://example.com/a',
        content: '第一段摘要',
        score: 0.91,
        published_date: 'Mon, 05 May 2025 10:00:00 GMT',
      },
      { title: '结果二', url: 'https://example.org/b', content: '第二段摘要', score: 0.72 },
      // 坏条目：不是 http(s)。必须单条丢弃，不连累另外两条
      { title: '坏条目', url: 'file:///C:/Windows/win.ini', content: '不该出现' },
      // 坏条目：带凭据
      { title: '带凭据', url: 'https://user:pw@example.net/c', content: '不该出现' },
    ],
    response_time: 0.42,
    answer: null,
    images: [],
    ...overrides,
  });
}

/**
 * 可信调用上下文（形状与 `src/tools/executor.mjs` 的 makeInvocation 一致）。
 *
 * 宿主的 `ctx.net` 只在**一次真实工具调用**里可用：没有这份上下文就返回
 * E4071（见 docs/web-search-contract.md §3 与交接文档 §A）。所以直接调用
 * 工厂的测试也必须模拟它 —— 这不是"给测试开后门"，而是模拟宿主真实调用。
 *
 * @param {'plugin_web_search' | 'plugin_web_fetch'} tool
 * @param {object} [over]
 * @returns {object}
 */
function trustedInvocation(tool = 'plugin_web_search', over = {}) {
  return {
    pluginId: 'web-search',
    tool,
    origin: 'console',
    convKey: 'private:0',
    isGroup: false,
    requester: { id: '', nickname: '' },
    messageId: null,
    replyToMessageId: null,
    callId: 'call_web_search_test',
    at: 1_700_000_000_000,
    ...over,
  };
}

/* ------------------------------------------------------------ 1. 开关 */

test('★ 总闸判定：缺省开，且只认真正的布尔值', () => {
  assert.equal(networkEnabledFrom({ network: { enabled: true } }), true);
  assert.equal(networkEnabledFrom({ network: { enabled: false } }), false);
  // 老配置没有这个块 → 保持既有行为（开）
  assert.equal(networkEnabledFrom({}), true);
  assert.equal(networkEnabledFrom(null), true);
  assert.equal(networkEnabledFrom({ network: {} }), true);

  /*
   * 脏值**不做真值转换**。
   *
   * 这是安全方向上唯一不能容忍的错法：用户写了 "false" 却没关掉，
   * 而界面上一切正常。启动校验（schema）会把这种值直接拒绝；
   * 这里作为运行期兜底，一律按缺省（开）—— 但绝不当成"用户想关"的
   * 反义来处理，那样反而会静默改变行为。
   */
  assert.equal(networkEnabledFrom({ network: { enabled: 'false' } }), true, '字符串不参与真假判定');
  assert.equal(networkEnabledFrom({ network: { enabled: 0 } }), true, '数字不参与真假判定');
});

test('总闸关闭时的统一结果：明确、可执行、不许绕过', () => {
  const r = networkDisabledResult('搜索');
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.DISABLED);
  assert.match(r.message, /联网已关闭/);
  assert.match(r.message, /没有发出任何请求/);
  assert.match(r.message, /不要重试/);
});

test('★ 总闸关 → ctx.net.search 直接拒绝，且**零请求**', async () => {
  const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
  const factory = createNetFactory({
    getEnabled: () => false,
    deps: { transport: fake.transport },
  });
  const net = factory.makeFor({
    pluginId: 'web-search',
    config: { baseUrl: 'https://api.tavily.com' },
    secrets: { apiKey: 'tvly-FAKE-KEY-FOR-TEST-0001' },
  })({ signal: new AbortController().signal, invocation: trustedInvocation('plugin_web_search') });

  const r = await net.search({ query: '今天天气' });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.DISABLED);
  assert.equal(fake.calls.length, 0, '关闸后一个请求都不能发');
  assert.equal(factory.stats.searches, 0);
});

/* ------------------------------------------------------------ 2. 协议 */

test('查询词清洗：去 CQ 码、去控制字符、压空白、截断', () => {
  assert.equal(sanitizeQuery('  [CQ:at,qq=1] 你好 \n 世界 '), '你好 世界');
  assert.equal(sanitizeQuery('\u0000\u0007x'), 'x');
  assert.equal(sanitizeQuery('a'.repeat(500)).length, 400);
  assert.equal(sanitizeQuery(undefined), '');
  // 不做任何"理解"或改写：查询词是提问人的意思
  assert.equal(sanitizeQuery('1+1 等于几'), '1+1 等于几');
});

test('服务地址规范化：只允许 http(s)、不许内嵌凭据、拒绝查询串与片段', () => {
  assert.deepEqual(normalizeBaseUrl('https://api.tavily.com/'), { ok: true, baseUrl: 'https://api.tavily.com' });
  assert.equal(normalizeBaseUrl('https://api.tavily.com').baseUrl, 'https://api.tavily.com');

  /*
   * 查询串 / 片段必须**拒绝**，不是"悄悄删掉"。
   *
   * 静默删除把两件不同的事混成一件：用户以为自己在配置里写了代理参数
   * 或占位 Key，实际发出去的地址没有它们 —— 症状是"配置看起来对、搜索
   * 却总是 401/404"。而且查询串是 Key 泄漏的常见写法（`?api_key=…`），
   * 直接拒绝比猜测意图安全。
   */
  for (const [input, why] of [
    ['https://api.tavily.com/?x=1', '带查询串'],
    ['https://api.tavily.com/#frag', '带片段'],
  ]) {
    const r = normalizeBaseUrl(input);
    assert.equal(r.ok, false, `${why} 必须被拒`);
    assert.equal(r.code, NET_CODE.NOT_CONFIGURED);
  }

  const bad = [
    ['', '空地址'],
    ['ftp://example.com', '非 http'],
    ['https://user:pw@example.com', '内嵌凭据'],
    ['不是 URL', '不是 URL'],
    // 远程端点必须 HTTPS：明文 HTTP 会把 Key 发给中间人
    ['http://example.com', '远程明文 http'],
  ];
  for (const [input, why] of bad) {
    const r = normalizeBaseUrl(input);
    assert.equal(r.ok, false, `${why} 必须被拒`);
    assert.equal(r.code, NET_CODE.NOT_CONFIGURED);
  }
});

test('★ 正常搜索：返回结构化来源，坏条目单条丢弃', async () => {
  const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
  const r = await searchOnce({
    baseUrl: 'https://api.tavily.com',
    apiKey: 'tvly-FAKE-KEY-FOR-TEST-0002',
    query: '测试查询',
    maxResults: 5,
    transport: fake.transport,
  });

  assert.equal(r.ok, true);
  assert.equal(r.provider, 'tavily');
  // 4 条原始结果里 2 条是坏的（file:// 与内嵌凭据）→ 只剩 2 条好来源
  assert.equal(r.results.length, 2);
  for (const one of r.results) {
    assert.match(one.url, /^https:\/\//, '来源 URL 必须仍然是 http(s)');
    assert.ok(one.title && one.snippet, '标题与摘要都要有');
  }
  assert.equal(r.results[0].publishedDate, 'Mon, 05 May 2025 10:00:00 GMT');

  // 请求形状：POST + Bearer + 只发我们支持的字段
  const sent = fake.calls[0];
  assert.equal(sent.url, 'https://api.tavily.com/search');
  assert.equal(sent.apiKey, 'tvly-FAKE-KEY-FOR-TEST-0002');
  assert.equal(sent.body.query, '测试查询');
  assert.equal(sent.body.max_results, 5);
  assert.equal(sent.body.search_depth, 'basic');
  assert.equal(sent.body.topic, 'general');
  // 这三项必须显式关掉：它们会放大响应体与费用
  assert.equal(sent.body.include_answer, false);
  assert.equal(sent.body.include_raw_content, false);
  assert.equal(sent.body.include_images, false);
});

test('★ 空结果是合法结果（ok:true + 空数组），不报错', async () => {
  const fake = fakeTransport(() => ({
    statusCode: 200,
    headers: {},
    body: JSON.stringify({ query: '很冷门的词', results: [] }),
  }));
  const r = await searchOnce({
    baseUrl: 'https://api.tavily.com',
    apiKey: 'k',
    query: '很冷门的词',
    transport: fake.transport,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results, []);
});

test('★ 200 但没有 results 数组 → E4085（协议不符），不是空结果', async () => {
  const cases = [
    ['完全没有 results', JSON.stringify({ query: 'x' })],
    ['results 是字符串', JSON.stringify({ results: 'nope' })],
    ['返回 HTML 错误页', '<html><body>gateway error</body></html>'],
    ['空响应体', ''],
  ];
  for (const [why, body] of cases) {
    const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body }));
    const r = await searchOnce({
      baseUrl: 'https://api.tavily.com',
      apiKey: 'k',
      query: 'x',
      transport: fake.transport,
    });
    assert.equal(r.ok, false, why);
    assert.equal(r.code, NET_CODE.PROTOCOL, `${why} 必须报协议不符`);
  }
});

test('★ 有 results 但每条都是坏 URL → E4085（全坏不等于空）', async () => {
  const fake = fakeTransport(() => ({
    statusCode: 200,
    headers: {},
    body: JSON.stringify({
      results: [
        { title: 'a', url: 'javascript:alert(1)' },
        { title: 'b', url: 'http://127.0.0.1/admin' },
        { title: 'c', url: '' },
      ],
    }),
  }));
  const r = await searchOnce({
    baseUrl: 'https://api.tavily.com',
    apiKey: 'k',
    query: 'x',
    transport: fake.transport,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.PROTOCOL);
  assert.match(r.message, /没有一条是合法来源/);
});

test('★ 上游错误分类：鉴权 / 限流 / 配额 / 参数 / 5xx', async () => {
  const cases = [
    [401, NET_CODE.UNAUTHORIZED],
    [403, NET_CODE.UNAUTHORIZED],
    [429, NET_CODE.QUOTA],
    [432, NET_CODE.QUOTA],
    [433, NET_CODE.QUOTA],
    [402, NET_CODE.QUOTA],
    [400, NET_CODE.PROTOCOL],
    [422, NET_CODE.PROTOCOL],
    [500, NET_CODE.UPSTREAM],
    [502, NET_CODE.UPSTREAM],
    [418, NET_CODE.UPSTREAM],
  ];
  for (const [status, want] of cases) {
    const err = classifyStatus(status, 'some detail', {});
    assert.equal(err.code, want, `HTTP ${status} 应映射到 ${want}`);
    assert.ok(err.message.length > 0);
  }
});

test('限流响应里的 Retry-After 被解析成人话（秒数与 HTTP 日期两种写法）', () => {
  assert.equal(parseRetryAfter({ 'retry-after': '60' }), 60_000);
  assert.equal(parseRetryAfter({ 'retry-after': '0' }), 0);
  const future = new Date(Date.now() + 30_000).toUTCString();
  const ms = parseRetryAfter({ 'retry-after': future });
  assert.ok(ms > 20_000 && ms <= 31_000, `HTTP 日期写法应解析出约 30 秒，实际 ${ms}`);
  assert.equal(parseRetryAfter({}), 0);
  assert.equal(parseRetryAfter({ 'retry-after': '不是时间' }), 0);
});

test('鉴权失败的错误消息里不出现 Key', async () => {
  const apiKey = 'tvly-SECRET-KEY-SHOULD-NEVER-APPEAR';
  const fake = fakeTransport(() => ({
    statusCode: 401,
    headers: {},
    body: JSON.stringify({ detail: { error: 'Unauthorized: missing or invalid API key.' } }),
  }));
  const r = await searchOnce({
    baseUrl: 'https://api.tavily.com',
    apiKey,
    query: 'x',
    transport: fake.transport,
  });
  assert.equal(r.code, NET_CODE.UNAUTHORIZED);
  assert.equal(containsKey(JSON.stringify(r), apiKey), false, '错误结果里不能出现 Key');
  assert.match(r.message, /检查 API Key/);
});

test('错误响应体里只挖人话，不原样回显', () => {
  assert.equal(describeErrorBody('{"detail":{"error":"bad topic"}}'), 'bad topic');
  assert.equal(describeErrorBody('{"detail":"plain"}'), 'plain');
  assert.equal(describeErrorBody('{"detail":[{"msg":"field required"}]}'), 'field required');
  assert.equal(describeErrorBody('{"message":"boom"}'), 'boom');
  assert.equal(describeErrorBody('不是 JSON'), '不是 JSON');
  assert.equal(describeErrorBody(''), '');
  // 超长要截断：错误体可能是整页 HTML
  assert.ok(describeErrorBody('x'.repeat(1000)).length <= 200);
});

test('没有 Key → E4081（清晰指出是配置问题，不是"没搜到"）', async () => {
  const r = await searchOnce({
    baseUrl: 'https://api.tavily.com',
    apiKey: '',
    query: 'x',
    transport: async () => ({ statusCode: 200, headers: {}, body: okBody() }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.NOT_CONFIGURED);
  assert.match(r.message, /API Key/);
});

test('空查询词 → E4085（不浪费一次额度）', async () => {
  let called = 0;
  const r = await searchOnce({
    baseUrl: 'https://api.tavily.com',
    apiKey: 'k',
    query: '   ',
    transport: async () => {
      called += 1;
      return { statusCode: 200, headers: {}, body: okBody() };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.PROTOCOL);
  assert.equal(called, 0);
});

test('参数夹取：条数与深度都在协议允许范围内', async () => {
  const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: JSON.stringify({ results: [] }) }));
  await searchOnce({
    baseUrl: 'https://api.tavily.com',
    apiKey: 'k',
    query: 'x',
    maxResults: 9999,
    searchDepth: '不存在的深度',
    transport: fake.transport,
  });
  assert.equal(fake.calls[0].body.max_results, MAX_RESULTS_LIMIT);
  assert.equal(SEARCH_DEPTHS.includes(fake.calls[0].body.search_depth), true);
  assert.equal(fake.calls[0].body.search_depth, 'basic');
});

test('结果规范化：坏 URL / 非对象一律返回 null（由调用方逐条丢弃）', () => {
  assert.equal(normalizeResult(null), null);
  assert.equal(normalizeResult('str'), null);
  assert.equal(normalizeResult({ url: 'javascript:1' }), null);
  assert.equal(normalizeResult({ url: 'http://192.168.1.1/' }), null);
  // 没有标题时用 hostname 兜底（不编造标题）
  const one = normalizeResult({ url: 'https://example.com/x', content: 'c' });
  assert.equal(one.title, 'example.com');
  // 超长摘要被截断
  const long = normalizeResult({ url: 'https://example.com/y', title: 't', content: 'z'.repeat(2000) });
  assert.ok(long.snippet.length <= 600);
});

/* ------------------------------------------------------------ 3. 网页读取限制 */

test('HTML → 纯文本：删脚本样式、保留段落、解实体', () => {
  const html = `
    <html><head><style>.a{color:red}</style><script>alert(1)</script></head>
    <body>
      <h1>标题</h1>
      <p>第一段 &amp; 第二句</p>
      <p>第二段&nbsp;内容</p>
      <!-- 注释不该出现 -->
      <noscript>无脚本提示</noscript>
      <script>steal()</script>
    </body></html>`;
  const text = htmlToText(html);
  assert.match(text, /标题/);
  assert.match(text, /第一段 & 第二句/);
  assert.match(text, /第二段 内容/);
  assert.doesNotMatch(text, /alert\(1\)/, '脚本体不该出现');
  assert.doesNotMatch(text, /color:red/, '样式体不该出现');
  assert.doesNotMatch(text, /注释不该出现/);
  assert.doesNotMatch(text, /无脚本提示/);
  assert.doesNotMatch(text, /<[^>]+>/, '不能残留标签');
});

test('HTML 实体解码：常见命名实体与数字实体，未知实体原样保留', () => {
  assert.equal(decodeEntities('&lt;a&gt;'), '<a>');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeEntities('&hellip;'), '…');
  // 未知实体保留：静默删掉会让"原文缺了一段"无法解释
  assert.equal(decodeEntities('&notAKnownEntity;'), '&notAKnownEntity;');
});

test('内容类型白名单是白名单（默认拒绝），不是黑名单', () => {
  assert.equal(contentTypeOf('Text/HTML; charset=utf-8'), 'text/html');
  assert.equal(contentTypeOf(undefined), '');
  for (const ok of ALLOWED_CONTENT_TYPES) assert.equal(isAllowedContentType(ok), true, ok);
  for (const bad of ['application/octet-stream', 'image/png', 'application/pdf', 'video/mp4']) {
    assert.equal(isAllowedContentType(bad), false, bad);
  }
});

/**
 * 造一个"网页服务器"的 requestOnce 接缝。
 *
 * @param {Record<string, {status?: number, headers?: object, body?: string}>} pages
 * @returns {{calls: any[], requestOnce: (input: any) => Promise<any>}}
 */
function fakeWeb(pages) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    requestOnce: async (input) => {
      const key = `${input.url.host}${input.url.pathname}`;
      calls.push({ key, ip: input.ip, url: input.url.toString() });
      const page = pages[key];
      if (!page) return { statusCode: 404, headers: {}, buffer: Buffer.alloc(0), truncated: false, contentType: '' };
      return {
        statusCode: page.status ?? 200,
        headers: page.headers ?? {},
        buffer: Buffer.from(page.body ?? '', 'utf8'),
        truncated: page.truncated === true,
        contentType: contentTypeOf(page.headers?.['content-type'] ?? 'text/html'),
      };
    },
  };
}

/** 永远解析到公网地址（测试用） */
const publicDns = async () => ['93.184.216.34'];

test('★ 网页读取：内网 / 本机 / 非 http / 内嵌凭据 一律 E4087', async () => {
  const web = fakeWeb({});
  const cases = [
    'http://127.0.0.1/',
    'http://localhost/admin',
    'http://192.168.1.1/',
    'http://[::1]/',
    'file:///C:/Windows/win.ini',
    'ftp://example.com/x',
    'gopher://example.com/',
    'http://user:pw@example.com/',
    '\\\\server\\share\\file',
    'C:\\Windows\\win.ini',
  ];
  for (const url of cases) {
    const r = await fetchText(url, {
      requestOnce: web.requestOnce,
      resolveHost: publicDns,
    });
    assert.equal(r.ok, false, `${url} 必须被拒`);
    assert.equal(r.code, NET_CODE.URL_REJECTED, `${url} 应报 E4087，实际 ${r.code}: ${r.message}`);
  }
  assert.equal(web.calls.length, 0, '被拒绝的地址一个请求都不能发');
});

test('★ 域名解析到内网 → E4087（DNS 层的 SSRF 也要拦）', async () => {
  const web = fakeWeb({ 'evil.example/': { body: '<p>x</p>' } });
  const r = await fetchText('http://evil.example/', {
    requestOnce: web.requestOnce,
    resolveHost: async () => ['10.0.0.5'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.URL_REJECTED);
  assert.equal(web.calls.length, 0);
});

test('★ 重定向到内网 → E4087（每一跳都重新校验）', async () => {
  const web = fakeWeb({
    'pub.example/': { status: 302, headers: { location: 'http://127.0.0.1/secret' } },
  });
  const r = await fetchText('https://pub.example/', {
    requestOnce: web.requestOnce,
    resolveHost: publicDns,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.URL_REJECTED);
  // 只发过第一跳（公网那一跳），内网那一跳根本没发
  assert.equal(web.calls.length, 1);
  assert.match(web.calls[0].key, /^pub\.example/, `实际发到了 ${web.calls[0].key}`);
});

test('重定向跳数超限 → E4087（不无限跟）', async () => {
  const web = fakeWeb({
    'a.example/': { status: 302, headers: { location: 'https://b.example/' } },
    'b.example/': { status: 302, headers: { location: 'https://c.example/' } },
    'c.example/': { status: 302, headers: { location: 'https://d.example/' } },
    'd.example/': { status: 302, headers: { location: 'https://e.example/' } },
    'e.example/': { status: 302, headers: { location: 'https://f.example/' } },
    'f.example/': { status: 302, headers: { location: 'https://g.example/' } },
  });
  const r = await fetchText('https://a.example/', {
    requestOnce: web.requestOnce,
    resolveHost: publicDns,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.URL_REJECTED);
  assert.match(r.message, /重定向次数/);
});

test('★ 正常网页：降级成纯文本并记录最终地址', async () => {
  const web = fakeWeb({
    'example.com/page': {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>真正的标题</h1><p>正文第一段</p><script>x()</script></body></html>',
    },
  });
  const r = await fetchText('https://example.com/page', {
    requestOnce: web.requestOnce,
    resolveHost: publicDns,
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /真正的标题/);
  assert.match(r.text, /正文第一段/);
  assert.doesNotMatch(r.text, /x\(\)/);
  assert.equal(r.contentType, 'text/html');
  assert.equal(r.status, 200);
  assert.equal(r.finalUrl, 'https://example.com/page');
});

test('★ 内容类型不在白名单 → E4088', async () => {
  const web = fakeWeb({
    'example.com/a.bin': {
      headers: { 'content-type': 'application/octet-stream' },
      body: 'binary-ish',
    },
  });
  const r = await fetchText('https://example.com/a.bin', {
    requestOnce: web.requestOnce,
    resolveHost: publicDns,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.CONTENT);
  assert.match(r.message, /application\/octet-stream/);
});

test('★ 超大响应 → 截断并标 truncated（不是失败）', async () => {
  const big = 'a'.repeat(5000);
  const web = fakeWeb({
    'example.com/big': {
      headers: { 'content-type': 'text/plain' },
      body: big,
      truncated: true,
    },
  });
  const r = await fetchText('https://example.com/big', {
    requestOnce: web.requestOnce,
    resolveHost: publicDns,
    maxBytes: 4096,
  });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
});

test('正文字符上限生效（字节上限之后再加一道）', async () => {
  const web = fakeWeb({
    'example.com/long': { headers: { 'content-type': 'text/plain' }, body: 'b'.repeat(3000) },
  });
  const r = await fetchText('https://example.com/long', {
    requestOnce: web.requestOnce,
    resolveHost: publicDns,
    maxChars: 500,
  });
  assert.equal(r.ok, true);
  assert.equal(r.text.length, 500);
  assert.equal(r.truncated, true);
});

test('非 2xx → E4086（上游故障，不是"没内容"）', async () => {
  const web = fakeWeb({ 'example.com/err': { status: 503, body: '' } });
  const r = await fetchText('https://example.com/err', {
    requestOnce: web.requestOnce,
    resolveHost: publicDns,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.UPSTREAM);
  assert.match(r.message, /HTTP 503/);
});

test('大小与超时的硬边界被夹住（配置写 1 也不会变成 0）', async () => {
  assert.equal(FETCH_LIMITS.maxBytesMin, 1024);
  assert.equal(FETCH_LIMITS.timeoutMsMax, 30_000);
  const web = fakeWeb({
    'example.com/small': { headers: { 'content-type': 'text/plain' }, body: 'c'.repeat(2000) },
  });
  const r = await fetchText('https://example.com/small', {
    requestOnce: web.requestOnce,
    resolveHost: publicDns,
    maxBytes: 1, // 小于硬下限
  });
  assert.equal(r.ok, true);
  assert.ok(r.text.length > 0);
});

/* ------------------------------------------------------------ 4. 取消 */

test('★ 取消：在途网页请求 abort → E4070', async () => {
  const ctrl = new AbortController();
  const web = {
    requestOnce: (input) => new Promise((_, reject) => {
      // 模拟一个永远不返回的请求；收到 abort 时按真实实现那样抛取消
      input.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('请求已取消'), { code: NET_CODE.CANCELLED }));
      }, { once: true });
    }),
  };
  const p = fetchText('https://example.com/slow', {
    requestOnce: web.requestOnce,
    resolveHost: publicDns,
    signal: ctrl.signal,
  });
  // 让 pending 先建立
  await new Promise((r) => setTimeout(r, 5));
  ctrl.abort();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.CANCELLED);
});

test('★ 取消：在途搜索 abort → E4070，并计入统计', async () => {
  const ctrl = new AbortController();
  const factory = createNetFactory({
    getEnabled: () => true,
    deps: {
      transport: (input) => new Promise((_, reject) => {
        input.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('搜索已取消'), { code: NET_CODE.CANCELLED }));
        }, { once: true });
      }),
    },
  });
  const net = factory.makeFor({
    pluginId: 'web-search',
    config: { baseUrl: 'https://api.tavily.com' },
    secrets: { apiKey: 'k' },
  })({ signal: ctrl.signal, invocation: trustedInvocation('plugin_web_search') });

  const p = net.search({ query: 'slow' });
  await new Promise((r) => setTimeout(r, 5));
  ctrl.abort();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.CANCELLED);
  assert.equal(factory.stats.cancelled, 1, '取消要单独计数（不是失败）');
  assert.equal(factory.stats.failures, 0, '取消不该被算成失败');
});

test('★ 总闸 true → false 时，在途请求被立即中止（refresh）', async () => {
  let enabled = true;
  let aborted = 0;
  const factory = createNetFactory({
    getEnabled: () => enabled,
    deps: {
      transport: (input) => new Promise((_, reject) => {
        input.signal.addEventListener('abort', () => {
          aborted += 1;
          reject(Object.assign(new Error('搜索已取消'), { code: NET_CODE.CANCELLED }));
        }, { once: true });
      }),
    },
  });
  const net = factory.makeFor({
    pluginId: 'web-search',
    config: { baseUrl: 'https://api.tavily.com' },
    secrets: { apiKey: 'k' },
  })({ signal: new AbortController().signal, invocation: trustedInvocation('plugin_web_search') });

  const p = net.search({ query: 'in flight' });
  await new Promise((r) => setTimeout(r, 5));

  // 用户点「关闭联网」
  enabled = false;
  const n = factory.refresh();
  assert.equal(n, 1, 'refresh 应中止 1 个在途请求');

  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.CANCELLED);
  assert.equal(aborted, 1);
  assert.equal(factory.refresh(), 0, '没有在途请求时 refresh 返回 0');

  // 关闸后新请求直接拒绝，且零请求
  const again = await net.search({ query: 'after' });
  assert.equal(again.code, NET_CODE.DISABLED);
});

/* ------------------------------------------------------------ 5. 视图与配置 */

test('★ 联网状态四态：off / no-plugin / needs-config / on 必须分开', () => {
  assert.equal(resolveNetEffective({ enabled: false, pluginEnabled: true, configured: true }), 'off');
  assert.equal(resolveNetEffective({ enabled: true, pluginEnabled: false, configured: true }), 'no-plugin');
  assert.equal(
    resolveNetEffective({ enabled: true, pluginEnabled: true, pluginStatus: 'ready', configured: false }),
    'needs-config',
  );
  assert.equal(
    resolveNetEffective({ enabled: true, pluginEnabled: true, pluginStatus: 'error', configured: true }),
    'needs-config',
  );
  assert.equal(
    resolveNetEffective({ enabled: true, pluginEnabled: true, pluginStatus: 'ready', configured: true }),
    'on',
  );

  // 总闸优先级最高：关着时即使一切正常也只能是 off
  assert.equal(
    resolveNetEffective({ enabled: false, pluginEnabled: true, pluginStatus: 'ready', configured: true }),
    'off',
  );
});

test('buildNetView：形状完整、总闸关时不暴露工具、密钥不回显', () => {
  const base = {
    config: { network: { enabled: false }, plugins: { enabled: ['web-search'] } },
    plugin: {
      enabled: true,
      status: 'ready',
      config: [{ key: 'baseUrl', value: 'https://api.tavily.com' }, { key: 'apiKey', value: '' }],
    },
    hasSecret: true,
    stats: createNetStats(),
  };
  const view = buildNetView(base);
  assert.equal(view.enabled, false);
  assert.equal(view.effective, 'off');
  assert.deepEqual(view.tools, [], '关闸时工具必须不可见');
  assert.equal(JSON.stringify(view).includes('tvly-'), false);

  const on = buildNetView({ ...base, config: { network: { enabled: true } } });
  assert.equal(on.effective, 'on');
  assert.deepEqual(on.tools.sort(), [...NET_TOOL_NAMES].sort());
  // 配置回显只读字段，且**没有**密钥字段
  for (const k of ['provider', 'baseUrl', 'maxResults', 'timeoutMs', 'searchDepth', 'allowFetch']) {
    assert.ok(k in on, `快照应包含 ${k}`);
  }
  assert.equal('apiKey' in on, false, '快照里不能有密钥字段');

  // 插件未启用
  const noPlugin = buildNetView({ ...base, config: { network: { enabled: true } }, plugin: { enabled: false } });
  assert.equal(noPlugin.effective, 'no-plugin');
  assert.deepEqual(noPlugin.tools, []);

  // 缺 Key
  const needs = buildNetView({ ...base, config: { network: { enabled: true } }, hasSecret: false });
  assert.equal(needs.effective, 'needs-config');
});

test('buildNetView 永不抛错：脏配置也给完整形状', () => {
  for (const bad of [null, {}, { network: 'x' }, { network: { enabled: 'yes' } }]) {
    const v = buildNetView({ config: bad, plugin: null, stats: null });
    assert.equal(typeof v.effective, 'string');
    assert.ok(Array.isArray(v.tools));
    assert.ok(v.stats && typeof v.stats.searches === 'number');
  }
});

test('disabledNetTools：关闸给出工具名单，开闸给 null', () => {
  assert.deepEqual(disabledNetTools({ network: { enabled: false } }), [...NET_TOOL_NAMES]);
  assert.equal(disabledNetTools({ network: { enabled: true } }), null);
  assert.equal(disabledNetTools({}), null);
});

test('插件配置归一：脏值回默认，不抛', () => {
  assert.deepEqual(normalizeNetConfig({}), { ...NET_DEFAULTS });
  const dirty = normalizeNetConfig({
    baseUrl: '不是 URL',
    maxResults: 'abc',
    timeoutMs: -1,
    searchDepth: 'nope',
    allowFetch: 'yes',
    maxFetchBytes: 1,
    fetchTimeoutMs: 999999,
  });
  // 非法地址归一成**空串**，不回退官方地址：把用户写错的地址悄悄换成
  // api.tavily.com，会让"我配的是自建代理"变成"请求打去了官方端点"，
  // 而界面看起来一切正常。空串会让 configured=false，直接显示"缺配置"。
  assert.equal(dirty.baseUrl, '');
  assert.equal(dirty.maxResults, NET_DEFAULTS.maxResults);
  // 数字越界是**夹取**而不是回默认：用户写了 -1 说明想要"更短"，夹到下限比
  // 悄悄改用 15 秒更符合意图（而真正的范围校验在保存时由插件自校验硬失败）
  assert.equal(dirty.timeoutMs, 1000);
  assert.equal(dirty.searchDepth, NET_DEFAULTS.searchDepth);
  // 只认真正的 false：字符串 "yes" 不该关闭这个开关
  assert.equal(dirty.allowFetch, true);
  assert.equal(dirty.maxFetchBytes, FETCH_LIMITS.maxBytesMin);
  assert.equal(dirty.fetchTimeoutMs, FETCH_LIMITS.timeoutMsMax);
});

test('allowFetch=false 时 fetch 被拒绝，search 仍可用', async () => {
  const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
  const factory = createNetFactory({
    getEnabled: () => true,
    deps: { transport: fake.transport },
  });
  const make = factory.makeFor({
    pluginId: 'web-search',
    config: { baseUrl: 'https://api.tavily.com', allowFetch: false },
    secrets: { apiKey: 'k' },
  });

  // search / fetch 各自对应一个工具名，所以必须分别构造调用对象
  const fetchNet = make({ invocation: trustedInvocation('plugin_web_fetch') });
  const f = await fetchNet.fetch({ url: 'https://example.com/' });
  assert.equal(f.ok, false);
  assert.equal(f.code, NET_CODE.DISABLED);

  const searchNet = make({ invocation: trustedInvocation('plugin_web_search') });
  const s = await searchNet.search({ query: 'x' });
  assert.equal(s.ok, true);
});

test('★ init / 测试连接阶段不允许发请求（两种运行时同一口径）', async () => {
  /*
   * 没有"某次调用"的时候，插件只该读事实（configured / enabled），
   * 不该借 init 去花一次额度。process 运行时那边本来就只能读事实；
   * 这里钉住 in-process 侧的行为，免得两种 runtime 语义分叉。
   */
  const fake = fakeTransport(() => ({ statusCode: 200, headers: {}, body: okBody() }));
  const factory = createNetFactory({ getEnabled: () => true, deps: { transport: fake.transport } });
  const factsOnly = factory.makeFor({
    pluginId: 'web-search',
    config: { baseUrl: 'https://api.tavily.com' },
    secrets: { apiKey: 'k' },
  })({ invocation: null, allowRequests: false });

  const r = await factsOnly.search({ query: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4071');
  assert.equal(fake.calls.length, 0, 'init 阶段不该发出任何请求');
  // 但事实仍然可读 —— 插件 init 要靠它决定提示什么
  assert.equal(factsOnly.configured, true);
  assert.equal(factsOnly.enabled, true);

  const f = await factsOnly.fetch({ url: 'https://example.com/' });
  assert.equal(f.code, 'E4071');
});

test('搜索统计：成功计 searches，失败计 failures，Key 不进统计', async () => {
  const apiKey = 'tvly-STATS-KEY-NEVER-LOGGED';
  const factory = createNetFactory({
    getEnabled: () => true,
    deps: {
      transport: async () => ({ statusCode: 200, headers: {}, body: okBody() }),
    },
  });
  const net = factory.makeFor({
    pluginId: 'web-search',
    config: { baseUrl: 'https://api.tavily.com' },
    secrets: { apiKey },
  })({ invocation: trustedInvocation('plugin_web_search') });

  await net.search({ query: 'a' });
  assert.equal(factory.stats.searches, 1);
  assert.equal(factory.stats.lastAt > 0, true);

  const failing = createNetFactory({
    getEnabled: () => true,
    deps: { transport: async () => ({ statusCode: 500, headers: {}, body: '' }) },
  });
  const bad = failing.makeFor({
    pluginId: 'web-search',
    config: { baseUrl: 'https://api.tavily.com' },
    secrets: { apiKey },
  })({ invocation: trustedInvocation('plugin_web_search') });
  await bad.search({ query: 'b' });
  assert.equal(failing.stats.failures, 1);
  assert.equal(failing.stats.lastError.code, NET_CODE.UPSTREAM);
  assert.equal(JSON.stringify(failing.stats).includes(apiKey), false, '统计里不能出现 Key');
});
