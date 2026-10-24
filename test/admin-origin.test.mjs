/**
 * 管理员身份来源 —— 「谁能让它动本机」
 *
 * ## 这一组守的是什么
 *
 * 修这个问题之前，`resolveOrigin()` 判断 `owner-private` 用的是
 * `config.allow.private`。那等于把「准入」和「授权」合成一张表：
 * 为了让机器人能回某人的私聊而把他加进白名单（本意只是允许对话），
 * 他就**同时**拿到宿主机工具与高风险操作的确认权 ——
 * 而用户完全不知道加白名单还顺带授了权。
 *
 * 所以这里钉住三件事：
 *
 *   1. 白名单**默认**不等于管理员（这是修复本身）
 *   2. 兼容开关能用，但必须显式打开，且只并进 `allow.private`
 *   3. 投递豁免是并集（含 DSH 管理员），但**不参与授权**
 *
 * 第 3 条最容易做错：把「能收到审批推送」当成「能批准宿主机操作」，
 * 就会让 DSH 插件的管理员悄悄获得本机权限。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coreAdminIds,
  isCoreAdmin,
  deliverableAdminIds,
  normalizeAdminIds,
} from '../src/guard/admin.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../src/config/schema.mjs';

const ME = '100000001';
const OTHER = '100000002';
const DSH_ADMIN = '100000003';

/** 造一份经过 schema 校验的完整配置 */
function cfg(over = {}) {
  return validateConfig({
    allow: { groups: [], private: [] },
    ...over,
  });
}

/* ------------------------------------------------------------ 归一化 */

test('号码归一：数组、逗号串、中英文分隔符都认', () => {
  assert.deepEqual(normalizeAdminIds([ME]), [ME]);
  assert.deepEqual(normalizeAdminIds(`${ME},${OTHER}`), [ME, OTHER]);
  assert.deepEqual(normalizeAdminIds(`${ME}，${OTHER}`), [ME, OTHER]);
  assert.deepEqual(normalizeAdminIds(`${ME}、${OTHER}`), [ME, OTHER]);
  assert.deepEqual(normalizeAdminIds(`${ME} ${OTHER}`), [ME, OTHER]);
});

test('★ 号码归一：非法项被丢弃，不会静默变成"谁都可以"', () => {
  // 混进空串/说明文字后 includes() 永远不成立 —— 那是静默失效
  assert.deepEqual(normalizeAdminIds(['', ' ', null, undefined, 'abc', '管理员']), []);
  assert.deepEqual(normalizeAdminIds([ME, ME, '  100000001  ']), [ME], '去重且 trim');
});

/* ---------------------------------------------------------- 核心名单 */

test('★ 白名单不再等于管理员（这是修复本身）', () => {
  const c = cfg({ allow: { groups: [], private: [ME] } });
  assert.deepEqual(coreAdminIds(c), [], '只在白名单里 → 不是管理员');
  assert.equal(isCoreAdmin(c, ME), false);
});

test('★ 显式配置的管理员才生效', () => {
  const c = cfg({ admin: { qqIds: [ME] } });
  assert.deepEqual(coreAdminIds(c), [ME]);
  assert.equal(isCoreAdmin(c, ME), true);
  assert.equal(isCoreAdmin(c, OTHER), false);
});

test('★ 兼容开关：显式打开后白名单并入（且只在打开时）', () => {
  const off = cfg({ allow: { groups: [], private: [ME] }, admin: { qqIds: [] } });
  assert.deepEqual(coreAdminIds(off), [], '默认关闭时白名单不生效');

  const on = cfg({
    allow: { groups: [], private: [ME] },
    admin: { qqIds: [OTHER], inheritWhitelist: true },
  });
  assert.deepEqual(coreAdminIds(on).sort(), [ME, OTHER].sort(), '并集');
});

test('★ 兼容开关不把群白名单当管理员', () => {
  // 群号不是人的身份，群里的管理员判定走另一条逻辑
  const c = cfg({
    allow: { groups: ['100000004'], private: [] },
    admin: { inheritWhitelist: true },
  });
  assert.deepEqual(coreAdminIds(c), []);
});

test('isCoreAdmin 对空值/非法值一律 false', () => {
  const c = cfg({ admin: { qqIds: [ME] } });
  for (const bad of ['', null, undefined, '  ', 'abc']) {
    assert.equal(isCoreAdmin(c, bad), false, `${String(bad)} 不该是管理员`);
  }
});

test('★ 默认配置里管理员名单是空的（fail-closed）', () => {
  assert.deepEqual(DEFAULT_CONFIG.admin.qqIds, []);
  assert.equal(DEFAULT_CONFIG.admin.inheritWhitelist, false);
});

/* ---------------------------------------------------------- 投递豁免 */

test('★ 投递名单 = 核心管理员 + DSH 插件管理员 + 旧字段', () => {
  const c = cfg({
    admin: { qqIds: [ME] },
    plugins: { config: { 'dsh-bridge': { admins: DSH_ADMIN } } },
  });
  const list = deliverableAdminIds(c);
  assert.ok(list.includes(ME), '核心管理员要能收到');
  assert.ok(list.includes(DSH_ADMIN), 'DSH 审批推送不能被这次拆分打断');
});

test('★ 投递名单不会反过来变成授权', () => {
  const c = cfg({
    admin: { qqIds: [ME] },
    plugins: { config: { 'dsh-bridge': { admins: DSH_ADMIN } } },
  });
  // 关键：DSH 管理员能收到推送，但不是宿主机操作的管理员
  assert.equal(isCoreAdmin(c, DSH_ADMIN), false, 'DSH 管理员不该获得本机权限');
  assert.equal(isCoreAdmin(c, ME), true);
});

test('投递名单去重（同一个号出现在多处只算一次）', () => {
  const c = cfg({
    admin: { qqIds: [ME] },
    plugins: { config: { 'dsh-bridge': { admins: `${ME},${OTHER}` } } },
  });
  const list = deliverableAdminIds(c);
  assert.deepEqual(list, [ME, OTHER]);
});

test('旧 dsh.admins 仍然兜底（迁移没跑到的第一轮）', () => {
  const c = cfg({ dsh: { admins: [OTHER] } });
  assert.ok(deliverableAdminIds(c).includes(OTHER));
});

/* ---------------------------------------------------------- 配置校验 */

test('★ 管理员号码形状非法 → 启动就报错（不能静默失效）', () => {
  assert.throws(
    () => validateConfig({ admin: { qqIds: ['abc'] } }),
    /admin\.qqIds|QQ 号/,
    '非法号进不了闸门比较，必须 fail-fast',
  );
  assert.throws(() => validateConfig({ admin: { qqIds: [''] } }), /admin\.qqIds|QQ 号/);
});

test('★ inheritWhitelist 必须是布尔值', () => {
  assert.throws(
    () => validateConfig({ admin: { inheritWhitelist: 'yes' } }),
    /inheritWhitelist/,
  );
});

test('★ 老配置（完全没有 admin 块）能通过校验，且默认不含管理员', () => {
  const v = validateConfig({
    onebot: { wsUrl: 'ws://127.0.0.1:3001' },
    allow: { groups: [], private: [ME] },
  });
  assert.deepEqual(v.admin.qqIds, [], '补成空名单');
  assert.equal(v.admin.inheritWhitelist, false);
  assert.deepEqual(coreAdminIds(v), [], '不能因为补齐就凭空给出权限');
});

test('admin 里的未知子键被拒（fail-fast 纪律）', () => {
  assert.throws(() => validateConfig({ admin: { admins: [] } }), /未知|E40XX/);
});
