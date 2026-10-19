/**
 * 发送闸门 —— 白名单与管理员豁免
 *
 * 这一层的职责是"谁能收到机器人的消息"，跟"谁能命令机器人"是**两个方向**，
 * 但两者共用过一张表，于是踩了一个必然发生的坑：
 *
 * 管理员配好了审批推送，却没把自己的私聊加进 `allow.private`
 * （那张表本意是"允许谁发指令"），于是审批发不出去——
 * 而且是静默失败，DSH 那边一直等到超时。
 *
 * 所以管理员私聊必须豁免。但 `deny` 的优先权要保留：
 * 显式拉黑比身份更说了算，万一某个号被盗，先拉黑要立即生效。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkWhitelist, passSendGate, RateLimiter } from '../src/guard/send-gate.mjs';

const baseCfg = () => ({
  allow: { groups: ['20001'], private: [] },
  deny: { groups: [], private: [] },
  admins: ['10001'],
});

test('白名单内的群放行', () => {
  assert.equal(checkWhitelist('group:20001', baseCfg()).ok, true);
});

test('不在白名单的群拒绝', () => {
  const r = checkWhitelist('group:99999', baseCfg());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E20XX');
});

test('★ 管理员私聊即使不在白名单也能送达', () => {
  // 这就是审批推送能发出去的关键：allow.private 是空的，
  // 但号在 admins 里，所以必须放行。
  const r = checkWhitelist('private:10001', baseCfg());
  assert.equal(r.ok, true, '管理员私聊必须能收到审批');
});

test('非管理员的私聊仍然拒绝（空白名单 fail-closed）', () => {
  const r = checkWhitelist('private:88888', baseCfg());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E20XX');
});

test('★ deny 优先于管理员豁免（拉黑要立即生效）', () => {
  const cfg = baseCfg();
  cfg.deny.private = ['10001'];
  const r = checkWhitelist('private:10001', cfg);
  assert.equal(r.ok, false, '显式拉黑比管理员身份更说了算');
  assert.match(r.message, /黑名单/);
});

test('管理员豁免只对私聊生效，不放开群', () => {
  // 一个号在 admins 里，不代表它所在的群都能收到消息
  const cfg = baseCfg();
  const r = checkWhitelist('group:10001', cfg);
  assert.equal(r.ok, false, '不能因为号是管理员就放开任意群');
});

test('admins 缺失时不崩（老配置兼容）', () => {
  const cfg = baseCfg();
  delete cfg.admins;
  const r = checkWhitelist('private:10001', cfg);
  assert.equal(r.ok, false);
});

test('admins 里的数字与字符串都能比对（OneBot int64 差异）', () => {
  const cfg = baseCfg();
  cfg.admins = [10001]; // 数字形式
  assert.equal(checkWhitelist('private:10001', cfg).ok, true);
});

test('★ 端到端：管理员私聊能过完整闸门', () => {
  const limiter = new RateLimiter({ maxPerMinute: 60, maxPerHour: 600 });
  const r = passSendGate({
    convKey: 'private:10001',
    text: '审批请求：fs_write',
    config: baseCfg(),
    audit: () => ({ ok: true }),
    limiter,
  });
  assert.equal(r.ok, true, '审批消息必须能发出去');
});

test('端到端：非管理员私聊仍被拒', () => {
  const limiter = new RateLimiter({ maxPerMinute: 60, maxPerHour: 600 });
  const r = passSendGate({
    convKey: 'private:88888',
    text: '你好',
    config: baseCfg(),
    audit: () => ({ ok: true }),
    limiter,
  });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
});

test('会话键形状非法直接拒绝', () => {
  const r = checkWhitelist('nonsense', baseCfg());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4033');
});
