/**
 * 插件运行时：同进程（in-process）
 *
 * ## 什么时候用它
 *
 * 只有 `trusted: true` 的第一方插件才允许。原因很直接：
 * 同进程插件没有隔离 —— 它写个 `while(true)` 就能把整个后端卡死，
 * 主程序连"关掉这个插件"的界面都刷不出来。
 *
 * 那为什么还要这个运行时？因为有些插件必须与宿主**共享生命周期**：
 * 比如 `dsh-bridge` 要起一个 HTTP 端口、要接管 QQ 消息（`handleMessage`），
 * 这些能力目前只存在于进程内。子进程插件收不到消息、也拿不到宿主的发送闸门。
 *
 * ## 那这里防什么
 *
 * 防不了崩溃，但能防"插件在授权上作弊"以及"插件异常让宿主报错栈崩掉"：
 *
 *   - `origins` / `confirm` 由宿主推导（见 manifest.mjs 的 deriveToolPolicy）
 *   - 每次调用都套 try/catch + 超时，异常变成工具结果而不是宿主异常
 *   - 返回值必须可序列化、体积受限，防止把内存塞爆
 *   - `dispose` 有独立超时，插件不放手也不能卡住停用流程
 *
 * ## 超时只能"放弃等待"，不能"杀死"
 *
 * 这一点必须写清楚，否则会给人虚假的安全感：同进程里
 * 我们无法抢占一个正在执行的 JS 函数。超时后宿主只是不再等它，
 * 那个函数仍在跑（直到它自己让出事件循环）。
 * 真正需要强杀的插件必须走 `process` 运行时。
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

/** 单个工具返回值上限：超过按失败处理，避免把宿主内存塞爆 */
const MAX_RESULT_BYTES = 256 * 1024;

/** dispose 最多等多久 */
const DISPOSE_TIMEOUT_MS = 3000;

/** init 默认超时 */
const INIT_TIMEOUT_MS = 8000;

/** 测试连接默认超时 */
const TEST_TIMEOUT_MS = 15000;

/**
 * 给一个 Promise 加超时。
 *
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
export function withTimeout(p, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${what}超时（${ms}ms）`), { code: 'E4065' }));
    }, ms);
    // 不要因为这个定时器把进程钉住
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 检查一个值能不能安全地跨边界传出去。
 *
 * @param {unknown} value
 * @returns {{ok: true, json: string} | {ok: false, message: string}}
 */
export function checkSerializable(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    return { ok: false, message: `返回值无法序列化：${String(/** @type {any} */ (err)?.message ?? err)}` };
  }
  if (json === undefined) return { ok: true, json: 'null' };
  if (Buffer.byteLength(json, 'utf8') > MAX_RESULT_BYTES) {
    return { ok: false, message: `返回值超过 ${Math.floor(MAX_RESULT_BYTES / 1024)}KB 上限` };
  }
  return { ok: true, json };
}

/**
 * 同进程运行时。
 */
export class InProcessRuntime {
  /**
   * @param {object} opts
   * @param {object} opts.manifest
   * @param {string} opts.dir 插件目录
   * @param {string} opts.dataDir 运行数据目录
   * @param {Record<string, any>} opts.config
   * @param {Record<string, string>} opts.secrets
   * @param {(level: string, message: string, fields?: object) => void} opts.log
   * @param {(convKey: string, text: string) => Promise<any>} [opts.sendText]
   */
  constructor(opts) {
    this.manifest = opts.manifest;
    this.dir = opts.dir;
    this.dataDir = opts.dataDir;
    this.config = opts.config;
    this.secrets = opts.secrets;
    this.log = opts.log;
    this.sendText = opts.sendText ?? (async () => ({ ok: false, message: '宿主未提供发送能力' }));

    /** @type {any} */
    this.mod = null;
    /** @type {any} */
    this.instance = null;
    /** 插件整体停用时中断（用于长任务的协作式取消） */
    this.controller = new AbortController();
    this.disposed = false;
  }

  /** 运行时类型标识（界面与日志用） */
  get kind() {
    return 'in-process';
  }

  /**
   * 加载入口并调用 init。
   *
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
   */
  async init() {
    const entryPath = path.join(this.dir, this.manifest.entry);

    try {
      const st = await fs.stat(entryPath);
      if (!st.isFile()) {
        return { ok: false, code: 'E4044', message: `入口不是文件：${this.manifest.entry}` };
      }
    } catch {
      return { ok: false, code: 'E4044', message: `入口文件不存在：${this.manifest.entry}` };
    }

    try {
      /*
       * 缓存击穿：同一进程里重复 import 同一路径会拿到旧模块。
       * 加时间戳查询串让"重载"真的重新执行代码。
       *
       * 注意这只对**入口文件**有效：入口 import 的 `./lib/*.mjs` 仍走旧缓存。
       * 同进程插件都是随包内置的，重载语义按"重启后端才彻底生效"理解，
       * 界面会明确提示（restartRequired）。这一点不藏着。
       */
      const url = `${pathToFileURL(entryPath).href}?v=${Date.now()}`;
      this.mod = await import(url);
    } catch (err) {
      const e = /** @type {any} */ (err);
      return { ok: false, code: 'E4045', message: `入口导入失败：${String(e?.message ?? e)}` };
    }

    const plugin = this.mod?.default ?? this.mod?.plugin;
    if (!plugin || typeof plugin !== 'object') {
      return { ok: false, code: 'E4041', message: '入口必须 export default 一个对象' };
    }
    this.instance = plugin;

    // 声明了工具就必须实现 callTool，否则调用时会 500 —— 早点说清楚
    if (this.manifest.tools.length > 0 && typeof plugin.callTool !== 'function') {
      return { ok: false, code: 'E4041', message: '声明了 tools 但入口没有实现 callTool()' };
    }
    if (this.manifest.handleMessage && typeof plugin.handleMessage !== 'function') {
      return { ok: false, code: 'E4041', message: '声明了 handleMessage: true 但入口没有实现 handleMessage()' };
    }

    if (typeof plugin.init === 'function') {
      try {
        const r = await withTimeout(
          Promise.resolve(plugin.init(this.makeContext())),
          INIT_TIMEOUT_MS,
          '插件初始化',
        );
        if (r && r.ok === false) {
          return {
            ok: false,
            code: r.code ?? 'E4064',
            message: String(r.message ?? '插件初始化返回失败'),
          };
        }
      } catch (err) {
        const e = /** @type {any} */ (err);
        return {
          ok: false,
          code: e?.code === 'E4065' ? 'E4065' : 'E4064',
          message: `初始化失败：${String(e?.message ?? e)}`,
        };
      }
    }

    return { ok: true };
  }

  /**
   * 组装交给插件的上下文。
   *
   * 刻意**不给** client、不给整个 config、不给 paths：
   * 插件只该知道"我是谁、我的配置是什么、我怎么发消息、我怎么记日志"。
   *
   * @returns {object}
   */
  makeContext() {
    return {
      plugin: {
        id: this.manifest.id,
        name: this.manifest.name,
        version: this.manifest.version,
        dir: this.dir,
        dataDir: this.dataDir,
        runtime: 'in-process',
      },
      config: { ...this.config },
      secrets: { ...this.secrets },
      dataDir: this.dataDir,
      signal: this.controller.signal,
      log: (level, message, fields) => this.log(String(level ?? 'info'), String(message ?? ''), fields),
      sendText: (convKey, text) => this.sendText(String(convKey), String(text)),
    };
  }

  /**
   * 执行工具。
   *
   * @param {{tool: string, args: object, timeoutMs: number}} input
   * @returns {Promise<{ok: boolean, value?: any, code?: string, message?: string}>}
   */
  async callTool({ tool, args, timeoutMs }) {
    if (this.disposed) return { ok: false, code: 'E4067', message: '插件已停用' };
    if (!this.instance || typeof this.instance.callTool !== 'function') {
      return { ok: false, code: 'E4067', message: '插件未就绪（没有实现 callTool）' };
    }

    let value;
    try {
      value = await withTimeout(
        Promise.resolve(
          this.instance.callTool({
            tool,
            args: args ?? {},
            ctx: this.makeContext(),
            signal: this.controller.signal,
          }),
        ),
        timeoutMs,
        `工具 ${tool} 执行`,
      );
    } catch (err) {
      const e = /** @type {any} */ (err);
      return {
        ok: false,
        code: e?.code === 'E4065' ? 'E4065' : 'E4066',
        message: String(e?.message ?? e),
      };
    }

    const check = checkSerializable(value);
    if (!check.ok) return { ok: false, code: 'E4066', message: check.message };
    // 过一遍序列化再返回：保证宿主拿到的和插件以为的不是同一个可变对象
    return { ok: true, value: value === undefined ? null : JSON.parse(check.json) };
  }

  /**
   * 测试连接。
   *
   * @returns {Promise<{ok: boolean, message?: string, details?: object, code?: string}>}
   */
  async testConnection() {
    if (!this.instance || typeof this.instance.testConnection !== 'function') {
      return { ok: false, code: 'E4068', message: '该插件未实现测试连接' };
    }
    try {
      const r = await withTimeout(
        Promise.resolve(this.instance.testConnection(this.makeContext())),
        TEST_TIMEOUT_MS,
        '测试连接',
      );
      if (!r || typeof r !== 'object') {
        return { ok: false, code: 'E4066', message: '测试连接返回值不合法' };
      }
      return {
        ok: r.ok === true,
        message: typeof r.message === 'string' ? r.message : r.ok === true ? '连接正常' : '测试失败',
        details: r.details && typeof r.details === 'object' ? r.details : undefined,
      };
    } catch (err) {
      const e = /** @type {any} */ (err);
      return { ok: false, code: e?.code === 'E4065' ? 'E4065' : 'E4066', message: String(e?.message ?? e) };
    }
  }

  /**
   * 接管一条消息（仅 in-process）。
   *
   * @param {{evt: object}} input
   * @returns {Promise<boolean>} true = 已处理，不再走 AI 回合
   */
  async handleMessage({ evt }) {
    if (this.disposed) return false;
    if (!this.instance || typeof this.instance.handleMessage !== 'function') return false;
    try {
      const r = await withTimeout(
        Promise.resolve(
          this.instance.handleMessage({
            evt,
            sendText: (convKey, text) => this.sendText(String(convKey), String(text)),
            ctx: this.makeContext(),
          }),
        ),
        10000,
        '消息接管',
      );
      return r === true;
    } catch (err) {
      // 接管失败不能让消息丢掉：返回 false，让宿主继续走正常 AI 回合
      this.log('error', `消息接管异常：${String(/** @type {any} */ (err)?.message ?? err)}`);
      return false;
    }
  }

  /**
   * 停用：中断信号 + 调 dispose。
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.controller.abort();
    } catch {
      /* 忽略 */
    }
    const fn = this.instance?.dispose;
    if (typeof fn === 'function') {
      try {
        await withTimeout(Promise.resolve(fn(this.makeContext())), DISPOSE_TIMEOUT_MS, '插件释放');
      } catch (err) {
        // 释放失败只记日志：停用必须完成，否则用户点不动那个按钮
        this.log('warn', `释放资源超时或失败：${String(/** @type {any} */ (err)?.message ?? err)}`);
      }
    }
    this.instance = null;
  }
}
