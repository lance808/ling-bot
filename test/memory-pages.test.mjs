/**
 * 《记忆》与《工具调用》两页 —— F21 前端
 *
 * ## 这次改动的核心是"拆"与"并"
 *
 *   《工具记忆》→《记忆》     并入日记，去掉工具列表
 *   新增《工具调用》          承接工具列表
 *   系统安全页                删掉重复的工具清单
 *
 * 拆并本身不会报错，出错的地方是**内容漏搬**或**搬重复**：
 *   · 日记的权重条没跟过来 → 用户以为淡忘功能没了
 *   · 工具列表在两页都留着 → 加工具时改一处漏一处
 *
 * 所以这个文件守的是"东西到底在哪、在几处"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMemory } from '../ui/src/views/memory.mjs';
import { renderToolCalls } from '../ui/src/views/tool-calls.mjs';
import { resetDiaryPageState } from '../ui/src/views/diary.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/* ------------------------------------------------------------ DOM 桩 */

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.dataset = {};
  }
  append(...n) {
    this.children.push(...n);
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
}

function installDom() {
  const prev = globalThis.document;
  globalThis.document = {
    createElement: (t) => new Element(t),
    createTextNode: (t) => ({ textContent: String(t) }),
  };
  return () => {
    globalThis.document = prev;
  };
}

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const c of node.children ?? []) walk(c, out);
  return out;
}

const allText = (n) =>
  walk(n)
    .map((x) => x.textContent ?? '')
    .filter(Boolean)
    .join('\n');

const allClasses = (n) =>
  walk(n)
    .map((x) => x.className ?? '')
    .join(' ');

/** 造一个工具 */
function tool(name, origins, extra = {}) {
  return { name, origins, risk: 'R0', confirm: 'never', description: `${name} 的说明`, ...extra };
}

/* ------------------------------------------------------------ 《记忆》页 */

test('★ 《记忆》页不再叫「工具记忆」，也没有 L3/L4/L5 字样', () => {
  /*
   * 用户明确要求去掉 L3/L4/L5。这些编号来自内部文档的分层，
   * 界面上出现只会让人问"L3 是什么"。
   */
  const restore = installDom();
  try {
    resetDiaryPageState();
    const text = allText(renderMemory({ brain: { conversations: [] } }, {}));
    assert.ok(!/L3|L4|L5/.test(text), `不该出现 L3/L4/L5：${text.slice(0, 200)}`);
    assert.ok(!/工具记忆/.test(text), '不该再出现「工具记忆」');
    assert.match(text, /情境知识/, '应有情境知识');
  } finally {
    restore();
  }
});

test('★ 《记忆》页含日记区块（并进来了）', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const snap = {
      brain: { conversations: [] },
      diary: { days: [{ date: '2026-03-10', weight: 90, locked: false, daysElapsed: 10, summary: '那天聊了很多', highlights: [], source: {}, inContext: true }] },
      diaryConfig: { decayPerDay: 1, hiddenBelowWeight: 0, contextMinWeight: 60 },
    };
    const text = allText(renderMemory(snap, {}));
    assert.match(text, /日记与淡忘/, '日记区块标题要在');
    assert.match(text, /2026-03-10/, '日记条目要在');
    assert.match(text, /那天聊了很多/, '日记正文要在');
  } finally {
    restore();
  }
});

test('★ 日记权重条也跟过来了（不能只搬标题）', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const snap = {
      brain: { conversations: [] },
      diary: { days: [{ date: '2026-03-10', weight: 80, locked: false, daysElapsed: 20, summary: 'x', highlights: [], source: {}, inContext: true }] },
      diaryConfig: { decayPerDay: 1, hiddenBelowWeight: 0, contextMinWeight: 60 },
    };
    const classes = allClasses(renderMemory(snap, {}));
    assert.match(classes, /bar-fill/, '权重条要在（漏搬的话这里会挂）');
    assert.match(classes, /w-80/, '权重档位要对');
  } finally {
    restore();
  }
});

test('★ 《记忆》页不含工具清单（已搬走）', () => {
  /*
   * 工具清单只能有一份。留在《记忆》里就会出现"两页各画一遍"，
   * 加工具时改一处漏一处 —— 而漏改不会报错。
   */
  const restore = installDom();
  try {
    resetDiaryPageState();
    const snap = {
      brain: { conversations: [] },
      registry: { tools: [tool('fs_read', ['owner-private'])] },
    };
    const text = allText(renderMemory(snap, {}));
    assert.ok(!/fs_read/.test(text), '工具名不该出现在《记忆》页');
    assert.match(text, /工具调用/, '应指路到《工具调用》页');
  } finally {
    restore();
  }
});

test('《记忆》页在空快照下不白屏', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    assert.doesNotThrow(() => renderMemory({}, {}));
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 《工具调用》页 */

test('★ 《工具调用》页列出工具、来源与确认要求', () => {
  const restore = installDom();
  try {
    const snap = {
      registry: {
        tools: [
          tool('fs_list', ['owner-private', 'console']),
          tool('fs_read', ['owner-private'], { risk: 'R0' }),
        ],
      },
    };
    const text = allText(renderToolCalls(snap, {}));
    assert.match(text, /fs_list/, '应列出 fs_list');
    assert.match(text, /fs_read/, '应列出 fs_read');
    assert.match(text, /主人私聊/, '来源要翻成人话');
    assert.match(text, /群聊不可用/, '只对私聊开放的要标出来');
  } finally {
    restore();
  }
});

test('★ 插件工具标注来源插件（据此去插件页定位）', () => {
  const restore = installDom();
  try {
    const snap = {
      registry: { tools: [tool('plugin_dsh_ask', ['owner-private'], { plugin: 'dsh-bridge', risk: 'R1', confirm: 'always' })] },
    };
    const text = allText(renderToolCalls(snap, {}));
    assert.match(text, /dsh-bridge/, '应标出来自哪个插件');
    assert.match(text, /每次都要确认/, 'confirm=always 要显示出来');
  } finally {
    restore();
  }
});

test('★ 没有工具时给出空态而不是空白表格', () => {
  const restore = installDom();
  try {
    const text = allText(renderToolCalls({ registry: { tools: [] } }, {}));
    assert.match(text, /没有注册任何工具/);
  } finally {
    restore();
  }
});

test('★ 来源统计能区分「群聊可用」与「仅宿主机」', () => {
  /*
   * 这是本页最实用的一栏：用户真正想知道的是"群里能用几个"。
   * 一个工具"存在"和"群里能用"是两件事，混淆会让人以为机器人
   * 在群里能读本地文件。
   */
  const restore = installDom();
  try {
    const snap = {
      registry: {
        tools: [
          tool('a_host', ['owner-private']), // 仅宿主机
          tool('b_group', ['group']), // 群聊可用
          tool('c_both', ['owner-private', 'group']),
        ],
      },
    };
    const text = allText(renderToolCalls(snap, {}));
    assert.match(text, /共 3 个工具/, '总数要对');
    assert.match(text, /群聊可用 2 个/, '群聊可用数要对（b_group + c_both）');
    assert.match(text, /仅宿主机 1 个/, '仅宿主机数要对（a_host）');
  } finally {
    restore();
  }
});

test('★ origins 为空的工具标为「谁都调不到」', () => {
  /*
   * 硬边界：没声明 origins 就是没人能用。显示成正常工具会误导用户。
   * 正常情况下 defineTool 会拒绝这种工具，但快照可能来自旧版本或插件。
   */
  const restore = installDom();
  try {
    const snap = { registry: { tools: [tool('orphan', [])] } };
    const text = allText(renderToolCalls(snap, {}));
    assert.match(text, /无来源可用|谁都调不到/, '空 origins 必须显式标红');
  } finally {
    restore();
  }
});

test('《工具调用》页在空快照下不白屏', () => {
  const restore = installDom();
  try {
    assert.doesNotThrow(() => renderToolCalls({}, {}));
    assert.doesNotThrow(() => renderToolCalls({ registry: {} }, {}));
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 不重复 */

test('★ 工具清单只在一处渲染（系统安全页不再列清单）', () => {
  /*
   * 系统安全页原来也有一份工具清单。两份的后果不是"多花点像素"，
   * 而是**加一个工具得记得改两处**，漏改的那次不会报错，
   * 只会让两个页面说的不一样，用户没法判断该信哪个。
   */
  const security = read('ui/src/views/security.mjs');

  // 不该再逐条渲染工具名
  assert.ok(!/hostTools\.map/.test(security), '系统安全页不该再逐条列宿主工具');
  assert.ok(!/qqTools\.map/.test(security), '系统安全页不该再逐条列 QQ 工具');
  // 但应指路
  assert.match(security, /工具调用/, '应指向《工具调用》页');
});

test('★ 旧 tools.mjs 已删除，没有第二份实现', () => {
  const views = readdirSync(path.join(ROOT, 'ui', 'src', 'views'));
  assert.ok(!views.includes('tools.mjs'), 'tools.mjs 应已拆分为 memory.mjs 与 tool-calls.mjs');
  assert.ok(views.includes('memory.mjs'), '缺 memory.mjs');
  assert.ok(views.includes('tool-calls.mjs'), '缺 tool-calls.mjs');
});

test('★ 侧栏里《记忆》与《工具调用》都是独立入口，且没有「日记」', () => {
  const app = read('ui/src/app.mjs');
  assert.match(app, /label: '记忆'/, '缺《记忆》入口');
  assert.match(app, /label: '工具调用'/, '缺《工具调用》入口');
  assert.ok(!/label: '工具记忆'/.test(app), '不该还有「工具记忆」');
  assert.ok(!/label: '日记'/.test(app), '日记已并入《记忆》，不该还有独立入口');
});

test('★ 界面里不再出现 L3/L4/L5 字样', () => {
  /*
   * 全量扫一遍视图目录，防止别处还有残留。
   * 这些编号是内部文档的分层术语，不该泄漏到界面上。
   *
   * 注意：安全页原来也有 L1~L4 一套编号（准入/授权/约束/审计）。
   * 两套编号撞在一起，用户会以为两个页面里的「L3」是同一个东西。
   * 所以安全页的也改成了语义名称 —— 这条现在是**无例外**的。
   */
  const viewsDir = path.join(ROOT, 'ui', 'src', 'views');
  const offenders = [];
  for (const f of readdirSync(viewsDir).filter((x) => x.endsWith('.mjs'))) {
    const text = readFileSync(path.join(viewsDir, f), 'utf8');
    // 只查会显示给用户的字符串字面量；注释里提到是允许的
    for (const m of text.matchAll(/'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g)) {
      if (/\bL[345]\b/.test(m[0])) offenders.push(`${f}: ${m[0].slice(0, 40)}`);
    }
  }
  assert.deepEqual(offenders, [], `这些界面字符串里还有 L3/L4/L5：\n${offenders.join('\n')}`);
});
