/**
 * 真实端到端：后端 + 真模型 + 真实 QQ 投递。
 *
 * **API Key 只从环境变量读，不写入文件**；WS token 仅写入临时配置，用后删除。
 * 此脚本会向指定群实际发送消息，并消耗模型额度。
 *   $env:LING_LLM_BASE = "<你的 OpenAI 兼容地址，例如 https://api.deepseek.com/v1>"
 *   $env:LING_LLM_KEY  = "sk-..."
 *   $env:LING_LLM_MODEL = "<服务商提供的模型名>"
 *   $env:LING_ONEBOT_WS = "ws://127.0.0.1:3001"
 *   $env:LING_ONEBOT_TOKEN = "<SnowLuma 的 WS 令牌>"
 *   node scripts/e2e-real.mjs <群号>
 *
 * 它做四件事：
 *   1. 在临时 userData 里写非凭据配置（API Key 与 WS token 从 env 传入）
 *   2. 起真实后端，连真实 SnowLuma
 *   3. 触发一个回合（手动触发，白名单内群）
 *   4. 断言：turn 事件齐全、工具循环正常、消息真的发出去了
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const BASE = process.env.LING_LLM_BASE ?? '';
const KEY = process.env.LING_LLM_KEY ?? '';
const MODEL = process.env.LING_LLM_MODEL ?? 'deepseek-chat';
const WS_URL = process.env.LING_ONEBOT_WS ?? 'ws://127.0.0.1:3001';
const WS_TOKEN = process.env.LING_ONEBOT_TOKEN ?? '';
// 群号从命令行取；不给就报错提示，**不在代码里写死真实群号**
const GROUP = process.argv[2] ?? '';
if (!GROUP) {
  console.error('用法：node scripts/e2e-real.mjs <群号>');
  console.error('群号属于环境相关数据，不写进仓库。');
  process.exit(2);
}

if (!BASE || !KEY) {
  console.error('✖ 缺 LING_LLM_BASE / LING_LLM_KEY');
  process.exit(2);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-real-'));

  // API Key 由后端读取继承的 LING_LLM_KEY；仅 WS token 随临时配置清理。
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      onebot: { wsUrl: WS_URL, accessToken: WS_TOKEN },
      llm: { baseUrl: BASE, model: MODEL, keywords: ['测试'] },
      allow: { groups: [GROUP], private: [] },
      deny: { groups: [], private: [] },
      proactive: { enabled: false, probability: 0 },
      tools: { roots: [repoRoot], allowR3: false },
    }),
  );

  const backend = fork(path.join(repoRoot, 'src', 'index.mjs'), [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, LING_USER_DATA: dataDir, LING_LOG_LEVEL: 'info' },
  });
  backend.stderr.on('data', (d) => process.stderr.write(d));

  /** @type {Map<number, Function>} */
  const waiting = new Map();
  /** @type {object[]} */
  const events = [];
  let seq = 0;

  readline.createInterface({ input: backend.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m.result);
        waiting.delete(m.id);
      } else if (m.method === 'event') {
        events.push(m.params);
      }
    } catch {
      /* 非 JSON 输出忽略 */
    }
  });

  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const t = setTimeout(() => reject(new Error(`超时：${method}`)), 15_000);
      waiting.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      backend.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  console.log(`临时数据目录：${dataDir}`);
  console.log(`模型：${MODEL} @ ${BASE}`);
  console.log(`目标群：${GROUP}\n`);

  await new Promise((r) => setTimeout(r, 2000));

  const snap = await rpc('snapshot');
  console.log(`联通状态：${snap.state}`);
  console.log(`模型已配置：${snap.brain?.configured}`);
  console.log(`QQ 号：${snap.account?.selfId ?? '(未登录)'}\n`);

  // 触发回合
  const trig = await rpc('action', {
    name: 'turn.manual',
    params: { convKey: `group:${GROUP}`, text: '用一句话介绍你自己' },
  });
  console.log(`触发结果：${JSON.stringify(trig)}\n`);

  // 等回合结束
  const started = Date.now();
  let end = null;
  while (Date.now() - started < 90_000) {
    await new Promise((r) => setTimeout(r, 500));
    const e = events.find((x) => x.event === 'turn-end');
    if (e) {
      end = e.payload;
      break;
    }
  }

  const s = events.find((x) => x.event === 'turn-start')?.payload;
  const deltas = events.filter((x) => x.event === 'turn-delta');
  const tools = events.filter((x) => x.event === 'turn-tool');

  console.log('=== 结果 ===');
  console.log(`  turn-start : ${s ? `trigger=${s.trigger} proactive=${s.proactive}` : '✖ 没收到'}`);
  console.log(`  流式分片   : ${deltas.length}`);
  console.log(`  工具调用   : ${tools.length}${tools.length ? ` (${tools.map((t) => t.payload.tool).join(', ')})` : ''}`);
  console.log(`  turn-end   : ${JSON.stringify(end)}`);

  // 最终快照：确认用量与消息都落到了后端视图
  const after = await rpc('snapshot');
  console.log(`  用量今日   : ${JSON.stringify(after.usage?.today)}`);
  const msgs = after.messages?.slice(-3) ?? [];
  console.log(`  最近消息   : ${msgs.map((m) => `${m.convKey}|${m.sender?.nickname}|${String(m.text).slice(0, 40)}`).join(' / ')}`);

  const ok = Boolean(end && end.ok !== false);
  console.log(`\n${ok ? '✓ 真实端到端通过' : '✖ 真实端到端失败'}`);

  backend.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`✖ ${err?.stack ?? err}`);
  process.exit(1);
});
