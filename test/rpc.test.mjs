/**
 * RPC 契约测试 —— F1 / F13 边界第 4 条
 *
 * 守两件事：
 *   1. IPC 只有三个 method，不按功能长通道
 *   2. setting 通道对输入做校验（直接赋值会让闸门行为变成未定义）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/**
 * 起一个后端实例，返回 rpc 函数与清理器。
 *
 * @returns {Promise<{rpc: (m: string, p?: any) => Promise<any>, dataDir: string, close: () => Promise<void>}>}
 */
async function spawnBackend() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-rpc-'));
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
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
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
        waiting.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg.result ?? msg.error);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
    close: async () => {
      child.kill();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('IPC：只有 snapshot / action / setting 三个 method', async () => {
  const be = await spawnBackend();
  try {
    for (const m of ['snapshot', 'action', 'setting']) {
      const res = await be.rpc(m, m === 'action' ? { name: 'noop' } : m === 'setting' ? { key: 'noop' } : {});
      // 三个 method 都应有应答（未必成功，但不能是"未知 method"）
      assert.ok(res !== undefined, `${m} 必须有应答`);
      assert.notEqual(res?.code, 'E50XX', `${m} 不应被判为未知 method`);
    }
    // 其他 method 一律拒绝
    const bad = await be.rpc('restart-everything');
    assert.equal(bad?.code, 'E50XX');
  } finally {
    await be.close();
  }
});

test('setting：allow 形状非法时拒绝，不污染闸门', async () => {
  const be = await spawnBackend();
  try {
    const notObject = await be.rpc('setting', { key: 'allow', value: 42 });
    assert.equal(notObject?.ok, false);

    const badId = await be.rpc('setting', { key: 'allow', value: { groups: ['abc'], private: [] } });
    assert.equal(badId?.ok, false);
    assert.match(badId?.message ?? '', /非法 QQ 号/);

    const notArray = await be.rpc('setting', { key: 'allow', value: { groups: 'x', private: [] } });
    assert.equal(notArray?.ok, false);

    const good = await be.rpc('setting', { key: 'allow', value: { groups: [123, '456'], private: [] } });
    assert.equal(good?.ok, true);

    // 规范化：数字转字符串、去重
    const snap = await be.rpc('snapshot');
    assert.deepEqual(snap.config.allow.groups, ['123', '456']);
  } finally {
    await be.close();
  }
});

test('setting：persona 超限被拒（不静默截断）', async () => {
  const be = await spawnBackend();
  try {
    const ok = await be.rpc('setting', { key: 'persona', value: '我是个安静的助手。' });
    assert.equal(ok?.ok, true);

    const tooLong = await be.rpc('setting', { key: 'persona', value: 'x'.repeat(6001) });
    assert.equal(tooLong?.ok, false);
    assert.equal(tooLong?.code, 'E4041');

    const wrongType = await be.rpc('setting', { key: 'persona', value: 123 });
    assert.equal(wrongType?.ok, false);

    const snap = await be.rpc('snapshot');
    assert.equal(snap.persona, '我是个安静的助手。');
  } finally {
    await be.close();
  }
});

test('setting：未支持的键明确报错，而不是假装成功', async () => {
  const be = await spawnBackend();
  try {
    const res = await be.rpc('setting', { key: 'lol', value: 1 });
    assert.equal(res?.ok, false);
    assert.equal(res?.code, 'E40XX');
  } finally {
    await be.close();
  }
});

test('tool.run：来源由服务端固定，调用方无法自带 origin 提权', async () => {
  const be = await spawnBackend();
  try {
    // 试图通过 params 传 origin=owner-private —— 必须被忽略
    const res = await be.rpc('action', {
      name: 'tool.run',
      params: { tool: 'fs_list', args: {}, convKey: 'private:0', origin: 'owner-private' },
    });
    // console 来源本来就允许只读工具，所以这里断言的是"能用"，且不因 origin 字段变化
    assert.equal(res?.ok, true);

    // 未登记工具被拒
    const missing = await be.rpc('action', { name: 'tool.run', params: { tool: 'shell_full', args: {} } });
    assert.equal(missing?.ok, false);
    assert.equal(missing?.code, 'E4032');
  } finally {
    await be.close();
  }
});
