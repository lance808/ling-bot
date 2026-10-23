/**
 * 唤醒硬限的「0 = 不限」语义 —— F19
 *
 * ## 为什么单独守这一条
 *
 * `maxWakePerMinute` / `maxWakePerHour` 的 0 有**两种可能的解释**，
 * 而它们的后果完全相反：
 *
 *   0 = 一次都不许   → 用户清成 0 之后机器人彻底不说话
 *   0 = 不限制       → 用户清成 0 之后机器人不再受频率约束
 *
 * 用户已明确确认采用**后者**。
 *
 * 这个区别必须用测试钉死，因为两种实现对"限流器"内部逻辑的写法
 * 几乎一样（都是 `if (count >= limit) reject`），差别只在
 * 是否有一个 `if (limit <= 0) return ok` 的提前返回。
 * 少写那三行不会报错，只会在用户清空输入框时让机器人彻底哑掉 ——
 * 而用户不会联想到"是我把上限设成 0 导致的"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WakeLedger } from '../src/llm/triggers.mjs';

/* ------------------------------------------------------------ 0 = 不限 */

test('★ maxPerMinute = 0 表示不限制，不是"一次都不许"', () => {
  const ledger = new WakeLedger();
  // 连续 50 次都该放行
  for (let i = 0; i < 50; i++) {
    const r = ledger.check('group:1', { maxPerMinute: 0, maxPerHour: 0 });
    assert.equal(r.ok, true, `第 ${i + 1} 次不该被拦`);
    ledger.note('group:1');
  }
});

test('★ maxPerHour = 0 表示不限制', () => {
  const ledger = new WakeLedger();
  for (let i = 0; i < 120; i++) {
    const r = ledger.check('group:1', { maxPerMinute: 0, maxPerHour: 0 });
    assert.equal(r.ok, true, `第 ${i + 1} 次不该被拦`);
    ledger.note('group:1');
  }
});

test('两者都为 0：完全不限', () => {
  const ledger = new WakeLedger();
  for (let i = 0; i < 200; i++) ledger.note('group:1');
  const r = ledger.check('group:1', { maxPerMinute: 0, maxPerHour: 0 });
  assert.equal(r.ok, true);
});

/* ------------------------------------------------------------ 非 0 仍然生效 */

test('★ 非 0 时仍然真的会拦（确认"不限"没有把限制整体关掉）', () => {
  /*
   * 这条是上面几条的反向保险：如果实现里不小心写成
   * "永远 return ok"，上面全绿但功能已死。
   */
  const ledger = new WakeLedger();
  const cfg = { maxPerMinute: 2, maxPerHour: 100 };

  assert.equal(ledger.check('group:1', cfg).ok, true);
  ledger.note('group:1');
  assert.equal(ledger.check('group:1', cfg).ok, true);
  ledger.note('group:1');

  const third = ledger.check('group:1', cfg);
  assert.equal(third.ok, false, '第 3 次应被每分钟上限拦下');
  assert.ok(third.retryAfterMs > 0, '应该给出还要等多久');
});

test('计数按会话隔离：一个会话的用量不影响另一个', () => {
  const ledger = new WakeLedger();
  const cfg = { maxPerMinute: 1, maxPerHour: 10 };

  ledger.note('group:1');
  assert.equal(ledger.check('group:1', cfg).ok, false, 'group:1 已用完');
  assert.equal(ledger.check('group:2', cfg).ok, true, 'group:2 不受影响');
});

test('滑出窗口后恢复额度', () => {
  /*
   * 用滑动窗口而不是固定桶：固定桶在分钟交界处会瞬间放行两倍数量。
   *
   * 这里不注入时钟（WakeLedger 用自己的时间），所以只验证
   * 「额度用完 → 报 retryAfterMs → 那个值是合理的」这条链。
   */
  const ledger = new WakeLedger();
  const cfg = { maxPerMinute: 3, maxPerHour: 100 };
  for (let i = 0; i < 3; i++) ledger.note('group:1');
  const r = ledger.check('group:1', cfg);
  assert.equal(r.ok, false);
  assert.ok(r.retryAfterMs > 0 && r.retryAfterMs <= 60_000, `retryAfterMs 应在 1 分钟窗口内，实际 ${r.retryAfterMs}`);
});

/* ------------------------------------------------------------ 与静音无关 */

test('★ 频率硬限读的是 wake 配置，与静音是两套东西', () => {
  /*
   * 静音管"现在不许说话"，频率硬限管"说得太频繁了"。
   * 两者独立：静音关掉之后，频率额度不会因为静音期间没用过就暴涨，
   * 反过来静音也不会因为频率额度还剩很多就不生效。
   *
   * 这里只确认接口分层：WakeLedger 单独构造，不依赖任何 silence 状态。
   */
  const ledger = new WakeLedger();
  assert.equal(ledger.check('group:1', { maxPerMinute: 1, maxPerHour: 1 }).ok, true);
  // 没有传 silence 相关字段，照样工作 —— 说明两者确实解耦
});
