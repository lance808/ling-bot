/**
 * 极简 store —— 原生 JS，无框架
 *
 * 只做三件事：持有 state、通知订阅者、提供一个 dispatch 修改入口。
 * 不引入任何响应式框架，因为这些页面没有复杂派生状态（FUNCTIONS §8.5）。
 */

const state = {
  page: 'overview',
  snapshot: null,
  selectedConv: null,
  logLines: [],
  toast: null,
  backend: { state: 'unknown', message: null },
};

/** @type {Set<() => void>} */
const subscribers = new Set();

export function getState() {
  return state;
}

/** @param {() => void} fn */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit() {
  for (const fn of subscribers) {
    try {
      fn();
    } catch (err) {
      console.error('订阅者异常', err);
    }
  }
}

/**
 * @param {Partial<typeof state>} patch
 */
export function set(patch) {
  Object.assign(state, patch);
  emit();
}

/** @param {string} text */
export function toast(text) {
  state.toast = { text, at: Date.now() };
  emit();
}
