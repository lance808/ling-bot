/**
 * 可替换传输层 —— F13 边界第 3 条 / 验证点 V1（FUNCTIONS §8.3）
 *
 * 为什么单独抽一层：Node 内置 `WebSocket` 不能自定义请求头，
 * 而 OneBot 的鉴权可能是 header 也可能是 `?access_token=`。
 * 把这件事关在一个文件里，将来换 `ws` 或换实现都不影响上层。
 *
 * 对外只暴露统一形状：
 *   open(url) -> { send(obj), onMessage(fn), onClose(fn), onOpen(fn), close() }
 */

/**
 * 基于全局 WebSocket 的实现（Node ≥ 22 稳定，浏览器同款 API）。
 *
 * @param {string} url
 * @returns {object} 连接句柄
 */
export function openNativeWebSocket(url) {
  if (typeof globalThis.WebSocket !== 'function') {
    const err = new Error('当前运行时不提供 WebSocket');
    err.code = 'E1001';
    throw err;
  }

  const ws = new globalThis.WebSocket(url);
  /** @type {(data: string) => void} */
  let messageHandler = () => {};

  return {
    kind: 'native',
    get readyState() {
      return ws.readyState;
    },
    onOpen(fn) {
      ws.addEventListener('open', () => fn());
    },
    onMessage(fn) {
      messageHandler = fn;
      ws.addEventListener('message', (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        messageHandler(data);
      });
    },
    onClose(fn) {
      ws.addEventListener('close', (ev) => fn({ code: ev.code, reason: ev.reason }));
      ws.addEventListener('error', () => fn({ code: 0, reason: 'error' }));
    },
    send(obj) {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
    },
  };
}

/**
 * 传输层工厂。
 *
 * V1 结论待实测后回填：若 SnowLuma 只接受 `Authorization` 头，
 * 这里改为返回基于 `ws` 的实现即可，**上层一行都不用动**。
 *
 * @param {{kind?: 'native'}} [opts]
 */
export function createTransport(opts = {}) {
  const kind = opts.kind ?? 'native';
  if (kind !== 'native') {
    const err = new Error(`未实现的传输类型：${kind}`);
    err.code = 'E1001';
    throw err;
  }
  return {
    kind,
    /** @param {string} url */
    open: (url) => openNativeWebSocket(url),
  };
}
