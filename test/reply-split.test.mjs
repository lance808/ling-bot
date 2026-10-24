/**
 * 回复分条协议 —— 模型的一次输出怎么变成若干个气泡
 *
 * ## 这个文件守的是什么
 *
 * 分条最危险的失败方式不是"没分开"，而是**丢内容**或**把一句话拆断**：
 * 用户看到两条语义不接的话，会以为机器人坏了。所以这里每条用例都盯着
 * "内容有没有原样留下"和"边界是不是模型显式给的"。
 *
 * 协议设计成可校验的（围栏 + JSON 数组），因此可以逐条钉死：
 *   · 单条 → 不分
 *   · 多条 → 按数组顺序分
 *   · 普通换行 → **不拆**（这是旧实现的 bug：整段落成一个气泡）
 *   · 代码块 → 绝不切开
 *   · 无效格式 → 整条原样降级，不猜
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSplitBlock,
  splitReply,
  clampToMax,
  mergeUnbalancedFences,
  isFenceOpen,
  SPLIT_FENCE_LANG,
  DEFAULT_MAX_MESSAGES,
  MAX_MESSAGES_HARD_CAP,
} from '../src/reply/split.mjs';

/** 造一个分条块 */
const block = (items) =>
  ['```' + SPLIT_FENCE_LANG, JSON.stringify(items), '```'].join('\n');

/* ------------------------------------------------------------------ 单条 */

test('普通回答（没有分条块）整条发出', () => {
  const r = splitReply('今天有点忙，晚点聊。');
  assert.equal(r.mode, 'plain');
  assert.deepEqual(r.messages, ['今天有点忙，晚点聊。']);
  assert.equal(r.reason, 'no-block');
});

test('分条块里只有一条时仍然是整条发', () => {
  const r = splitReply(block(['就这一句']));
  assert.deepEqual(r.messages, ['就这一句']);
  assert.equal(r.mode, 'plain', '只有一条没有拆的必要，走普通路径');
  assert.equal(r.reason, 'single');
});

test('空文本不出消息', () => {
  assert.deepEqual(splitReply('').messages, []);
  assert.deepEqual(splitReply('   \n  ').messages, []);
});

/* ------------------------------------------------------------------ 多条 */

test('★ 两条：按数组顺序，前后各一个气泡', () => {
  const r = splitReply(block(['第一件事做完了。', '第二件明天再说。']));
  assert.equal(r.mode, 'structured');
  assert.deepEqual(r.messages, ['第一件事做完了。', '第二件明天再说。']);
});

test('多条：空元素被丢掉，不产生空气泡', () => {
  const r = splitReply(block(['有内容', '   ', '', '也有内容']));
  assert.deepEqual(r.messages, ['有内容', '也有内容']);
});

test('★ 围栏外的说明文字不丢，但并进相邻一条（不产生碎气泡）', () => {
  /*
   * "分两条说："只有几个字，独立成一个气泡就是个碎片。
   * 并进相邻那一条之后：内容没丢、条数不变、也不会把 maxMessages 顶爆。
   */
  const text = ['分两条说：', block(['A 部分', 'B 部分']), '就这些。'].join('\n\n');
  const r = splitReply(text);
  assert.equal(r.messages.length, 2, '条数与数组元素数一致');
  assert.match(r.messages[0], /^分两条说：/);
  assert.match(r.messages[0], /A 部分$/m);
  assert.match(r.messages[1], /^B 部分/);
  assert.match(r.messages[1], /就这些。$/);
});

test('围栏前的说明 + 只有一条元素 → 仍然是一条（并进去，不造第二条）', () => {
  const r = splitReply(['先说一句：', block(['正文'])].join('\n\n'));
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /先说一句：/);
  assert.match(r.messages[0], /正文/);
});

/* ------------------------------------------------------------ 普通换行 */

test('★ 普通换行不拆（这就是旧 bug：整段落进一个气泡，但不能靠换行拆）', () => {
  /*
   * 关键点：**不能因为有空行就拆**。
   * 模型写段落时经常空行，那不代表它想分条；机械拆会把一段连贯的话
   * 切成几个没有主语的碎片。分条必须由协议显式给出。
   */
  const text = '第一段，讲背景。\n\n第二段，讲结论。\n\n第三段，讲下一步。';
  const r = splitReply(text);
  assert.equal(r.mode, 'plain');
  assert.deepEqual(r.messages, [text], '整段原样，一个字都不许动');
});

test('按句号/逗号不会被拆（不按标点机械拆分）', () => {
  const text = '好的。我明白了，那这件事就这么定，明天开始。';
  const r = splitReply(text);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0], text);
});

/* -------------------------------------------------------------- 代码块 */

test('★ 代码块整块留在同一条里（前提是不在分条块内被切开）', () => {
  const code = ['看这段：', '', '```js', 'const a = 1;', 'const b = 2;', '```', '', '就这样。'].join('\n');
  const r = splitReply(code);
  assert.equal(r.mode, 'plain');
  assert.deepEqual(r.messages, [code]);
  assert.equal(r.messages[0].includes('```js'), true, '代码围栏要原样保留');
  assert.equal(r.messages[0].includes('const b = 2;'), true);
});

test('★ 分条块内代码跨了两个元素时，自动合回一条', () => {
  /*
   * 模型不总是听话：它可能把一段代码切成两条。这里按围栏状态修复 ——
   * 否则用户会收到"上面一半"和"下面一半"两个都渲染不出的残块。
   */
  const r = splitReply(
    block([
      '先看代码：\n```js\nconst a = 1;',
      'const b = 2;\n```\n跑完就是这个结果。',
      '另一件事：明天再说。',
    ]),
  );
  assert.equal(r.messages.length, 2, '合成的代码块 + 另一件事');
  assert.match(r.messages[0], /const a = 1;[\s\S]*const b = 2;/);
  assert.match(r.messages[0], /```[\s\S]*```/, '修复后必须有完整的围栏');
  assert.equal(r.messages[1], '另一件事：明天再说。');
});

test('未闭合围栏：原样发出，不编造结尾', () => {
  const items = ['开头\n```py\nprint(1)'];
  const merged = mergeUnbalancedFences(items);
  assert.deepEqual(merged, ['开头\n```py\nprint(1)'], '不能凭空补 ```');
});

test('isFenceOpen：识别 ``` 与 ~~~，且成对', () => {
  assert.equal(isFenceOpen('无围栏'), false);
  assert.equal(isFenceOpen('```js\ncode'), true);
  assert.equal(isFenceOpen('```js\ncode\n```'), false);
  assert.equal(isFenceOpen('~~~\ncode'), true);
  assert.equal(isFenceOpen('~~~\ncode\n~~~'), false);
  // 闭合字符必须一致：``` 开头、~~~ 结尾不算闭合
  assert.equal(isFenceOpen('```\na\n~~~'), true);
});

test('表格与列表在普通文本里不会被拆', () => {
  const table = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  const list = ['要做三件事：', '- 备份', '- 改配置', '- 重启'].join('\n');
  for (const text of [table, list]) {
    const r = splitReply(text);
    assert.deepEqual(r.messages, [text]);
  }
});

/* ------------------------------------------------------------ 无效格式 */

test('★ JSON 不合法 → 整条原样降级，绝不猜', () => {
  const text = ['```' + SPLIT_FENCE_LANG, '["没闭合的数组"', '```'].join('\n');
  const r = splitReply(text);
  assert.equal(r.mode, 'plain');
  assert.equal(r.messages.length, 1);
  assert.match(r.reason, /invalid-json/);
  // 原文必须完整保留（包括那个坏围栏），否则用户不知道发生了什么
  assert.equal(r.messages[0].includes('没闭合的数组'), true);
});

test('顶层不是数组 → 降级', () => {
  const r = splitReply(block({ a: 1 }));
  assert.equal(r.mode, 'plain');
  assert.equal(r.reason, 'not-array');
});

test('★ 数组里有非字符串元素 → 降级（不做 String() 转换）', () => {
  /*
   * String({}) 会得到 "[object Object]"。把它发出去，用户看到的是一条
   * 乱码消息；而整段降级至少内容还在、还能看出模型想说什么。
   */
  const r = splitReply(['```' + SPLIT_FENCE_LANG, '[{"text":"x"}]', '```'].join('\n'));
  assert.equal(r.mode, 'plain');
  assert.equal(r.reason, 'non-string-item');
});

test('空数组 → 降级', () => {
  const r = splitReply(block([]));
  assert.equal(r.mode, 'plain');
  assert.equal(r.reason, 'empty');
});

test('普通代码块（语言不是 ling-msgs）不被当成协议', () => {
  const text = ['```json', '["a", "b"]', '```'].join('\n');
  const r = splitReply(text);
  assert.equal(r.mode, 'plain');
  assert.equal(r.reason, 'no-block');
});

test('写了两个分条块 → 内容都保留，条数按上限夹住', () => {
  const text = [block(['A']), block(['B'])].join('\n\n');
  const r = splitReply(text);
  const all = r.messages.join('\n');
  assert.ok(all.includes('A'), '第一块的内容不能丢');
  assert.ok(all.includes('B'), '第二块的内容也不能丢');
  assert.ok(!all.includes(SPLIT_FENCE_LANG), '协议块本身不该出现在发给用户的内容里');
});

/* -------------------------------------------------------------- 条数上限 */

test('★ 超过条数上限：并进最后一条，不丢内容', () => {
  const items = ['一', '二', '三', '四', '五'];
  const { items: out, clamped } = clampToMax(items, 3);
  assert.equal(clamped, true);
  assert.equal(out.length, 3);
  assert.equal(out[2], '三\n四\n五', '多出来的按顺序并进最后一条');
  // 内容一条都不能少
  for (const s of items) assert.ok(out.join('\n').includes(s), `丢了 ${s}`);
});

test('splitReply 会按 maxMessages 夹条数', () => {
  const r = splitReply(block(['a', 'b', 'c', 'd']), { maxMessages: 2 });
  assert.equal(r.messages.length, 2);
  assert.equal(r.clamped, true);
  assert.match(r.messages[1], /c[\s\S]*d/);
});

test('默认上限是少量（不是"随便多少条"）', () => {
  assert.ok(DEFAULT_MAX_MESSAGES >= 2 && DEFAULT_MAX_MESSAGES <= 5, '默认应是"少量消息"');
  assert.ok(MAX_MESSAGES_HARD_CAP >= DEFAULT_MAX_MESSAGES);
  const r = splitReply(block(Array.from({ length: 20 }, (_, i) => `第${i + 1}条`)));
  assert.ok(r.messages.length <= DEFAULT_MAX_MESSAGES, `实际 ${r.messages.length} 条`);
});

test('maxMessages 非法值回落到默认（不产生 0 条或 1e9 条）', () => {
  for (const bad of [0, -1, NaN, 'x', null, undefined]) {
    const r = splitReply(block(['a', 'b', 'c']), { maxMessages: /** @type {any} */ (bad) });
    assert.ok(r.messages.length >= 1 && r.messages.length <= MAX_MESSAGES_HARD_CAP);
  }
});

test('★ 关闭分条后即使写了协议也整条发（硬开关）', () => {
  const text = block(['a', 'b']);
  const r = splitReply(text, { enabled: false });
  assert.equal(r.mode, 'plain');
  assert.deepEqual(r.messages, [text], '原文照发，连协议块一起');
  assert.equal(r.reason, 'disabled');
});

/* ---------------------------------------------------------------- 解析器 */

test('parseSplitBlock：未命中时 found=false，调用方据此走原路径', () => {
  const r = parseSplitBlock('普通回答');
  assert.deepEqual(r, { found: false });
});

test('parseSplitBlock：命中时给出 before/after，便于调用方自己决定怎么拼', () => {
  const r = parseSplitBlock(['前', block(['x', 'y']), '后'].join('\n'));
  assert.equal(r.found, true);
  assert.equal(r.ok, true);
  assert.equal(r.before, '前');
  assert.equal(r.after, '后');
  assert.deepEqual(r.items, ['x', 'y']);
});

test('大小写与多余空格都认（模型不一定精确复刻标记）', () => {
  const r = splitReply(['```  LING-MSGS  ', '["a","b"]', '```'].join('\n'));
  assert.equal(r.mode, 'structured');
  assert.deepEqual(r.messages, ['a', 'b']);
});

test('CRLF 换行也认（Windows 上模型经手的文本可能是 CRLF）', () => {
  const text = '```' + SPLIT_FENCE_LANG + '\r\n["a","b"]\r\n```';
  const r = splitReply(text);
  assert.deepEqual(r.messages, ['a', 'b']);
});
