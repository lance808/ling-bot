/**
 * 设置页数据接口
 *
 * 这些测试守三条会让功能"静默坏掉"的规则：
 *   1. 不回显令牌（回显了就等于把它打印在屏幕上）
 *   2. 空字符串 = 不改（否则"保存一次"就把令牌清空了）
 *   3. 鉴权拿不到就拒绝（fail-closed，不是放行）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { registerBridgeRoutes } from '../dsh-plugin/dsh-qq-bridge/lib/routes.js';

/**
 * 造一个假 webServer，直接把请求喂给 handler。
 *
 * 不用真 HTTP：这里要测的是**处理逻辑**（鉴权、字段合并），
 * 起监听端口只会让测试变慢且引入端口冲突。
 */
function makeHarness({ authenticated = true, config = {} } = {}) {
  /** @type {any} */
  let handler = null;
  /** @type {any[]} */
  const updates = [];
  /** @type {number} */
  let clears = 0;

  const webServer = {
    // 新契约：register 只收**一个对象** { kind, path, handler }
    register(route) {
      handler = route.handler;
      return () => {};
    },
  };

  registerBridgeRoutes(webServer, {
    readConfig: () => config,
    updateConfig: async (patch) => {
      updates.push(patch);
      Object.assign(config, patch);
    },
    clearToken: async () => {
      clears += 1;
      config.bridgeToken = '';
    },
    // 真实契约是 requestRejection({headers}) → 401|403|undefined
    connection: {
      requestRejection: () => (authenticated ? undefined : 401),
    },
  });

  /**
   * 发一个请求，返回 { status, body }。
   *
   * @param {string} url
   * @param {object} [body]
   * @param {string} [method]
   */
  const req = async (url, body, method) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const request = {
      url,
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    };
    let status = 0;
    let raw = '';
    const res = {
      writeHead(code) {
        status = code;
      },
      end(text) {
        raw += text ?? '';
      },
    };
    await handler(request, res);
    return { status, body: raw ? JSON.parse(raw) : null };
  };

  return { req, updates, get clears() { return clears; }, config };
}

/* ---------------------------------------------------------------- 读 */

test('读配置时不回显令牌，只告诉有没有', async () => {
  const h = makeHarness({ config: { bridgeToken: 'super-secret-token', bridgeUrl: 'http://x' } });
  const r = await h.req('/api/qq-bridge/config');
  assert.equal(r.status, 200);
  assert.equal(r.body.hasToken, true);
  // 这是最关键的一条：令牌一个字都不能出现在响应里
  assert.equal(JSON.stringify(r.body).includes('super-secret-token'), false);
  assert.equal(r.body.bridgeToken, undefined);
});

test('没配令牌时 hasToken 为 false', async () => {
  const h = makeHarness({ config: {} });
  const r = await h.req('/api/qq-bridge/config');
  assert.equal(r.body.hasToken, false);
});

/* ---------------------------------------------------------------- 写 */

test('令牌留空表示不改，不会把它清掉', async () => {
  const h = makeHarness({ config: { bridgeToken: 'old-token' } });
  await h.req('/api/qq-bridge/config', { bridgeUrl: 'http://new', bridgeToken: '' });
  assert.equal(h.updates.length, 1);
  assert.equal('bridgeToken' in h.updates[0], false, '空字符串不该进 patch');
  assert.equal(h.updates[0].bridgeUrl, 'http://new');
});

test('只有空白的令牌也不改', async () => {
  const h = makeHarness({ config: { bridgeToken: 'old' } });
  await h.req('/api/qq-bridge/config', { bridgeToken: '   ' });
  // 只有空白 → 没有有效字段 → 返回 400
  assert.equal(h.updates.length, 0);
});

test('填了新令牌才会改', async () => {
  const h = makeHarness({ config: { bridgeToken: 'old' } });
  const r = await h.req('/api/qq-bridge/config', { bridgeToken: 'fresh-token' });
  assert.equal(r.status, 200);
  assert.equal(h.updates[0].bridgeToken, 'fresh-token');
});

test('一次能改多个字段', async () => {
  const h = makeHarness();
  await h.req('/api/qq-bridge/config', {
    bridgeUrl: 'http://127.0.0.1:3458',
    admins: '10001,10002',
    relayApprovals: true,
    onUnreachable: 'delegate',
  });
  assert.deepEqual(h.updates[0], {
    bridgeUrl: 'http://127.0.0.1:3458',
    admins: '10001,10002',
    relayApprovals: true,
    onUnreachable: 'delegate',
  });
});

test('没有要改的字段时明确报错，不静默成功', async () => {
  const h = makeHarness();
  const r = await h.req('/api/qq-bridge/config', {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /没有要改/);
});

/* ---------------------------------------------------------------- 清令牌 */

test('清令牌走独立路由', async () => {
  const h = makeHarness({ config: { bridgeToken: 't' } });
  const r = await h.req('/api/qq-bridge/config/clear-token', {});
  assert.equal(r.status, 200);
  assert.equal(h.clears, 1);
});

/* ---------------------------------------------------------------- 鉴权 */

test('★ 未通过鉴权时一律 401，且不改任何东西', async () => {
  const h = makeHarness({ authenticated: false, config: { bridgeToken: 'x' } });
  const r1 = await h.req('/api/qq-bridge/config');
  assert.equal(r1.status, 401);
  const r2 = await h.req('/api/qq-bridge/config', { bridgeUrl: 'http://evil' });
  assert.equal(r2.status, 401);
  assert.equal(h.updates.length, 0, '未鉴权的写入必须一个字都没写');
  const r3 = await h.req('/api/qq-bridge/config/clear-token', {});
  assert.equal(r3.status, 401);
  assert.equal(h.clears, 0);
});

test('★ 拿不到鉴权能力时拒绝（fail-closed，不是放行）', async () => {
  let handler = null;
  registerBridgeRoutes(
    { register: (route) => { handler = route.handler; return () => {}; } },
    {
      readConfig: () => ({ bridgeToken: 'x' }),
      updateConfig: async () => {},
      clearToken: async () => {},
      connection: null, // 拿不到
    },
  );
  let status = 0;
  await handler(
    { url: '/api/qq-bridge/config', method: 'GET', async *[Symbol.asyncIterator]() {} },
    { writeHead: (c) => { status = c; }, end: () => {} },
  );
  assert.equal(status, 401, '拿不到鉴权就必须拒绝');
});

/* ---------------------------------------------------------------- 其它 */

test('未知路由 404', async () => {
  const h = makeHarness();
  const r = await h.req('/api/qq-bridge/nope');
  assert.equal(r.status, 404);
});

test('查询串不影响路由匹配', async () => {
  const h = makeHarness({ config: { bridgeToken: 'x' } });
  const r = await h.req('/api/qq-bridge/config?t=1');
  assert.equal(r.status, 200);
});

test('响应禁止缓存（配置是实时的）', async () => {
  let headers = {};
  let handler = null;
  registerBridgeRoutes(
    { register: (route) => { handler = route.handler; return () => {}; } },
    {
      readConfig: () => ({}),
      updateConfig: async () => {},
      clearToken: async () => {},
      connection: { requestRejection: () => undefined },
    },
  );
  await handler(
    { url: '/api/qq-bridge/config', method: 'GET', async *[Symbol.asyncIterator]() {} },
    { writeHead: (c, hd) => { headers = hd; }, end: () => {} },
  );
  assert.equal(headers['cache-control'], 'no-store');
});

/* ---------------------------------------------------------------- 契约 */

test('★ register 必须按 { kind, path, handler } 一个对象调用', async () => {
  // 这条守的是一个真实踩过的坑：写成 register(handler, { prefix }) 时，
  // 注册不会报错，但路由永远匹配不上，请求落到兜底返回纯文本 "not found"，
  // 前端 parse 那个响应就得到 "Unexpected token 'o'"。
  /** @type {any} */
  let captured = null;
  registerBridgeRoutes(
    {
      register(route) {
        captured = route;
        return () => {};
      },
    },
    {
      readConfig: () => ({}),
      updateConfig: async () => {},
      clearToken: async () => {},
      connection: { requestRejection: () => undefined },
    },
  );

  assert.ok(captured, '必须调用了 register');
  assert.equal(typeof captured, 'object', '必须传一个对象，不能传两个参数');
  assert.equal(captured.kind, 'prefix');
  assert.equal(captured.path, '/api/qq-bridge');
  assert.equal(typeof captured.handler, 'function');
});

test('★ 不能调用不存在的 connection.isAuthenticated', async () => {
  // 这条守的是一个真实踩过的坑：DSH 的 connection 根本没有
  // isAuthenticated —— 只有 requestRejection。调用它时异常被 catch 吞掉、
  // 统一返回 false，结果**带着合法会话过来也一律 401**，
  // 而界面上只显示"保存失败"。
  const src = await import('node:fs/promises').then((m) =>
    m.readFile(new URL('../dsh-plugin/dsh-qq-bridge/lib/routes.js', import.meta.url), 'utf8'),
  );
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n');
  assert.equal(/isAuthenticated/.test(code), false, 'connection 没有 isAuthenticated 这个方法');
  assert.ok(/requestRejection/.test(code), '必须用 requestRejection');
});
