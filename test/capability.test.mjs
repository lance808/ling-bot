/**
 * 模型能力探测 —— 视觉 / 生图 / 通道
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
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeVisionAnswer,
  inferChannel,
  describeCatalog,
  chatUrlOf,
  imagesUrlOf,
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
  assert.match(r.detail, /红色/);
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
    ['dall-e-3', 'imageGen'],
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

/* ---------------------------------------------------------------- 地址 */

test('chat 与 images 端点地址前缀一致', () => {
  for (const base of [
    'https://a.com',
    'https://a.com/v1',
    'https://a.com/v1/',
    'https://a.com/v1/chat/completions',
  ]) {
    assert.equal(
      chatUrlOf(base).replace(/\/chat\/completions$/, ''),
      imagesUrlOf(base).replace(/\/images\/generations$/, ''),
      `地址不一致：${base}`,
    );
  }
});
