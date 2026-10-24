/**
 * 回归：聊天模型只探视觉，生图彻底归独立插件
 *
 * ## 这个文件在防什么
 *
 * 聊天模型设置页曾经也探测（并展示）生图能力：拿聊天模型的地址与 Key 去
 * 请求 `/images/generations`。这有两个问题：
 *
 *   1. **误判**：中转站的聊天与生图常常不是同一家，用聊天 Key 试生图端点
 *      得出的结论，跟"这个对话模型能不能生图"其实没关系；
 *   2. **真花钱**：用户只是想知道"能不能读图"，却因此**真的生成了一张图**。
 *
 * 所以生图整体搬进了 `plugins/image-generation`：另一套地址、另一把 Key、
 * 另一个模型、独立的付费审批。本文件从四个角度钉住这条边界：
 *
 *   a. 旧配置（含 `image` / `imageGen` / `probes.image` / `channel:'imageGen'`）
 *      仍然能加载，启动迁移后这些字段无残留 —— 升级不能把人挡在门外；
 *   b. `probeModel` 只发**一次** `/chat/completions`，任何 URL 都不命中
 *      `/images/generations`（把探测改回去，这条立刻红）；
 *   c. 视觉能力本身没有被削弱：`judgeVisionAnswer` 的三态语义不变；
 *   d. 独立生图插件不受影响：配置校验、自检零网络请求、清单仍声明付费工具。
 *
 * 全部网络用 stub，不真实联网、不发 QQ、不真实生图。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { validateConfig } from '../src/config/schema.mjs';
import {
  probeModel,
  judgeVisionAnswer,
  sanitizeModelCapabilities,
} from '../src/llm/capability.mjs';
import imagePlugin from '../plugins/image-generation/index.mjs';

/** 端点键的形状与 `endpointKey()` 一致：规范化后的 chat URL */
const ENDPOINT = 'https://a.example/v1/chat/completions';

/**
 * 旧版配置里的能力表（真实形状：`[端点][模型名] = 结论`）。
 *
 * 旧版探测会把生图结论和视觉结论写在同一个条目里，
 * 还会把 `channel` 直接记成 `imageGen`。
 */
const legacyCapabilities = () => ({
  [ENDPOINT]: {
    'dall-e-3': {
      vision: false,
      image: true,
      imageGen: true,
      channel: 'imageGen',
      probes: { vision: { supported: false }, image: { supported: true } },
      probedAt: '2026-10-01T00:00:00Z',
    },
    'deepseek-v4.1': {
      vision: true,
      image: false,
      probes: { vision: { supported: true }, image: { supported: false } },
      probedAt: '2026-10-01T00:00:00Z',
      endpoint: ENDPOINT,
    },
    // 只测过生图、从没测过视觉的条目：清理后应当整条消失
    'flux-1.1': {
      image: true,
      probes: { image: { supported: true } },
      probedAt: '2026-10-01T00:00:00Z',
    },
  },
});

/* ================================================================ a. 旧配置 */

test('a. 旧配置含生图探测结论时仍能加载，sanitize 后无残留', () => {
  const legacy = { llm: { modelCapabilities: legacyCapabilities() } };

  // 能加载：这些键都在动态字典里，配置层不该把它们当"未知配置项"抛 E40XX
  let cfg;
  assert.doesNotThrow(() => {
    cfg = validateConfig(legacy);
  }, '旧字段不能变成"未知配置项" —— 那等于升级即起不来');

  const saved = cfg.llm.modelCapabilities[ENDPOINT];
  assert.equal(saved['dall-e-3'].image, true, '校验层原样接受，清理交给启动迁移');
  assert.equal(saved['dall-e-3'].channel, 'imageGen');

  // 迁移：旧生图结论消失
  const { caps, changed } = sanitizeModelCapabilities(cfg.llm.modelCapabilities);
  assert.equal(changed, true, '有旧字段就要报 changed，宿主据此原子写回');

  for (const [model, entry] of Object.entries(caps[ENDPOINT])) {
    assert.equal('image' in entry, false, `${model} 仍残留 image`);
    assert.equal('imageGen' in entry, false, `${model} 仍残留 imageGen`);
    assert.equal(entry.channel === 'imageGen', false, `${model} 仍留着 channel:'imageGen'`);
    if (entry.probes) {
      assert.equal('image' in entry.probes, false, `${model} 仍残留 probes.image`);
    }
  }

  // 该留的必须留下：视觉结论、端点、探测时间
  const visionEntry = caps[ENDPOINT]['deepseek-v4.1'];
  assert.equal(visionEntry.vision, true, '视觉结论仍然有效');
  assert.deepEqual(visionEntry.probes, { vision: { supported: true } }, 'probes.vision 要保留');
  assert.equal(visionEntry.endpoint, ENDPOINT);
  assert.equal(visionEntry.probedAt, '2026-10-01T00:00:00Z');

  // 只测过生图的条目整条删掉：它对"能不能对话"一句话都没说过
  assert.equal('flux-1.1' in caps[ENDPOINT], false, '只测过生图的条目要整条删掉');

  // 幂等：迁移跑第二次不再产生变化
  assert.equal(sanitizeModelCapabilities(caps).changed, false);

  // 写回磁盘后的配置仍能通过启动校验
  assert.doesNotThrow(() => validateConfig({ llm: { modelCapabilities: caps } }));
});

test('a2. 干净配置不会被迁移改动', () => {
  const clean = {
    llm: {
      modelCapabilities: {
        [ENDPOINT]: {
          'm-1': { vision: false, probes: { vision: { supported: false } }, probedAt: 'x' },
        },
      },
    },
  };
  const cfg = validateConfig(clean);
  const { caps, changed } = sanitizeModelCapabilities(cfg.llm.modelCapabilities);
  assert.equal(changed, false, '没有旧字段就不该触发写盘');
  assert.deepEqual(caps, cfg.llm.modelCapabilities);
});

test('a3. 只残留 channel:imageGen 的条目被整条清掉，不留空壳', () => {
  /*
   * 旧探测还会写 `channel: 'imageGen'`。如果条目只剩这个字段，
   * 删完就是一个 `{}` —— 它对界面没有意义（"最近探测过"却没有任何结论）。
   * 这类条目必须整条删，而不是留个空对象。
   */
  const { caps, changed } = sanitizeModelCapabilities({
    [ENDPOINT]: {
      'only-channel': { channel: 'imageGen', probedAt: '2026-01-01T00:00:00Z' },
      // 有视觉结论的条目不受影响：只删 channel，保留视觉
      'has-vision': { channel: 'imageGen', vision: true, probes: { vision: { supported: true } } },
    },
  });
  assert.equal(changed, true);
  assert.equal(caps[ENDPOINT]['only-channel'], undefined, '只剩旧生图 channel 的条目要整条删');
  assert.equal(caps[ENDPOINT]['has-vision'].channel, undefined, '旧 channel 结论要删');
  assert.equal(caps[ENDPOINT]['has-vision'].vision, true, '视觉结论必须保留');
  // 幂等：再跑一次不该再有变化
  assert.equal(sanitizeModelCapabilities(caps).changed, false);
});

/* ================================================== b. 探测只打 chat 端点 */

/** 把 fetch 换成记录 URL/请求体的桩；finally 里必须恢复（返回恢复函数） */
function stubFetch(responseBody, status = 200) {
  const calls = { urls: [], bodies: [] };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.urls.push(String(url));
    calls.bodies.push(String(init?.body ?? ''));
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('b. probeModel 恰好发一次 /chat/completions，绝不请求 /images/generations', async () => {
  const { calls, restore } = stubFetch({
    choices: [{ message: { content: '红色' }, finish_reason: 'stop' }],
  });

  try {
    const out = await probeModel({
      baseUrl: 'https://stub.example/v1',
      apiKey: 'sk-test-only',
      model: 'm-1',
      timeoutMs: 2000,
    });

    // (1) 次数与地址
    assert.equal(calls.urls.length, 1, `探测只能发一次请求，实际 ${calls.urls.length} 次：${calls.urls.join(', ')}`);
    assert.equal(calls.urls[0], 'https://stub.example/v1/chat/completions');
    assert.match(calls.urls[0], /\/chat\/completions$/, '必须打到 chat 端点');
    assert.ok(
      !calls.urls.some((u) => /\/images\/generations/.test(u)),
      `探测不能请求生图端点（那会真的花钱）：${calls.urls.join(', ')}`,
    );

    // (2) 请求体是视觉探测（图片输入），不是一次生图请求
    const body = JSON.parse(calls.bodies[0]);
    assert.equal(body.model, 'm-1');
    assert.ok(JSON.stringify(body.messages ?? []).includes('image_url'), '视觉探测要带图片输入');
    assert.equal('prompt' in body, false, '不能带生图用的 prompt 字段');
    assert.equal('n' in body, false, '不能带生图张数 n');
    assert.equal('size' in body, false, '不能带生图尺寸 size');
    assert.equal('response_format' in body, false, '不能带生图返回格式');

    // (3) 红色回答 → 确认支持视觉；结果形状里没有生图
    assert.equal(out.probes.vision.supported, true, '红色回答说明它确实读到了图');
    assert.deepEqual(Object.keys(out.probes), ['vision'], 'probes 里只能有视觉');
    assert.equal('image' in out.probes, false);
    assert.equal('image' in out, false);
    assert.equal(out.channel.channel, 'multimodal', '实测可读图 → 多模态通道');
  } finally {
    restore();
  }
});

test('b2. 旧客户端传 probe:[vision,image] 也只会探视觉', async () => {
  const { calls, restore } = stubFetch({
    choices: [{ message: { content: '红色' }, finish_reason: 'stop' }],
  });
  try {
    // probeModel 的签名里没有 probe 参数；就算调用方塞进来也不能被采纳。
    await probeModel({
      baseUrl: 'https://stub.example/v1',
      apiKey: 'sk-test-only',
      model: 'm-1',
      timeoutMs: 2000,
      probe: ['vision', 'image'],
    });
    assert.equal(calls.urls.length, 1, `旧客户端不该多发出请求：${calls.urls.join(', ')}`);
    assert.ok(!calls.urls.some((u) => /\/images\//.test(u)), '任何路径都不能指向生图端点');
  } finally {
    restore();
  }
});

test('b3. 视觉探测失败时不写任何结论，也不会顺手去测生图', async () => {
  const { calls, restore } = stubFetch({ error: { message: 'invalid api key' } }, 401);
  try {
    const out = await probeModel({
      baseUrl: 'https://stub.example/v1',
      apiKey: 'sk-bad',
      model: 'm-1',
      timeoutMs: 2000,
    });
    assert.equal(calls.urls.length, 1, '4xx 之后不能再补一次别的请求');
    assert.ok(!calls.urls.some((u) => /\/images\//.test(u)));
    // 4xx 是"没测出来"，不是"不支持"
    assert.equal(out.probes.vision.supported, null, '凭据类错误不能判成不支持视觉');
    assert.equal(typeof out.channel.channel, 'string');
  } finally {
    restore();
  }
});

/* ============================================ c. 视觉判定语义不能被削弱 */

test('c. 视觉判定三态语义不变', () => {
  // 红色 → 支持
  assert.equal(
    judgeVisionAnswer({ choices: [{ message: { content: '红色' }, finish_reason: 'stop' }] }).supported,
    true,
  );
  // 空回答且无思考 → 没测出来（不是不支持）
  assert.equal(
    judgeVisionAnswer({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }).supported,
    null,
  );
  // 模型明确说看不了图 → 不支持
  assert.equal(
    judgeVisionAnswer({ choices: [{ message: { content: '抱歉，我无法查看图片。' }, finish_reason: 'stop' }] }).supported,
    false,
  );
  // 推理型模型把结论写在 reasoning_content 里也要认出来
  assert.equal(
    judgeVisionAnswer({
      choices: [{ message: { content: '', reasoning_content: 'The image is clearly solid red.' }, finish_reason: 'length' }],
    }).supported,
    true,
  );
});

/* ============================================== d. 独立生图插件不受影响 */

/** 按 `normalizeConfig` 的必填项构造一份合法配置（不联网、不生成） */
const validPluginConfig = () => ({
  apiUrl: 'http://127.0.0.1:8123/v1',
  model: 'mock-image',
  admins: '100000003',
  size: '1024x1024',
  count: 1,
});

test('d1. 生图插件的本地配置校验仍然有效', () => {
  assert.deepEqual(imagePlugin.validateConfig(validPluginConfig()), { ok: true }, '合法配置要通过');

  for (const bad of [
    { ...validPluginConfig(), apiUrl: 'ftp://x/v1' },            // 非 HTTP(S)
    { ...validPluginConfig(), apiUrl: 'http://u:p@h/v1' },       // 带凭据
    { ...validPluginConfig(), apiUrl: 'http://h/v1?q=1' },       // 带查询串
    { ...validPluginConfig(), count: 99 },                       // 张数超上限
    { ...validPluginConfig(), size: '大图' },                     // 尺寸不规范
  ]) {
    assert.equal(imagePlugin.validateConfig(bad).ok, false, `不合法配置必须拒绝：${JSON.stringify(bad)}`);
  }
});

test('d2. 插件自检只做本地校验：零网络请求，绝不暗中生成收费图片', async () => {
  let fetchCalls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('测试里不允许真实网络请求');
  };
  try {
    const r = await imagePlugin.testConnection({
      config: validPluginConfig(),
      secrets: { apiKey: 'local-test-key' },
    });
    assert.equal(r.ok, true, `配置齐全时应通过本地校验：${JSON.stringify(r)}`);
    assert.equal(fetchCalls, 0, '自检一次请求都不该发 —— 尤其不能悄悄生成一张收费图');
  } finally {
    globalThis.fetch = real;
  }
});

test('d3. 插件自检在缺 Key 时如实失败，且仍然零请求', async () => {
  let fetchCalls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('测试里不允许真实网络请求');
  };
  try {
    const r = await imagePlugin.testConnection({ config: validPluginConfig(), secrets: {} });
    assert.equal(r.ok, false, '缺 Key 不能报通过');
    assert.match(String(r.message ?? ''), /本地|未发送网络请求/, '要说明"未发请求"，别让人以为连通性已验证');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = real;
  }
});

test('d4. 插件清单仍声明 image_generate，且是 paid + 插件审批', async () => {
  const raw = JSON.parse(
    await fs.readFile(new URL('../plugins/image-generation/plugin.json', import.meta.url), 'utf8'),
  );
  assert.equal(raw.id, 'image-generation');

  const tool = (raw.tools ?? []).find((t) => t.name === 'image_generate');
  assert.ok(tool, '清单里必须有 image_generate');
  assert.ok(Array.isArray(tool.effects), 'effects 要是数组');
  assert.ok(tool.effects.includes('paid'), `effects 必须含 paid，实际 ${JSON.stringify(tool.effects)}`);
  assert.equal(tool.approval, 'plugin', '付费工具必须走插件自己的审批');
  assert.equal(tool.risk, 'R2', '收费工具的风险等级不能被降级');
  assert.ok((raw.permissions ?? []).includes('paid'), '插件权限里要有 paid');
});
