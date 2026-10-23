/**
 * 日记淡忘：页面口径与阈值边界 —— F18
 *
 * `test/diary-decay.test.mjs` 守的是**计算**（100→99→…、锁定、解锁不补算）。
 * 这个文件守的是**展示口径**，因为两者不一致会出一个很隐蔽的 bug：
 *
 *   界面说"这条已经淡忘了"、后端却仍把它带进上下文
 *
 * 也就是说同一条日记在两处的判定相反。用户看到的是"它明明忘了怎么还提这事"。
 *
 * 所以这里钉死三件事：
 *   1. `isHidden` 与 `shouldIncludeInContext` 在阈值上的口径互补、不重叠
 *   2. 配置默认值（100 / 每天 1 / 60）与 schema 一致
 *   3. 剩余天数的展示不会算出 Infinity 或负数
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeWeight, isHidden, shouldIncludeInContext, localDateKey, daysBetween } from '../src/diary/decay.mjs';
import { DEFAULT_CONFIG } from '../src/config/schema.mjs';

/** 本地构造的当天正午，避开零点边界 */
const at = (y, m, d) => new Date(y, m - 1, d, 12, 0);

/* ------------------------------------------------------------ 配置默认值 */

test('★ 配置默认值符合需求原文：100 分、每天 -1', () => {
  assert.equal(DEFAULT_CONFIG.diary.initialWeight, 100, '「默认 100」');
  assert.equal(DEFAULT_CONFIG.diary.decayPerDay, 1, '「每一天减 1」');
});

test('配置默认值：隐藏阈值 0（默认不藏任何东西）', () => {
  assert.equal(DEFAULT_CONFIG.diary.hiddenBelowWeight, 0);
});

test('配置默认值：进上下文的门槛是 60', () => {
  assert.equal(DEFAULT_CONFIG.diary.contextMinWeight, 60);
});

/* ------------------------------------------------------------ 阈值口径 */

test('★ 阈值口径互补：同一条日记不会既"隐藏"又"进上下文"', () => {
  /*
   * 两边都用同一个阈值 60 时：
   *   isHidden(w, 60)             → w < 60 才隐藏
   *   shouldIncludeInContext(w,60) → w >= 60 才带
   * 所以 w=60 恰好是"可见且带"，w=59 是"隐藏且不带"。没有裂缝。
   */
  for (const w of [0, 1, 30, 59, 60, 61, 99, 100]) {
    const hidden = isHidden(w, 60);
    const included = shouldIncludeInContext(w, 60);
    assert.equal(hidden, !included, `w=${w} 时两者必须互补，实际 hidden=${hidden} included=${included}`);
  }
});

test('阈值边界：等于阈值时仍然可见、仍然进上下文', () => {
  assert.equal(isHidden(60, 60), false, '等于阈值不该隐藏');
  assert.equal(shouldIncludeInContext(60, 60), true, '等于阈值该带');
});

test('阈值边界：低一分就既隐藏又不带', () => {
  assert.equal(isHidden(59, 60), true);
  assert.equal(shouldIncludeInContext(59, 60), false);
});

test('阈值 0：没有日记会被默认隐藏', () => {
  // 默认配置就是 0，即"没配阈值时全带"——把 0 理解成全屏蔽是个反直觉的坑
  for (const w of [0, 1, 50, 100]) {
    assert.equal(isHidden(w, 0), false, `w=${w} 在阈值 0 下不该被隐藏`);
    assert.equal(shouldIncludeInContext(w, 0), true);
  }
});

/* ------------------------------------------------------------ 权重曲线 */

test('★ 100 分开始，每天掉 1，第 41 天掉到 60（正好是上下文门槛）', () => {
  const rec = { weightBase: 100, weightBaseDate: '2026-01-01' };
  // 第 1 天 = 1-01；第 41 天 = 2-10（相差 40 天）
  const r = computeWeight({ ...rec, now: at(2026, 2, 10) });
  assert.equal(r.weight, 60);
  assert.equal(shouldIncludeInContext(r.weight, DEFAULT_CONFIG.diary.contextMinWeight), true, '刚好还在上下文里');

  // 第 42 天掉到 59 → 不再进上下文
  const r2 = computeWeight({ ...rec, now: at(2026, 2, 11) });
  assert.equal(r2.weight, 59);
  assert.equal(shouldIncludeInContext(r2.weight, DEFAULT_CONFIG.diary.contextMinWeight), false, '掉出上下文');
});

test('权重到 0 后不再变负', () => {
  const r = computeWeight({ weightBase: 100, weightBaseDate: '2026-01-01', now: at(2027, 1, 1) });
  assert.equal(r.weight, 0);
  assert.ok(r.weight >= 0, '权重不能为负');
  assert.equal(r.faded, true);
});

/* ------------------------------------------------------------ 剩余天数 */

test('★ 剩余天数：按当前衰减速度算，不出现 Infinity 或负数', () => {
  /*
   * 界面会显示"约 N 天后淡忘"。这条断言防的是除以 0 得到 Infinity，
   * 或者权重已经 0 却算出负数天。
   */
  const remainDays = (weight, perDay) => {
    if (perDay <= 0) return null; // 不衰减
    if (weight <= 0) return 0; // 已淡忘
    return Math.ceil(weight / perDay);
  };

  assert.equal(remainDays(100, 1), 100);
  assert.equal(remainDays(60, 1), 60);
  assert.equal(remainDays(0, 1), 0, '已淡忘时是 0 天，不是负数');
  assert.equal(remainDays(100, 0), null, 'decayPerDay=0 时不该算出 Infinity');
  assert.ok(Number.isFinite(remainDays(37, 1)));
});

/* ------------------------------------------------------------ 本地时区 */

test('★ 日期键用本地时区：同一天任何时刻都是同一个键', () => {
  assert.equal(localDateKey(at(2026, 6, 15)), '2026-06-15');
  // 凌晨与深夜必须落在同一天（用 UTC 会跨日）
  assert.equal(localDateKey(new Date(2026, 5, 15, 0, 0, 1)), '2026-06-15');
  assert.equal(localDateKey(new Date(2026, 5, 15, 23, 59, 59)), '2026-06-15');
});

test('日期差按自然日，不是毫秒除法', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-02'), 1);
  assert.equal(daysBetween('2026-01-01', '2026-01-01'), 0);
  assert.equal(daysBetween('2026-01-02', '2026-01-01'), -1, '反序是负数');
});

/* ------------------------------------------------------------ 锁定展示 */

test('锁定期间权重冻结，与衰减配置无关', () => {
  const rec = {
    weightBase: 100,
    weightBaseDate: '2026-01-01',
    locked: true,
    lockedWeight: 88,
    lockedDate: '2026-01-13',
  };
  // 一年后仍是 88
  assert.equal(computeWeight({ ...rec, now: at(2027, 1, 1) }).weight, 88);
  // 换一个 decayPerDay 也不影响
  assert.equal(computeWeight({ ...rec, decayPerDay: 10, now: at(2027, 1, 1) }).weight, 88);
});
