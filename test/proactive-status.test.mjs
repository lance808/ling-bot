/**
 * 主动发言状态与「情境知识」持久化 —— 修正"只有前端"的假数据
 *
 * ## 这一组守的是什么
 *
 * 排查发现三处界面看着正常、实际是假的：
 *
 *   1. `proactiveCount` —— 界面读了，后端**从来没有**这个字段，恒为 0。
 *      这种 bug 比"没数据"更糟：它看起来像"功能正常、只是还没触发过"。
 *
 *   2. `brain.conversations` 只遍历内存 Map（`recentByConv`），
 *      重启后必然为空 —— 而会话和楼层明明都在 `sessions.json` 里。
 *      用户看到"还没有会话记录"，会以为是数据丢了。
 *
 *   3. `registry.pages` 是硬编码的旧页面列表，和实际 13 页完全不符，
 *      界面也没读它。留着会让人以为有"插件注册页面"的机制。
 *
 * ## 为什么"能主动吗"要三档而不是两档
 *
 * 护栏都过了不等于"马上会说" —— 还要按概率掷骰子。给绿色等于承诺，
 * 而 10% 概率大部分时候不动，用户会以为坏了。所以中间那档是蓝色 + 明说看概率。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TriggerLedger, decideProactive } from '../src/llm/triggers.mjs';
import { snapshotRegistry } from '../src/registry.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const MIN = 60_000;

/* ------------------------------------------------------------ 计数 */

test('★ 主动发言次数是真实累加的（不是恒 0 的假字段）', () => {
  const L = new TriggerLedger();
  assert.equal(L.snapshot('group:1').proactiveCount, 0, '初始为 0');

  L.noteProactive('group:1', 1_000_000);
  assert.equal(L.snapshot('group:1').proactiveCount, 1, '第一次主动后为 1');

  L.noteProactive('group:1', 2_000_000);
  assert.equal(L.snapshot('group:1').proactiveCount, 2, '第二次主动后为 2');

  // 不同会话互不影响
  assert.equal(L.snapshot('group:2').proactiveCount, 0, '别的会话不该被带上');
});

test('★ 读取未知会话不写回 Map（否则快照会不断制造垃圾）', () => {
  /*
   * `snapshot()` 原来用"读时创建"的 `#get`：快照遍历所有会话调它，
   * 一个从没活跃过的 convKey 就会在内存里永久留个空壳。
   * 快照 2 秒一次，这个 Map 会单调增长。
   */
  const L = new TriggerLedger();
  L.noteHuman('group:real', 1_000_000);
  const before = L.size();

  for (let i = 0; i < 50; i++) L.snapshot(`group:ghost-${i}`);

  assert.equal(L.size(), before, `读了 50 个未知会话，size 不该变（实际 ${L.size()}）`);
});

test('读取未知会话返回形状完整的默认值', () => {
  /*
   * 界面不该再判空：字段都在，只是值为 null/0。
   */
  const L = new TriggerLedger();
  const s = L.snapshot('group:never');
  assert.deepEqual(s, {
    lastHumanAt: null,
    lastProactiveAt: null,
    lastAutoTurnAt: null,
    proactiveCount: 0,
  });
});

/* ------------------------------------------------------------ 冷却状态 */

test('★ 私聊不主动（与 decideProactive 的护栏 0 一致）', () => {
  const L = new TriggerLedger();
  L.noteHuman('private:1', 1_000_000);
  const st = L.proactiveStatus('private:1', {}, false, 1_000_001);
  assert.equal(st.ready, false);
  assert.match(st.reason, /私聊/);
  assert.equal(st.retryAfterMs, null, '私聊是永远不主动，不是"等一会儿"');
});

test('★ 没有真人发言过 → 不主动（冷群不开口）', () => {
  const L = new TriggerLedger();
  const st = L.proactiveStatus('group:1', {}, true, 1_000_000);
  assert.equal(st.ready, false);
  assert.match(st.reason, /真人发言/);
});

test('★ 群安静超过活跃窗口 → 不主动', () => {
  const L = new TriggerLedger();
  const now = 10_000_000;
  L.noteHuman('group:1', now - 40 * MIN); // 40 分钟前
  const st = L.proactiveStatus('group:1', { activeWindowMs: 30 * MIN }, true, now);
  assert.equal(st.ready, false);
  assert.match(st.reason, /安静/);
});

test('★ 主动冷却中要给出「还要等多久」', () => {
  /*
   * 这是本页最有用的信息：用户真正的困惑是"它刚才怎么不说话"，
   * 而一个累计次数回答不了这个问题。
   */
  const L = new TriggerLedger();
  const now = 10_000_000;
  L.noteHuman('group:1', now - 5 * MIN);
  L.noteProactive('group:1', now - 10 * MIN); // 10 分钟前主动过

  const st = L.proactiveStatus('group:1', { minIntervalMs: 30 * MIN }, true, now);
  assert.equal(st.ready, false);
  assert.equal(st.retryAfterMs, 20 * MIN, '30 分钟间隔 - 已过 10 分钟 = 还要 20 分钟');
  assert.match(st.reason, /上次主动/);
});

test('★ 护栏都过了也只说「看概率」，不能报 ready', () => {
  /*
   * 报 ready=true 等于承诺"马上会说"。而实际按 10% 概率，
   * 大部分时候它不动 —— 用户会以为功能坏了。
   */
  const L = new TriggerLedger();
  const now = 10_000_000;
  L.noteHuman('group:1', now - 1 * MIN);
  L.noteProactive('group:1', now - 60 * MIN);

  const st = L.proactiveStatus('group:1', { minIntervalMs: 30 * MIN, probability: 0.1 }, true, now);
  assert.equal(st.ready, false, 'ready 必须是 false —— 还没掷骰子');
  assert.equal(st.rollable, true, '但要说清楚"可以掷骰子了"');
  assert.match(st.reason, /10%/, '要告诉用户概率是多少');
});

test('★ proactiveStatus 的判定顺序必须与 decideProactive 一致', () => {
  /*
   * 如果两者不一致，界面说的和实际做的就是两回事 ——
   * 那比不显示更糟。这里用同一组输入交叉验证"不能主动"的结论一致。
   */
  const cases = [
    { name: '私聊', convKey: 'private:1', isGroup: false, humanAgo: 1 * MIN, proactiveAgo: null },
    { name: '从没真人发言', convKey: 'group:1', isGroup: true, humanAgo: null, proactiveAgo: null },
    { name: '群已安静', convKey: 'group:2', isGroup: true, humanAgo: 40 * MIN, proactiveAgo: null },
    { name: '主动冷却中', convKey: 'group:3', isGroup: true, humanAgo: 5 * MIN, proactiveAgo: 10 * MIN },
  ];
  const cfg = { minIntervalMs: 30 * MIN, activeWindowMs: 30 * MIN, probability: 0.1 };
  const now = 100_000_000;

  for (const c of cases) {
    const L = new TriggerLedger();
    if (c.humanAgo !== null) L.noteHuman(c.convKey, now - c.humanAgo);
    if (c.proactiveAgo !== null) L.noteProactive(c.convKey, now - c.proactiveAgo);

    const st = L.proactiveStatus(c.convKey, cfg, c.isGroup, now);
    const decided = decideProactive({
      state: L.snapshot(c.convKey),
      isGroup: c.isGroup,
      config: cfg,
      now,
      random: () => 0, // 概率拉满：如果护栏全过就一定会主动
    });

    assert.equal(st.ready, false, `${c.name}：状态不该说 ready`);
    assert.equal(st.rollable === true, decided !== null, `${c.name}：可掷骰子与真实判定不一致`);
  }
});

/* ------------------------------------------------------------ registry 死字段 */

test('★ registry 快照不再有 pages / timers 死字段', () => {
  /*
   * `pages` 是硬编码的旧页面列表（和实际 13 页完全不符），
   * `timers` 恒为空数组、全仓没人往里写。
   *
   * 留着比删掉更危险：后来的人会以为这里有扩展点，
   * 往一个死数组里写数据，然后困惑于"为什么没生效"。
   */
  const reg = snapshotRegistry();
  assert.equal('pages' in reg, false, 'pages 已删除');
  assert.equal('timers' in reg, false, 'timers 已删除');
  assert.ok(Array.isArray(reg.actions), 'actions 仍在');
  assert.ok(Array.isArray(reg.tools), 'tools 仍在');
});

test('★ 启动中兜底快照的 registry 形状与正常快照一致', () => {
  /*
   * 兜底快照和正常快照形状不一致时，界面在"启动中"和"启动完成"
   * 之间会遇到两套结构，任何按字段假设写的代码都会在某一侧出错。
   */
  const idx = read('src/index.mjs');
  const boot = idx.match(/registry:\s*\{[^}]*\}/);
  assert.ok(boot, '应能找到兜底快照里的 registry');
  assert.ok(!/pages/.test(boot[0]), `兜底快照不该还有 pages：${boot[0]}`);
  assert.ok(!/timers/.test(boot[0]), `兜底快照不该还有 timers：${boot[0]}`);
});

/* ------------------------------------------------------------ 会话列表持久化 */

test('★ 会话列表以落盘楼层为基准，不是只遍历内存 Map', () => {
  /*
   * 之前 `brain.conversations` 只遍历 `recentByConv`（内存 Map）。
   * 重启后整块必然为空，而会话和楼层明明都在 sessions.json 里 ——
   * 用户看到"还没有会话记录"，会以为数据丢了。
   */
  const idx = read('src/index.mjs');

  const block = idx.match(/conversations:\s*\(\(\)\s*=>\s*\{[\s\S]{0,2600}?\}\)\(\)/);
  assert.ok(block, '应能找到 conversations 的构造块');
  assert.match(block[0], /sessionList/, '应以落盘会话列表为基准');
  assert.match(block[0], /recentByConv/, '也要并上内存里刚到的');
});

test('★ sessions 与 brain.conversations 共用同一份会话列表', () => {
  /*
   * 各调一次 `sessionStore.list()` 会：① 2 秒一次的快照里重复全量遍历；
   * ② 两次结果可能不一致（中间正好有新消息落盘），
   * 界面会看到自相矛盾的两个计数。
   */
  const idx = read('src/index.mjs');

  /*
   * 只数**真实调用**，注释里提到的不算 —— 注释里写这个词是为了
   * 解释"为什么不各调一次"，把它算进调用次数会让测试永远失败。
   */
  const codeOnly = idx
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
  const calls = codeOnly.match(/sessionStore\.list\(\)/g) ?? [];
  assert.equal(calls.length, 2, `快照 1 处 + action 1 处，实际 ${calls.length} 处`);

  const sessionsLine = idx.match(/\n\s+sessions:\s*(\w+),/);
  assert.ok(sessionsLine, '应能找到快照里的 sessions 字段');
  assert.equal(sessionsLine[1], 'sessionList', 'sessions 应复用同一份列表');
});

/* ------------------------------------------------------------ 界面 */

test('★ 《记忆》页展示「现在能主动吗」，且不再读不存在的 count', () => {
  const view = read('ui/src/views/memory.mjs');
  assert.match(view, /现在能主动吗/, '要有可用性那一列');
  assert.match(view, /proactiveCount/, '要有真实计数');
  assert.ok(!/c\.count\b/.test(view), '不该再回退到不存在的 c.count');
  assert.match(view, /retryAfterMs/, '要展示还要等多久');
});

test('★ 「护栏都过了」那档不能显示成绿色', () => {
  /*
   * 绿色 = "正常/可以"，用户会读成"马上会说"。
   * 实际按概率大部分时候不动 —— 必须用中性色 + 明说看概率。
   */
  const view = read('ui/src/views/memory.mjs');
  const fn = view.match(/function proactiveCell[\s\S]*?\n\}/);
  assert.ok(fn, '应能找到 proactiveCell');
  assert.match(fn[0], /可以，但看概率/, '要明说是看概率');
  assert.ok(!/pill\([^)]*'ok'\)/.test(fn[0]), '这一档不该用 ok 绿色');
});

test('★ 空态要说明「重启后仍在」，避免被当成数据丢失', () => {
  const view = read('ui/src/views/memory.mjs');
  assert.match(view, /重启/, '空态应解释重启后仍然显示');
});
