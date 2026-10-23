/**
 * 会话楼层：分配、读楼层、落盘 —— F5
 *
 * 这组测试守的是「消息不会丢、也不会被偷偷跳过」。
 * 四条要点，每一条对应一个真实会发生的故障：
 *
 *   1. 楼层号单调递增且重启不倒退 —— 否则读楼层会对不上
 *   2. 没喂给模型的楼层**不会**被读楼层越过 —— 否则那条消息永远不再被处理
 *   3. 缓冲淘汰后读楼层**可以**越过 —— 否则会永久卡死在同一点
 *   4. 落盘/读回一致，坏文件降级而不是阻止启动
 *
 * 第 2 条和第 3 条看起来矛盾，其实是同一枚硬币的两面：
 * 能跨过的只有「已经不存在」的楼，仍然存在的必须一栋一栋喂。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { SessionStore, MAX_MESSAGES_PER_CONV } from '../src/session/store.mjs';

/** 临时目录里的仓库，测试之间互不干扰 */
async function makeStore(over = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-floor-'));
  const filePath = path.join(dir, 'sessions.json');
  const store = new SessionStore({ filePath, ...over });
  return { store, dir, filePath };
}

/** 造一条归一化后的事件 */
const evt = (uid, text, messageId = null) => ({
  messageId,
  sender: { userId: String(uid), nickname: `u${uid}` },
  text,
  time: 1_700_000_000,
});

const CONV = 'group:123456';

/* ------------------------------------------------------------------ 楼层号 */

test('楼层号从 1 开始，单调递增', async () => {
  const { store } = await makeStore();
  assert.equal(store.append(CONV, evt(1, 'a')).floor, 1);
  assert.equal(store.append(CONV, evt(1, 'b')).floor, 2);
  assert.equal(store.append(CONV, evt(2, 'c')).floor, 3);
});

test('不同会话各自从 1 开始编号', async () => {
  const { store } = await makeStore();
  assert.equal(store.append('group:1', evt(1, 'a')).floor, 1);
  assert.equal(store.append('private:2', evt(2, 'b')).floor, 1);
  assert.equal(store.append('group:1', evt(3, 'c')).floor, 2);
});

test('非法会话键被拒绝，不会悄悄建出一个空会话', async () => {
  const { store } = await makeStore();
  for (const bad of ['', 'group:', 'group:abc', 'weird:1', null, undefined]) {
    const r = store.append(/** @type {any} */ (bad), evt(1, 'x'));
    assert.equal(r.ok, false, `${String(bad)} 应被拒绝`);
  }
  assert.equal(store.conversationCount, 0);
});

test('★ 重启后楼层号不倒退（不会重复使用旧号）', async () => {
  const { store, filePath } = await makeStore();
  store.append(CONV, evt(1, 'a'));
  store.append(CONV, evt(1, 'b'));
  await store.close();

  const reopened = new SessionStore({ filePath });
  await reopened.load();
  const r = reopened.append(CONV, evt(1, 'c'));
  assert.equal(r.floor, 3, '重启后必须接着 3 号，不能回到 1');
});

/* ------------------------------------------------------- 读楼层的核心语义 */

test('★ 没喂给模型的消息不会被读楼层越过（最关键的一条）', async () => {
  const { store } = await makeStore();
  for (let i = 1; i <= 3; i++) store.append(CONV, evt(1, `m${i}`));

  // 只喂了 1 号
  store.markModelSeen(CONV, [1]);
  assert.equal(store.readThroughFloor(CONV), 1, '读到第 1 楼就该停住');

  // 喂了 1、3（跳过了 2）—— 读楼层仍必须停在第 1 楼
  store.markModelSeen(CONV, [3]);
  assert.equal(store.readThroughFloor(CONV), 1, '中间有 2 号没喂，绝不能跳到 3');

  // 补上 2 之后才允许到 3
  store.markModelSeen(CONV, [2]);
  assert.equal(store.readThroughFloor(CONV), 3);
});

test('★ 缓冲淘汰后读楼层可以越过（否则会永久卡死）', async () => {
  const { store } = await makeStore({ maxMessages: 3 });
  // 塞 5 条，前 2 条会被淘汰
  for (let i = 1; i <= 5; i++) store.append(CONV, evt(1, `m${i}`));
  // 一条都没喂给模型，但 1、2 已被淘汰（不可能再处理）
  assert.equal(store.readThroughFloor(CONV), 2, '被淘汰的楼可以被跨过');

  // 3、4、5 还在，没喂过就不能跨
  store.markModelSeen(CONV, [3, 4, 5]);
  assert.equal(store.readThroughFloor(CONV), 5);
});

test('markModelSeen 忽略不存在的楼层（防止凭空跳过中间）', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'a')); // floor 1
  store.append(CONV, evt(1, 'b')); // floor 2
  // 试图直接标记一个未来楼层
  assert.equal(store.markModelSeen(CONV, [99]), 0, '不存在的楼层不该被登记');
  assert.equal(store.readThroughFloor(CONV), 0, '读楼层不能被伪造的号带过去');
});

test('markModelSeen 忽略非法入参', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'a'));
  for (const bad of [null, undefined, 'x', {}, 3.5, -1]) {
    assert.equal(store.markModelSeen(CONV, /** @type {any} */ (bad)), 0);
  }
});

test('unreadCount 与 readThroughFloor 一致', async () => {
  const { store } = await makeStore();
  for (let i = 1; i <= 5; i++) store.append(CONV, evt(1, `m${i}`));
  assert.equal(store.unreadCount(CONV), 5);
  store.markModelSeen(CONV, [1, 2]);
  assert.equal(store.unreadCount(CONV), 3);
});

test('acknowledge 能显式推到指定楼层，但仍不越过未处理的楼', async () => {
  const { store } = await makeStore();
  for (let i = 1; i <= 5; i++) store.append(CONV, evt(1, `m${i}`));
  const r = store.acknowledge(CONV, 3);
  assert.equal(r.ok, true);
  assert.equal(r.readThroughFloor, 3);
  assert.equal(store.unreadCount(CONV), 2);
});

test('acknowledge 目标超过最高楼层时夹到最高楼层', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'a'));
  assert.equal(store.acknowledge(CONV, 999).readThroughFloor, 1);
});

test('acknowledge 非法入参不改变状态', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'a'));
  store.markModelSeen(CONV, [1]);
  const before = store.readThroughFloor(CONV);
  assert.equal(store.acknowledge(CONV, /** @type {any} */ ('x')).ok, false);
  assert.equal(store.readThroughFloor(CONV), before);
});

/* ------------------------------------------------------------------ 分页 */

test('分页：默认返回最新一页', async () => {
  const { store } = await makeStore();
  for (let i = 1; i <= 10; i++) store.append(CONV, evt(1, `m${i}`));
  const r = store.page(CONV, { limit: 3 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages.map((m) => m.floor), [8, 9, 10]);
  assert.equal(r.hasMore, true);
});

test('分页：afterFloor 从读楼层之后取最早一页', async () => {
  const { store } = await makeStore();
  for (let i = 1; i <= 10; i++) store.append(CONV, evt(1, `m${i}`));
  const r = store.page(CONV, { afterFloor: 4, limit: 3 });
  assert.deepEqual(r.messages.map((m) => m.floor), [5, 6, 7]);
  assert.equal(r.hasMore, true);
});

test('分页：beforeFloor 向上翻历史', async () => {
  const { store } = await makeStore();
  for (let i = 1; i <= 10; i++) store.append(CONV, evt(1, `m${i}`));
  const r = store.page(CONV, { beforeFloor: 8, limit: 3 });
  assert.deepEqual(r.messages.map((m) => m.floor), [5, 6, 7]);
  assert.equal(r.hasMore, true, '前面还有 1~4');
});

test('分页：恰好一页时 hasMore=false', async () => {
  const { store } = await makeStore();
  for (let i = 1; i <= 3; i++) store.append(CONV, evt(1, `m${i}`));
  const r = store.page(CONV, { limit: 3 });
  assert.equal(r.messages.length, 3);
  assert.equal(r.hasMore, false);
});

test('分页：空会话返回空列表而不是报错', async () => {
  const { store } = await makeStore();
  const r = store.page('group:999999', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, []);
  assert.equal(r.hasMore, false);
});

test('★ 分页：非法参数明确报错，不静默返回空列表', async () => {
  const { store } = await makeStore();
  for (let i = 1; i <= 5; i++) store.append(CONV, evt(1, `m${i}`));

  const bad = [
    { afterFloor: -1 },
    { afterFloor: 'x' },
    { afterFloor: 1.5 },
    { beforeFloor: -3 },
    { limit: 0 },
    { limit: -5 },
    { limit: 'many' },
    { afterFloor: 1, beforeFloor: 3 },
  ];
  for (const opts of bad) {
    const r = store.page(CONV, opts);
    assert.equal(r.ok, false, `${JSON.stringify(opts)} 应被拒绝`);
    assert.equal(r.code, 'E4010');
  }
});

test('分页 limit 上限 200，超出被夹住而不是报错', async () => {
  const { store } = await makeStore({ maxMessages: 300 });
  for (let i = 1; i <= 250; i++) store.append(CONV, evt(1, `m${i}`));
  const r = store.page(CONV, { limit: 9999 });
  assert.equal(r.messages.length, 200);
});

test('分页返回副本：改返回值不影响仓库', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'original'));
  const r = store.page(CONV, {});
  r.messages[0].text = '被改坏了';
  assert.equal(store.page(CONV, {}).messages[0].text, 'original');
});

test('unreadMessages 从读楼层之后取，且不越过未读', async () => {
  const { store } = await makeStore();
  for (let i = 1; i <= 5; i++) store.append(CONV, evt(1, `m${i}`));
  store.markModelSeen(CONV, [1, 2]);
  const pending = store.unreadMessages(CONV);
  assert.deepEqual(pending.map((m) => m.floor), [3, 4, 5]);
});

/* ------------------------------------------------------------------ 落盘 */

test('落盘/读回：消息、楼层、已读状态都一致', async () => {
  const { store, filePath } = await makeStore();
  for (let i = 1; i <= 4; i++) store.append(CONV, evt(1, `m${i}`));
  store.markModelSeen(CONV, [1, 2]);
  await store.flush();

  const reopened = new SessionStore({ filePath });
  const r = await reopened.load();
  assert.equal(r.ok, true);
  assert.equal(r.loaded, 1);

  const page = reopened.page(CONV, { limit: 10 });
  assert.deepEqual(page.messages.map((m) => m.text), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(page.lastFloor, 4);
  assert.equal(reopened.readThroughFloor(CONV), 2, '已读状态要能恢复');

  // 继续 append 不冲突
  assert.equal(reopened.append(CONV, evt(1, 'm5')).floor, 5);
});

test('文件不存在时 load 返回空仓库（首次启动的正常路径）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-floor-'));
  const store = new SessionStore({ filePath: path.join(dir, 'none.json') });
  const r = await store.load();
  assert.equal(r.ok, true);
  assert.equal(r.loaded, 0);
  assert.equal(r.recovered, false);
});

test('★ 坏文件不拦住启动，改名留证后从空仓库开始', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-floor-'));
  const filePath = path.join(dir, 'sessions.json');
  await fs.writeFile(filePath, '{ 这不是 JSON', 'utf8');

  const store = new SessionStore({ filePath });
  const r = await store.load();
  assert.equal(r.ok, false);
  assert.equal(r.recovered, true);
  assert.equal(store.conversationCount, 0, '坏文件要降级成空仓库');

  // 原文件被改名保留，而不是删掉
  const files = await fs.readdir(dir);
  assert.ok(files.some((f) => f.endsWith('.corrupt')), '坏文件必须留证据');
});

test('落盘期间的新增不会丢（dirty/version 保护）', async () => {
  const { store, filePath } = await makeStore();
  store.append(CONV, evt(1, 'before'));
  // 不 await：在落盘进行中继续写
  const flushing = store.flush();
  store.append(CONV, evt(1, 'during'));
  await flushing;
  await store.flush(); // 第二轮把 during 写下去

  const reopened = new SessionStore({ filePath });
  await reopened.load();
  const texts = reopened.page(CONV, { limit: 10 }).messages.map((m) => m.text);
  assert.ok(texts.includes('before'));
  assert.ok(texts.includes('during'), '写盘期间进来的消息也必须落盘');
});

test('load 忽略脏数据：超出 lastFloor 的楼层、非法会话键', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-floor-'));
  const filePath = path.join(dir, 'sessions.json');
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      conversations: {
        'group:1': {
          convKey: 'group:1',
          lastFloor: 2,
          readThroughFloor: 99,
          messages: [
            { floor: 1, text: 'ok' },
            { floor: 2, text: 'ok2' },
            { floor: 77, text: '超出 lastFloor，应被丢掉' },
          ],
          modelSeenFloors: [1, 555],
        },
        'bad-key': { lastFloor: 1, messages: [] },
      },
    }),
    'utf8',
  );

  const store = new SessionStore({ filePath });
  await store.load();
  assert.equal(store.conversationCount, 1, '非法会话键被丢弃');
  const page = store.page('group:1', { limit: 10 });
  assert.deepEqual(page.messages.map((m) => m.floor), [1, 2], '超出范围的楼层被丢弃');
  assert.ok(store.readThroughFloor('group:1') <= 2, '越界的读楼层要被夹回来');
});

/* ------------------------------------------------------------------ 上限 */

test('每会话消息数超上限时淘汰最旧的', async () => {
  const { store } = await makeStore({ maxMessages: 3 });
  for (let i = 1; i <= 5; i++) store.append(CONV, evt(1, `m${i}`));
  const r = store.page(CONV, { limit: 10 });
  assert.deepEqual(r.messages.map((m) => m.floor), [3, 4, 5], '只保留最近 3 条');
  assert.equal(r.lastFloor, 5, '最高楼层不因淘汰而下降');
});

test('并发 append 不会分到同一个楼层号', async () => {
  const { store } = await makeStore();
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => Promise.resolve(store.append(CONV, evt(1, `m${i}`)))),
  );
  const floors = results.map((r) => r.floor);
  assert.equal(new Set(floors).size, 50, '楼层号必须唯一');
  assert.equal(Math.max(...floors), 50);
});

test('默认每会话上限是 200', () => {
  assert.equal(MAX_MESSAGES_PER_CONV, 200);
});

/* ------------------------------------------------------------------ 列表 */

test('list 按最近更新排序并带未读数', async () => {
  let t = 1000;
  const { store } = await makeStore({ now: () => t });
  store.append('group:1', evt(1, 'a'));
  t += 100;
  store.append('group:2', evt(2, 'b'));
  store.markModelSeen('group:2', [1]);

  const list = store.list();
  assert.equal(list[0].convKey, 'group:2', '最近更新的排在前面');
  assert.equal(list[0].unread, 0);
  assert.equal(list[1].unread, 1);
});

/* ------------------------------------------------------------ 按日统计 */

/** 造一个指定本地时间的毫秒时间戳 */
const atLocal = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();

test('★ 按日统计：即使消息被淘汰，昨天的活动仍然记得', async () => {
  /*
   * 这是日记生成的命门。messages 只有最近 200 条，一个活跃群两天就能刷满。
   * 如果 hasActivityOn 从 messages 里数，昨天就会变成 0 条 ——
   * 于是日记生成器以为昨天没人说话，直接不生成，用户看到"日记消失了"，
   * 而且没有任何报错。所以必须查 activityByDate 这个历史累计。
   */
  let t = atLocal(2026, 3, 10, 10);
  const { store } = await makeStore({ now: () => t, maxMessages: 2 });

  store.append('group:1', evt(1, '昨天的消息'));
  // 再塞 5 条今天的，把昨天的挤出缓冲
  t = atLocal(2026, 3, 11, 10);
  for (let i = 0; i < 5; i++) store.append('group:1', evt(1, `今天${i}`));

  const page = store.page('group:1', { limit: 10 });
  assert.ok(!page.messages.some((m) => m.text === '昨天的消息'), '昨天那条确实已被淘汰');

  assert.equal(store.hasActivityOn('2026-03-10'), true, '淘汰了也要记得昨天有活动');
  assert.equal(store.activityCountOn('2026-03-10'), 1);
  assert.equal(store.activityCountOn('2026-03-11'), 5);
});

test('按日统计：没活动的日期返回 false 与 0', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'a'));
  assert.equal(store.hasActivityOn('2020-01-01'), false);
  assert.equal(store.activityCountOn('2020-01-01'), 0);
  assert.deepEqual(store.conversationsOn('2020-01-01'), []);
});

test('按日统计：跨会话累计', async () => {
  const { store } = await makeStore();
  const day = new Date().toISOString().slice(0, 10);
  // 用本地日期键，避免 UTC 与本地跨日
  const { localDateKey } = await import('../src/diary/decay.mjs');
  const key = localDateKey(Date.now());
  store.append('group:1', evt(1, 'a'));
  store.append('group:2', evt(2, 'b'));
  store.append('group:2', evt(3, 'c'));
  assert.equal(store.activityCountOn(key), 3);
  const convs = store.conversationsOn(key);
  assert.equal(convs.length, 2);
  assert.equal(convs[0].convKey, 'group:2', '当天消息多的排前面');
  assert.equal(convs[0].count, 2);
});

test('★ 按日统计能落盘并读回', async () => {
  let t = atLocal(2026, 3, 10, 10);
  const { store, filePath } = await makeStore({ now: () => t });
  store.append('group:1', evt(1, 'a'));
  await store.flush();

  const reopened = new SessionStore({ filePath });
  await reopened.load();
  assert.equal(reopened.hasActivityOn('2026-03-10'), true, '重启后昨天的活动不能丢');
  assert.equal(reopened.activityCountOn('2026-03-10'), 1);
});

test('按日统计：老文件没有该字段时从现存消息重建', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-floor-'));
  const filePath = path.join(dir, 'sessions.json');
  // 模拟旧版落盘：没有 activityByDate
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      conversations: {
        'group:1': {
          convKey: 'group:1',
          lastFloor: 1,
          messages: [{ floor: 1, text: 'x', receivedAt: atLocal(2026, 5, 1, 9) }],
          modelSeenFloors: [1],
        },
      },
    }),
    'utf8',
  );

  const store = new SessionStore({ filePath });
  await store.load();
  assert.equal(store.hasActivityOn('2026-05-01'), true, '老文件要能重建出活动统计');
});
