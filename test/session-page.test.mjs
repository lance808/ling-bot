/**
 * 按条读取聊天记录：分页语义 —— F5
 *
 * 「按条读取」听起来简单，但分页边界是最容易出静默错误的地方：
 *
 *   · 翻页时**漏掉**恰好卡在边界的那一条 → 用户看不到某些消息，且毫无提示
 *   · 翻页时**重复**同一条 → 同一条消息出现两次，看起来像发重了
 *   · 非法参数返回空列表 → 被误读成"没有更多了"，用户以为历史就这么多
 *
 * 所以这里断言的重点不是"能翻页"，而是**边界上的那一条到底在哪一页**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { SessionStore } from '../src/session/store.mjs';

async function seeded(count, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-page-'));
  const store = new SessionStore({ filePath: path.join(dir, 'sessions.json'), ...opts });
  for (let i = 1; i <= count; i++) {
    store.append('group:100', {
      messageId: 9000 + i,
      sender: { userId: String(i % 3), nickname: `u${i % 3}` },
      text: `m${i}`,
      time: 1_700_000_000 + i,
    });
  }
  return store;
}

/* --------------------------------------------------------------- 默认页 */

test('默认页取最新一页，楼层升序', async () => {
  const store = await seeded(120);
  const r = store.page('group:100', { limit: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.messages.length, 50);
  assert.deepEqual(r.messages[0].floor, 71);
  assert.deepEqual(r.messages[49].floor, 120);
  // 严格升序，没有重复
  const floors = r.messages.map((m) => m.floor);
  assert.deepEqual(floors, [...floors].sort((a, b) => a - b));
  assert.equal(new Set(floors).size, 50);
});

test('★ 首屏不再是 100 条上限：能翻到第 1 楼', async () => {
  /*
   * 老实现是 `messages.slice(-100)`，第 101 条以前的历史根本拿不到。
   * 这里模拟界面连续向上翻页，直到 hasMore=false，断言能一路翻到 1 楼。
   */
  const store = await seeded(120);
  let cursor = 121; // 从最新之后开始向前
  const seen = [];
  for (let guard = 0; guard < 10; guard++) {
    const r = store.page('group:100', { beforeFloor: cursor, limit: 50 });
    if (r.messages.length === 0) break;
    seen.push(...r.messages.map((m) => m.floor));
    cursor = r.messages[0].floor;
    if (!r.hasMore) break;
  }
  const sorted = seen.sort((a, b) => a - b);
  assert.equal(sorted[0], 1, '必须能翻到第 1 楼');
  assert.equal(sorted[sorted.length - 1], 120);
  assert.equal(new Set(sorted).size, 120, '翻页不能漏、也不能重');
});

/* --------------------------------------------------------- afterFloor */

test('afterFloor 取最早的一页（补读未读）', async () => {
  const store = await seeded(100);
  const r = store.page('group:100', { afterFloor: 40, limit: 10 });
  assert.deepEqual(r.messages.map((m) => m.floor), [41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
  assert.equal(r.hasMore, true);
});

test('★ afterFloor 边界：恰好等于某一楼时不含该楼', async () => {
  // 「读楼层 40」的意思是"40 及之前都读过了"，所以下一页必须从 41 开始
  const store = await seeded(10);
  const r = store.page('group:100', { afterFloor: 5, limit: 3 });
  assert.deepEqual(r.messages.map((m) => m.floor), [6, 7, 8]);
});

test('afterFloor 超过最高楼层时返回空页', async () => {
  const store = await seeded(10);
  const r = store.page('group:100', { afterFloor: 999, limit: 5 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, []);
  assert.equal(r.hasMore, false);
});

test('afterFloor=0 等价于从头读', async () => {
  const store = await seeded(5);
  const r = store.page('group:100', { afterFloor: 0, limit: 3 });
  assert.deepEqual(r.messages.map((m) => m.floor), [1, 2, 3]);
});

/* -------------------------------------------------------- beforeFloor */

test('★ beforeFloor 边界：不含该楼本身', async () => {
  // 向上翻时 beforeFloor 是"当前最早那一楼"，它已经在界面上了，不能再返回一次
  const store = await seeded(20);
  const r = store.page('group:100', { beforeFloor: 11, limit: 5 });
  assert.deepEqual(r.messages.map((m) => m.floor), [6, 7, 8, 9, 10]);
});

test('beforeFloor 小于等于 1 时返回空页且 hasMore=false', async () => {
  const store = await seeded(10);
  const r = store.page('group:100', { beforeFloor: 1, limit: 5 });
  assert.deepEqual(r.messages, []);
  assert.equal(r.hasMore, false);
});

/* ---------------------------------------------------------- 边界组合 */

test('恰好一页：hasMore 必须为 false', async () => {
  const store = await seeded(50);
  const r = store.page('group:100', { limit: 50 });
  assert.equal(r.messages.length, 50);
  assert.equal(r.hasMore, false, '刚好一页时不该说"还有更多"');
});

test('多一条：hasMore 必须为 true', async () => {
  const store = await seeded(51);
  const r = store.page('group:100', { limit: 50 });
  assert.equal(r.messages.length, 50);
  assert.equal(r.hasMore, true);
});

test('空会话返回空列表而不是错误', async () => {
  const store = await seeded(0);
  const r = store.page('group:100', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, []);
  assert.equal(r.hasMore, false);
});

test('完全不存在的会话也返回空列表', async () => {
  const store = await seeded(3);
  const r = store.page('group:999999', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, []);
});

/* ------------------------------------------------------- 非法参数 */

test('★ 非法分页参数返回明确错误码，不静默返回空列表', async () => {
  /*
   * 这条是防"看起来正常"的故障：返回空列表会被界面渲染成
   * "这个会话没有更多消息"，用户永远不会知道是自己传错了参数。
   */
  const store = await seeded(10);
  const cases = [
    { afterFloor: -1 },
    { afterFloor: 1.5 },
    { afterFloor: Number.NaN },
    { afterFloor: '5' },
    { afterFloor: Infinity },
    { beforeFloor: -2 },
    { beforeFloor: 2.5 },
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: 'ten' },
    { afterFloor: 1, beforeFloor: 5 },
  ];
  for (const opts of cases) {
    const r = store.page('group:100', opts);
    assert.equal(r.ok, false, `${JSON.stringify(opts)} 应被拒绝`);
    assert.equal(r.code, 'E4010', `${JSON.stringify(opts)} 应返回 E4010`);
  }
});

test('limit 默认 50', async () => {
  const store = await seeded(80);
  const r = store.page('group:100', {});
  assert.equal(r.messages.length, 50);
});

test('limit 上限 200', async () => {
  const store = await seeded(250, { maxMessages: 300 });
  const r = store.page('group:100', { limit: 1000 });
  assert.equal(r.messages.length, 200);
});

/* ------------------------------------------------------- 与读楼层配合 */

test('page 返回的 readThroughFloor 与 store 一致', async () => {
  const store = await seeded(10);
  store.markModelSeen('group:100', [1, 2, 3]);
  const r = store.page('group:100', { limit: 5 });
  assert.equal(r.readThroughFloor, 3);
  assert.equal(r.lastFloor, 10);
});

test('★ 未读条数 = lastFloor - readThroughFloor，与徽标口径一致', async () => {
  const store = await seeded(10);
  store.markModelSeen('group:100', [1, 2, 3, 4]);
  const r = store.page('group:100', {});
  assert.equal(r.lastFloor - r.readThroughFloor, 6, '界面徽标直接减这两个数');

  // 跳到未读：从读楼层之后开始，正好拿到 6 条
  const unread = store.page('group:100', { afterFloor: r.readThroughFloor, limit: 50 });
  assert.equal(unread.messages.length, 6);
  assert.deepEqual(unread.messages.map((m) => m.floor), [5, 6, 7, 8, 9, 10]);
});

test('★ 楼层里有洞时（中间未喂过模型），afterFloor 仍按真实楼层返回', async () => {
  /*
   * 读楼层可能停在 3，而 4 存在但没喂过。此时"跳到未读"必须从 4 开始，
   * 不能因为读楼层算不动就把 4 也当成已读吞掉。
   */
  const store = await seeded(10);
  store.markModelSeen('group:100', [1, 2, 3, 5]); // 故意跳过 4
  assert.equal(store.readThroughFloor('group:100'), 3, '4 没喂过，读楼层停在 3');
  const r = store.page('group:100', { afterFloor: 3, limit: 3 });
  assert.deepEqual(r.messages.map((m) => m.floor), [4, 5, 6], '4 必须被返回');
});
