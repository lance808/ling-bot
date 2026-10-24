/**
 * 表情包体系：宿主侧（effects / 授权 / 网关能力 / 人格协调）
 *
 * ## 这个文件测什么、不测什么
 *
 * 它只测**宿主**这一半：新增的两个 effect 有没有立起正确的风险下限、
 * `ctx.gateway` 的边界（归属、能力三态、不支持与失败的区别、发送仍走闸门）、
 * 以及"人格写着不用表情包时工具真的不出现"。
 *
 * 插件自己的库合并、去重、限频在 `stickers-plugin.test.mjs` 里。
 *
 * 全部用注入的假网关与假发送函数：**不连 QQ、不发真消息、不调模型**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EFFECTS,
  EFFECT_RISK_FLOOR,
  riskFloorOf,
  normalizeEffects,
  maxRisk,
} from '../src/plugins/effects.mjs';
import { normalizeManifest, deriveToolPolicy, checkRiskAllowed } from '../src/plugins/manifest.mjs';
import { chatGrantAllows } from '../src/guard/chat-grant.mjs';
import {
  isToolGranted,
  isToolDisabled,
  resolveToolSet,
  DEFAULT_POLICY,
} from '../src/guard/tool-gate.mjs';
import { normalizeChannelRule, defaultChatTools } from '../src/plugins/chat-tools.mjs';
import {
  GatewayBridge,
  createGatewayFactory,
  unavailableGateway,
  normalizeFaceItem,
  looksLikeUnsupportedAction,
  FACE_FETCH_LIMITS,
} from '../src/plugins/gateway-bridge.mjs';
import { resolvePersonaStickerPolicy, buildStickerGuidance, DEFAULT_PERSONA } from '../src/llm/prompt.mjs';
import { isAnimatedImage, sniffMime } from '../src/llm/image-bytes.mjs';

/* ==================================================================== 夹具 */

/** 一张最小的 1×1 PNG（真实字节，魔数与 IHDR 都正确） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 一张单帧 GIF */
const GIF_1F = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * 造一张多帧 GIF。
 *
 * 目的只有一个：验证 `isAnimatedImage` 能真的数出第二帧 ——
 * 而这个判定直接决定"模型会不会以为自己看到了动作"。
 *
 * @param {number} frames
 * @returns {Buffer}
 */
function makeGif(frames) {
  const head = Buffer.from('GIF89a', 'ascii');
  const lsd = Buffer.alloc(7);
  lsd[0] = 1;
  lsd[2] = 1;
  const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]);
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor[5] = 1;
  descriptor[6] = 1;
  descriptor[7] = 1;
  descriptor[8] = 1;
  const lzw = Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]);
  const one = Buffer.concat([gce, descriptor, lzw]);
  return Buffer.concat([head, lsd, ...Array.from({ length: frames }, () => one), Buffer.from([0x3b])]);
}

/**
 * 一个被真正推导过的插件工具声明。
 *
 * 注意要传 `effectiveRisk`：`deriveToolPolicy` 读的是**推导后**的值，
 * 手写夹具漏掉它会让"effects 把 R0 抬到 R2"这条规则在测试里静默失效 ——
 * 那正是这个文件里最重要的一条断言。
 */
function pluginTool(over = {}) {
  const declared = {
    name: 'plugin_sticker_send',
    needs: 'qq',
    risk: 'R0',
    effects: ['chat.send.media'],
    plugin: 'stickers',
    ...over,
  };
  const eff = normalizeEffects(declared.effects);
  declared.effectiveRisk = maxRisk(declared.risk, riskFloorOf(eff.effects));
  return { ...declared, ...deriveToolPolicy(declared) };
}

/**
 * 假网关：记录收到的每个动作，按脚本回话。
 *
 * @param {Record<string, (params: any) => any>} script
 */
function fakeGateway(script = {}) {
  /** @type {Array<{action: string, params: any}>} */
  const calls = [];
  const request = async (action, params) => {
    calls.push({ action, params });
    const fn = script[action];
    if (!fn) throw Object.assign(new Error(`unexpected action ${action}`), { retcode: 1404 });
    return fn(params);
  };
  return { calls, request };
}

/** 造一个"会话里有消息"的 lookupMessage */
function lookupWith(map) {
  return ({ convKey, messageId }) => {
    const key = `${convKey}|${String(messageId)}`;
    const hit = map[key];
    if (!hit) return { ok: false, code: 'E4074', message: '不在当前会话' };
    return { ok: true, event: hit };
  };
}

/** 临时目录（每个用例一份，结束时删） */
async function tempDir(prefix = 'ling-sticker-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/* ================================================== effects：新增两个词 */

test('★ EFFECTS 里有 qq.account.read / qq.account.write，且下限分别是 R1 / R2', () => {
  assert.ok(EFFECTS.includes('qq.account.read'), '必须被宿主认识，否则清单会被 E4041 拒掉');
  assert.ok(EFFECTS.includes('qq.account.write'));
  assert.equal(EFFECT_RISK_FLOOR['qq.account.read'], 'R1');
  assert.equal(EFFECT_RISK_FLOOR['qq.account.write'], 'R2');

  for (const word of ['qq.account.read', 'qq.account.write']) {
    const one = normalizeEffects([word]);
    assert.equal(one.ok, true);
    assert.deepEqual(one.effects, [word]);
  }
});

test('★ 账号写不能靠写 R0 换自动执行：声明 R0 + qq.account.write → 生效 R2', () => {
  /*
   * 这是要求 12 的落点。作者若把它写成 R0，宿主必须抬到 R2，
   * 否则"往账号里塞表情"会变成一个自动执行、不弹确认的操作。
   */
  const manifest = normalizeManifest({
    id: 'demo',
    name: '演示',
    version: '1.0.0',
    apiVersion: '1',
    description: '测试用',
    tools: [
      {
        name: 'collect',
        description: '收藏一个表情',
        needs: 'qq',
        risk: 'R0',
        effects: ['qq.account.write'],
      },
    ],
  });
  assert.equal(manifest.ok, true, manifest.message);
  const tool = manifest.manifest.tools[0];
  assert.equal(tool.risk, 'R0', '声明的仍是 R0');
  assert.equal(tool.effectiveRisk, 'R2', '生效风险必须被抬到 R2');
  assert.equal(deriveToolPolicy(tool).risk, 'R2');
  assert.equal(deriveToolPolicy(tool).confirm, 'always', 'R2 必须人工确认');
});

test('两项混合时取最高下限', () => {
  assert.equal(riskFloorOf(['qq.account.read']), 'R1');
  assert.equal(riskFloorOf(['qq.account.read', 'qq.account.write']), 'R2');
  assert.equal(riskFloorOf(['qq.account.write', 'exec']), 'R3');
  assert.equal(maxRisk('R1', 'R2'), 'R2');
  assert.equal(maxRisk('R3', 'R2'), 'R3');
});

test('★ 账号写进不了聊天来源（即使管理员把它写进 tools）', () => {
  const tool = pluginTool({ effects: ['qq.account.write'] });
  assert.equal(tool.risk, 'R2');

  // 管理员明确点名 + 允许付费，仍然必须被拒
  const grant = {
    channel: 'group',
    rule: { enabled: true, tools: ['plugin_sticker_send'], allowPaid: true },
  };
  const one = chatGrantAllows(tool, grant);
  assert.equal(one.ok, false);
  assert.equal(one.reason, 'write-or-exec-tool');
});

test('★ 账号读可以进聊天来源（R1 上限内），但要管理员点名', () => {
  const tool = pluginTool({ name: 'plugin_sticker_list', effects: ['qq.account.read'], risk: 'R1' });
  assert.equal(tool.risk, 'R1');

  const notListed = chatGrantAllows(tool, {
    channel: 'group',
    rule: { enabled: true, tools: [], allowPaid: false },
  });
  assert.equal(notListed.ok, false);
  assert.equal(notListed.reason, 'tool-not-listed');

  const listed = chatGrantAllows(tool, {
    channel: 'group',
    rule: { enabled: true, tools: ['plugin_sticker_list'], allowPaid: false },
  });
  assert.equal(listed.ok, true);
});

test('R2 的账号写工具在 allowDangerous 关闭时整体不可启用', () => {
  const r = checkRiskAllowed('R2', false);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4042');
  assert.equal(checkRiskAllowed('R2', true).ok, true);
});

/* ============================================ 人格禁用 → 工具不可见 */

test('★ 人格禁用时表情工具从候选集里消失（结构性，不是提示词）', () => {
  const tools = [
    pluginTool({ name: 'plugin_sticker_send', effects: ['chat.send.media'] }),
    pluginTool({ name: 'plugin_sticker_list', effects: ['qq.account.read'], risk: 'R1' }),
    pluginTool({ name: 'plugin_echo', effects: [] }),
  ];
  const policy = { ...DEFAULT_POLICY, chatTools: null, disabledTools: ['plugin_sticker_send', 'plugin_sticker_list'] };

  const visible = resolveToolSet('owner-private', tools, policy, { convKey: 'private:1' });
  const names = visible.map((t) => t.name);
  assert.equal(names.includes('plugin_sticker_send'), false);
  assert.equal(names.includes('plugin_sticker_list'), false);
  assert.equal(names.includes('plugin_echo'), true, '别的工具不该被连带禁掉');

  // 执行层同样拦住：可见性只是第一道
  const one = isToolGranted(tools[0], 'owner-private', policy, { convKey: 'private:1' });
  assert.equal(one, false);
});

test('disabledTools 只做精确匹配，不做前缀/通配', () => {
  const policy = { ...DEFAULT_POLICY, disabledTools: ['plugin_sticker_send'] };
  assert.equal(isToolDisabled({ name: 'plugin_sticker_send' }, policy), true);
  assert.equal(isToolDisabled({ name: 'plugin_sticker_send_v2' }, policy), false);
  assert.equal(isToolDisabled({ name: 'plugin_sticker' }, policy), false);
  // 通配符不被解释
  assert.equal(isToolDisabled({ name: 'plugin_sticker_send' }, { disabledTools: ['plugin_*'] }), false);
});

test('disabledTools 缺省/空数组时不改变任何行为', () => {
  const tool = pluginTool();
  assert.equal(isToolGranted(tool, 'owner-private', DEFAULT_POLICY, { convKey: 'private:1' }), true);
  assert.equal(isToolGranted(tool, 'owner-private', { ...DEFAULT_POLICY, disabledTools: [] }, { convKey: 'private:1' }), true);
});

/* ================================================ 人格表态的三态识别 */

test('★ 默认人格被判成 forbid（它写着「不用表情包」）', () => {
  assert.equal(resolvePersonaStickerPolicy(DEFAULT_PERSONA), 'forbid');
});

test('人格表态三态：forbid / allow / unset', () => {
  assert.equal(resolvePersonaStickerPolicy('说话习惯：不用表情包'), 'forbid');
  assert.equal(resolvePersonaStickerPolicy('不要发表情'), 'forbid');
  assert.equal(resolvePersonaStickerPolicy('禁止使用表情包'), 'forbid');
  assert.equal(resolvePersonaStickerPolicy('表情包别用'), 'forbid');

  assert.equal(resolvePersonaStickerPolicy('可以发表情'), 'allow');
  assert.equal(resolvePersonaStickerPolicy('偶尔用表情包也行'), 'allow');

  assert.equal(resolvePersonaStickerPolicy(''), 'unset');
  assert.equal(resolvePersonaStickerPolicy('说话简短，别写小作文'), 'unset');
  assert.equal(resolvePersonaStickerPolicy('你表情很丰富'), 'unset', '「表情」单独出现不是表态');
});

test('「允许但克制」不会被误判成禁止', () => {
  // 同时含"可以"与"别……发"，意图是允许
  assert.equal(resolvePersonaStickerPolicy('可以发表情，但别在正式场合发'), 'allow');
});

test('表情策略：enabled=false 时不注入；视觉关着时点明"不要声称看过图"', () => {
  assert.equal(buildStickerGuidance({ enabled: false }), '');
  const on = buildStickerGuidance({ enabled: true, maxPerTurn: 1, visionEnabled: false });
  assert.ok(on.includes('表情包'));
  assert.ok(on.includes('不要**声称你看过图') || on.includes('不要声称你看过图'), '必须点明视觉关着');
  assert.ok(on.includes('一张'), '必须说明一条一张');
});

test('overridePersona 时策略声明优先于人格那句话（但不改人格文本）', () => {
  const g = buildStickerGuidance({ enabled: true, overridePersona: true });
  assert.ok(g.includes('优先于人格里关于表情的那句话'));

  const normal = buildStickerGuidance({ enabled: true });
  assert.ok(normal.includes('以人格为准'));
});

/* ==================================================== 网关：能力探测 */

test('★ 能力三态：探测成功且缺动作 → unsupported；探测失败 → unknown', async () => {
  // ① 探测成功，但没有 add_custom_face
  const a = new GatewayBridge({
    request: async () => ['fetch_custom_face_detail'],
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
  });
  await a.probe({ force: true });
  const ca = a.capsView();
  assert.equal(ca.prober, 'ok');
  assert.equal(ca.fetchCustomFaceDetail, 'supported');
  assert.equal(ca.addCustomFace, 'unsupported');

  // ② 探测本身失败 → 一律 unknown（不是 unsupported）
  const b = new GatewayBridge({
    request: async () => {
      throw new Error('网络超时');
    },
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
  });
  const pb = await b.probe({ force: true });
  assert.equal(pb.ok, false);
  const cb = b.capsView();
  assert.equal(cb.addCustomFace, 'unknown', '没测出来 ≠ 不支持');
  assert.equal(cb.fetchCustomFaceDetail, 'unknown');
});

test('★ 网关没有 get_supported_actions 时保持 unknown（很多网关只是没实现这个元动作）', async () => {
  const g = new GatewayBridge({
    request: async () => ({ status: 'ok', data: { not: 'an array' } }),
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
  });
  const r = await g.probe({ force: true });
  assert.equal(r.ok, true);
  assert.equal(g.capsView().addCustomFace, 'unknown');
});

test('实测"不认识这个动作"会降级为 unsupported，且后续调用直接短路', async () => {
  const { calls, request } = fakeGateway({
    get_supported_actions: () => ['fetch_custom_face_detail'],
  });
  const g = new GatewayBridge({ request, lookupMessage: () => ({ ok: false }), sendSegments: async () => ({ ok: true }) });
  await g.probe({ force: true });
  assert.equal(g.capsView().addCustomFace, 'unsupported');

  const before = calls.length;
  const r = await g.call('add_custom_face', { file: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_GATEWAY_UNSUPPORTED');
  assert.equal(calls.length, before, '已知不支持就不该再打网关');
});

test('「不支持」与「调用失败」是两个码', () => {
  assert.equal(looksLikeUnsupportedAction({ retcode: 1404 }), true);
  assert.equal(looksLikeUnsupportedAction({ message: '不支持的 API' }), true);
  assert.equal(looksLikeUnsupportedAction({ message: 'connection timeout' }), false);
  assert.equal(looksLikeUnsupportedAction({ retcode: 0, message: '' }), false);
});

/* ==================================================== 网关：列表与合并 */

test('★ listFaces：拿满 count 时 complete=false（不能据此删本地条目）', async () => {
  const items = Array.from({ length: 3 }, (_, i) => ({ emoji_id: `e${i}`, md5: `M${i}`, desc: `d${i}`, url: 'https://x/y.png' }));
  const { request } = fakeGateway({ fetch_custom_face_detail: () => items });

  const g = new GatewayBridge({ request, lookupMessage: () => ({ ok: false }), sendSegments: async () => ({ ok: true }) });
  const full = await g.listFaces({ count: 3 });
  assert.equal(full.ok, true);
  assert.equal(full.items.length, 3);
  assert.equal(full.complete, false, '拿满可能被截断');

  const partial = await g.listFaces({ count: 10 });
  assert.equal(partial.complete, true, '少拿才算全量');
});

test('★ listFaces：返回结构不对时报 BAD_PAYLOAD，绝不退化成空数组', async () => {
  const { request } = fakeGateway({ fetch_custom_face_detail: () => ({ status: 'ok', data: null }) });
  const g = new GatewayBridge({ request, lookupMessage: () => ({ ok: false }), sendSegments: async () => ({ ok: true }) });
  const r = await g.listFaces({ count: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_GATEWAY_BAD_PAYLOAD');
  assert.equal(r.items, undefined, '不能给一个空数组让调用方误以为账号是空的');
});

test('条目归一化：缺 id 的丢弃，md5 大写，字段名兼容三种写法', () => {
  assert.equal(normalizeFaceItem({ desc: '没有 id' }), null);
  assert.equal(normalizeFaceItem(null), null);

  const a = normalizeFaceItem({ emoji_id: 12, md5: 'aabb', desc: 'd', url: 'https://x' });
  assert.equal(a.id, '12');
  assert.equal(a.md5, 'AABB');
  assert.equal(a.resId, '12');

  const b = normalizeFaceItem({ resId: 'r1', summary: '说明' });
  assert.equal(b.id, 'r1');
  assert.equal(b.desc, '说明');
});

test('listFaces 会丢掉没有 id 的条目，但不影响其它条目', async () => {
  const { request } = fakeGateway({
    fetch_custom_face_detail: () => [{ emoji_id: 'a' }, { desc: '没有 id' }, { emoji_id: 'b' }],
  });
  const g = new GatewayBridge({ request, lookupMessage: () => ({ ok: false }), sendSegments: async () => ({ ok: true }) });
  const r = await g.listFaces({ count: 10 });
  assert.equal(r.items.length, 2);
});

/* ============================================ 网关：取图（动图与超限） */

test('★ fetchFaceImage：按魔数判类型、算出 sha256、识别动图、落盘到 faces/', async () => {
  const dir = await tempDir();
  try {
    const gif = makeGif(2);
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => ({ ok: true }),
      fetchUrl: async () => ({ buffer: gif }),
    });
    const r = await g.fetchFaceImage({ dir, ref: { id: 'x', url: 'https://cdn/x.gif' }, maxBytes: 96 * 1024 });
    assert.equal(r.ok, true);
    assert.equal(r.mime, 'image/gif');
    assert.equal(r.animated, true, '两帧 GIF 必须判成动图');
    assert.match(r.file, /^faces\/[0-9a-f]{64}\.gif$/);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.ok(r.dataUrl.startsWith('data:image/gif;base64,'));

    const st = await fs.stat(path.join(dir, r.file));
    assert.equal(st.isFile(), true, '必须真的落盘（发送时要用）');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('★ 超过识别预算：仍然落盘并返回 file，但 dataUrl 为空、tooLarge=true', async () => {
  const dir = await tempDir();
  try {
    // 造一个大一点的 PNG：在 1×1 后面补注释不会变格式，但足够超过 1KB 预算
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(4096, 0)]);
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => ({ ok: true }),
      fetchUrl: async () => ({ buffer: big }),
    });
    const r = await g.fetchFaceImage({ dir, ref: { id: 'x', url: 'https://cdn/x.png' }, maxBytes: 2048 });
    assert.equal(r.ok, true, '这不是失败：仍然能发');
    assert.equal(r.tooLarge, true);
    assert.equal(r.dataUrl, '', '超预算不返回 base64，否则会撞爆工具返回值上限');
    assert.ok(r.file, '必须仍然有 file 才能发送');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('★ 识别预算被夹在 4KB..128KB 之间（超出按边界夹取，不是照单全收）', async () => {
  /*
   * docs/stickers-contract.md §1.3：`maxBytes` 默认 96KB，**可传范围 4096..131072**
   * （超出按边界夹取）。
   *
   * 上界不是洁癖：`dataUrl` 是 base64（膨胀 4/3），而工具返回值整体不得超
   * 256KB。让调用方传 4MB（下载硬顶）就会把返回值撞爆 → 整次调用变 E4066，
   * 症状是"插件偶尔坏掉"。
   */
  assert.equal(FACE_FETCH_LIMITS.hardMaxBytes, 4 * 1024 * 1024);

  const dir = await tempDir();
  try {
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => ({ ok: true }),
      fetchUrl: async () => ({ buffer: Buffer.concat([PNG_1X1, Buffer.alloc(200 * 1024, 0)]) }),
    });

    // 传 4MB：必须按 128KB 夹取 → 200KB 的图算"超过识别预算"
    const huge = await g.fetchFaceImage({ dir, ref: { id: 'x', url: 'https://cdn/x.png' }, maxBytes: 4 * 1024 * 1024 });
    assert.equal(huge.ok, true);
    assert.equal(huge.tooLarge, true, '4MB 的预算必须被夹到 128KB，否则 dataUrl 会撞爆返回值上限');
    assert.equal(huge.dataUrl, '');

    const g2 = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => ({ ok: true }),
      // ~2KB：夹在 1KB 与 4KB 之间，正好能区分下界是 1024 还是 4096
      fetchUrl: async () => ({ buffer: Buffer.concat([PNG_1X1, Buffer.alloc(1900, 0)]) }),
    });

    // 传 1KB：必须按 4KB 夹取 → 2KB 的图是"能看"的
    const small = await g2.fetchFaceImage({ dir, ref: { id: 'y', url: 'https://cdn/y.png' }, maxBytes: 1024 });
    assert.equal(small.ok, true);
    assert.ok(small.bytes > 1024 && small.bytes < 4096, `前置条件：图应该在 1KB 与 4KB 之间（实际 ${small.bytes}）`);
    assert.equal(small.tooLarge, false, '下界必须夹到 4096：传 1024 不该让 2KB 的图"永远看不到"');
    assert.ok(small.dataUrl.startsWith('data:image/png;base64,'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('不是图片的字节被拒（按魔数，不看扩展名）', async () => {
  const dir = await tempDir();
  try {
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => ({ ok: true }),
      fetchUrl: async () => ({ buffer: Buffer.from('<html>not an image</html>') }),
    });
    const r = await g.fetchFaceImage({ dir, ref: { id: 'x', url: 'https://cdn/x.png' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E_STICKER_FETCH_FAILED');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('非 http(s) 的地址一律拒绝（file:// 是绕过受控链路的入口）', async () => {
  const dir = await tempDir();
  try {
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => ({ ok: true }),
    });
    for (const url of ['file:///C:/Windows/win.ini', 'data:image/png;base64,AAAA', '']) {
      const r = await g.fetchFaceImage({ dir, ref: { id: 'x', url } });
      assert.equal(r.ok, false, url || '(空)');
      assert.equal(r.code, 'E_STICKER_NO_IMAGE_URL');
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('动图判定：单帧 GIF 不是动图；PNG 静图不是动图', () => {
  assert.equal(isAnimatedImage(GIF_1F), false);
  assert.equal(isAnimatedImage(makeGif(1)), false);
  assert.equal(isAnimatedImage(makeGif(2)), true);
  assert.equal(isAnimatedImage(PNG_1X1), false);
  assert.equal(sniffMime(GIF_1F), 'image/gif');
});

/* ==================================================== 网关：收藏归属 */

test('★ collectFace：不属于当前会话的消息一律 E4074（不区分"不存在"与"别的会话"）', async () => {
  const dir = await tempDir();
  try {
    const g = new GatewayBridge({
      request: async () => [],
      // 只有 private:1 里的 msg 1 存在
      lookupMessage: lookupWith({ 'private:1|1': { messageId: 1, sender: { userId: '42' }, segments: [{ type: 'image', data: { base64: `base64://${PNG_1X1.toString('base64')}` } }] } }),
      sendSegments: async () => ({ ok: true }),
    });

    const other = await g.collectFace({ convKey: 'group:2', messageId: 1 });
    assert.equal(other.ok, false);
    assert.equal(other.code, 'E4074');

    const missing = await g.collectFace({ convKey: 'private:1', messageId: 999 });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'E4074');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('★ collectFace：不能收藏自己发的消息', async () => {
  const seg = { type: 'image', data: { base64: `base64://${PNG_1X1.toString('base64')}` } };
  const g = new GatewayBridge({
    request: async () => ({ emoji_id: 'e1' }),
    lookupMessage: lookupWith({
      'group:1|7': { messageId: 7, sender: { userId: '999' }, segments: [seg] },
    }),
    sendSegments: async () => ({ ok: true }),
  });
  const r = await g.collectFace({ convKey: 'group:1', messageId: 7, selfId: '999' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_STICKER_SELF_COLLECT');
});

test('★ collectFace：消息里没有图片段时明确报错', async () => {
  const g = new GatewayBridge({
    request: async () => ({ emoji_id: 'e1' }),
    lookupMessage: lookupWith({
      'group:1|8': { messageId: 8, sender: { userId: '42' }, segments: [{ type: 'text', data: { text: 'hi' } }] },
    }),
    sendSegments: async () => ({ ok: true }),
  });
  const r = await g.collectFace({ convKey: 'group:1', messageId: 8, selfId: '999' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_STICKER_NO_IMAGE');
});

test('★ collectFace：网关不支持时明确报 UNSUPPORTED，不能降级成本地收藏', async () => {
  const seg = { type: 'image', data: { base64: `base64://${PNG_1X1.toString('base64')}` } };
  const { calls, request } = fakeGateway({
    get_supported_actions: () => ['fetch_custom_face_detail'],
    add_custom_face: () => ({ emoji_id: 'never' }),
  });
  const g = new GatewayBridge({
    request,
    lookupMessage: lookupWith({ 'group:1|9': { messageId: 9, sender: { userId: '42' }, segments: [seg] } }),
    sendSegments: async () => ({ ok: true }),
  });
  await g.probe({ force: true });

  const r = await g.collectFace({ convKey: 'group:1', messageId: 9 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_GATEWAY_UNSUPPORTED');
  assert.equal(calls.some((c) => c.action === 'add_custom_face'), false, '已知不支持就不该再打');
});

test('★ collectFace 成功：返回 emojiId 与 sha256，备注失败只给 warning', async () => {
  const seg = { type: 'image', data: { base64: `base64://${PNG_1X1.toString('base64')}` } };
  const { request } = fakeGateway({
    add_custom_face: () => ({ emoji_id: 'e42' }),
    modify_custom_face: () => ({ status: 'failed', wording: '不支持改备注' }),
  });
  const g = new GatewayBridge({
    request,
    lookupMessage: lookupWith({ 'group:1|10': { messageId: 10, sender: { userId: '42' }, segments: [seg] } }),
    sendSegments: async () => ({ ok: true }),
  });

  const ok = await g.collectFace({ convKey: 'group:1', messageId: 10, desc: '好图' });
  assert.equal(ok.ok, true);
  assert.equal(ok.emojiId, 'e42');
  assert.equal(ok.viaQqAccount, true);
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  assert.ok(ok.warning.includes('备注'), '备注失败要说出来，但不影响收藏成功');
});

test('★ collectFace：收藏成功但没返回 emoji_id 时不能算成功', async () => {
  const seg = { type: 'image', data: { base64: `base64://${PNG_1X1.toString('base64')}` } };
  const { request } = fakeGateway({ add_custom_face: () => ({ status: 'ok' }) });
  const g = new GatewayBridge({
    request,
    lookupMessage: lookupWith({ 'group:1|11': { messageId: 11, sender: { userId: '42' }, segments: [seg] } }),
    sendSegments: async () => ({ ok: true }),
  });
  const r = await g.collectFace({ convKey: 'group:1', messageId: 11 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_STICKER_COLLECT_NO_ID');
});

/* ==================================================== 网关：发送表情 */

/**
 * 造一个可发送的表情文件（直接写进 faces/，模拟 fetchFaceImage 的产物）。
 *
 * @param {string} dir
 * @returns {Promise<string>} 相对路径
 */
async function seedFace(dir) {
  const rel = 'faces/abc123.png';
  await fs.mkdir(path.join(dir, 'faces'), { recursive: true });
  await fs.writeFile(path.join(dir, rel), PNG_1X1);
  return rel;
}

test('★ sendFace：走注入的发送通路，消息段里只有一张图（没有文字段）', async () => {
  const dir = await tempDir();
  try {
    const rel = await seedFace(dir);
    /** @type {any[]} */
    const sent = [];
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async (input) => {
        sent.push(input);
        return { ok: true, messageId: 1001 };
      },
      sendDelayMs: [0, 0],
    });

    const r = await g.sendFace({ convKey: 'group:1', dir, file: rel });
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 1001);
    assert.equal(r.bubbles, 1);

    assert.equal(sent.length, 1);
    const segs = sent[0].segments;
    assert.equal(segs.filter((s) => s.type === 'text').length, 0, '不能在同一气泡里带文字');
    assert.equal(segs.filter((s) => s.type === 'image').length, 1, '一条消息只有一张表情');
    assert.equal(sent[0].convKey, 'group:1');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('★ sendFace：闸门拒绝原样返回 code，不包成别的错误', async () => {
  const dir = await tempDir();
  try {
    const rel = await seedFace(dir);
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => ({ ok: false, code: 'E2030', message: '发送过快（每分钟上限 8）' }),
      sendDelayMs: [0, 0],
    });
    const r = await g.sendFace({ convKey: 'group:1', dir, file: rel });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E2030');
    assert.match(r.message, /每分钟/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('★ sendFace：引用必须属于当前会话（E4074），否则不发出去', async () => {
  const dir = await tempDir();
  try {
    const rel = await seedFace(dir);
    let called = false;
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => {
        called = true;
        return { ok: true };
      },
      sendDelayMs: [0, 0],
    });
    const r = await g.sendFace({ convKey: 'group:1', dir, file: rel, replyToMessageId: '999' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E4074');
    assert.equal(called, false, '被拒的引用不能先发出去再报错');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sendFace：私聊里传 atUserId 被拒', async () => {
  const dir = await tempDir();
  try {
    const rel = await seedFace(dir);
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: true, event: { messageId: 1 } }),
      sendSegments: async () => ({ ok: true }),
      sendDelayMs: [0, 0],
    });
    const r = await g.sendFace({ convKey: 'private:1', dir, file: rel, atUserId: '42' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E_STICKER_TARGET_NOT_GROUP');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('★ sendFace：缓存目录之外的文件一律拒绝（路径越界）', async () => {
  const dir = await tempDir();
  const outside = await tempDir('ling-sticker-out-');
  try {
    await fs.writeFile(path.join(outside, 'evil.png'), PNG_1X1);
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => ({ ok: true }),
      sendDelayMs: [0, 0],
    });
    for (const file of ['../evil.png', 'evil.png', path.join(outside, 'evil.png')]) {
      const r = await g.sendFace({ convKey: 'group:1', dir, file });
      assert.equal(r.ok, false, file);
      assert.ok(['E4075', 'E_STICKER_NOT_FOUND'].includes(r.code), `${file} → ${r.code}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('★ sendFace：与文本共用队列（同一个 key 上严格按顺序）', async () => {
  const dir = await tempDir();
  try {
    const rel = await seedFace(dir);
    /** @type {string[]} */
    const order = [];
    /** 极简串行器：与 reply/send.mjs 的语义一致 */
    const chains = new Map();
    const sequencer = {
      run(key, fn) {
        const prev = chains.get(key) ?? Promise.resolve();
        const next = prev.then(() => fn(), () => fn());
        chains.set(key, next.then(() => {}, () => {}));
        return next;
      },
    };

    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async (input) => {
        order.push(input.auditText);
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true };
      },
      sequencer,
      sendDelayMs: [0, 0],
    });

    // 同时进来三条，其中两条是文字（用同一个 sequencer 模拟宿主的文本通路）
    const textSend = (t) => sequencer.run('group:1', async () => {
      order.push(t);
      await new Promise((r) => setTimeout(r, 5));
    });
    const p1 = textSend('文字1');
    const p2 = g.sendFace({ convKey: 'group:1', dir, file: rel, label: '表情' });
    const p3 = textSend('文字3');
    await Promise.all([p1, p2, p3]);

    assert.deepEqual(order, ['文字1', '[表情] 表情', '文字3'], '表情必须排在它两次调用之间的位置，不能插队');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sendFace 成功后回调 onFaceSent（供宿主记 [表情] 上下文）', async () => {
  const dir = await tempDir();
  try {
    const rel = await seedFace(dir);
    /** @type {any[]} */
    const noted = [];
    const g = new GatewayBridge({
      request: async () => [],
      lookupMessage: () => ({ ok: false }),
      sendSegments: async () => ({ ok: true, messageId: 7 }),
      sendDelayMs: [0, 0],
      onFaceSent: (info) => noted.push(info),
    });
    await g.sendFace({ convKey: 'group:1', dir, file: rel });
    assert.equal(noted.length, 1);
    assert.equal(noted[0].convKey, 'group:1');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ============================================ 网关：工厂与会话归属 */

test('★ 工厂：没有会话时收藏/发送返回 E4074（而不是去读空会话）', async () => {
  const { makeGateway } = createGatewayFactory({
    request: async () => [],
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
  });
  const gw = makeGateway({ convKey: '', dataDir: '' });
  const collect = await gw.collectFace({ messageId: '1' });
  assert.equal(collect.code, 'E4074');
  const send = await gw.sendFace({ file: 'faces/x.png' });
  assert.equal(send.code, 'E4074');
});

test('★ 工厂：vision 是同步属性且带 known 可信位', () => {
  // 没接 getVision → known:false（不能谎称"视觉关着"）
  const noVision = createGatewayFactory({
    request: async () => [],
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
  }).makeGateway({ convKey: 'group:1' });
  assert.equal(noVision.vision.known, false);
  assert.equal(noVision.vision.enabled, false);

  // 接了 → known:true，且 supported 保持三态
  const withVision = createGatewayFactory({
    request: async () => [],
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
    getVision: () => ({ enabled: true, supported: null }),
  }).makeGateway({ convKey: 'group:1' });
  assert.equal(withVision.vision.known, true);
  assert.equal(withVision.vision.enabled, true);
  assert.equal(withVision.vision.supported, null, '未探测不能折成 false');
  assert.ok(withVision.vision instanceof Object);
  assert.equal(typeof withVision.vision.then, 'undefined', 'vision 不能是 Promise');
});

test('★ 工厂：caps() 同步、未探测时三态全是 unknown', () => {
  const gw = createGatewayFactory({
    request: async () => [],
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
  }).makeGateway({ convKey: 'group:1' });
  const caps = gw.caps();
  assert.equal(typeof caps.then, 'undefined', 'caps 不能是 Promise');
  assert.equal(caps.addCustomFace, 'unknown');
  assert.equal(caps.fetchCustomFaceDetail, 'unknown');
});

test('宿主没注入网关能力时：available=false，方法返回 E4072，形状仍然完整', async () => {
  const gw = unavailableGateway('宿主未提供网关能力');
  assert.equal(gw.available, false);
  assert.equal(gw.vision.known, false, '不能谎称视觉关着');
  const r = await gw.sendFace({ file: 'x' });
  assert.equal(r.code, 'E4072');
  assert.equal(typeof gw.caps, 'function');
});

test('取消后所有网关方法返回 E4070（不再打网关）', async () => {
  /** @type {any[]} */
  const calls = [];
  const { makeGateway } = createGatewayFactory({
    request: async (a) => {
      calls.push(a);
      return [];
    },
    lookupMessage: () => ({ ok: true, event: {} }),
    sendSegments: async () => ({ ok: true }),
  });
  const controller = new AbortController();
  controller.abort();
  const gw = makeGateway({ convKey: 'group:1', dataDir: '/tmp', signal: controller.signal });

  for (const r of [
    await gw.listFaces({}),
    await gw.collectFace({ messageId: '1' }),
    await gw.sendFace({ file: 'faces/x.png' }),
    await gw.fetchFaceImage({ ref: { url: 'https://x/y.png' } }),
  ]) {
    assert.equal(r.code, 'E4070');
  }
  assert.equal(calls.length, 0, '取消后不该再打网关');
});
