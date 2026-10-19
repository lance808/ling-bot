/**
 * 触发与概率唤醒 —— F7
 *
 * 这组测试守的是「不会变成群里刷存在感的机器人」。
 * 三重护栏任何一条失效，产品就毁了，所以每条都单独测。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRIGGER,
  detectTrigger,
  decideProactive,
  isStrongTrigger,
  TriggerLedger,
} from '../src/llm/triggers.mjs';

const CFG = { probability: 0.1, minIntervalMs: 1_800_000, activeWindowMs: 1_800_000, autoTurnPerMinute: 1 };

/** @param {Partial<object>} over */
function msg(over = {}) {
  return { kind: 'message', isGroup: true, convKey: 'group:1', text: '你好', atSelf: false, ...over };
}

test('触发：私聊/at/名字/关键词各自命中', () => {
  assert.equal(detectTrigger(msg({ isGroup: false, convKey: 'private:1' }))?.trigger, TRIGGER.PRIVATE);
  assert.equal(detectTrigger(msg({ atSelf: true }))?.trigger, TRIGGER.AT);
  assert.equal(detectTrigger(msg({ text: 'Ling 在吗' }), { selfName: 'Ling' })?.trigger, TRIGGER.NAME);
  assert.equal(
    detectTrigger(msg({ text: '今天吃什么' }), { config: { keywords: ['吃什么'] } })?.trigger,
    TRIGGER.KEYWORD,
  );
});

test('触发：普通群聊消息不构成触发', () => {
  assert.equal(detectTrigger(msg({ text: '随便聊聊' }), { selfName: 'Ling' }), null);
});

test('触发：强/弱分类正确（决定排队还是丢弃）', () => {
  assert.equal(isStrongTrigger(TRIGGER.AT), true);
  assert.equal(isStrongTrigger(TRIGGER.NAME), true);
  assert.equal(isStrongTrigger(TRIGGER.PRIVATE), true);
  assert.equal(isStrongTrigger(TRIGGER.KEYWORD), false);
  assert.equal(isStrongTrigger(TRIGGER.PROBABILITY), false);
});

test('护栏 0：私聊永不主动发言（那是骚扰）', () => {
  const r = decideProactive({
    state: { lastHumanAt: Date.now() },
    isGroup: false,
    config: { ...CFG, probability: 1 },
    random: () => 0,
  });
  assert.equal(r, null);
});

test('护栏 1：冷群不开口（最近 30 分钟没真人说话）', () => {
  const now = 10_000_000;
  // 从没说过话
  assert.equal(decideProactive({ state: {}, isGroup: true, config: { ...CFG, probability: 1 }, now, random: () => 0 }), null);
  // 31 分钟前说过 —— 已冷
  assert.equal(
    decideProactive({
      state: { lastHumanAt: now - 31 * 60_000 },
      isGroup: true,
      config: { ...CFG, probability: 1 },
      now,
      random: () => 0,
    }),
    null,
  );
  // 29 分钟前说过 —— 还热
  assert.ok(
    decideProactive({
      state: { lastHumanAt: now - 29 * 60_000 },
      isGroup: true,
      config: { ...CFG, probability: 1 },
      now,
      random: () => 0,
    }),
  );
});

test('护栏 2：两次主动发言间隔 ≥ 30 分钟（硬下限，不看概率）', () => {
  const now = 10_000_000;
  const hot = { lastHumanAt: now - 60_000 };

  // 10 分钟前才主动说过 —— 即使概率 1 也不许
  assert.equal(
    decideProactive({
      state: { ...hot, lastProactiveAt: now - 10 * 60_000 },
      isGroup: true,
      config: { ...CFG, probability: 1 },
      now,
      random: () => 0,
    }),
    null,
  );

  // 31 分钟前说过 —— 可以
  assert.ok(
    decideProactive({
      state: { ...hot, lastProactiveAt: now - 31 * 60_000, lastAutoTurnAt: now - 31 * 60_000 },
      isGroup: true,
      config: { ...CFG, probability: 1 },
      now,
      random: () => 0,
    }),
  );
});

test('护栏 2 不被概率稀释：probability=0.1 时仍严格受间隔约束', () => {
  const now = 10_000_000;
  // 用 random 恒为 0（必中）来证明：拦住它的是间隔，不是运气
  const blocked = decideProactive({
    state: { lastHumanAt: now - 60_000, lastProactiveAt: now - 5 * 60_000 },
    isGroup: true,
    config: CFG,
    now,
    random: () => 0,
  });
  assert.equal(blocked, null, '间隔不足时必须拦住，且连骰子都不该掷');
});

test('概率：过了护栏才掷骰子，random 高时不触发', () => {
  const now = 10_000_000;
  const state = { lastHumanAt: now - 60_000 };
  assert.ok(decideProactive({ state, isGroup: true, config: CFG, now, random: () => 0.05 }));
  assert.equal(decideProactive({ state, isGroup: true, config: CFG, now, random: () => 0.5 }), null);
});

test('每会话每分钟自动回合上限', () => {
  const now = 10_000_000;
  const r = decideProactive({
    state: { lastHumanAt: now - 60_000, lastAutoTurnAt: now - 10_000 },
    isGroup: true,
    config: { ...CFG, probability: 1 },
    now,
    random: () => 0,
  });
  assert.equal(r, null);
});

test('状态簿：记录真人/主动/自动回合', () => {
  const ledger = new TriggerLedger();
  ledger.noteHuman('group:1', 1000);
  assert.equal(ledger.snapshot('group:1').lastHumanAt, 1000);

  ledger.noteProactive('group:1', 2000);
  const s = ledger.snapshot('group:1');
  assert.equal(s.lastProactiveAt, 2000);
  assert.equal(s.lastAutoTurnAt, 2000, '主动发言同时也是自动回合');

  ledger.clear('group:1');
  assert.equal(ledger.snapshot('group:1').lastHumanAt, null);
});
