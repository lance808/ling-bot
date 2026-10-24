/**
 * 分条回复与**其它发送者**在同一会话里的顺序（跨功能冲突）
 *
 * ## 为什么要单独测这件事
 *
 * 分条发送的"顺序"不只由 `sendBurst` 决定：同一个会话里还有别的发送者 ——
 * 表情（`ctx.gateway.sendFace`）、生图后台投递（`ctx.deliverMedia`）、
 * 插件聊天（`ctx.chat.send` / `ctx.sendText`）。它们各自都是一条完整的 QQ 消息。
 *
 * 如果它们不共用同一个串行器，就会出现：
 *
 *     A1  A2  B1（插件插进来）  A3      ← 读起来像有人抢话
 *
 * 所以契约（docs/reply-split-protocol.md §5 不变量 2 与 docs/plugin-api.md §5.3.1）
 * 要求"同一会话严格串行"。这里用真实计时器把三种发送者逐个排进同一条回复中间，
 * 验证它们要么排队，要么根本不发。
 *
 * ## 这几条用例的性质：回归守卫
 *
 * `ctx.chat.send` / `ctx.chat.sendMedia` 曾经**没有**接进共享串行器，
 * 实测顺序是 `A1 B1-tool A2 A3`（工具发的文字插进气泡中间）。
 * 宿主接线修好之后，这几条用例就是那个回归的唯一自动化守卫：
 * 只要 `sequencer` 被从聊天工厂里摘掉，它们会立刻变红。
 *
 * 仍未接进队列的是插件的 `ctx.sendText`（`manager.mjs` 的 `sendText: this.sendText`
 * → `index.mjs:895`），那条通路不在本文件的桩覆盖范围内 ——
 * 已在 `.verify/reply-review.md` §3.2 记为剩余缺口并给出补丁。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSequencer, sendBurst } from '../src/reply/send.mjs';
import { createMediaDelivery } from '../src/plugins/delivery.mjs';
import { createChatFactory } from '../src/plugins/host-chat.mjs';

/** 可被 abort 打断的等待（与 send.mjs 的 defaultSleep 同语义） */
const signalSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });

/**
 * 造一个记录落地顺序的发送通路。
 *
 * @param {string[]} order
 * @param {number} [delayMs]
 */
const makeSender = (order, delayMs = 2) => async ({ convKey, auditText }) => {
  await signalSleep(delayMs);
  order.push(auditText);
  return { ok: true, messageId: order.length };
};

/** 造一个带三帧的分条回复 */
const burstOf = (sequencer, order, convKey = 'group:1') =>
  sendBurst({
    convKey,
    messages: ['A1', 'A2', 'A3'],
    send: async (k, t) => makeSender(order)({ convKey: k, auditText: t }),
    sequencer,
    intervalMs: 120,
    sleep: signalSleep,
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建一个临时插件数据目录 + 一个可投递的文件 */
async function tempPluginDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-reply-media-'));
  const file = path.join(root, 'pic.png');
  await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { root, file };
}

/* ------------------------------------------------- 生图后台投递（共享队列） */

test('★ 后台媒体投递排在分条回复之后，不插进气泡中间', async () => {
  const { root } = await tempPluginDir();
  const sequencer = createSequencer();
  /** @type {string[]} */
  const order = [];
  const deliver = createMediaDelivery({ sendSegments: makeSender(order), sequencer });

  const burst = burstOf(sequencer, order);
  await wait(60); // 落在 A1 之后、A2 之前
  const r = await deliver({
    pluginId: 'p',
    dataDir: root,
    convKey: 'group:1',
    path: 'pic.png',
    kind: 'image',
    auditText: 'B1-media',
  });
  await burst;

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(order, ['A1', 'A2', 'A3', 'B1-media'], `实际顺序：${order.join(' ')}`);
});

test('跨会话的后台投递不受另一个会话的回复阻塞', async () => {
  const { root } = await tempPluginDir();
  const sequencer = createSequencer();
  /** @type {string[]} */
  const order = [];
  const deliver = createMediaDelivery({ sendSegments: makeSender(order), sequencer });

  const burst = burstOf(sequencer, order, 'group:1');
  await wait(40);
  const r = await deliver({
    pluginId: 'p',
    dataDir: root,
    convKey: 'group:2',
    path: 'pic.png',
    kind: 'image',
    auditText: 'other-conv',
  });
  await burst;

  assert.equal(r.ok, true);
  // 另一个会话不该排在 A3 之后（它有自己的链）
  const at = order.indexOf('other-conv');
  assert.ok(at >= 0 && at < order.indexOf('A3'), `实际顺序：${order.join(' ')}`);
});

/* ------------------------------------------------------- 取消 / 闸门拒绝 */

test('★ 排队等回复发完时被取消 → 一条都不发，返回 E4070', async () => {
  const { root } = await tempPluginDir();
  const sequencer = createSequencer();
  /** @type {string[]} */
  const order = [];
  const deliver = createMediaDelivery({ sendSegments: makeSender(order), sequencer });
  const controller = new AbortController();

  const burst = burstOf(sequencer, order);
  const pending = deliver({
    pluginId: 'p',
    dataDir: root,
    convKey: 'group:1',
    path: 'pic.png',
    kind: 'image',
    auditText: 'B1-media',
    signal: controller.signal,
  });

  await wait(60);
  controller.abort();
  const [r] = await Promise.all([pending, burst]);

  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4070');
  assert.deepEqual(order, ['A1', 'A2', 'A3'], `取消后不该多出一条：${order.join(' ')}`);
});

test('被发送闸门拒绝时：原样带回 code，不抛异常', async () => {
  const { root } = await tempPluginDir();
  /** @type {string[]} */
  const order = [];
  const deliver = createMediaDelivery({
    sendSegments: async () => ({ ok: false, code: 'E2030', message: '发送过快' }),
    sequencer: createSequencer(),
  });

  const r = await deliver({
    pluginId: 'p',
    dataDir: root,
    convKey: 'group:1',
    path: 'pic.png',
    kind: 'image',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E2030');
  assert.equal(order.length, 0);
});

test('目标会话非法时立刻拒绝，不去碰发送通路', async () => {
  const { root } = await tempPluginDir();
  let touched = 0;
  const deliver = createMediaDelivery({
    sendSegments: async () => {
      touched += 1;
      return { ok: true };
    },
    sequencer: createSequencer(),
  });

  for (const convKey of ['', 'group:', 'not-a-conv', 'group:abc']) {
    const r = await deliver({ pluginId: 'p', dataDir: root, convKey, path: 'pic.png', kind: 'image' });
    assert.equal(r.ok, false, convKey);
    assert.equal(r.code, 'E4074', convKey);
  }
  assert.equal(touched, 0);
});

/* ---------------------------------------------- 插件聊天（★ 已知缺口） */

test('★ ctx.chat.send（工具发的文字）排在分条回复之后，不插进气泡中间', async () => {
  /*
   * 宿主把同一个 `replySequencer` 同时交给分条发送与 `createChatFactory`
   * （见 src/index.mjs 的 replySequencer → PluginManager → 聊天工厂），
   * 所以工具发的文字必须排在整段回复之后，而不是落在 A1/A2 之间。
   *
   * 这条用例在接线缺失时会失败（实测过 `A1 B1-tool A2 A3`），
   * 因此它同时是"接线还在"的回归守卫。
   */
  const sequencer = createSequencer();
  /** @type {string[]} */
  const order = [];
  const sendSegments = makeSender(order);
  const { makeChat } = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: () => ({ ok: false }),
    sendSegments,
    sequencer,
  });
  const chat = makeChat({ pluginId: 'p', invocation: { convKey: 'group:1' } });

  const burst = burstOf(sequencer, order);
  await wait(60); // 落在 A1 之后、A2 之前
  await chat.send({ text: 'B1-tool' });
  await burst;

  assert.deepEqual(order, ['A1', 'A2', 'A3', 'B1-tool'], `实际顺序：${order.join(' ')}`);
});

test('★ ctx.chat.sendMedia（工具发的图）同样排在分条回复之后', async () => {
  const { root } = await tempPluginDir();
  const sequencer = createSequencer();
  /** @type {string[]} */
  const order = [];
  const sendSegments = makeSender(order);
  const { makeChat } = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: () => ({ ok: false }),
    sendSegments,
    sequencer,
  });
  const chat = makeChat({ pluginId: 'p', invocation: { convKey: 'group:1' }, dataDir: root });

  const reg = await chat.registerMedia({ path: 'pic.png', kind: 'image' });
  assert.equal(reg.ok, true, JSON.stringify(reg));

  const burst = burstOf(sequencer, order);
  await wait(60);
  const sent = await chat.sendMedia({ handles: [reg.handle] });
  await burst;

  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.deepEqual(order, ['A1', 'A2', 'A3', '[image] pic.png'], `实际顺序：${order.join(' ')}`);
});

test('取消后排队中的 ctx.chat.send 一条都不发', async () => {
  const sequencer = createSequencer();
  /** @type {string[]} */
  const order = [];
  const sendSegments = makeSender(order);
  const { makeChat } = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: () => ({ ok: false }),
    sendSegments,
    sequencer,
  });
  const controller = new AbortController();
  const chat = makeChat({ pluginId: 'p', invocation: { convKey: 'group:1' }, signal: controller.signal });

  const burst = burstOf(sequencer, order);
  await wait(60);
  const pending = chat.send({ text: 'B1-tool' });
  controller.abort();
  const [r] = await Promise.all([pending, burst]);

  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4070');
  assert.deepEqual(order, ['A1', 'A2', 'A3'], `取消后不该多出一条：${order.join(' ')}`);
});
