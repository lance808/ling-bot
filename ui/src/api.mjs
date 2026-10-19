/**
 * 前端唯一出口 —— F13 边界第 4 条
 *
 * 严格只用 preload 暴露的 window.ling。
 * 加新页面/新能力时，**这个文件不需要改**（I11）：
 * 一切动作都走 { name, params }，由后端按注册表分发。
 */

const ling = /** @type {any} */ (globalThis).ling;

export function hasBridge() {
  return Boolean(ling?.invoke);
}

/** @returns {Promise<any>} */
export function snapshot() {
  return ling.invoke('snapshot', {});
}

/**
 * 触发一个动作。
 *
 * @param {string} name
 * @param {object} [params]
 */
export function action(name, params = {}) {
  return ling.invoke('action', { name, params });
}

/**
 * 改一项设置。
 *
 * @param {string} key
 * @param {any} value
 */
export function setting(key, value) {
  return ling.invoke('setting', { key, value });
}

/**
 * 订阅后端推送。
 *
 * @param {(msg: {event: string, payload: any}) => void} fn
 */
export function onEvent(fn) {
  if (!ling?.onEvent) return () => {};
  return ling.onEvent(fn);
}

export function meta() {
  return ling?.meta ?? { platform: 'unknown', versions: {} };
}

/**
 * 弹系统文件选择器，只拿路径。
 *
 * 选文件是**界面操作**，不是 QQ 能力，所以它不走 action。
 * 拿到路径后仍要调 `action('send-media')` 才真的发送——
 * 能不能发由后端闸门判定，这个函数不参与授权。
 *
 * @param {'image'|'video'|'record'|'file'} kind
 * @returns {Promise<{ok: boolean, path?: string, canceled?: boolean}>}
 */
export function pickFile(kind) {
  if (!ling?.pickFile) return Promise.resolve({ ok: false, canceled: true });
  return ling.pickFile({ kind });
}
