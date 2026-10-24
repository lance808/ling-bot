/**
 * DSH 桥的指令解析与审批队列
 *
 * 这里测的都是"人会怎么用"而不是"代码怎么写"：
 * 半角全角、有无空格、编号对不对得上、超时怎么办。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { parseCommand, parseDuration, formatPendingList } from '../plugins/dsh-bridge/lib/command.mjs';
import { DshBridge } from '../plugins/dsh-bridge/lib/bridge.mjs';
import plugin from '../plugins/dsh-bridge/index.mjs';

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

/** 造一个连 onNotify 也记下来的桥（撤销通知用） */
function makeBridgeWithNotify() {
  /** @type {any[]} */
  const asked = [];
  /** @type {any[]} */
  const notified = [];
  const b = new DshBridge({
    token: 'test-token',
    onAsk: async (r) => {
      asked.push(r);
    },
    onNotify: (info) => {
      notified.push(info);
    },
  });
  return { bridge: b, asked, notified };
}

/** 让出一个事件循环轮次：推送是异步发的 */
const tick = () => new Promise((r) => setTimeout(r, 20));

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

/* ---------------------------------------------------------------- 桥：两段式 */

test('★ askStart 立刻回编号，不等结论', async () => {
  const { bridge, asked } = makeBridge();
  const start = bridge.askStart({ toolName: 'fs_write', reason: '要写 README' });

  assert.match(String(start.id), /^\d+$/);
  assert.equal(start.outcome, undefined, '正常登记不该带结论');

  await tick();
  assert.equal(asked.length, 1, '登记之后必须推出去，否则用户永远不知道要回答');
  assert.equal(asked[0].id, start.id);
  assert.equal(asked[0].kind, 'approval');
  assert.equal(asked[0].toolName, 'fs_write');

  const waiting = bridge.awaitResult(start.id);
  bridge.answer(start.id, 'allowed-once');
  assert.deepEqual(await waiting, {
    status: 'answered',
    kind: 'approval',
    outcome: 'allowed-once',
  });
});

test('★ 免打扰时 askStart 不给编号，直接放行', async () => {
  const { bridge, asked } = makeBridge();
  bridge.quiet(60_000);

  const start = bridge.askStart({ toolName: 'fs_write' });
  assert.equal(start.id, null, '没有待回复就没有编号可给');
  assert.equal(start.outcome, 'allowed-once');

  await tick();
  assert.equal(asked.length, 0, '免打扰期间不该打扰用户');
  // 没有编号自然也没有结论可等
  assert.equal((await bridge.awaitResult(start.id)).status, 'unknown');
});

test('提问走两段式：答案按当次选项表翻译', async () => {
  const { bridge, asked } = makeBridge();
  const questions = [
    {
      id: 'q1',
      header: '改哪里',
      question: '要改哪个文件？',
      options: [{ label: 'README.md' }, { label: 'src/index.mjs' }],
    },
  ];

  const start = bridge.askQuestionStart({ questions });
  assert.match(String(start.id), /^\d+$/);
  await tick();
  assert.equal(asked[0].kind, 'question');

  const waiting = bridge.awaitResult(start.id);
  // 用户回 2 = 第二项；交给 DSH 的必须是**选项文案**而不是编号
  assert.equal(bridge.reply(start.id, '2').ok, true);

  const r = await waiting;
  assert.equal(r.status, 'answered');
  assert.equal(r.kind, 'question');
  assert.deepEqual(r.answer, {
    answers: [{ id: 'q1', selected: ['src/index.mjs'] }],
  });
});

test('没有可选项的提问不产生待回复（没法回数字）', () => {
  const { bridge } = makeBridge();
  const start = bridge.askQuestionStart({ questions: [{ id: 'q1', question: '说说看' }] });
  assert.equal(start.id, null);
  assert.equal(bridge.listPending().length, 0);
});

test('★ withdraw 让等待方拿到 withdrawn，并通知 QQ 侧', async () => {
  const { bridge, notified } = makeBridgeWithNotify();
  const start = bridge.askStart({ toolName: 'fs_write' });
  const waiting = bridge.awaitResult(start.id);

  assert.deepEqual(bridge.withdraw(start.id, 'desktop'), { ok: true, removed: true });

  const r = await waiting;
  assert.equal(r.status, 'withdrawn', '撤销不能表现成超时或拒绝');
  assert.equal(r.reason, 'desktop');

  await tick();
  assert.equal(notified.length, 1, '撤销后要告诉 QQ 侧别回了');
  assert.equal(notified[0].id, start.id);
  assert.equal(notified[0].reason, 'desktop');

  assert.deepEqual(bridge.listPending(), [], '作废的请求不能还挂在队列里');
});

test('★ withdraw 之后再用编号回复必须报错', () => {
  const { bridge } = makeBridgeWithNotify();
  const start = bridge.askStart({ toolName: 'fs_write' });
  bridge.withdraw(start.id, 'desktop');

  const r = bridge.reply(start.id, '1');
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(String(start.id)));
  // 直接指定结论的老入口也一样：不能对已撤销的请求翻案
  assert.equal(bridge.answer(start.id, 'allowed-once').ok, false);
});

test('withdraw 不存在的编号明确报错，也不发通知', async () => {
  const { bridge, notified } = makeBridgeWithNotify();
  const r = bridge.withdraw('42', 'desktop');
  assert.equal(r.ok, false);
  assert.equal(r.removed, false);
  assert.match(r.error, /42/);
  await tick();
  assert.equal(notified.length, 0);
});

test('没有 onNotify 时 withdraw 也不炸（回调是可选的）', async () => {
  const { bridge } = makeBridge();
  const start = bridge.askStart({ toolName: 'shell' });
  assert.equal(bridge.withdraw(start.id, 'desktop').ok, true);
  await tick();
  assert.deepEqual(bridge.listPending(), []);
});

test('★ 同一条只能 await 一次（结论不能被取两次）', async () => {
  const { bridge } = makeBridge();
  const start = bridge.askStart({ toolName: 'shell' });
  const waiting = bridge.awaitResult(start.id);
  bridge.answer(start.id, 'rejected');
  assert.equal((await waiting).status, 'answered');
  assert.equal((await bridge.awaitResult(start.id)).status, 'unknown');
});

test('await 未知编号回 unknown，不抛错', async () => {
  const { bridge } = makeBridge();
  assert.equal((await bridge.awaitResult('99')).status, 'unknown');
  assert.equal((await bridge.awaitResult(undefined)).status, 'unknown');
});

test('ask()/askQuestion() 仍是登记 + 等待的包装', async () => {
  const { bridge, asked } = makeBridge();

  const p = bridge.ask({ toolName: 'shell' });
  await tick();
  assert.equal(asked.length, 1);
  bridge.reply(asked[0].id, '2'); // 审批的第 2 项 = 拒绝
  assert.equal(await p, 'rejected');

  const q = bridge.askQuestion({
    questions: [{ id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] }],
  });
  await tick();
  const qid = bridge.listPending()[0].id;
  bridge.reply(qid, '1');
  assert.deepEqual(await q, { answers: [{ id: 'q1', selected: ['A'] }] });
});

test('★ 撤销之后 ask() 返回 unavailable（QQ 这边没有结论）', async () => {
  const { bridge } = makeBridge();
  const p = bridge.ask({ toolName: 'shell' });
  await tick();
  const id = bridge.listPending()[0].id;
  bridge.withdraw(id, 'desktop');
  assert.equal(await p, 'unavailable');
});

test('★ 超时回 timeout，ask() 转成 unavailable（不能猜成同意或拒绝）', async () => {
  // 只给 30ms：测的是"没人回答"这条路径，不是真等两分钟
  const b = new DshBridge({ token: 't', onAsk: async () => {}, timeoutMs: 30 });

  const start = b.askStart({ toolName: 'shell' });
  assert.deepEqual(await b.awaitResult(start.id), { status: 'timeout' });

  assert.equal(await b.ask({ toolName: 'shell' }), 'unavailable');
});

test('shutdown 让还在等的请求拿到 cancelled（进程退出不把 DSH 卡住）', async () => {
  const { bridge } = makeBridge();
  const start = bridge.askStart({ toolName: 'shell' });
  const waiting = bridge.awaitResult(start.id);
  bridge.shutdown();
  assert.equal((await waiting).status, 'cancelled');
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

/* ---------------------------------------------------------------- 宿主 gate（消息接管边界） */

const GATE_TOKEN = 'gate-test-token';
const ADMIN_ID = '10001';

/** 起一个真的桥插件（随机空闲端口），并把推送/回执都记下来 */
async function bootPlugin(t) {
  /*
   * 端口用 0 先问系统要一个，再放开给插件：插件配置层不接受 0
   * （normalizePort 会把 0 当成脏值退默认端口，可能撞上真实桥）。
   */
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  /** @type {any[]} 插件推给 QQ 的审批消息 */
  const pushed = [];
  /** @type {any[]} 回执消息 */
  const receipts = [];
  const sendText = async (convKey, text) => {
    const messageId = `mid-${pushed.length + receipts.length + 1}`;
    pushed.push({ convKey, text, messageId });
    return { ok: true, messageId };
  };
  const replyText = async (convKey, text) => {
    receipts.push({ convKey, text });
    return { ok: true };
  };
  const ctx = {
    config: { token: GATE_TOKEN, admins: ADMIN_ID, port },
    secrets: {},
    log: () => {},
    sendText,
  };
  const init = await plugin.init(ctx);
  assert.equal(init.ok, true, `桥应该能起来：${init.message}`);
  t.after(async () => {
    plugin.dispose(ctx).catch(() => {});
  });
  return { port, pushed, receipts, ctx, replyText };
}

/** 直接打插件起的本地桥路由 */
async function post(port, path, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GATE_TOKEN}` },
    body: JSON.stringify(body),
  });
  return await res.json();
}

/** 等一个条件成立 */
async function waitFor(fn, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 管理员私聊事件 */
function adminEvt(extra = {}) {
  return {
    convKey: `private:${ADMIN_ID}`,
    isGroup: false,
    sender: { userId: ADMIN_ID },
    text: '1',
    ...extra,
  };
}

test('★ 宿主 confirmPending 时，不带引用的「1」不得被 DSH 抢走（带引用仍生效）', async (t) => {
  const app = await bootPlugin(t);
  const start = await post(app.port, '/dsh/ask', { toolName: 'fs_write', reason: '要写 README' });
  await waitFor(() => app.pushed.length === 1);
  const messageId = app.pushed[0].messageId;
  const id = String(start.id);
  assert.equal((await post(app.port, '/qq/pending')).items.length, 1);

  /*
   * 宿主确认卡也在等：这句不带引用的「1」指代不明，必须让宿主接手。
   * 旧实现会按"恰好一条待回复"把 DSH 这条批掉，宿主的确认卡随后被拒。
   */
  const taken = await plugin.handleMessage({
    evt: adminEvt({ text: '1' }),
    sendText: app.replyText,
    ctx: app.ctx,
    gate: { whitelisted: true, silenced: false, confirmPending: true },
  });
  assert.equal(taken, false, 'confirmPending 时不得接管不带引用的确认回复');
  assert.equal((await post(app.port, '/qq/pending')).items.length, 1, 'DSH 那条必须原样挂着');

  // 带引用 = 已消歧：仍然按 messageId 精确认领，不受 confirmPending 影响
  const quoted = await plugin.handleMessage({
    evt: adminEvt({ text: '1', replyTo: { messageId } }),
    sendText: app.replyText,
    ctx: app.ctx,
    gate: { whitelisted: true, silenced: false, confirmPending: true },
  });
  assert.equal(quoted, true, '带引用的 DSH 审批必须仍然生效');
  assert.equal((await post(app.port, '/qq/pending')).items.length, 0, '带引用回答后应结算掉');
  assert.match(String(app.receipts.at(-1)?.text ?? ''), /允许一次/, `实际回执：${app.receipts.at(-1)?.text}`);
  assert.equal(String(id).length > 0, true, '审批编号应存在');
});

test('★ 宿主 silenced / whitelisted=false 时 DSH 一律不接管（哪怕只有一条待审批）', async (t) => {
  const app = await bootPlugin(t);
  await post(app.port, '/dsh/ask', { toolName: 'shell' });
  await waitFor(() => app.pushed.length === 1);

  for (const [why, gate] of [
    ['静音期', { silenced: true }],
    ['不在白名单', { whitelisted: false }],
  ]) {
    const taken = await plugin.handleMessage({
      evt: adminEvt({ text: '同意' }),
      sendText: app.replyText,
      ctx: app.ctx,
      gate,
    });
    assert.equal(taken, false, `${why}：不得接管`);
    assert.equal((await post(app.port, '/qq/pending')).items.length, 1, `${why}：待审批不能被悄悄结算`);
    assert.equal(app.receipts.length, 0, `${why}：不该发任何回执`);
  }

  // 没有 gate（旧宿主/单测）时维持原行为：恰好一条待审批可省略编号
  const normal = await plugin.handleMessage({
    evt: adminEvt({ text: '同意' }),
    sendText: app.replyText,
    ctx: app.ctx,
    gate: null,
  });
  assert.equal(normal, true, '没有 gate 限制时应照常接管');
  assert.equal((await post(app.port, '/qq/pending')).items.length, 0);
});

test('★ DSH 有多条待审批时，「是」这类确认短句必须提示带编号，不能落到正则/AI', async (t) => {
  const app = await bootPlugin(t);
  await post(app.port, '/dsh/ask', { toolName: 'fs_write' });
  await post(app.port, '/dsh/ask', { toolName: 'shell' });
  await waitFor(() => app.pushed.length === 2);
  assert.equal((await post(app.port, '/qq/pending')).items.length, 2);

  /*
   * 宿主确认表是空的（confirmPending:false），DSH 自己有两条待审批。
   * 「是」既不是裸编号、parseCommand 也无法判定批哪一条。
   * 旧实现 return false → 消息落到 regex-reply 口令或 AI 回合，
   * 用户看到"已回复"、两条审批纹丝不动。
   */
  const taken = await plugin.handleMessage({
    evt: adminEvt({ text: '是' }),
    sendText: app.replyText,
    ctx: app.ctx,
    gate: { whitelisted: true, silenced: false, confirmPending: false },
  });
  assert.equal(taken, true, '必须自己收住，不能交给正则/AI');
  assert.match(String(app.receipts.at(-1)?.text ?? ''), /2 条待处理审批/, `实际提示：${app.receipts.at(-1)?.text}`);
  assert.match(String(app.receipts.at(-1)?.text ?? ''), /编号|引用/, '提示必须告诉用户怎么回复');
  assert.equal((await post(app.port, '/qq/pending')).items.length, 2, '提示不能顺手结算任何一条');

  // 宿主有待确认时仍是"宿主优先"：DSH 让路（return false），不抢这句话
  const hostWins = await plugin.handleMessage({
    evt: adminEvt({ text: '是' }),
    sendText: app.replyText,
    ctx: app.ctx,
    gate: { whitelisted: true, silenced: false, confirmPending: true },
  });
  assert.equal(hostWins, false, '宿主有待确认时 DSH 仍让路');
  assert.equal((await post(app.port, '/qq/pending')).items.length, 2);
});

test('恰好一条待审批时「同意」仍按既有语义直接结算（不破坏省略编号）', async (t) => {
  const app = await bootPlugin(t);
  await post(app.port, '/dsh/ask', { toolName: 'fs_write' });
  await waitFor(() => app.pushed.length === 1);

  const taken = await plugin.handleMessage({
    evt: adminEvt({ text: '同意' }),
    sendText: app.replyText,
    ctx: app.ctx,
    gate: { whitelisted: true, silenced: false, confirmPending: false },
  });
  assert.equal(taken, true);
  assert.match(String(app.receipts.at(-1)?.text ?? ''), /已同意/, `实际回执：${app.receipts.at(-1)?.text}`);
  assert.equal((await post(app.port, '/qq/pending')).items.length, 0, '应当结算掉那条审批');
});
