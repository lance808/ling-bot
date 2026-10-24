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
 *
 * ## 每次调用的上下文
 *
 * `callTool` 的 ctx 是**按调用**造的（不是 init 那一份）：
 * 里面的 `caller` 与 `chat` 描述"这一次"调用，用完即弃。
 *
 * 为什么不能复用 init 的 ctx：init 发生在插件启动时，那时根本不知道
 * 谁会调用、在哪个会话调用。复用就必然要往一个共享对象里塞"当前会话"，
 * 而并发调用时后一次会覆盖前一次 —— 那正好是串会话事故的成因。
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

import { unavailableGateway } from './gateway-bridge.mjs';
import { freezeCaller } from './caller.mjs';

/** 单个工具返回值上限：超过按失败处理，避免把宿主内存塞爆 */
const MAX_RESULT_BYTES = 256 * 1024;

/** dispose 最多等多久 */
const DISPOSE_TIMEOUT_MS = 3000;

/** init 默认超时 */
const INIT_TIMEOUT_MS = 8000;

/** 测试连接默认超时 */
const TEST_TIMEOUT_MS = 15000;

/**
 * 保存前配置校验的超时。
 *
 * 比 init 短得多：这是用户点「保存」后同步等待的一步，久了就是卡界面。
 * 而它本该只做纯计算（解析 JSON、编译正则），毫秒级。
 * 取 5 秒是给"规则很多 + 机器很慢"留余量，正常不会碰到。
 */
const VALIDATE_TIMEOUT_MS = 5000;

/**
 * 给一个 Promise 加超时。
 *
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {string} what
 * @param {AbortSignal} [signal] 外部取消：中止时立刻结束等待
 * @returns {Promise<T>}
 */
export function withTimeout(p, ms, what, signal, onTimeout) {
  let timer;
  /** @type {() => void} */
  let onAbort = () => {};

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error(`${what}超时（${ms}ms）`), { code: 'E4065' });
      // 先结算为超时，再通知任务取消，避免 abort 回调把 E4065 抢成 E4070。
      reject(error);
      onTimeout?.(error);
    }, ms);
    // 不要因为这个定时器把进程钉住
    if (typeof timer.unref === 'function') timer.unref();

    /*
     * 外部取消：**必须**让这个 Promise 结束。
     *
     * 只清定时器不 reject 会让调用方的 await 永远悬着 ——
     * 表现是"用户点了停止，这个回合再也不结束"。这和 reply/send.mjs
     * 里 defaultSleep 的注释是同一个坑。
     */
    if (signal) {
      onAbort = () => {
        reject(Object.assign(new Error('调用已取消'), { code: 'E4070' }));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  return Promise.race([p, timeout]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  });
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
 * 组合两个取消源：插件整体停用 + 本次调用取消。
 *
 * 为什么需要组合：插件被停用时 ctx.signal abort（长任务要收手），
 * 而单次调用也可能被用户点停止。插件只看其中一个就会漏掉另一种情况。
 * 用 AbortSignal.any 而不是手写监听，是因为它自己会清理监听器
 * （手写的版本在每次调用都加一个 listener，长时间运行会泄漏）。
 *
 * @param {AbortSignal[]} signals
 * @returns {AbortSignal}
 */
export function combineSignals(signals) {
  const list = signals.filter((s) => s && typeof s.aborted === 'boolean');
  if (list.length === 0) return new AbortController().signal;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const one of list) {
    if (one.aborted) {
      controller.abort(one.reason);
      break;
    }
    one.addEventListener('abort', () => controller.abort(one.reason), { once: true });
  }
  return controller.signal;
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
   * @param {(input: object) => Promise<object>} [opts.deliverMedia] 可信同进程插件的后台媒体投递
   * @param {(input: {pluginId: string, invocation: object, dataDir: string, signal: AbortSignal}) => object} [opts.makeChat]
   *   宿主注入的聊天能力工厂（见 plugins/host-chat.mjs）。缺省时 ctx.chat 的
   *   每个方法都返回 E4072 —— 明确报"宿主没提供"，而不是给一个半残对象。
   * @param {(input: {pluginId: string, invocation: object, dataDir: string, signal: AbortSignal}) => object} [opts.makeGateway]
   *   宿主注入的网关受控能力工厂（见 plugins/gateway-bridge.mjs）。与 makeChat
   *   同一套形状：**按调用**产出，闭包里带着不可变的 convKey / dataDir / signal。
   * @param {(input: {invocation: object | null, signal?: AbortSignal}) => object} [opts.makeNet]
   *   宿主注入的联网能力工厂（见 src/net/host-net.mjs）。同样**按调用**产出：
   *   闭包里已经绑定了插件身份、配置与密钥，`ctx.net` 只是它的出口。
   *
   *   为什么不做成单例：配置与密钥是**每个插件**自己的。单例就必须在调用时
   *   往里写"当前是谁"，并发时必然串 —— 和 chat / gateway 是同一个理由。
   */
  constructor(opts) {
    this.manifest = opts.manifest;
    this.dir = opts.dir;
    this.dataDir = opts.dataDir;
    this.config = opts.config;
    this.secrets = { ...(opts.secrets ?? {}) };
    if (this.manifest.id === 'web-search') delete this.secrets.apiKey;
    this.log = opts.log;
    this.sendText = opts.sendText ?? (async () => ({ ok: false, message: '宿主未提供发送能力' }));
    // 后台能力只给可信同进程插件；即使直接构造运行时也不向其他插件暴露。
    this.deliverMedia = opts.manifest.runtime === 'in-process' && opts.manifest.trusted === true
      && typeof opts.deliverMedia === 'function' ? opts.deliverMedia : null;
    this.makeChat = opts.makeChat ?? null;
    this.makeGateway = opts.makeGateway ?? null;
    this.makeNet = opts.makeNet ?? null;

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
   * 只加载入口模块并校验导出形状，**不调用 init**。
   *
   * ## 为什么把它从 init 里拆出来
   *
   * 「保存前校验配置」（清单 `validateConfig: true`）需要在插件还没
   * 初始化时问它一句"这套配置能用吗"。而 init 会真的去开端口、建定时器、
   * 连服务 —— 为了校验一次配置就把这些都跑一遍，等于把一次纯计算
   * 变成了有副作用的操作：校验失败的半初始化实例还得再收拾一遍。
   *
   * 所以拆成两段：
   *   load()  纯加载 + 形状校验（无副作用，可重复调用）
   *   init()  = load() + init 钩子（有副作用，只在启用时跑）
   *
   * `this.instance` 在 load 之后就可用了，即使 init 从未被调用。
   * 这不是"半就绪"：入口里凡是依赖 init 状态的方法，都应该在
   * 拿不到运行时单例时优雅降级（`testConnection` 的既有约定就是这样）。
   *
   * 幂等：已经加载过就直接返回成功，不重复 import。
   *
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
   */
  async load() {
    if (this.instance) return { ok: true };

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
    // 声明了 validateConfig 就必须实现它，否则保存时无从校验（静默放行最糟）
    if (this.manifest.validateConfig && typeof plugin.validateConfig !== 'function') {
      return {
        ok: false,
        code: 'E4041',
        message: '声明了 validateConfig: true 但入口没有实现 validateConfig(config)',
      };
    }

    return { ok: true };
  }

  /**
   * 加载入口并调用 init。
   *
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
   */
  async init() {
    const loaded = await this.load();
    if (!loaded.ok) return loaded;

    const plugin = this.instance;

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
   * 组装交给插件的**基础**上下文（init / dispose / testConnection 用）。
   *
   * 刻意**不给** client、不给整个 config、不给 paths：
   * 插件只该知道"我是谁、我的配置是什么、我怎么发消息、我怎么记日志"。
   *
   * 注意这里没有 `caller` / `chat`：这两种能力只在**一次工具调用**里有意义。
   * 在 init 时给一个"不知道是谁"的 caller 只会诱导插件把它存起来用 ——
   * 而存下来的上下文在并发调用时必然是错的。
   *
   * `net` 是例外：它在 init / 测试连接里**也有**，但只有同步事实
   * （available / enabled / provider / configured）是真的可用，`search` /
   * `fetch` 在这两个阶段会返回 E4071。理由很实际：插件要在 init 里
   * 判断"要不要提示用户去填 Key"，而它读的就是 `ctx.net.configured`。
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
      ...(this.deliverMedia ? {
        deliverMedia: async (input = {}) => {
          if (this.disposed || this.controller.signal.aborted) {
            return { ok: false, code: 'E4067', message: '插件已停用，拒绝后台投递' };
          }
          // 不绑定工具回合：任务可以在工具返回后继续，取消由任务自己的 signal 控制。
          const signal = combineSignals([this.controller.signal, input.signal]);
          if (signal.aborted) return { ok: false, code: 'E4070', message: '后台投递已取消' };
          return this.deliverMedia({
            ...input,
            signal,
            isActive: () => !this.disposed && !this.controller.signal.aborted,
          });
        },
      } : {}),
      /**
       * 联网能力（只有事实，没有调用上下文时 search/fetch 会拒绝）。
       *
       * 每次现取而不是缓存：总闸可能刚被关掉，缓存会让"关掉之后 init
       * 还看到 enabled:true"——那正好是安全开关最不该出现的症状。
       */
      net: this.makeNet
        ? this.makeNet({ invocation: null, allowRequests: false })
        : unavailableNet('宿主未提供联网能力（E4071）'),
    };
  }

  /**
   * 组装**本次调用**的上下文。
   *
   * @param {object} input
   * @param {object} [input.invocation] 宿主构造的可信调用上下文
   * @param {AbortSignal} [input.signal] 本次调用的取消信号
   * @returns {object}
   */
  makeCallContext({ invocation, signal } = {}) {
    const base = this.makeContext();
    const combined = combineSignals([this.controller.signal, signal]);

    return {
      ...base,
      /**
       * 本次调用是谁、在哪、由谁触发（宿主生成，模型改不动）。
       *
       * 用 `freezeCaller` 而不是 `{...invocation}`：展开会**丢掉冻结属性**
       * （executor 造出来的 invocation 是 Object.freeze 过的），于是文档许诺的
       * "caller 不可变"在这条路径上不成立。详见 caller.mjs 的文件头。
       */
      caller: freezeCaller(invocation),
      /** 受控聊天能力：只能操作 caller.convKey */
      chat: this.makeChat
        ? this.makeChat({
            pluginId: this.manifest.id,
            invocation: invocation ?? null,
            dataDir: this.dataDir,
            signal: combined,
          })
        : unavailableChat('宿主未提供聊天能力（E4072）'),
      /**
       * 受控网关能力：账号级动作（拉收藏表情、取表情字节、收藏、发表情）。
       *
       * 与 chat 同一套形状，理由也一样：它绑定"这次调用在哪个会话、
       * 用哪个 dataDir、被哪个 signal 取消"。做成单例就必须在调用时
       * 往里写当前会话，并发时会串。
       */
      gateway: this.makeGateway
        ? this.makeGateway({
            pluginId: this.manifest.id,
            invocation: invocation ?? null,
            dataDir: this.dataDir,
            signal: combined,
          })
        : unavailableGateway('宿主未提供网关能力（E4072）'),
      /**
       * 受控联网能力（契约见 docs/web-search-contract.md §3）。
       *
       * 插件拿到的只是一个**已经被总闸判定过**的对象：它自己读不到配置，
       * 也就无法决定自己是否受总闸约束。而且每次 `search` / `fetch`
       * 进入时宿主还会再读一次总闸 —— 构造那一刻开着、调用那一刻关掉，
       * 也必须被拦住。
       */
      net: this.makeNet
        ? this.makeNet({ invocation: invocation ?? null, signal: combined })
        : unavailableNet('宿主未提供联网能力（E4071）'),
      /** 组合信号：插件停用 *或* 本次调用被取消都会 abort */
      signal: combined,
    };
  }

  /**
   * 执行工具。
   *
   * @param {{tool: string, args: object, timeoutMs: number, invocation?: object, signal?: AbortSignal}} input
   * @returns {Promise<{ok: boolean, value?: any, code?: string, message?: string}>}
   */
  async callTool({ tool, args, timeoutMs, invocation, signal }) {
    if (this.disposed) return { ok: false, code: 'E4067', message: '插件已停用' };
    if (!this.instance || typeof this.instance.callTool !== 'function') {
      return { ok: false, code: 'E4067', message: '插件未就绪（没有实现 callTool）' };
    }

    // 进函数之前就已经被取消了：不要白跑一次插件代码
    if (signal?.aborted) return { ok: false, code: 'E4070', message: '调用已取消' };

    // 每次调用独立计时取消；超时不能 abort 插件生命周期，否则后续调用也会失效。
    const timeoutController = new AbortController();
    const callCtx = this.makeCallContext({
      invocation,
      signal: combineSignals([signal, timeoutController.signal]),
    });

    let value;
    try {
      value = await withTimeout(
        Promise.resolve(
          this.instance.callTool({
            tool,
            args: args ?? {},
            ctx: callCtx,
            signal: callCtx.signal,
          }),
        ),
        timeoutMs,
        `工具 ${tool} 执行`,
        callCtx.signal,
        (error) => timeoutController.abort(error),
      );
    } catch (err) {
      const e = /** @type {any} */ (err);
      /*
       * 取消要单独报 E4070，不能混进 E4066。
       *
       * 混进去的后果：管理器会把 E4066 当成"插件崩溃"（它有专门的
       * crashed 状态与撤工具逻辑），于是用户点一次停止，插件就被标成崩溃、
       * 工具从列表里消失 —— 看起来像"点停止把插件点坏了"。
       */
      if (e?.code === 'E4070' || e?.name === 'AbortError') {
        return { ok: false, code: 'E4070', message: '调用已取消' };
      }
      return {
        ok: false,
        code: e?.code === 'E4065' ? 'E4065' : 'E4066',
        message: String(e?.message ?? e),
      };
    } finally {
      /*
       * 调用结束（成功、失败、取消都算）立即让本次的联网能力失效。
       *
       * 插件可以把 `ctx.net` 存起来留到下一次调用；那会让"一次授权"
       * 变成"永久授权"，而配置与 Key 还在闭包里。revoke 之后它只剩
       * 一个会明确返回 E4071 的对象。
       */
      try {
        callCtx?.net?.revoke?.();
      } catch {
        /* revoke 本身不能影响调用结果 */
      }
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
      return { ok: false, code: e?.code === 'E4065' ? 'E4065' : 'E4066', message: String(e?.message ?? err) };
    }
  }

  /**
   * 保存配置前的自校验（清单 `validateConfig: true`）。
   *
   * ## 与 testConnection 的两点不同
   *
   * 1. **参数是配置对象本身**，不是 `ctx`。因为调用发生时配置还没落盘，
   *    候选值只存在于这次调用里 —— 给 `ctx.config` 只能拿到旧值，
   *    那校验的就是"上一份配置"，一点用都没有。
   * 2. **不需要先 init**。它会先 `load()`（纯加载，无副作用），
   *    所以插件处于「待配置 / 初始化失败」时也能被校验。
   *
   * 插件没有实现时返回 `ok: true` —— 清单校验（load）已经拒绝过
   * "声明了但没实现"的情况，这里是兜底：未声明这个能力的插件不该
   * 因为宿主多问了一句而保存失败。
   *
   * @param {Record<string, any>} config 候选配置（已按声明归一）
   * @returns {Promise<{ok: boolean, message?: string, details?: object, code?: string}>}
   */
  async validateConfig(config) {
    if (!this.manifest.validateConfig) return { ok: true };

    const loaded = await this.load();
    if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };

    const fn = this.instance?.validateConfig;
    if (typeof fn !== 'function') return { ok: true };

    try {
      const r = await withTimeout(
        Promise.resolve(fn(config ?? {})),
        VALIDATE_TIMEOUT_MS,
        '配置校验',
      );
      if (!r || typeof r !== 'object') {
        return { ok: false, code: 'E4066', message: 'validateConfig 返回值不合法（应为 {ok, message}）' };
      }
      return {
        ok: r.ok === true,
        message: typeof r.message === 'string' ? r.message : undefined,
        details: r.details && typeof r.details === 'object' ? r.details : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        code: 'E4062',
        message: `配置校验失败：${String(/** @type {any} */ (err)?.message ?? err)}`,
      };
    }
  }

  /**
   * 接管一条消息（仅 in-process）。
   *
   * `gate` 是宿主在派发前算好的**结构性事实**（白名单、静音、是否有待确认）。
   * 插件据此决定"这条消息该不该由我处理"，而不是自己去猜：
   *
   *   - 白名单/静音是宿主的策略，插件看不到那份配置；
   *   - "还有待确认"只有宿主知道（确认表在 guard/confirm.mjs 里）。
   *
   * 传下去而不是让插件自己判断，是这条边界唯一可靠的写法：
   * 插件读不到那些状态，就永远不会出现"两种判定各说一套"。
   *
   * @param {{evt: object, gate?: object}} input
   * @returns {Promise<boolean>} true = 已处理，不再走 AI 回合
   */
  async handleMessage({ evt, gate }) {
    if (this.disposed) return false;
    if (!this.instance || typeof this.instance.handleMessage !== 'function') return false;
    try {
      const r = await withTimeout(
        Promise.resolve(
          this.instance.handleMessage({
            evt,
            gate: gate ?? null,
            /*
             * 兼容旧插件的 sendText(convKey, text)：渠道插件自己决定往哪发，
             * 所以这里**保留** convKey 参数（它不经过工具调用，没有 caller）。
             * 它仍然走宿主的统一发送闸门。
             */
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

/**
 * 宿主没注入聊天能力时的占位对象。
 *
 * 每个方法都返回同一个明确的错误，而不是 `undefined`：
 * 插件调用一个不存在的方法会抛 TypeError，那个异常会被包成 E4066
 * （"执行异常"），而真实原因是"宿主没提供这个能力" —— 排查方向完全不同。
 *
 * ## 为什么读类方法保持同步
 *
 * `recent` / `message` / `mediaList` 在正常实现里是**同步**返回的
 * （她只是内存查找）。占位对象要是全部做成 async，插件按正常语义写
 * `const r = ctx.chat.recent(...)` 就会拿到一个 Promise，再去读 `r.ok`
 * 得到 undefined —— 那个 bug 只在"宿主没注入"时出现，而那时最需要
 * 清晰的错误信息。所以形状必须与正常实现一致。
 *
 * @param {string} message
 * @returns {object}
 */
export function unavailableChat(message) {
  const err = () => ({ ok: false, code: 'E4072', message });
  return {
    recent: () => err(),
    message: () => err(),
    mediaList: () => err(),
    send: async () => err(),
    sendMedia: async () => err(),
    registerMedia: async () => err(),
  };
}

/**
 * 宿主没注入联网能力时的占位对象。
 *
 * ## 形状必须与正常实现一致（含四个同步字段）
 *
 * 插件很自然会写 `if (!ctx.net.enabled) return ...` 做提前短路。
 * 如果占位对象没有 `enabled`，那个判断拿到的是 `undefined`
 * （falsy），表面行为看着"对"，但插件作者永远发现不了自己写的是
 * "宿主没注入"而不是"联网关着"—— 两者对用户的含义完全不同。
 *
 * ## 两个方法都返回明确的 E4071，而不是 undefined
 *
 * 返回 undefined 会让插件写 `const r = await ctx.net.search(...); r.ok`
 * 时抛 TypeError，那个异常会被包成 E4066「插件执行异常」，而真实原因是
 * "宿主没接好"。E4071 直接指向装配问题，排查方向完全不同。
 *
 * @param {string} message
 * @returns {object}
 */
export function unavailableNet(message) {
  const err = () => ({ ok: false, code: 'E4071', message });
  return {
    available: false,
    enabled: false,
    provider: '',
    configured: false,
    search: async () => err(),
    fetch: async () => err(),
  };
}
