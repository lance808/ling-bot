/**
 * 凭据保险箱 —— DPAPI 加密存储
 *
 * 这里要守住的几件事：
 *   1. 密文里**不能**出现明文（这是加密的全部意义）
 *   2. 篡改过的密文必须**报错**，不能返回垃圾
 *   3. 格式不认识时必须**明确拒绝**，不能当空值处理
 *   4. 解不开时**不静默**——换机器/换账户就会这样，必须能看出来原因
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sealSecret, openSecret, isVaultAvailable, VaultError, VAULT_FORMAT } from '../src/config/vault.mjs';

const canUseVault = await isVaultAvailable();
const skip = canUseVault ? false : '当前环境没有 DPAPI（非 Windows 或 PowerShell 不可用）';

test('加密后密文里不含明文', { skip }, async () => {
  const secret = 'sk-abcdefghijklmnop-这是一个不该出现在密文里的值';
  const sealed = await sealSecret(secret);

  assert.equal(sealed.format, VAULT_FORMAT);
  assert.ok(sealed.data.length > 0);

  // 最直接的检查：密文里搜不到明文，也搜不到它的 base64
  const plainB64 = Buffer.from(secret, 'utf8').toString('base64');
  assert.equal(sealed.data.includes(secret), false, '密文里出现了明文');
  assert.equal(sealed.data.includes(plainB64), false, '密文里出现了明文的 base64');
});

test('加密 → 解密，内容一致', { skip }, async () => {
  const secret = 'sk-roundtrip-test-1234567890';
  const sealed = await sealSecret(secret);
  assert.equal(await openSecret(sealed), secret);
});

test('含中文与换行的值也能往返', { skip }, async () => {
  const secret = '第一行\n第二行 with spaces\tand tabs\n结束';
  const sealed = await sealSecret(secret);
  assert.equal(await openSecret(sealed), secret);
});

test('同一明文加密两次，密文不同（DPAPI 带随机盐）', { skip }, async () => {
  const a = await sealSecret('same-value');
  const b = await sealSecret('same-value');

  assert.notEqual(a.data, b.data, '两次密文相同说明没有随机性');
  assert.equal(await openSecret(a), 'same-value');
  assert.equal(await openSecret(b), 'same-value');
});

test('篡改密文必须报错，不能返回垃圾', { skip }, async () => {
  const sealed = await sealSecret('tamper-me');

  // 改掉最后 4 个字符
  const broken = sealed.data.slice(0, -4) + 'AAAA';
  await assert.rejects(
    () => openSecret({ ...sealed, data: broken }),
    (err) => err instanceof VaultError,
    '篡改后竟然解开了',
  );
});

test('格式不认识时明确拒绝', { skip }, async () => {
  await assert.rejects(
    () => openSecret({ format: 'plain-v0', data: 'whatever' }),
    (err) => err instanceof VaultError && err.code === 'E4105',
  );
});

test('空内容被拒绝', { skip }, async () => {
  await assert.rejects(
    () => openSecret({ format: VAULT_FORMAT, data: '' }),
    (err) => err instanceof VaultError && err.code === 'E4104',
  );
});

test('加密空字符串被拒绝', { skip }, async () => {
  await assert.rejects(
    () => sealSecret(''),
    (err) => err instanceof VaultError && err.code === 'E4103',
  );
});

test('isVaultAvailable 返回布尔值', async () => {
  const v = await isVaultAvailable();
  assert.equal(typeof v, 'boolean');
});

test('错误对象带 code（便于界面给出人话提示）', { skip }, async () => {
  try {
    await openSecret({ format: 'bad', data: 'x' });
    assert.fail('应该抛错');
  } catch (err) {
    assert.ok(err instanceof VaultError);
    assert.match(err.code, /^E41/);
    assert.equal(typeof err.message, 'string');
    assert.ok(err.message.length > 0);
  }
});
