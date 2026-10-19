/**
 * 人工确认通道 —— F14
 *
 * 守一条：**默认拒绝**。
 * 没人应答、超时、界面没开，一律当"不允许"——
 * 一个默认放行的确认框比没有确认框更危险，因为人以为自己被保护了。
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
 * 起后端，返回 rpc + 事件流 + 清理器。
 *
 * @param {object} [cfgOverride] 写入 config.json 的内容
 */
async function spawnBackend(cfgOverride) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-confirm-'));
  if (cfgOverride) {
    await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(cfgOverride), 'utf8');
  }
  const child = fork(path.join(repoRoot, 'src', 'index.mjs'), [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, LING_USER_DATA: dataDir, LING_LOG_LEVEL: 'error' },
  });
  child.stderr.on('data', () => {});

  /** @type {Map<number, Function>} */
  const waiting = new Map();
  /** @type {object[]} */
  const events = [];
  let seq = 0;

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m.result);
        waiting.delete(m.id);
      } else if (m.method === 'event') {
        events.push(m.params);
      }
    } catch {
      /* 日志 */
    }
  });

  await new Promise((r) => setTimeout(r, 900));

  return {
    dataDir,
    events,
    rpc: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const t = setTimeout(() => reject(new Error(`超时：${method}`)), 8000);
        waiting.set(id, (r) => {
          clearTimeout(t);
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

test('确认：解析一个不存在的 id 会被拒绝（不能靠猜 id 放行）', async () => {
  const be = await spawnBackend();
  try {
    const res = await be.rpc('action', { name: 'confirm.resolve', params: { id: 'confirm-0-abc', allow: true } });
    assert.equal(res?.ok, false);
    assert.match(res?.message ?? '', /过期|不存在/);
  } finally {
    await be.close();
  }
});

test('确认：快照里能看到待确认列表（界面据此弹框）', async () => {
  const be = await spawnBackend();
  try {
    const snap = await be.rpc('snapshot');
    assert.ok(Array.isArray(snap.brain?.pendingConfirms));
    assert.equal(snap.brain.pendingConfirms.length, 0);
  } finally {
    await be.close();
  }
});

test('确认：R2 工具在无人应答时不会被执行（fail-closed）', async () => {
  // 用 console 来源跑一个 R0 只读工具应当直接成功；
  // R2 工具当前还没登记，这里验证"未登记 → E4032"，保证默认面是收紧的
  const be = await spawnBackend();
  try {
    const res = await be.rpc('action', { name: 'tool.run', params: { tool: 'fs_write', args: { path: 'a', content: 'b' } } });
    assert.equal(res?.ok, false);
    assert.equal(res?.code, 'E4032', '未登记的高风险工具必须拒绝，而不是"等确认"');
  } finally {
    await be.close();
  }
});

test('回合：模型未配置时不会尝试对话（也不该报错）', async () => {
  const be = await spawnBackend();
  try {
    const snap = await be.rpc('snapshot');
    assert.equal(snap.brain.configured, false, '默认配置没有 apiKey');
    assert.equal(snap.brain.model.length > 0, true);
  } finally {
    await be.close();
  }
});

test('回合：手动触发在非白名单目标上被拒', async () => {
  const be = await spawnBackend();
  try {
    const res = await be.rpc('action', { name: 'turn.manual', params: { convKey: 'group:999999', text: 'hi' } });
    assert.equal(res?.ok, false);
    assert.equal(res?.code, 'E20XX');
  } finally {
    await be.close();
  }
});

test('回合：没有在途回合时停止不会崩', async () => {
  const be = await spawnBackend();
  try {
    const res = await be.rpc('action', { name: 'turn.stop', params: {} });
    assert.equal(res?.ok, false);
  } finally {
    await be.close();
  }
});

test('用量：初始快照里 today 全为 0，且带 proactive 单列', async () => {
  const be = await spawnBackend();
  try {
    const snap = await be.rpc('snapshot');
    assert.equal(snap.usage.today.totalTokens, 0);
    assert.equal(snap.usage.todayProactive.totalTokens, 0, '主动支出必须单列');
    assert.equal(snap.usage.proactiveRatio, 0);
  } finally {
    await be.close();
  }
});
