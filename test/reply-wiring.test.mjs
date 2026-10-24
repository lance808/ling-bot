/**
 * 分条功能的接线：提示词约定 + 配置校验 + 界面
 *
 * ## 为什么这三块要放在一起测
 *
 * 分条是**三处必须同时对上**的功能：
 *
 *   1. 提示词告诉模型写什么标记（`buildSplitGuidance`）
 *   2. 解析器认哪个标记（`SPLIT_FENCE_LANG`）
 *   3. 发送层按哪个上限切（`reply.maxMessages`）
 *
 * 任何一处漂移的表现都是"模型写了但没拆开"，而且不报错。
 * 所以这里断言的不是"函数返回值长什么样"，而是**三处的标记与数值一致**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMessages, buildSplitGuidance, SPLIT_FENCE_LANG as PROMPT_LANG } from '../src/llm/prompt.mjs';
import { SPLIT_FENCE_LANG as SPLIT_LANG, DEFAULT_MAX_MESSAGES, MAX_MESSAGES_HARD_CAP } from '../src/reply/split.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../src/config/schema.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------ 标记一致 */

test('★ 提示词里的标记与解析器认的是同一个（漂移会静默失效）', () => {
  assert.equal(PROMPT_LANG, SPLIT_LANG, '两边必须字面相同');
  assert.equal(SPLIT_LANG, 'ling-msgs');
});

/* ------------------------------------------------------------ 提示词 */

test('分条约定写进了 system prompt，且带上限条数', () => {
  const msgs = buildMessages({
    persona: '',
    context: { convKey: 'group:1', isGroup: true, recent: [], maxMessages: 4 },
  });
  const system = msgs[0].content;
  assert.match(system, new RegExp(SPLIT_LANG), '要出现分条标记');
  assert.match(system, /最多 4 条/, '上限要写进提示');
});

test('★ 上限为 1 时完全不提分条协议（说了只会让模型解释这件事）', () => {
  const guidance = buildSplitGuidance({ maxMessages: 1 });
  assert.equal(guidance, '');

  const msgs = buildMessages({
    persona: '',
    context: { convKey: 'group:1', isGroup: true, recent: [], maxMessages: 1 },
  });
  assert.ok(!msgs[0].content.includes(SPLIT_LANG), '提示里不该出现分条标记');
});

test('★ 提示明确禁止按标点/换行机械拆分、保护代码块', () => {
  const g = buildSplitGuidance({ maxMessages: 3 });
  assert.match(g, /不要|不按/, '要明确说不要机械拆');
  assert.match(g, /逗号|标点/, '要点出标点');
  assert.match(g, /代码块/, '要保护代码块');
  assert.match(g, /独立读懂/, '要说明一条消息要能独立读懂');
});

test('提示里不出现会误导的"用空行分段"说法', () => {
  const g = buildSplitGuidance({ maxMessages: 3 });
  assert.ok(!/空行/.test(g), '空行不是边界，提它会诱导模型用错方式');
});

/* ------------------------------------------------------------ 配置 */

test('★ reply 配置有默认值且落在合法区间', () => {
  assert.ok(DEFAULT_CONFIG.reply, '缺 reply 块');
  assert.equal(typeof DEFAULT_CONFIG.reply.splitEnabled, 'boolean');
  assert.ok(DEFAULT_CONFIG.reply.maxMessages >= 1);
  assert.ok(DEFAULT_CONFIG.reply.maxMessages <= MAX_MESSAGES_HARD_CAP);
  assert.ok(DEFAULT_CONFIG.reply.intervalMs >= 100);
  assert.ok(DEFAULT_CONFIG.reply.intervalMs <= 10000);
});

test('默认条数是"少量消息"，不是很多条', () => {
  assert.ok(DEFAULT_CONFIG.reply.maxMessages <= 5, `默认 ${DEFAULT_CONFIG.reply.maxMessages} 条偏多`);
  assert.equal(DEFAULT_CONFIG.reply.maxMessages, DEFAULT_MAX_MESSAGES, '配置默认值与解析器默认值要一致');
});

test('默认开启分条（升级后行为变好，不需要用户先去找开关）', () => {
  assert.equal(DEFAULT_CONFIG.reply.splitEnabled, true);
});

test('★ 老配置（没有 reply 块）能通过校验', () => {
  const v = validateConfig({ allow: { groups: [], private: [] } });
  assert.equal(v.reply.maxMessages, DEFAULT_CONFIG.reply.maxMessages, '缺失的块用默认值补齐');
});

test('★ maxMessages 越界在启动时硬失败（不静默夹）', () => {
  /*
   * 运行时的 normalize 会夹，但它**静默**：用户手改 config.json 写 100，
   * 起作用的是 10，而界面显示 100 —— 那是最难查的一类配置问题。
   */
  assert.throws(() => validateConfig({ reply: { maxMessages: 0 } }), /maxMessages/);
  assert.throws(() => validateConfig({ reply: { maxMessages: 11 } }), /maxMessages/);
  assert.throws(() => validateConfig({ reply: { maxMessages: 2.5 } }), /maxMessages/);
  assert.throws(() => validateConfig({ reply: { maxMessages: '3' } }), /maxMessages/);
});

test('intervalMs 越界在启动时硬失败', () => {
  assert.throws(() => validateConfig({ reply: { intervalMs: 0 } }), /intervalMs/);
  assert.throws(() => validateConfig({ reply: { intervalMs: 60_000 } }), /intervalMs/);
});

test('splitEnabled 非布尔值被拒', () => {
  assert.throws(() => validateConfig({ reply: { splitEnabled: 'true' } }), /splitEnabled/);
});

test('reply 里拼错的键仍然被拒（fail-fast 纪律）', () => {
  assert.throws(() => validateConfig({ reply: { maxMessage: 3 } }), /未知/);
});

/* ------------------------------------------------------------ 界面 */

/** 造一个最小 DOM，够 vue 无关的视图模块跑起来 */
function fakeDom() {
  const node = (tag) => {
    /** @type {any} */
    const attrs = {};
    /** @type {any} */
    const n = {
      tagName: String(tag).toUpperCase(),
      children: [],
      className: '',
      textContent: '',
      value: '',
      checked: false,
      hidden: false,
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      append(...kids) {
        this.children.push(...kids);
        return this;
      },
      appendChild(k) {
        this.children.push(k);
        return k;
      },
      replaceChildren(...kids) {
        this.children = kids;
      },
      /*
       * 真实 DOM 里 `input.type` 是**反射属性**：setAttribute('type','checkbox')
       * 之后 element.type 就是 'checkbox'。测试要按真实语义实现，
       * 否则"开关是不是勾上的"这类断言会因为假 DOM 的简化而误判。
       */
      setAttribute(k, v) {
        attrs[k] = String(v);
        if (k in this) this[k] = String(v);
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
      },
      removeAttribute(k) {
        delete attrs[k];
      },
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    return n;
  };
  return {
    document: {
      createElement: (tag) => node(tag),
      createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    },
    node,
  };
}

/** 递归收集所有节点的文本 */
function textsOf(node) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.textContent === 'string' && n.textContent) out.push(n.textContent);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out.join('\n');
}

async function withFakeDom(fn) {
  const prevDocument = globalThis.document;
  globalThis.document = fakeDom().document;
  try {
    return await fn();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
}

test('分条区块渲染出协议示例与三个可调项', async () => {
  const { renderReplySplit } = await import('../ui/src/views/reply-split.mjs');
  await withFakeDom(async () => {
    const view = renderReplySplit(
      { reply: { splitEnabled: true, maxMessages: 3, intervalMs: 800, hardCap: MAX_MESSAGES_HARD_CAP } },
      {},
    );
    const text = textsOf(view);
    assert.match(text, /允许分条发送/);
    assert.match(text, /一次回复最多分几条/);
    assert.match(text, /两条之间间隔/);
    assert.match(text, new RegExp(SPLIT_LANG), '要把协议标记写给用户看');
    // 硬上限必须说出来，否则用户以为填 30 会生效
    assert.match(text, new RegExp(`只按 ${MAX_MESSAGES_HARD_CAP} 条`));
  });
});

test('分条区块：关闭时开关展示为关（读配置，不是写死）', async () => {
  const { renderReplySplit } = await import('../ui/src/views/reply-split.mjs');
  await withFakeDom(async () => {
    const view = renderReplySplit({ reply: { splitEnabled: false, maxMessages: 3, intervalMs: 800 } }, {});
    /** @type {any[]} */
    const boxes = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      // 勾选框：tagName 是 INPUT 且带 checkbox class
      if (n.tagName === 'INPUT' && String(n.className).includes('checkbox')) boxes.push(n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(view);
    assert.equal(boxes.length, 1, '应只有一个开关');
    assert.equal(boxes[0].checked, false, '配置里关着，界面必须是关的');
  });
});

test('★ 分条区块挂在《语言》页里，且有独立入口（不是只创建文件）', async () => {
  /*
   * F23 把分条并进了《语言》页 —— 但这不等于"分条功能没了"。
   * 断言要落在**可发现性**上：侧栏里有《语言》，语言页里真的渲染分条区块。
   */
  const app = await fs.readFile(path.join(ROOT, 'ui/src/app.mjs'), 'utf8');
  assert.match(app, /import \{ renderLanguage \} from '\.\/views\/language\.mjs'/);
  assert.match(app, /id: 'language'/);
  assert.match(app, /renderLanguage\(s,/);
  // 分条不再作为独立侧栏入口（否则就是第二份入口）
  assert.ok(!/id: 'reply-split'/.test(app), '分条已并入《语言》页，不该再占侧栏入口');

  const lang = await fs.readFile(path.join(ROOT, 'ui/src/views/language.mjs'), 'utf8');
  assert.match(lang, /import \{ renderReplySplit \} from '\.\/reply-split\.mjs'/);
  assert.match(lang, /renderReplySplit\(snap, ctx\)/, '语言页必须真的渲染分条区块');
  assert.match(lang, /label: '分条'/);
});

/* ------------------------------------------------- 设置通道接得上 */

test('★ setting 通道里有 reply.* 分支（否则界面保存会落到"未支持"）', async () => {
  const src = await fs.readFile(path.join(ROOT, 'src/index.mjs'), 'utf8');
  assert.match(src, /key\.startsWith\('reply\.'\)/, '缺 reply.* 前缀分支');
  assert.match(src, /applyReplySetting\(config, field, value\)/);
  // 校验函数本身要拒绝越界值，而不是照单全收
  assert.match(src, /未支持的分条设置项/);
});

test('★ 快照里带 reply 块（界面才有东西可渲染）', async () => {
  const src = await fs.readFile(path.join(ROOT, 'src/index.mjs'), 'utf8');
  assert.match(src, /\n\s+reply: \{/, '快照里缺 reply 字段');
  assert.match(src, /hardCap: MAX_MESSAGES_HARD_CAP/, '要把硬上限透给界面');
});
