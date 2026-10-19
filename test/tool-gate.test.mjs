/**
 * 授权模型测试 —— F14 / I13、I14
 *
 * 这组测试守的是整个项目最重要的那条性质：
 * **模型被说服了，也改变不了它能调用什么。**
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ORIGIN, assertOrigin } from '../src/guard/origin.mjs';
import {
  RISK,
  resolveToolSet,
  isToolGranted,
  validateParams,
  needsConfirm,
  toOpenAiTools,
} from '../src/guard/tool-gate.mjs';

const HOST_READ = {
  name: 'fs_read',
  kind: 'host',
  risk: RISK.R0,
  origins: [ORIGIN.OWNER_PRIVATE, ORIGIN.CONSOLE],
  params: { path: { type: 'string', required: true } },
};

const HOST_WRITE = {
  name: 'fs_write',
  kind: 'host',
  risk: RISK.R2,
  confirm: 'always',
  origins: [ORIGIN.OWNER_PRIVATE],
  params: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
};

const QQ_SEND = {
  name: 'send_message',
  kind: 'qq',
  risk: RISK.R0,
  origins: [ORIGIN.OWNER_PRIVATE, ORIGIN.OWNER_GROUP, ORIGIN.GROUP],
  params: { text: { type: 'string', required: true } },
};

const ALL = [HOST_READ, HOST_WRITE, QQ_SEND];

test('I13：群聊来源拿不到任何宿主机工具', () => {
  const granted = resolveToolSet(ORIGIN.GROUP, ALL);
  assert.deepEqual(granted.map((t) => t.name), ['send_message']);
  assert.ok(!granted.some((t) => t.kind === 'host'));
});

test('I13：主动唤醒回合拿不到宿主机工具', () => {
  const granted = resolveToolSet(ORIGIN.PROACTIVE, ALL);
  assert.ok(!granted.some((t) => t.kind === 'host'));
});

test('I13：只有管理员私聊能拿到宿主机工具', () => {
  const granted = resolveToolSet(ORIGIN.OWNER_PRIVATE, ALL);
  // fs_write 可见 ≠ 可以不经确认执行：可见性看 origins，执行还要过 needsConfirm
  assert.deepEqual(granted.map((t) => t.name).sort(), ['fs_read', 'fs_write', 'send_message']);
  assert.ok(granted.some((t) => t.kind === 'host'));
});

test('I13：未声明 origins 的工具谁都调不到（fail-closed）', () => {
  const orphan = { name: 'orphan', kind: 'host', risk: RISK.R0 };
  for (const origin of Object.values(ORIGIN)) {
    assert.equal(resolveToolSet(origin, [orphan]).length, 0, `${origin} 不应拿到 orphan`);
  }
});

test('I13：管理员在群里（owner-group）也拿不到宿主机工具', () => {
  const granted = resolveToolSet(ORIGIN.OWNER_GROUP, ALL);
  assert.deepEqual(granted.map((t) => t.name), ['send_message']);
});

test('R3 默认不开放，必须显式打开', () => {
  const r3 = { name: 'shell_full', kind: 'host', risk: RISK.R3, origins: [ORIGIN.OWNER_PRIVATE] };
  assert.equal(resolveToolSet(ORIGIN.OWNER_PRIVATE, [r3]).length, 0);
  assert.equal(
    resolveToolSet(ORIGIN.OWNER_PRIVATE, [r3], { allowR3Default: true, groupHostToolsForbidden: true, proactiveHostToolsForbidden: true }).length,
    1,
  );
});

test('I14：判定只依赖 origin，伪造的来源会被拒', () => {
  assert.throws(() => assertOrigin('admin'), /非法回合来源/);
  assert.throws(() => resolveToolSet(/** @type {any} */ ('owner-private '), [HOST_READ]), /非法回合来源/);
  assert.throws(() => resolveToolSet(/** @type {any} */ (''), [HOST_READ]), /非法回合来源/);
});

test('isToolGranted：风险档非法一律拒绝', () => {
  const weird = { name: 'weird', kind: 'host', risk: 'R9', origins: [ORIGIN.OWNER_PRIVATE] };
  assert.equal(isToolGranted(weird, ORIGIN.OWNER_PRIVATE), false);
});

test('参数校验：缺必填、类型错、超长都要拒绝', () => {
  const params = {
    path: { type: 'string', required: true, maxLength: 10 },
    flag: { type: 'boolean', required: false },
  };

  assert.equal(validateParams(params, { path: 'a' }).ok, true);
  assert.equal(validateParams(params, {}).ok, false);
  assert.equal(validateParams(params, { path: 123 }).ok, false);
  assert.equal(validateParams(params, { path: 'x'.repeat(11) }).ok, false);
  assert.equal(validateParams(params, { path: 'a', flag: 'yes' }).ok, false);
  // 不信任多余字段：不会被透传
  const res = validateParams(params, { path: 'a', extra: 'drop-me' });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(/** @type {any} */ (res).value), ['path']);
});

test('确认策略：R2/R3 默认需要人点头，R0 不需要', () => {
  assert.equal(needsConfirm(HOST_READ), false);
  assert.equal(needsConfirm(HOST_WRITE), true);
  assert.equal(needsConfirm({ risk: RISK.R3, confirm: 'never' }), false);
  assert.equal(needsConfirm({ risk: RISK.R0, confirm: 'always' }), true);
  assert.equal(needsConfirm(undefined), true, '缺声明时应当保守');
});

test('下发模型的 tools 形状符合 OpenAI 兼容协议', () => {
  const tools = toOpenAiTools([HOST_READ]);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'fs_read');
  assert.equal(tools[0].function.parameters.additionalProperties, false);
  assert.deepEqual(tools[0].function.parameters.required, ['path']);
});
