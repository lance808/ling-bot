/**
 * 联网搜索验收 —— 用**真实 HTTP** 打本地模拟服务商
 *
 * ## 与 test/web-search*.test.mjs 的分工
 *
 * 那两个测试用注入的 `transport` / `requestOnce`，验证的是**判定逻辑**。
 * 这个脚本多走一层真实网络栈（node:http 服务器 + node:http 客户端），
 * 验证的是"接上真链路之后仍然对"：
 *
 *   · 请求真的发出去了吗（关闸时一个字节都不该到服务端）
 *   · 真的把 Bearer 头带上了吗（而不是拼进 URL 或 body）
 *   · 真实 abort 会真的断开连接吗
 *   · 真实的 429 / 500 / 非 JSON 响应会被正确分类吗
 *
 * ## 全程不联网、不花钱
 *
 * 服务端监听 `127.0.0.1` 的随机端口；Key 是假的；不读 `config.json`、
 * 不读真实凭据、不发 QQ 消息。
 *
 * 运行：node scripts/verify-web-search.mjs
 */

import http from 'node:http';
import assert from 'node:assert/strict';

import { createNetFactory } from '../src/net/host-net.mjs';
import { searchOnce, containsKey } from '../src/net/search.mjs';
import { fetchText, requestOnce } from '../src/net/http.mjs';
import { NET_CODE } from '../src/net/gate.mjs';
import { buildNetView, disabledNetTools, createNetStats, NET_TOOL_NAMES } from '../src/net/view.mjs';

let pass = 0;
let fail = 0;

/**
 * 一条断言 + 计数。
 *
 * @param {boolean} cond
 * @param {string} message
 */
function ok(cond, message) {
  if (cond) {
    pass += 1;
    console.log(`  OK  ${message}`);
  } else {
    fail += 1;
    console.log(`  ✖   ${message}`);
  }
}

/**
 * 一条必须抛/必须失败的断言。
 *
 * @param {() => Promise<any>} fn
 * @param {string} code
 * @param {string} message
 */
async function failsWith(fn, code, message) {
  try {
    const r = await fn();
    ok(r?.ok === false && r?.code === code, `${message}（期望 ${code}，实际 ${r?.code ?? '成功'}）`);
  } catch (err) {
    ok(false, `${message}（抛异常：${String(err?.message ?? err)}）`);
  }
}

/* ------------------------------------------------------------ 模拟服务商 */

/**
 * 每种场景一个路由。
 *
 * 服务端还会记录"收到了什么"，用来断言请求形状（方法、路径、头、body）。
 *
 * @type {{requests: Array<{method: string, url: string, headers: any, body: any}>, sockets: Set<any>}}
 */
const seen = { requests: [], sockets: new Set() };

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handler(req, res) {
  /** 读完整 body */
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  /** @type {any} */
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  seen.requests.push({ method: req.method, url: req.url, headers: req.headers, body });

  const send = (status, payload, headers = {}) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(text);
  };

  // 正常搜索
  if (req.url === '/search' && req.method === 'POST') {
    const q = String(body?.query ?? '');
    if (q === '空结果') {
      send(200, { query: q, results: [], response_time: 0.1 });
      return;
    }
    if (q === '协议不符') {
      send(200, '<html>gateway error</html>');
      return;
    }
    if (q === '慢请求') {
      // 故意不回：让客户端超时/取消。连接保持打开。
      return;
    }
    send(200, {
      query: q,
      results: [
        { title: '来源一', url: 'https://example.com/one', content: '摘要一', score: 0.9 },
        // 坏 URL：必须被单条丢弃
        { title: '坏条目', url: 'file:///C:/Windows/win.ini', content: '不该出现' },
        { title: '来源二', url: 'https://example.org/two', content: '摘要二', score: 0.7 },
      ],
      response_time: 0.2,
      answer: null,
      images: [],
    });
    return;
  }

  // 鉴权失败
  if (req.url === '/unauthorized/search') {
    send(401, { detail: { error: 'Unauthorized: missing or invalid API key.' } }, {});
    return;
  }
  // 限流
  if (req.url === '/ratelimit/search') {
    send(429, { detail: { error: 'too many requests' } }, { 'retry-after': '7' });
    return;
  }
  // 上游故障
  if (req.url === '/broken/search') {
    send(500, { detail: { error: 'Internal Server Error' } });
    return;
  }
  // 配额
  if (req.url === '/quota/search') {
    send(432, { detail: { error: 'plan limit exceeded' } });
    return;
  }

  // 网页读取：正常 HTML
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>标题</h1><p>正文</p><script>evil()</script></body></html>');
    return;
  }
  // 网页读取：二进制
  if (req.url === '/binary') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([0, 1, 2, 3]));
    return;
  }
  // 网页读取：超大
  if (req.url === '/huge') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(100_000));
    return;
  }
  // 网页读取：跳回内网
  if (req.url === '/redirect-internal') {
    res.writeHead(302, { location: 'http://127.0.0.1/secret' });
    res.end();
    return;
  }
  // 网页读取：慢响应
  if (req.url === '/slow-page') {
    return;
  }
  // 网页读取：没有 Content-Type（必须拒绝，不能猜 HTML）
  if (req.url === '/no-type') {
    res.writeHead(200);
    res.end('<html><body>没有类型</body></html>');
    return;
  }
  // 网页读取：多重 Content-Encoding（无法安全解码）
  if (req.url === '/multi-encoding') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip, br' });
    res.end('<html><body>多重编码</body></html>');
    return;
  }

  send(404, { detail: { error: 'not found' } });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    try {
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    } catch {
      /* 已断开 */
    }
  });
});
server.on('connection', (socket) => {
  seen.sockets.add(socket);
  socket.on('close', () => seen.sockets.delete(socket));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = /** @type {any} */ (server.address());
const base = `http://127.0.0.1:${port}`;
console.log(`\n本地模拟服务商：${base}\n`);

/* ------------------------------------------------------------ 1. 真实搜索 */

console.log('## 1. 真实 HTTP 搜索（含请求形状）');

{
  const apiKey = 'tvly-FAKE-KEY-FOR-VERIFY-0001';
  const r = await searchOnce({
    baseUrl: base,
    apiKey,
    query: '测试查询',
    maxResults: 5,
  });

  ok(r.ok === true, '正常搜索应成功');
  ok(r.results.length === 2, `坏 URL 应被单条丢弃（实际 ${r.results?.length} 条）`);
  ok(r.results.every((x) => /^https:\/\//.test(x.url)), '来源 URL 必须仍是 http(s)');
  ok(r.results[0].title === '来源一' && r.results[0].snippet === '摘要一', '标题与摘要都要保留');
  ok(containsKey(JSON.stringify(r), apiKey) === false, '结果里不能出现 Key');

  const sent = seen.requests.filter((x) => x.url === '/search').at(-1);
  ok(sent?.method === 'POST', '必须用 POST');
  ok(String(sent?.headers?.authorization ?? '') === `Bearer ${apiKey}`, 'Key 必须在 Authorization 头里');
  ok(String(sent?.headers?.['content-type'] ?? '').includes('application/json'), '请求体必须是 JSON');
  ok(sent?.body?.query === '测试查询', '查询词要真的发出去');
  ok(sent?.body?.include_raw_content === false && sent?.body?.include_images === false, '放大响应的开关必须显式关闭');
  ok(JSON.stringify(sent?.body ?? {}).includes(apiKey) === false, 'Key 不能出现在请求体里');
}

console.log('\n## 2. 空结果 vs 失败（这是两件事）');

{
  const empty = await searchOnce({ baseUrl: base, apiKey: 'k', query: '空结果' });
  ok(empty.ok === true && empty.results.length === 0, 'results: [] 是合法的空结果');
}

{
  const r = await searchOnce({ baseUrl: base, apiKey: 'k', query: '协议不符' });
  ok(r.ok === false && r.code === NET_CODE.PROTOCOL, '200 但不是 JSON → E4085（不是空结果）');
}

console.log('\n## 3. 上游错误分类（真实状态码）');

await failsWith(
  () => searchOnce({ baseUrl: `${base}/unauthorized`, apiKey: 'k', query: 'x' }),
  NET_CODE.UNAUTHORIZED,
  '401 → E4082',
);
{
  const r = await searchOnce({ baseUrl: `${base}/ratelimit`, apiKey: 'k', query: 'x' });
  ok(r.ok === false && r.code === NET_CODE.QUOTA, '429 → E4083');
  ok(r.retryAfterMs === 7000, `Retry-After: 7 应解析成 7000ms（实际 ${r.retryAfterMs}）`);
}
await failsWith(
  () => searchOnce({ baseUrl: `${base}/broken`, apiKey: 'k', query: 'x' }),
  NET_CODE.UPSTREAM,
  '500 → E4086',
);
await failsWith(
  () => searchOnce({ baseUrl: `${base}/quota`, apiKey: 'k', query: 'x' }),
  NET_CODE.QUOTA,
  '432 → E4083（配额）',
);

console.log('\n## 4. 超时与取消（真实连接）');

{
  const started = Date.now();
  const r = await searchOnce({ baseUrl: base, apiKey: 'k', query: '慢请求', timeoutMs: 400 });
  const took = Date.now() - started;
  ok(r.ok === false && r.code === NET_CODE.TIMEOUT, `慢请求应超时（实际 ${r.code}）`);
  ok(took < 3000, `超时要真的到点返回（用了 ${took}ms）`);
}

{
  const ctrl = new AbortController();
  const p = searchOnce({ baseUrl: base, apiKey: 'k', query: '慢请求', timeoutMs: 5000, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 120));
  ctrl.abort();
  const r = await p;
  ok(r.ok === false && r.code === NET_CODE.CANCELLED, '取消 → E4070（不是超时、不是失败）');
}

/* ------------------------------------------------------------ 4.5 宿主可信调用与配置上限 */

console.log('\n## 4.5 宿主可信调用：鉴权、配置上限、能力失效');

{
  let enabled = true;
  const factory = createNetFactory({ getEnabled: () => enabled, stats: createNetStats() });
  const baseCfg = { baseUrl: base, maxResults: 2 };
  const secrets = { apiKey: 'tvly-FAKE-KEY-FOR-VERIFY-0003' };
  const goodCall = {
    signal: new AbortController().signal,
    invocation: { pluginId: 'web-search', tool: 'plugin_web_search', origin: 'console' },
  };

  // 没有可信上下文 → E4071，零请求
  {
    const before = seen.requests.length;
    const net = factory.makeFor({ pluginId: 'web-search', config: baseCfg, secrets })({
      signal: new AbortController().signal,
    });
    const r = await net.search({ query: '无上下文' });
    ok(r.ok === false && r.code === 'E4071', '缺少 invocation → E4071');
    ok(seen.requests.length === before, '缺少 invocation 时零请求');
  }

  // 错误的工具 / 来源 → E4071
  for (const invocation of [
    { pluginId: 'web-search', tool: 'plugin_web_fetch', origin: 'console' },
    { pluginId: 'web-search', tool: 'plugin_web_search', origin: 'group:123' },
    { pluginId: 'other', tool: 'plugin_web_search', origin: 'console' },
  ]) {
    const before = seen.requests.length;
    const net = factory.makeFor({ pluginId: 'web-search', config: baseCfg, secrets })({
      signal: new AbortController().signal,
      invocation,
    });
    const r = await net.search({ query: '越权' });
    ok(r.ok === false && r.code === 'E4071', `不可信调用被拒：${JSON.stringify(invocation)}`);
    ok(seen.requests.length === before, '不可信调用零请求');
  }

  // 配置上限：模型参数只能减少
  {
    const net = factory.makeFor({ pluginId: 'web-search', config: baseCfg, secrets })(goodCall);
    const before = seen.requests.length;
    const r = await net.search({ query: '上限测试', maxResults: 20 });
    ok(r.ok === true, '配置上限内的搜索应成功');
    const sent = seen.requests.slice(before).find((x) => x.url === '/search');
    ok(sent?.body?.max_results === 2, `配置 2、参数 20 → 上游只能收到 2（实际 ${sent?.body?.max_results}）`);
  }

  // 未知 provider → E4081，零请求
  {
    const net = factory.makeFor({
      pluginId: 'web-search',
      config: { ...baseCfg, provider: 'bing' },
      secrets,
    })(goodCall);
    const before = seen.requests.length;
    const r = await net.search({ query: '未知服务' });
    ok(r.ok === false && r.code === NET_CODE.NOT_CONFIGURED, '未知 provider → E4081');
    ok(seen.requests.length === before, '未知 provider 时零请求');
  }

  // revoke：调用结束后能力失效
  {
    const net = factory.makeFor({ pluginId: 'web-search', config: baseCfg, secrets })(goodCall);
    net.revoke();
    const before = seen.requests.length;
    const r = await net.search({ query: '失效之后' });
    ok(r.ok === false && r.code === 'E4071', 'revoke 后 → E4071');
    ok(seen.requests.length === before, 'revoke 后零请求');
  }
}

/* ------------------------------------------------------------ 5. 总闸 */

console.log('\n## 5. 总闸：关掉之后一个请求都不发');

{
  let enabled = false;
  const before = seen.requests.length;
  const factory = createNetFactory({ getEnabled: () => enabled, stats: createNetStats() });
  const net = factory.makeFor({
    pluginId: 'web-search',
    config: { baseUrl: base },
    secrets: { apiKey: 'tvly-FAKE-KEY-FOR-VERIFY-0002' },
  })({
    signal: new AbortController().signal,
    // 宿主可信调用上下文（host-net 现在会校验；缺了会 E4071）
    invocation: { pluginId: 'web-search', tool: 'plugin_web_search', origin: 'console' },
  });

  const r = await net.search({ query: 'x' });
  ok(r.ok === false && r.code === NET_CODE.DISABLED, '关闸 → E4080');
  ok(seen.requests.length === before, '关闸后服务端一个请求都没收到');

  // 打开后能搜
  enabled = true;
  const r2 = await net.search({ query: '开了' });
  ok(r2.ok === true, '开闸后可以搜');
  ok(seen.requests.length === before + 1, '开闸后服务端收到 1 个请求');

  // 在途请求：开→关时立即中止
  const p = net.search({ query: '慢请求' });
  await new Promise((r) => setTimeout(r, 100));
  enabled = false;
  const aborted = factory.refresh();
  const r3 = await p;
  ok(aborted === 1, `refresh() 应中止 1 个在途请求（实际 ${aborted}）`);
  ok(r3.ok === false && r3.code === NET_CODE.CANCELLED, '在途请求被中止 → E4070');

  // 工具可见性
  ok(JSON.stringify(disabledNetTools({ network: { enabled: false } })) === JSON.stringify(NET_TOOL_NAMES),
    '关闸时联网工具应结构性不可见');
  ok(disabledNetTools({ network: { enabled: true } }) === null, '开闸时不禁用');

  const view = buildNetView({
    config: { network: { enabled: false } },
    plugin: { enabled: true, status: 'ready', config: [{ key: 'baseUrl', value: base }] },
    hasSecret: true,
    stats: createNetStats(),
  });
  ok(view.effective === 'off' && view.tools.length === 0, '快照：关闸时 effective=off、工具为空');
  ok(view.configured === true, '快照：密钥状态是布尔，不回显明文');
}

/* ------------------------------------------------------------ 6. 网页读取 */

console.log('\n## 6. 网页读取：内网与本机一律拒绝');

for (const url of [
  'http://127.0.0.1/',
  'http://localhost/',
  'http://192.168.1.1/',
  'http://[::1]/',
  'file:///C:/Windows/win.ini',
  'C:\\Windows\\win.ini',
  'ftp://example.com/x',
  'http://user:pw@example.com/',
]) {
  const r = await fetchText(url);
  ok(r.ok === false && r.code === NET_CODE.URL_REJECTED, `${url} → E4087`);
}

console.log('\n## 7. 网页读取：正常、类型、大小、重定向');

{
  /*
   * 这一组必须连本机才能测"真实抓取"，而本机地址在正常路径下是被拒的
   * （见上一组）。所以这里用两个**测试接缝**，只替换"最终把包送到哪"：
   *
   *   · resolveHost：把模拟域名解析成一个公网 IP（形状校验因此通过）；
   *   · requestOnce：把请求转到本地模拟服务（生产实现连的是已校验的 IP）。
   *
   * URL 形状、重定向逐跳校验、字节/类型/时间上限、HTML 降级 —— 这些
   * 判定全部还是生产代码。生产路径永远不会传这两个接缝。
   */
  const asPublic = async () => ['93.184.216.34'];
  /*
   * 逻辑 URL 不带端口：生产实现只允许 80/443（防止用公网域名扫对端任意端口）。
   * 随机端口只存在于 `requestOnce` 接缝内部，生产路径拿不到它。
   */
  const publicHost = 'public.example';
  const toLocal = (input) => requestOnce({
    ...input,
    url: new URL(`${input.url.pathname}${input.url.search}`, base),
    ip: '127.0.0.1',
    // 不要把接缝自己再传下去（下面调用的是生产实现）
    requestOnce: undefined,
  });

  const page = await fetchText(`http://${publicHost}/page`, { resolveHost: asPublic, requestOnce: toLocal });
  ok(page.ok === true, `正常网页应成功（实际 ${page.code ?? 'ok'}）`);
  ok(/标题/.test(page.text) && /正文/.test(page.text), '正文应保留');
  ok(!/evil\(\)/.test(page.text), 'script 内容必须被删掉');
  ok(page.contentType === 'text/html', '内容类型要正确');

  const binary = await fetchText(`http://${publicHost}/binary`, { resolveHost: asPublic, requestOnce: toLocal });
  ok(binary.ok === false && binary.code === NET_CODE.CONTENT, 'application/octet-stream → E4088');

  const huge = await fetchText(`http://${publicHost}/huge`, {
    resolveHost: asPublic,
    requestOnce: toLocal,
    maxBytes: 4096,
  });
  ok(huge.ok === true && huge.truncated === true, '超大响应应截断并标记 truncated');

  const redirect = await fetchText(`http://${publicHost}/redirect-internal`, {
    resolveHost: asPublic,
    requestOnce: toLocal,
  });
  ok(redirect.ok === false && redirect.code === NET_CODE.URL_REJECTED,
    '重定向到内网 → E4087（每一跳都重新校验）');

  const slow = await fetchText(`http://${publicHost}/slow-page`, {
    resolveHost: asPublic,
    requestOnce: toLocal,
    timeoutMs: 300,
  });
  ok(slow.ok === false && slow.code === NET_CODE.TIMEOUT, '慢页面应超时');
}

  console.log('\n## 7.5 网页读取：端口、URL 长度、缺失类型、多重编码');

  {
    const asPublic = async () => ['93.184.216.34'];
    const toLocal = (input) => requestOnce({
      ...input,
      url: new URL(`${input.url.pathname}${input.url.search}`, base),
      ip: '127.0.0.1',
      requestOnce: undefined,
    });

    const portBlocked = await fetchText(`http://public.example:${port}/page`, { resolveHost: asPublic });
    ok(portBlocked.ok === false && portBlocked.code === NET_CODE.URL_REJECTED, '逻辑 URL 非 80/443 端口 → E4087');

    const tooLong = await fetchText(`http://public.example/${'a'.repeat(2048)}`, { resolveHost: asPublic });
    ok(tooLong.ok === false && tooLong.code === NET_CODE.URL_REJECTED, 'URL 超过 2048 字符 → E4087');

    const noType = await fetchText('http://public.example/no-type', { resolveHost: asPublic, requestOnce: toLocal });
    ok(noType.ok === false && noType.code === NET_CODE.CONTENT, '缺少 Content-Type → E4088（不猜 HTML）');

    const multi = await fetchText('http://public.example/multi-encoding', {
      resolveHost: asPublic,
      requestOnce: toLocal,
    });
    ok(multi.ok === false && multi.code === NET_CODE.CONTENT, '多重 Content-Encoding → E4088');
  }

  /* ------------------------------------------------------------ 收尾 */

await new Promise((resolve) => server.close(resolve));
console.log(`\n全部完成：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
