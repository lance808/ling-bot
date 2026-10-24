/**
 * LlmClient：普通 function tools 必须进入 HTTP 请求体
 *
 * 这是一条曾经真实漏掉的链路：agent-loop 已经调用了
 * `llm.chat({ tools: toOpenAiTools(runner.availableTools()) })`，
 * 但 client 只在“服务商原生联网”有计划时才写 `body.tools`。
 * 结果是没有开原生联网时，插件工具根本没发给模型；模型只会回答
 * “我没有生图能力”，而日志里看起来一切正常。
 *
 * 这里用本地 SSE 假上游捕获请求体，不联网、不花钱。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { LlmClient } from '../src/llm/client.mjs';

/**
 * 起一个只回一段文本的本地 SSE 上游，记录请求体。
 *
 * @param {import('node:test').TestContext} t
 */
async function makeUpstream(t) {
  /** @type {any[]} */
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    bodies,
  };
}

function clientFor(baseUrl) {
  return new LlmClient({
    baseUrl,
    model: 'test-model',
    apiKey: 'sk-test-tools',
    timeoutMs: 5000,
    maxRetries: 0,
  });
}

const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'plugin_image_generate',
    description: '生成图片',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
};

test('普通 function tools 会写入请求体，并设置 tool_choice=auto', async (t) => {
  const { baseUrl, bodies } = await makeUpstream(t);
  const result = await clientFor(baseUrl).chat({
    messages: [{ role: 'user', content: '帮我生成一张猫的图片' }],
    tools: [IMAGE_TOOL],
  });

  assert.equal(result.text, 'ok');
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].tools, [IMAGE_TOOL]);
  assert.equal(bodies[0].tool_choice, 'auto');
});

test('没有工具或空工具集时不写 tools/tool_choice（保持旧请求体）', async (t) => {
  const { baseUrl, bodies } = await makeUpstream(t);
  await clientFor(baseUrl).chat({ messages: [{ role: 'user', content: 'hi' }] });
  await clientFor(baseUrl).chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].tools, undefined);
  assert.equal(bodies[0].tool_choice, undefined);
  assert.equal(bodies[1].tools, undefined);
  assert.equal(bodies[1].tool_choice, undefined);
});

test('原生联网计划存在时，function tools 与原生工具必须同时保留', async (t) => {
  const { baseUrl, bodies } = await makeUpstream(t);
  const nativeTool = { type: 'web_search', web_search: { enable: true } };
  const client = new LlmClient({
    baseUrl,
    model: 'test-model',
    apiKey: 'sk-test-tools',
    timeoutMs: 5000,
    maxRetries: 0,
    webSearch: () => ({ provider: 'zhipu', bodyPatch: {}, tools: [nativeTool] }),
  });

  await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [IMAGE_TOOL],
  });

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].tools, [IMAGE_TOOL, nativeTool]);
  assert.equal(bodies[0].tool_choice, 'auto');
});
