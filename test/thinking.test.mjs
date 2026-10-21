/**
 * 思考链路 —— F7 后端侧
 *
 * 这里守的是一组**会静默出错**的地方：
 *
 *   1. reasoning 不回灌：拼回下一次 messages 会被上游 400，token 还会暴涨。
 *      这个错不会报错，只会让账单变贵、让某些上游开始 400。
 *   2. 三种字段名（reasoning_content / reasoning / thinking）都要认，
 *      只认一个的话换个上游就静默丢光。
 *   3. 分片到达要逐块累积，只取最后一块会丢掉前面所有思考。
 *   4. 落盘必须原子：半个 JSON 的后果是**那一天的记录全读不出来**。
 *   5. 容量闸门要在**写之前**生效，否则两次检查之间可能把磁盘撑爆。
 *   6. 日期用本地时区，否则晚上 11 点的记录会被算到"明天"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  ThinkingStore,
  localDateKey,
  MAX_REASONING_CHARS,
  MAX_ENTRIES_PER_CONV_PER_DAY,
  MAX_DAYS,
  MAX_TOTAL_BYTES,
} from '../src/llm/thinking.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { runTurn } from '../src/llm/agent-loop.mjs';

/* ---------------------------------------------------------------- 工具 */

/** @returns {Promise<string>} */
async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ling-think-'));
}

/**
 * 固定"现在"的仓库：日期相关的断言不能依赖真实时钟。
 *
 * @param {{dir: string, now?: number, maxDays?: number, maxTotalBytes?: number}} opts
 */
function storeAt(opts) {
  const now = opts.now ?? Date.now();
  return new ThinkingStore({
    dir: opts.dir,
    now: () => now,
    maxDays: opts.maxDays,
    maxTotalBytes: opts.maxTotalBytes,
  });
}

/** 空视图的完整形状。集中一处，加字段时只改这里，不必追着每个断言跑。 */
const EMPTY_VIEW = {
  days: [],
  total: 0,
  entryCount: 0,
  stepCount: 0,
  hasMore: false,
  nextBefore: null,
  nextBeforeDate: null,
  cursorIgnored: false,
  conversations: [],
  dayKeys: [],
  lastSkip: null,
  lastError: null,
  retentionDays: 30,
};

/** @param {string} dir */
async function files(dir) {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** @param {string} dir @param {string} name */
async function readJson(dir, name) {
  return JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
}

/**
 * 起一个假上游，按 SSE 吐给定的事件。
 *
 * @param {any[]} chunks
 * @returns {Promise<{baseUrl: string, bodies: any[], close: () => Promise<void>}>}
 */
async function sseServer(chunks) {
  /** @type {any[]} */
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const buf = [];
    for await (const c of req) buf.push(c);
    try {
      bodies.push(JSON.parse(Buffer.concat(buf).toString('utf8')));
    } catch {
      bodies.push(null);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = /** @type {any} */ (server.address()).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

const mkClient = (baseUrl) =>
  new LlmClient({ baseUrl, model: 'reasoner', apiKey: 'sk-test', timeoutMs: 5000, maxRetries: 0 });

/* ---------------------------------------------------------------- 本地日期 */

test('日期键：用本地时区，不能用 UTC', () => {
  // 本地 23:30 的记录必须落在本地这一天。
  // 用 UTC 的话，东八区会把它算到"明天"，界面按日分组就会出现
  // "今天只有上午记录、晚上记录跑到明天"这种怪事。
  const d = new Date(2026, 9, 19, 23, 30, 0);
  assert.equal(localDateKey(d.getTime()), '2026-10-19');

  const early = new Date(2026, 9, 19, 0, 30, 0);
  assert.equal(localDateKey(early.getTime()), '2026-10-19');

  // 补零：2026-1-5 要写成 2026-01-05，否则按字符串排序会乱
  assert.equal(localDateKey(new Date(2026, 0, 5, 12, 0, 0).getTime()), '2026-01-05');
});

/* ---------------------------------------------------------------- 截断 */

test('截断：单条 reasoning 超过上限时截断并写明原长', async () => {
  const dir = await tmpDir();
  const at = new Date(2026, 9, 19, 10, 0, 0).getTime();
  const store = storeAt({ dir, now: at });

  const long = '思'.repeat(MAX_REASONING_CHARS + 1000);
  const rec = store.record({
    convKey: 'group:100000001',
    at,
    steps: [{ n: 1, reasoning: long, tools: [], answerPreview: 'ok' }],
  });

  assert.ok(rec, '有 reasoning 就应该真的记下来');
  const text = rec.steps[0].reasoning;
  assert.equal(text.length <= MAX_REASONING_CHARS + 40, true, '截断后不能还是全文');
  assert.match(text, /已截断/);
  assert.match(text, new RegExp(`原 ${long.length} 字符`));
  // 保留的是**前面**那一段（思考的开头才是意图），不是尾巴
  assert.ok(text.startsWith('思'.repeat(20)));

  // 落盘后读回来也不能二次截断（否则"原 N 字符"里的 N 会被改错）
  await store.flush();
  const reloaded = storeAt({ dir, now: at });
  await reloaded.load();
  const view = reloaded.view({ days: 1, limit: 10 });
  assert.match(view.days[0].entries[0].steps[0].reasoning, new RegExp(`原 ${long.length} 字符`));
});

test('截断：恰好等于上限时不加标记', async () => {
  const dir = await tmpDir();
  const at = Date.now();
  const store = storeAt({ dir, now: at });
  const exact = 'x'.repeat(MAX_REASONING_CHARS);
  const rec = store.record({ convKey: 'private:1', at, steps: [{ n: 1, reasoning: exact }] });
  assert.equal(rec?.steps[0].reasoning, exact);
});

/* ---------------------------------------------------------------- 静默降级 */

test('降级：没有 reasoning 时不记录、不建空文件', async () => {
  const dir = await tmpDir();
  const at = Date.now();
  const store = storeAt({ dir, now: at });

  assert.equal(store.record({ convKey: 'group:1', at, steps: [] }), null);
  assert.equal(store.record({ convKey: 'group:1', at, steps: [{ n: 1, reasoning: '  ' }] }), null);
  assert.equal(store.record({ convKey: 'group:1', at }), null);
  // 缺 convKey 也没法归档
  assert.equal(store.record({ at, steps: [{ n: 1, reasoning: '想了' }] }), null);

  await store.flush();
  assert.deepEqual(await files(dir), [], '不该留下任何文件');
  assert.deepEqual(store.view({ days: 1, limit: 50 }), EMPTY_VIEW);
});

/* ---------------------------------------------------------------- 按日分文件 */

test('按日一结：不同日期写进不同文件，文件名就是日期', async () => {
  const dir = await tmpDir();
  const today = new Date(2026, 9, 19, 12, 0, 0).getTime();
  const yesterday = new Date(2026, 9, 18, 12, 0, 0).getTime();
  const store = storeAt({ dir, now: today });

  store.record({ convKey: 'group:1', at: yesterday, steps: [{ n: 1, reasoning: '昨天的想法' }] });
  store.record({ convKey: 'group:1', at: today, steps: [{ n: 1, reasoning: '今天的想法' }] });
  await store.flush();

  assert.deepEqual(await files(dir), ['2026-10-18.json', '2026-10-19.json']);

  const y = await readJson(dir, '2026-10-18.json');
  assert.equal(y.date, '2026-10-18');
  assert.equal(y.entries.length, 1);
  assert.equal(y.entries[0].convKey, 'group:1');
  assert.equal(y.entries[0].steps[0].reasoning, '昨天的想法');

  const t = await readJson(dir, '2026-10-19.json');
  assert.equal(t.entries[0].steps[0].reasoning, '今天的想法');
});

test('按日一结：重启后 load() 能把近期记录读回来', async () => {
  const dir = await tmpDir();
  const at = new Date(2026, 9, 19, 9, 0, 0).getTime();

  const a = storeAt({ dir, now: at });
  a.record({
    convKey: 'group:100000001',
    at,
    steps: [{ n: 1, reasoning: '第一步', tools: ['web_search'], answerPreview: '答案一' }],
  });
  a.record({
    convKey: 'private:100000002',
    at: at + 1000,
    steps: [{ n: 1, reasoning: '另一个人' }],
  });
  await a.flush();

  const b = storeAt({ dir, now: at + 5000 });
  const r = await b.load();
  assert.equal(r.loaded, 1);

  const all = b.view({ days: 1, limit: 50 });
  assert.equal(all.total, 2);
  assert.equal(all.days[0].date, '2026-10-19');
  assert.equal(all.days[0].entries.length, 2);
  // 按 at 升序
  assert.equal(all.days[0].entries[0].convKey, 'group:100000001');
  assert.deepEqual(all.days[0].entries[0].steps[0].tools, ['web_search']);

  // 按会话过滤
  const only = b.view({ convKey: 'private:100000002', days: 1, limit: 50 });
  assert.equal(only.days[0].entries.length, 1);
  assert.equal(only.total, 1);
});

/* ---------------------------------------------------------------- 视图语义 */

test('视图：days 截最近 N 个有数据的日期，limit 截最近 N 条，total 不受影响', async () => {
  const dir = await tmpDir();
  const base = new Date(2026, 9, 17, 10, 0, 0).getTime();
  const store = storeAt({ dir, now: base });

  for (let d = 0; d < 3; d += 1) {
    const at = base + d * 24 * 3600 * 1000;
    for (let i = 0; i < 2; i += 1) {
      store.record({ convKey: 'group:1', at: at + i, steps: [{ n: 1, reasoning: `d${d}-${i}` }] });
    }
  }

  const all = store.view({ days: 10, limit: 100 });
  assert.equal(all.total, 6);
  assert.deepEqual(
    all.days.map((x) => x.date),
    ['2026-10-17', '2026-10-18', '2026-10-19'],
    '日期升序',
  );

  const oneDay = store.view({ days: 1, limit: 100 });
  assert.deepEqual(oneDay.days.map((x) => x.date), ['2026-10-19'], '只留最近的日期');
  assert.equal(oneDay.total, 6, 'total 是全部留存条数，不受 days 影响');

  const limited = store.view({ days: 10, limit: 2 });
  assert.equal(limited.total, 6);
  const kept = limited.days.flatMap((x) => x.entries);
  assert.equal(kept.length, 2, 'limit 截的是条数');
  // 截的是"最近的 N 条"：留下的应该是最后两条
  assert.match(kept[1].steps[0].reasoning, /d2-1/);
});

test('视图：返回的是拷贝，改它不会污染内存', async () => {
  const dir = await tmpDir();
  const at = Date.now();
  const store = storeAt({ dir, now: at });
  store.record({ convKey: 'group:1', at, steps: [{ n: 1, reasoning: '原始' }] });

  const v = store.view({ days: 1, limit: 10 });
  v.days[0].entries[0].steps[0].reasoning = '被改了';
  v.days[0].entries[0].steps[0].tools.push('注入工具');

  const again = store.view({ days: 1, limit: 10 });
  assert.equal(again.days[0].entries[0].steps[0].reasoning, '原始');
  assert.deepEqual(again.days[0].entries[0].steps[0].tools, []);
});

/* ---------------------------------------------------------------- 落盘不丢数据 */

test('★ 写盘期间新增的记录不会被静默丢掉（历史未保存的根因）', async () => {
  /*
   * 旧实现的 #doFlush 是「序列化 → await 写盘 → 无条件 dirty.delete(date)」。
   * 写盘是真异步 IO，期间完全可能有 record() 落到同一天，于是那条
   * **没被序列化进去**的记录被一起当成"已保存"，此后只在内存里活到退出。
   *
   * 这里用"边记边 flush"把这个窗口撑开：修复前实测 200 条只落盘 30 多条。
   */
  const dir = await tmpDir();
  const now = new Date(2026, 9, 19, 12, 0, 0).getTime();
  const store = storeAt({ dir, now });

  for (let i = 0; i < 120; i += 1) {
    store.record({ convKey: 'group:1', at: now + i, steps: [{ n: 1, reasoning: `r${i}` }] });
    // 每记几条就踢一次 flush，让"写盘进行中"与"继续记录"重叠
    if (i % 3 === 0) void store.flush();
    await new Promise((r) => setImmediate(r));
  }
  await store.flush();
  // 防抖计时器排的那次也收一下，确保所有 dirty 都落地
  await store.flush();

  const mem = store.view({ days: 1, limit: 9999 }).total;
  assert.equal(mem, 120, '内存里应有 120 条');

  const day = await readJson(dir, '2026-10-19.json');
  assert.equal(day.entries.length, 120, `落盘必须一条不少，实际 ${day.entries.length}`);
  const texts = day.entries.map((e) => e.steps[0].reasoning);
  assert.equal(new Set(texts).size, 120, '不能有重复或丢号');
});

test('★ 写盘失败时保留 dirty，恢复后能补写上去', async () => {
  const dir = await tmpDir();
  const at = new Date(2026, 9, 19, 12, 0, 0).getTime();
  const store = storeAt({ dir, now: at });
  store.record({ convKey: 'group:1', at, steps: [{ n: 1, reasoning: '要保住的' }] });

  // 把目标文件位置占成一个目录：写入必然失败
  await fs.mkdir(store.dir, { recursive: true });
  await fs.mkdir(path.join(dir, '2026-10-19.json'), { recursive: true });

  const first = await store.flush();
  assert.equal(first.written, 0, '第一次写不进去');
  assert.ok(store.lastError, '错误要留痕，不能静默');

  // 清掉障碍，再 flush 一次应当补上
  await fs.rmdir(path.join(dir, '2026-10-19.json'));
  await store.flush();
  /*
   * 不清 dirty 的意义就在这里：写失败的那一天必须留在队列里，
   * 否则这一条记录只活在内存里，重启即消失。
   * 防抖计时器可能已经抢先补写过一次，所以这里只看**最终结果**，
   * 不假设是哪一次调用写成功的。
   */
  const day = await readJson(dir, '2026-10-19.json');
  assert.equal(day.entries.length, 1);
  assert.equal(day.entries[0].steps[0].reasoning, '要保住的');
});

test('★ 记录后自动落盘：不显式 flush 也能在防抖窗口后写进磁盘', async () => {
  const dir = await tmpDir();
  const at = new Date(2026, 9, 19, 12, 0, 0).getTime();
  const store = storeAt({ dir, now: at });
  store.record({ convKey: 'group:1', at, steps: [{ n: 1, reasoning: '自动落盘' }] });

  // 等过防抖窗口（FLUSH_DEBOUNCE_MS=400），不主动调用 flush
  await new Promise((r) => setTimeout(r, 900));
  const day = await readJson(dir, '2026-10-19.json');
  assert.equal(day.entries[0].steps[0].reasoning, '自动落盘');
});

/* ---------------------------------------------------------------- 分页游标容错 */

test('★ 游标坏了只退回第一页，不许抛错（它曾让整份快照失败）', () => {
  const dir = 'C:/tmp/unused';
  const store = storeAt({ dir, now: Date.now() });
  store.record({ convKey: 'group:1', at: Date.now(), steps: [{ n: 1, reasoning: 'x' }] });

  // 三种坏游标：非 base64、解出来不是 JSON、JSON 里字段非法
  for (const bad of ['!!!not base64!!!', Buffer.from('not json').toString('base64url'), Buffer.from('{"end":"x"}').toString('base64url')]) {
    const v = store.view({ days: 1, limit: 10, before: bad });
    assert.equal(v.cursorIgnored, true, `坏游标 ${bad.slice(0, 12)} 应被忽略`);
    assert.equal(v.days.length, 1, '要退回第一页，而不是空视图');
  }
});

test('★ 游标与当前筛选不匹配时也退回第一页（切「当前会话」必然发生）', () => {
  const dir = 'C:/tmp/unused';
  const now = Date.now();
  const store = storeAt({ dir, now });
  store.record({ convKey: 'group:1', at: now, steps: [{ n: 1, reasoning: 'a' }] });
  store.record({ convKey: 'group:1', at: now + 1, steps: [{ n: 1, reasoning: 'b' }] });
  store.record({ convKey: 'group:1', at: now + 2, steps: [{ n: 1, reasoning: 'c' }] });

  // 「全部会话」翻页拿到的游标里 convKey 是 null
  const page1 = store.view({ days: 1, limit: 2 });
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextBefore);

  // 用户切到「当前会话」，游标还是旧的 → 不能抛
  const page2 = store.view({ convKey: 'group:1', days: 1, limit: 2, before: page1.nextBefore });
  assert.equal(page2.cursorIgnored, true);
  assert.equal(page2.days.flatMap((d) => d.entries).length, 2, '退回第一页');
});

/* ---------------------------------------------------------------- 会话索引 */

test('会话索引：不受分页影响，按最近记录倒序，带条数与步数', () => {
  const dir = 'C:/tmp/unused';
  const now = new Date(2026, 9, 19, 12, 0, 0).getTime();
  const store = storeAt({ dir, now });

  // 甲：1 条 2 步（较旧）；乙：2 条 1 步（较新）
  store.record({ convKey: 'group:1', at: now - 5000, steps: [{ n: 1, reasoning: 'a1' }, { n: 2, reasoning: 'a2' }] });
  store.record({ convKey: 'private:2', at: now - 1000, steps: [{ n: 1, reasoning: 'b1' }] });
  store.record({ convKey: 'private:2', at: now, steps: [{ n: 1, reasoning: 'b2' }] });

  // 故意只取 1 条：索引仍应是完整的两个会话（它是"目录"，不能被分页裁掉）
  const v = store.view({ days: 1, limit: 1 });
  assert.equal(v.entryCount, 1, '这一页只有 1 条');
  assert.equal(v.conversations.length, 2, '目录里两个会话都在');

  assert.deepEqual(v.conversations.map((c) => c.convKey), ['private:2', 'group:1'], '最近有记录的在前');
  const g = v.conversations.find((c) => c.convKey === 'group:1');
  assert.equal(g.entries, 1);
  assert.equal(g.steps, 2, '步数要单独给：一条记录可能含多步');
});

test('会话索引：dayKeys 列出所有有数据的日期（升序）', () => {
  const dir = 'C:/tmp/unused';
  const base = new Date(2026, 9, 17, 12, 0, 0).getTime();
  const store = storeAt({ dir, now: base + 2 * 86400000 });
  for (let d = 0; d < 3; d += 1) {
    store.record({ convKey: 'group:1', at: base + d * 86400000, steps: [{ n: 1, reasoning: `d${d}` }] });
  }
  assert.deepEqual(store.view({ days: 1 }).dayKeys, ['2026-10-17', '2026-10-18', '2026-10-19']);
});

test('删某一天：只影响那一天，且从会话索引里一起消失', async () => {
  const dir = await tmpDir();
  const base = new Date(2026, 9, 18, 12, 0, 0).getTime();
  const store = storeAt({ dir, now: base + 86400000 });

  store.record({ convKey: 'group:1', at: base, steps: [{ n: 1, reasoning: '前一天' }] });
  store.record({ convKey: 'group:1', at: base + 86400000, steps: [{ n: 1, reasoning: '当天' }] });
  await store.flush();

  const r = await store.clearDay('2026-10-18');
  assert.equal(r.removed, 1);
  const v = store.view({ days: 7 });
  assert.deepEqual(v.days.map((d) => d.date), ['2026-10-19']);
  assert.deepEqual(v.dayKeys, ['2026-10-19']);
  assert.equal(v.conversations.find((c) => c.convKey === 'group:1').entries, 1);
});


/* ---------------------------------------------------------------- 条数上限 */

test('条数上限：同会话当天最多保留 200 条，丢最旧的', async () => {
  const dir = await tmpDir();
  const at = new Date(2026, 9, 19, 10, 0, 0).getTime();
  const store = storeAt({ dir, now: at });

  for (let i = 0; i < MAX_ENTRIES_PER_CONV_PER_DAY + 5; i += 1) {
    store.record({ convKey: 'group:1', at: at + i, steps: [{ n: 1, reasoning: `第 ${i} 条` }] });
  }

  const v = store.view({ days: 1, limit: 500 });
  assert.equal(v.total, MAX_ENTRIES_PER_CONV_PER_DAY);
  const reasonings = v.days[0].entries.map((e) => e.steps[0].reasoning);
  assert.ok(!reasonings.includes('第 0 条'), '最旧的应该被丢掉');
  assert.ok(reasonings.includes(`第 ${MAX_ENTRIES_PER_CONV_PER_DAY + 4} 条`), '最新的必须还在');
});

test('条数上限：只挤掉同一会话的旧记录，不动别人', async () => {
  const dir = await tmpDir();
  const at = new Date(2026, 9, 19, 10, 0, 0).getTime();
  const store = storeAt({ dir, now: at });

  store.record({ convKey: 'group:999', at: at - 999, steps: [{ n: 1, reasoning: '别人的记录' }] });
  for (let i = 0; i < MAX_ENTRIES_PER_CONV_PER_DAY + 3; i += 1) {
    store.record({ convKey: 'group:1', at: at + i, steps: [{ n: 1, reasoning: `a${i}` }] });
  }

  const other = store.view({ convKey: 'group:999', days: 1, limit: 10 });
  assert.equal(other.total, 1, '别的会话不能被挤掉');
});

/* ---------------------------------------------------------------- 超期删除 */

test('超期删除：只保留最近 30 天，更早的 load 时删掉', async () => {
  const dir = await tmpDir();
  const now = new Date(2026, 9, 19, 12, 0, 0).getTime();
  await fs.mkdir(dir, { recursive: true });

  // 手工铺几个文件：正好 30 天边界的那天要留，再往前一天要删
  const dayKey = (offset) => {
    const d = new Date(now);
    d.setDate(d.getDate() - offset);
    return localDateKey(d.getTime());
  };
  const keep = dayKey(MAX_DAYS - 1);
  const drop = dayKey(MAX_DAYS);
  for (const date of [keep, drop, '2020-01-01']) {
    await fs.writeFile(
      path.join(dir, `${date}.json`),
      JSON.stringify({ date, entries: [{ at: 1, convKey: 'group:1', steps: [{ n: 1, reasoning: 'x' }] }] }),
      'utf8',
    );
  }

  const store = storeAt({ dir, now });
  const r = await store.load();
  assert.equal(r.removed, 2, '两个过期文件都要删');
  const left = await files(dir);
  assert.deepEqual(left, [`${keep}.json`]);
  assert.equal(store.view({ days: 99, limit: 99 }).total, 1);
});

test('超期删除：坏文件只跳过它自己，不影响别的日期', async () => {
  const dir = await tmpDir();
  const now = new Date(2026, 9, 19, 12, 0, 0).getTime();
  await fs.mkdir(dir, { recursive: true });

  // 模拟"上次被杀的进程"留下的半个 JSON —— 这正是原子写要防的东西
  await fs.writeFile(path.join(dir, '2026-10-19.json'), '{"date":"2026-10-19","entries":[{"at":1', 'utf8');
  await fs.writeFile(
    path.join(dir, '2026-10-18.json'),
    JSON.stringify({ date: '2026-10-18', entries: [{ at: 1, convKey: 'group:1', steps: [{ n: 1, reasoning: '还好' }] }] }),
    'utf8',
  );

  const store = storeAt({ dir, now });
  const r = await store.load();
  assert.equal(r.loaded, 1, '好的那天要读回来');
  const v = store.view({ days: 9, limit: 9 });
  assert.equal(v.total, 1);
  assert.equal(v.days[0].date, '2026-10-18');
});

test('记录：已经超出保留期的时间戳直接丢，不建注定被删的文件', async () => {
  const dir = await tmpDir();
  const now = new Date(2026, 9, 19, 12, 0, 0).getTime();
  const store = storeAt({ dir, now });

  const tooOld = now - (MAX_DAYS + 1) * 86400000;
  assert.equal(store.record({ convKey: 'group:1', at: tooOld, steps: [{ n: 1, reasoning: 'x' }] }), null);

  await store.flush();
  assert.deepEqual(await files(dir), []);
});

/* ---------------------------------------------------------------- 原子写入 */

test('原子写入：不残留 .tmp，且能覆盖已存在的旧文件', async () => {
  const dir = await tmpDir();
  const at = new Date(2026, 9, 19, 10, 0, 0).getTime();
  const store = storeAt({ dir, now: at });

  store.record({ convKey: 'group:1', at, steps: [{ n: 1, reasoning: '第一次' }] });
  await store.flush();

  // 再写同一天：rename 必须覆盖旧文件（Windows 上用 MoveFileEx 替换）
  store.record({ convKey: 'group:1', at: at + 1, steps: [{ n: 1, reasoning: '第二次' }] });
  await store.flush();

  assert.deepEqual(await files(dir), ['2026-10-19.json'], '不能留下 .tmp 残留');
  const day = await readJson(dir, '2026-10-19.json');
  assert.equal(day.entries.length, 2, '旧内容不能被覆盖丢掉，新内容也要在');
  assert.equal(day.entries[1].steps[0].reasoning, '第二次');
});

test('原子写入：目录里已有的 .tmp 垃圾不会被当成数据读', async () => {
  const dir = await tmpDir();
  const now = new Date(2026, 9, 19, 10, 0, 0).getTime();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.2026-10-19.json.abc.tmp'), '{"date":"2026-10-19","entr', 'utf8');

  const store = storeAt({ dir, now });
  const r = await store.load();
  assert.equal(r.loaded, 0);
  assert.deepEqual(store.view({ days: 1, limit: 10 }), EMPTY_VIEW);
});

/* ---------------------------------------------------------------- 8MB 上限 */

test('8MB 上限：超量时从最旧的文件开始删，且是在写之前生效', async () => {
  const dir = await tmpDir();
  const at = new Date(2026, 9, 19, 10, 0, 0).getTime();
  // 把上限压到 3KB，方便用几 KB 的数据触发
  const store = storeAt({ dir, now: at, maxTotalBytes: 3000 });

  const filler = 'x'.repeat(900);
  const day1 = at - 2 * 24 * 3600 * 1000;
  const day2 = at - 1 * 24 * 3600 * 1000;
  store.record({ convKey: 'group:1', at: day1, steps: [{ n: 1, reasoning: filler }] });
  await store.flush();
  store.record({ convKey: 'group:1', at: day2, steps: [{ n: 1, reasoning: filler }] });
  await store.flush();

  // 第三次写入会让总量超过 3000 字节：最旧的那天（day1）必须被删掉
  store.record({ convKey: 'group:1', at, steps: [{ n: 1, reasoning: filler }] });
  await store.flush();

  const left = await files(dir);
  assert.ok(!left.includes(`${localDateKey(day1)}.json`), '最旧的文件要删掉');
  assert.ok(left.includes(`${localDateKey(at)}.json`), '正在写的那天不能被删');

  let total = 0;
  for (const name of left) {
    const st = await fs.stat(path.join(dir, name));
    total += st.size;
  }
  assert.ok(total <= 3000, `总占用 ${total} 应压到上限内`);
});

test('8MB 上限：上限常量可覆盖，默认值是 8MB 与 30 天', async () => {
  const dir = await tmpDir();
  const store = new ThinkingStore({ dir });
  assert.equal(store.maxTotalBytes, 8 * 1024 * 1024);
  assert.equal(MAX_TOTAL_BYTES, 8 * 1024 * 1024);
  assert.equal(store.maxDays, 30);
  assert.equal(MAX_DAYS, 30);
});

/* ---------------------------------------------------------------- 清空 */

test('清空：只删当天，别的日期不受影响', async () => {
  const dir = await tmpDir();
  const now = new Date(2026, 9, 19, 10, 0, 0).getTime();
  const store = storeAt({ dir, now });

  store.record({ convKey: 'group:1', at: now, steps: [{ n: 1, reasoning: '今天' }] });
  store.record({ convKey: 'group:1', at: now - 86400000, steps: [{ n: 1, reasoning: '昨天' }] });
  await store.flush();

  const r = await store.clearDay();
  assert.equal(r.date, '2026-10-19');
  assert.equal(r.removed, 1);

  assert.deepEqual(await files(dir), ['2026-10-18.json'], '当天文件要被删掉');
  assert.equal(store.view({ days: 9, limit: 9 }).total, 1);
});

/* ---------------------------------------------------------------- client 侧 */

test('★ reasoning_content 分片到达时逐块累积（不能只取最后一块）', async () => {
  const s = await sseServer([
    { choices: [{ delta: { reasoning_content: '先想' } }] },
    { choices: [{ delta: { reasoning_content: '一步，' } }] },
    { choices: [{ delta: { reasoning_content: '再想一步。' }, content: '' }] },
    { choices: [{ delta: { content: '答案' } }] },
  ]);
  try {
    const seen = [];
    const res = await mkClient(s.baseUrl).chat({
      messages: [{ role: 'user', content: 'hi' }],
      onReasoningDelta: (d) => seen.push(d),
    });

    assert.equal(res.reasoning, '先想一步，再想一步。', '三块必须拼起来');
    assert.equal(res.text, '答案');
    assert.deepEqual(seen, ['先想', '一步，', '再想一步。'], '逐块回调也要按序触发');
  } finally {
    await s.close();
  }
});

test('★ 三种上游字段名都要认：reasoning_content / reasoning / thinking', async () => {
  for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
    const s = await sseServer([
      { choices: [{ delta: { [field]: '想到了' } }] },
      { choices: [{ delta: { content: '好' } }] },
    ]);
    try {
      const res = await mkClient(s.baseUrl).chat({ messages: [{ role: 'user', content: 'x' }] });
      assert.equal(res.reasoning, '想到了', `字段 ${field} 要被认出来`);
    } finally {
      await s.close();
    }
  }
});

test('★ 同一 chunk 三家都填时只取第一个非空，不重复拼', async () => {
  const s = await sseServer([
    { choices: [{ delta: { reasoning_content: 'A', reasoning: 'A', thinking: 'A' } }] },
    { choices: [{ delta: { content: '好' } }] },
  ]);
  try {
    const res = await mkClient(s.baseUrl).chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.reasoning, 'A', '同一段思考不能被拼三遍');
  } finally {
    await s.close();
  }
});

test('★ 思考内容绝不回灌：请求体里不能出现 reasoning', async () => {
  // 这是整个功能最容易犯的错：把 reasoning 拼回 messages → 上游 400
  const s = await sseServer([
    { choices: [{ delta: { reasoning_content: '秘密的思考过程' } }] },
    { choices: [{ delta: { content: '答案' } }] },
  ]);
  try {
    const res = await mkClient(s.baseUrl).chat({
      messages: [{ role: 'user', content: '第一问' }],
      onReasoningDelta: () => {},
    });
    assert.equal(res.reasoning, '秘密的思考过程');

    const body = JSON.stringify(s.bodies[0]);
    assert.ok(!body.includes('reasoning'), '请求体不能带 reasoning 字段');
    assert.ok(!body.includes('thinking'), '请求体不能带 thinking 字段');
    assert.ok(!body.includes('秘密的思考过程'), '思考正文不能出现在请求里');
  } finally {
    await s.close();
  }
});

test('非推理模型：没有思考字段时 reasoning 是空串，不报错', async () => {
  const s = await sseServer([
    { choices: [{ delta: { content: '直接答' } }] },
    { choices: [{ delta: {} }] },
  ]);
  try {
    const res = await mkClient(s.baseUrl).chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.reasoning, '');
    assert.equal(res.text, '直接答');
  } finally {
    await s.close();
  }
});

/* ---------------------------------------------------------------- 循环侧 */

test('★ runTurn 累积 thinkingTrace，且思考绝不进下一轮 messages', async () => {
  let i = 0;
  const calls = [];
  const script = [
    // 第一步：带思考 + 要工具
    {
      text: '',
      reasoning: '我需要先查一下资料。',
      toolCalls: [{ id: 'c1', name: 'web_search', arguments: '{"q":"天气"}' }],
    },
    // 第二步：带思考 + 最终回答
    { text: '今天下雨。', reasoning: '资料够了，可以回答。', toolCalls: [] },
  ];
  const runner = {
    availableTools: () => [
      {
        name: 'web_search',
        kind: 'host',
        risk: 'R0',
        origins: ['owner-private'],
        description: '搜',
        params: {},
      },
    ],
    run: async () => ({ ok: true, result: { content: '晴' } }),
  };
  const toOpenAiTools = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name } }));

  const res = await runTurn({
    llm: {
      async chat(req) {
        calls.push(JSON.parse(JSON.stringify(req.messages)));
        const step = script[Math.min(i, 1)];
        i += 1;
        return { ...step, usage: { totalTokens: 1 }, model: 'fake', cancelled: false };
      },
    },
    runner,
    toOpenAiTools,
    messages: [{ role: 'user', content: '今天天气？' }],
  });

  assert.equal(res.thinkingTrace.length, 2, '每步有思考就记一条');
  assert.equal(res.thinkingTrace[0].n, 1);
  assert.equal(res.thinkingTrace[0].reasoning, '我需要先查一下资料。');
  assert.deepEqual(res.thinkingTrace[0].tools, ['web_search'], '记下这步调了什么工具');
  assert.equal(res.thinkingTrace[1].n, 2);
  assert.equal(res.thinkingTrace[1].answerPreview, '今天下雨。');

  // 第二次请求里绝不能出现上一轮的思考文本
  const second = JSON.stringify(calls[1]);
  assert.ok(!second.includes('我需要先查一下资料'), '思考不能被抬进上下文');
});

test('runTurn：非推理模型时 thinkingTrace 是空数组', async () => {
  const llm = {
    async chat() {
      return { text: '答', toolCalls: [], usage: {}, model: 'fake', cancelled: false };
    },
  };
  const res = await runTurn({
    llm,
    runner: { availableTools: () => [], run: async () => ({ ok: true }) },
    toOpenAiTools: (t) => t,
    messages: [],
  });
  assert.deepEqual(res.thinkingTrace, []);
  assert.equal(res.text, '答');
});

/* ----------------------------------------------------- 「没有思考内容」也要能解释 */

test('★ 没有 reasoning 时不留空记录，但要留下可解释的标记', () => {
  /*
   * 这条钉的是一个真实踩过的坑：用户把模型从 `buddy/xxx` 改成 `xxx` 之后，
   * 上游不再返回 reasoning，于是思考链路永远不更新 —— 而页面上还挂着
   * 昨天那条记录，看起来一切正常，日志里也一个字都没有。
   *
   * 静默跳过本身是对的（不能拿空记录塞满界面），但必须留下"为什么"。
   */
  const store = new ThinkingStore({ dir: 'ignored-by-this-test', now: () => 1_800_000_000_000 });

  // 一开始没有标记
  assert.equal(store.view({ days: 1 }).lastSkip, null);

  store.noteNoReasoning({ convKey: 'group:111', at: 1_800_000_000_000 });
  const skip = store.view({ days: 1 }).lastSkip;
  assert.ok(skip, '要能读到"最近一回合没有思考内容"');
  assert.equal(skip.convKey, 'group:111');
  assert.equal(skip.at, 1_800_000_000_000);

  // 但数据本身必须还是干净的：没有多出空记录
  assert.deepEqual(store.view({ days: 7 }).days, []);
  assert.equal(store.view({ days: 7 }).total, 0);
});

test('★ 真的有思考内容之后，「没有思考内容」的标记要自动失效', async () => {
  const dir = await tmpDir();
  const store = new ThinkingStore({ dir, now: () => 1_800_000_000_000 });
  try {
    store.noteNoReasoning({ convKey: 'group:111', at: 1_800_000_000_000 });
    assert.ok(store.view({ days: 1 }).lastSkip);

    store.record({ convKey: 'group:111', at: 1_800_000_001_000, steps: [{ n: 1, reasoning: '这次有' }] });
    assert.equal(store.view({ days: 1 }).lastSkip, null, '有记录了就不该再说"没有思考内容"');
    assert.equal(store.view({ days: 1 }).total, 1);
  } finally {
    await store.flush();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('没有思考内容不影响 dayKeys / conversations（只影响那句提示）', () => {
  const store = new ThinkingStore({ dir: 'ignored-by-this-test', now: () => 1_800_000_000_000 });
  store.noteNoReasoning({ convKey: 'group:111' });
  const v = store.view({ days: 7 });
  assert.deepEqual(v.dayKeys, []);
  assert.deepEqual(v.conversations, []);
  assert.equal(v.total, 0);
});

/* --------------------------------------------- 换模型后要自己适配 reasoning 开关 */

test('★ 默认 auto 不往请求体里塞任何思考字段（不猜）', async () => {
  /*
   * 加错字段比不加更糟：有的上游见到不认识的键直接 400。
   * 所以"没有明确指定"时必须完全不碰请求体。
   */
  const s = await sseServer([{ choices: [{ delta: { content: '好' } }] }]);
  try {
    const c = new LlmClient({ baseUrl: s.baseUrl, model: 'x', apiKey: 'k', timeoutMs: 5000, maxRetries: 0 });
    await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const body = s.bodies[0];
    assert.ok(body, '请求体要能解析出来');
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.enable_thinking, undefined);
    // 基础字段不能因为合并而被弄丢
    assert.equal(body.model, 'x');
    assert.equal(body.stream, true);
  } finally {
    await s.close();
  }
});

test('★ 指定 thinking 风格时，请求体里要真的带上对应字段', async () => {
  const cases = [
    ['deepseek', (b) => assert.deepEqual(b.thinking, { type: 'enabled' })],
    ['openai', (b) => assert.equal(b.reasoning_effort, 'medium')],
    ['qwen', (b) => assert.equal(b.enable_thinking, true)],
    ['anthropic', (b) => assert.deepEqual(b.thinking, { type: 'enabled', budget_tokens: 4096 })],
    ['off', (b) => assert.equal(b.thinking, undefined)],
  ];

  for (const [style, check] of cases) {
    const s = await sseServer([{ choices: [{ delta: { content: '好' } }] }]);
    try {
      const c = new LlmClient({
        baseUrl: s.baseUrl,
        model: 'x',
        apiKey: 'k',
        timeoutMs: 5000,
        maxRetries: 0,
        thinking: style,
      });
      await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
      check(s.bodies[0]);
      // 无论哪种风格，业务字段都必须完好
      assert.equal(s.bodies[0].model, 'x', `${style}：model 不能被覆盖掉`);
      assert.equal(s.bodies[0].messages.length, 1);
    } finally {
      await s.close();
    }
  }
});

test('打开思考不影响 reasoning 的解析（字段名照旧三种都认）', async () => {
  const s = await sseServer([
    { choices: [{ delta: { reasoning_content: '想了' } }] },
    { choices: [{ delta: { content: '答' } }] },
  ]);
  try {
    const c = new LlmClient({
      baseUrl: s.baseUrl,
      model: 'x',
      apiKey: 'k',
      timeoutMs: 5000,
      maxRetries: 0,
      thinking: 'deepseek',
    });
    const res = await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.reasoning, '想了');
    assert.equal(res.text, '答');
  } finally {
    await s.close();
  }
});

test('未知的 thinking 值不会把请求弄坏（退回不注入）', async () => {
  const s = await sseServer([{ choices: [{ delta: { content: '好' } }] }]);
  try {
    const c = new LlmClient({
      baseUrl: s.baseUrl,
      model: 'x',
      apiKey: 'k',
      timeoutMs: 5000,
      maxRetries: 0,
      thinking: '不存在的风格',
    });
    await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(s.bodies[0].thinking, undefined, '认不出来就当没配，不能瞎发');
  } finally {
    await s.close();
  }
});
