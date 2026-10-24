/**
 * 一个回合的回复怎么落地：拆分 → 逐条发 → 记账
 *
 * ## 这个文件守的是「记账」那三条要求
 *
 *   1. 历史只记真正成功发出的内容（被限流的不能进上下文）
 *   2. 不能重复记账（一次回复不是一个回合记三次）
 *   3. 主动回合只记一次（否则 30 分钟间隔护栏会被一次回复打穿）
 *
 * 这三条都不会抛异常：错了只会让下一轮模型重复自己、或让主动发言变密。
 * 所以必须用断言钉住 —— 靠肉眼 review 是看不出来的。
 *
 * 全程注入假 send，**不向真实 QQ 发任何消息**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deliverReply, attachNotice } from '../src/reply/deliver.mjs';
import { createSequencer } from '../src/reply/send.mjs';
import { SPLIT_FENCE_LANG } from '../src/reply/split.mjs';

/** 造一个分条块 */
const block = (items) => ['```' + SPLIT_FENCE_LANG, JSON.stringify(items), '```'].join('\n');

/** 立即返回的假 sleep */
const noSleep = async () => {};

/**
 * 跑一次 deliverReply，并收集记账调用。
 *
 * @param {object} opts
 */
async function run(opts) {
  /** @type {string[]} */
  const sentToHistory = [];
  let delivered = 0;
  /** @type {Array<{convKey: string, text: string}>} */
  const calls = [];

  let i = 0;
  const results = opts.results ?? [];
  const r = await deliverReply({
    convKey: opts.convKey ?? 'group:1',
    text: opts.text ?? '',
    notice: opts.notice ?? null,
    config: opts.config ?? { splitEnabled: true, maxMessages: 3, intervalMs: 800 },
    sequencer: opts.sequencer ?? createSequencer(),
    signal: opts.signal,
    sleep: opts.sleep ?? noSleep,
    async send(convKey, text) {
      calls.push({ convKey, text });
      const step = results[Math.min(i, results.length - 1)];
      i += 1;
      if (typeof step === 'function') return step(convKey, text);
      return step ?? { ok: true };
    },
    onSent: (text) => sentToHistory.push(text),
    onDelivered: () => {
      delivered += 1;
    },
  });

  return { r, calls, sentToHistory, delivered };
}

/* ------------------------------------------------------------------ 单条 */

test('普通文本：一条消息，历史记一条，回合记一次', async () => {
  const { r, calls, sentToHistory, delivered } = await run({ text: '好，我知道了。' });
  assert.equal(calls.length, 1);
  assert.deepEqual(sentToHistory, ['好，我知道了。']);
  assert.equal(delivered, 1);
  assert.equal(r.splitMode, 'plain');
  assert.equal(r.ok, true);
});

/* ------------------------------------------------------------------ 多条 */

test('★ 分条：三条各发一次，历史记三条，但回合只记一次', async () => {
  const { r, calls, sentToHistory, delivered } = await run({
    text: block(['第一句。', '第二句。', '第三句。']),
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.text), ['第一句。', '第二句。', '第三句。']);
  assert.deepEqual(sentToHistory, ['第一句。', '第二句。', '第三句。'], '每条都要进上下文');
  assert.equal(delivered, 1, '一次回复 = 一个回合，不是三个');
  assert.equal(r.splitMode, 'structured');
});

test('普通换行仍然只发一条（不按换行拆）', async () => {
  const text = '第一段。\n\n第二段。';
  const { calls } = await run({ text });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, text);
});

/* -------------------------------------------------------------- 触顶说明 */

test('★ 触顶说明挂在最后一条上，不单独占一个气泡', async () => {
  const { calls } = await run({
    text: block(['第一条。', '第二条。']),
    notice: '（工具调用已达上限：8 步 / 30 秒，我先停在这里。）',
  });

  assert.equal(calls.length, 2, '说明不能变成第三条');
  assert.equal(calls[1].text.startsWith('第二条。'), true);
  assert.match(calls[1].text, /已达上限/);
});

test('只有触顶说明、没有正文时，说明本身就是要发的内容', async () => {
  const { r, calls } = await run({ text: '', notice: '（这一轮处理超时了，先停在这里。）' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /超时/);
  assert.equal(r.ok, true);
});

test('attachNotice：空列表补成一条，正常列表拼在末尾', () => {
  assert.deepEqual(attachNotice([], 'n'), ['n']);
  assert.deepEqual(attachNotice(['a', 'b'], 'n'), ['a', 'b\nn']);
  assert.deepEqual(attachNotice(['a'], null), ['a']);
});

/* ------------------------------------------------------------ 部分失败 */

test('★ 中间一条被限流：历史里不能有它（否则下一轮它会以为自己说过）', async () => {
  const { r, calls, sentToHistory, delivered } = await run({
    text: block(['一', '二', '三']),
    results: [{ ok: true }, { ok: false, code: 'E2030', message: '发送过快' }, { ok: true }],
  });

  assert.equal(calls.length, 3, '失败不该让后面的停发');
  assert.deepEqual(sentToHistory, ['一', '三'], '失败的那条不进历史');
  assert.equal(delivered, 1, '只要发出去过，回合计数照记一次');
  assert.equal(r.sent.length, 2);
  assert.equal(r.failed.length, 1);
  assert.equal(r.ok, true);
});

test('★ 全部失败：历史为空，回合计数一次都不记', async () => {
  const { r, sentToHistory, delivered } = await run({
    text: block(['一', '二']),
    results: [{ ok: false, code: 'E20XX', message: '不在白名单' }],
  });

  assert.deepEqual(sentToHistory, [], '一条都没发出去，历史必须干净');
  assert.equal(delivered, 0, '没发出去就不是一个成功回合');
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 2);
});

/* -------------------------------------------------------------- 中止 */

test('★ 中止：已经发出的进历史，没发的不进，且不再多发', async () => {
  const controller = new AbortController();
  const { r, calls, sentToHistory, delivered } = await run({
    text: block(['一', '二', '三']),
    results: [
      () => {
        controller.abort();
        return { ok: true };
      },
    ],
    signal: controller.signal,
  });

  assert.equal(calls.length, 1, '中止后不能再发');
  assert.deepEqual(sentToHistory, ['一']);
  assert.equal(delivered, 1);
  assert.equal(r.aborted, true);
  assert.equal(r.ok, true, '已经发出去的那条不能算没发');
});

test('一开始就中止：什么都不发，什么都不记', async () => {
  const controller = new AbortController();
  controller.abort();
  const { r, calls, sentToHistory, delivered } = await run({
    text: block(['一', '二']),
    signal: controller.signal,
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(sentToHistory, []);
  assert.equal(delivered, 0);
  assert.equal(r.aborted, true);
});

/* -------------------------------------------------------------- 空输入 */

test('空文本且没有说明：什么都不发（empty=true）', async () => {
  const { r, calls, delivered } = await run({ text: '   ' });
  assert.equal(calls.length, 0);
  assert.equal(delivered, 0);
  assert.equal(r.empty, true);
  assert.equal(r.ok, false);
});

/* ---------------------------------------------------------- 配置生效 */

test('关闭分条：即使写了协议块也整条发（历史里也只有一条）', async () => {
  const text = block(['一', '二']);
  const { calls, sentToHistory } = await run({
    text,
    config: { splitEnabled: false, maxMessages: 3, intervalMs: 800 },
  });
  assert.equal(calls.length, 1);
  assert.equal(sentToHistory.length, 1);
  assert.equal(sentToHistory[0].includes(SPLIT_FENCE_LANG), true, '原文照发');
});

test('maxMessages 生效：超出部分并进最后一条，历史条数与实际发送一致', async () => {
  const { calls, sentToHistory } = await run({
    text: block(['一', '二', '三', '四']),
    config: { splitEnabled: true, maxMessages: 2, intervalMs: 800 },
  });
  assert.equal(calls.length, 2);
  assert.equal(sentToHistory.length, 2, '记账条数必须等于实际发出的条数');
  assert.match(sentToHistory[1], /三[\s\S]*四/);
});

/* ------------------------------------------------------------ 发送顺序 */

test('★ 两回合同一会话：记账顺序与发送顺序一致，不交错', async () => {
  /*
   * 记账顺序错了不会报错，但会让上下文里的"他说过什么"顺序错乱 ——
   * 下一轮模型接话时就会对不上。所以这里连记账一起断言。
   */
  const sequencer = createSequencer();
  /** @type {string[]} */
  const sendOrder = [];
  /** @type {string[]} */
  const history = [];

  const makeSend = (tag) => async (convKey, text) => {
    await new Promise((r) => setTimeout(r, 1));
    sendOrder.push(`${tag}${text}`);
    return { ok: true };
  };

  const send = (tag) => async (convKey, text) => makeSend(tag)(convKey, text);

  const jobA = deliverReply({
    convKey: 'group:1',
    text: block(['1', '2']),
    config: { splitEnabled: true, maxMessages: 3, intervalMs: 800 },
    sequencer,
    sleep: noSleep,
    send: send('A'),
    onSent: (t) => history.push(`A${t}`),
    onDelivered: () => {},
  });
  const jobB = deliverReply({
    convKey: 'group:1',
    text: block(['1', '2']),
    config: { splitEnabled: true, maxMessages: 3, intervalMs: 800 },
    sequencer,
    sleep: noSleep,
    send: send('B'),
    onSent: (t) => history.push(`B${t}`),
    onDelivered: () => {},
  });

  await Promise.all([jobA, jobB]);

  assert.deepEqual(sendOrder, ['A1', 'A2', 'B1', 'B2']);
  assert.deepEqual(history, ['A1', 'A2', 'B1', 'B2'], '记账顺序与发送顺序必须一致');
});
