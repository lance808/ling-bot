/**
 * 静音页渲染 —— F20 前端
 *
 * ## 为什么这个文件值得单独存在
 *
 * 静音页有四种静音方式、八个开关、三个列表和两个输入行，
 * 是本次新增里 DOM 结构最复杂的一页。它出错的方式全都是**运行时**的：
 *
 *   · 快照里少一个字段 → `.length` 读 undefined → 整页白屏
 *   · 空数组没兜底 → `map` 到 null 后又被 append → 崩
 *   · 临时静音列表为空时错误地渲染了表头 → 用户以为有东西没加载
 *
 * 这些用 `node --check` 一个都发现不了，而白屏是最难解释的故障 ——
 * 用户只会说"点进去是空的"。
 *
 * 所以这里用一份最小 DOM 桩真的把页面渲染出来，并对**结构**做断言。
 * 桩只实现 render.mjs 真正用到的那几个方法，多实现反而会掩盖问题。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderSilence, resetSilencePageState } from '../ui/src/views/silence.mjs';

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
    this.disabled = false;
    this.checked = false;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  addEventListener(key, fn) {
    this.listeners[key] = fn;
  }
}

/** 装 DOM 桩，返回还原函数 */
function installDom() {
  const prev = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (t) => ({ textContent: String(t) }),
  };
  return () => {
    globalThis.document = prev;
  };
}

/** 深度遍历，收集所有节点 */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const c of node.children ?? []) walk(c, out);
  return out;
}

/** 收集页面上的全部可见文本 */
function allText(node) {
  return walk(node)
    .map((n) => n.textContent ?? '')
    .filter(Boolean)
    .join('\n');
}

/** 收集所有 className */
function allClasses(node) {
  return walk(node)
    .map((n) => n.className ?? '')
    .join(' ');
}

/* ------------------------------------------------------------ 渲染 */

test('★ 空快照也能渲染出页面（不白屏）', () => {
  /*
   * 首帧时 snapshot 可能还没到，silence 字段完全不存在。
   * 这时必须渲染出一个"什么都没有但结构完整"的页面，
   * 而不是抛异常导致整页白屏。
   */
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence({}, {});
    assert.ok(node, '必须返回节点');
    const text = allText(node);
    assert.match(text, /当前状态/, '缺状态卡片');
    assert.match(text, /全局静音/, '缺全局开关卡片');
  } finally {
    restore();
  }
});

test('★ silence 字段缺失时按"没静音"渲染', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence({ silence: undefined }, {});
    const text = allText(node);
    assert.match(text, /正常说话中/, '没有静音时应显示正常状态');
  } finally {
    restore();
  }
});

test('★ 全局静音时状态行显示为已静音', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence(
      { silence: { all: true, convKeys: [], windows: [], temporary: [], summary: '全局静音：所有会话都不回复' } },
      {},
    );
    const text = allText(node);
    assert.match(text, /全局静音/, '应显示全局静音状态');
    // 不该同时说"正常说话中"
    assert.ok(!/正常说话中/.test(text), '全局静音时不该显示正常状态');
  } finally {
    restore();
  }
});

test('★ 时段命中时状态行说明是时段导致的', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence(
      {
        silence: {
          all: false,
          convKeys: [],
          windows: [{ start: '23:00', end: '08:00' }],
          windowHit: true,
          windowNow: '23:00–08:00',
          temporary: [],
          summary: '静默时段 23:00–08:00：所有会话都不回复',
        },
      },
      {},
    );
    const text = allText(node);
    assert.match(text, /23:00/, '应显示时段');
    assert.match(text, /静默时段/, '应说明是时段导致的');
  } finally {
    restore();
  }
});

test('★ 有临时静音时列出会话并给出剩余时间', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const now = Date.now();
    const node = renderSilence(
      {
        silence: {
          all: false,
          convKeys: [],
          windows: [],
          temporary: [{ convKey: 'group:123', until: now + 120_000, leftMs: 120_000 }],
        },
      },
      {},
    );
    const text = allText(node);
    assert.match(text, /group:123/, '应列出被临时静音的会话');
    assert.match(text, /还剩约/, '应给出剩余时间');
    assert.match(text, /全部恢复/, '应提供一键恢复');
  } finally {
    restore();
  }
});

test('临时静音为空时不渲染那块列表', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence(
      { silence: { all: false, convKeys: [], windows: [], temporary: [] } },
      {},
    );
    const text = allText(node);
    assert.ok(!/全部恢复/.test(text), '没有临时静音时不该出现「全部恢复」');
  } finally {
    restore();
  }
});

test('★ 按会话静音列表能列出，并给出移出按钮', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence(
      { silence: { all: false, convKeys: ['group:1', 'private:2'], windows: [], temporary: [] } },
      {},
    );
    const text = allText(node);
    assert.match(text, /group:1/);
    assert.match(text, /private:2/);
    assert.match(text, /移出/);
  } finally {
    restore();
  }
});

test('★ 静默时段列表能列出，跨午夜时段正常显示', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence(
      {
        silence: {
          all: false,
          convKeys: [],
          windows: [{ start: '23:00', end: '08:00' }, { start: '12:00', end: '13:00' }],
          temporary: [],
        },
      },
      {},
    );
    const text = allText(node);
    assert.match(text, /23:00/, '跨午夜时段要显示');
    assert.match(text, /08:00/);
    assert.match(text, /12:00/);
  } finally {
    restore();
  }
});

test('★ 指令关闭时状态行说明指令已关闭', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence(
      { silence: { all: false, convKeys: [], windows: [], temporary: [], allowCommand: false } },
      {},
    );
    const text = allText(node);
    assert.match(text, /聊天指令已关闭/, '应显示指令已关闭');
  } finally {
    restore();
  }
});

test('★ 管理员名单为空时提示"谁都不能用"', () => {
  /*
   * 这是最容易误解的一处：开关开着但名单空，实际没人能用指令。
   * 页面必须说清楚，否则用户以为已经授权好了。
   */
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence(
      { silence: { all: false, convKeys: [], windows: [], temporary: [], allowCommand: true, adminIds: [] } },
      {},
    );
    const text = allText(node);
    assert.match(text, /谁都不能用指令/, '空名单必须明确说明没人能用');
  } finally {
    restore();
  }
});

test('管理员名单有内容时列出 QQ 号', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence(
      {
        silence: {
          all: false, convKeys: [], windows: [], temporary: [],
          allowCommand: true, adminIds: ['10001', '10002'],
        },
      },
      {},
    );
    const text = allText(node);
    assert.match(text, /10001/);
    assert.match(text, /10002/);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 关键文案 */

test('★ 页面明确说明"静音期间 @ 也不回"', () => {
  /*
   * 这是用户最容易踩到困惑的地方：他 @ 了机器人，机器人没反应，
   * 他不知道是因为静音。所以文案必须写在页面上，而不是只写在文档里。
   */
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence({ silence: { all: false, convKeys: [], windows: [], temporary: [] } }, {});
    const text = allText(node);
    assert.match(text, /@/, '应提到 @');
    assert.match(text, /不回复/, '应说明 @ 也不回复');
    assert.match(text, /说话/, '应告诉用户怎么恢复');
  } finally {
    restore();
  }
});

test('★ 页面提供「闭嘴」指令的用法示例', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence({ silence: { all: false, convKeys: [], windows: [], temporary: [] } }, {});
    const text = allText(node);
    assert.match(text, /闭嘴/, '应给出指令示例');
    assert.match(text, /2h/, '应给出带时长的示例');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 交互不崩 */

test('★ 点击开关不会抛错（回调里不能同步崩）', () => {
  /*
   * 开关的 change 回调会调 setting()，那是异步的。
   * 这里只验证**同步部分**不崩 —— 桩里没有真后端，
   * 只要回调能构造出来并触发一次就说明结构没问题。
   */
  const restore = installDom();
  try {
    resetSilencePageState();
    const node = renderSilence({ silence: { all: false, convKeys: [], windows: [], temporary: [] } }, {});

    const boxes = walk(node).filter((n) => n.attributes?.type === 'checkbox' || n.tagName === 'INPUT');
    assert.ok(boxes.length > 0, '应该有可交互的输入控件');

    // 触发所有带 change 监听的复选框
    let fired = 0;
    for (const b of boxes) {
      const fn = b.listeners?.change;
      if (typeof fn !== 'function') continue;
      b.checked = !b.checked;
      assert.doesNotThrow(() => fn({ target: b }), '开关回调不该同步抛错');
      fired++;
    }
    assert.ok(fired > 0, '至少应该有一个开关绑定了 change');
  } finally {
    restore();
  }
});

test('rerender 缺失时也不崩（首帧没有 ctx）', () => {
  const restore = installDom();
  try {
    resetSilencePageState();
    assert.doesNotThrow(() => renderSilence({ silence: { all: false, convKeys: [], windows: [], temporary: [] } }));
  } finally {
    restore();
  }
});
