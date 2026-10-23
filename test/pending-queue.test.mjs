/**
 * 待回复队列
 *
 * 最危险的场景是**编号复用**：编号到 99 回卷、超时还会回收。
 * 一条迟到的旧回复若命中新请求，就等于「用旧意图批准新操作」。
 * 所以队列必须只认当前在册的编号。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PendingQueue } from '../plugins/dsh-bridge/lib/pending.mjs';

const spec = (over = {}) => ({
  kind: /** @type {const} */ ('approval'),
  title: '操作审批',
  choices: [
    { key: 'allowed-once', label: '允许一次' },
    { key: 'rejected', label: '拒绝' },
  ],
  ...over,
});

test('登记后能查到，编号从 1 开始', () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  const p = q.wait(spec());
  assert.deepEqual(q.ids(), ['1']);
  q.settle('1', 'allowed-once');
  return p.then((r) => {
    assert.equal(r.status, 'answered');
    assert.equal(r.value, 'allowed-once');
    assert.deepEqual(q.ids(), []);
  });
});

test('★ 结算后不能再结算第二次', async () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  const p = q.wait(spec());
  assert.equal(q.settle('1', 'rejected').ok, true);
  const again = q.settle('1', 'allowed-once');
  assert.equal(again.ok, false, '同一条不能被回答两次');
  const r = await p;
  assert.equal(r.value, 'rejected', '第一次的结论不能被覆盖');
});

test('★ 不存在的编号必须报错，不能静默成功', () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  const r = q.settle('42', 'allowed-once');
  assert.equal(r.ok, false);
  assert.match(r.error, /没有编号/);
});

test('超时返回 timeout，不是 rejected', async () => {
  const q = new PendingQueue({ timeoutMs: 20 });
  const r = await q.wait(spec());
  assert.equal(r.status, 'timeout', '超时不能当成拒绝——用户可能只是在忙');
  assert.deepEqual(q.ids(), []);
});

test('★ 编号 99 之后回卷到 1', () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  // 只改计数器，不真的建 99 条
  q.nextNo = 99;
  const p1 = q.wait(spec());
  const p2 = q.wait(spec());
  assert.deepEqual(q.ids().sort(), ['1', '99']);
  q.settle('99', 'allowed-once');
  q.settle('1', 'allowed-once');
  return Promise.all([p1, p2]);
});

test('★ 编号复用后，旧回复不命中新请求', async () => {
  // 造出真实的复用：编号 1 先给 A，A 超时回收；
  // 然后让计数器回卷，编号 1 再分配给 B。
  // 关键是：A 那次结算必须已经失效，迟到的"1"只能落到 B。
  const q = new PendingQueue({ timeoutMs: 30 });
  const a = q.wait(spec({ preview: 'A' }));
  const ra = await a;
  assert.equal(ra.status, 'timeout');

  // 复用编号 1
  q.nextNo = 1;
  const b = q.wait(spec({ preview: 'B' }));
  assert.equal(q.get('1').preview, 'B', '编号被复用了');
  assert.equal(q.settle('1', 'rejected').ok, true);
  const rb = await b;
  assert.equal(rb.value, 'rejected');
  assert.deepEqual(q.ids(), []);
});

test('cancelAll 把在册的都按取消结算', async () => {
  const q = new PendingQueue({ timeoutMs: 5000 });
  const a = q.wait(spec());
  const b = q.wait(spec());
  q.cancelAll();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 'cancelled');
  assert.equal(rb.status, 'cancelled');
  assert.deepEqual(q.ids(), []);
});

test('list 带上选项表，供"有什么卡着"展示', () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  q.wait(spec({ preview: 'fs_write' }));
  const [item] = q.list();
  assert.equal(item.preview, 'fs_write');
  assert.equal(item.choices.length, 2);
  assert.equal(item.kind, 'approval');
});

test('onPush 抛错不影响等待（推送是尽力而为）', async () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  const p = q.wait(
    spec({
      onPush: () => {
        throw new Error('QQ 没连上');
      },
    }),
  );
  assert.deepEqual(q.ids(), ['1'], '推送失败也要保持在册，等用户可能重连');
  q.settle('1', 'allowed-once');
  assert.equal((await p).status, 'answered');
});

test('onPush 收到的 entry 带渲染所需的一切', () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  let seen = null;
  const p = q.wait(
    spec({
      preview: 'fs_write',
      onPush: (e) => {
        seen = e;
      },
    }),
  );
  assert.equal(seen.id, '1');
  assert.equal(seen.kind, 'approval');
  assert.equal(seen.choices.length, 2);
  assert.equal(seen.title, '操作审批');
  q.settle('1', 'rejected');
  return p;
});

test('提问类条目保留 multiSelect', () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  const p = q.wait({
    kind: 'question',
    title: '提问',
    choices: [{ key: '1', label: 'A' }, { key: '2', label: 'B' }],
    multiSelect: true,
    preview: '选哪些',
  });
  assert.equal(q.get('1').multiSelect, true);
  q.settle('1', { any: 'thing' });
  return p;
});

/* ---------------------------------------------------------------- 两段式 */

test('enqueue 同时交出编号和 Promise', async () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  const { id, promise } = q.enqueue(spec());
  assert.equal(id, '1');
  assert.deepEqual(q.ids(), ['1']);
  q.settle(id, 'allowed-once');
  const r = await promise;
  assert.equal(r.status, 'answered');
  assert.equal(r.value, 'allowed-once');
});

test('wait 与 enqueue 是同一份实现（编号仍然从 1 起）', () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  const p = q.wait(spec());
  assert.deepEqual(q.ids(), ['1']);
  q.settle('1', 'rejected');
  return p;
});

test('★ withdraw 以 withdrawn 结算，并把条目移出在册', async () => {
  const q = new PendingQueue({ timeoutMs: 5000 });
  const { id, promise } = q.enqueue(spec());
  assert.deepEqual(q.withdraw(id, 'desktop'), { ok: true });
  const r = await promise;
  assert.equal(r.status, 'withdrawn', '撤销不能表现成超时或拒绝');
  assert.equal(r.reason, 'desktop');
  assert.deepEqual(q.ids(), [], '撤销后不能再占着编号');
});

test('withdraw 不写 reason 时按 desktop（目前只有桌面端会撤销）', async () => {
  const q = new PendingQueue({ timeoutMs: 5000 });
  const { promise } = q.enqueue(spec());
  q.withdraw('1');
  assert.equal((await promise).reason, 'desktop');
});

test('★ withdraw 不存在的编号要报错，不能静默成功', () => {
  const q = new PendingQueue({ timeoutMs: 1000 });
  const r = q.withdraw('7', 'desktop');
  assert.equal(r.ok, false);
  assert.match(r.error, /7/);
});

test('★ withdraw 之后不能再被 settle（旧编号不能翻案）', async () => {
  const q = new PendingQueue({ timeoutMs: 5000 });
  const { promise } = q.enqueue(spec());
  q.withdraw('1', 'desktop');
  assert.equal(q.settle('1', 'allowed-once').ok, false);
  assert.equal(q.withdraw('1', 'desktop').ok, false, '同一条不能撤两次');
  assert.equal((await promise).status, 'withdrawn');
});

test('withdraw 之后条目立刻从列表消失', () => {
  const q = new PendingQueue({ timeoutMs: 5000 });
  q.enqueue(spec({ preview: 'fs_write' }));
  q.withdraw('1', 'desktop');
  assert.deepEqual(q.list(), []);
});
