/**
 * DSH 桥的 HTTP 路由（真起端口）
 *
 * 单元测试只证明"函数返回了什么"，证明不了 DSH 插件**实际会看到什么**。
 * 两段式协议的关键全在 HTTP 层：/dsh/ask 必须立刻回编号，
 * /dsh/await 必须挂得住，/dsh/withdraw 必须能让挂着的那条立刻收工。
 * 这些只能在真的监听一个端口、用真的 HTTP 请求测。
 *
 * 端口用 0（让系统分配）：并行跑测试时不会撞端口，也不用维护端口号。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DshBridge, serve } from '../plugins/dsh-bridge/lib/bridge.mjs';

const TOKEN = 'route-test-token';

/**
 * 起一个真的桥 + 真的端口。
 *
 * @param {object} [over] 覆盖 DshBridge 的构造参数
 */
async function boot(over = {}) {
  /** @type {any[]} */
  const pushed = [];
  /** @type {any[]} */
  const notified = [];

  const bridge = new DshBridge({
    token: TOKEN,
    onAsk: async (req) => {
      pushed.push(req);
    },
    onNotify: (info) => {
      notified.push(info);
    },
    ...over,
  });

  const srv = await serve(bridge, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${srv.port}`;

  /**
   * @param {string} path
   * @param {any} [body]
   * @param {{token?: string}} [opt]
   */
  const post = async (path, body = {}, opt = {}) => {
    const token = opt.token === undefined ? TOKEN : opt.token;
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  return { bridge, srv, port: srv.port, post, pushed, notified, close: () => srv.close() };
}

/** 等一个条件成立（推送/通知都是异步发的） */
async function waitFor(fn, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * 后台请求：先挂上 catch，免得测试提前结束时报"未处理的 rejection"。
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<T>}
 */
function bg(p) {
  p.catch(() => {});
  return p;
}

/** 关服务器 + 清掉在等条目，任何测试失败都不会把进程挂住 */
function useApp(t, app) {
  t.after(async () => {
    await app.close();
  });
  return app;
}

/* ---------------------------------------------------------------- 审批 */

test('★ /dsh/ask 立刻回编号，/dsh/await 等到结论', async (t) => {
  const app = useApp(t, await boot());

  const start = await app.post('/dsh/ask', {
    kind: 'approval',
    toolName: 'fs_write',
    reason: '要写入 README',
  });
  assert.equal(start.status, 200);
  assert.equal(start.body.ok, true);
  assert.match(String(start.body.id), /^\d+$/, '两段式的第一段必须给出编号');

  // 登记了就要在待回复列表里，否则 QQ 那边根本看不到
  const pending = await app.post('/qq/pending');
  assert.equal(pending.body.items.length, 1);
  assert.equal(pending.body.items[0].id, String(start.body.id));

  const waiting = bg(app.post('/dsh/await', { id: start.body.id }));

  // 等推送真的发出去，再模拟管理员引用回复"1"
  await waitFor(() => app.pushed.length === 1);
  const answered = await app.post('/qq/answer', { id: start.body.id, reply: '1' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.ok, true);

  const done = await waiting;
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, {
    ok: true,
    status: 'answered',
    kind: 'approval',
    outcome: 'allowed-once',
  });

  // 结论取走之后不该还占着编号
  assert.equal((await app.post('/qq/pending')).body.items.length, 0);
});

test('kind 省略按审批处理（协议里的默认值）', async (t) => {
  const app = useApp(t, await boot());
  const start = await app.post('/dsh/ask', { toolName: 'fs_read' });
  assert.match(String(start.body.id), /^\d+$/);

  const waiting = bg(app.post('/dsh/await', { id: start.body.id }));
  await waitFor(() => app.pushed.length === 1);
  assert.equal(app.pushed[0].kind, 'approval');

  await app.post('/qq/answer', { id: start.body.id, reply: '2' }); // 2 = 拒绝
  const done = await waiting;
  assert.equal(done.body.outcome, 'rejected');
});

/* ---------------------------------------------------------------- 提问 */

test('★ 提问走同一条 /dsh/ask，答案按题目结构回传', async (t) => {
  const app = useApp(t, await boot());

  const questions = [
    {
      id: 'q1',
      header: '改哪里',
      question: '要改哪个文件？',
      options: [{ label: 'README.md' }, { label: 'src/index.mjs' }],
    },
  ];

  const start = await app.post('/dsh/ask', { kind: 'question', questions });
  assert.match(String(start.body.id), /^\d+$/);

  const waiting = bg(app.post('/dsh/await', { id: start.body.id }));
  await waitFor(() => app.pushed.length === 1);
  assert.equal(app.pushed[0].kind, 'question');

  await app.post('/qq/answer', { id: start.body.id, reply: '2' });
  const done = await waiting;
  assert.equal(done.body.status, 'answered');
  assert.equal(done.body.kind, 'question');
  assert.deepEqual(done.body.answer, {
    answers: [{ id: 'q1', selected: ['src/index.mjs'] }],
  });
});

test('旧路由 /dsh/ask-question 仍按长轮询回答案（兼容别名）', async (t) => {
  const app = useApp(t, await boot());

  const waiting = bg(
    app.post('/dsh/ask-question', {
      questions: [{ id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] }],
    }),
  );
  await waitFor(() => app.pushed.length === 1);
  await app.post('/qq/answer', { id: app.pushed[0].id, reply: '1' });

  const done = await waiting;
  assert.equal(done.status, 200);
  assert.equal(done.body.answer.answers[0].selected[0], 'A');
});

test('没有可选项的提问不产生编号', async (t) => {
  const app = useApp(t, await boot());
  const r = await app.post('/dsh/ask', {
    kind: 'question',
    questions: [{ id: 'q1', question: '随便说说' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, null);
  assert.equal((await app.post('/qq/pending')).body.items.length, 0);
});

/* ---------------------------------------------------------------- 撤销 */

test('★ /dsh/withdraw 让挂着的那条 await 立刻收工，并通知 QQ 侧', async (t) => {
  const app = useApp(t, await boot());

  const start = await app.post('/dsh/ask', { toolName: 'fs_write' });
  const id = String(start.body.id);
  const waiting = bg(app.post('/dsh/await', { id }));

  await waitFor(() => app.pushed.length === 1);

  // 桌面端先回答了：撤销 QQ 这条
  const w = await app.post('/dsh/withdraw', { id, reason: 'desktop' });
  assert.equal(w.status, 200);
  assert.deepEqual(w.body, { ok: true, removed: true });

  const done = await waiting;
  assert.equal(done.body.ok, true);
  assert.equal(done.body.status, 'withdrawn', '撤销不能表现成超时');
  assert.equal(done.body.reason, 'desktop');

  // 用户不该再看到"等你回答"
  await waitFor(() => app.notified.length === 1);
  assert.equal(app.notified[0].id, id);
  assert.equal((await app.post('/qq/pending')).body.items.length, 0);

  // 结论只发一次：撤销后同一个编号再 await 就是 unknown
  const again = await app.post('/dsh/await', { id });
  assert.equal(again.body.status, 'unknown');
});

test('withdraw 不存在的编号回 400，且不发通知', async (t) => {
  const app = useApp(t, await boot());
  const r = await app.post('/dsh/withdraw', { id: '42', reason: 'desktop' });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.removed, false);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(app.notified.length, 0);
});

test('★ 撤销之后 QQ 回复会明确报错（不能给作废的请求补一个结论）', async (t) => {
  const app = useApp(t, await boot());

  const start = await app.post('/dsh/ask', { toolName: 'fs_write' });
  const id = String(start.body.id);
  const waiting = bg(app.post('/dsh/await', { id }));
  await waitFor(() => app.pushed.length === 1);

  await app.post('/dsh/withdraw', { id, reason: 'desktop' });
  await waiting;

  const answer = await app.post('/qq/answer', { id, reply: '1' });
  assert.equal(answer.status, 400);
  assert.equal(answer.body.ok, false);
});

/* ---------------------------------------------------------------- 免打扰 */

test('★ 免打扰期间 /dsh/ask 直接回 allowed-once，不产生待回复', async (t) => {
  const app = useApp(t, await boot());

  const quiet = await app.post('/qq/quiet', { ms: 60_000 });
  assert.equal(quiet.body.quiet, true);

  const start = await app.post('/dsh/ask', { toolName: 'fs_write' });
  assert.equal(start.status, 200);
  assert.deepEqual(start.body, { ok: true, id: null, outcome: 'allowed-once' });

  await new Promise((res) => setTimeout(res, 20));
  assert.equal(app.pushed.length, 0, '免打扰期间不该打扰用户');
  assert.equal((await app.post('/qq/pending')).body.items.length, 0);

  await app.post('/qq/quiet', { cancel: true });
});

/* ---------------------------------------------------------------- 边界 */

test('/dsh/await 未知编号回 200 + unknown（结论在 status 里，不在 HTTP 码里）', async (t) => {
  const app = useApp(t, await boot());
  const r = await app.post('/dsh/await', { id: '99' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, status: 'unknown' });
});

test('★ /dsh/await 超时回 status:timeout（不是拒绝，也不是 500）', async (t) => {
  // 只给 40ms：测的是"没人回答"这条路径，不是真等两分钟
  const app = useApp(t, await boot({ timeoutMs: 40 }));

  const start = await app.post('/dsh/ask', { toolName: 'fs_write' });
  const r = await app.post('/dsh/await', { id: start.body.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, status: 'timeout' });

  // 超时后编号已回收，再来一次就是 unknown
  assert.equal((await app.post('/dsh/await', { id: start.body.id })).body.status, 'unknown');
});

test('★ 令牌不对时三条新路由全部 401', async (t) => {
  const app = useApp(t, await boot());

  for (const route of ['/dsh/ask', '/dsh/await', '/dsh/withdraw']) {
    const noToken = await app.post(route, { id: '1' }, { token: '' });
    assert.equal(noToken.status, 401, `${route} 缺令牌必须拒绝`);
    assert.equal(noToken.body.ok, false);

    const wrong = await app.post(route, { id: '1' }, { token: 'wrong' });
    assert.equal(wrong.status, 401, `${route} 错令牌必须拒绝`);
  }

  // 被拒的请求不能悄悄登记出一条待回复
  assert.equal((await app.post('/qq/pending')).body.items.length, 0);
});

test('/dsh/ping 报告待回复数量与路由命中数', async (t) => {
  const app = useApp(t, await boot());

  const start = await app.post('/dsh/ask', { toolName: 'fs_write' });
  const ping = await app.post('/dsh/ping');
  assert.equal(ping.body.pending, 1);
  assert.equal(ping.body.hits['/dsh/ask'], 1);
  assert.equal(ping.body.quiet, false);

  // 收尾：别把待回复留在队列里（否则 120s 定时器会拖着进程）
  await app.post('/dsh/withdraw', { id: start.body.id, reason: 'desktop' });
});

test('GET 仍然只回 405（少一个入口就少一条被利用的路径）', async (t) => {
  const app = useApp(t, await boot());
  const res = await fetch(`http://127.0.0.1:${app.port}/dsh/ask`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 405);
  assert.equal((await res.json()).ok, false);
});
