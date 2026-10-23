/**
 * 私聊审核（管理员私聊）不受发送限流影响
 *
 * 故障背景：确认卡与回执都走管理员私聊，而一次审批往返至少 2 条，
 * 忙一点的回合 6~8 条。默认限流 8/分钟、60/小时，**正常使用就会撞上**。
 *
 * 撞上后的两种表现都是静默的（sendText resolve {ok:false} 而非抛异常）：
 *   - 确认卡发不出去 → 用户不知道要确认 → 超时按拒绝；
 *   - 回执发不出去   → 确认成功了却没有任何回信。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { passSendGate, checkWhitelist, isAdminPrivate, RateLimiter } from '../src/guard/send-gate.mjs';

const ADMIN = '100000001';
const ADMIN_KEY = `private:${ADMIN}`;
const STRANGER_KEY = 'private:99999999';
const GROUP_KEY = 'group:100000002';

function makeConfig(over = {}) {
  return {
    allow: { groups: [], private: [ADMIN] },
    deny: { groups: [], private: [] },
    admins: [ADMIN],
    ...over,
  };
}

const auditPass = () => ({ ok: true });

function makeLimiter(maxPerMinute = 2, maxPerHour = 3) {
  return new RateLimiter({ maxPerMinute, maxPerHour });
}

const gate = (convKey, limiter, config = makeConfig()) =>
  passSendGate({ convKey, text: 'x', config, audit: auditPass, limiter });

test('★ 管理员私聊不受每分钟限流影响', () => {
  const limiter = makeLimiter(2, 100);
  // 连发 10 条，全部要过
  for (let i = 0; i < 10; i += 1) {
    const r = gate(ADMIN_KEY, limiter);
    assert.equal(r.ok, true, `第 ${i + 1} 条被挡：${r.code} ${r.message}`);
  }
});

test('★ 管理员私聊不受每小时限流影响', () => {
  const limiter = makeLimiter(1000, 3);
  for (let i = 0; i < 10; i += 1) {
    const r = gate(ADMIN_KEY, limiter);
    assert.equal(r.ok, true, `第 ${i + 1} 条被挡：${r.code} ${r.message}`);
  }
});

test('★ 陌生人私聊照旧受限（豁免不能扩散）', () => {
  // 陌生人必须在白名单里，否则先被白名单挡掉，测不到限流这一层
  const cfg = makeConfig({ allow: { groups: [], private: [ADMIN, '99999999'] } });
  const limiter = makeLimiter(2, 100);
  gate(STRANGER_KEY, limiter, cfg);
  gate(STRANGER_KEY, limiter, cfg);
  const third = gate(STRANGER_KEY, limiter, cfg);
  assert.equal(third.ok, false, '第三条应当被限流');
  assert.equal(third.code, 'E2030');
  assert.equal(gate(ADMIN_KEY, limiter, cfg).ok, true, '同一时刻管理员不受影响');
});

test('★ 群聊照旧受限（豁免只对管理员私聊）', () => {
  const cfg = makeConfig({ allow: { groups: ['100000002'], private: [ADMIN] } });
  const limiter = makeLimiter(2, 100);
  gate(GROUP_KEY, limiter, cfg);
  gate(GROUP_KEY, limiter, cfg);
  const third = gate(GROUP_KEY, limiter, cfg);
  assert.equal(third.ok, false, '群聊第三条应当被限流');
  assert.equal(third.code, 'E2030');
});

test('★ 管理员身份不能绕过出站审计（安全边界没被放宽）', () => {
  const limiter = makeLimiter(100, 100);
  const r = passSendGate({
    convKey: ADMIN_KEY,
    text: '我的 key 是 D:\\secret\\config.json',
    config: makeConfig(),
    audit: () => ({ ok: false, code: 'E2020', message: '含本机路径' }),
    limiter,
  });
  assert.equal(r.ok, false, '审计必须仍然拦截');
  assert.equal(r.code, 'E2020');
});

test('★ 管理员身份不能绕过黑名单', () => {
  const cfg = makeConfig({ deny: { groups: [], private: [ADMIN] } });
  const wl = checkWhitelist(ADMIN_KEY, cfg);
  assert.equal(wl.ok, false, '黑名单优先于管理员身份');
});

test('isAdminPrivate 只认管理员私聊', () => {
  const cfg = makeConfig();
  assert.equal(isAdminPrivate(ADMIN_KEY, cfg), true);
  assert.equal(isAdminPrivate(STRANGER_KEY, cfg), false);
  assert.equal(isAdminPrivate(GROUP_KEY, cfg), false, '群聊不是私聊');
  assert.equal(isAdminPrivate(`group:${ADMIN}`, cfg), false, '同一个号在群里也不算');
  assert.equal(isAdminPrivate('乱写的', cfg), false);
  assert.equal(isAdminPrivate(ADMIN_KEY, { admins: [] }), false);
});

test('★ admins 为空时退回限流（不能因为读不到名单就不限流）', () => {
  const cfg = makeConfig({ admins: [] });
  const limiter = makeLimiter(1, 100);
  assert.equal(gate(ADMIN_KEY, limiter, cfg).ok, true);
  const second = gate(ADMIN_KEY, limiter, cfg);
  assert.equal(second.ok, false, '拿不到管理员名单时应照常限流');
});
