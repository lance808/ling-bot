/**
 * 多模态消息组装（提示层 + 工具回灌） —— docs/vision-contract.md §6 / §7 / §8
 *
 * 这个文件守的是两个**不会报错**的故障：
 *
 *   1. 加了图片支持之后，**没有图片的旧路径**悄悄变了形状 ——
 *      于是纯文本模型收到一个 content 数组，请求 400，而所有人以为
 *      是"上游又抽风了"。所以第一条断言是"逐字段一致"，不是"包含某某"。
 *
 *   2. 工具取回的图被塞进 tool 消息 —— base64 被 wrapToolResult 的
 *      8000 字符截断成半截字符串，模型看到一堆乱码，链路一声不响。
 *
 * 每条断言都对着一个具体的失败方式写，不测"看起来对不对"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMessages,
  isAllowedImageDataUrl,
  wrapToolResult,
  MAX_IMAGES_PER_MESSAGE,
} from '../src/llm/prompt.mjs';
import { runTurn } from '../src/llm/agent-loop.mjs';
import { looksLikeImageRejection } from '../src/llm/client.mjs';

/* ------------------------------------------------------------------ 素材 */

/** 最小合法的 PNG data URL（1x1 透明像素） */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

const img = (dataUrl, extra = {}) => ({ dataUrl, mime: 'image/png', ...extra });

/** 造一份 context，recent 由调用方给 */
function ctx(recent, extra = {}) {
  return { convKey: 'group:1', isGroup: true, recent, ...extra };
}

/* --------------------------------------------------------- 向后兼容（硬） */

test('★ 没有 images 时，content 必须仍然是字符串（逐字段一致）', () => {
  /*
   * 这是整个视觉改动最危险的回归点：数组 content 一旦"顺手"应用到所有
   * 消息上，所有纯文本模型立刻 400，而且现象是"换了模型就坏"，
   * 极难联想到是提示层改了形状。
   */
  const built = buildMessages({
    persona: 'P',
    role: 'R',
    context: ctx([
      { role: 'user', nickname: '小明', text: '看这个' },
      { role: 'assistant', text: '看了' },
      { role: 'tool', text: '工具结果' },
      { role: 'user', text: '没昵称的' },
    ]),
  });

  const dialog = built.slice(1); // 第一条是 system
  assert.deepEqual(dialog, [
    { role: 'user', content: '小明：看这个' },
    { role: 'assistant', content: '看了' },
    { role: 'user', content: '工具结果' },
    { role: 'user', content: '群友：没昵称的' },
  ]);
  for (const m of built) assert.equal(typeof m.content, 'string', '一条都不能是数组');
});

test('★ images 为空数组 / 空对象 / 非数组时，仍然退回字符串 content', () => {
  /*
   * 调用方会给我们各种"看起来像有图"的形状：
   * 视觉链路可能返回 images: []（这回合一张都没取到），
   * 老代码可能把 images 写成对象或字符串。这些都不能改变 content 形状。
   */
  const cases = [[], {}, 'nope', null, undefined, [{ dataUrl: 'http://x/a.png', mime: 'image/png' }]];
  for (const images of cases) {
    const built = buildMessages({
      persona: '',
      context: ctx([{ role: 'user', nickname: 'A', text: 'hi', images }]),
    });
    const last = built[built.length - 1];
    assert.equal(typeof last.content, 'string', `images=${JSON.stringify(images)} 时必须是字符串`);
  }
});

/* ------------------------------------------------------------- 数组 content */

test('有 images 时 content 是数组，且 text 必须在第一个元素', () => {
  const built = buildMessages({
    persona: '',
    context: ctx([{ role: 'user', nickname: '小明', text: '看这个', images: [img(PNG)] }]),
  });
  const last = built[built.length - 1];

  assert.ok(Array.isArray(last.content), 'content 要是数组');
  assert.deepEqual(last.content[0], { type: 'text', text: '小明：看这个' }, 'text 必须最前且带昵称前缀');
  assert.deepEqual(last.content[1], { type: 'image_url', image_url: { url: PNG } });
});

test('多张图按顺序全部保留，顺序与输入一致', () => {
  const built = buildMessages({
    persona: '',
    context: ctx([{ role: 'user', text: '三张', images: [img(PNG), img(JPG), img(GIF)] }]),
  });
  const content = built[built.length - 1].content;
  assert.equal(content.length, 4, '1 个 text + 3 个 image_url');
  assert.deepEqual(content.slice(1).map((p) => p.image_url.url), [PNG, JPG, GIF]);
});

test('★ assistant 消息永不带 image_url（否则等于伪造模型自己发过图）', () => {
  const built = buildMessages({
    persona: '',
    context: ctx([{ role: 'assistant', text: '我说的话', images: [img(PNG)] }]),
  });
  /*
   * 注意不能取 built 的最后一条：recent 以 assistant 结尾时提示层会追加
   * 一条「（继续）」。这里要断言的是那条 assistant 消息本身。
   */
  const assistant = built.find((m) => m.role === 'assistant' && m.content === '我说的话');
  assert.ok(assistant, 'assistant 消息要原样保留');
  assert.equal(typeof assistant.content, 'string', 'assistant 的 content 必须是纯文本');
  assert.ok(!built.some((m) => Array.isArray(m.content)), '整份提示里不该出现数组 content');
});

test('★ system 永远不是数组 content（图片不能抬进最高权限层）', () => {
  /*
   * 断言的是**结构化**形态：system 的 content 必须是字符串。
   * 注意"人格文本里恰好写了 data URL"是另一件事 —— 那是用户自己写的字，
   * 我们不做内容过滤（提示注入只能靠结构防，见 prompt.mjs 文件头）。
   * 真正要拦的是"把 images 数组拼进 system 消息"。
   */
  const built = buildMessages({
    persona: '人格文本',
    context: ctx([{ role: 'user', text: '图片', images: [img(PNG)] }], {
      memory: ['记忆'],
      trigger: '被 @',
      proactive: true,
    }),
  });
  const systems = built.filter((m) => m.role === 'system');
  assert.ok(systems.length >= 2, '至少有行为层与记忆层两条 system');
  for (const m of systems) {
    assert.equal(typeof m.content, 'string', 'system.content 必须是字符串');
    assert.ok(!m.content.includes('image_url'), 'system 里不能出现 image_url 结构');
  }
});

/* --------------------------------------------------------- dataUrl 白名单 */

test('★ 非 image 的 data URL 一律丢弃：svg / 非图片 / 空载荷 / 脏串', () => {
  /*
   * SVG 能带脚本，`data:text/html` 更是完全无关的东西。
   * 这里不是"格式偏好"：content[].image_url.url 会被原样发给上游。
   */
  const bad = [
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,', // 空载荷
    'data:image/png;base64,@@@@', // 非 base64 字符
    'data:image/png;base64,AAAA\nBBBB', // 换行
    'data:image/bmp;base64,Qk0=',
    'https://multimedia.nt.qq.com.cn/x?sign=abc',
    'base64://AAA',
    '',
  ];
  for (const dataUrl of bad) {
    const built = buildMessages({
      persona: '',
      context: ctx([{ role: 'user', nickname: 'A', text: 't', images: [img(dataUrl)] }]),
    });
    const last = built[built.length - 1];
    assert.equal(typeof last.content, 'string', `应丢弃：${dataUrl.slice(0, 40)}`);
  }
});

test('★ 脏图混在好图里：只丢脏的那张，其余照常提交', () => {
  // 一张坏图不该让整条消息退回纯文本（那样用户会以为"图又坏了"）
  const built = buildMessages({
    persona: '',
    context: ctx([
      {
        role: 'user',
        nickname: 'A',
        text: 't',
        images: [img('bogus'), img(PNG), { dataUrl: 42 }, img(JPG), null, 'x'],
      },
    ]),
  });
  const content = built[built.length - 1].content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content.slice(1).map((p) => p.image_url.url), [PNG, JPG]);
});

test('★ 每条最多 4 张，多余的忽略（不是报错）', () => {
  const many = Array.from({ length: 9 }, () => img(PNG));
  const built = buildMessages({
    persona: '',
    context: ctx([{ role: 'user', text: '很多图', images: many }]),
  });
  const content = built[built.length - 1].content;
  assert.equal(MAX_IMAGES_PER_MESSAGE, 4);
  assert.equal(content.length, 1 + 4, '1 个 text + 最多 4 张');
});

test('四种允许的格式都能通过白名单', () => {
  for (const u of [PNG, JPG, GIF, WEBP]) assert.equal(isAllowedImageDataUrl(u), true, u.slice(0, 20));
  for (const u of ['', 'x', null, undefined, 123, {}]) assert.equal(isAllowedImageDataUrl(u), false);
});

/* ------------------------------------------------------ 工具结果的图像回灌 */

/** 按脚本回话的假 LLM，并记下每次请求的 messages */
function scriptedLlm(script) {
  let i = 0;
  return {
    calls: [],
    async chat(req) {
      this.calls.push(JSON.parse(JSON.stringify(req.messages)));
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return {
        text: step.text ?? '',
        toolCalls: step.toolCalls ?? [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: false },
        model: 'fake',
        cancelled: false,
      };
    },
  };
}

/** 固定返回某个 outcome 的 runner */
function runnerReturning(outcome) {
  return {
    ran: [],
    availableTools: () => [{ name: 'chat_image', kind: 'host', description: '取图', params: {} }],
    async run(name, args) {
      this.ran.push({ name, args });
      return outcome;
    },
  };
}

const toOpenAiTools = () => [{ type: 'function', function: { name: 'chat_image' } }];

async function runWith(outcome) {
  const llm = scriptedLlm([
    { toolCalls: [{ id: 'c1', name: 'chat_image', arguments: '{"messageId":"1"}' }] },
    { text: '看到了' },
  ]);
  const runner = runnerReturning(outcome);
  const res = await runTurn({
    llm,
    runner,
    toOpenAiTools,
    messages: [{ role: 'user', content: '看图' }],
  });
  // 第二次请求 = 模型看到 tool 结果与图片之后的那一次
  return { res, messages: llm.calls[1], runner };
}

test('★ 工具返回图片：tool 消息只放文本并注明"附 N 张图片，见下一条消息"', async () => {
  const { messages } = await runWith({
    ok: true,
    result: { text: '消息 123 的媒体内容（1 项）', images: [img(PNG, { label: 'a.png' })] },
  });

  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '必须有 tool 消息');
  assert.equal(typeof toolMsg.content, 'string', 'tool 消息必须是纯文本');
  assert.match(toolMsg.content, /消息 123 的媒体内容/, '保留工具的 text');
  assert.match(toolMsg.content, /附 1 张图片，见下一条消息/);
  assert.ok(!toolMsg.content.includes('base64,'), 'base64 绝不能进 tool 消息（会被截断）');
});

test('★ 图片由紧随其后的 user 消息承载，且 text 在最前', async () => {
  const { messages } = await runWith({
    ok: true,
    result: { text: '取回一张', images: [img(PNG), img(JPG)] },
  });

  const toolIdx = messages.findIndex((m) => m.role === 'tool');
  assert.ok(toolIdx >= 0);
  const followup = messages[toolIdx + 1];
  assert.ok(followup, 'tool 消息之后必须有下一条');
  assert.equal(followup.role, 'user', '图片用 user 角色承载，不能用 assistant 伪造');
  assert.ok(Array.isArray(followup.content), 'content 必须是数组');
  assert.deepEqual(followup.content[0], { type: 'text', text: '（工具 chat_image 取回的图片）' });
  assert.deepEqual(
    followup.content.slice(1).map((p) => p.image_url.url),
    [PNG, JPG],
  );
  // 顺序：assistant(tool_calls) → tool → user(图片)
  const assistantIdx = messages.findIndex((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistantIdx < toolIdx, 'assistant.tool_calls 必须在 tool 之前');
});

test('★ 老形状工具结果不受影响：{content} 仍原样 JSON 进 tool 消息', async () => {
  /*
   * 这条是"向后兼容"在 agent-loop 这一侧的落点。
   * 没有 images 字段的结果必须走**改动前**的完全同一条路径：
   * wrapToolResult(name, result) 里的 JSON.stringify。
   */
  const { messages, runner } = await runWith({ ok: true, result: { content: '文件内容' } });
  assert.equal(runner.ran.length, 1);

  const toolMsg = messages.find((m) => m.role === 'tool');
  const expected = wrapToolResult('chat_image', { content: '文件内容' });
  assert.equal(toolMsg.content, expected, '必须与旧实现的输出逐字符相同');
  assert.ok(!messages.some((m) => Array.isArray(m.content)), '没有图时不该出现数组 content');
});

test('★ 工具返回的全是脏图：不提交任何图，也不把 base64 漏进文本', async () => {
  const { messages } = await runWith({
    ok: true,
    result: {
      text: '取回失败',
      images: [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }, { dataUrl: 'data:image/png;base64,' }],
    },
  });

  assert.ok(!messages.some((m) => Array.isArray(m.content)), '一张合法图都没有 → 不追加 user 消息');
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /取回失败/, '工具的 text 仍然要在');
  assert.match(toolMsg.content, /这次没有可提交的图片/, '要说清楚没图，而不是"附 0 张，见下一条"');
  assert.ok(!toolMsg.content.includes('PHN2Zz4'), '未通过白名单的载荷不能出现在提示里');
});

test('★ images 字段本身是脏形状时，也绝不能把它的内容 stringify 进 tool 文本', async () => {
  /*
   * 这是"排除法 vs 白名单"在 agent-loop 这一侧的对应问题：
   * 如果实现只对"数组里的每一项"做校验，而没先确认 images **是不是数组**，
   * 那么 `images: '<base64>'` 这种脏形状就会顺着 JSON.stringify 流进
   * tool 文本，再被 wrapToolResult 的 8000 字符截断 —— 正是需求点名的故障。
   *
   * 正确行为：只要结果上存在 `images` 这个键，无论它是什么形状，
   * 都整块摘掉（图片走结构化通道，不走文本）。
   */
  const dirty = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    { url: 'https://multimedia.nt.qq.com.cn/x?rkey=SECRET' },
    42,
    null,
    ['data:image/png;base64,iVBORw0KGgo='], // 数组里直接放了字符串而不是对象
  ];

  for (const images of dirty) {
    const { messages } = await runWith({ ok: true, result: { text: '取回结果', images } });
    const toolMsg = messages.find((m) => m.role === 'tool');
    assert.ok(!messages.some((m) => Array.isArray(m.content)), '没有合法图 → 不追加 user 消息');
    assert.match(toolMsg.content, /取回结果/, '工具的 text 仍然要在');
    assert.match(toolMsg.content, /这次没有可提交的图片/, '要如实说没图');
    assert.ok(!toolMsg.content.includes('iVBORw0KGgo'), 'base64 不能进 tool 文本');
    assert.ok(!toolMsg.content.includes('SECRET'), 'URL 不能进 tool 文本');
    assert.ok(!toolMsg.content.includes('rkey='));
  }
});

test('工具返回 5 张图：只提交 4 张（单条消息上限）', async () => {
  const { messages } = await runWith({
    ok: true,
    result: { text: '五张', images: Array.from({ length: 5 }, () => img(PNG)) },
  });
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /附 4 张图片/);
  const followup = messages[messages.findIndex((m) => m.role === 'tool') + 1];
  assert.equal(followup.content.length, 1 + 4);
});

test('text 之外的字段照旧 JSON.stringify 进文本（保持现有语义）', async () => {
  const { messages } = await runWith({
    ok: true,
    result: { text: '说明', images: [img(PNG)], messageId: '123', count: 2 },
  });
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /messageId/);
  assert.match(toolMsg.content, /"123"/);
  assert.match(toolMsg.content, /"count": 2/, '其余字段要照旧 stringify（缩进 2 空格）');
});

test('工具调用失败时行为不变：不回灌图片，只回错误', async () => {
  const llm = scriptedLlm([
    { toolCalls: [{ id: 'c1', name: 'chat_image', arguments: '{}' }] },
    { text: '好吧' },
  ]);
  const runner = {
    availableTools: () => [{ name: 'chat_image', kind: 'host', description: '', params: {} }],
    async run() {
      return { ok: false, code: 'E3102', message: '网关取图失败' };
    },
  };
  await runTurn({ llm, runner, toOpenAiTools, messages: [] });
  const messages = llm.calls[1];
  assert.ok(!messages.some((m) => Array.isArray(m.content)));
  assert.match(messages.find((m) => m.role === 'tool').content, /E3102/);
});

/* -------------------------------------------------- looksLikeImageRejection */

test('★ 只有 400/413/415/422 + 图片关键词才算"图片被拒收"', () => {
  for (const status of [400, 413, 415, 422]) {
    assert.equal(looksLikeImageRejection(status, 'unsupported image_url in messages'), true, `${status} image`);
    assert.equal(looksLikeImageRejection(status, '当前模型不支持图片输入'), true, `${status} 中文`);
  }
  assert.equal(looksLikeImageRejection(415, 'unsupported media type: image/webp'), true);
  assert.equal(looksLikeImageRejection(400, 'vision is not available for this model'), true);
  /*
   * 415 只说 "unsupported media type"、一个字都没提图片时判 false：
   * 那可能是 tools 里传了别的附件类型，抹掉图片解决不了问题。
   */
  assert.equal(looksLikeImageRejection(415, 'unsupported media type'), false);
});

test('★ 401/403/429/5xx 一律 false：那是 key/额度/服务问题，不是"不支持图片"', () => {
  /*
   * 误判的代价是把"key 配错了"记录成"模型不支持读图"，
   * 然后用户去改模型、发现怎么改都没用 —— 这条断言就是拦这个的。
   */
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    assert.equal(looksLikeImageRejection(status, 'unsupported image'), false, `${status} 必须 false`);
    assert.equal(looksLikeImageRejection(status, '不支持图片'), false);
  }
});

test('关键词不命中时 false：400 的绝大多数原因和图片无关', () => {
  const unrelated = [
    'max_tokens is too large',
    'invalid_request_error: messages must not be empty',
    "Invalid value for 'tools'",
    '模型名称错误',
  ];
  for (const msg of unrelated) assert.equal(looksLikeImageRejection(400, msg), false, msg);
});

test('脏输入不炸：状态码/文本类型不对时 false', () => {
  for (const s of ['400', null, undefined, NaN, 400.5, {}, []]) {
    // '400' 字符串是数字 → 接受；其余一律 false（宁可不降级也不误判）
    const expected = s === '400';
    assert.equal(looksLikeImageRejection(s, 'unsupported image'), expected, `status=${String(s)}`);
  }
  for (const m of [null, undefined, 42, {}, []]) {
    assert.equal(looksLikeImageRejection(400, m), false, `message=${String(m)}`);
  }
});

test('大小写不敏感，但保留子串匹配', () => {
  assert.equal(looksLikeImageRejection(400, 'Unsupported IMAGE'), true);
  assert.equal(looksLikeImageRejection(400, 'IMAGE_URL invalid'), true);
  assert.equal(looksLikeImageRejection(400, '多模态不可用'), true);
});
