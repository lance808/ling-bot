/**
 * 日记生成：从聊天到一篇总结 —— F5
 *
 * ## 这个文件在防什么
 *
 * 日记是"写下来就不会再看第二遍"的东西，所以它出错的方式往往是**静默**的：
 * 少了一天、内容空着、要点是编造的。用户不会立刻发现，等发现时
 * 已经找不回来了。
 *
 * 四条主线：
 *
 *   1. 模型可用 → 有真实总结；模型不可用 → 有**降级内容**（不是空文件）
 *   2. 摘要解析要宽容 —— 模型不按格式输出时不能把内容丢掉
 *   3. 摘录要截断 —— 活跃群一天几千条，全塞进去既超长又没用
 *   4. 生成失败时 store 仍被写入一条可读记录，degraded 标记要诚实
 *
 * 第 1 和第 4 条是重点：**宁可写一篇降级日记，也不要留空**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  buildDigest,
  buildSummaryPrompt,
  parseSummary,
  buildDegradedSummary,
  generateDiary,
  collectGroupsForDate,
  MAX_MESSAGES_PER_CONV,
  MAX_TEXT_CHARS,
  MAX_HIGHLIGHTS,
} from '../src/diary/generate.mjs';
import { DiaryStore } from '../src/diary/store.mjs';

/** 临时目录里的日记仓库 */
async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-diary-gen-'));
  return { store: new DiaryStore({ dir }), dir };
}

const groups = [
  {
    convKey: 'group:111',
    messages: [
      { nickname: '小明', text: '今天吃了火锅', userId: '1' },
      { nickname: '小红', text: '好羡慕，多少钱', userId: '2' },
    ],
  },
  { convKey: 'private:222', messages: [{ nickname: '老板', text: '明天九点开会', userId: '3' }] },
];

/* ------------------------------------------------------------ 摘录整理 */

test('摘录按会话分组，带条数与说话人', () => {
  const d = buildDigest(groups);
  assert.match(d.text, /群 111（2 条）/);
  assert.match(d.text, /私聊 222（1 条）/);
  assert.match(d.text, /小明：今天吃了火锅/);
  assert.equal(d.messageCount, 3);
  assert.deepEqual(d.convKeys, ['group:111', 'private:222']);
});

test('★ 摘录：单条过长要截断，不能让一条长文吃掉整份提示词', () => {
  const long = '啊'.repeat(MAX_TEXT_CHARS + 100);
  const d = buildDigest([{ convKey: 'group:1', messages: [{ nickname: 'x', text: long }] }]);
  assert.ok(d.text.length < long.length, '必须被截断');
  assert.match(d.text, /…$/);
});

test('★ 摘录：单会话消息数超上限时只取最近的', () => {
  const many = Array.from({ length: MAX_MESSAGES_PER_CONV + 20 }, (_, i) => ({
    nickname: 'u',
    text: `第 ${i} 条`,
  }));
  const d = buildDigest([{ convKey: 'group:1', messages: many }]);
  // 最近的应该在，最早的应该被砍掉
  assert.match(d.text, new RegExp(`第 ${many.length - 1} 条`));
  assert.ok(!d.text.includes('第 0 条'), '最早的应被截掉');
});

test('摘录：空内容返回空文本与 0 条', () => {
  const d = buildDigest([]);
  assert.equal(d.text, '');
  assert.equal(d.messageCount, 0);
  assert.deepEqual(d.convKeys, []);
});

test('摘录：无文本的消息被跳过（不能写出"小明："这种空行）', () => {
  const d = buildDigest([
    { convKey: 'group:1', messages: [{ nickname: 'x', text: '  ' }, { nickname: 'y', text: '有内容' }] },
  ]);
  assert.ok(!/^x：$/m.test(d.text));
  assert.match(d.text, /有内容/);
});

/* ------------------------------------------------------------ 提示词 */

test('提示词要求只写发生过的事（防编造）', () => {
  const msgs = buildSummaryPrompt('2026-03-10', '摘录内容');
  const system = msgs.find((m) => m.role === 'system')?.content ?? '';
  assert.match(system, /不要编造/);
  assert.match(system, /隐私|密码/);
  const user = msgs.find((m) => m.role === 'user')?.content ?? '';
  assert.match(user, /2026-03-10/);
  assert.match(user, /摘录内容/);
});

/* ------------------------------------------------------------ 摘要解析 */

test('摘要解析：能拆出要点', () => {
  const r = parseSummary('今天主要在聊吃的。\n- 小明吃了火锅\n- 老板要开会');
  assert.equal(r.summary, '今天主要在聊吃的。');
  assert.deepEqual(r.highlights, ['小明吃了火锅', '老板要开会']);
});

test('★ 摘要解析：模型混用多种列表符号也要能拆', () => {
  // 模型经常不按一种格式输出，硬要求一种会整天解析失败
  const r = parseSummary('概述在这。\n* 星号项\n1. 数字项\n2、顿号项\n• 圆点项');
  assert.equal(r.summary, '概述在这。');
  assert.equal(r.highlights.length, 4);
});

test('★ 摘要解析：没有要点行时，整段当概述而不是丢掉内容', () => {
  const r = parseSummary('今天大家就在闲聊，没什么正事。');
  assert.equal(r.summary, '今天大家就在闲聊，没什么正事。');
  assert.deepEqual(r.highlights, []);
});

test('摘要解析：空回复返回空', () => {
  assert.deepEqual(parseSummary(''), { summary: '', highlights: [] });
  assert.deepEqual(parseSummary(null), { summary: '', highlights: [] });
});

test('摘要解析：要点数量与长度有上限', () => {
  const text = Array.from({ length: MAX_HIGHLIGHTS + 10 }, (_, i) => `- 要点 ${i}`).join('\n');
  const r = parseSummary(text);
  assert.equal(r.highlights.length, MAX_HIGHLIGHTS, '要点数量要封顶');
});

/* ------------------------------------------------------------ 降级内容 */

test('★ 降级日记：模型不可用时仍有可读内容与要点', () => {
  const d = buildDigest(groups);
  const deg = buildDegradedSummary('2026-03-10', d);
  assert.match(deg.summary, /2026-03-10/);
  assert.match(deg.summary, /3 条消息/);
  assert.match(deg.summary, /没有生成总结/);
  assert.ok(deg.highlights.length > 0, '降级也要有要点，不能全空');
});

test('★ 降级日记：摘录三种传法都产出要点（防静默变空）', () => {
  const d = buildDigest(groups);
  const forms = [
    d, // 直接传 buildDigest 的返回值
    d.text, // 纯字符串
    { digest: d.text }, // 包一层字符串
    { digest: d }, // 包一层对象
  ];
  for (const f of forms) {
    const r = buildDegradedSummary('2026-03-10', f);
    assert.ok(r.highlights.length > 0, `${typeof f} 形式的入参要点不该为空`);
  }
});

test('降级日记：零消息时给出说明而不是空串', () => {
  const deg = buildDegradedSummary('2026-03-10', { messageCount: 0, convKeys: [], digest: '' });
  assert.match(deg.summary, /没有可摘录/);
  assert.ok(deg.summary.length > 0);
});

test('降级日记：跳过分组标题行（那是结构不是内容）', () => {
  const deg = buildDegradedSummary('2026-03-10', {
    messageCount: 1,
    convKeys: ['group:1'],
    digest: '## 群 1（1 条）\n小明：你好',
  });
  assert.ok(!deg.highlights.some((h) => h.startsWith('##')));
  assert.deepEqual(deg.highlights, ['小明：你好']);
});

/* ------------------------------------------------------------ 端到端 */

test('★ 端到端：模型可用时写入真实总结，degraded=false', async () => {
  const { store } = await makeStore();
  const r = await generateDiary({
    date: '2026-03-10',
    groups,
    store,
    model: 'deepseek-chat',
    llm: {},
    // 注入一个假的对话函数，不真的发请求
    chat: async () => '今天主要在聊吃的和开会。\n- 小明吃了火锅\n- 老板要求明天九点开会',
  });

  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.messageCount, 3);

  const rec = store.get('2026-03-10');
  assert.match(rec.summary, /聊吃的和开会/);
  assert.equal(rec.highlights.length, 2);
  assert.equal(rec.degraded, false);
  assert.equal(rec.model, 'deepseek-chat');
  assert.equal(rec.source.messageCount, 3);
});

test('★ 端到端：模型抛异常时降级写入，degraded=true 且有原因', async () => {
  const { store } = await makeStore();
  const r = await generateDiary({
    date: '2026-03-11',
    groups,
    store,
    model: 'deepseek-chat',
    llm: {},
    chat: async () => {
      throw new Error('上游 500');
    },
  });

  assert.equal(r.ok, true, '生成失败也不能让调用方以为整体失败');
  assert.equal(r.degraded, true);
  assert.match(String(r.error), /500/);

  const rec = store.get('2026-03-11');
  assert.equal(rec.degraded, true);
  assert.match(rec.summary, /没有生成总结/);
  assert.ok(rec.highlights.length > 0, '降级也要有摘录');
  assert.equal(rec.model, '', '降级时不该把模型名记成生成者');
});

test('★ 端到端：完全没配 LLM 时也要写一篇（不能空着）', async () => {
  const { store } = await makeStore();
  const r = await generateDiary({ date: '2026-03-12', groups, store, llm: null });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.match(String(r.error), /未配置|不可用/);
  assert.ok(store.has('2026-03-12'), '必须真的写进去');
});

test('端到端：当天零消息也记一条（否则日记页会缺一天）', async () => {
  const { store } = await makeStore();
  const r = await generateDiary({ date: '2026-03-13', groups: [], store });
  assert.equal(r.ok, true);
  assert.equal(r.messageCount, 0);
  assert.ok(store.has('2026-03-13'));
  assert.match(store.get('2026-03-13').summary, /没有可摘录/);
});

test('端到端：模型返回空内容算降级，不写空日记', async () => {
  const { store } = await makeStore();
  const r = await generateDiary({
    date: '2026-03-14',
    groups,
    store,
    llm: {},
    chat: async () => '   ',
  });
  assert.equal(r.degraded, true);
  assert.match(String(r.error), /空内容/);
  assert.ok(store.get('2026-03-14').summary.length > 0);
});

test('端到端：不覆盖已锁定的日记的权重基准', async () => {
  const { store } = await makeStore();
  // 先写一条并锁定
  await generateDiary({ date: '2026-03-15', groups, store, llm: null });
  await store.lock('2026-03-15');
  const before = store.get('2026-03-15');
  assert.equal(before.locked, true);

  // 再生成一次（模拟重试）
  await generateDiary({
    date: '2026-03-15',
    groups,
    store,
    llm: {},
    chat: async () => '新的总结\n- 新要点',
  });

  const after = store.get('2026-03-15');
  assert.equal(after.locked, true, '重新生成不能把用户钉住的日记解锁');
  assert.equal(after.weightBaseDate, before.weightBaseDate);
});

/* ------------------------------------------------------ 按日期取消息 */

test('★ collectGroupsForDate 只取当天的消息', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-diary-collect-'));
  const { SessionStore } = await import('../src/session/store.mjs');
  const { localDateKey } = await import('../src/diary/decay.mjs');

  const sessionStore = new SessionStore({ filePath: path.join(dir, 'sessions.json') });
  sessionStore.append('group:1', {
    sender: { userId: '1', nickname: 'a' },
    text: '今天的',
    time: Math.floor(Date.now() / 1000),
  });

  const today = localDateKey(Date.now());
  const g = collectGroupsForDate(sessionStore, today, localDateKey);
  assert.equal(g.length, 1);
  assert.equal(g[0].messages.length, 1);
  assert.equal(g[0].messages[0].text, '今天的');
});

test('collectGroupsForDate：不存在的日期返回空数组', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-diary-collect-'));
  const { SessionStore } = await import('../src/session/store.mjs');
  const { localDateKey } = await import('../src/diary/decay.mjs');
  const sessionStore = new SessionStore({ filePath: path.join(dir, 'sessions.json') });

  assert.deepEqual(collectGroupsForDate(sessionStore, '2020-01-01', localDateKey), []);
});
