/**
 * 前端唯一出口 —— F13 边界第 4 条
 *
 * 严格只用 preload 暴露的 window.ling。
 * 加新页面/新能力时，**这个文件不需要改**（I11）：
 * 一切动作都走 { name, params }，由后端按注册表分发。
 */

import { resultOf } from './contracts.mjs';

const ling = /** @type {any} */ (globalThis).ling;

export function hasBridge() {
  return Boolean(ling?.invoke);
}

/** @returns {Promise<any>} */
export function snapshot(params = {}) {
  return ling.invoke('snapshot', params);
}

export function restartBackend() {
  return resultOf(() => ling.restartBackend());
}

/**
 * 触发一个动作。
 *
 * @param {string} name
 * @param {object} [params]
 */
export function action(name, params = {}) {
  return resultOf(() => ling.invoke('action', { name, params }));
}

/**
 * 改一项设置。
 *
 * @param {string} key
 * @param {any} value
 */
export function setting(key, value) {
  return resultOf(() => ling.invoke('setting', { key, value }));
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
  return resultOf(() => ling.pickFile({ kind }));
}

/**
 * 打开外部网址（含本地 SnowLuma 控制台）。
 *
 * 这是**界面操作**，不走 action：和白名单判定一样，它是壳的职责。
 * 真正的白名单在 Rust 侧，前端传什么都绕不过去。
 *
 * @param {string} url
 */
export function openUrl(url) {
  if (!ling?.openUrl) return Promise.resolve({ ok: false, message: '当前环境不支持打开网址' });
  return resultOf(() => ling.openUrl(url));
}

/**
 * 启动本机的 SnowLuma。
 *
 * 只传目录：真正校验"这目录里有 index.mjs"的是壳，
 * 前端无法用它启动任意程序。
 *
 * @param {string} dir
 */
export function spawnSnowLuma(dir) {
  if (!ling?.spawnSnowLuma) return Promise.resolve({ ok: false, message: '当前环境不支持启动 SnowLuma' });
  return resultOf(() => ling.spawnSnowLuma(dir));
}

/**
 * 启动本机 QQ。
 *
 * @param {string} exe
 */
export function spawnQQ(exe) {
  if (!ling?.spawnQQ) return Promise.resolve({ ok: false, message: '当前环境不支持启动 QQ' });
  return resultOf(() => ling.spawnQQ(exe));
}
