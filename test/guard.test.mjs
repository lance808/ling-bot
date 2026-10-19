/**
 * 闸门 / 审计 / 路径策略 / 原子写 —— F9 / I4、I5
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { checkWhitelist, passSendGate, RateLimiter } from '../src/guard/send-gate.mjs';
import { auditOutbound, redact, maskSecret } from '../src/guard/audit.mjs';
import { resolveGuardedPath } from '../src/guard/path-policy.mjs';
import { writeJsonAtomic, readJson, readText, writeTextAtomic } from '../src/config/atomic.mjs';
import { validateConfig } from '../src/config/schema.mjs';

const CFG = {
  allow: { groups: ['123'], private: ['456'] },
  deny: { groups: ['999'], private: [] },
  allowAllWhenEmpty: false,
};

test('白名单：命中放行，未命中拒绝，deny 优先', () => {
  assert.equal(checkWhitelist('group:123', CFG).ok, true);
  assert.equal(checkWhitelist('private:456', CFG).ok, true);
  assert.equal(checkWhitelist('group:999', CFG).ok, false, 'deny 优先于 allow');
  assert.equal(checkWhitelist('group:888', CFG).ok, false);
  assert.equal(checkWhitelist('group:abc', CFG).ok, false, '会话键形状非法');
});

test('白名单：空列表默认 fail-closed，显式打开才放行', () => {
  const empty = { allow: { groups: [], private: [] }, deny: { groups: [], private: [] } };
  assert.equal(checkWhitelist('group:1', empty).ok, false);
  assert.equal(checkWhitelist('group:1', { ...empty, allowAllWhenEmpty: true }).ok, true);
});

test('白名单：数字/字符串混用也能比较（OneBot int64 差异）', () => {
  const cfg = { allow: { groups: [123], private: [] }, deny: { groups: [], private: [] } };
  assert.equal(checkWhitelist('group:123', cfg).ok, true);
});

test('I4：出站审计拦本机路径与凭据，整条不发', () => {
  assert.equal(auditOutbound('今天天气不错').ok, true);
  assert.equal(auditOutbound('看 D:\\secret\\a.txt').ok, false);
  assert.equal(auditOutbound('见 /home/user/.ssh').ok, false);
  assert.equal(auditOutbound('apiKey: "sk-abcdefghijklmnop"').ok, false);
  assert.equal(auditOutbound('https://user:pass@example.com').ok, false);
  assert.equal(auditOutbound('-----BEGIN RSA PRIVATE KEY-----').ok, false);
});

test('脱敏与掩码：凭据不出现在日志里', () => {
  assert.ok(!redact('token=abcdefghijklmnopqrstuvwxyz').includes('abcdefghijklmnopqrstuvwxyz'));
  assert.equal(maskSecret(''), '（未设置）');
  assert.ok(maskSecret('sk-1234567890abcdef').startsWith('sk-1'));
  assert.ok(maskSecret('sk-1234567890abcdef').includes('位'));
});

test('闸门：白名单外被拒且标记 denied', () => {
  const limiter = new RateLimiter({ maxPerMinute: 10, maxPerHour: 100 });
  const res = passSendGate({
    convKey: 'group:888',
    text: 'hi',
    config: CFG,
    audit: auditOutbound,
    limiter,
  });
  assert.equal(res.ok, false);
  assert.equal(/** @type {any} */ (res).denied, true);
  assert.equal(/** @type {any} */ (res).code, 'E20XX');
});

test('闸门：审计命中被拒', () => {
  const limiter = new RateLimiter({ maxPerMinute: 10, maxPerHour: 100 });
  const res = passSendGate({ convKey: 'group:123', text: 'C:\\Windows\\system.ini', config: CFG, audit: auditOutbound, limiter });
  assert.equal(res.ok, false);
  assert.equal(/** @type {any} */ (res).code, 'E2020');
});

test('闸门：限流生效', () => {
  const limiter = new RateLimiter({ maxPerMinute: 1, maxPerHour: 100 });
  assert.equal(passSendGate({ convKey: 'group:123', text: 'a', config: CFG, audit: auditOutbound, limiter }).ok, true);
  const second = passSendGate({ convKey: 'group:123', text: 'b', config: CFG, audit: auditOutbound, limiter });
  assert.equal(second.ok, false);
  assert.equal(/** @type {any} */ (second).code, 'E2030');
});

test('闸门：空内容被拒', () => {
  const limiter = new RateLimiter({ maxPerMinute: 10, maxPerHour: 100 });
  const res = passSendGate({ convKey: 'group:123', text: '   ', config: CFG, audit: auditOutbound, limiter });
  assert.equal(res.ok, false);
});

test('路径策略：越界、凭据、state 目录都要拒绝', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-path-'));
  const userData = path.join(root, 'ud');
  await fs.mkdir(path.join(userData, 'state'), { recursive: true });
  await fs.writeFile(path.join(root, 'ok.txt'), 'hello', 'utf8');
  await fs.writeFile(path.join(userData, 'secrets.json'), '{}', 'utf8');
  await fs.writeFile(path.join(userData, 'state', 'sessions.json'), '{}', 'utf8');

  const base = { roots: [root], userDataDir: userData };

  assert.equal((await resolveGuardedPath('ok.txt', base)).ok, true);
  assert.equal((await resolveGuardedPath('../outside.txt', base)).ok, false, '穿越必须被拒');
  assert.equal((await resolveGuardedPath('../../../etc/passwd', base)).ok, false);

  const secret = await resolveGuardedPath(path.join(userData, 'secrets.json'), { ...base });
  assert.equal(secret.ok, false, '凭据文件对工具不可读');

  const stateFile = await resolveGuardedPath(path.join(userData, 'state', 'sessions.json'), base);
  assert.equal(stateFile.ok, false, 'state 目录对工具不可读');

  await fs.rm(root, { recursive: true, force: true });
});

test('I5：原子写保留 BOM，读时吃掉', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-atomic-'));
  const file = path.join(dir, 'cfg.json');

  // 先写一份带 BOM 的
  await fs.writeFile(file, '\uFEFF{"a":1}', 'utf8');
  const first = await readText(file);
  assert.equal(first?.hadBom, true);
  assert.equal(first?.text, '{"a":1}');

  await writeJsonAtomic(file, { a: 2 });
  const second = await readText(file);
  assert.equal(second?.hadBom, true, '写回应保留 BOM');
  assert.deepEqual(await readJson(file), { a: 2 });

  await fs.rm(dir, { recursive: true, force: true });
});

test('I9：未知配置键导致启动失败，而不是静默忽略', () => {
  assert.throws(() => validateConfig({ onebot: { wsUrl: 'ws://127.0.0.1:3001', typo: 1 } }), /未知配置项/);
  assert.throws(() => validateConfig({ proactive: { probability: 2 } }), /proactive\.probability/);
  assert.throws(() => validateConfig({ onebot: { wsUrl: 'not-a-url' } }), /wsUrl/);

  // 合法配置能过
  const ok = validateConfig({ proactive: { probability: 0.1 } });
  assert.equal(/** @type {any} */ (ok).proactive.probability, 0.1);
  assert.equal(/** @type {any} */ (ok).limits.maxSendPerMinute, 8, '未写的键应用默认值');
});
