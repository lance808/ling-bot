/**
 * 自实现 OneBot 11 客户端 —— F2
 *
 * 为什么不用 `@snowluma/sdk`（DECISIONS D6）：
 *   1. 不被 SDK 主版本与 Node 下限拖拽（2.0.0 一天内把 engines 从 22 抬到 24）
 *   2. 一套代码同时对接 SnowLuma / NapCatQQ / LuckyLilliaBot
 *   3. 无 postinstall 修补需求
 *
 * 边界纪律（不变量 I2）：**本文件不允许出现 `snowluma` 字样。**
 * 它只认 `wsUrl` + `accessToken`。端点发现逻辑在 providers/ 里，换实现整块替换。
 */

import { createTransport } from './transport.mjs';

/**
 * @typedef {object} OneBotClientOptions
 * @property {string} wsUrl
 * @property {string} [accessToken]
 * @property {object} [transport]
 * @property {number} [requestTimeoutMs]
 * @property {number} [reconnectBaseMs]
 * @property {number} [reconnectMaxMs]
 * @property {(evt: object) => void} [onEvent]
 * @property {(state: string, detail?: object) => void} [onState]
 */

/** 连接状态机四态：idle → connecting → linked → backoff */
export const CLIENT_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  LINKED: 'linked',
  BACKOFF: 'backoff',
});

export class OneBotClient {
  /** @type {OneBotClientOptions} */
  #opts;
  /** @type {object | null} */
  #conn = null;
  /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
  #pending = new Map();
  /** @type {ReturnType<typeof setTimeout> | null} */
  #reconnectTimer = null;
  #attempt = 0;
  #echo = 0;
  #state = CLIENT_STATE.IDLE;
  /** 主动关闭中：用于区分"用户关掉"与"意外掉线" */
  #closing = false;

  constructor(opts) {
    if (!opts?.wsUrl) throw new TypeError('wsUrl 必填');
    this.#opts = {
      requestTimeoutMs: 10_000,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 30_000,
      ...opts,
    };
  }

  get state() {
    return this.#state;
  }

  /**
   * 带 token 的完整 URL。
   * 走查询参数而不是 header，是为了兼容 Node 内置 WebSocket（验证点 V1）。
   */
  buildUrl() {
    const url = new URL(this.#opts.wsUrl);
    if (this.#opts.accessToken) url.searchParams.set('access_token', this.#opts.accessToken);
    return url.toString();
  }

  #setState(state, detail) {
    this.#state = state;
    this.#opts.onState?.(state, detail);
  }

  /** 建立连接（会一直维持，断了自动重连） */
  connect() {
    if (this.#state === CLIENT_STATE.LINKED || this.#state === CLIENT_STATE.CONNECTING) return;
    this.#closing = false;
    this.#setState(CLIENT_STATE.CONNECTING);

    const transport = this.#opts.transport ?? createTransport();
    let conn;
    try {
      conn = transport.open(this.buildUrl());
    } catch (err) {
      this.#scheduleReconnect(err);
      return;
    }
    this.#conn = conn;

    conn.onOpen(() => {
      this.#attempt = 0;
      this.#setState(CLIENT_STATE.LINKED);
    });

    conn.onMessage((raw) => this.#handleRaw(raw));

    conn.onClose((detail) => {
      this.#conn = null;
      this.#failAllPending(new Error('连接已断开'));
      // 主动 close() 之后不该再自动重连 —— 否则"关掉了还在后台连"
      if (this.#closing) return;
      this.#scheduleReconnect(detail);
    });
  }

  /**
   * 重连退避：1s → 2s → 4s … 封顶 30s，带 ±20% 抖动。
   * 注意：**收到心跳不重置退避**——心跳来了但发不出动作，不算健康（F4）。
   */
  #scheduleReconnect(detail) {
    if (this.#reconnectTimer) return;
    const base = Math.min(this.#opts.reconnectMaxMs, this.#opts.reconnectBaseMs * 2 ** this.#attempt);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(500, Math.round(base + jitter));
    this.#attempt += 1;
    this.#setState(CLIENT_STATE.BACKOFF, { delayMs: delay, detail });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  /** @param {string} raw */
  #handleRaw(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    // 动作响应：有 echo
    if (payload && typeof payload === 'object' && payload.echo !== undefined) {
      const waiter = this.#pending.get(String(payload.echo));
      if (waiter) {
        this.#pending.delete(String(payload.echo));
        clearTimeout(waiter.timer);
        if (payload.status === 'failed' || payload.retcode !== 0) {
          const err = new Error(payload.message || payload.wording || '动作失败');
          /** @type {any} */ (err).code = 'E1030';
          /** @type {any} */ (err).retcode = payload.retcode;
          waiter.reject(err);
        } else {
          waiter.resolve(payload.data);
        }
      }
      return;
    }

    // 事件：交给上层
    if (payload?.post_type) this.#opts.onEvent?.(payload);
  }

  /** @param {Error} err */
  #failAllPending(err) {
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.#pending.clear();
  }

  /**
   * 发一个动作，按 echo 关联响应；超时即 reject 并从等待表清理（防泄漏）。
   *
   * @param {string} action
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  sendAction(action, params = {}) {
    if (!this.#conn || this.#state !== CLIENT_STATE.LINKED) {
      const err = new Error('尚未联通的 OneBot 端点');
      /** @type {any} */ (err).code = 'E1001';
      return Promise.reject(err);
    }

    const echo = String(++this.#echo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        const err = new Error(`OneBot 未在 ${this.#opts.requestTimeoutMs}ms 内响应 ${action}`);
        /** @type {any} */ (err).code = 'E1030';
        reject(err);
      }, this.#opts.requestTimeoutMs);
      timer.unref?.();

      this.#pending.set(echo, { resolve, reject, timer });
      try {
        this.#conn?.send({ action, params, echo });
      } catch (err) {
        this.#pending.delete(echo);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 只读探活：HTTP 与 WS token 可能是两个值，用它的连通性验证候选端点 */
  async getLoginInfo() {
    return this.sendAction('get_login_info');
  }

  /**
   * 兜底在线态。**不要用 get_login_info 取 good**（它只返回 user_id/nickname）。
   */
  async getStatus() {
    return this.sendAction('get_status');
  }

  close() {
    // 先立旗标，再关连接：onClose 回调会同步检查它，
    // 否则关闭动作本身会被当成"意外掉线"而排一次重连。
    this.#closing = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#conn?.close();
    this.#conn = null;
    this.#failAllPending(new Error('客户端已关闭'));
    this.#setState(CLIENT_STATE.IDLE);
  }
}
