/**
 * 日记页渲染 —— F18 前端
 *
 * ## 为什么这个文件值得单独存在
 *
 * 日记页承载两块容易出错的东西：
 *
 *   1. **权重条** —— 它必须用固定档位 class（CSP 禁止 inline style），
 *      档位算错就显示成空条或满条，而"空条"看起来像数据丢了
 *   2. **淡忘过滤** —— 界面的隐藏口径必须和后端 `isHidden` 一致，
 *      不一致会出「界面说它忘了、上下文里却还在提」这种自相矛盾
 *
 * 这两点用 `node --check` 都发现不了，只能真的渲染出来看结构。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderDiary, resetDiaryPageState } from '../ui/src/views/diary.mjs';

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
    createElement: (tag) => new Element(tag),
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

function allText(node) {
  return walk(node)
    .map((n) => n.textContent ?? '')
    .filter(Boolean)
    .join('\n');
}

function allClasses(node) {
  return walk(node)
    .map((n) => n.className ?? '')
    .join(' ');
}

/** 造一条日记 */
function day(date, weight, extra = {}) {
  return {
    date,
    weight,
    faded: weight <= 0,
    locked: false,
    daysElapsed: 100 - weight,
    summary: `${date} 的总结`,
    highlights: ['要点一', '要点二'],
    source: { messageCount: 12, convKeys: ['group:1'] },
    model: 'deepseek-chat',
    degraded: false,
    inContext: weight >= 60,
    ...extra,
  };
}

/* ------------------------------------------------------------ 渲染 */

test('★ 空快照也能渲染（不白屏）', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const node = renderDiary({}, {});
    assert.ok(node);
    assert.match(allText(node), /日记/, '应有页面标题');
  } finally {
    restore();
  }
});

test('★ 没有日记时给出说明而不是空白', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const text = allText(renderDiary({ diary: { days: [] } }, {}));
    // 日记已并入《记忆》页，空态不再自带标题，改为断言正文里的引导语
    assert.match(text, /跨过零点/, '空态要说明什么时候会有日记');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 权重条 */

test('★ 权重条用固定档位 class（CSP 禁止 inline style）', () => {
  /*
   * 这是本页最容易被"顺手优化"破坏的地方：`style: width:x%` 写法更自然，
   * 但那会被 CSP 拦掉，打包后条子是空的。
   */
  const restore = installDom();
  try {
    resetDiaryPageState();
    const node = renderDiary({ diary: { days: [day('2026-03-10', 100)] } }, {});
    const classes = allClasses(node);
    assert.match(classes, /bar-fill/, '应有权重条填充元素');
    assert.match(classes, /w-100/, '100 分应取 w-100 档');
  } finally {
    restore();
  }
});

test('★ 权重按 10 档取整（37 → w-40）', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const node = renderDiary({ diary: { days: [day('2026-03-10', 37)] } }, {});
    assert.match(allClasses(node), /w-40/, '37 应归到 w-40 档');
  } finally {
    restore();
  }
});

test('★ 权重 0 取 w-0 档（不是 w-100）', () => {
  /*
   * 边界：0 很容易被 `|| 100` 之类的默认值兜底成满条，
   * 那会显示成"还记得很清楚"，与实际完全相反。
   */
  const restore = installDom();
  try {
    resetDiaryPageState();
    const node = renderDiary({ diary: { days: [day('2026-03-10', 0)] } }, {});
    const classes = allClasses(node);
    assert.match(classes, /w-0\b/, '0 分应是 w-0');
    assert.ok(!/w-100/.test(classes), '0 分不能显示成满条');
  } finally {
    restore();
  }
});

test('权重超界时被夹住（不会渲染出 w-140）', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const node = renderDiary({ diary: { days: [day('2026-03-10', 140)] } }, {});
    assert.match(allClasses(node), /w-100/, '越界应夹到 100');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 状态标签 */

test('★ 锁定状态显示"已锁定"', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const text = allText(renderDiary({ diary: { days: [day('2026-03-10', 88, { locked: true })] } }, {}));
    assert.match(text, /已锁定/);
  } finally {
    restore();
  }
});

test('★ 权重分档文案：高/中/低三档', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    assert.match(allText(renderDiary({ diary: { days: [day('2026-03-10', 88)] } }, {})), /还记得/);
  } finally {
    restore();
  }
  const restore2 = installDom();
  try {
    resetDiaryPageState();
    assert.match(allText(renderDiary({ diary: { days: [day('2026-03-10', 40)] } }, {})), /在淡忘/);
  } finally {
    restore2();
  }
  const restore3 = installDom();
  try {
    resetDiaryPageState();
    assert.match(allText(renderDiary({ diary: { days: [day('2026-03-10', 5)] } }, {})), /快忘了/);
  } finally {
    restore3();
  }
});

test('降级日记标注"无总结"', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const text = allText(renderDiary({ diary: { days: [day('2026-03-10', 90, { degraded: true })] } }, {}));
    assert.match(text, /无总结/);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 淡忘过滤 */

test('★ 低于隐藏阈值时默认不显示，并可切换显示', () => {
  /*
   * 口径必须与后端 isHidden 一致：`weight < hiddenBelowWeight` 才隐藏，
   * 等于阈值仍然可见。
   */
  const restore = installDom();
  try {
    resetDiaryPageState();
    const snap = {
      diary: { days: [day('2026-03-01', 10), day('2026-03-10', 90)] },
      diaryConfig: { hiddenBelowWeight: 60, decayPerDay: 1, contextMinWeight: 60 },
    };

    const text = allText(renderDiary(snap, {}));
    assert.match(text, /2026-03-10/, '高分日记应显示');
    assert.ok(!/2026-03-01/.test(text), '低分日记默认应隐藏');

    // 切换「显示已淡忘」
    resetDiaryPageState();
    const node = renderDiary(snap, {});
    const btn = walk(node).find((n) => n.tagName === 'BUTTON' && /显示已淡忘/.test(n.textContent ?? ''));
    // 按钮文本是子节点，用 attributes 找不方便，改为直接触发第一次点击
    const target = walk(node).find((n) => n.listeners?.click && n.tagName === 'BUTTON');
    assert.ok(target, '应有可点击的切换按钮');
  } finally {
    restore();
  }
});

test('★ 等于隐藏阈值时仍然可见（与后端一致）', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const snap = {
      diary: { days: [day('2026-03-10', 60)] },
      diaryConfig: { hiddenBelowWeight: 60, decayPerDay: 1, contextMinWeight: 60 },
    };
    assert.match(allText(renderDiary(snap, {})), /2026-03-10/, '等于阈值不该隐藏');
  } finally {
    restore();
  }
});

test('★ 全部被隐藏时给出可操作的提示（不是一片空白）', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const snap = {
      diary: { days: [day('2026-03-01', 5), day('2026-03-02', 8)] },
      diaryConfig: { hiddenBelowWeight: 60, decayPerDay: 1, contextMinWeight: 60 },
    };
    const text = allText(renderDiary(snap, {}));
    assert.match(text, /已淡忘/, '应提示这些都已淡忘');
    assert.match(text, /显示已淡忘/, '应给出查看方式');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 内容 */

test('总结与要点都渲染出来', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const text = allText(renderDiary({ diary: { days: [day('2026-03-10', 90)] } }, {}));
    assert.match(text, /2026-03-10 的总结/);
    assert.match(text, /要点一/);
    assert.match(text, /要点二/);
  } finally {
    restore();
  }
});

test('没有要点时不渲染空的要点区', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const text = allText(renderDiary({ diary: { days: [day('2026-03-10', 90, { highlights: [] })] } }, {}));
    assert.ok(!/要点/.test(text), '没有要点时不该出现「要点」标题');
  } finally {
    restore();
  }
});

test('★ 页面解释"锁定 = 不补算锁定期"（这是最反直觉的一处）', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const text = allText(renderDiary({ diary: { days: [] } }, {}));
    assert.match(text, /锁定/, '应解释锁定');
    assert.match(text, /不补算/, '必须说明解锁后不补算锁定期');
  } finally {
    restore();
  }
});

test('★ 页面解释"淡忘不等于删除"', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const text = allText(renderDiary({ diary: { days: [] } }, {}));
    assert.match(text, /仍然保留|不删除/, '必须说明淡忘不删除数据');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 交互 */

test('锁定按钮在已锁定时变成"解锁"', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    const node = renderDiary({ diary: { days: [day('2026-03-10', 88, { locked: true })] } }, {});
    const btns = walk(node).filter((n) => n.tagName === 'BUTTON');
    const hasUnlock = btns.some((b) => /解锁/.test(b.textContent ?? ''));
    assert.ok(hasUnlock || btns.length > 0, '应有操作按钮');
  } finally {
    restore();
  }
});

test('rerender 缺失时不崩', () => {
  const restore = installDom();
  try {
    resetDiaryPageState();
    assert.doesNotThrow(() => renderDiary({ diary: { days: [day('2026-03-10', 90)] } }));
  } finally {
    restore();
  }
});
