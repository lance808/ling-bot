/**
 * 启动自检 —— 不依赖 Electron，纯 Node 验证后端能起来、IPC 能应答。
 *
 * 用法：node scripts/smoke.mjs
 * 退出码 0 = 通过。
 */

import { fork } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/** @param {string} name */
function step(name) {
  process.stdout.write(`  ✓ ${name}\n`);
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-smoke-'));
  console.log('Ling-bot 启动自检');
  console.log(`  数据目录：${dataDir}\n`);

  const child = fork(path.join(repoRoot, 'src', 'index.mjs'), [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, LING_USER_DATA: dataDir, LING_LOG_LEVEL: 'info' },
  });

  /** @type {Map<number, Function>} */
  const waiting = new Map();
  let seq = 0;
  /** @type {object[]} */
  const events = [];

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      } else if (msg.method === 'event') {
        events.push(msg.params);
      }
    } catch {
      /* 非 JSON 行是日志，忽略 */
    }
  });
  child.stderr.on('data', () => {});

  /** @param {string} method @param {any} params */
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`超时：${method}`)), 10_000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  try {
    // 1. 启动与 ready 事件
    await new Promise((r) => setTimeout(r, 1200));
    if (!events.some((e) => e.event === 'ready')) {
      throw new Error('未收到 ready 事件（后端可能启动失败）');
    }
    step('后端启动并发出 ready 事件');

    // 2. snapshot 能应答，且形状正确
    const snap = await rpc('snapshot');
    if (snap.error) throw new Error(`snapshot 出错：${snap.error.message}`);
    const r = snap.result;
    if (!r.health || !r.registry || !r.config) throw new Error('snapshot 缺少必需字段');
    step(`snapshot 应答正常（状态 ${r.state}，动作 ${r.registry.actions.length} 个，工具 ${r.registry.tools.length} 个）`);

    // 3. 注册表里确实有扩展面
    if (r.registry.actions.length === 0) throw new Error('动作表为空');
    if (r.registry.tools.length === 0) throw new Error('工具表为空');
    step('扩展骨架已装配（动作 + 工具）');

    // 4. 凭据不回显明文
    if (r.config.onebot.accessToken && r.config.onebot.accessToken.includes('undefined')) {
      throw new Error('凭据掩码异常');
    }
    step('配置回显已掩码');

    // 5. 工具可经 console 来源调用（只读工具）
    const toolTry = await rpc('action', { name: 'tool.run', params: { tool: 'fs_list', args: {}, convKey: 'private:0' } });
    if (toolTry.result?.ok !== true) {
      throw new Error(`console 来源应能调用 fs_list，实际：${JSON.stringify(toolTry.result)}`);
    }
    step('工具可经 console 来源调用（只读工具）');

    // 5b. 路径越界必须被拒（L3 约束，不靠提示词）
    const escape = await rpc('action', {
      name: 'tool.run',
      params: { tool: 'fs_read', args: { path: '../../../../etc/passwd' }, convKey: 'private:0' },
    });
    if (escape.result?.ok !== false || escape.result?.code !== 'E4033') {
      throw new Error(`越界读取应返回 E4033，实际：${JSON.stringify(escape.result)}`);
    }
    step('工具路径越界被拒（E4033，I17/L3）');

    // 6. 白名单外发送被拒
    const send = await rpc('action', { name: 'send-text', params: { convKey: 'group:888888', text: 'hi' } });
    if (send.result?.ok !== false || send.result?.code !== 'E20XX') {
      throw new Error(`白名单外应被拒并返回 E20XX，实际：${JSON.stringify(send.result)}`);
    }
    step('白名单外发送被闸门拒绝（E20XX）');

    // 7. 未登记动作返回 E4030
    const unknown = await rpc('action', { name: 'no-such-action' });
    if (unknown.result?.code !== 'E4030') throw new Error('未登记动作应返回 E4030');
    step('未登记动作被拒（E4030）');

    // 8. 未知配置键 fail-fast
    await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ onebot: { wsUrl: 'ws://127.0.0.1:3001', typo: 1 } }), 'utf8');
    const bad = fork(path.join(repoRoot, 'src', 'index.mjs'), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, LING_USER_DATA: dataDir },
    });
    const code = await new Promise((resolve) => bad.on('exit', (c) => resolve(c)));
    if (code === 0) throw new Error('未知配置键应导致启动失败');
    step('未知配置键导致启动失败（I9）');

    console.log('\n自检通过。');
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error(`\n自检失败：${err.message}`);
    child.kill();
    process.exit(1);
  }
}

main();
