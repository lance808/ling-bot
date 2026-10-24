import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  ModelProbe,
  ModelProbeError,
  cleanText,
  findCatalogModel,
  listModels,
  modelsEndpoint,
  parseModelCatalog,
} from '../plugins/image-generation/lib/models.mjs';
import { normalizeConfig } from '../plugins/image-generation/lib/config.mjs';
import { createImagePlugin } from '../plugins/image-generation/index.mjs';
import { normalizeManifest, deriveToolPolicy } from '../src/plugins/manifest.mjs';
import { chatGrantAllows } from '../src/guard/chat-grant.mjs';

/** 本地 HTTP 模拟；测试结束先销毁残留 socket，避免超时用例拖住 close。 */
async function makeServer(t, handler) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    try {
      handler(req, res);
    } catch {
      res.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const catalogBody = {
  data: [
    { id: 'zeta-image', owned_by: 'lab', capabilities: { image_generation: true } },
    { id: 'alpha-text', owned_by: 'lab', capabilities: ['chat', 'text_generation'] },
    'beta-model',
  ],
};

test('modelsEndpoint：兼容基址、生图端点与完整 models 端点', () => {
  assert.equal(modelsEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/models');
  assert.equal(modelsEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1/models');
  assert.equal(
    modelsEndpoint('https://api.example.com/v1/images/generations'),
    'https://api.example.com/v1/models',
  );
  assert.equal(modelsEndpoint('https://api.example.com/v1/models'), 'https://api.example.com/v1/models');
  assert.equal(modelsEndpoint('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/models');
});

test('modelsEndpoint：拒绝空值、非 HTTP、URL 内凭据/查询/片段', () => {
  for (const bad of [
    '',
    'ftp://example.com/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?key=secret',
    'https://example.com/v1#fragment',
  ]) {
    assert.throws(() => modelsEndpoint(bad), (error) => error.code === 'CONFIG_BAD_API_URL');
  }
});

test('parseModelCatalog：兼容三种目录形状、去重、排序与截断', () => {
  const parsed = parseModelCatalog(catalogBody, { maxModels: 2 });
  assert.deepEqual(parsed.models.map((m) => m.id), ['alpha-text', 'beta-model']);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.invalidRows, 0);

  const asModels = parseModelCatalog({ models: [{ name: 'x' }, { model: 'y' }, { id: 'x' }] });
  assert.deepEqual(asModels.models.map((m) => m.id), ['x', 'y']);
  assert.equal(asModels.total, 2);

  assert.deepEqual(parseModelCatalog([]).models, []);
  assert.deepEqual(parseModelCatalog({ data: [] }).models, []);
  assert.throws(() => parseModelCatalog({}), (e) => e.code === 'UPSTREAM_BAD_MODELS');
});

test('parseModelCatalog：只读元数据声明；不按模型名推断；false 不算支持', () => {
  const parsed = parseModelCatalog({
    data: [
      { id: 'declared-gen', capabilities: { image_generation: true } },
      { id: 'declared-vision', capabilities: ['vision'] },
      { id: 'declared-chat', modalities: ['text'], type: 'chat' },
      { id: 'declared-edit', features: ['image_edit'] },
      { id: 'false-claim', capabilities: { image_generation: false } },
      { id: 'string-false-claim', capabilities: { image_generation: 'false' } },
      { id: 'nested-false-claim', capabilities: { image_generation: { supported: false } } },
      { id: 'dall-e-3' },
      { id: 'flux-pro' },
    ],
  });
  const byId = Object.fromEntries(parsed.models.map((m) => [m.id, m]));
  assert.equal(byId['declared-gen'].declared.imageGeneration, true);
  assert.equal(byId['declared-vision'].declared.vision, true);
  assert.equal(byId['declared-vision'].declared.imageGeneration, null);
  assert.equal(byId['declared-chat'].declared.chat, true);
  assert.equal(byId['declared-edit'].declared.imageEditing, true);
  assert.equal(byId['false-claim'].declared.imageGeneration, null);
  assert.equal(byId['string-false-claim'].declared.imageGeneration, null);
  assert.equal(byId['nested-false-claim'].declared.imageGeneration, null);
  // 没有能力元数据时完全不猜——名字像生图模型也不行。
  assert.equal(byId['dall-e-3'].declared, undefined);
  assert.equal(byId['flux-pro'].declared, undefined);
});

test('parseModelCatalog：清理控制字符与超长字段，保留合法 Unicode ID', () => {
  const parsed = parseModelCatalog({
    data: [
      { id: '  bad\u0000id\nnext  ', owned_by: 'x'.repeat(300) },
      { id: '模型-一', capabilities: ['vision'] },
      { id: '' },
      { id: 42 },
    ],
  });
  const cleaned = parsed.models.find((m) => m.id === 'bad id next');
  assert.ok(cleaned, '控制字符应被清理为普通空格');
  assert.equal(cleaned.ownedBy.length, 120);
  assert.ok(parsed.models.some((m) => m.id === '模型-一'));
  assert.equal(parsed.invalidRows, 2);
  assert.equal(cleanText(' a\n b ', 10), 'a b');
});

test('findCatalogModel：精确优先、大小写不敏感，不做模糊/前缀匹配', () => {
  const models = [{ id: 'Flux-Pro' }, { id: 'flux' }];
  assert.equal(findCatalogModel(models, 'Flux-Pro').matchedBy, 'exact');
  assert.equal(findCatalogModel(models, 'flux-pro').matchedBy, 'case-insensitive');
  assert.equal(findCatalogModel(models, 'flux-pro-max').entry, null);
  assert.equal(findCatalogModel(models, '').entry, null);
});

test('listModels：成功时只发一次 GET，路径/认证正确，结果不含 Key', async (t) => {
  const requests = [];
  const { base } = await makeServer(t, async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(catalogBody));
  });

  const result = await listModels({ apiUrl: `${base}/v1`, apiKey: 'local-test-key' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, '/v1/models');
  assert.equal(requests[0].authorization, 'Bearer local-test-key');
  assert.match(requests[0].accept, /application\/json/);
  assert.equal(result.endpoint, `${base}/v1/models`);
  assert.equal(result.total, 3);
  assert.deepEqual(result.models.map((m) => m.id), ['alpha-text', 'beta-model', 'zeta-image']);
  assert.equal(JSON.stringify(result).includes('local-test-key'), false);
});

test('listModels：3xx 一律拒绝，不跟随到第二台主机', async (t) => {
  let leaked = 0;
  const second = await makeServer(t, (_req, res) => {
    leaked += 1;
    res.end('{}');
  });
  let firstHits = 0;
  const first = await makeServer(t, (_req, res) => {
    firstHits += 1;
    res.writeHead(302, { location: `${second.base}/leak` });
    res.end();
  });

  await assert.rejects(
    listModels({ apiUrl: first.base, apiKey: 'local-test-key' }),
    (error) => error.code === 'UPSTREAM_REDIRECT' && error.status === 302,
  );
  assert.equal(firstHits, 1);
  assert.equal(leaked, 0);
});

test('listModels：4xx/5xx、200 包 error、坏 JSON 都只报本地 code，不重试', async (t) => {
  let hits = 0;
  let status = 401;
  let body = '{"error":"upstream-sensitive-body"}';
  const { base } = await makeServer(t, (_req, res) => {
    hits += 1;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });

  for (const [code, nextStatus] of [
    ['UPSTREAM_HTTP_ERROR', 401],
    ['UPSTREAM_HTTP_ERROR', 500],
    ['UPSTREAM_ERROR', 200],
    ['UPSTREAM_BAD_JSON', 200],
  ]) {
    status = nextStatus;
    body = nextStatus === 200 && code === 'UPSTREAM_ERROR'
      ? '{"error":{"message":"upstream-sensitive-body"}}'
      : nextStatus === 200
        ? 'not json'
        : '{"error":"upstream-sensitive-body"}';
    hits = 0;
    await assert.rejects(
      listModels({ apiUrl: `${base}/v1`, apiKey: 'local-test-key' }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(String(error.message).includes('upstream-sensitive-body'), false);
        assert.equal(String(error.message).includes('local-test-key'), false);
        return true;
      },
    );
    assert.equal(hits, 1, '不允许自动重试');
  }
});

test('listModels：响应超过上限按流式/长度双重截断', async (t) => {
  let hits = 0;
  const { base } = await makeServer(t, (_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
    res.end('a'.repeat(5000));
  });
  await assert.rejects(
    listModels({ apiUrl: `${base}/v1`, apiKey: 'k', maxBytes: 1024 }),
    (error) => error.code === 'UPSTREAM_TOO_LARGE',
  );
  assert.equal(hits, 1);

  let streamHits = 0;
  const stream = await makeServer(t, (_req, res) => {
    streamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'x'.repeat(2048) }] }));
  });
  await assert.rejects(
    listModels({ apiUrl: stream.base, apiKey: 'k', maxBytes: 1024 }),
    (error) => error.code === 'UPSTREAM_TOO_LARGE',
  );
  assert.equal(streamHits, 1);
});

test('listModels：超时/外部取消会中止且不重试', async (t) => {
  let hits = 0;
  const { base } = await makeServer(t, (_req, _res) => {
    hits += 1;
    // 故意不回包，等客户端预算到点。
  });
  await assert.rejects(
    listModels({ apiUrl: base, apiKey: 'k', timeoutMs: 1000 }),
    (error) => error.code === 'UPSTREAM_TIMEOUT',
  );
  assert.equal(hits, 1);

  const controller = new AbortController();
  controller.abort();
  hits = 0;
  await assert.rejects(
    listModels({ apiUrl: base, apiKey: 'k', signal: controller.signal }),
    (error) => error.code === 'UPSTREAM_ABORTED',
  );
  assert.equal(hits, 0, '取消发生在请求前，不应打上游');
});

test('listModels：非法地址、缺 Key 在发请求前失败', async (t) => {
  let hits = 0;
  const { base } = await makeServer(t, (_req, res) => {
    hits += 1;
    res.end('{}');
  });
  await assert.rejects(
    listModels({ apiUrl: `${base}/v1?key=x`, apiKey: 'k' }),
    (error) => error.code === 'CONFIG_BAD_API_URL',
  );
  await assert.rejects(
    listModels({ apiUrl: base, apiKey: '' }),
    (error) => error.code === 'CONFIG_BAD_API_KEY',
  );
  assert.equal(hits, 0);
});

test('ModelProbe：成功结果含声明能力、固定未计费探测标记，且不含 Key', async () => {
  const calls = [];
  const probe = new ModelProbe({
    config: normalizeConfig({
      apiUrl: 'http://127.0.0.1:1/v1',
      model: 'img-model',
      probeCooldownMs: 0,
      probeMaxModels: 10,
    }),
    apiKey: 'local-test-key',
    listFn: async (input) => {
      calls.push(input);
      return {
        endpoint: 'http://127.0.0.1:1/v1/models',
        models: [
          { id: 'img-model', declared: { imageGeneration: true, evidence: ['image_generation'] } },
          { id: 'other' },
        ],
        total: 2,
        truncated: false,
        invalidRows: 0,
      };
    },
  });

  const result = await probe.run({ requesterId: '90001' });
  assert.equal(result.ok, true);
  assert.equal(result.probe, 'model-catalog');
  assert.equal(result.configuredModel.id, 'img-model');
  assert.equal(result.configuredModel.present, true);
  assert.equal(result.configuredModel.declared.imageGeneration, true);
  assert.equal(result.generationProbe.performed, false);
  assert.equal(result.generationProbe.reason.includes('不发起计费'), true);
  assert.equal(result.dataTrust, 'upstream-model-catalog-untrusted');
  assert.equal(JSON.stringify(result).includes('local-test-key'), false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].maxModels >= 10, '核对目录不应被展示上限截断');
  assert.equal(calls[0].timeoutMs, 15000);
});

test('ModelProbe：配置模型排在展示上限之后仍能正确核对', async () => {
  const probe = new ModelProbe({
    config: normalizeConfig({
      apiUrl: 'http://127.0.0.1:1/v1',
      model: 'model-c',
      probeCooldownMs: 0,
      probeMaxModels: 1,
    }),
    apiKey: 'k',
    listFn: async () => ({
      endpoint: 'http://x/models',
      models: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }],
      total: 3,
      truncated: false,
      invalidRows: 0,
    }),
  });
  const result = await probe.run({ requesterId: 'a' });
  assert.equal(result.configuredModel.present, true);
  assert.equal(result.configuredModel.matchedBy, 'exact');
  assert.equal(result.models.length, 1);
  assert.equal(result.truncated, true);
});

test('ModelProbe：列表硬截断且未找到时返回无法确认，而不是不存在', async () => {
  const probe = new ModelProbe({
    config: normalizeConfig({ apiUrl: 'http://127.0.0.1:1/v1', model: 'beyond', probeCooldownMs: 0 }),
    apiKey: 'k',
    listFn: async () => ({
      endpoint: 'http://x/models',
      models: [{ id: 'only-first-page' }],
      total: 5000,
      truncated: true,
      invalidRows: 0,
    }),
  });
  const result = await probe.run({ requesterId: 'a' });
  assert.equal(result.configuredModel.present, null);
  assert.match(result.note, /超过核对上限/);
});

test('ModelProbe：结果按配置上限裁剪，并标注截断', async () => {
  const probe = new ModelProbe({
    config: normalizeConfig({
      apiUrl: 'http://127.0.0.1:1/v1',
      model: 'm',
      probeCooldownMs: 0,
      probeMaxModels: 1,
    }),
    apiKey: 'k',
    listFn: async () => ({
      endpoint: 'http://x/models',
      models: [{ id: 'a' }, { id: 'b' }],
      total: 2,
      truncated: false,
      invalidRows: 0,
    }),
  });
  const result = await probe.run({ requesterId: 'a' });
  assert.equal(result.models.length, 1);
  assert.equal(result.truncated, true);
  assert.match(result.note, /仅返回 1 个/);
});

test('ModelProbe：超大目录输出受体积预算约束，仍保留核对结论', async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({
    id: `model-${String(i).padStart(3, '0')}-${'x'.repeat(100)}`,
    ownedBy: 'owner-'.repeat(20),
    declared: {
      imageGeneration: i === 250 ? true : null,
      imageEditing: null,
      vision: null,
      chat: null,
      metadataPresent: true,
      evidence: Array.from({ length: 5 }, () => 'capability_'.repeat(8)),
    },
  }));
  const probe = new ModelProbe({
    config: normalizeConfig({
      apiUrl: 'http://127.0.0.1:1/v1',
      model: many[250].id,
      probeCooldownMs: 0,
      probeMaxModels: 500,
    }),
    apiKey: 'k',
    listFn: async () => ({ endpoint: 'http://x/models', models: many, total: 500, truncated: false, invalidRows: 0 }),
  });
  const result = await probe.run({ requesterId: 'a' });
  assert.equal(result.ok, true);
  assert.equal(result.configuredModel.present, true, '核对必须使用裁剪前的目录');
  assert.equal(result.configuredModel.declared.imageGeneration, true);
  assert.equal(result.models.length < 500, true);
  assert.equal(result.truncated, true);
  assert.match(result.note, /体积裁剪/);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 200 * 1024);
});

test('ModelProbe：模型不存在/目录为空如实返回未知，不推断不支持', async () => {
  const makeProbe = (models, total) => new ModelProbe({
    config: normalizeConfig({
      apiUrl: 'http://127.0.0.1:1/v1',
      model: 'wanted',
      probeCooldownMs: 0,
    }),
    apiKey: 'k',
    listFn: async () => ({ endpoint: 'http://x/models', models, total, truncated: false, invalidRows: 0 }),
  });

  const absent = await makeProbe([{ id: 'other' }], 1).run({ requesterId: 'a' });
  assert.equal(absent.ok, true);
  assert.equal(absent.configuredModel.present, false);
  assert.match(absent.note, /不能据此断定不可用/);

  const empty = await makeProbe([], 0).run({ requesterId: 'a' });
  assert.equal(empty.ok, true);
  assert.equal(empty.configuredModel.present, null);
  assert.match(empty.note, /目录为空/);
});

test('ModelProbe：配置关闭/未配置/取消分别给出明确 code', async () => {
  const disabled = new ModelProbe({
    config: normalizeConfig({ apiUrl: 'http://x', model: 'm', probeEnabled: false }),
    apiKey: 'k',
  });
  assert.equal((await disabled.run({})).code, 'IMAGE_PROBE_DISABLED');

  const missing = new ModelProbe({ config: normalizeConfig({ model: 'm' }), apiKey: '' });
  assert.equal((await missing.run({})).code, 'IMAGE_PROBE_NOT_CONFIGURED');

  const controller = new AbortController();
  controller.abort();
  const aborted = new ModelProbe({
    config: normalizeConfig({ apiUrl: 'http://x', model: 'm' }),
    apiKey: 'k',
  });
  assert.equal((await aborted.run({ signal: controller.signal })).code, 'IMAGE_PROBE_ABORTED');
});

test('ModelProbe：冷却、每小时上限与单飞（busy）', async () => {
  let now = 1_000_000;
  let calls = 0;
  const config = normalizeConfig({
    apiUrl: 'http://x',
    model: 'm',
    probeCooldownMs: 5000,
    probePerHour: 2,
  });
  const catalog = { endpoint: 'http://x/models', models: [{ id: 'm' }], total: 1, truncated: false, invalidRows: 0 };
  const probe = new ModelProbe({
    config,
    apiKey: 'k',
    now: () => now,
    listFn: async () => {
      calls += 1;
      return catalog;
    },
  });

  assert.equal((await probe.run({ requesterId: 'a' })).ok, true);
  const cooled = await probe.run({ requesterId: 'a' });
  assert.equal(cooled.code, 'IMAGE_PROBE_RATE_LIMITED');
  assert.equal(cooled.retryAfterMs, 5000);
  now += 5000;
  assert.equal((await probe.run({ requesterId: 'a' })).ok, true);
  now += 5000;
  const hourly = await probe.run({ requesterId: 'a' });
  assert.equal(hourly.code, 'IMAGE_PROBE_RATE_LIMITED');
  assert.ok(hourly.retryAfterMs > 0);
  assert.equal(calls, 2);

  // busy：第一个探测未结束时，第二个（即使另一个请求者）不得并发打上游。
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let activeCalls = 0;
  const busyProbe = new ModelProbe({
    config: normalizeConfig({ apiUrl: 'http://x', model: 'm', probeCooldownMs: 0 }),
    apiKey: 'k',
    listFn: async () => {
      activeCalls += 1;
      await gate;
      return catalog;
    },
  });
  const first = busyProbe.run({ requesterId: 'a' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await busyProbe.run({ requesterId: 'b' });
  assert.equal(second.code, 'IMAGE_PROBE_BUSY');
  release();
  assert.equal((await first).ok, true);
  assert.equal(activeCalls, 1);
});

test('ModelProbe：上游错误脱敏，不把异常正文或 Key 带入结果', async () => {
  const probe = new ModelProbe({
    config: normalizeConfig({ apiUrl: 'http://x', model: 'm' }),
    apiKey: 'local-test-key',
    listFn: async () => {
      throw new ModelProbeError('UPSTREAM_TIMEOUT', 'contains local-test-key and upstream body');
    },
  });
  const result = await probe.run({ requesterId: 'a' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UPSTREAM_TIMEOUT');
  assert.equal(JSON.stringify(result).includes('local-test-key'), false);
  assert.equal(JSON.stringify(result).includes('upstream body'), false);
  assert.equal(result.outcomeUnknown, false);
});

test('清单：模型探测是 host-only R1/net，不是收费或插件自审工具', async () => {
  const raw = JSON.parse(await fs.readFile(new URL('../plugins/image-generation/plugin.json', import.meta.url), 'utf8'));
  const parsed = normalizeManifest(raw, 'image-generation');
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.manifest.version, '1.1.0');
  const tool = parsed.manifest.tools.find((t) => t.name === 'image_probe_models');
  assert.ok(tool, '必须声明 image_probe_models');
  assert.deepEqual(tool.effects, ['net']);
  assert.equal(tool.risk, 'R1');
  assert.notEqual(tool.approval, 'plugin');
  assert.equal(tool.needs, 'host');

  const policy = deriveToolPolicy(tool);
  assert.equal(policy.kind, 'host');
  assert.deepEqual(policy.origins, ['owner-private', 'console']);
  assert.equal(policy.risk, 'R1');
  assert.equal(policy.approval, 'host');

  // 聊天来源拿不到 host 工具；即使写进 group 授权也不行。
  const grant = { channel: 'group', rule: { enabled: true, tools: ['plugin_image_probe_models'], allowPaid: false } };
  assert.equal(chatGrantAllows({ ...tool, kind: 'host' }, grant).reason, 'host-tool-in-chat');
});

test('插件集成：只读探测走真实 GET，不创建任务、不发 QQ、不泄露 Key', async (t) => {
  const requests = [];
  const { base } = await makeServer(t, (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { id: 'img-model', capabilities: { image_generation: true } },
        { id: 'plain-model' },
      ],
    }));
  });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-image-probe-'));
  const sent = [];
  const plugin = createImagePlugin();
  const controller = new AbortController();
  const config = {
    apiUrl: `${base}/v1`,
    model: 'img-model',
    admins: '90001',
    probeCooldownMs: 0,
  };
  const init = await plugin.init({
    dataDir: dir,
    config,
    secrets: { apiKey: 'local-test-key' },
    sendText: async (_convKey, text) => {
      sent.push(text);
      return { ok: true, messageId: '-1' };
    },
    deliverMedia: async () => ({ ok: true }),
    signal: controller.signal,
  });
  assert.equal(init.ok, true, JSON.stringify(init));

  try {
    const result = await plugin.callTool({
      tool: 'image_probe_models',
      args: {},
      ctx: { caller: { requester: { id: '90001' }, convKey: 'private:90001' } },
      signal: controller.signal,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.configuredModel.present, true);
    assert.equal(result.configuredModel.declared.imageGeneration, true);
    assert.equal(result.generationProbe.performed, false);
    assert.equal(JSON.stringify(result).includes('local-test-key'), false);

    // 只允许 GET /models；任何 POST 都会在这里被记录并最终断言失败。
    assert.deepEqual(requests.map((r) => r.method), ['GET']);
    assert.equal(requests[0].url, '/v1/models');
    assert.equal(requests[0].authorization, 'Bearer local-test-key');
    assert.equal(sent.length, 0, '模型探测不应发 QQ 消息');

    const disk = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'));
    assert.deepEqual(disk.tasks, [], '模型探测不应创建任务');

    const unknown = await plugin.callTool({
      tool: 'image_probe_models',
      args: { model: 'not-in-catalog' },
      ctx: { caller: { requester: { id: '90001' } } },
      signal: controller.signal,
    });
    assert.equal(unknown.configuredModel.present, false);

    const before = requests.length;
    const testConnection = await plugin.testConnection({ config, secrets: { apiKey: 'local-test-key' } });
    assert.equal(testConnection.ok, true);
    assert.equal(requests.length, before, '测试连接按钮仍然不发网络请求');
  } finally {
    await plugin.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('插件集成：探测关闭时返回明确 code，仍不联网', async (t) => {
  let hits = 0;
  const { base } = await makeServer(t, (_req, res) => {
    hits += 1;
    res.end('{}');
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-image-probe-off-'));
  const plugin = createImagePlugin();
  const controller = new AbortController();
  const init = await plugin.init({
    dataDir: dir,
    config: { apiUrl: `${base}/v1`, model: 'm', admins: '90001', probeEnabled: false },
    secrets: { apiKey: 'k' },
    sendText: async () => ({ ok: true }),
    deliverMedia: async () => ({ ok: true }),
    signal: controller.signal,
  });
  assert.equal(init.ok, true);
  try {
    const result = await plugin.callTool({
      tool: 'image_probe_models',
      args: {},
      ctx: { caller: { requester: { id: '90001' } } },
      signal: controller.signal,
    });
    assert.equal(result.code, 'IMAGE_PROBE_DISABLED');
    assert.equal(hits, 0);
  } finally {
    await plugin.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('配置：探测范围非法时 validateConfig 拒绝保存', () => {
  const plugin = createImagePlugin();
  for (const bad of [
    { probeTimeoutMs: 100 },
    { probePerHour: 0 },
    { probeMaxModels: 501 },
    { probeEnabled: 'yes' },
  ]) {
    const result = plugin.validateConfig(bad);
    assert.equal(result.ok, false, JSON.stringify(result));
  }
  assert.equal(plugin.validateConfig({}).ok, true);
});
