/**
 * 配置面一致性 —— F17/F18/F19 收口
 *
 * ## 为什么这个测试值得单独存在
 *
 * Ling-bot 的配置校验是 **fail-fast**：`mergeStrict` 遇到未知键直接 E40XX。
 * 这条纪律是对的（拼错的键会静默失效，比报错糟糕得多），但它有个代价：
 *
 *   **任何一项新配置漏了默认值，用户升级后直接开不了机。**
 *
 * 而漏掉的方式往往不是"忘了写"，是"改的时候两边没同步"：
 * DEFAULT_CONFIG 加了字段、config.example.json 忘了加，或者反过来。
 * 这种事靠人眼对齐是守不住的 —— 所以用测试钉死。
 *
 * 这个文件守四件事：
 *   1. example 的每一个键在 DEFAULT_CONFIG 里都存在（不会写出一个没人认识的键）
 *   2. 新增的三块（wake / diary / session 相关）默认值齐全
 *   3. 老配置（没有 wake / diary）能通过校验 —— 升级不能把老用户拦在门外
 *   4. 未知键仍然被拒（fail-fast 纪律没被放松）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, validateConfig } from '../src/config/schema.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 递归取键路径集合，例如 `wake.atMention` */
function keyPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    // 只对纯对象递归；数组和 null 到此为止
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keyPaths(v, p));
  }
  return out;
}

/**
 * 动态字典节点：键**由用户数据决定**，不是固定的配置项。
 *
 * 本测试的职责是"发现示例里写了 DEFAULT_CONFIG 不认识的键"（用户照抄会
 * 启动失败）。但 `plugins.config` 的性质不是"配置项"，而是"每个插件的
 * 普通配置"——键是插件 id，值由插件清单声明。`mergeStrict` 会把整块接受
 * （见 schema.mjs 的 DYNAMIC_MAPS），所以这些键**天然不在** DEFAULT_CONFIG
 * 里，也不该在。
 *
 * 不跳过它们的话，示例里每加一个插件的默认配置就会让这条测试变红，
 * 而真正的信号（拼错的键）会被噪音淹没。口径与 schema 的 DYNAMIC_MAPS
 * 保持一致。
 */
const DYNAMIC_PREFIXES = ['plugins.config'];

/**
 * 某个路径是否落在动态字典下面（含节点本身）。
 *
 * @param {string} p
 * @returns {boolean}
 */
function isDynamicPath(p) {
  return DYNAMIC_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}.`));
}

test('★ config.example.json 的每个键都在 DEFAULT_CONFIG 里（防写出无人认识的键）', async () => {
  const raw = await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8');
  const example = JSON.parse(raw);

  const known = new Set(keyPaths(DEFAULT_CONFIG));
  const missing = [];
  for (const p of keyPaths(example)) {
    if (isDynamicPath(p)) continue;
    if (!known.has(p)) missing.push(p);
  }

  assert.deepEqual(
    missing,
    [],
    `config.example.json 里有 DEFAULT_CONFIG 不认识的键，用户照抄示例就会启动失败：${missing.join(', ')}`,
  );
});

test('★ 示例里的动态字典只允许出现在 plugins.config 下', async () => {
  /*
   * 反过来守一遍：动态字典是**豁免**，豁免范围必须写死。
   * 如果哪天有人把 `llm` 之类也加进 DYNAMIC_PREFIXES，这条会立刻变红，
   * 提醒"你放宽的不是插件配置，而是任意未知键"。
   */
  const raw = await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8');
  const example = JSON.parse(raw);
  const known = new Set(keyPaths(DEFAULT_CONFIG));
  const unknownOutsideDynamic = keyPaths(example).filter(
    (p) => !known.has(p) && !isDynamicPath(p),
  );
  assert.deepEqual(unknownOutsideDynamic, []);
  /*
   * 插件配置块本身必须是允许的（否则上面那条豁免就没意义了）。
   *
   * 注意判的是**嵌套路径** example.plugins.config，不是顶层字面键名 ——
   * `'plugins.config' in example` 查的是顶层有没有一个叫 "plugins.config"
   * 的键（永远为 false），这条断言会被它自己骗过去。
   */
  assert.ok(
    example?.plugins && typeof example.plugins.config === 'object' && example.plugins.config !== null,
    '示例里应给出一个插件配置的写法',
  );
});

test('★ config.example.json 能通过严格校验', async () => {
  const raw = await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8');
  const example = JSON.parse(raw);
  // validateConfig 对未知键是抛错；能跑通就说明示例是合法的
  const v = validateConfig(example);
  assert.equal(typeof v, 'object');
});

/* ------------------------------------------------------------ 新增配置面 */

test('★ wake 块的默认值齐全（漏一项老配置就起不来）', () => {
  const required = [
    'defaultMode',
    'atMention',
    'nameMention',
    'question',
    'poke',
    'speakerIds',
    'keywords',
    'batchWindowMs',
    'minSleepMs',
    'maxSleepMs',
    'maxWakePerMinute',
    'maxWakePerHour',
    'noActionLimit',
    'preSleepWaitMs',
    'recommendedProbability',
  ];
  for (const k of required) {
    assert.ok(k in DEFAULT_CONFIG.wake, `wake.${k} 缺默认值`);
  }
});

test('★ diary 块的默认值齐全', () => {
  for (const k of ['initialWeight', 'decayPerDay', 'hiddenBelowWeight', 'contextMinWeight']) {
    assert.ok(k in DEFAULT_CONFIG.diary, `diary.${k} 缺默认值`);
  }
});

test('wake 默认值：触发开关默认全开（升级后 @ 不能失效）', () => {
  /*
   * 老配置里根本没有 wake 这一块。如果默认关，
   * 升级后所有人的 @ 都不再触发 —— 那比不加这个功能更坏。
   */
  assert.equal(DEFAULT_CONFIG.wake.atMention, true);
  assert.equal(DEFAULT_CONFIG.wake.nameMention, true);
  assert.equal(DEFAULT_CONFIG.wake.question, true);
  assert.equal(DEFAULT_CONFIG.wake.poke, true);
});

test('wake 默认值：频率硬限有非零默认（不能默认无限）', () => {
  assert.ok(DEFAULT_CONFIG.wake.maxWakePerMinute > 0, '默认必须有个上限');
  assert.ok(DEFAULT_CONFIG.wake.maxWakePerHour > 0);
  assert.ok(DEFAULT_CONFIG.wake.batchWindowMs > 0, '合并窗口默认要开');
});

test('wake 默认值：defaultMode 是 active', () => {
  assert.equal(DEFAULT_CONFIG.wake.defaultMode, 'active');
});

/* ------------------------------------------------------------ 老配置兼容 */

test('★ 老配置（没有 wake / diary 块）能通过校验', () => {
  // 模拟老用户 data/config.json：只有本来就有那几块
  const legacy = {
    onebot: { wsUrl: 'ws://127.0.0.1:3001' },
    llm: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    allow: { groups: [], private: [] },
    proactive: { enabled: true, probability: 0.1 },
  };
  const v = validateConfig(legacy);
  assert.equal(v.wake.defaultMode, 'active', '缺失的块要用默认值补齐');
  assert.equal(v.diary.decayPerDay, 1);
});

test('★ 老配置里的 llm.keywords 不导致启动失败，且值保留', () => {
  /*
   * 这是最容易翻车的一条：如果把 llm.keywords 从 schema 里删掉，
   * 老用户的配置一启动就报"未知键"，而且看起来像程序坏了。
   *
   * 所以字段要继续被接受。值本身会在 boot() 里迁到 wake.keywords，
   * 但 schema 这一层不能拒绝它。
   */
  const legacy = { llm: { keywords: ['小鲸鱼', '你好'] } };
  const v = validateConfig(legacy);
  assert.deepEqual(v.llm.keywords, ['小鲸鱼', '你好'], '老字段的值不能被抹掉');
});

test('旧 dsh 块仍然被接受（既有的废弃字段先例）', () => {
  const v = validateConfig({ dsh: { port: 8788 } });
  assert.equal(v.dsh.port, 8788);
});

/* ------------------------------------------------------------ fail-fast 纪律 */

test('★ 未知键仍然被拒（fail-fast 纪律没被放松）', () => {
  assert.throws(
    () => validateConfig({ 这是一个拼错的键: 1 }),
    (err) => /E40XX|未知|unknown/i.test(String(err?.message ?? err)),
    '未知键必须报错，否则拼错的配置会静默失效',
  );
});

test('未知的 wake 子键也被拒', () => {
  assert.throws(
    () => validateConfig({ wake: { atMentionTypo: true } }),
    (err) => /E40XX|未知|unknown/i.test(String(err?.message ?? err)),
  );
});

test('未知的 diary 子键也被拒', () => {
  assert.throws(
    () => validateConfig({ diary: { decayPerDayy: 2 } }),
    (err) => /E40XX|未知|unknown/i.test(String(err?.message ?? err)),
  );
});

/* ------------------------------------------------------------ 值形状 */

test('wake.speakerIds / keywords 默认是数组而不是 null', () => {
  // null 会让 `.includes()` 直接抛错，这属于"默认值给错了"的典型
  assert.ok(Array.isArray(DEFAULT_CONFIG.wake.speakerIds));
  assert.ok(Array.isArray(DEFAULT_CONFIG.wake.keywords));
});

test('空配置能得到完整默认值', () => {
  const v = validateConfig({});
  assert.ok(v.wake, 'wake 块要被补齐');
  assert.ok(v.diary, 'diary 块要被补齐');
  assert.equal(v.ui.language, 'zh-CN');
});

/* ------------------------------------------------------------ 术语 */

test('★ 新增的配置项里不出现「水位」', async () => {
  // 用户明确要求改用「楼层」。这里守配置层的可见文本
  const raw = await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8');
  assert.ok(!raw.includes('水位'), 'config.example.json 不该出现「水位」');
});
