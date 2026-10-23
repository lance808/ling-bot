/**
 * 日记仓库与跨日判定 —— T4
 *
 * 这组测试守的是「日记会在正确的那天生成，且不会重复生成、不会因为坏文件起不来」。
 * 五组要点，每组对应一个会静默出事的地方：
 *
 *   1. 跨日只在**真的**跨了零点时触发，且同一天只生成一次（幂等）。
 *      少了这道锁，每分钟一次的 tick 会把 LLM 配额打空；
 *      多了方向错的锁，日记就永远不会生成，而且没有任何报错。
 *   2. 启动补生成只补「昨日缺失 **且** 昨日有活动」的那一天。
 *      多天缺失时只补最近一天 —— 一次补 30 天会炸。
 *   3. 落盘/读回一致；坏文件改名 `.corrupt` 后从空仓库继续，绝不拦住启动。
 *   4. 锁定状态不会被 `save()` 悄悄冲掉（自动生成时带着旧快照回来就会）。
 *   5. 日期键用**本地**时区，不是 UTC —— UTC+8 的凌晨用 UTC 会算成前一天。
 *
 * 所有时间都用 `new Date(y, m, d, h, min)` 这种**本地构造**，
 * 不用带 Z 的 ISO 串：后者会让测试跟着跑测试那台机器的时区漂。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  DiaryStore,
  DiaryScheduler,
  localDateKey,
  DEFAULT_WEIGHT_BASE,
  RETRY_BACKOFF_MS,
} from '../src/diary/store.mjs';
import { computeWeight } from '../src/diary/decay.mjs';

/* ------------------------------------------------------------------ 工具 */

/** 临时目录（每次调用互不干扰） */
async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ling-diary-'));
}

/**
 * 固定「现在」的仓库：日期相关的断言不能依赖真实时钟。
 *
 * @param {{dir: string, now?: number}} opts
 */
function storeAt({ dir, now }) {
  return new DiaryStore({ dir, now: () => now });
}

/** 本地构造的时刻，避开零点边界 */
function at(y, m, d, h = 12, min = 0) {
  return new Date(y, m - 1, d, h, min).getTime();
}

/** 一条填好的日记（字段与落盘形状完全一致，便于 deepEqual 对账） */
function rec(date, over = {}) {
  return {
    date,
    createdAt: at(2026, 1, 2),
    model: 'test-model',
    source: { convKeys: ['group:1'], messageCount: 12 },
    summary: '昨天群里聊了天气和猫。',
    highlights: ['天气转凉', '猫又胖了'],
    degraded: false,
    weightBase: DEFAULT_WEIGHT_BASE,
    weightBaseDate: date,
    locked: false,
    lockedWeight: null,
    lockedDate: null,
    ...over,
  };
}

/**
 * 造一个可注入的调度器。
 *
 * `exists` / `activity` 用 Set 模拟，`generated` 记录实际生成过哪些日期。
 *
 * @param {{start: string, now: () => number, existing?: string[], activities?: string[]}} opts
 */
function makeScheduler({ start, now, existing = [], activities = [] }) {
  const exists = new Set(existing);
  const activity = new Set(activities);
  /** @type {Array<{date: string, trigger: string}>} */
  const generated = [];
  const scheduler = new DiaryScheduler({
    now,
    lastSeenDate: start,
    hasDiary: (date) => exists.has(date),
    hasActivity: (date) => activity.has(date),
    onGenerate: (date, trigger) => {
      generated.push({ date, trigger });
      exists.add(date);
    },
  });
  return { scheduler, generated, exists, activity };
}

/* -------------------------------------------------- 跨日判定：幂等与方向 */

test('跨日判定：同一天重复 tick 只生成一次（幂等）', async () => {
  let now = at(2026, 1, 2, 12, 0);
  const { scheduler, generated } = makeScheduler({ start: '2026-01-02', now: () => now });

  // 跨过午夜到 1-03：第一次 tick 生成 1-02
  now = at(2026, 1, 3, 0, 1);
  const first = await scheduler.tick();
  assert.equal(first.generated, true, '跨日后的第一次 tick 应该生成昨日');
  assert.equal(first.date, '2026-01-02');
  assert.equal(generated.length, 1);

  // 同一天内再 tick 十次：一次都不许再生成
  for (let i = 0; i < 10; i += 1) {
    now += 60_000;
    const r = await scheduler.tick();
    assert.equal(r.generated, false, `同一天第 ${i + 1} 次 tick 不该再生成`);
  }
  assert.equal(generated.length, 1, '同一天只能生成一次');
});

test('跨日判定：没跑过午夜就不生成', async () => {
  let now = at(2026, 1, 2, 9, 0);
  const { scheduler, generated } = makeScheduler({ start: '2026-01-02', now: () => now });

  // 同一天从早跑到晚，分钟级 tick 一次都不该生成
  for (let i = 0; i < 20; i += 1) {
    const r = await scheduler.tick();
    assert.equal(r.generated, false);
    assert.equal(r.reason, 'same-day');
    now += 30 * 60_000;
  }
  assert.equal(generated.length, 0);

  // shouldGenerateYesterday 也必须一致地摇头
  assert.equal(scheduler.shouldGenerateYesterday(), false);
});

test('跨日判定：跑过午夜生成的是「昨日」而不是「今天」', async () => {
  let now = at(2026, 1, 1, 23, 59);
  const { scheduler, generated } = makeScheduler({ start: '2026-01-01', now: () => now });

  // 23:59 还没跨
  assert.equal((await scheduler.tick()).generated, false);
  assert.equal(scheduler.shouldGenerateYesterday(), false);

  // 00:01 跨了：昨天是 1-01
  now = at(2026, 1, 2, 0, 1);
  assert.equal(scheduler.shouldGenerateYesterday(), true, '跨零点后应该判定为「该生成昨日」');

  const r = await scheduler.tick();
  assert.equal(r.generated, true);
  assert.deepEqual(generated, [{ date: '2026-01-01', trigger: 'rollover' }]);
  assert.equal(r.today, '2026-01-02', '今天必须是新的一天');
  assert.equal(r.yesterday, '2026-01-01');
});

test('跨日判定：跨零点前 tick 过一次（首 tick 只记日期，不生成）', async () => {
  let now = at(2026, 1, 2, 12, 0);
  // 不传 lastSeenDate：模拟真实启动，调度器还不知道"今天是哪天"
  const { scheduler, generated } = makeScheduler({ now: () => now });

  const first = await scheduler.tick();
  assert.equal(first.reason, 'first-tick');
  assert.equal(first.generated, false, '首 tick 不生成：启动补生成是 catchUpOnStartup 的职责');
  assert.equal(scheduler.lastSeenDate, '2026-01-02', '首 tick 只记下今天是哪天');

  now = at(2026, 1, 3, 0, 0);
  assert.equal((await scheduler.tick()).generated, true);
  assert.equal(generated.length, 1);
});

test('跨日判定：昨日已存在时跨日不重复生成', async () => {
  let now = at(2026, 1, 2, 12, 0);
  const { scheduler, generated } = makeScheduler({
    start: '2026-01-02',
    now: () => now,
    existing: ['2026-01-02'],
  });

  now = at(2026, 1, 3, 0, 5);
  const r = await scheduler.tick();
  assert.equal(r.generated, false, '磁盘上已有 1-02 就不该再生成');
  assert.equal(r.reason, 'already-exists');
  assert.equal(generated.length, 0);
});

test('跨日判定：多天缺失时只补最近一天，不会一次补 30 天', async () => {
  // 上次观察到 1-01，现在已经是 1-31 —— 中间缺了 29 天
  let now = at(2026, 1, 31, 10, 0);
  const { scheduler, generated } = makeScheduler({ start: '2026-01-01', now: () => now });

  const r = await scheduler.tick();
  assert.equal(r.generated, true);
  assert.equal(generated.length, 1, '多天缺失只补一天');
  assert.equal(generated[0].date, '2026-01-30', '补的是最近一天（昨日），不是最早缺的那天');
});

test('跨日判定：生成失败会重试，但不在退避窗口内狂打', async () => {
  let now = at(2026, 1, 2, 12, 0);
  let attempts = 0;
  const scheduler = new DiaryScheduler({
    now: () => now,
    lastSeenDate: '2026-01-02',
    hasDiary: () => false,
    hasActivity: () => true,
    onGenerate: () => {
      attempts += 1;
      throw new Error('LLM 挂了');
    },
  });

  now = at(2026, 1, 3, 0, 1);
  const first = await scheduler.tick();
  assert.equal(first.generated, false);
  assert.equal(first.reason, 'failed');
  assert.ok(scheduler.lastError, '失败原因必须留下，不能静默');

  // 退避窗口内不再重试
  const second = await scheduler.tick();
  assert.equal(second.generated, false);
  assert.equal(second.reason, 'backoff');
  assert.equal(attempts, 1, '退避期内不许再打一次');

  // 退避过后自动重试（日记生成失败不该永久放弃）
  now += RETRY_BACKOFF_MS + 1000;
  const third = await scheduler.tick();
  assert.equal(third.reason, 'failed');
  assert.equal(attempts, 2, '退避过后应该重试');
});

/* ------------------------------------------------------ 启动补生成三态 */

test('启动补生成：昨日缺失且有活动 → 补', async () => {
  const now = at(2026, 1, 2, 9, 0);
  const { scheduler, generated } = makeScheduler({
    start: '2026-01-02',
    now: () => now,
    activities: ['2026-01-01'],
  });

  const pending = scheduler.pendingOnStartup();
  assert.equal(pending.needed, true);
  assert.equal(pending.date, '2026-01-01', '补的永远是被完整过完的那一天');

  const r = await scheduler.catchUpOnStartup();
  assert.equal(r.generated, true);
  assert.deepEqual(generated, [{ date: '2026-01-01', trigger: 'startup' }]);
});

test('启动补生成：昨日缺失但无活动 → 不补', async () => {
  const now = at(2026, 1, 2, 9, 0);
  const { scheduler, generated } = makeScheduler({ start: '2026-01-02', now: () => now });

  const pending = scheduler.pendingOnStartup();
  assert.equal(pending.needed, false);
  assert.equal(pending.reason, 'no-activity', '没活动生成出来只是纯占位，是噪音');

  const r = await scheduler.catchUpOnStartup();
  assert.equal(r.generated, false);
  assert.equal(generated.length, 0);
});

test('启动补生成：昨日已存在 → 不补', async () => {
  const now = at(2026, 1, 2, 9, 0);
  const { scheduler, generated } = makeScheduler({
    start: '2026-01-02',
    now: () => now,
    existing: ['2026-01-01'],
    activities: ['2026-01-01'],
  });

  assert.equal(scheduler.pendingOnStartup().needed, false);
  assert.equal(scheduler.pendingOnStartup().reason, 'already-exists');

  const r = await scheduler.catchUpOnStartup();
  assert.equal(r.generated, false);
  assert.equal(generated.length, 0);
});

test('启动补生成：多天缺失时也只补最近一天', async () => {
  const now = at(2026, 1, 31, 9, 0);
  const { scheduler, generated } = makeScheduler({
    start: '2026-01-31',
    now: () => now,
    // 1-01..1-30 全缺，而且全都有活动
    activities: Array.from({ length: 30 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`),
  });

  const r = await scheduler.catchUpOnStartup();
  assert.equal(r.generated, true);
  assert.equal(generated.length, 1, '只补一天');
  assert.equal(generated[0].date, '2026-01-30');
});

test('启动补生成：重复调用也只生成一次', async () => {
  const now = at(2026, 1, 2, 9, 0);
  const { scheduler, generated } = makeScheduler({
    start: '2026-01-02',
    now: () => now,
    activities: ['2026-01-01'],
  });

  await scheduler.catchUpOnStartup();
  await scheduler.catchUpOnStartup();
  await scheduler.catchUpOnStartup();
  assert.equal(generated.length, 1, '启动补生成必须幂等');
});

test('启动补生成：那一次失败后，退避过期的 tick 会自动重试（不会永久少一天）', async () => {
  let now = at(2026, 1, 2, 9, 0);
  let attempts = 0;
  let shouldFail = true;
  const exists = new Set();
  const scheduler = new DiaryScheduler({
    now: () => now,
    hasDiary: (date) => exists.has(date),
    hasActivity: () => true,
    onGenerate: (date) => {
      attempts += 1;
      if (shouldFail) throw new Error('启动时 LLM 还没就绪');
      exists.add(date);
    },
  });

  // 启动补生成恰好失败
  const first = await scheduler.catchUpOnStartup();
  assert.equal(first.generated, false);
  assert.equal(first.reason, 'failed');
  assert.equal(scheduler.pendingDate, '2026-01-01', '失败的那天要挂起来，等 tick 重试');

  // 同一天的 tick 处在退避窗口内：不再打一次
  assert.equal((await scheduler.tick()).reason, 'backoff');
  assert.equal(attempts, 1);

  // 退避过后 tick 自动重试并成功
  shouldFail = false;
  now += RETRY_BACKOFF_MS + 1000;
  const r = await scheduler.tick();
  assert.equal(r.generated, true, '退避过后必须自动补上，否则这一天永远没有日记');
  assert.equal(r.date, '2026-01-01');
  assert.equal(scheduler.pendingDate, null, '成功之后不该再挂着');
});

/* --------------------------------------------------------- 落盘 / 读回 */

test('落盘：并发 save 不丢数据（写盘期间的新版本必须被看见）', async () => {
  const dir = await tmpDir();
  const store = storeAt({ dir, now: at(2026, 1, 2, 9, 0) });

  /*
   * 同时发起多次 save：它们会在写盘期间互相重叠。
   * 若「写完就无条件认为已保存」，后面那次的内容会只在内存里活到进程退出
   * —— thinking.mjs 正是这样丢过数据（并发 200 次只落盘 32 条）。
   * 这里要求：全部 await 完之后，磁盘上的内容必须是最新那次。
   */
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.save(rec('2026-01-01', { summary: `第 ${i + 1} 次写入` })),
    ),
  );
  await store.flush();

  const reopened = storeAt({ dir, now: at(2026, 1, 2, 9, 0) });
  await reopened.load();
  assert.equal(reopened.get('2026-01-01').summary, '第 8 次写入', '磁盘上必须是最新版本');
});

test('落盘：写入后重新加载，内容逐字段一致', async () => {
  const dir = await tmpDir();
  const now = at(2026, 1, 2, 9, 0);

  const store = storeAt({ dir, now });
  const saved = await store.save(rec('2026-01-01'));
  assert.equal(saved.ok, true);
  await store.flush();

  // 磁盘上确实是一天一个文件
  assert.deepEqual(await fs.readdir(dir), ['2026-01-01.json']);

  const reopened = storeAt({ dir, now });
  const res = await reopened.load();
  assert.equal(res.ok, true);
  assert.equal(res.loaded, 1);
  assert.equal(res.recovered, false);

  const got = reopened.get('2026-01-01');
  assert.deepEqual(got, rec('2026-01-01'));
});

test('落盘：list() 按日期倒序，且包含已淡忘的（藏不藏由上层决定）', async () => {
  const dir = await tmpDir();
  const now = at(2026, 2, 10, 9, 0);
  const store = storeAt({ dir, now });

  await store.save(rec('2026-02-01'));
  await store.save(rec('2026-02-03'));
  await store.save(rec('2026-02-02'));
  await store.flush();

  const dates = store.list().map((r) => r.date);
  assert.deepEqual(dates, ['2026-02-03', '2026-02-02', '2026-02-01'], '倒序：新的在前');

  // 放 200 天：权重早已归零，但 list() 仍然返回它
  const later = storeAt({ dir, now: at(2026, 8, 20) });
  await later.load();
  const all = later.list();
  assert.equal(all.length, 3, '淡忘不等于删除，仓库不做隐藏');
  const w = computeWeight({ ...all[0], now: at(2026, 8, 20) });
  assert.equal(w.weight, 0);
  assert.equal(w.faded, true);
});

test('落盘：summary 为空时存成降级占位，绝不留空文件', async () => {
  const dir = await tmpDir();
  const store = storeAt({ dir, now: at(2026, 1, 2, 9, 0) });

  const r = await store.save({
    date: '2026-01-01',
    source: { convKeys: ['group:1', 'private:2'], messageCount: 42 },
    highlights: ['第一条要点', '第二条要点'],
    summary: '',
  });
  assert.equal(r.ok, true);
  assert.equal(r.record.degraded, true, '没有正文就是没总结成功');
  assert.equal(r.record.summary, '第一条要点\n第二条要点', '降级时用原始摘录占位');

  // 连摘录都没有：也要有一句可读的统计，不能是空串
  const r2 = await store.save({
    date: '2026-01-02',
    source: { convKeys: ['group:1'], messageCount: 7 },
  });
  assert.equal(r2.record.degraded, true);
  assert.match(r2.record.summary, /7 条消息/);
  assert.ok(r2.record.summary.length > 0);
});

test('落盘：没给的字段不会被默认值冲掉（权重与创建时间）', async () => {
  const dir = await tmpDir();
  const store = storeAt({ dir, now: at(2026, 1, 2, 9, 0) });

  await store.save(rec('2026-01-01', { createdAt: 111, weightBase: 73, weightBaseDate: '2026-01-01' }));

  // 调用方只改摘要，别的字段都没给
  await store.save({ date: '2026-01-01', summary: '补充一句。' });
  const got = store.get('2026-01-01');
  assert.equal(got.summary, '补充一句。');
  assert.equal(got.createdAt, 111, 'createdAt 不该被重置成现在');
  assert.equal(got.weightBase, 73, 'weightBase 不该被拉回 100');
  assert.equal(got.weightBaseDate, '2026-01-01', '衰减基准不该漂到今天');
});

test('落盘：返回副本，改返回值不会污染仓库', async () => {
  const dir = await tmpDir();
  const store = storeAt({ dir, now: at(2026, 1, 2, 9, 0) });
  const r = await store.save(rec('2026-01-01'));

  r.record.summary = '被调用方改掉了';
  r.record.source.convKeys.push('group:999');
  r.record.highlights.push('塞进来的');

  const got = store.get('2026-01-01');
  assert.equal(got.summary, '昨天群里聊了天气和猫。');
  assert.deepEqual(got.source.convKeys, ['group:1']);
  assert.equal(got.highlights.length, 2);
});

/* -------------------------------------------------------- 坏文件降级 */

test('坏文件降级：改名 .corrupt，不抛异常拦住启动', async () => {
  const dir = await tmpDir();
  const now = at(2026, 1, 3, 9, 0);

  const store = storeAt({ dir, now });
  await store.save(rec('2026-01-01'));
  await store.save(rec('2026-01-02'));
  await store.flush();

  // 把其中一天写成半截 JSON（模拟被杀的进程）
  await fs.writeFile(path.join(dir, '2026-01-02.json'), '{"date":"2026-01-02","summ', 'utf8');

  const reopened = storeAt({ dir, now });
  const res = await reopened.load();
  // 一个坏文件只隔离它自己，不能让整个历史拖没
  assert.equal(res.ok, true, '坏文件不该让 load 整体失败');
  assert.equal(res.loaded, 1, '好的那天仍然读得回来');
  assert.equal(res.recovered, true, '要做过隔离动作');
  assert.ok(reopened.has('2026-01-01'));
  assert.equal(reopened.has('2026-01-02'), false);

  // 证据留下，不是删掉
  const names = await fs.readdir(dir);
  assert.ok(names.includes('2026-01-02.json.corrupt'), `应留下 .corrupt 证据，实际：${names.join(',')}`);

  // 隔离之后照常能写回那一天
  await reopened.save(rec('2026-01-02'));
  assert.equal(reopened.has('2026-01-02'), true);
});

test('坏文件降级：日期键非法 / 目录不存在都不抛', async () => {
  const dir = path.join(await tmpDir(), 'not-created-yet');
  const store = storeAt({ dir, now: at(2026, 1, 2, 9, 0) });

  // 目录还不存在（首次运行）：不该当成错误
  const res = await store.load();
  assert.equal(res.ok, true);
  assert.equal(res.loaded, 0);
  assert.deepEqual(store.list(), []);

  // 非法日期键是调用方的编程错误，要早点暴露
  await assert.rejects(() => store.save({ date: '2026-02-30' }), TypeError);
  await assert.rejects(() => store.save({ date: '/etc/passwd' }), TypeError);
  await assert.rejects(() => store.save({}), TypeError);
});

/* ---------------------------------------------------------------- 锁定 */

test('锁定：lock 之后 list() 仍是 locked，save 不会把它冲成未锁定', async () => {
  const dir = await tmpDir();
  const now = at(2026, 1, 5, 12, 0);
  const store = storeAt({ dir, now });
  await store.save(rec('2026-01-01'));

  const locked = await store.lock('2026-01-01');
  assert.equal(locked.ok, true);
  assert.equal(locked.record.locked, true);
  assert.equal(locked.record.lockedWeight, 96, '1-01 写下、1-05 锁定：100 - 4 天');
  assert.equal(locked.record.lockedDate, '2026-01-05');

  assert.equal(store.get('2026-01-01').locked, true);
  assert.equal(store.list()[0].locked, true, 'list() 里也必须体现锁定');

  // 自动生成拿旧快照回来改摘要：locked: false 也不许把锁定冲掉
  await store.save({ date: '2026-01-01', summary: '重新生成的摘要。', locked: false });
  const after = store.get('2026-01-01');
  assert.equal(after.locked, true, 'save 不能悄悄解锁');
  assert.equal(after.lockedWeight, 96, '冻结权重也不许变');
  assert.equal(after.lockedDate, '2026-01-05');
  assert.equal(after.summary, '重新生成的摘要。', '摘要本身照常更新');

  // 落盘再读回，锁定状态仍然在
  await store.flush();
  const reopened = storeAt({ dir, now: at(2026, 2, 10) });
  await reopened.load();
  const back = reopened.get('2026-01-01');
  assert.equal(back.locked, true);
  assert.equal(back.lockedWeight, 96);
  // 锁着就不衰减：放 36 天还是 96
  assert.equal(computeWeight({ ...back, now: at(2026, 2, 10) }).weight, 96);
});

test('锁定：unlock 后从当天重新衰减，不补算锁定期', async () => {
  const dir = await tmpDir();
  const now = at(2026, 1, 3, 12, 0);
  const store = storeAt({ dir, now });
  await store.save(rec('2026-01-01'));

  await store.lock('2026-01-01'); // 1-03 锁，权重 98

  // 锁到 2-02（30 天）再解锁
  const later = storeAt({ dir, now: at(2026, 2, 2, 12, 0) });
  await later.load();
  const unlocked = await later.unlock('2026-01-01');

  assert.equal(unlocked.record.locked, false);
  assert.equal(unlocked.record.lockedWeight, null, '不清掉会让人误以为还锁着');
  assert.equal(unlocked.record.lockedDate, null);
  assert.equal(unlocked.record.weightBase, 98, '解锁时的当前权重成为新基准');
  assert.equal(unlocked.record.weightBaseDate, '2026-02-02', '基准日期重置为解锁当天');
  // 若补算 30 天锁定期，现在应该是 68。明确不允许。
  assert.equal(computeWeight({ ...unlocked.record, now: at(2026, 2, 2, 12, 0) }).weight, 98);
});

test('锁定：lock/unlock 不存在的日期返回 ok:false 而不是抛错', async () => {
  const dir = await tmpDir();
  const store = storeAt({ dir, now: at(2026, 1, 5, 12, 0) });

  const l = await store.lock('2026-01-01');
  assert.equal(l.ok, false);
  assert.equal(l.record, null);

  const u = await store.unlock('2026-01-01');
  assert.equal(u.ok, false);
});

/* ---------------------------------------------------------------- 时区 */

test('时区：日期键是本地时区的，不用 UTC', () => {
  // 本地 1-01 23:59 与本地 1-02 00:01：跨了零点就是跨了天
  assert.equal(localDateKey(at(2026, 1, 1, 23, 59)), '2026-01-01');
  assert.equal(localDateKey(at(2026, 1, 2, 0, 1)), '2026-01-02');

  // 同一天不论几点都得到同一个键
  assert.equal(localDateKey(at(2026, 1, 5, 0, 0)), '2026-01-05');
  assert.equal(localDateKey(at(2026, 1, 5, 23, 59)), '2026-01-05');

  // DiaryStore 的静态方法必须和 decay.mjs 是同一套口径（不实现第二份）
  assert.equal(DiaryStore.localDateKey(at(2026, 1, 5, 23, 59)), '2026-01-05');
  assert.equal(DiaryStore.localDateKey(at(2026, 1, 5, 23, 59)), localDateKey(at(2026, 1, 5, 23, 59)));

  // 补零
  assert.equal(localDateKey(at(2026, 12, 9, 8, 0)), '2026-12-09');
});

test('时区：跨日判定跟着本地日期走（凌晨跨零点即算新的一天）', async () => {
  // 模拟 UTC+8 的凌晨：本地 00:30 已经是新的一天，UTC 那边还是前一天
  let now = at(2026, 3, 1, 23, 50);
  const { scheduler, generated } = makeScheduler({ start: '2026-03-01', now: () => now });

  assert.equal((await scheduler.tick()).generated, false, '23:50 还没跨');

  now = at(2026, 3, 2, 0, 10);
  const r = await scheduler.tick();
  assert.equal(r.generated, true);
  assert.equal(generated[0].date, '2026-03-01', '生成的必须是本地口径的昨天');
});

/* ------------------------------------------------------------ 端到端 */

test('端到端：跨零点生成昨日 → 落盘 → 重启读回', async () => {
  const dir = await tmpDir();
  let now = at(2026, 1, 21, 23, 0);

  const store = storeAt({ dir, now });
  await store.load();

  // 定时任务：每 tick 一次就检查日期
  const scheduler = new DiaryScheduler({
    now: () => now,
    hasDiary: (date) => store.has(date),
    hasActivity: (date) => date === '2026-01-21',
    onGenerate: async (date) => {
      await store.save(
        rec(date, {
          createdAt: now,
          summary: '1 月 21 日的总结。',
          source: { convKeys: ['group:1'], messageCount: 30 },
        }),
      );
    },
  });

  await scheduler.tick(); // 记下 1-21
  assert.equal(store.has('2026-01-21'), false);

  // 跨到 1-22
  now = at(2026, 1, 22, 0, 2);
  const r = await scheduler.tick();
  assert.equal(r.generated, true);
  assert.equal(store.has('2026-01-21'), true);

  // 重启：新的仓库 + 新的调度器
  now = at(2026, 1, 22, 8, 0);
  const reopened = storeAt({ dir, now });
  const loaded = await reopened.load();
  assert.equal(loaded.loaded, 1);
  assert.equal(reopened.get('2026-01-21').summary, '1 月 21 日的总结。');

  // 重启后的调度器不该重复补生成 1-21
  const again = new DiaryScheduler({
    now: () => now,
    hasDiary: (date) => reopened.has(date),
    hasActivity: () => true,
    onGenerate: () => {
      throw new Error('不该被调用');
    },
  });
  assert.equal(again.pendingOnStartup().needed, false, '已存在就不补');
  assert.equal((await again.catchUpOnStartup()).generated, false);
});
