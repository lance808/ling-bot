/**
 * 分条发送 —— 每条过闸门、按会话串行、能中止、能报部分失败
 *
 * ## 为什么不测「真的发出去了」
 *
 * 这里注入的 `send` 就是 `index.mjs` 里的那道闸门（白名单 + 审计 + 限流）。
 * 用假的 send 能精确控制"第几条失败、什么时候中止"，而那正是真机上
 * 最难复现的几种情况（限流撞上、用户点停止）。
 *
 * **不向真实 QQ 发任何消息**：整条链路到 `send` 为止，下面没有网络。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sendBurst,
  createSequencer,
  normalizeIntervalMs,
  normalizeMaxMessages,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
} from '../src/reply/send.mjs';
import { MAX_MESSAGES_HARD_CAP } from '../src/reply/split.mjs';

/** 立即返回的假 sleep，并记录每次等了多久 */
function fakeSleep() {
  const waits = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

/** 造一个按脚本返回结果的 send */
function scriptedSend(results = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async send(convKey, text) {
      calls.push({ convKey, text });
      const step = results[Math.min(i, results.length - 1)];
      i += 1;
      if (typeof step === 'function') return step(convKey, text);
      return step ?? { ok: true };
    },
  };
}

/* ------------------------------------------------------------------ 单条 */

test('单条：只发一次，不产生任何间隔', async () => {
  const s = scriptedSend();
  const { waits, sleep } = fakeSleep();
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['就一句'],
    send: s.send,
    sequencer: createSequencer(),
    sleep,
  });

  assert.equal(s.calls.length, 1);
  assert.deepEqual(waits, [], '单条不该等待');
  assert.deepEqual(r.sent, ['就一句']);
  assert.equal(r.ok, true);
  assert.equal(r.failed.length, 0);
  assert.equal(r.aborted, false);
});

test('空列表：一条都不发，且明确返回 ok=false', async () => {
  const s = scriptedSend();
  const r = await sendBurst({ convKey: 'group:1', messages: [], send: s.send, sequencer: createSequencer() });
  assert.equal(s.calls.length, 0);
  assert.equal(r.ok, false);
  assert.equal(r.planned, 0);
});

test('空白消息被过滤掉（不产生空消息被闸门以 E2031 拒绝）', async () => {
  const s = scriptedSend();
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['  ', '有效', '\n'],
    send: s.send,
    sequencer: createSequencer(),
    sleep: async () => {},
  });
  assert.deepEqual(s.calls.map((c) => c.text), ['有效']);
  assert.equal(r.planned, 1);
});

/* ------------------------------------------------------------------ 多条 */

test('★ 多条：按顺序逐条发，条间各等一次间隔', async () => {
  const s = scriptedSend();
  const { waits, sleep } = fakeSleep();
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['一', '二', '三'],
    send: s.send,
    sequencer: createSequencer(),
    sleep,
    intervalMs: 600,
  });

  assert.deepEqual(s.calls.map((c) => c.text), ['一', '二', '三'], '顺序必须与数组一致');
  assert.deepEqual(waits, [600, 600], '三条之间两次等待');
  assert.equal(r.sent.length, 3);
  assert.equal(r.ok, true);
});

test('超上限：只发前 maxMessages 条（内容不丢是拆分层的责任，这里只管条数）', async () => {
  const s = scriptedSend();
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['1', '2', '3', '4', '5'],
    send: s.send,
    sequencer: createSequencer(),
    sleep: async () => {},
    maxMessages: 3,
  });
  assert.equal(s.calls.length, 3);
  assert.equal(r.planned, 3);
});

test('maxMessages 非法值被夹进合法区间（不会发出 0 条或海量条）', async () => {
  for (const bad of [0, -5, NaN, 'x', null]) {
    const s = scriptedSend();
    const r = await sendBurst({
      convKey: 'k',
      messages: Array.from({ length: 20 }, (_, i) => `m${i}`),
      send: s.send,
      sequencer: createSequencer(),
      sleep: async () => {},
      maxMessages: /** @type {any} */ (bad),
    });
    const n = normalizeMaxMessages(bad);
    assert.equal(s.calls.length, Math.min(20, n));
    assert.ok(r.sent.length >= 1, '至少要发出去一条');
  }
});

/* ------------------------------------------------------------ 部分失败 */

test('★ 中间一条失败：其余照发，失败项被如实报出', async () => {
  /*
   * 关键语义：一条失败**不能**让后面的全不发。
   * 现实里的失败（限流、上游抖动）通常是瞬时的，用户宁可看到
   * "第二句没出来"也不愿意整段消失。
   */
  const s = scriptedSend([{ ok: true }, { ok: false, code: 'E2030', message: '发送过快' }, { ok: true }]);
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['一', '二', '三'],
    send: s.send,
    sequencer: createSequencer(),
    sleep: async () => {},
  });

  assert.equal(s.calls.length, 3, '失败也要继续把后面的发完');
  assert.deepEqual(r.sent, ['一', '三']);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].index, 1);
  assert.equal(r.failed[0].text, '二');
  assert.equal(r.failed[0].code, 'E2030');
  assert.equal(r.ok, true, '有发出去的就算这一回合有效');
});

test('★ 全部失败：ok=false，并能带回第一个错误码', async () => {
  const s = scriptedSend([{ ok: false, code: 'E20XX', message: '不在白名单' }]);
  const r = await sendBurst({
    convKey: 'group:9',
    messages: ['一', '二'],
    send: s.send,
    sequencer: createSequencer(),
    sleep: async () => {},
  });

  assert.equal(r.ok, false);
  assert.deepEqual(r.sent, []);
  assert.equal(r.failed.length, 2);
  assert.equal(r.failed[0].code, 'E20XX');
});

test('send 抛异常也被当成"这条失败"，不拖垮整批', async () => {
  const s = scriptedSend([
    () => {
      throw Object.assign(new Error('上游炸了'), { code: 'E1001' });
    },
    { ok: true },
  ]);
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['一', '二'],
    send: s.send,
    sequencer: createSequencer(),
    sleep: async () => {},
  });
  assert.deepEqual(r.sent, ['二']);
  assert.equal(r.failed[0].code, 'E1001');
  assert.equal(r.ok, true);
});

/* -------------------------------------------------------------- 中止 */

test('★ 发送前就已中止：一条都不发', async () => {
  const controller = new AbortController();
  controller.abort();
  const s = scriptedSend();
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['一', '二'],
    send: s.send,
    sequencer: createSequencer(),
    signal: controller.signal,
    sleep: async () => {},
  });
  assert.equal(s.calls.length, 0);
  assert.equal(r.aborted, true);
  assert.equal(r.ok, false);
});

test('★ 发完第一条后中止：只发出第一条，后面的不再发', async () => {
  /*
   * 中止检查必须放在**每条发送之前**。只查一次的话，用户在间隔里
   * 点了停止，后面几条还是会依次冒出来——那也是"点了没反应"。
   */
  const controller = new AbortController();
  const s = scriptedSend([
    () => {
      controller.abort();
      return { ok: true };
    },
  ]);
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['一', '二', '三'],
    send: s.send,
    sequencer: createSequencer(),
    signal: controller.signal,
    sleep: async () => {},
  });

  assert.deepEqual(r.sent, ['一']);
  assert.equal(s.calls.length, 1, '中止后不能再发');
  assert.equal(r.aborted, true);
  assert.equal(r.ok, true, '已经发出去的那条不能算没发');
});

test('间隔期间中止：等待立刻结束，不再发下一条', async () => {
  const controller = new AbortController();
  const s = scriptedSend();
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['一', '二'],
    send: s.send,
    sequencer: createSequencer(),
    signal: controller.signal,
    // 模拟"等待中收到中止"：sleep 里直接 abort 并立即返回
    sleep: async () => {
      controller.abort();
    },
  });
  assert.equal(s.calls.length, 1, '中止发生在间隔里，第二条不该发出');
  assert.equal(r.aborted, true);
});

/* --------------------------------------------------------- 发送顺序 */

test('★ 同一会话两个回合：绝不交错（A1 A2 B1 B2，不是 A1 B1 A2 B2）', async () => {
  /*
   * 这是要求 5 的核心。两个回合几乎同时结束（群里被连问两句）时，
   * 若各自 await 自己那几条，网络调度会把它们穿插成 A1 B1 A2 B2 ——
   * 读起来像两个人在抢话。
   */
  const sequencer = createSequencer();
  /** @type {string[]} */
  const order = [];

  const makeSend = (tag) => async (convKey, text) => {
    // 模拟真实发送有耗时，让"如果不串行就会交错"这件事真的有机会发生
    await new Promise((r) => setTimeout(r, 1));
    order.push(`${tag}${text}`);
    return { ok: true };
  };

  const turnA = sendBurst({
    convKey: 'group:1',
    messages: ['1', '2', '3'],
    send: makeSend('A'),
    sequencer,
    sleep: async () => {},
  });
  const turnB = sendBurst({
    convKey: 'group:1',
    messages: ['1', '2', '3'],
    send: makeSend('B'),
    sequencer,
    sleep: async () => {},
  });

  await Promise.all([turnA, turnB]);

  assert.deepEqual(order, ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'], `实际顺序：${order.join(' ')}`);
});

test('不同会话不互相排队（隔离）', async () => {
  const sequencer = createSequencer();
  const order = [];
  const makeSend = (tag) => async () => {
    await new Promise((r) => setTimeout(r, 1));
    order.push(tag);
    return { ok: true };
  };

  await Promise.all([
    sendBurst({ convKey: 'group:1', messages: ['x', 'y'], send: makeSend('A'), sequencer, sleep: async () => {} }),
    sendBurst({ convKey: 'group:2', messages: ['x', 'y'], send: makeSend('B'), sequencer, sleep: async () => {} }),
  ]);

  // 两个会话各自保序；整体交替是允许的（它们本来就不该互相等）
  assert.deepEqual(order.filter((x) => x.startsWith('A')), ['A', 'A']);
  assert.deepEqual(order.filter((x) => x.startsWith('B')), ['B', 'B']);
});

test('★ 前一个回合发送失败不会卡死后续（链不能断）', async () => {
  const sequencer = createSequencer();
  const calls = [];

  const first = sendBurst({
    convKey: 'group:1',
    messages: ['一'],
    send: async () => {
      calls.push('first');
      throw new Error('上游挂了');
    },
    sequencer,
    sleep: async () => {},
  });

  const second = sendBurst({
    convKey: 'group:1',
    messages: ['二'],
    send: async (k, t) => {
      calls.push(t);
      return { ok: true };
    },
    sequencer,
    sleep: async () => {},
  });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, false);
  assert.deepEqual(b.sent, ['二'], '后来的消息必须还能发出去');
  assert.deepEqual(calls, ['first', '二']);
});

/* ---------------------------------------------------------- 参数校验 */

test('间隔归一：非法值回落默认，越界被夹到硬边界', () => {
  assert.equal(normalizeIntervalMs(undefined), DEFAULT_INTERVAL_MS);
  assert.equal(normalizeIntervalMs('abc'), DEFAULT_INTERVAL_MS);
  assert.equal(normalizeIntervalMs(1), MIN_INTERVAL_MS, '太短没意义（QQ 会合并显示）');
  assert.equal(normalizeIntervalMs(999_999), MAX_INTERVAL_MS, '太长像消息丢了');
  assert.equal(normalizeIntervalMs(800), 800);
});

test('条数归一：硬上限真的挡得住', () => {
  assert.equal(normalizeMaxMessages(100), MAX_MESSAGES_HARD_CAP);
  assert.equal(normalizeMaxMessages(0), 1);
  assert.equal(normalizeMaxMessages('x'), 3, '非法值回落默认 3');
  assert.equal(normalizeMaxMessages(3), 3);
});

test('没有 send 函数时立刻抛 TypeError（接线错误不该静默吞掉）', async () => {
  await assert.rejects(
    () => sendBurst({ convKey: 'group:1', messages: ['x'], send: null }),
    (err) => err instanceof TypeError,
  );
});
