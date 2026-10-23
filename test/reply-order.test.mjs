/**
 * 回复顺序与上下文纯净性 —— 「回复混乱」的回归测试
 *
 * 这个文件断言的是**四条具体的机制**，不是"感觉对了"：
 *
 *   1. 自己发的消息不能以「群友」的身份回到上下文里
 *   2. 同一条消息重复投递只能产生一次处理
 *   3. 连着的两条强触发都要被回复，且顺序不能颠倒
 *   4. 队列满时的丢弃行为是可预测的，不是静默乱丢
 *
 * 为什么值得单独成一个测试文件：这四条里有三条是**静默**故障 ——
 * 没有异常、没有错误码，只是"机器人接了自己的话""连问两句只回一句"。
 * 没有断言钉住的化，这类回归下次改代码时不会再有人发现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isSelfMessage, MessageDedup, TurnQueue } from '../src/session/inbound.mjs';
import { buildMessages } from '../src/llm/prompt.mjs';

/* ------------------------------------------------------------------ 自消息 */

const msg = (userId, text = 'hi') => ({ sender: { userId, nickname: `u${userId}` }, text });

test('自消息识别：拿 selfId 比对发送者', () => {
  assert.equal(isSelfMessage(msg('10001'), '10001'), true);
  assert.equal(isSelfMessage(msg('10002'), '10001'), false);
});

test('★ selfId 未知时不能把所有消息都判成自消息', () => {
  /*
   * 这是有意的保守方向：拿不到 selfId 时如果返回 true，
   * 整个机器人会对所有消息失聪 —— 比"漏过一条自己的消息"严重得多。
   */
  assert.equal(isSelfMessage(msg('10001'), ''), false);
  assert.equal(isSelfMessage(msg('10001'), null), false);
  assert.equal(isSelfMessage(msg('10001'), undefined), false);
});

test('缺少 sender / userId 时不判为自消息', () => {
  assert.equal(isSelfMessage({}, '10001'), false);
  assert.equal(isSelfMessage(null, '10001'), false);
  assert.equal(isSelfMessage({ sender: {} }, '10001'), false);
});

test('★ 自消息进上下文必须是 assistant 角色，不能伪装成群友', () => {
  /*
   * 这条是「回复混乱」最直接的来源：
   * 自己刚说的话若以 `user` 身份 + 自己的昵称进入 messages，
   * 模型会把它当成"群友说的"，然后接自己的话、重复自己。
   */
  const built = buildMessages({
    persona: '',
    role: '',
    context: {
      convKey: 'group:123',
      isGroup: true,
      // 模拟 index.mjs 修正后的推入方式
      recent: [
        { role: 'user', nickname: '群友A', text: '今天吃什么' },
        { role: 'assistant', text: '随便' },
        { role: 'user', nickname: '群友A', text: '那我定' },
      ],
    },
  });

  const contents = built.map((m) => `${m.role}:${m.content}`);
  // 自己的话必须以 assistant 出现，且原文不再带「自己昵称：」前缀
  assert.ok(contents.includes('assistant:随便'), '自己的话要作为 assistant 消息');
  assert.ok(
    !contents.some((c) => c.startsWith('user:') && c.includes('随便')),
    '自己的话不能被当成群友发言回灌',
  );
});

/* ------------------------------------------------------------------ 去重 */

test('去重：同一条只放行一次', () => {
  const d = new MessageDedup();
  assert.equal(d.markSeen('group:1', 100), false, '第一次应放行');
  assert.equal(d.markSeen('group:1', 100), true, '第二次应判定为重复');
});

test('去重按会话隔离：不同会话的同号消息互不影响', () => {
  const d = new MessageDedup();
  assert.equal(d.markSeen('group:1', 100), false);
  assert.equal(d.markSeen('group:2', 100), false, '另一个群的同一 messageId 不是重复');
});

test('★ 没有 messageId 时不去重（宁可重复也不丢）', () => {
  // 丢一条消息用户会以为机器人坏了；重复一条至少对话还能继续
  const d = new MessageDedup();
  assert.equal(d.markSeen('group:1', null), false);
  assert.equal(d.markSeen('group:1', null), false);
  assert.equal(d.markSeen('group:1', ''), false);
  assert.equal(d.size, 0, '没有 id 的调用不应占用去重表');
});

test('去重容量上限：超出后丢最早的，不会无限增长', () => {
  const d = new MessageDedup({ capacity: 3 });
  for (const id of [1, 2, 3]) d.markSeen('group:1', id);
  assert.equal(d.size, 3);
  d.markSeen('group:1', 4);
  assert.equal(d.size, 3, '容量封顶');
  // 最早的那条被淘汰，因此再次收到会被当成新消息放行
  assert.equal(d.markSeen('group:1', 1), false, '被淘汰的旧 id 不再视为重复');
  assert.equal(d.markSeen('group:1', 4), true, '仍在表内的 id 依然算重复');
});

test('去重 TTL：过期后同一条可以再次放行', () => {
  let now = 1_000_000;
  const d = new MessageDedup({ ttlMs: 1000, now: () => now });
  assert.equal(d.markSeen('group:1', 7), false);
  now += 500;
  assert.equal(d.markSeen('group:1', 7), true, 'TTL 内算重复');
  now += 2000;
  assert.equal(d.markSeen('group:1', 7), false, '过期后重新放行（内存不会永久占着）');
});

/* ------------------------------------------------------------------ 队列 */

test('队列：先进先出，不能覆盖', () => {
  const q = new TurnQueue({ limit: 5 });
  q.push('group:1', { trigger: 'at', reason: 'first' });
  q.push('group:1', { trigger: 'at', reason: 'second' });

  assert.equal(q.size('group:1'), 2);
  assert.equal(q.shift('group:1').reason, 'first', '先来的先被消费');
  assert.equal(q.shift('group:1').reason, 'second');
  assert.equal(q.shift('group:1'), null);
});

test('★ 两条强触发都要被回复（单槽 Map 会丢掉第一条）', () => {
  /*
   * 这正是老实现的 bug：pendingTurns 是 Map<string, job>，
   * 第二条 set 直接覆盖第一条，第一条永远不会被回复。
   */
  const q = new TurnQueue({ limit: 5 });
  const jobs = ['问A', '问B'].map((r) => ({ trigger: 'at', reason: r }));
  for (const job of jobs) q.push('group:1', job);

  const answered = [];
  let next;
  while ((next = q.shift('group:1'))) answered.push(next.reason);

  assert.deepEqual(answered, ['问A', '问B'], '两条都回复，且顺序与提问一致');
});

test('队列上限：超限丢最旧，并回报丢了哪一条', () => {
  const q = new TurnQueue({ limit: 2 });
  assert.equal(q.push('group:1', { reason: 'a' }).dropped, null);
  assert.equal(q.push('group:1', { reason: 'b' }).dropped, null);
  const third = q.push('group:1', { reason: 'c' });
  assert.equal(third.dropped?.reason, 'a', '丢的是最旧那条');
  assert.equal(third.length, 2, '长度不超过上限');
  assert.equal(q.shift('group:1').reason, 'b');
});

test('队列按会话隔离', () => {
  const q = new TurnQueue({ limit: 5 });
  q.push('group:1', { reason: 'g1' });
  q.push('private:2', { reason: 'p2' });
  assert.equal(q.size('group:1'), 1);
  assert.equal(q.size('private:2'), 1);
  assert.equal(q.total, 2);
  assert.equal(q.shift('group:1').reason, 'g1');
  assert.equal(q.size('group:1'), 0);
  assert.equal(q.size('private:2'), 1, '别的会话不受影响');
});

test('空队列 shift 返回 null，且不残留空数组', () => {
  const q = new TurnQueue({ limit: 5 });
  assert.equal(q.shift('group:none'), null);
  q.push('group:1', { reason: 'x' });
  q.shift('group:1');
  assert.equal(q.size('group:1'), 0);
  assert.equal(q.total, 0);
});

test('triggers 只暴露触发类型，不泄漏 job 本体', () => {
  const q = new TurnQueue({ limit: 5 });
  q.push('group:1', { trigger: 'at', evt: { text: '敏感内容' } });
  assert.deepEqual(q.triggers('group:1'), ['at']);
});

test('非法 limit 回落到默认值', () => {
  for (const bad of [0, -1, NaN, 'x', null, undefined]) {
    const q = new TurnQueue({ limit: /** @type {any} */ (bad) });
    for (let i = 0; i < 6; i++) q.push('group:1', { reason: String(i) });
    assert.equal(q.size('group:1'), 5, `limit=${String(bad)} 应回落到 5`);
  }
});
