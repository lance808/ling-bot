/**
 * 分条发送的**中止**语义 —— 用生产实现里的 defaultSleep，不注入假 sleep
 *
 * ## 为什么单独一个文件
 *
 * `reply-send.test.mjs` 全部注入假 sleep（否则跑一次要好几秒），于是
 * **生产用的那条等待实现**（`defaultSleep`）从来没被真正跑过。
 * 而它守的是「点了停止之后，停在消息边界」：
 *
 *   · 若 abort 时只 clearTimeout 不 resolve，调用方的 await 会永远悬着 ——
 *     表现是"点了停止，回合再也没结束"；
 *   · 若 abort 时直接丢掉 resolve 但循环还往下走，剩下的消息会继续冒出来。
 *
 * 这两种错法都不会抛异常、也不会被断言发现，只会在真机上表现为"停止没用"。
 * 所以这里用真实的计时器把两条都钉住。
 *
 * 不连 QQ、不发任何消息：`send` 是注入的假实现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sendBurst, createSequencer, defaultSleep, DEFAULT_INTERVAL_MS } from '../src/reply/send.mjs';

/**
 * 记录发送序列的假 send。
 *
 * @returns {{calls: string[], send: (convKey: string, text: string) => Promise<{ok: boolean}>}}
 */
function recorder() {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    async send(convKey, text) {
      calls.push(text);
      return { ok: true };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------- defaultSleep */

test('defaultSleep：ms<=0 立即返回（不留一个空转的计时器）', async () => {
  const t0 = Date.now();
  await defaultSleep(0);
  await defaultSleep(-5);
  assert.ok(Date.now() - t0 < 50, '不该真的等');
});

test('defaultSleep：中止时立刻结束等待，而不是把 resolve 丢掉', async () => {
  const controller = new AbortController();
  const t0 = Date.now();
  const waiting = defaultSleep(5_000, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await waiting; // 如果实现把 resolve 丢了，这里会一直挂着，测试超时
  const spent = Date.now() - t0;
  assert.ok(spent < 1_000, `中止后应立刻返回，实际等了 ${spent}ms`);
});

test('defaultSleep：正常到点也会返回（不依赖 abort）', async () => {
  const t0 = Date.now();
  await defaultSleep(30);
  assert.ok(Date.now() - t0 >= 20);
});

/* --------------------------------------------- 真实等待里的中止（★ 核心） */

test('★ 真实 defaultSleep：间隔中中止 → 不再发下一条，且总耗时远小于剩余间隔', async () => {
  const controller = new AbortController();
  const r0 = recorder();

  const t0 = Date.now();
  const job = sendBurst({
    convKey: 'group:1',
    messages: ['一', '二', '三'],
    send: r0.send,
    sequencer: createSequencer(),
    signal: controller.signal,
    intervalMs: 3_000, // 故意很长：中止必须把它打断
    // 不注入 sleep —— 走生产实现
  });
  setTimeout(() => controller.abort(), 80);
  const r = await job;
  const spent = Date.now() - t0;

  assert.deepEqual(r0.calls, ['一'], '中止后不该再发第二条');
  assert.equal(r.aborted, true);
  assert.deepEqual(r.sent, ['一']);
  assert.ok(spent < 2_000, `中止应打断 3s 的间隔，实际耗时 ${spent}ms`);
});

test('★ 中止发生在第一条之前：一条都不发，也不白等一个间隔', async () => {
  const controller = new AbortController();
  controller.abort();
  const r0 = recorder();
  const t0 = Date.now();
  const r = await sendBurst({
    convKey: 'group:1',
    messages: ['一', '二'],
    send: r0.send,
    sequencer: createSequencer(),
    signal: controller.signal,
    intervalMs: 3_000,
  });
  assert.equal(r0.calls.length, 0);
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - t0 < 1_000);
});

test('★ 排队等前一个回合时被中止：轮到它的时候一条都不发', async () => {
  /*
   * 真实场景：群里被连问两句，第二个回合的回复排在第一个后面。
   * 用户在排队期间点了停止 —— 轮到这个回合时，它必须什么都不发。
   *
   * 这条同时验证了"中止检查在每条之前"对**排队者**也成立
   * （检查在循环里，而不是在进队列前判一次）。
   */
  const sequencer = createSequencer();
  const order = [];

  // 先占住队列：第一条发完之后一直等（用一个大 interval 把它拖住）
  const controllerA = new AbortController();
  const first = sendBurst({
    convKey: 'group:1',
    messages: ['A1', 'A2'],
    send: async (k, t) => {
      order.push(t);
      controllerA.abort(); // 发完 A1 就让 A 自己停，但队列此刻仍占着
      return { ok: true };
    },
    sequencer,
    signal: controllerA.signal,
    intervalMs: 3_000,
  });

  // B 排在 A 后面，并且在中止状态下入队
  const controllerB = new AbortController();
  controllerB.abort();
  const second = sendBurst({
    convKey: 'group:1',
    messages: ['B1', 'B2'],
    send: async (k, t) => {
      order.push(t);
      return { ok: true };
    },
    sequencer,
    signal: controllerB.signal,
    intervalMs: 100,
  });

  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(order, ['A1'], '只有 A 的第一条出去了');
  assert.equal(a.aborted, true);
  assert.equal(b.aborted, true);
  assert.deepEqual(b.sent, [], '排队中被中止的回合一条都不能发');
  assert.equal(b.ok, false);
});

/* ------------------------------------------------------------ 间隔归一 */

test('间隔默认值落在文档范围（100–10000ms）内', () => {
  assert.ok(DEFAULT_INTERVAL_MS >= 100 && DEFAULT_INTERVAL_MS <= 10_000);
});

test('真实计时器下：三条消息的总耗时约等于两次间隔（不是并发发出去）', async () => {
  const r0 = recorder();
  const t0 = Date.now();
  const r = await sendBurst({
    convKey: 'group:2',
    messages: ['一', '二', '三'],
    send: r0.send,
    sequencer: createSequencer(),
    intervalMs: 120,
  });
  const spent = Date.now() - t0;
  assert.deepEqual(r0.calls, ['一', '二', '三']);
  assert.equal(r.sent.length, 3);
  // 两次间隔 = 240ms；只校验"确实等了"，不把上限卡得太死（CI 抖动）
  assert.ok(spent >= 180, `应等满两次间隔，实际 ${spent}ms`);
  assert.ok(spent < 3_000, `不能等到超时，实际 ${spent}ms`);
});

/* 保持一个"存在"的引用，避免 lint 说 sleep 未使用 */
void sleep;
