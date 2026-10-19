/**
 * DSH 桥的指令解析与审批队列
 *
 * 这里测的都是"人会怎么用"而不是"代码怎么写"：
 * 半角全角、有无空格、编号对不对得上、超时怎么办。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand, parseDuration, formatPendingList } from '../plugins/dsh-bridge/lib/command.mjs';
import { DshBridge } from '../plugins/dsh-bridge/lib/bridge.mjs';

/* ---------------------------------------------------------------- 时长 */

test('时长解析认各种写法', () => {
  assert.equal(parseDuration('10分钟'), 600_000);
  assert.equal(parseDuration('10分'), 600_000);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('30秒'), 30_000);
  assert.equal(parseDuration('1小时'), 3_600_000);
  assert.equal(parseDuration('2时'), 7_200_000);
  // 无单位按分钟 —— "免打扰10" 最自然的理解
  assert.equal(parseDuration('10'), 600_000);
});

test('时长解析对垃圾输入返回 0 而不是瞎猜', () => {
  for (const bad of ['', 'abc', '0', '-5', '十分钟', null, undefined]) {
    assert.equal(parseDuration(/** @type {any} */ (bad)), 0, `输入 ${bad}`);
  }
});

/* ---------------------------------------------------------------- 前缀指令 */

test('/dsh 前缀的内容原样作为指令', () => {
  const p = parseCommand('/dsh 帮我看一下日志');
  assert.equal(p.kind, 'command');
  assert.equal(p.text, '帮我看一下日志');
});

test('#dsh 也认', () => {
  const p = parseCommand('#dsh ls -la');
  assert.equal(p.kind, 'command');
  assert.equal(p.text, 'ls -la');
});

test('★ 前缀指令的内容不会被关键词规则抢走', () => {
  // 指令正文恰好是"同意"，不能被当成审批回复
  const p = parseCommand('/dsh 同意', { pendingIds: ['3'] });
  assert.equal(p.kind, 'command');
  assert.equal(p.text, '同意');
});

test('空的 /dsh 给出用法而不是静默失败', () => {
  const p = parseCommand('/dsh');
  assert.equal(p.kind, 'unknown');
  assert.match(p.reason, /用法/);
});

/* ---------------------------------------------------------------- 审批回复 */

test('同意 / 拒绝的各种说法', () => {
  for (const s of ['同意 3', '同意3', '3 同意', '3同意', '批准 3', '通过 3', 'yes 3', 'ok 3']) {
    const p = parseCommand(s, { pendingIds: ['3'] });
    assert.equal(p.kind, 'approve', `输入：${s}`);
    assert.equal(p.id, '3');
  }
  for (const s of ['拒绝 3', '拒绝3', '3 拒绝', '不同意 3', '驳回 3', 'no 3', 'deny 3']) {
    const p = parseCommand(s, { pendingIds: ['3'] });
    assert.equal(p.kind, 'reject', `输入：${s}`);
  }
});

test('★ 编号不在册时明确拒绝，绝不猜', () => {
  const p = parseCommand('同意 7', { pendingIds: ['3'] });
  assert.equal(p.kind, 'unknown');
  assert.match(p.reason, /7/);
  // 要告诉用户现在有哪些编号可批
  assert.match(p.reason, /3/);
});

test('没有任何待审批时说清楚', () => {
  const p = parseCommand('同意 1', { pendingIds: [] });
  assert.equal(p.kind, 'unknown');
  assert.match(p.reason, /没有待审批/);
});

test('只有一条待审批时允许省略编号', () => {
  const p = parseCommand('同意', { pendingIds: ['5'] });
  assert.equal(p.kind, 'approve');
  assert.equal(p.id, '5');
});

test('★ 多条待审批时省略编号必须拒绝（不能挑一条批）', () => {
  const p = parseCommand('同意', { pendingIds: ['1', '2'] });
  assert.equal(p.kind, 'unknown');
  assert.match(p.reason, /编号/);
});

test('单说"同意"但没待审批，不会凭空批', () => {
  const p = parseCommand('同意', { pendingIds: [] });
  assert.equal(p.kind, 'unknown');
});

/* ---------------------------------------------------------------- 免打扰 */

test('免打扰的各种写法', () => {
  assert.deepEqual(parseCommand('免打扰 30分钟'), { kind: 'quiet', ms: 1_800_000 });
  assert.deepEqual(parseCommand('安静 1小时'), { kind: 'quiet', ms: 3_600_000 });
  assert.deepEqual(parseCommand('放行10分钟'), { kind: 'quiet', ms: 600_000 });
  // 不给时长默认 10 分钟
  assert.deepEqual(parseCommand('免打扰'), { kind: 'quiet', ms: 600_000 });
});

test('取消免打扰', () => {
  assert.equal(parseCommand('取消免打扰').kind, 'unquiet');
});

/* ---------------------------------------------------------------- 普通聊天 */

test('★ 普通聊天不会被当成给 DSH 的指令', () => {
  for (const s of ['今天天气不错', '你好', '哈哈哈', '在吗', '1', '3']) {
    const p = parseCommand(s, { pendingIds: ['3'] });
    assert.notEqual(p.kind, 'command', `输入：${s} 不该变成指令`);
  }
});

/* ---------------------------------------------------------------- 桥：审批队列 */

/** 造一个不接 QQ 的桥，用于测纯逻辑 */
function makeBridge() {
  /** @type {any[]} */
  const asked = [];
  const b = new DshBridge({
    token: 'test-token',
    onAsk: async (r) => {
      asked.push(r);
    },
  });
  return { bridge: b, asked };
}

test('★ 免打扰期内审批直接放行，不推 QQ', async () => {
  const { bridge, asked } = makeBridge();
  bridge.quiet(60_000);
  const outcome = await bridge.ask({ toolName: 'fs_write' });
  assert.equal(outcome, 'allowed-once');
  assert.equal(asked.length, 0, '免打扰期间不该打扰用户');
});

test('免打扰有上限，不能设成永久', () => {
  const { bridge } = makeBridge();
  const ms = bridge.quiet(999 * 3600_000);
  assert.ok(ms <= 3600_000, `实际 ${ms} 应被截断到 1 小时内`);
});

test('取消免打扰后恢复正常询问', async () => {
  const { bridge, asked } = makeBridge();
  bridge.quiet(60_000);
  bridge.unquiet();
  const p = bridge.ask({ toolName: 'fs_write' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asked.length, 1);
  // 把它答掉，否则测试挂住
  bridge.answer(asked[0].id, 'rejected');
  assert.equal(await p, 'rejected');
});

test('回答审批把结论传给等待方', async () => {
  const { bridge, asked } = makeBridge();
  const p = bridge.ask({ toolName: 'shell', reason: '要跑命令' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].toolName, 'shell');
  bridge.answer(asked[0].id, 'allowed-once');
  assert.equal(await p, 'allowed-once');
});

test('回答不存在的编号会明确报错', () => {
  const { bridge } = makeBridge();
  const r = bridge.answer('99', 'allowed-once');
  assert.equal(r.ok, false);
  assert.match(r.error, /99/);
});

test('★ 结论词表外的值一律拒绝', () => {
  const { bridge } = makeBridge();
  for (const bad of ['ok', 'yes', 'allowed', 'true', '', 'rejected-all']) {
    const r = bridge.answer('1', bad);
    assert.equal(r.ok, false, `不该接受 ${bad}`);
  }
});

test('令牌比对：错的就是错的', () => {
  const { bridge } = makeBridge();
  assert.equal(bridge.checkToken('test-token'), true);
  assert.equal(bridge.checkToken('test-toke'), false);
  assert.equal(bridge.checkToken('test-tokenx'), false);
  assert.equal(bridge.checkToken(''), false);
});

test('★ 没配令牌时拒绝一切（不是放行一切）', () => {
  const b = new DshBridge({ token: '', onAsk: async () => {} });
  assert.equal(b.enabled, false);
  assert.equal(b.checkToken(''), false);
  assert.equal(b.checkToken('anything'), false);
});

/* ---------------------------------------------------------------- 桥：指令 */

test('指令能投递给 DSH', async () => {
  /** @type {any[]} */
  const got = [];
  const b = new DshBridge({
    token: 't',
    onAsk: async () => {},
    onCommand: async (c) => {
      got.push(c);
    },
  });
  const r = await b.command({ text: '看看日志', from: '10001' });
  assert.equal(r.ok, true);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '看看日志');
});

test('★ 指令投递失败要明确报错，不能假装成功', async () => {
  const b = new DshBridge({
    token: 't',
    onAsk: async () => {},
    onCommand: async () => {
      throw new Error('DSH 没连上');
    },
  });
  const r = await b.command({ text: '干活' });
  assert.equal(r.ok, false);
  assert.match(r.error, /DSH 没连上/);
});

test('空指令被拒', async () => {
  const b = new DshBridge({ token: 't', onAsk: async () => {} });
  assert.equal((await b.command({ text: '   ' })).ok, false);
});

/* ---------------------------------------------------------------- 展示 */

test('待审批列表为空时说人话', () => {
  assert.match(formatPendingList([]), /没有待审批/);
});

test('多条待审批合并成一条，不刷屏', () => {
  const text = formatPendingList([
    { id: '1', toolName: 'fs_write', reason: '要写文件' },
    { id: '2', toolName: 'shell', reason: '要跑命令' },
  ]);
  assert.match(text, /2 条/);
  assert.match(text, /\[1\]/);
  assert.match(text, /\[2\]/);
  // 一次发送，不是两条消息
  assert.equal(text.includes('\n\n'), true);
});
