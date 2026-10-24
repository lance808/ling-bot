/**
 * 分条解析的**边界**：文档 §4 里那几行状态描述，逐条钉死
 *
 * `reply-split.test.mjs` 覆盖了主路径与 5 类降级；这里补的是它对
 * 「边界情况的处理」表里**没有单独断言**的几条：
 *
 *   · 未闭合围栏 → 原样发出，**不编造结尾**（顶层 / 围栏之后各一处）
 *   · 多处围栏 + 条数上限 → 内容一条都不丢
 *   · maxMessages = 1 → 一条，且不把协议语法泄露给用户
 *   · 围栏前后文字并进相邻那一条（等值断言，不是"包含"）
 *   · 大小写 / 空格 / CRLF 同时出现
 *
 * 这些都不是"格式好不好看"的问题：每一条错了都会让用户看到
 * 一段没人想看的 JSON 或半截代码。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitReply, SPLIT_FENCE_LANG } from '../src/reply/split.mjs';

const block = (items) => ['```' + SPLIT_FENCE_LANG, JSON.stringify(items), '```'].join('\n');

/** 数一段文本里有几个 ``` */
const fenceCount = (s) => (String(s).match(/```/g) ?? []).length;

/* -------------------------------------------------------- 未闭合围栏 */

test('★ 顶层 ling-msgs 围栏没闭合 → 整条原样发，不补结尾', () => {
  const text = ['```' + SPLIT_FENCE_LANG, '["甲","乙"]'].join('\n');
  const r = splitReply(text);

  assert.equal(r.mode, 'plain');
  assert.equal(r.messages.length, 1);
  assert.deepEqual(r.messages, [text], '一个字都不能改');
  assert.equal(fenceCount(r.messages[0]), 1, '不能凭空补一个 ``` 结尾');
});

test('★ 围栏之后的代码块没闭合 → 原样留着，不补结尾', () => {
  const text = block(['说得对。', '我贴一段：']) + '\n```js\nconst a = 1;';
  const r = splitReply(text);

  assert.equal(r.mode, 'structured');
  const last = r.messages[r.messages.length - 1];
  assert.match(last, /const a = 1;/);
  assert.equal(fenceCount(last) % 2, 1, '未闭合的代码块不能被"修复"成闭合');
});

test('未闭合的代码块自成一條（不并进上一条、也不被截断）', () => {
  /*
   * 这里守的是"内容不丢、边界不乱"：
   * 上一条是完整的一句话，后面那条是个没写完的代码块。
   * 合回上一条会把一句完整的话变成"半截代码的引言"；
   * 丢掉后半段则是丢内容。所以正确的是**各自成条、原样发出**。
   */
  const text = block(['第一句。', '看代码：\n```js\nconst a = 1;']);
  const r = splitReply(text);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0], '第一句。');
  assert.match(r.messages[1], /const a = 1;/);
  assert.equal(fenceCount(r.messages[1]) % 2, 1, '未闭合就是未闭合，别硬修');
});

/* -------------------------------------------------- 多处围栏 + 条数上限 */

test('★ 两处分条块 + maxMessages=2 → 内容一条都不丢', () => {
  const text = [block(['甲一', '甲二']), block(['乙一', '乙二'])].join('\n\n');
  const r = splitReply(text, { maxMessages: 2 });

  assert.equal(r.messages.length, 2);
  const all = r.messages.join('\n');
  for (const piece of ['甲一', '甲二', '乙一', '乙二']) {
    assert.ok(all.includes(piece), `丢了 ${piece}`);
  }
  assert.ok(!all.includes(SPLIT_FENCE_LANG), '协议标记不能泄露给用户');
});

test('两处分条块之间的文字并进前一块的最后一条（不独立成碎气泡）', () => {
  const text = [block(['甲', '乙']), '中间一句', block(['丙', '丁'])].join('\n');
  const r = splitReply(text, { maxMessages: 10 });
  assert.deepEqual(r.messages, ['甲', '乙\n中间一句', '丙', '丁']);
});

/* ------------------------------------------------------------ 只有一条 */

test('★ maxMessages=1 → 只发一条，且不含协议语法', () => {
  const r = splitReply(block(['甲', '乙', '丙']), { maxMessages: 1 });
  assert.equal(r.messages.length, 1);
  for (const piece of ['甲', '乙', '丙']) {
    assert.ok(r.messages[0].includes(piece), `丢了 ${piece}`);
  }
  assert.ok(!r.messages[0].includes(SPLIT_FENCE_LANG), '不能把围栏发给用户');
  assert.equal(r.clamped, true);
});

/* -------------------------------------------------- 围栏前后文字的归属 */

test('★ 围栏前后文字：前 → 第一条，后 → 最后一条（等值断言）', () => {
  const text = ['分两条说：', block(['第一条', '第二条']), '就这些。'].join('\n');
  const r = splitReply(text);
  assert.deepEqual(r.messages, ['分两条说：\n第一条', '第二条\n就这些。']);
});

/* --------------------------------------------- 大小写 / 空格 / CRLF 同时 */

test('★ 大写 + 前后空格 + CRLF 同时出现也认', () => {
  const text = '```   LING-MSGS   \r\n["甲","乙"]\r\n   ```';
  const r = splitReply(text);
  assert.equal(r.mode, 'structured');
  assert.deepEqual(r.messages, ['甲', '乙']);
});

test('围栏内容前后有空行也认（模型爱空行）', () => {
  const text = '```' + SPLIT_FENCE_LANG + '\n\n["甲","乙"]\n\n```';
  assert.deepEqual(splitReply(text).messages, ['甲', '乙']);
});

/* -------------------------------------------------- 元素内代码块跨三段 */

test('★ 代码块跨三个元素 → 合回一条，另一条独立', () => {
  const r = splitReply(
    block(['看代码：\n```js\nconst a = 1;', 'const b = 2;', 'const c = 3;\n```\n就这样。', '另外一件事。']),
  );
  assert.equal(r.messages.length, 2);
  assert.match(r.messages[0], /const a = 1;[\s\S]*const b = 2;[\s\S]*const c = 3;/);
  assert.equal(fenceCount(r.messages[0]) % 2, 0, '合回之后围栏必须成对');
  assert.equal(r.messages[1], '另外一件事。');
});
