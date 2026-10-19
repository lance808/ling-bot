/**
 * 模型目录读取（GET /models）
 *
 * 这里守的核心是**区分"读不到"和"读到空的"**：
 *   不少中转站会把未知路径回退到首页，于是 baseUrl 填错时拿到的是
 *   HTTP 200 + 一段 HTML —— 状态码完全正常。
 *   如果只按 200 判断，就会解析出"0 个模型"并显示成"读取成功"，
 *   用户会以为服务商一个模型都没提供。这是静默失败，必须拦下。
 *
 * 用本地 HTTP 服务模拟各种响应，不依赖外网（这样测试永远能跑）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { LlmClient, LlmError } from '../src/llm/client.mjs';

/**
 * 起一个临时服务，按 handler 响应。
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>, lastPath: () => string}>}
 */
async function serve(handler) {
  let last = '';
  const server = http.createServer((req, res) => {
    last = req.url ?? '';
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = /** @type {any} */ (server.address()).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    lastPath: () => last,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

const mkClient = (baseUrl) =>
  new LlmClient({ baseUrl, model: 'test-model', apiKey: 'sk-test', timeoutMs: 5000 });

test('读标准 OpenAI 形状 {data:[{id}]}', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'b-model' }, { id: 'a-model' }] }));
  });
  try {
    const models = await mkClient(s.baseUrl).listModels();
    // 必须排序：目录乱序时下拉框会跳来跳去
    assert.deepEqual(models, ['a-model', 'b-model']);
    assert.equal(s.lastPath(), '/v1/models');
  } finally {
    await s.close();
  }
});

test('读数组形状 [{id}]（部分中转）', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: 'x' }, { id: 'y' }]));
  });
  try {
    assert.deepEqual(await mkClient(s.baseUrl).listModels(), ['x', 'y']);
  } finally {
    await s.close();
  }
});

test('字符串数组也接受', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(['m1', 'm2']));
  });
  try {
    assert.deepEqual(await mkClient(s.baseUrl).listModels(), ['m1', 'm2']);
  } finally {
    await s.close();
  }
});

test('去重', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'dup' }, { id: 'dup' }, { id: 'other' }] }));
  });
  try {
    assert.deepEqual(await mkClient(s.baseUrl).listModels(), ['dup', 'other']);
  } finally {
    await s.close();
  }
});

test('★ 返回 HTML 时必须是错误，不能当成 0 个模型', async () => {
  // 这就是真实踩到的坑：填错路径时中转站回退到首页，HTTP 200 + HTML
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body>Welcome</body></html>');
  });
  try {
    await assert.rejects(
      () => mkClient(s.baseUrl).listModels(),
      (err) => {
        assert.ok(err instanceof LlmError);
        assert.equal(err.code, 'E3021');
        // 报错要说人话，并且指出实际请求的地址，方便排查 baseUrl
        assert.match(err.message, /网页而不是模型列表/);
        assert.match(err.message, /models/);
        return true;
      },
    );
  } finally {
    await s.close();
  }
});

test('★ 空列表必须报错，不能显示成"读取成功"', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  try {
    await assert.rejects(
      () => mkClient(s.baseUrl).listModels(),
      (err) => err instanceof LlmError && err.code === 'E3021' && /模型列表是空的/.test(err.message),
    );
  } finally {
    await s.close();
  }
});

test('非 JSON 响应报错', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json at all');
  });
  try {
    await assert.rejects(
      () => mkClient(s.baseUrl).listModels(),
      (err) => err instanceof LlmError && err.code === 'E3021' && /不是 JSON/.test(err.message),
    );
  } finally {
    await s.close();
  }
});

test('HTTP 非 2xx 报错并带状态码', async () => {
  const s = await serve((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  try {
    await assert.rejects(
      () => mkClient(s.baseUrl).listModels(),
      (err) => err instanceof LlmError && err.code === 'E3021' && /401/.test(err.message),
    );
  } finally {
    await s.close();
  }
});

test('没有 key 时不发请求，直接报 E3020', async () => {
  const c = new LlmClient({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: '', timeoutMs: 1000 });
  await assert.rejects(
    () => c.listModels(),
    (err) => err instanceof LlmError && err.code === 'E3020',
  );
});

test('地址规范化：只填域名 → /v1/models', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'a' }] }));
  });
  try {
    const bare = s.baseUrl.replace(/\/v1$/, '');
    await mkClient(bare).listModels();
    assert.equal(s.lastPath(), '/v1/models');
  } finally {
    await s.close();
  }
});

test('地址规范化：误填了 /chat/completions → 回到同级 /models', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'a' }] }));
  });
  try {
    await mkClient(`${s.baseUrl}/chat/completions`).listModels();
    assert.equal(s.lastPath(), '/v1/models');
  } finally {
    await s.close();
  }
});

test('两个地址方法保持一致（不能对话能通、读目录 404）', () => {
  for (const base of [
    'https://a.com',
    'https://a.com/v1',
    'https://a.com/v1/',
    'https://a.com/v1/chat/completions',
  ]) {
    const c = mkClient(base);
    const chat = c.chatUrl();
    const models = c.modelsUrl();
    // 去掉尾部资源名后，前缀必须一致
    assert.equal(
      chat.replace(/\/chat\/completions$/, ''),
      models.replace(/\/models$/, ''),
      `地址不一致：base=${base} chat=${chat} models=${models}`,
    );
  }
});
