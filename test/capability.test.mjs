/**
 * 模型能力探测 —— 视觉 / 通道
 *
 * 这些测试守的是一条真实踩过的教训链：
 *
 * 1. **1×1 图会被尺寸下限拒绝**，报错长得像"不支持"，于是把支持视觉的
 *    模型误判成不支持（qwen3.8-max 就这样被误判过）。→ 改用 64×64。
 * 2. **正式回答为空不代表没看到图**。推理型模型把过程放在
 *    `reasoning_content`，`content` 可能为空。只看 content 会判错。
 * 3. 而 `reasoning_content` 里也可能写着 "I cannot process the image"
 *    —— 同样是空回答，结论却相反。→ 必须识别否定表述。
 *
 * 三种情况的响应形状都在这里固定下来，以后改判定逻辑能立刻发现回归。
 *
 * ## 本模块**不探测生图**
 *
 * 生图归独立插件 `plugins/image-generation`：另一套地址、另一把 Key、
 * 另一个模型。所以这里既没有 `imagesUrlOf` 之类的地址推导，也不按模型名
 * 认定生图能力；旧配置里遗留的 `image` / `imageGen` 由
 * `sanitizeModelCapabilities` 清掉（用例见文件末尾）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeVisionAnswer,
  inferChannel,
  describeCatalog,
  sanitizeModelCapabilities,
  chatUrlOf,
  RED_SQUARE_PNG_BASE64,
} from '../src/llm/capability.mjs';

/* ---------------------------------------------------------------- 探测图 */

test('探测图是 64×64 PNG，不是 1×1', () => {
  const buf = Buffer.from(RED_SQUARE_PNG_BASE64, 'base64');
  // PNG 签名
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR 里第 16..19 字节是宽、20..23 是高（大端）
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.equal(width, 64, '宽度必须是 64：1×1 会被尺寸下限拒绝，导致误判');
  assert.equal(height, 64, '高度必须是 64');
});

test('探测图足够小（不浪费额度）', () => {
  const buf = Buffer.from(RED_SQUARE_PNG_BASE64, 'base64');
  assert.ok(buf.length < 1000, `图太大：${buf.length} 字节`);
});

/* ---------------------------------------------------------------- 视觉判定 */

test('正常回答 → 支持', () => {
  const r = judgeVisionAnswer({
    choices: [{ message: { content: '红色' }, finish_reason: 'stop' }],
  });
  assert.equal(r.supported, true);
  assert.match(r.detail, /识别固定红图|红色/, '说明要能看出是验证了目标颜色');
});

test('★ 正式回答为空但思考内容描述了图 → 支持（kimi-k3 的真实形状）', () => {
  const r = judgeVisionAnswer({
    choices: [
      {
        message: {
          content: '',
          reasoning_content:
            'The user is asking what color is mainly in the image, and asks to only answer with the color name. The image is clearly solid red.',
        },
        finish_reason: 'length',
      },
    ],
  });
  assert.equal(r.supported, true, '思考内容显示它确实看到了图');
  assert.match(r.detail, /截断|思考/);
});

test('★ 模型说"无法处理图片" → 不支持（glm-5.3 的真实形状）', () => {
  const r = judgeVisionAnswer({
    choices: [
      {
        message: {
          content: null,
          reasoning_content:
            "The user is asking me to identify the main color of an image, but there's a reminder in the prompt stating that I cannot process the image because I don't have that capability.",
        },
        finish_reason: 'length',
      },
    ],
  });
  assert.equal(r.supported, false, '模型自己说看不了图，就是看不了');
});

test('中文的"无法处理图片"也要认出来', () => {
  const r = judgeVisionAnswer({
    choices: [{ message: { content: '抱歉，我无法查看图片。' }, finish_reason: 'stop' }],
  });
  assert.equal(r.supported, false);
});

test('空回答且无思考 → null（没测出来，不是不支持）', () => {
  const r = judgeVisionAnswer({
    choices: [{ message: { content: '' }, finish_reason: 'stop' }],
  });
  assert.equal(r.supported, null, '"没测出来"必须与"不支持"区分');
});

test('思考内容与图片无关 → null', () => {
  const r = judgeVisionAnswer({
    choices: [
      {
        message: { content: '', reasoning_content: 'The user said hello. I should greet back.' },
        finish_reason: 'length',
      },
    ],
  });
  assert.equal(r.supported, null);
});

test('响应形状异常也不崩', () => {
  for (const bad of [{}, { choices: [] }, { choices: [{}] }, null]) {
    const r = judgeVisionAnswer(bad);
    assert.equal(typeof r, 'object');
    assert.ok(r.supported === null || typeof r.supported === 'boolean');
  }
});

/* ---------------------------------------------------------------- 通道推断 */

test('已实测可读图 → 多模态通道', () => {
  const c = inferChannel({ model: 'some-model', caps: { vision: true } });
  assert.equal(c.channel, 'multimodal');
});

test('已实测不支持视觉 → 不会因为名字像多模态而误判', () => {
  const c = inferChannel({ model: 'gpt-4o-vision', caps: { vision: false } });
  // 名字里带 vision，但实测不支持 —— 名字不能压过实测
  assert.notEqual(c.channel, 'multimodal');
});

test('从名字猜的通道要标明依据', () => {
  const cases = [
    ['text-embedding-3-large', 'embedding'],
    ['whisper-1', 'audio'],
    ['qwen-vl-max', 'multimodal'],
    ['deepseek-v4.1', 'text'],
  ];
  for (const [model, want] of cases) {
    const c = inferChannel({ model });
    assert.equal(c.channel, want, `${model} 应为 ${want}，实际 ${c.channel}`);
    // 每个结论都要能说清依据，否则用户没法判断可信度
    assert.ok(c.basis.length > 0);
  }
});

test('★ 名字像生图模型也不判 imageGen：不按名字认定生图能力', () => {
  // 生图能力归独立插件，聊天模型的地址/Key 与它无关。
  // 按名字宣布"能生图"，用户就会拿聊天 Key 去期待生图。
  for (const model of ['dall-e-3', 'flux-1.1', 'sdxl-turbo', 'imagen-3']) {
    const c = inferChannel({ model });
    assert.notEqual(c.channel, 'imageGen', `${model} 不能被判成 imageGen`);
    assert.equal(c.channel, 'other', `${model} 应归为 other（疑似非对话模型）`);
    assert.match(c.label, /疑似非对话/, '标签要留余地，不能说它就是生图模型');
    assert.match(c.basis, /独立插件/, '依据要说明生图归独立插件');
    assert.match(c.basis, /不按名字/, '依据要说明不按名字认定');
  }
});

test('★ 旧结论 caps.image 不再影响通道推断', () => {
  // 清理之前写进配置的 image:true 是历史遗留，没有任何出处。
  // 它必须不能再把通道"抬"成 imageGen —— 否则用户换回旧配置就看到幽灵能力。
  for (const image of [true, false]) {
    const c = inferChannel({ model: 'deepseek-v4.1', caps: { image } });
    assert.notEqual(c.channel, 'imageGen', 'caps.image 不能产生 imageGen 通道');
    assert.equal(c.channel, 'text', '没有视觉实测时仍按文本通道');
  }
});

test('describeCatalog 保留三态能力', () => {
  const out = describeCatalog(['a', 'b', 'c'], {
    a: { vision: true },
    b: { vision: false },
    // c 没有记录
  });
  assert.equal(out[0].vision, true);
  assert.equal(out[1].vision, false);
  assert.equal(out[2].vision, null, '未测必须是 null，不能压成 false');
});

test('★ describeCatalog 不再返回 image 字段', () => {
  // 目录里出现 image 就会被界面当成一个可选项展示 —— 那是生图插件的事。
  const out = describeCatalog(['dall-e-3', 'deepseek-v4.1'], {
    'dall-e-3': { image: true, imageGen: true, vision: false },
    'deepseek-v4.1': { vision: true },
  });
  for (const item of out) {
    assert.equal('image' in item, false, `${item.id} 的结果不该有 image 键`);
    assert.equal('imageGen' in item, false, `${item.id} 的结果不该有 imageGen 键`);
    assert.equal(typeof item.vision === 'boolean' || item.vision === null, true, 'vision 保持三态');
  }
});

/* ---------------------------------------------------------------- 地址 */

test('chat 地址只补 /chat/completions（探测不会再推导生图地址）', async () => {
  for (const base of [
    'https://a.com',
    'https://a.com/v1',
    'https://a.com/v1/',
    'https://a.com/v1/chat/completions',
  ]) {
    assert.match(chatUrlOf(base), /\/chat\/completions$/, `地址不对：${base}`);
  }
  // 本模块已不再导出 imagesUrlOf：没有"顺手推一个生图地址"的入口，
  // 就不可能有人在探测链路里拼出 /images/generations。
  const mod = await import('../src/llm/capability.mjs');
  assert.equal('imagesUrlOf' in mod, false, 'imagesUrlOf 必须已删除');
  assert.equal('probeImageGen' in mod, false, 'probeImageGen 必须已删除');
  assert.equal('hasImageEvidence' in mod, false, 'hasImageEvidence 必须已删除');
});

/* ------------------------------------------------ 旧生图结论的清理 */

test('★ sanitizeModelCapabilities 清掉遗留的生图字段', () => {
  const { caps, changed } = sanitizeModelCapabilities({
    'https://a.example/v1/chat/completions': {
      'm-1': {
        vision: true,
        image: true,
        imageGen: true,
        channel: 'imageGen',
        probedAt: '2026-10-19T00:00:00Z',
        endpoint: 'https://a.example/v1/chat/completions',
        任意字段: 1,
        probes: { vision: { supported: true }, image: { supported: true } },
      },
    },
  });

  assert.equal(changed, true, '有旧字段就要报 changed，宿主据此写回');
  const entry = caps['https://a.example/v1/chat/completions']['m-1'];
  assert.equal('image' in entry, false, 'image 要删掉');
  assert.equal('imageGen' in entry, false, 'imageGen 要删掉');
  assert.equal('channel' in entry, false, "channel:'imageGen' 是旧探测的结论，要删掉交给重算");
  assert.equal('image' in entry.probes, false, 'probes.image 要删掉');
  // 该留的一个都不能少
  assert.equal(entry.vision, true, '视觉结论仍然有效');
  assert.deepEqual(entry.probes, { vision: { supported: true } }, 'probes.vision 要保留');
  assert.equal(entry.probedAt, '2026-10-19T00:00:00Z', '探测时间要保留');
  assert.equal(entry.endpoint, 'https://a.example/v1/chat/completions', '端点要保留');
  assert.equal(entry.任意字段, 1, '不认识的元信息不该被丢');
});

test('★ 只测过生图的条目整条删除，不留"探测失败"的假象', () => {
  const { caps, changed } = sanitizeModelCapabilities({
    'https://a.example/v1/chat/completions': {
      'image-only': { image: true, probes: { image: { supported: true } }, probedAt: 'x' },
      'probe-only-with-vision-null': { probes: { vision: { supported: null } }, image: false },
    },
  });

  assert.equal(changed, true);
  const scoped = caps['https://a.example/v1/chat/completions'];
  assert.equal('image-only' in scoped, false, '只测过生图的条目要整条删掉');
  // 测过视觉但没测出来（supported:null）仍是"测过"，必须留
  assert.ok('probe-only-with-vision-null' in scoped, 'probes.vision 存在就要保留');
  assert.deepEqual(scoped['probe-only-with-vision-null'].probes, { vision: { supported: null } });
  assert.equal('image' in scoped['probe-only-with-vision-null'], false);
});

test('★ sanitizeModelCapabilities 幂等，且不动干净配置', () => {
  const clean = {
    'https://a.example/v1/chat/completions': {
      'm-1': { vision: false, probes: { vision: { supported: false } }, probedAt: 'x' },
    },
  };
  const once = sanitizeModelCapabilities(clean);
  assert.equal(once.changed, false, '没有旧字段就不该说 changed');
  assert.equal(once.caps, clean, '没改动时要原样返回，避免无谓写盘');

  const legacy = {
    'https://a.example/v1/chat/completions': {
      'm-1': { vision: true, image: true, probes: { vision: { supported: true }, image: { supported: true } }, channel: 'imageGen' },
    },
  };
  const first = sanitizeModelCapabilities(legacy);
  assert.equal(first.changed, true);
  const second = sanitizeModelCapabilities(first.caps);
  assert.equal(second.changed, false, '第二次必须 changed=false');
  assert.deepEqual(second.caps, first.caps, '清理结果要稳定');
});

test('sanitizeModelCapabilities 对空值/异常形状不崩', () => {
  for (const bad of [null, undefined, [], 'x']) {
    const r = sanitizeModelCapabilities(bad);
    assert.equal(typeof r, 'object');
    assert.equal(r.changed, false);
  }
  // 端点下的值不是对象、模型条目不是对象：原样搬过去，不抛
  const weird = { ep: null, ep2: { m: 'not-an-object' } };
  const r = sanitizeModelCapabilities(weird);
  assert.equal(r.changed, false);
  assert.equal(r.caps.ep, null);
  assert.equal(r.caps.ep2.m, 'not-an-object');
});
