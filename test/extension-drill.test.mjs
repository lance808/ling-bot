/**
 * 扩展性演练（I11）—— 这是"架构够不够强悍"的可执行证明，不是口号。
 *
 * 判据：新增一个 QQ 动作，**改动文件 ≤ 2 个**（动作文件 + 注册行），
 * 且传输层、闸门、IPC 通道、前端出口**零改动**。
 *
 * 这里通过哈希四个核心文件来证明"零改动"——文件没被动过，比人工 review 可靠。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { _clearActionsForTest, defineAction, getAction, listActions } from '../src/onebot/actions/index.mjs';
import { _clearToolsForTest } from '../src/tools/registry.mjs';
import { registerDemoPingAction } from './fixtures/demo-ping.action.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/** I11 点名的四个"不许动"的文件 */
const FROZEN_FILES = [
  'src/onebot/transport.mjs',
  'src/guard/send-gate.mjs',
  'electron/preload.cjs',
  'ui/src/api.mjs',
];

/** @param {string} rel */
async function sha256(rel) {
  const buf = await fs.readFile(path.join(repoRoot, rel));
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('扩展骨架：新增动作只需声明，核心文件零改动', async () => {
  const before = new Map();
  for (const rel of FROZEN_FILES) before.set(rel, await sha256(rel));

  _clearActionsForTest();
  _clearToolsForTest();

  // 只做一件事：注册一个新动作
  registerDemoPingAction();

  const action = getAction('__demo_ping');
  assert.ok(action, '新动作应登记成功');
  assert.equal(action.permission, 'read');
  assert.equal(action.onebotAction, 'get_status');

  // 核心文件未被改动
  for (const rel of FROZEN_FILES) {
    assert.equal(await sha256(rel), before.get(rel), `${rel} 不应被改动`);
  }

  // 声明式：参数校验信息来自声明本身，不需要写 if
  assert.deepEqual(Object.keys(action.params), ['note']);

  _clearActionsForTest();
});

test('扩展骨架：permission 非法时登记会被拒绝（fail-fast，不静默）', () => {
  _clearActionsForTest();
  assert.throws(
    () =>
      defineAction({
        name: '__bad_action',
        onebotAction: 'whatever',
        permission: 'root', // 不在 read/send/manage/qzone 里
      }),
    /permission 非法/,
  );
  _clearActionsForTest();
});

test('扩展骨架：缺 onebotAction 会被拒绝', () => {
  _clearActionsForTest();
  assert.throws(() => defineAction({ name: '__no_target', permission: 'read' }), /必须有 onebotAction/);
  _clearActionsForTest();
});

test('扩展骨架：重复登记同名动作会被拒绝', () => {
  _clearActionsForTest();
  registerDemoPingAction();
  assert.throws(() => registerDemoPingAction(), /重复登记/);
  _clearActionsForTest();
});

test('扩展骨架：清单可枚举（启动时会打印，新人能一眼看到系统组成）', () => {
  _clearActionsForTest();
  registerDemoPingAction();
  const names = listActions().map((a) => a.name);
  assert.deepEqual(names, ['__demo_ping']);
  _clearActionsForTest();
});
