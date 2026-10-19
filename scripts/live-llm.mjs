/**
 * 真模型联调脚本。
 *
 * **密钥从环境变量读，绝不写进文件、绝不进仓库**：
 *   $env:LING_LLM_KEY = "sk-..."     # 或用你的 API Key
 *   $env:LING_LLM_BASE = "https://api.xxx.com/v1"
 *   node scripts/live-llm.mjs
 *
 * 这个脚本本身可以安全提交（不含任何凭据）。
 */

import { LlmClient } from '../src/llm/client.mjs';
import { runTurn } from '../src/llm/agent-loop.mjs';
import { buildMessages } from '../src/llm/prompt.mjs';
import { toOpenAiTools, RISK } from '../src/guard/tool-gate.mjs';
import { ORIGIN } from '../src/guard/origin.mjs';

const BASE_URL = process.env.LING_LLM_BASE ?? '';
const API_KEY = process.env.LING_LLM_KEY ?? '';
const MODEL = process.env.LING_LLM_MODEL ?? 'deepseek-chat';

if (!BASE_URL || !API_KEY) {
  console.error('✖ 缺环境变量：LING_LLM_BASE / LING_LLM_KEY');
  console.error('  例如：$env:LING_LLM_BASE="https://api.example.com/v1"; $env:LING_LLM_KEY="sk-..."');
  process.exit(2);
}

/** 脱敏显示，避免密钥出现在输出/截图里 */
function mask(s) {
  if (!s) return '(空)';
  return s.length <= 10 ? '***' : `${s.slice(0, 4)}***${s.slice(-4)}`;
}

async function main() {
  const llm = new LlmClient({ baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY, timeoutMs: 60_000 });

  console.log('=== 真模型联调 ===');
  console.log(`  baseUrl  : ${BASE_URL}`);
  console.log(`  chatUrl  : ${llm.chatUrl()}`);
  console.log(`  apiKey   : ${mask(API_KEY)}`);
  console.log(`  model    : ${MODEL}`);

  /* ---- 1. 纯文本流式 ---- */
  console.log('\n[1] 纯文本流式对话');
  const deltas = [];
  const r1 = await llm.chat({
    messages: [{ role: 'user', content: '用一句中文回答：1+1 等于几？' }],
    onDelta: (d) => deltas.push(d),
  });
  console.log(`  文本      : ${r1.text}`);
  console.log(`  分片数    : ${deltas.length}`);
  console.log(`  分片拼接一致: ${deltas.join('') === r1.text}`);
  console.log(`  用量      : ${JSON.stringify(r1.usage)}`);
  console.log(`  实际模型  : ${r1.model}`);

  /* ---- 2. 工具调用往返 ---- */
  console.log('\n[2] 工具调用往返');
  const TOOL = {
    name: 'fs_read',
    kind: 'host',
    risk: RISK.R0,
    origins: [ORIGIN.OWNER_PRIVATE],
    description: '读取文本文件内容',
    params: { path: { type: 'string', required: true, description: '文件路径' } },
  };
  const ran = [];
  const runner = {
    availableTools: () => [TOOL],
    async run(name, args) {
      ran.push({ name, args });
      return { ok: true, result: { path: args.path, content: '{"name": "ling-bot", "version": "0.1.0"}' } };
    },
  };

  const r2 = await runTurn({
    llm,
    runner,
    toOpenAiTools,
    messages: buildMessages({
      persona: '你是 Ling，一个简洁的助手。回答不超过 30 字。',
      context: {
        convKey: 'private:1',
        isGroup: false,
        recent: [{ role: 'user', nickname: '主人', text: '看下 package.json 里叫什么名字' }],
      },
    }),
  });
  console.log(`  工具被执行: ${JSON.stringify(ran)}`);
  console.log(`  步数      : ${r2.steps}`);
  console.log(`  最终回答  : ${r2.text}`);
  console.log(`  用量合计  : ${JSON.stringify(r2.usage)}`);

  /* ---- 3. 中断 ---- */
  console.log('\n[3] 中断（AbortController 真断连接）');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 400);
  try {
    const r3 = await llm.chat({
      messages: [{ role: 'user', content: '请写一篇 2000 字的长文，主题是海洋。' }],
      signal: ctrl.signal,
    });
    console.log(`  cancelled = ${r3.cancelled}`);
    console.log(`  已收长度  = ${r3.text.length}（中断后不应发送这段残文）`);
  } catch (e) {
    console.log(`  抛出：${e.code} ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  /* ---- 4. 坏 key 的报错可读性 ---- */
  console.log('\n[4] 坏 key 的报错是否可读');
  const bad = new LlmClient({ baseUrl: BASE_URL, model: MODEL, apiKey: 'sk-invalid-000000' });
  try {
    await bad.chat({ messages: [{ role: 'user', content: 'hi' }] });
    console.log('  ✖ 竟然成功了？坏 key 不该成功');
  } catch (e) {
    console.log(`  code=${e.code} status=${e.status} retryable=${e.retryable}`);
    console.log(`  message=${e.message}`);
  }

  console.log('\n✓ 真模型联调结束');
}

main().catch((e) => {
  console.error(`\n✖ 失败：${e.code ?? ''} ${e.message}`);
  process.exit(1);
});
