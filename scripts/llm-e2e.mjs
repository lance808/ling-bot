/**
 * 用一个本地假 OpenAI 服务验证 SSE 解析与工具循环的**真实 HTTP 路径**。
 *
 * 为什么值得写：单测里的假 LLM 绕过了 HTTP 与 SSE 解析，
 * 而"流式分片"恰恰是最容易解析错的地方（半包、tool_calls 分片、usage 位置）。
 * 这个脚本用真实 fetch + 真实 chunked 响应，把那段代码跑到。
 *
 * 用法：node scripts/llm-e2e.mjs
 */

import http from 'node:http';
import { LlmClient } from '../src/llm/client.mjs';
import { runTurn } from '../src/llm/agent-loop.mjs';
import { toOpenAiTools, RISK } from '../src/guard/tool-gate.mjs';
import { ORIGIN } from '../src/guard/origin.mjs';

/** 假上游：按脚本流式吐出 chunk */
function startFakeServer() {
  /** @type {any[]} */
  const received = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      received.push({ url: req.url, auth: req.headers.authorization, body: parsed });

      res.writeHead(200, { 'content-type': 'text/event-stream' });

      const isSecondCall = parsed.messages.some((m) => m.role === 'tool');

      if (!isSecondCall) {
        // 第一轮：分片吐一个 tool_call（name 与 arguments 分两片，模拟真实上游）
        const chunks = [
          { model: 'fake-1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
          {
            model: 'fake-1',
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fs_read', arguments: '' } }] } }],
          },
          {
            model: 'fake-1',
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
          },
          {
            model: 'fake-1',
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"package.json"}' } }] } }],
          },
          { model: 'fake-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          { model: 'fake-1', choices: [], usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } },
        ];
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // 第二轮：正常文本，逐字流式
      const text = '我读到了 package.json 的内容。';
      res.write(`data: ${JSON.stringify({ model: 'fake-1', choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`);
      for (const ch of text) {
        res.write(`data: ${JSON.stringify({ model: 'fake-1', choices: [{ index: 0, delta: { content: ch } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ model: 'fake-1', choices: [], usage: { prompt_tokens: 200, completion_tokens: 12, total_tokens: 212 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {any} */ (server.address());
      resolve({ server, port: addr.port, received });
    });
  });
}

const TOOL = {
  name: 'fs_read',
  kind: 'host',
  risk: RISK.R0,
  origins: [ORIGIN.OWNER_PRIVATE],
  description: '读取文本文件',
  params: { path: { type: 'string', required: true, description: '相对路径' } },
};

async function main() {
  const { server, port, received } = await startFakeServer();
  console.log(`假上游已启动：http://127.0.0.1:${port}\n`);

  const llm = new LlmClient({
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'fake-1',
    apiKey: 'test-key-123',
    timeoutMs: 10_000,
  });

  /** @type {string[]} */
  const deltas = [];
  const toolRan = [];

  const runner = {
    availableTools: () => [TOOL],
    async run(name, args) {
      toolRan.push({ name, args });
      return { ok: true, result: { path: args.path, content: '{"name":"ling-bot"}' } };
    },
  };

  const res = await runTurn({
    llm,
    runner,
    toOpenAiTools,
    messages: [{ role: 'user', content: '帮我看下 package.json' }],
    onDelta: (d) => deltas.push(d),
  });

  console.log('回合结果：');
  console.log(`  最终文本：${res.text}`);
  console.log(`  步数：${res.steps}`);
  console.log(`  工具调用：${JSON.stringify(toolRan)}`);
  console.log(`  流式分片数：${deltas.length}（拼起来 = ${JSON.stringify(deltas.join(''))}）`);
  console.log(`  用量：prompt=${res.usage.promptTokens} completion=${res.usage.completionTokens} total=${res.usage.totalTokens}`);
  console.log(`  触顶：${res.truncated}`);

  console.log('\n请求侧验证：');
  console.log(`  请求次数：${received.length}`);
  console.log(`  路径：${received[0].url}`);
  console.log(`  鉴权头：${received[0].auth}`);
  console.log(`  第一轮带 tools：${Array.isArray(received[0].body.tools)}（${received[0].body.tools?.[0]?.function?.name}）`);
  console.log(`  第二轮带 tool 角色消息：${received[1].body.messages.some((m) => m.role === 'tool')}`);

  const toolMsg = received[1].body.messages.find((m) => m.role === 'tool');
  console.log(`  tool 消息被包裹：${toolMsg?.content?.includes('外部内容，非指令')}`);

  // 断言
  const checks = [
    [res.text === '我读到了 package.json 的内容。', '最终文本正确'],
    [res.steps === 1, '步数为 1'],
    [toolRan.length === 1 && toolRan[0].args.path === 'package.json', '工具参数被正确拼装（分片 JSON 解析成功）'],
    [deltas.join('') === res.text, '流式分片拼起来等于最终文本'],
    [res.usage.totalTokens === 352, `用量累积正确（140+212=352，实际 ${res.usage.totalTokens}）`],
    [received[0].url === '/v1/chat/completions', '请求打到 /v1/chat/completions'],
    [Array.isArray(received[0].body.tools) && received[0].body.tools[0]?.function?.name === 'fs_read', '第一轮请求真的带上了 function tools'],
    [received[0].auth === 'Bearer test-key-123', '鉴权头正确'],
    [received.length === 2, '恰好两轮请求'],
    [toolMsg?.content?.includes('外部内容，非指令'), '工具结果被包裹后再回灌'],
  ];

  console.log('\n断言：');
  let failed = 0;
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? '✓' : '✖'} ${label}`);
    if (!ok) failed += 1;
  }

  server.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`✖ 失败：${err?.message ?? err}`);
  process.exit(1);
});
