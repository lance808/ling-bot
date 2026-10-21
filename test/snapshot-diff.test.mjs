import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFingerprint, VOLATILE_SNAPSHOT_KEYS, VOLATILE_RANGE_KEYS } from '../ui/src/snapshot-diff.mjs';
import { getState, set, subscribe } from '../ui/src/store.mjs';

/*
 * 这组测试钉的是「要不要整页重绘」的判据。
 *
 * 判错的两种后果都是线上症状：
 *   · 该忽略的没忽略 → 每 2 秒重绘一次，卡片阴影闪
 *   · 不该忽略的忽略了 → 数据变了界面不动
 */

const snap = (patch = {}) => ({
  state: 'idle',
  health: {
    linked: true,
    good: true,
    goodFresh: true,
    online: true,
    verdict: 'ok',
    lastHeartbeatAt: 1000,
    lastEventAt: 1000,
    lastGoodAt: 1000,
  },
  messages: [{ convKey: 'group:1', text: 'hi', time: 1 }],
  brain: { configured: true, model: 'm', pendingConfirms: [], conversations: [{ convKey: 'group:1', lastHumanAt: 5 }] },
  ...patch,
});

test('心跳时间戳变化不算变化', () => {
  const a = snapshotFingerprint(snap());
  const b = snapshotFingerprint(
    snap({ health: { ...snap().health, lastHeartbeatAt: 2000, lastEventAt: 2000, lastGoodAt: 2000 } }),
  );
  assert.equal(a, b);
});

test('心跳字段被剥掉，且只剥这三个', () => {
  assert.deepEqual([...VOLATILE_SNAPSHOT_KEYS], ['lastHeartbeatAt', 'lastEventAt', 'lastGoodAt']);
});

test('真正要显示的变化必须改变指纹', () => {
  const base = snapshotFingerprint(snap());
  // 健康判定变了（界面上是绿/黄/灰药丸）
  assert.notEqual(base, snapshotFingerprint(snap({ health: { ...snap().health, verdict: 'degraded' } })));
  // 有新消息
  assert.notEqual(base, snapshotFingerprint(snap({ messages: [{ convKey: 'group:1', text: 'yo', time: 2 }] })));
  // 待确认项出现（确认条要立刻弹出来）
  assert.notEqual(
    base,
    snapshotFingerprint(snap({ brain: { ...snap().brain, pendingConfirms: [{ id: 'a', tool: 't' }] } })),
  );
  // 会话列表里"最近有人说话"的时间会被工具页显示，不能剥
  assert.notEqual(
    base,
    snapshotFingerprint(snap({ brain: { ...snap().brain, conversations: [{ convKey: 'group:1', lastHumanAt: 9 }] } })),
  );
});

test('嵌套数组里的心跳字段也能剥掉', () => {
  // 心跳字段目前只在 health 下，但指纹是整棵树扫的；
  // 万一将来挪了位置，剥字段的行为不该跟着失效。
  assert.equal(
    snapshotFingerprint({ a: { lastEventAt: 1 }, b: [{ lastEventAt: 2 }] }),
    snapshotFingerprint({ a: { lastEventAt: 9 }, b: [{ lastEventAt: 8 }] }),
  );
});

test('用量区间的 since/until 变化不算变化', () => {
  assert.deepEqual([...VOLATILE_RANGE_KEYS], ['since', 'until']);
  const usage = (since, until) => ({
    usage: { range: { since, until, calls: 3, covered: true }, today: { totalTokens: 10 } },
  });
  assert.equal(snapshotFingerprint(usage(1000, 2000)), snapshotFingerprint(usage(1000 + 40, 2000 + 40)));
});

test('用量区间里真正的内容变化仍要改变指纹', () => {
  const usage = (patch) => ({ usage: { range: { since: 1000, until: 2000, calls: 3, ...patch } } });
  assert.notEqual(snapshotFingerprint(usage({})), snapshotFingerprint(usage({ calls: 4 })));
  assert.notEqual(snapshotFingerprint(usage({})), snapshotFingerprint(usage({ covered: false })));
});

test('只剥 usage.range 下的 since/until，别处同名字段照算', () => {
  // 万一将来别的结构里也有 since/until，不能连带忽略
  assert.notEqual(snapshotFingerprint({ x: { since: 1 } }), snapshotFingerprint({ x: { since: 2 } }));
  assert.notEqual(snapshotFingerprint({ x: { range: { since: 1 } } }), snapshotFingerprint({ x: { range: { since: 2 } } }));
});

test('静置 90 秒仍刷新统计边界，换页可读到新快照且不触发轮询重绘', () => {
  const previous = getState().snapshot;
  const windowMs = 24 * 3600_000;
  const start = 1_000_000_000;
  const usage = (now) => ({ usage: { range: { since: now - windowMs, until: now, calls: 0, covered: true } } });
  let renders = 0;
  const unsubscribe = subscribe(() => { renders += 1; });
  try {
    set({ snapshot: usage(start) });
    assert.equal(renders, 1);
    const fingerprint = snapshotFingerprint(getState().snapshot);
    for (const elapsed of [30_000, 60_000, 90_000]) {
      const fresh = usage(start + elapsed);
      assert.equal(snapshotFingerprint(fresh), fingerprint);
      set({ snapshot: fresh }, { notify: false });
    }
    assert.equal(renders, 1, '无可见内容变化时不重绘');
    const cutoff = start + 90_000 - windowMs;
    assert.ok(Math.abs(getState().snapshot.usage.range.since - cutoff) < 60_000, '换页时统计区间仍有效');
    set({ snapshot: usage(start + 92_000) });
    assert.equal(renders, 2, '普通更新仍通知订阅者');
  } finally {
    unsubscribe();
    set({ snapshot: previous }, { notify: false });
  }
});
