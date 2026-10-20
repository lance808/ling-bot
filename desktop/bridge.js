/**
 * Tauri 桥接层 —— 保持 window.ling 契约不变
 *
 * 页面脚本（ui/src/**）一直只认识 window.ling：
 *   invoke(method, payload) / onEvent(fn) / restartBackend() / pickFile(opts) / meta
 *
 * 换桌面壳时最容易犯的错是"顺手把前端也改一遍"：那会让已测过的契约
 * 一起松动。所以这里在**页面脚本运行之前**把同一个形状铺好，
 * ui/src 一行都不用改。
 *
 * 为什么不用 @tauri-apps/api：那会给项目加一个运行时依赖，
 * 而本项目一直是零运行时依赖。Tauri 的 IPC 通道本身是稳定的，
 * 这里直接用它的内部通道（与官方 API 走的是同一条路）。
 */

const internals = window.__TAURI_INTERNALS__;
const rawInvoke = internals?.invoke;
const { invoke } = internals ?? {};

/** 旧版 preload 只放行这三个方法 */
const ALLOWED_METHODS = new Set(['snapshot', 'action', 'setting']);

/* ------------------------------------------------------------ 事件 */

const listeners = new Set();
let listenStarted = false;

/**
 * 订阅后端推送。
 *
 * Tauri 的事件是"先注册回调 id，再由原生侧按 id 发回来"，
 * 所以这里用 transformCallback 拿一个稳定 id，然后调 event 插件的 listen。
 */
function startEventListener() {
  if (listenStarted) return;
  listenStarted = true;
  try {
    const callbackId = internals.transformCallback((payload) => {
      const msg = payload;
      // 后端业务事件包在 backend-event 里，生命周期事件直接透传
      const normalized =
        msg?.event === 'backend-event' ? msg.payload : msg;
      for (const fn of listeners) {
        try {
          fn(normalized);
        } catch {
          // 单个订阅者出错不能影响其它订阅者
        }
      }
    });
    rawInvoke('plugin:event|listen', {
      event: 'ling:event',
      target: { kind: 'Any' },
      handler: callbackId,
    }).catch(() => {
      listenStarted = false;
    });
  } catch {
    listenStarted = false;
  }
}

window.ling = {
  /**
   * @param {string} method
   * @param {any} payload
   */
  invoke(method, payload) {
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(new Error(`未允许的 IPC method：${method}`));
    }
    return invoke('ling_invoke', { method, payload: payload ?? {} });
  },

  /** @param {(msg: {event: string, payload: any}) => void} fn */
  onEvent(fn) {
    startEventListener();
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  restartBackend() {
    return invoke('ling_restart_backend');
  },

  pickFile(opts) {
    return invoke('ling_pick_file', { opts: opts ?? {} });
  },

  meta: {
    platform: 'win32',
    versions: {},
  },
};

// 环境信息是异步的：取到就补上，取不到保持占位（页面只用于显示）
invoke('ling_meta')
  .then((m) => {
    if (m) window.ling.meta = m;
  })
  .catch(() => {});
