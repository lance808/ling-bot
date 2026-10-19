/**
 * 极简 DOM 构建工具 —— 原生 JS
 *
 * 硬纪律（FUNCTIONS §8.5）：**禁止 `innerHTML = 外部数据`**。
 * QQ 文本、文件名、配置值都可能带标签，一律走 textContent。
 */

/**
 * 创建元素。
 *
 * @param {string} tag
 * @param {object | string} [props] 属性；字符串视为 className
 * @param {Array<Node | string | null | undefined>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  if (typeof props === 'string') props = { class: props };

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') throw new Error('render.mjs 不允许直接注入 html：请用 el/text');
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value);
    } else if (key === 'value' && 'value' in node) {
      /** @type {any} */ (node).value = value;
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

/** @param {string} text */
export function text(value) {
  return document.createTextNode(String(value ?? ''));
}

/** 清空一个容器 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * 键值行。
 *
 * @param {string} k
 * @param {Node | string} v
 */
export function kv(k, v) {
  return el('div', { class: 'kv' }, [el('span', { class: 'k', text: k }), el('span', { class: 'v' }, [v])]);
}

/**
 * 状态药丸。
 *
 * @param {string} label
 * @param {'ok'|'warn'|'err'|'dim'} tone
 */
export function pill(label, tone) {
  return el('span', { class: `pill pill-${tone}`, text: label });
}

/**
 * 卡片。
 *
 * @param {string} title
 * @param {Array<Node | null>} children
 */
export function card(title, children) {
  return el('section', { class: 'card' }, [el('h2', { text: title }), ...children]);
}

/**
 * 时间戳 → HH:MM:SS
 *
 * @param {number | null | undefined} tsSec 秒或毫秒
 */
export function clock(tsSec) {
  if (!tsSec) return '—';
  const ms = tsSec > 1e12 ? tsSec : tsSec * 1000;
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}
