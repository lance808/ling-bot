/**
 * 网页读取（web_fetch）安全专项 —— URL 形状、类型、大小、编码、取消、重定向
 *
 * ## 为什么单独一份
 *
 * `web_fetch` 是整个项目里唯一"目标地址由外部内容决定"的能力，也就是
 * SSRF 的正面入口。它要同时防住这些互不相干的事：
 *
 *   1. **地址形状**：超长 URL、非 80/443 端口（公网域名 + 任意端口 = 端口扫描）；
 *   2. **内容类型**：缺失类型与二进制类型都拒绝（不能"猜 HTML"）；
 *   3. **大小**：解压前（wire）与解压后（decoded）各有限制，且到限就**停**，
 *      不是"读完了再截断"；
 *   4. **编码**：多重 / 未知 Content-Encoding 一律拒绝（猜错顺序 = 把压缩流
 *      当正文交给模型）；
 *   5. **取消与超时**：DNS 挂起时也要受总 deadline / signal 约束，
 *      取消后晚返回的 DNS 不得再发请求；
 *   6. **重定向**：每一跳重新校验，内网 / 非 http / 带凭据 / 非标准端口全拒。
 *
 * ## 本地模拟方式
 *
 * 逻辑 URL 一律是 `http://public.example/...`（无端口），
 * `requestOnce` 接缝把它换到本机 `127.0.0.1:<随机端口>` 上的临时 HTTP 服务；
 * DNS 接缝固定返回一个公网 IP。**不给生产代码加私网白名单** ——
 * 随机端口只存在于本测试的接缝内部。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchText,
  requestOnce,
  checkFetchUrlShape,
  parseContentEncoding,
} from '../src/net/http.mjs';
import { NET_CODE } from '../src/net/gate.mjs';

/** 公网测试 IP（永不真的连它：一律走接缝） */
const PUBLIC_IP = '93.184.216.34';
const publicDns = async () => [PUBLIC_IP];

/** 起一个本机临时 HTTP 服务（随机端口） */
function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** @param {import('node:http').Server} server */
function portOf(server) {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

/** @param {import('node:http').Server} server */
function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * 把一个逻辑 URL 接到本机临时端口上。
 *
 * 注意：只在接缝内部换 host/port，`fetchText` 看到的仍是 `public.example`。
 *
 * @param {number} port
 * @returns {{calls: number, requestOnce: Function}}
 */
function localSeam(port) {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    requestOnce: async (input) => {
      state.calls += 1;
      const local = new URL(input.url.toString());
      local.protocol = 'http:';
      local.hostname = '127.0.0.1';
      local.port = String(port);
      return requestOnce({
        url: local,
        ip: '127.0.0.1',
        maxBytes: input.maxBytes,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
    },
  };
}

/**
 * 走本机服务抓一次逻辑网页。
 *
 * @param {number} port
 * @param {string} url
 * @param {object} [opts]
 */
function fetchLocal(port, url, opts = {}) {
  const seam = localSeam(port);
  return {
    seam,
    run: () => fetchText(url, { resolveHost: publicDns, requestOnce: seam.requestOnce, ...opts }),
  };
}

/** 造一个"按路径返回固定页"的 requestOnce 接缝（不启服务，专测重定向逻辑） */
function fakePages(pages) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    requestOnce: async (input) => {
      const key = `${input.url.hostname}${input.url.pathname}`;
      calls.push(key);
      const page = pages[key];
      if (!page) {
        return { statusCode: 404, headers: {}, buffer: Buffer.alloc(0), truncated: false, contentType: 'text/plain' };
      }
      return {
        statusCode: page.status ?? 200,
        headers: page.headers ?? {},
        buffer: Buffer.from(page.body ?? '', 'utf8'),
        truncated: page.truncated === true,
        contentType: page.contentType ?? 'text/plain',
      };
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ 1. URL 形状 */

test('★ 超长 URL（>2048）→ E4087，零请求', async () => {
  let requests = 0;
  const requestOnce = async () => {
    requests += 1;
    return { statusCode: 200, headers: {}, buffer: Buffer.alloc(0), truncated: false, contentType: 'text/plain' };
  };
  const url = `http://public.example/${'a'.repeat(2100)}`;
  assert.ok(url.length > 2048);
  const r = await fetchText(url, { resolveHost: publicDns, requestOnce });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.URL_REJECTED, `应报 E4087，实际 ${r.code}: ${r.message}`);
  assert.match(r.message, /2048|过长|超过/, '错误消息应说明长度限制');
  assert.equal(requests, 0, '超长地址不得发出任何请求');
});

test('★ 非 80/443 端口 → E4087，零请求（公网域名 + 任意端口 = 端口扫描）', async () => {
  const cases = ['http://public.example:8080/x', 'https://public.example:8443/x', 'http://public.example:22/x'];
  for (const url of cases) {
    let requests = 0;
    const requestOnce = async () => {
      requests += 1;
      return { statusCode: 200, headers: {}, buffer: Buffer.alloc(0), truncated: false, contentType: 'text/plain' };
    };
    const r = await fetchText(url, { resolveHost: publicDns, requestOnce });
    assert.equal(r.ok, false, `${url} 必须被拒`);
    assert.equal(r.code, NET_CODE.URL_REJECTED, `${url} 应报 E4087`);
    assert.equal(requests, 0, `${url} 不得发出请求`);
  }

  // 标准端口放行（形状层）
  assert.equal(checkFetchUrlShape(new URL('http://public.example:80/x')).ok, true);
  assert.equal(checkFetchUrlShape(new URL('https://public.example:443/x')).ok, true);
  assert.equal(checkFetchUrlShape(new URL('http://public.example/x')).ok, true);
});

/* ------------------------------------------------------------ 2. 内容类型 */

test('★ 响应缺少 Content-Type → E4088（不再猜 HTML）', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-length': '2' });
    res.end('hi');
  });
  try {
    const { run } = fetchLocal(portOf(server), 'http://public.example/no-type');
    const r = await run();
    assert.equal(r.ok, false, '缺失 Content-Type 不能当正文读');
    assert.equal(r.code, NET_CODE.CONTENT, `应报 E4088，实际 ${r.code}: ${r.message}`);
    assert.match(r.message, /Content-Type/, '错误消息应点明缺类型');
  } finally {
    await closeServer(server);
  }
});

test('★ application/octet-stream → E4088，且不把正文读完', async () => {
  const total = 4 * 1024 * 1024;
  const state = { written: 0, done: false };
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024, 0x00);
    const pump = () => {
      while (state.written < total && !state.done && !res.destroyed) {
        state.written += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      if (!res.destroyed) res.end();
    };
    res.on('close', () => {
      state.done = true;
    });
    res.on('error', () => {
      state.done = true;
    });
    pump();
  });
  try {
    const { run } = fetchLocal(portOf(server), 'http://public.example/a.bin');
    const r = await run();
    assert.equal(r.ok, false);
    assert.equal(r.code, NET_CODE.CONTENT, `应报 E4088，实际 ${r.code}`);
    await sleep(50);
    assert.ok(state.written < total / 2, `类型被拒后必须停止下载（已写出 ${state.written} / ${total}）`);
  } finally {
    await closeServer(server);
  }
});

test('multipart / 未知 Content-Encoding → E4088（不猜解码顺序）', async () => {
  assert.equal(parseContentEncoding('gzip, br').ok, false, '多重编码必须拒绝');
  assert.equal(parseContentEncoding('zstd').ok, false, '未知编码必须拒绝');
  assert.equal(parseContentEncoding('').ok, true, '空编码合法');
  assert.equal(parseContentEncoding('identity').ok, true, 'identity 合法');
  assert.equal(parseContentEncoding('gzip').ok, true, 'gzip 合法');

  const cases = [
    ['多重编码', 'gzip, br'],
    ['未知编码', 'zstd'],
  ];
  for (const [why, encoding] of cases) {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding });
      res.end('hello');
    });
    try {
      const { run } = fetchLocal(portOf(server), 'http://public.example/enc');
      const r = await run();
      assert.equal(r.ok, false, `${why} 必须被拒`);
      assert.equal(r.code, NET_CODE.CONTENT, `${why} 应报 E4088，实际 ${r.code}: ${r.message}`);
    } finally {
      await closeServer(server);
    }
  }
});

/* ------------------------------------------------------------ 3. 大小限制 */

test('★ 解压后（decoded）字节受 maxBytes 限制：gzip 炸弹只解出上限内的内容', async () => {
  const payload = Buffer.alloc(1024 * 1024, 0x61); // 1MB 的 a，压缩后只有 ~1KB
  const gz = zlib.gzipSync(payload);
  assert.ok(gz.length < 4096, '前置条件：压缩后远小于解压后');
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
    res.end(gz);
  });
  try {
    const { run } = fetchLocal(portOf(server), 'http://public.example/bomb', { maxBytes: 4096 });
    const r = await run();
    assert.equal(r.ok, true, '超出上限是"截断"，不是失败');
    assert.equal(r.truncated, true, '解压后超限必须标 truncated');
    assert.ok(Buffer.byteLength(r.text) <= 4096, `返回正文不得超过上限（实际 ${Buffer.byteLength(r.text)}）`);
    assert.ok(r.text.length < payload.length, '不能把整颗炸弹交给模型');
  } finally {
    await closeServer(server);
  }
});

test('★ 解压前（wire）字节同样受 maxBytes 限制', async () => {
  /*
   * 用一个"压缩后比解压后更大"的样本把两个上限分开：
   * 随机数据 gzip 后会略大于原文，于是"解压后没超限、但收到的字节超限"
   * 这种情况只会被 wire 计数拦住。只实现 decoded 上限时这条会失败。
   */
  const payload = crypto.randomBytes(2000);
  const gz = zlib.gzipSync(payload);
  const maxBytes = gz.length - 1;
  assert.ok(maxBytes >= 1024, '前置条件：上限不能低于硬下限');
  assert.ok(gz.length > payload.length, '前置条件：压缩后确实比原文大');
  assert.ok(payload.length < maxBytes, `前置条件：解压后（${payload.length}）没超限，超限的只有 wire（${gz.length} > ${maxBytes}）`);

  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
    res.end(gz);
  });
  try {
    const { run } = fetchLocal(portOf(server), 'http://public.example/wire', { maxBytes });
    const r = await run();
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true, '压缩前的字节超限也必须标 truncated');
    assert.ok(Buffer.byteLength(r.text) <= maxBytes);
  } finally {
    await closeServer(server);
  }
});

test('★ 截断后必须真的停止下载（不是"读完再丢"）', async () => {
  const total = 8 * 1024 * 1024;
  const state = { written: 0, done: false };
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const chunk = Buffer.alloc(64 * 1024, 0x62);
    const pump = () => {
      while (state.written < total && !state.done && !res.destroyed) {
        state.written += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      if (!res.destroyed) res.end();
    };
    res.on('close', () => {
      state.done = true;
    });
    res.on('error', () => {
      state.done = true;
    });
    pump();
  });
  try {
    const startedAt = Date.now();
    const { run } = fetchLocal(portOf(server), 'http://public.example/huge', { maxBytes: 4096 });
    const r = await run();
    const elapsed = Date.now() - startedAt;
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true, '超限必须标 truncated');
    assert.ok(r.bytes <= 4096, `返回字节数不得超过上限（实际 ${r.bytes}）`);
    assert.ok(elapsed < 3000, `到上限就该立刻返回（实际 ${elapsed}ms）`);
    await sleep(80);
    assert.ok(
      state.written < total / 2,
      `截断后对端不该继续被读（服务端已写出 ${state.written} / ${total}）`,
    );
  } finally {
    await closeServer(server);
  }
});

/* ------------------------------------------------------------ 4. 取消与超时 */

test('★ DNS 挂起时取消：立刻返回 E4070，晚到的解析结果不得再发请求', async () => {
  const controller = new AbortController();
  let requested = 0;
  const slowDns = () => new Promise((resolve) => setTimeout(() => resolve([PUBLIC_IP]), 200));

  const startedAt = Date.now();
  const pending = fetchText('https://public.example/slow-dns', {
    resolveHost: slowDns,
    requestOnce: async (input) => {
      requested += 1;
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        buffer: Buffer.from('不该到这里'),
        truncated: false,
        contentType: 'text/plain',
      };
    },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  const r = await pending;
  const elapsed = Date.now() - startedAt;

  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.CANCELLED, `取消应报 E4070，实际 ${r.code}: ${r.message}`);
  assert.equal(requested, 0, '取消之后晚返回的 DNS 不得再发请求');
  assert.ok(elapsed < 180, `取消必须在 DNS 返回之前生效（实际 ${elapsed}ms）`);
});

test('DNS 挂起时也受总 deadline 约束（不会被 DNS 拖过总时限）', async () => {
  const hangingDns = () => new Promise(() => {});
  const startedAt = Date.now();
  const r = await fetchText('https://public.example/hang', {
    resolveHost: hangingDns,
    requestOnce: async () => {
      throw new Error('不该发请求');
    },
    timeoutMs: 1000,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.TIMEOUT, `应报 E4084，实际 ${r.code}: ${r.message}`);
  assert.ok(elapsed < 2500, `总 deadline 必须覆盖 DNS（实际 ${elapsed}ms）`);
});

/* ------------------------------------------------------------ 5. 正文长度 */

test('★ maxChars：默认 20000、上限 50000（与工具说明一致）', async () => {
  const body = 'x'.repeat(60_000);
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  try {
    const port = portOf(server);

    const dflt = await fetchLocal(port, 'http://public.example/long').run();
    assert.equal(dflt.ok, true);
    assert.equal(dflt.text.length, 20_000, `默认上限应为 20000，实际 ${dflt.text.length}`);
    assert.equal(dflt.truncated, true);

    const small = await fetchLocal(port, 'http://public.example/long', { maxChars: 300 }).run();
    assert.equal(small.text.length, 300, '显式 maxChars 生效');

    const over = await fetchLocal(port, 'http://public.example/long', { maxChars: 100_000 }).run();
    assert.equal(over.text.length, 50_000, `maxChars 上限应夹到 50000，实际 ${over.text.length}`);
    assert.equal(over.truncated, true);
  } finally {
    await closeServer(server);
  }
});

/* ------------------------------------------------------------ 6. 重定向 */

test('★ 重定向每一跳重新校验：内网 / 凭据 / 非标准端口 / 非 http 全拒', async () => {
  const cases = [
    ['重定向到内网', 'http://127.0.0.1/secret'],
    ['重定向到内网域名', 'http://192.168.1.1/admin'],
    ['重定向带凭据', 'https://user:pw@public.example/secret'],
    ['重定向到非标准端口', 'http://public.example:8080/scan'],
    ['重定向到非 http 协议', 'file:///C:/Windows/win.ini'],
  ];
  for (const [why, location] of cases) {
    const web = fakePages({
      'public.example/': { status: 302, headers: { location, 'content-type': 'text/plain' } },
      'public.example/next': { body: '不该到这里' },
    });
    const r = await fetchText('https://public.example/', {
      resolveHost: publicDns,
      requestOnce: web.requestOnce,
    });
    assert.equal(r.ok, false, `${why} 必须被拒`);
    assert.equal(r.code, NET_CODE.URL_REJECTED, `${why} 应报 E4087，实际 ${r.code}: ${r.message}`);
    assert.equal(web.calls.length, 1, `${why}：只允许第一跳（公网那一跳）发出，实际 ${web.calls.join(',')}`);
  }
});

test('★ 重定向到的域名解析到内网 → E4087（DNS 层逐跳校验）', async () => {
  const web = fakePages({
    'public.example/': { status: 302, headers: { location: 'https://evil.example/secret' } },
    'evil.example/secret': { body: '不该到这里' },
  });
  const resolveHost = async (hostname) => (hostname === 'evil.example' ? ['10.0.0.5'] : [PUBLIC_IP]);
  const r = await fetchText('https://public.example/', {
    resolveHost,
    requestOnce: web.requestOnce,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.URL_REJECTED, `应报 E4087，实际 ${r.code}: ${r.message}`);
  assert.equal(web.calls.length, 1, '内网那一跳不得发出请求');
});

test('重定向到合法公网地址仍可跟随（逐跳校验不是"全拒"）', async () => {
  const web = fakePages({
    'public.example/': { status: 302, headers: { location: 'https://public.example/next' } },
    'public.example/next': { body: '最终正文' },
  });
  const r = await fetchText('https://public.example/', {
    resolveHost: publicDns,
    requestOnce: web.requestOnce,
  });
  assert.equal(r.ok, true, `正常跳转应成功：${r.message ?? ''}`);
  assert.equal(r.finalUrl, 'https://public.example/next');
  assert.equal(r.redirects, 1);
  assert.match(r.text, /最终正文/);
  assert.equal(web.calls.length, 2);
});

test('重定向超过 4 跳 → E4087（不无限跟）', async () => {
  const web = fakePages({
    'a.example/': { status: 302, headers: { location: 'https://b.example/' } },
    'b.example/': { status: 302, headers: { location: 'https://c.example/' } },
    'c.example/': { status: 302, headers: { location: 'https://d.example/' } },
    'd.example/': { status: 302, headers: { location: 'https://e.example/' } },
    'e.example/': { status: 302, headers: { location: 'https://f.example/' } },
    'f.example/': { status: 302, headers: { location: 'https://g.example/' } },
  });
  const r = await fetchText('https://a.example/', { resolveHost: publicDns, requestOnce: web.requestOnce });
  assert.equal(r.ok, false);
  assert.equal(r.code, NET_CODE.URL_REJECTED, `应报 E4087，实际 ${r.code}: ${r.message}`);
  assert.match(r.message, /重定向次数/);
});
