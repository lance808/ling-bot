/**
 * 《语言》页 —— 唤醒 / 分条 / 静音三块合成一个入口（F23）
 *
 * ## 这个文件守的是什么
 *
 * 合并页面最容易出的错误不是"渲染不出来"，而是**只渲染了一块**：
 *
 *   · 分栏按钮点了没反应（rerender 没接上）
 *   · 切走再切回来，内容还是第一栏的（状态被存在局部变量里）
 *   · 静音那块压根没被调起来 → 用户以为静音设置被删了
 *
 * 这些都不会抛异常，症状只是"我点了没反应"或"那一栏去哪了"。
 * 所以这里用最小 DOM 桩真的点一下按钮，断言内容真的换了。
 *
 * 注意：三个子区块（wake/silence/reply-split）各自还有独立测试
 * （wake.test.mjs / silence-page.test.mjs / reply-wiring.test.mjs），
 * 这里只测**组合行为**，不重复测它们内部的字段。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderLanguage, resetLanguagePageState, currentLanguageTab } from '../ui/src/views/language.mjs';

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
    this.checked = false;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  appendChild(n) {
    this.children.push(n);
    return n;
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
    if (key in this) this[key] = value;
  }
  getAttribute(key) {
    return this.attributes[key] ?? null;
  }
  removeAttribute(key) {
    delete this.attributes[key];
  }
  addEventListener(key, fn) {
    this.listeners[key] = fn;
  }
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

function installDom() {
  const prev = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (t) => ({ textContent: String(t), nodeType: 3 }),
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

/** 找到分栏按钮 */
function segButtons(node) {
  return walk(node).filter((n) => String(n.className ?? '').includes('seg-btn'));
}

/** 一份能同时喂饱三块的快照 */
function snapshot() {
  return {
    wake: { keywords: [], speakerIds: [], runtime: {} },
    silence: { all: false, convKeys: [], windows: [], temporary: [] },
    reply: { splitEnabled: true, maxMessages: 3, intervalMs: 800, hardCap: 10 },
  };
}

/* ------------------------------------------------------------ 分栏 */

test('★ 三栏都在，默认停在唤醒（最常调的是"该不该开口"）', () => {
  const restore = installDom();
  try {
    resetLanguagePageState();
    const node = renderLanguage(snapshot(), {});
    const labels = segButtons(node).map((b) => b.textContent);
    assert.deepEqual(labels, ['唤醒', '分条', '静音']);
    assert.equal(currentLanguageTab(), 'wake');
    // 默认栏的内容真的渲染出来了（不是空壳）
    assert.match(allText(node), /触发条件/);
  } finally {
    restore();
  }
});

test('★ 点「分条」真的换成分条内容（不是点了没反应）', () => {
  const restore = installDom();
  try {
    resetLanguagePageState();
    let rendered = 0;
    const ctx = { rerender: () => (rendered += 1) };
    const first = renderLanguage(snapshot(), ctx);
    const splitBtn = segButtons(first).find((b) => b.textContent === '分条');
    assert.ok(splitBtn, '找不到「分条」分栏按钮');

    splitBtn.listeners.click?.();
    assert.equal(rendered, 1, '切换必须触发重绘');
    assert.equal(currentLanguageTab(), 'split');

    const second = renderLanguage(snapshot(), ctx);
    const text = allText(second);
    assert.match(text, /允许分条发送/, '切过去必须是分条区块');
    assert.ok(!/触发条件/.test(text), '不该还留着唤醒的内容');
  } finally {
    restore();
  }
});

test('★ 点「静音」能到静音区块（合并后最怕它"消失"）', () => {
  const restore = installDom();
  try {
    resetLanguagePageState();
    const ctx = { rerender() {} };
    const first = renderLanguage(snapshot(), ctx);
    segButtons(first)
      .find((b) => b.textContent === '静音')
      .listeners.click?.();

    const second = renderLanguage(snapshot(), ctx);
    const text = allText(second);
    assert.match(text, /当前状态/, '静音区块的核心是"现在到底闭没闭嘴"');
    assert.equal(currentLanguageTab(), 'silence');
  } finally {
    restore();
  }
});

test('★ 状态存在模块里：重绘不会跳回第一栏', () => {
  /*
   * 快照每 2 秒轮询、每次整页重建。状态若存在局部变量里，
   * 两秒后就会跳回唤醒栏 —— 表现成"我刚切到静音，它自己跳回去了"。
   */
  const restore = installDom();
  try {
    resetLanguagePageState();
    const ctx = { rerender() {} };
    segButtons(renderLanguage(snapshot(), ctx))
      .find((b) => b.textContent === '分条')
      .listeners.click?.();

    // 模拟两次轮询重绘
    renderLanguage(snapshot(), ctx);
    const third = renderLanguage(snapshot(), ctx);
    assert.equal(currentLanguageTab(), 'split');
    assert.match(allText(third), /允许分条发送/);
  } finally {
    restore();
  }
});

test('重复点当前栏不再重绘（避免无谓的整页重建）', () => {
  const restore = installDom();
  try {
    resetLanguagePageState();
    let rendered = 0;
    const ctx = { rerender: () => (rendered += 1) };
    const first = renderLanguage(snapshot(), ctx);
    segButtons(first)[0].listeners.click?.();
    assert.equal(rendered, 0, '已经在这一栏，点它不该触发重绘');
  } finally {
    restore();
  }
});

test('空快照也能渲染（首帧 snapshot 还没到时不白屏）', () => {
  const restore = installDom();
  try {
    resetLanguagePageState();
    for (const snap of [{}, { wake: undefined, silence: undefined, reply: undefined }]) {
      assert.doesNotThrow(() => renderLanguage(snap, {}));
    }
  } finally {
    restore();
  }
});
