/**
 * 宿主接线的验收测试 —— 视觉链路真的接上了吗
 *
 * ## 这组测试守的是什么
 *
 * 单测（vision-core / vision-prompt / vision-page）各自证明了**机制**正确：
 * 取图会夹预算、`buildMessages` 会拼多模态、页面会分区渲染。
 * 但"机制对了"不等于"真的接上了"——需求里点名的三个故障恰好都在接线处：
 *
 *   1. **关闭只是隐藏界面** → 关掉之后仍在发 `get_image`、仍在抓 URL；
 *   2. **能力探测可用 ≠ 真实聊天已读图** → 探测成功，但请求体里从来没有图；
 *   3. **每轮重复提交全部历史图片** → 账单按回合线性增长。
 *
 * 所以这里测的是**调用次数与请求体形状**，不是"函数返回值好看"。
 *
 * ## 全部本地模拟
 *
 * `getImage` / `fetchUrl` 都是注入的假实现，`LlmClient` 那一步只检查
 * 组装好的 messages。**不连 QQ、不联网、不调用任何收费模型。**
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { collectTurnImages, normalizeVisionConfig } from '../src/llm/vision.mjs';
import {
  annotateImagePlaceholders,
  buildVisionSnapshot,
  contentToText,
  floorsWithSubmittedImages,
  messagesToPlainText,
  recordVisionTurn,
  resolveEffective,
} from '../src/llm/vision-runtime.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { buildMessages } from '../src/llm/prompt.mjs';
import { looksLikeImageRejection } from '../src/llm/client.mjs';

/* ------------------------------------------------------------ 工具 */

/**
 * 造一张合法的 1×1 PNG（真实字节，魔数与 IHDR 都正确）。
 *
 * 不能用一段随便的 base64：取图链路会按魔数判定类型，
 * 假图片会被 E3105 拒掉 —— 那样测试通过与否就和"类型检查是否生效"纠缠在一起，
 * 失败时看不出是被哪个机制挡下的。
 *
 * @returns {Buffer}
 */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gAB'
      + '6f3PAAAAAElFTkSuQmCC',
    'base64',
  );
}

/**
 * 一个"每次调用都记下来"的假网关。
 *
 * 为什么必须计数：需求第 5 条是"关闭后停止自动取图"，而"停止"唯一的
 * 可观测证据就是**调用次数为 0**。断言返回值是空的并不能证明没取图 ——
 * 取完图再丢掉，返回值一样是空的。
 *
 * @param {object} [opts]
 */
function fakeGateway(opts = {}) {
  const calls = [];
  const buffer = opts.buffer ?? tinyPng();
  return {
    calls,
    deps: {
      getImage: async ({ file }) => {
        calls.push(file);
        if (opts.fail) throw new Error(opts.fail);
        return {
          file,
          base64: buffer.toString('base64'),
          width: 1,
          height: 1,
        };
      },
      // 即便被调用也不该联网：给它一个立刻失败的实现，误调用会体现为 E3103
      fetchUrl: async () => {
        calls.push('url');
        throw new Error('测试里不允许抓 URL');
      },
    },
  };
}

/** 造一条带图的消息事件 */
function evtWithImage(messageId, file) {
  return {
    messageId,
    segments: [{ type: 'image', data: { file, url: '' } }],
    text: '[图片]',
  };
}

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-vision-wiring-'));
  const store = new SessionStore({ filePath: path.join(dir, 'sessions.json') });
  return { store, dir };
}

/* ------------------------------------------------- 开关：真的关掉 */

test('★ 关闭时完全不取图（不是"取了再丢掉"）', async () => {
  const gw = fakeGateway();
  const out = await collectTurnImages({
    // enabled:false —— 这是宿主在 visionGate 里已经判过的那一步，
    // 但视觉层自己也要守：任何调用方都不该绕过开关。
    config: { ...normalizeVisionConfig({}), enabled: false },
    convKey: 'group:1',
    trigger: { messageId: 1, evt: evtWithImage(1, 'a.image') },
    deps: gw.deps,
  });
  assert.equal(gw.calls.length, 0, '关闭时网关一次都不该被调用');
  assert.equal(out.images.length, 0);
  assert.equal(out.stats.attempted, 0);
});

test('★ 开关关闭的宿主判定：effective 是 off，且不需要取图', () => {
  const eff = resolveEffective({ enabled: false, supported: true, lastTurn: { attempted: 3, loaded: 3 } });
  assert.equal(eff, 'off', '能力再强，关掉也是 off');
});

test('★ 能力实测不支持时不取图（省一次必然失败的网络请求）', () => {
  const eff = resolveEffective({ enabled: true, supported: false });
  assert.equal(eff, 'on-unsupported');
  assert.notEqual(eff, 'off', '"模型不支持"不等于"用户关了"，两种处境必须分开显示');
});

/* ------------------------------------------- 能力未知：仍然要带图 */

test('★ 能力未知（null）时仍然提交图片，并标为未探测', async () => {
  const gw = fakeGateway();
  const out = await collectTurnImages({
    config: { ...normalizeVisionConfig({}), enabled: true },
    convKey: 'group:1',
    trigger: { messageId: 7, evt: evtWithImage(7, 'b.image') },
    deps: gw.deps,
  });
  assert.equal(gw.calls.length, 1, '未探测不等于不支持，应该真的取一次');
  assert.equal(out.images.length, 1);
  assert.equal(resolveEffective({ enabled: true, supported: null }), 'on-unprobed');
});

test('★ 未探测绝不被渲染成"不支持"（三态不能折叠）', () => {
  const snap = buildVisionSnapshot({
    config: { enabled: true },
    capability: { probed: false, supported: null },
    runtime: {},
    normalize: normalizeVisionConfig,
  });
  assert.equal(snap.capability.supported, null);
  assert.equal(snap.effective, 'on-unprobed');
  assert.notEqual(snap.effective, 'on-unsupported');
});

/* ------------------------------------------- 真实的多模态请求形状 */

test('★ 组装出来的确实是 text + image_url 的多模态消息', () => {
  const dataUrl = `data:image/png;base64,${tinyPng().toString('base64')}`;
  const messages = buildMessages({
    persona: '',
    context: {
      convKey: 'group:1',
      isGroup: true,
      recent: [
        {
          role: 'user',
          nickname: '小明',
          text: '小明：看这个[图片]',
          images: [{ dataUrl, mime: 'image/png', label: '图片1' }],
        },
      ],
    },
  });

  const withImage = messages.find((m) => Array.isArray(m.content));
  assert.ok(withImage, '带图那条消息的 content 必须是数组');
  assert.equal(withImage.content[0].type, 'text', 'text 必须在最前（部分上游只认这个形状）');
  const imgPart = withImage.content.find((p) => p.type === 'image_url');
  assert.ok(imgPart, '必须有 image_url 段');
  assert.equal(imgPart.image_url.url, dataUrl, '必须是真正的 data URL，而不是 base64 裸串');
});

test('★ 文字消息仍然只有字符串 content（文本模型完全不受影响）', () => {
  const messages = buildMessages({
    persona: '',
    context: {
      convKey: 'group:1',
      isGroup: true,
      recent: [{ role: 'user', nickname: '小明', text: '小明：纯文字' }],
    },
  });
  for (const m of messages) {
    assert.equal(typeof m.content, 'string', '没有图时 content 必须还是字符串');
  }
});

/* --------------------------------------- 历史图：只提交一次 */

test('★ 历史图片只提交一次：第二次同一楼层不再取图', async () => {
  const gw = fakeGateway();
  const history = [{ floor: 3, messageId: 30, evt: { media: [{ kind: 'image', file: 'h3.image' }] } }];

  const first = await collectTurnImages({
    config: { ...normalizeVisionConfig({}), enabled: true },
    convKey: 'group:9',
    history,
    alreadySeen: new Set(),
    deps: gw.deps,
  });
  assert.equal(first.images.length, 1, '第一次应该取到');
  const callsAfterFirst = gw.calls.length;

  const second = await collectTurnImages({
    config: { ...normalizeVisionConfig({}), enabled: true },
    convKey: 'group:9',
    history,
    // 宿主把提交过的楼层记进了 imagesSeenFloors
    alreadySeen: new Set(floorsWithSubmittedImages(first.images)),
    deps: gw.deps,
  });
  assert.equal(second.images.length, 0, '第二次不应再提交同一张历史图');
  assert.equal(gw.calls.length, callsAfterFirst, '第二次连取图都不该发生（费用控制的落点）');
});

test('★ 历史图片只提交一次：跨重启（持久化集合）也生效', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-vision-restart-'));
  const filePath = path.join(dir, 'sessions.json');
  const store = new SessionStore({ filePath });
  store.append('group:5', { messageId: 100, sender: { userId: '1' }, text: '[图片]' });
  const media = [{ kind: 'image', file: 'p100.image', mime: 'image/png' }];
  assert.equal(store.attachMedia('group:5', 1, media), 1);

  assert.equal(store.markImagesSeen('group:5', [1]), 1);
  await store.flush();

  // 模拟重启：从同一个文件新建仓库
  const reopened = new SessionStore({ filePath });
  const loaded = await reopened.load();
  assert.equal(loaded.ok, true);
  const seen = reopened.imagesSeenFor('group:5');
  assert.ok(seen.has(1), '重启后仍然知道这一楼的图提交过（否则每轮重复烧钱）');
});

test('★ 同一张图在同一次调用里不重复取（引用 == 本期消息）', async () => {
  const gw = fakeGateway();
  const out = await collectTurnImages({
    config: { ...normalizeVisionConfig({}), enabled: true, includeQuoted: true },
    convKey: 'group:2',
    trigger: { messageId: 42, evt: evtWithImage(42, 'same.image') },
    quoted: { messageId: 42, evt: evtWithImage(42, 'same.image') },
    deps: gw.deps,
  });
  assert.equal(gw.calls.length, 1, '同一条消息被"本期"和"引用"各算一次是重复提交');
  assert.equal(out.images.length, 1);
});

/* --------------------------------------------- 引用图：会话归属 */

test('★ 引用图必须校验会话归属（跨会话的 id 不能被读到）', async () => {
  const { store } = await tempStore();
  // 群里有一条带图的消息
  store.append('group:1', { messageId: 500, sender: { userId: '1' }, text: '[图片]' });
  store.attachMedia('group:1', 1, [{ kind: 'image', file: 'cross.image' }]);

  // 但引用发生在另一个会话（私聊）里 —— page 限定 convKey 后应当找不到
  const page = store.page('private:2', { limit: 200 });
  const hit = page.messages.find((m) => String(m.messageId) === '500');
  assert.equal(hit, undefined, '不同会话的 page 不该看到这条消息');

  // 同一会话内则能查到（证明校验的是归属，不是"一律查不到"）
  const own = store.page('group:1', { limit: 200 }).messages.find((m) => String(m.messageId) === '500');
  assert.ok(own, '本会话内必须能查到，否则引用图功能就废了');
  assert.equal(own.media[0].file, 'cross.image');
});

/* --------------------------------------------- 取图失败：降级 */

test('★ get_image 失败时降级成纯文本，且失败码分类准确', async () => {
  const gw = fakeGateway({ fail: '网关 500' });
  const out = await collectTurnImages({
    config: { ...normalizeVisionConfig({}), enabled: true },
    convKey: 'group:3',
    trigger: { messageId: 8, evt: evtWithImage(8, 'bad.image') },
    deps: gw.deps,
  });
  assert.equal(out.images.length, 0, '取不到就不该有图');
  assert.ok(out.codes.length > 0, '必须有失败码');
  assert.ok(out.codes.every((c) => /^E310[1-9]$/.test(c)), `失败码必须落在 E3101–E3109，实际 ${out.codes.join('/')}`);
  assert.ok(out.notes.length > 0, '必须有给人看的说明');
});

test('★ 取图失败 ≠ 模型不支持：不得写进能力结论', () => {
  /*
   * 这一条守的是一类真实误判：网关抖动 → 取图失败 → 若把它记成
   * "模型不支持读图"，用户会在界面看到"已实测不支持"，而实际上
   * 模型完全能读图 —— 于是他再也不会打开这个功能。
   */
  const snap = buildVisionSnapshot({
    config: { enabled: true },
    capability: { probed: false, supported: null },
    runtime: { lastTurn: { attempted: 2, loaded: 0, codes: ['E3102'] } },
    normalize: normalizeVisionConfig,
  });
  assert.equal(snap.capability.supported, null, '取图失败不能污染能力结论');
  assert.equal(snap.effective, 'on-but-blocked', '应该显示"被挡下"而不是"不支持"');
});

test('★ 开着、能力没问题、但本回合一张都没取到 = on-but-blocked', () => {
  assert.equal(
    resolveEffective({ enabled: true, supported: true, lastTurn: { attempted: 2, loaded: 0 } }),
    'on-but-blocked',
  );
  // 纯文字回合（attempted = 0）不能被误判成"被挡下"
  assert.equal(
    resolveEffective({ enabled: true, supported: true, lastTurn: { attempted: 0, loaded: 0 } }),
    'on',
  );
});

/* --------------------------------------- 上游拒收：去图重试 */

test('★ 上游拒收图片的判定：只有 400/413/415/422 + 图片关键词才算', () => {
  assert.equal(looksLikeImageRejection(400, 'model does not support image input'), true);
  assert.equal(looksLikeImageRejection(415, 'unsupported image type'), true);
  assert.equal(looksLikeImageRejection(422, 'image_url is not supported'), true);
  assert.equal(looksLikeImageRejection(413, 'image too large'), true);
  // key 错 / 额度 / 服务端故障：都不是"图片被拒"
  assert.equal(looksLikeImageRejection(401, 'invalid api key'), false);
  assert.equal(looksLikeImageRejection(403, 'forbidden'), false);
  assert.equal(looksLikeImageRejection(429, 'rate limit exceeded'), false);
  assert.equal(looksLikeImageRejection(500, 'internal error'), false);
  // 状态码对但说的是别的事（例如上下文超长）
  assert.equal(looksLikeImageRejection(400, 'context length exceeded'), false);
  // 脏输入不炸
  assert.equal(looksLikeImageRejection(undefined, undefined), false);
  assert.equal(looksLikeImageRejection('400', null), false);
});

/* ------------------------------------------- 占位说明与记账 */

test('★ 关闭时给 [图片] 补说明，避免模型编造图里的内容', () => {
  const text = annotateImagePlaceholders('小明：[图片]', 'off');
  assert.ok(text.includes('[图片]'), '占位符本身保留');
  assert.ok(text.includes('关闭'), '要说明为什么看不到');
  assert.ok(text.includes('不要猜'), '要明确禁止编造');
});

test('★ 带图时不加"看不到"的说明（否则模型会否认图的存在）', () => {
  const text = annotateImagePlaceholders('小明：[图片]', 'on');
  assert.equal(text, '小明：[图片]', '能看图时不该多嘴');
});

test('★ 用量记账：数组 content 不会变成 [object Object]', () => {
  const dataUrl = `data:image/png;base64,${tinyPng().toString('base64')}`;
  const messages = [
    { role: 'system', content: '人格' },
    { role: 'user', content: [{ type: 'text', text: '小明：看图' }, { type: 'image_url', image_url: { url: dataUrl } }] },
  ];
  const plain = messagesToPlainText(messages);
  assert.ok(!plain.includes('[object Object]'), 'token 估算的文本里绝不能出现 [object Object]');
  assert.ok(plain.includes('小明：看图'), '要保留文本内容');
  assert.ok(!plain.includes('iVBORw0KGgo'), '不能把 base64 整段拼进去（会让估算彻底失真）');
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
});

test('★ 运行时统计：lastTurn 是覆盖、累计值才是累加', () => {
  const rt = {};
  recordVisionTurn(rt, { images: [{}, {}], stats: { attempted: 2, loaded: 2, skipped: 0, bytes: 100, codes: [] }, notes: [] });
  assert.equal(rt.imagesSubmitted, 2);
  assert.equal(rt.lastTurn.loaded, 2);

  recordVisionTurn(rt, { images: [{}], stats: { attempted: 1, loaded: 1, skipped: 0, bytes: 50, codes: [] }, notes: [] });
  assert.equal(rt.imagesSubmitted, 3, '累计值应该累加');
  assert.equal(rt.lastTurn.loaded, 1, 'lastTurn 必须只反映最近一回合');
  assert.equal(rt.lastTurn.bytes, 50, 'lastTurn 的字节也不能累加');
});

/* --------------------------------------------- 快照形状 */

test('★ 快照形状：开关 / 能力 / 实际效果 / 运行时四块齐全', () => {
  const snap = buildVisionSnapshot({
    config: { enabled: true, maxImagesPerTurn: 3 },
    capability: { probed: true, supported: true, model: 'm', probedAt: '2026-10-23T00:00:00.000Z' },
    runtime: { turnsWithImages: 4, imagesSubmitted: 9, bytesSubmitted: 12345, lastTurn: { attempted: 2, loaded: 2, bytes: 100 } },
    normalize: normalizeVisionConfig,
  });

  assert.equal(snap.enabled, true, '开关状态');
  assert.equal(snap.capability.supported, true, '能力探测结论（与开关分开）');
  assert.equal(snap.effective, 'on', '实际效果');
  assert.equal(snap.runtime.imagesSubmitted, 9, '运行统计');
  assert.equal(snap.limits.maxImagesPerTurn, 3);
  // 形状必须稳定：少一个字段界面就会渲染出 undefined
  for (const k of ['enabled', 'limits', 'capability', 'effective', 'runtime']) {
    assert.ok(k in snap, `快照缺字段 ${k}`);
  }
  for (const k of ['probed', 'supported', 'model', 'basis', 'detail', 'probedAt']) {
    assert.ok(k in snap.capability, `capability 缺字段 ${k}`);
  }
  for (const k of ['turnsWithImages', 'imagesSubmitted', 'bytesSubmitted', 'skipped', 'lastCodes', 'lastNotes', 'lastTurn', 'lastAt']) {
    assert.ok(k in snap.runtime, `runtime 缺字段 ${k}`);
  }
});

test('★ 快照里超出硬上限的配置会被夹取（界面显示的是实际生效值）', () => {
  const snap = buildVisionSnapshot({
    config: { enabled: true, maxImagesPerTurn: 99, timeoutMs: 30000 },
    capability: {},
    runtime: {},
    normalize: normalizeVisionConfig,
  });
  assert.equal(snap.limits.maxImagesPerTurn, 4, '必须夹到硬上限');
  assert.ok(snap.limits.timeoutMs <= 15000);
});

/* --------------------------------------------- 预算 */

test('★ 关了之后：连预算检查都不该发生（零副作用）', async () => {
  const gw = fakeGateway();
  const out = await collectTurnImages({
    config: { ...normalizeVisionConfig({}), enabled: false, maxImagesPerTurn: 4 },
    convKey: 'group:1',
    trigger: { messageId: 1, evt: evtWithImage(1, 'x.image') },
    history: [{ floor: 1, messageId: 1, evt: { media: [{ kind: 'image', file: 'x.image' }] } }],
    deps: gw.deps,
  });
  assert.equal(gw.calls.length, 0);
  assert.deepEqual(out.codes, []);
  assert.deepEqual(out.notes, []);
  assert.equal(out.stats.attempted, 0);
});

test('★ 取图链路注入的 fetchUrl 不被误调用（URL 来源只在真的没有缓存名时才试）', async () => {
  const gw = fakeGateway();
  await collectTurnImages({
    config: { ...normalizeVisionConfig({}), enabled: true },
    convKey: 'group:1',
    // 有安全缓存名 → 应该走 get_image，不该落到 URL 那一路
    trigger: { messageId: 2, evt: evtWithImage(2, 'cache.image') },
    deps: gw.deps,
  });
  assert.deepEqual(gw.calls, ['cache.image'], '只应该有 get_image 这一次调用');
});
