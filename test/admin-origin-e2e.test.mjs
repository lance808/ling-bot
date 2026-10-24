/**
 * 授权来源端到端 —— 白名单不再自动等于管理员
 *
 * ## 为什么要在后端进程里测
 *
 * `admin-origin.test.mjs` 测的是纯函数（`coreAdminIds` 等）。但真正
 * 决定"这个回合能不能拿到宿主机工具"的是 `index.mjs` 的
 * `resolveOrigin()` + `isOwnerId()`，那段逻辑只有在完整装配的后端里
 * 才会真的跑起来（配置校验、boot 迁移、来源判定、工具授权）。
 *
 * 所以这里起一个真后端，通过 `tool.run` 与快照验证：
 *
 *   1. 只加白名单 → 不进管理员名单，快照里 `admin.qqIds` 为空
 *   2. 显式配 `admin.qqIds` → 快照里出现
 *   3. 打开兼容开关 → 白名单被并进来
 *
 * ## 它防的是哪一类回归
 *
 * 有人为了"让白名单用户也能用宿主机工具"，把 `isOwnerId` 改回读
 * `config.allow.private`。那行改动很小、看起来合理，而后果是
 * 加个白名单就顺带授出本机操作权 —— 用户完全不会察觉。
 * 所以这条线索必须由端到端测试钉住，不能只靠纯函数单测。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * 起一个后端，返回 rpc 与清理器。
 *
 * @param {object} cfgOverride 写进 config.json 的内容
 */
async function spawnBackend(cfgOverride) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-admin-'));
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(cfgOverride), 'utf8');

  const child = fork(path.join(repoRoot, 'src', 'index.mjs'), [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, LING_USER_DATA: dataDir, LING_LOG_LEVEL: 'error' },
  });
  child.stderr.on('data', () => {});

  /** @type {Map<number, Function>} */
  const waiting = new Map();
  let seq = 0;

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m.result);
        waiting.delete(m.id);
      }
    } catch {
      /* 日志行 */
    }
  });

  await new Promise((r) => setTimeout(r, 900));

  return {
    dataDir,
    rpc: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => reject(new Error(`超时：${method}`)), 8000);
        waiting.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
    close: async () => {
      child.kill();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('★ 只加白名单不算管理员（快照里 admin.qqIds 为空）', async () => {
  const be = await spawnBackend({ allow: { groups: [], private: ['100000001'] } });
  try {
    const snap = await be.rpc('snapshot');
    assert.deepEqual(snap.admin.qqIds, [], '白名单不会自动变成管理员');
    assert.equal(snap.admin.inheritWhitelist, false, '兼容开关默认关');
    // 白名单本身仍然生效（准入没被改动）
    assert.deepEqual(snap.config.allow.private, ['100000001']);
  } finally {
    await be.close();
  }
});

test('★ 显式配置的管理员出现在快照里', async () => {
  const be = await spawnBackend({ admin: { qqIds: ['100000002'] } });
  try {
    const snap = await be.rpc('snapshot');
    assert.deepEqual(snap.admin.qqIds, ['100000002']);
  } finally {
    await be.close();
  }
});

test('★ 兼容开关打开后，白名单被并进生效名单', async () => {
  const be = await spawnBackend({
    allow: { groups: [], private: ['100000001'] },
    admin: { qqIds: ['100000002'], inheritWhitelist: true },
  });
  try {
    const snap = await be.rpc('snapshot');
    assert.deepEqual(snap.admin.qqIds.sort(), ['100000001', '100000002']);
  } finally {
    await be.close();
  }
});

test('★ setting 通道能写管理员名单，且立刻反映到快照', async () => {
  const be = await spawnBackend({});
  try {
    const r = await be.rpc('setting', { key: 'admin.qqIds', value: ['100000003'] });
    assert.equal(r?.ok, true);
    const snap = await be.rpc('snapshot');
    assert.deepEqual(snap.admin.qqIds, ['100000003']);
  } finally {
    await be.close();
  }
});

test('★ setting：非法管理员号码被拒（不能静默丢掉）', async () => {
  const be = await spawnBackend({});
  try {
    const r = await be.rpc('setting', { key: 'admin.qqIds', value: ['abc', '100000001'] });
    assert.equal(r?.ok, false, '有非法项就整体拒绝');
    const snap = await be.rpc('snapshot');
    assert.deepEqual(snap.admin.qqIds, [], '一次失败不能写入半份名单');
  } finally {
    await be.close();
  }
});

test('★ setting：兼容开关需要布尔值，且写后立刻生效', async () => {
  const be = await spawnBackend({
    allow: { groups: [], private: ['100000001'] },
  });
  try {
    const bad = await be.rpc('setting', { key: 'admin.inheritWhitelist', value: 'yes' });
    assert.equal(bad?.ok, false);

    const ok = await be.rpc('setting', { key: 'admin.inheritWhitelist', value: true });
    assert.equal(ok?.ok, true);

    const snap = await be.rpc('snapshot');
    assert.equal(snap.admin.inheritWhitelist, true);
    assert.deepEqual(snap.admin.qqIds, ['100000001'], '打开后才并入');
  } finally {
    await be.close();
  }
});

test('★ 投递名单包含 DSH 管理员，但授权名单不含（两者不能混）', async () => {
  const be = await spawnBackend({
    admin: { qqIds: ['100000002'] },
    plugins: { config: { 'dsh-bridge': { admins: '100000004' } } },
  });
  try {
    const snap = await be.rpc('snapshot');
    assert.deepEqual(snap.admin.qqIds, ['100000002'], '授权只认核心名单');
    assert.ok(snap.admin.deliverable.includes('100000004'), 'DSH 管理员仍能收到推送');
    assert.ok(snap.admin.deliverable.includes('100000002'));
  } finally {
    await be.close();
  }
});

test('★ 确认条快照形状：没有待确认时是空数组', async () => {
  const be = await spawnBackend({});
  try {
    const snap = await be.rpc('snapshot');
    assert.ok(Array.isArray(snap.brain.pendingConfirms));
    assert.equal(snap.brain.pendingConfirms.length, 0);
  } finally {
    await be.close();
  }
});

test('★ 桌面端确认不存在的 id 被拒（不能靠猜 id 放行）', async () => {
  const be = await spawnBackend({});
  try {
    const res = await be.rpc('action', {
      name: 'confirm.resolve',
      params: { id: 'confirm-0-abc', allow: true },
    });
    assert.equal(res?.ok, false);
    assert.match(res?.message ?? '', /过期|不存在/);
  } finally {
    await be.close();
  }
});
