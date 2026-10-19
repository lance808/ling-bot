/**
 * 插件端到端：真实模型 + 真实插件工具。
 *
 * 验证的是"能不能真的靠插件扩展能力"这件事，
 * 而不只是单元测试里的声明校验。
 *
 * 用法（密钥只走环境变量）：
 *   $env:LING_LLM_BASE = "<你的 OpenAI 兼容地址，例如 https://api.deepseek.com/v1>"
 *   $env:LING_LLM_KEY  = "sk-..."
 *   node scripts/e2e-plugin.mjs
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
const MODEL = process.env.LING_LLM_MODEL ?? 'deepseek-v4.1';

if (!BASE || !KEY) {
  console.error('✖ 缺 LING_LLM_BASE / LING_LLM_KEY');
  process.exit(2);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-plug-e2e-'));

  // 装示例插件（从仓库 plugins/ 拷到临时 userData/plugins/）
  fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'plugins', 'echo'), path.join(dataDir, 'plugins', 'echo'), { recursive: true });

  // 再装一个"装了但没启用"的，用来验证默认关闭
  fs.cpSync(path.join(repoRoot, 'plugins', 'echo'), path.join(dataDir, 'plugins', 'disabled_one'), { recursive: true });
  // 改掉它的自报名，否则会因名字不符而加载失败（那样就测不到"未启用"了）
  const idx = path.join(dataDir, 'plugins', 'disabled_one', 'index.mjs');
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace("name: 'echo'", "name: 'disabled_one'"));

  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' },
      llm: { baseUrl: BASE, model: MODEL, apiKey: KEY },
      allow: { groups: [], private: [] },
      plugins: { enabled: ['echo'], allowDangerous: false },
    }),
  );

  const backend = fork(path.join(repoRoot, 'src', 'index.mjs'), [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, LING_USER_DATA: dataDir, LING_LOG_LEVEL: 'error' },
  });
  backend.stderr.on('data', () => {});

  /** @type {Map<number, Function>} */
  const waiting = new Map();
  let seq = 0;
  readline.createInterface({ input: backend.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m.result);
        waiting.delete(m.id);
      }
    } catch {
      /* 忽略 */
    }
  });

  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const t = setTimeout(() => reject(new Error(`超时：${method}`)), 20_000);
      waiting.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      backend.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  await new Promise((r) => setTimeout(r, 1500));

  const snap = await rpc('snapshot');
  console.log('=== 插件加载情况 ===');
  console.log(`  enabled : ${JSON.stringify(snap.plugins?.enabled)}`);
  console.log(`  loaded  : ${JSON.stringify(snap.plugins?.loaded)}`);
  console.log(`  skipped : ${JSON.stringify(snap.plugins?.skipped)}`);

  // 直接执行插件工具，验证通道打通
  console.log('\n=== 直接执行插件工具 ===');
  const ran = await rpc('action', {
    name: 'tool.run',
    params: { tool: 'plugin_echo', args: { text: '插件通道通畅' } },
  });
  console.log(`  ${JSON.stringify(ran)}`);

  // 让真实模型自己决定要不要调这个工具
  console.log('\n=== 真实模型自主调用插件 ===');
  const llm = new (await import('../src/llm/client.mjs')).LlmClient({
    baseUrl: BASE,
    model: MODEL,
    apiKey: KEY,
    timeoutMs: 60_000,
  });
  const { runTurn } = await import('../src/llm/agent-loop.mjs');
  const { buildMessages } = await import('../src/llm/prompt.mjs');
  const { toOpenAiTools, RISK } = await import('../src/guard/tool-gate.mjs');
  const { ORIGIN } = await import('../src/guard/origin.mjs');

  const PLUGIN_TOOL = {
    name: 'plugin_echo',
    kind: 'qq',
    risk: RISK.R0,
    origins: [ORIGIN.OWNER_PRIVATE],
    description: '把传入的文字原样回显（来自插件 echo）',
    params: { text: { type: 'string', required: true, description: '要回显的文字' } },
  };

  const calls = [];
  const res = await runTurn({
    llm,
    toOpenAiTools,
    runner: {
      availableTools: () => [PLUGIN_TOOL],
      async run(name, args) {
        calls.push({ name, args });
        // 真的走插件实现
        const actual = await rpc('action', { name: 'tool.run', params: { tool: name, args } });
        return { ok: true, result: actual?.result ?? actual };
      },
    },
    messages: buildMessages({
      persona: '你是一个助手。工具能做的事就让工具做。',
      context: {
        convKey: 'private:1',
        isGroup: false,
        recent: [{ role: 'user', nickname: '主人', text: '请用 plugin_echo 把"你好世界"原样回显给我' }],
      },
    }),
  });

  console.log(`  模型调用插件次数：${calls.length}`);
  console.log(`  调用参数：${JSON.stringify(calls)}`);
  console.log(`  最终回答：${res.text}`);

  const checks = [
    [snap.plugins?.loaded?.some((p) => p.name === 'echo' && p.ok), '插件 echo 已加载'],
    [snap.plugins?.skipped?.includes('disabled_one'), '未启用的插件被识别为"装了但未启用"'],
    [ran?.ok === true && ran?.result?.echoed === '插件通道通畅', '直接执行插件工具成功'],
    [calls.length > 0, '真实模型自主调用了插件工具'],
  ];

  console.log('\n断言：');
  let failed = 0;
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? '✓' : '✖'} ${label}`);
    if (!ok) failed += 1;
  }

  backend.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`✖ ${e?.stack ?? e}`);
  process.exit(1);
});
