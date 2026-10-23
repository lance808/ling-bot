/**
 * 日记淡忘：权重衰减 —— F8
 *
 * 这组测试守的是「日记会慢慢被忘掉，但不会忘得莫名其妙」。
 * 重点在三件容易错的事上：
 *
 *   1. 日期差是自然日，不是毫秒除法（夏令时/时区会差一天）
 *   2. 锁定期不衰减，解锁后**不补算**锁定期
 *   3. 阈值比较的口径（等于阈值到底算带还是算藏）要被钉死
 *
 * 所有 now 都显式注入本地构造的 Date，不用带 Z 的 ISO 字符串——
 * 否则测试自己就跟着跑测试那台机器的时区漂了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  localDateKey,
  daysBetween,
  computeWeight,
  lockDiary,
  unlockDiary,
  shouldIncludeInContext,
  isHidden,
} from '../src/diary/decay.mjs';

/** 本地构造的「当天正午」，避开零点边界，免得测试自己撞上时区问题 */
function at(y, m, d, h = 12, min = 0) {
  return new Date(y, m - 1, d, h, min);
}

/** 一条默认满分的日记，写成 weightBaseDate 那天 */
function diary(dateKey, over = {}) {
  return { weightBase: 100, weightBaseDate: dateKey, locked: false, lockedWeight: null, lockedDate: null, ...over };
}

test('衰减：第 1 天 100 → 第 2 天 99 → 第 11 天 90', () => {
  const rec = diary('2026-01-01');

  assert.equal(computeWeight({ ...rec, now: at(2026, 1, 1) }).weight, 100);
  assert.equal(computeWeight({ ...rec, now: at(2026, 1, 2) }).weight, 99);
  assert.equal(computeWeight({ ...rec, now: at(2026, 1, 11) }).weight, 90);

  const r = computeWeight({ ...rec, now: at(2026, 1, 11) });
  assert.equal(r.daysElapsed, 10, '第 11 天与第 1 天相差 10 天');
  assert.equal(r.faded, false);
});

test('日期键：本地时区 YYYY-MM-DD，且补零', () => {
  assert.equal(localDateKey(at(2026, 1, 5)), '2026-01-05');
  assert.equal(localDateKey(at(2026, 12, 31)), '2026-12-31');
  // 日期键必须是本地口径：同一天不论几点都得到同一个键
  assert.equal(localDateKey(at(2026, 1, 5, 0, 0)), '2026-01-05');
  assert.equal(localDateKey(at(2026, 1, 5, 23, 59)), '2026-01-05');
});

test('日期差：跨月（1-31 → 2-1 是 1 天）', () => {
  assert.equal(daysBetween('2026-01-31', '2026-02-01'), 1);
  assert.equal(daysBetween('2026-01-01', '2026-02-01'), 31);
  // 平年 2 月 28 天
  assert.equal(daysBetween('2026-02-01', '2026-03-01'), 28);
});

test('日期差：跨年（12-31 → 1-1 是 1 天）', () => {
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1);
  assert.equal(daysBetween('2025-01-01', '2026-01-01'), 365);
});

test('日期差：闰年（2-28 → 3-1 在 2024 年是 2 天，2023 年是 1 天）', () => {
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2, '2024 是闰年，多一个 2-29');
  assert.equal(daysBetween('2023-02-28', '2023-03-01'), 1, '2023 是平年');
  assert.equal(daysBetween('2024-02-28', '2024-02-29'), 1);
  // 闰日确实存在：2-29 不能被静默进位成 3-1
  assert.equal(daysBetween('2024-02-29', '2024-03-01'), 1);
});

test('日期差：反向为负，同日为 0', () => {
  assert.equal(daysBetween('2026-01-11', '2026-01-01'), -10);
  assert.equal(daysBetween('2026-01-01', '2026-01-01'), 0);
});

test('本地时区：本地 23:59 到次日 00:01 算 1 天（跨零点即跨天）', () => {
  const before = at(2026, 1, 1, 23, 59);
  const after = at(2026, 1, 2, 0, 1);

  assert.equal(localDateKey(before), '2026-01-01');
  assert.equal(localDateKey(after), '2026-01-02');
  assert.equal(daysBetween(localDateKey(before), localDateKey(after)), 1);

  // 实际间隔只有 2 分钟，但「过了一个自然日」——衰减必须按自然日算
  const rec = diary('2026-01-01');
  assert.equal(computeWeight({ ...rec, now: before }).weight, 100);
  assert.equal(computeWeight({ ...rec, now: after }).weight, 99);
});

test('锁定：锁定当天冻结，跨 30 天权重完全不变', () => {
  const rec = diary('2026-01-01');
  // 第 3 天（权重 98）把它钉住
  const locked = lockDiary(rec, at(2026, 1, 3));

  assert.equal(locked.locked, true);
  assert.equal(locked.lockedWeight, 98, '冻结的是锁定当天的当前权重');
  assert.equal(locked.lockedDate, '2026-01-03');

  // 锁定当天不动
  assert.equal(computeWeight({ ...locked, now: at(2026, 1, 3) }).weight, 98);

  // 整整 30 天后仍然一分不掉
  const later = computeWeight({ ...locked, now: at(2026, 2, 2) });
  assert.equal(later.weight, 98, '锁定期内权重必须完全不变');
  assert.equal(later.daysElapsed, 30, 'daysElapsed 只是「锁了多久」，不参与权重');

  // 锁着的时候也永远不该被判成 faded
  assert.equal(later.faded, false);
});

test('锁定：不修改入参，且重复锁定不刷新 lockedDate', () => {
  const rec = diary('2026-01-01');
  const locked = lockDiary(rec, at(2026, 1, 3));

  assert.equal(rec.locked, false, '纯函数，不能就地改入参');
  assert.equal(rec.lockedWeight, null);

  // 第 10 天再锁一次：还锁着，就保持原样（否则「锁了多久」会被悄悄清零）
  const again = lockDiary(locked, at(2026, 1, 10));
  assert.equal(again.lockedDate, '2026-01-03');
  assert.equal(again.lockedWeight, 98);
});

test('解锁：从当天继续衰减，不补算锁定期', () => {
  const rec = diary('2026-01-01');
  const locked = lockDiary(rec, at(2026, 1, 3)); // 权重 98，锁在 1-3

  // 锁到 2-02（30 天）再解锁：基准重置为今天，权重仍从 98 起算
  const unlocked = unlockDiary(locked, at(2026, 2, 2));

  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.weightBase, 98, '解锁时的当前权重成为新基准');
  assert.equal(unlocked.weightBaseDate, '2026-02-02', '基准日期重置为解锁当天');
  assert.equal(unlocked.lockedWeight, null, '不清掉会让人误以为还锁着');
  assert.equal(unlocked.lockedDate, null);

  // 解锁当天不衰减
  assert.equal(computeWeight({ ...unlocked, now: at(2026, 2, 2) }).weight, 98);
  // 第二天掉一分
  assert.equal(computeWeight({ ...unlocked, now: at(2026, 2, 3) }).weight, 97);

  // 关键：若补算 30 天锁定期，现在应该是 68。明确不允许这个行为。
  assert.notEqual(computeWeight({ ...unlocked, now: at(2026, 2, 2) }).weight, 68);
  assert.equal(computeWeight({ ...unlocked, now: at(2026, 2, 2) }).daysElapsed, 0, '解锁后从零天起算');
});

test('解锁：未锁定的记录原样返回（不应凭空改写基准）', () => {
  const rec = diary('2026-01-01');
  const out = unlockDiary(rec, at(2026, 1, 5));
  assert.equal(out.locked, false);
  assert.equal(out.weightBase, 100);
  assert.equal(out.weightBaseDate, '2026-01-01', '没锁过就不该重置基准，否则等于白送分');
});

test('下限：权重掉到 0 就停住，不会变成负数', () => {
  const rec = diary('2026-01-01');
  // 100 天正好归零
  const zero = computeWeight({ ...rec, now: at(2026, 4, 11) });
  assert.equal(zero.weight, 0);
  assert.equal(zero.faded, true, '归零即「忘干净」');

  // 再放一年还是 0，不可能是负数
  const muchLater = computeWeight({ ...rec, now: at(2027, 4, 11) });
  assert.equal(muchLater.weight, 0);
  assert.ok(muchLater.weight >= 0);
  assert.equal(muchLater.faded, true);
});

test('上限：基准超过 100 时被夹到 100（数据写坏了也不该出现 120 分）', () => {
  const rec = diary('2026-01-01', { weightBase: 120 });
  assert.equal(computeWeight({ ...rec, now: at(2026, 1, 1) }).weight, 100);
});

test('容错：缺少基准日期时按「今天刚写下」算，权重不跳水', () => {
  const r = computeWeight({ weightBase: 100, now: at(2026, 5, 1) });
  assert.equal(r.weight, 100);
  assert.equal(r.daysElapsed, 0);
});

test('容错：日期键非法时抛带 code 的错，而不是静默算出 NaN', () => {
  assert.throws(() => daysBetween('2026/01/01', '2026-01-02'), (e) => e.code === 'E4041');
  assert.throws(() => daysBetween('2026-1-1', '2026-01-02'), (e) => e.code === 'E4041', '必须两位补零');
  assert.throws(() => daysBetween('2026-02-30', '2026-03-01'), (e) => e.code === 'E4041', '2-30 不存在，不能进位成 3-2');
  assert.throws(() => localDateKey(Number.NaN), (e) => e.code === 'E4041');
});

test('阈值：shouldIncludeInContext 口径是 weight >= min（等于阈值要带）', () => {
  assert.equal(shouldIncludeInContext(80, 80), true, '等于阈值必须带进上下文');
  assert.equal(shouldIncludeInContext(79, 80), false);
  assert.equal(shouldIncludeInContext(81, 80), true);

  // 缺省阈值 0：没配阈值就全带，不能理解成「全屏蔽」
  assert.equal(shouldIncludeInContext(0), true);
  assert.equal(shouldIncludeInContext(100), true);

  // weight 坏掉时当 0 处理：阈值 0 带、阈值 1 不带，绝不产生 NaN 比较
  assert.equal(shouldIncludeInContext(Number.NaN, 0), true);
  assert.equal(shouldIncludeInContext(undefined, 1), false);
});

test('阈值：isHidden 口径是 weight < hiddenBelow（等于阈值仍可见）', () => {
  assert.equal(isHidden(10, 10), false, '等于阈值仍然可见');
  assert.equal(isHidden(9, 10), true);
  assert.equal(isHidden(11, 10), false);

  // 缺省阈值 0：没配就什么都不藏
  assert.equal(isHidden(0), false);
  assert.equal(isHidden(100), false);

  assert.equal(isHidden(Number.NaN, 1), true, '坏值当 0：阈值 1 时藏起来');
});

test('阈值：两个口径互补，同一阈值下不会出现「藏起来却进了上下文」', () => {
  const w = 10;
  const min = 10;
  const below = 10;
  assert.equal(shouldIncludeInContext(w, min) && isHidden(w, below), false);
  assert.equal(shouldIncludeInContext(w, min), true);
  assert.equal(isHidden(w, below), false);
});

test('端到端：写下 → 衰减 → 锁定 → 解锁 → 归零', () => {
  let rec = diary('2026-01-01');

  // 过了 20 天（1-01 → 1-21）：80 分
  assert.equal(computeWeight({ ...rec, now: at(2026, 1, 21) }).weight, 80);

  // 1-21 锁住，放 100 天到 5-01，一分不掉
  rec = lockDiary(rec, at(2026, 1, 21));
  assert.equal(computeWeight({ ...rec, now: at(2026, 5, 1) }).weight, 80);
  assert.equal(computeWeight({ ...rec, now: at(2026, 5, 1) }).daysElapsed, 100, '锁了整整 100 天');

  // 5-01 解锁，从 80 分重新开始（不是 80 - 100 天 = 0）
  rec = unlockDiary(rec, at(2026, 5, 1));
  assert.equal(computeWeight({ ...rec, now: at(2026, 5, 1) }).weight, 80);

  // 再放 80 天（5-01 → 7-20）归零
  assert.equal(computeWeight({ ...rec, now: at(2026, 7, 19) }).weight, 1, '归零前一天还剩 1 分');
  assert.equal(computeWeight({ ...rec, now: at(2026, 7, 20) }).weight, 0);
  assert.equal(isHidden(computeWeight({ ...rec, now: at(2026, 7, 20) }).weight, 1), true);
});
