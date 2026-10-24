/**
 * 插件子进程入口 —— `process` 运行时的插件侧
 *
 * ## 协议
 *
 * 父进程 ↔ 子进程走 **stdin/stdout 上的 NDJSON**（一行一个 JSON）。
 * 不用 `child_process.fork` 的 IPC 通道：Windows 上 IPC 走命名管道，
 * 在受限环境里可能被拒绝；匿名管道（stdio）到处都能用，也更好调试
 * （手写一行 JSON 就能喂给子进程）。
 *
 * 父 → 子：
 *   { "type": "init", "payload": { manifest, dir, dataDir, config, secrets } }
 *   { "type": "call", "id": 1, "tool": "echo", "args": {...}, "timeoutMs": 20000,
 *     "invocation": { origin, convKey, requester, messageId, callId, ... } }
 *   { "type": "cancel", "id": 1 }               ← 取消这次调用（不杀进程）
 *   { "type": "test", "id": 2 }
 *   { "type": "dispose" }
 *   { "type": "send-text-result", "id": 7, "result": {...} }
 *   { "type": "host-call-result", "id": 9, "result": {...} }
 *   { "type": "shutdown" }
 *
 * 子 → 父：
 *   { "type": "ready" } | { "type": "init-error", "code", "message" }
 *   { "type": "result", "id": 1, "ok": true, "value": ... }
 *   { "type": "result", "id": 1, "ok": false, "code": "E4066", "message": "..." }
 *   { "type": "log", "level": "info", "message": "...", "fields": {...} }
 *   { "type": "send-text", "id": 7, "convKey": "...", "text": "..." }
 *   { "type": "host-call", "id": 9, "callId": 1, "method": "send", "args": {...} }
 *   { "type": "host-call", "id": 10, "callId": 1, "method": "vision", "args": {} }
 *   { "type": "fatal", "message": "..." }
 *
 * ## 为什么要把 console 接管掉
 *
 * 插件作者很自然会写 `console.log(...)`。而 stdout 就是协议通道 ——
 * 一行裸日志会让父进程的 JSON.parse 失败，症状是"插件随机不响应"。
 * 所以这里把 console.* 全部重定向成 `log` 消息：插件不用学新 API，
 * 协议也不会被打断。
 *
 * ## 上下文为什么由父进程随 call 一起下发，而不是子进程自己拼
 *
 * `ctx.caller` 是授权上下文。如果子进程能自己填，一句
 * `{origin:'owner-private'}` 就完成了提权。所以它只能来自父进程
 * 随 `call` 下发的 `invocation`，而且父进程**从不读**子进程回传的上下文字段。
 *
 * 同理，`ctx.chat.*` 在这里只是一个**代理**：真正的执行发生在父进程，
 * 父进程按 callId 找回自己记下的上下文。子进程即使伪造 args 里的会话，
 * 也改不了父进程认定的那个会话（因为 chat 接口里根本没有会话参数）。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

import { freezeCaller } from './caller.mjs';
import { UNKNOWN_GATEWAY_VISION } from './gateway-vision.mjs';

/** @type {any} */
let plugin = null;
/** @type {any} */
let ctx = null;
let disposed = false;

/**
 * 最近一次由父进程下发的联网事实。
 *
 * 存在这里而不是每次从 `ctx.net` 反推：`ctx` 是**这一轮 init** 的快照，
 * 而事实要随每次 call 刷新（用户可能刚关掉总闸）。父进程没带新事实时
 * 才回落到这份，保证"老宿主的 call 也能用"。
 *
 * @type {{available: boolean, enabled: boolean, provider: string, configured: boolean}}
 */
let lastNetFacts = { available: false, enabled: false, provider: '', configured: false };

/**
 * 在途调用的取消控制器 / 上下文。
 *
 * @type {Map<number, {controller: AbortController, invocation: object}>}
 */
const inflight = new Map();

/** 递增的 host-call id（与父进程的请求 id 是两套编号，互不干扰） */
let hostCallSeq = 0;
/** @type {Map<number, (v: any) => void>} */
const pendingHostCalls = new Map();

/**
 * 往父进程写一行协议消息。
 *
 * @param {object} msg
 */
function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch {
    // 父进程已经没了，写不出去也没别的办法
  }
}

/**
 * 插件日志 → 父进程。
 *
 * @param {string} level
 * @param {string} message
 * @param {object} [fields]
 */
function log(level, message, fields) {
  send({ type: 'log', level: String(level ?? 'info'), message: String(message ?? ''), fields });
}

// ---- 接管 console：stdout 是协议通道，裸打印会打断它 ----
/*
 * 只在**真的作为子进程入口**运行时接管 console 与 stdin。
 *
 * 为什么需要这个判断：测试要 import 本模块来验证 `ctx.caller` 的冻结与
 * `ctx.gateway` 的形状（那是子进程侧唯一真实的实现）。而在测试进程里
 * 接管 console 会把所有日志改写成 NDJSON 协议行 → 糊到测试输出里；
 * 给 stdin 注册 `end → process.exit(0)` 更会让测试进程直接退出。
 *
 * `IS_MAIN` 用 argv[1] 判定：父进程是 `node child-runner.mjs` 起的，
 * 测试里 argv[1] 是测试文件，两者不会相同。
 */
const IS_MAIN = (() => {
  try {
    if (!process.argv[1]) return false;
    const entry = path.resolve(process.argv[1]);
    const self = path.resolve(fileURLToPath(import.meta.url));
    // Windows 路径大小写不敏感：比较前统一小写，避免因盘符/目录大小写不同而判错
    return entry.toLowerCase() === self.toLowerCase();
  } catch {
    return false;
  }
})();

if (IS_MAIN) {
  for (const level of /** @type {const} */ (['log', 'info', 'warn', 'error', 'debug'])) {
    console[level] = (...args) => {
      const text = args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
      log(level === 'log' ? 'info' : level, text);
    };
  }
}

/**
 * 从父进程请求一次发送（走宿主闸门）。
 *
 * 这是**兼容垫片**：ctx.sendText(convKey, text) 是旧接口，
 * 渠道插件（dsh-bridge）靠它把审批卡发到管理员私聊。它不经过工具调用，
 * 因此没有 caller，会话是插件自己指定的 —— 仍然走宿主闸门。
 *
 * @param {string} convKey
 * @param {string} text
 * @returns {Promise<any>}
 */
function requestSendText(convKey, text) {
  return new Promise((resolve) => {
    const id = ++sendTextSeq;
    pendingSendText.set(id, resolve);
    send({ type: 'send-text', id, convKey, text });
  });
}

let sendTextSeq = 0;
/** @type {Map<number, (v: any) => void>} */
const pendingSendText = new Map();

/**
 * 向父进程请求一次宿主能力（chat.*）。
 *
 * @param {number} callId 当前调用 id（父进程据此找回可信上下文）
 * @param {string} method
 * @param {object} args
 * @returns {Promise<any>}
 */
function requestHostCall(callId, method, args) {
  return new Promise((resolve) => {
    const id = ++hostCallSeq;
    pendingHostCalls.set(id, resolve);
    send({ type: 'host-call', id, callId, method, args: args ?? {} });
  });
}

/**
 * 为一次调用组装 ctx.chat（全是代理）。
 *
 * 注意每个方法都**不接受**会话参数 —— 与宿主侧保持一致。
 * 保持一致很重要：不一致的话，插件按父进程的文档写代码，
 * 在子进程里却因为多传了一个 convKey 而静默发错地方。
 *
 * @param {number} callId
 * @param {(callId: number, method: string, args: object) => Promise<any>} [request] 宿主请求通道
 *   （默认是本模块的 `requestHostCall`；测试可注入假实现 —— 这样子进程侧的
 *   代理形状能在不 spawn 的前提下被断言）
 * @returns {object}
 */
export function makeChatProxy(callId, request = requestHostCall) {
  const call = (method, args) => request(callId, method, args ?? {});
  return {
    recent: (input) => call('recent', input),
    message: (input) => call('message', input),
    mediaList: (input) => call('mediaList', input),
    send: (input) => call('send', input),
    sendMedia: (input) => call('sendMedia', input),
    registerMedia: (input) => call('registerMedia', input),
  };
}

/**
 * 为一次调用组装 `ctx.gateway` 代理。
 *
 * ## 形状必须与宿主实现一致，包括同步属性
 *
 * `gateway.vision` 在宿主侧是**同步属性**（纯内存读一次配置快照），
 * 插件会自然地写 `const v = ctx.gateway.vision; if (!v.enabled) ...`。
 * 如果这里把它做成 async，`v` 就是一个 Promise，`v.enabled` 永远是
 * undefined —— 表现是"视觉永远被当成关着"，而代码看起来完全正确。
 *
 * 所以 `vision` 走**同步缓存**：第一次读到之后记住，同一次调用内不再变。
 * 它在一秒内变化的可能只存在于"用户刚好在工具执行的同一瞬间关掉视觉"，
 * 而那种情况下读旧值也说不上错（这次调用本来就开始于关掉之前）。
 *
 * `caps()` 同理：它是纯内存读取，做成同步，但要预热一次。
 *
 * @param {number} callId
 * @param {(callId: number, method: string, args: object) => Promise<any>} [request]
 * @returns {object}
 */
export function makeGatewayProxy(callId, request = requestHostCall) {
  /** 视觉事实的同步缓存（undefined = 还没拉过） */
  let visionCache;
  /** 能力视图的同步缓存 */
  let capsCache;

  const call = async (method, args) => {
    const r = await request(callId, method, args ?? {});
    return r;
  };

  return {
    /*
     * `available` 恒为 true：真正"宿主没注入"的情况在父进程侧会被换成
     * unavailableGateway（available:false）。子进程这边只有"有代理"和
     * "没有网关能力"两种，前者就一定 available。
     */
    available: true,

    get vision() {
      if (visionCache === undefined) {
        /*
         * 还没拉过就先给"未知"的安全默认值，同时后台刷新。
         *
         * 用共享的 `UNKNOWN_GATEWAY_VISION`（带 `known: false`）而不是手写
         * `{enabled:false, supported:null}`：漏掉 `known` 会让"没拉过"与
         * "宿主说不知道"在形状上分不出来，而两端形状不一致正是最难排查的
         * 一类问题（详见 gateway-vision.mjs 的文件头）。
         */
        visionCache = { ...UNKNOWN_GATEWAY_VISION };
        void call('vision').then((r) => {
          if (r?.ok && r.value && typeof r.value === 'object') visionCache = r.value;
        });
      }
      return visionCache;
    },

    caps() {
      if (capsCache === undefined) {
        capsCache = {
          prober: 'unknown',
          fetchCustomFaceDetail: 'unknown',
          addCustomFace: 'unknown',
          modifyCustomFace: 'unknown',
          probedAt: null,
          reason: '',
        };
        void call('caps').then((r) => {
          if (r?.ok && r.value && typeof r.value === 'object') capsCache = r.value;
        });
      }
      return capsCache;
    },

    probe: (input) => call('probe', input ?? {}),
    listFaces: (input) => call('listFaces', input ?? {}),
    fetchFaceImage: (input) => call('fetchFaceImage', input ?? {}),
    collectFace: (input) => call('collectFace', input ?? {}),
    sendFace: (input) => call('sendFace', input ?? {}),
  };
}

/**
 * 为一次调用组装 `ctx.net` 代理。
 *
 * ## 只下发事实，不下发密钥
 *
 * 子进程拿到的是 `available / enabled / provider / configured` 四个标量
 * （由父进程在 init 与每次 call 时算好）。真正的请求全部转成 host-call
 * 回父进程执行 —— 只有那里有密钥，也只有那里能在用户关掉联网时
 * 把在途请求一起掐掉。
 *
 * 如果把密钥下发到这里，插件就能绕过宿主直接调上游：额度照花，
 * 而宿主的开关、统计、取消统统失效。
 *
 * ## init / 测试连接阶段没有 callId
 *
 * 那时只能读事实、不能发请求（与宿主侧 `unavailableNet` 同一口径）。
 * 返回明确的 E4071 而不是抛错：插件写 `await` 之后读 `.ok` 不会崩，
 * 而错误信息直接指向"这里不该发请求"。
 *
 * @param {number | null} callId
 * @param {any} facts
 * @param {(callId: number, method: string, args: object) => Promise<any>} [request]
 * @returns {object}
 */
export function makeNetProxy(callId, facts, request = requestHostCall) {
  const f = normalizeNetFacts(facts);
  const factsOnly = () => ({
    ok: false,
    code: 'E4071',
    message: '联网请求只能在工具调用里发起（init / 测试连接阶段没有调用上下文，宿主也不会替你发请求）。',
  });

  const run = (method, args) => {
    if (!f.available) {
      return Promise.resolve({ ok: false, code: 'E4071', message: '宿主没有注入联网能力' });
    }
    if (callId === null || callId === undefined) return Promise.resolve(factsOnly());
    return request(callId, method, args ?? {});
  };

  return {
    available: f.available,
    enabled: f.enabled,
    provider: f.provider,
    configured: f.configured,
    search: (args) => run('search', args),
    fetch: (args) => run('fetch', args),
  };
}

/**
 * 解码父进程下发的联网事实。
 *
 * 严格按布尔判定（`=== true`）：拿不到就是 false。方向刻意偏严 ——
 * 把"没拿到"当成"可以用"会让插件在宿主没接线时仍去尝试，
 * 而那种失败看起来像"网络坏了"。
 *
 * @param {any} facts
 * @returns {{available: boolean, enabled: boolean, provider: string, configured: boolean}}
 */
function normalizeNetFacts(facts) {
  return {
    available: facts?.available === true,
    enabled: facts?.enabled === true,
    provider: String(facts?.provider ?? ''),
    configured: facts?.configured === true,
  };
}

/**
 * 组装**本次调用**的子进程侧 ctx。
 *
 * 抽成导出函数而不是写在 `handle()` 里，是为了让两端一致性可以被真正断言：
 * `ctx.caller` 的冻结与 `ctx.gateway.vision` 的形状都是"形状契约"，
 * 而这种东西只能靠"拿真实实现造一份、逐键比对"来守（见
 * test/plugin-runtime-parity.test.mjs）。写在消息处理函数里就只能靠 spawn
 * 子进程来测，而沙箱里 spawn 会被拒（EPERM）。
 *
 * @param {object} input
 * @param {object} input.baseCtx init 阶段那份 ctx（plugin/config/log/sendText…）
 * @param {any} input.invocation 父进程随 call 下发的可信上下文
 * @param {number} input.callId 本次调用的 id（host-call 用它回查会话）
 * @param {AbortSignal} input.signal 本次调用的取消信号
 * @param {object} [input.netFacts] 父进程这次下发的联网事实
 * @param {(callId: number, method: string, args: object) => Promise<any>} [input.request]
 * @returns {object}
 */
export function buildCallContext({ baseCtx, invocation, callId, signal, netFacts, request = requestHostCall }) {
  return {
    ...baseCtx,
    /*
     * caller 用宿主侧同一份 `freezeCaller` 归一 + 递归冻结。
     *
     * 父进程已经把 invocation 随 call 下发过来了（子进程编不了），但它是
     * JSON 反序列化出来的普通对象：不冻结的话，`ctx.caller.origin = ...`
     * 在这条路径上就是可以改的，而 in-process 侧不允许 —— 同一份清单
     * 在两个 runtime 上行为不同。详见 caller.mjs 的文件头。
     */
    caller: freezeCaller(invocation),
    chat: makeChatProxy(callId, request),
    gateway: makeGatewayProxy(callId, request),
    /*
     * 联网事实随每次 call 刷新：用户可能刚关掉总闸，而这一回合已经开始了。
     * 插件据此提前短路，父进程那边照样会再判一次（两道，互不依赖）。
     */
    net: makeNetProxy(callId, netFacts, request),
    signal,
  };
}

/**
 * 处理一条父进程消息。
 *
 * @param {any} msg
 */
async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'init') {
    const payload = msg.payload ?? {};
    try {
      const entryPath = path.join(payload.dir, payload.manifest.entry);
      const st = await fs.stat(entryPath);
      if (!st.isFile()) {
        send({ type: 'init-error', code: 'E4044', message: `入口不是文件：${payload.manifest.entry}` });
        return;
      }
      await fs.mkdir(payload.dataDir, { recursive: true });

      const url = `${pathToFileURL(entryPath).href}?v=${Date.now()}`;
      const mod = await import(url);
      const p = mod.default ?? mod.plugin;
      if (!p || typeof p !== 'object') {
        send({ type: 'init-error', code: 'E4041', message: '入口必须 export default 一个对象' });
        return;
      }
      plugin = p;

      ctx = {
        plugin: {
          id: payload.manifest.id,
          name: payload.manifest.name,
          version: payload.manifest.version,
          dir: payload.dir,
          dataDir: payload.dataDir,
          runtime: 'process',
        },
        config: payload.config ?? {},
        secrets: payload.manifest.id === 'web-search'
          ? Object.fromEntries(Object.entries(payload.secrets ?? {}).filter(([key]) => key !== 'apiKey'))
          : (payload.secrets ?? {}),
        dataDir: payload.dataDir,
        // init 阶段还没有"某次调用"，所以没有 caller / chat。
        // 子进程里没有"宿主整体停用"的信号源，用一个空 signal 占位，
        // 真正的强杀由父进程 kill 完成
        signal: new AbortController().signal,
        log: (level, message, fields) => log(level, message, fields),
        sendText: (convKey, text) => requestSendText(String(convKey), String(text)),
        /*
         * 联网能力：init 阶段只有事实（没有调用上下文）。
         *
         * 插件会在这里读 `ctx.net.configured` 决定要不要提示用户去填 Key ——
         * 那是 init 里唯一有意义的一件事。真发请求要等一次工具调用。
         */
        net: makeNetProxy(null, payload.netFacts),
      };
      lastNetFacts = normalizeNetFacts(payload.netFacts);

      if (payload.manifest.tools.length > 0 && typeof plugin.callTool !== 'function') {
        send({ type: 'init-error', code: 'E4041', message: '声明了 tools 但入口没有实现 callTool()' });
        return;
      }

      if (typeof plugin.init === 'function') {
        const r = await plugin.init(ctx);
        if (r && r.ok === false) {
          send({ type: 'init-error', code: r.code ?? 'E4064', message: String(r.message ?? '初始化返回失败') });
          return;
        }
      }
      send({ type: 'ready' });
    } catch (err) {
      const e = /** @type {any} */ (err);
      send({
        type: 'init-error',
        code: e?.code === 'E4045' ? 'E4045' : 'E4064',
        message: `初始化异常：${String(e?.message ?? e)}`,
      });
    }
    return;
  }

  if (msg.type === 'call') {
    const id = msg.id;
    if (disposed || !plugin || typeof plugin.callTool !== 'function') {
      send({ type: 'result', id, ok: false, code: 'E4067', message: '插件未就绪' });
      return;
    }

    const controller = new AbortController();
    const invocation = msg.invocation && typeof msg.invocation === 'object' ? msg.invocation : null;
    inflight.set(id, { controller, invocation });
    const timeoutMs = Number(msg.timeoutMs);
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(Object.assign(new Error('工具执行超时'), { code: 'E4065' })), timeoutMs)
      : null;
    timer?.unref?.();

    /*
     * 每次调用一份 ctx：caller / chat / signal 都只描述这一次。
     *
     * 复用同一个 ctx 对象会让并发调用互相覆盖"当前会话"——
     * 那正好是"图发到别的群"这类事故的成因。
     *
     * 组装逻辑抽在 `buildCallContext` 里（已导出）：形状契约需要对两端
     * 逐键断言，写在消息处理函数里就只能靠 spawn 来测。
     */
    const callCtx = buildCallContext({
      baseCtx: ctx,
      invocation,
      callId: id,
      signal: controller.signal,
      netFacts: msg.netFacts ?? lastNetFacts,
    });

    try {
      const value = await plugin.callTool({
        tool: msg.tool,
        args: msg.args ?? {},
        ctx: callCtx,
        signal: controller.signal,
      });
      let json;
      try {
        json = JSON.stringify(value);
      } catch (err) {
        send({
          type: 'result',
          id,
          ok: false,
          code: 'E4066',
          message: `返回值无法序列化：${String(/** @type {any} */ (err)?.message ?? err)}`,
        });
        return;
      }
      if (json === undefined) {
        send({ type: 'result', id, ok: true, value: null });
        return;
      }
      if (Buffer.byteLength(json, 'utf8') > 256 * 1024) {
        send({ type: 'result', id, ok: false, code: 'E4066', message: '返回值超过 256KB 上限' });
        return;
      }
      // 直接拼进协议行：避免再解析一次
      send({ type: 'result', id, ok: true, value: JSON.parse(json) });
    } catch (err) {
      const e = /** @type {any} */ (err);
      /*
       * 取消要报 E4070，别混成 E4066。
       *
       * E4066 在宿主侧意味着"插件执行异常"，管理器会据此把插件标成
       * crashed 并撤掉工具 —— 用户点一次停止就把插件点没了，很难理解。
       */
      const timedOut = controller.signal.reason?.code === 'E4065';
      const cancelled = e?.code === 'E4070' || e?.name === 'AbortError' || controller.signal.aborted;
      send({
        type: 'result',
        id,
        ok: false,
        code: timedOut ? 'E4065' : cancelled ? 'E4070' : 'E4066',
        message: timedOut ? '工具执行超时' : cancelled ? '调用已取消' : String(e?.message ?? e),
      });
    } finally {
      clearTimeout(timer);
      inflight.delete(id);
    }
    return;
  }

  if (msg.type === 'cancel') {
    /*
     * 取消：abort 这次调用的信号，让插件的长任务自己收手。
     *
     * **不退出进程、不 throw 到主流程**：父进程那边已经把等待结束了，
     * 这里只需要让插件看到 signal.aborted。插件不检查 signal 的话，
     * 它会继续跑完然后发一个迟到的 result —— 父进程找不到 pending，丢弃即可。
     */
    const one = inflight.get(Number(msg.id));
    if (one) {
      try {
        one.controller.abort(Object.assign(new Error('调用已取消'), { code: 'E4070' }));
      } catch {
        /* 忽略 */
      }
    }
    return;
  }

  if (msg.type === 'test') {
    const id = msg.id;
    if (!plugin || typeof plugin.testConnection !== 'function') {
      send({ type: 'result', id, ok: false, code: 'E4068', message: '该插件未实现测试连接' });
      return;
    }
    try {
      const r = await plugin.testConnection(ctx);
      send({
        type: 'result',
        id,
        ok: r?.ok === true,
        message: typeof r?.message === 'string' ? r.message : r?.ok === true ? '连接正常' : '测试失败',
        details: r?.details && typeof r.details === 'object' ? r.details : undefined,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      send({ type: 'result', id, ok: false, code: 'E4066', message: String(e?.message ?? e) });
    }
    return;
  }

  if (msg.type === 'send-text-result') {
    const resolve = pendingSendText.get(msg.id);
    if (resolve) {
      pendingSendText.delete(msg.id);
      resolve(msg.result ?? { ok: false, message: '宿主未返回结果' });
    }
    return;
  }

  if (msg.type === 'host-call-result') {
    /*
     * 调用已经被取消 / 结束时，对应的等待方可能已经清掉了。
     * 找不到就丢弃 —— 这是正常的（父进程不等了）。
     */
    const resolve = pendingHostCalls.get(msg.id);
    if (resolve) {
      pendingHostCalls.delete(msg.id);
      resolve(msg.result ?? { ok: false, code: 'E4071', message: '宿主未返回结果' });
    }
    return;
  }

  if (msg.type === 'dispose') {
    disposed = true;
    // 停用即取消所有在途调用：不能让一个长任务拖住停用流程
    for (const [, one] of inflight) {
      try {
        one.controller.abort(Object.assign(new Error('插件已停用'), { code: 'E4070' }));
      } catch {
        /* 忽略 */
      }
    }
    try {
      if (typeof plugin?.dispose === 'function') await plugin.dispose(ctx);
    } catch (err) {
      log('warn', `释放资源失败：${String(/** @type {any} */ (err)?.message ?? err)}`);
    }
    send({ type: 'disposed' });
    return;
  }

  if (msg.type === 'shutdown') {
    process.exit(0);
  }
}

// ---- 主循环：按行切分 stdin ----
/* 同上：只有真的作为子进程入口时才接管 stdin / 进程级异常。 */
if (IS_MAIN) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log('warn', '收到无法解析的协议行（已忽略）');
        continue;
      }
      void handle(msg);
    }
  });

  // 父进程没了就跟着退出，否则会留下孤儿进程占着端口
  process.stdin.on('end', () => process.exit(0));

  process.on('uncaughtException', (err) => {
    send({ type: 'fatal', message: String(err?.message ?? err) });
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    send({ type: 'fatal', message: `未处理的 Promise 拒绝：${String(/** @type {any} */ (err)?.message ?? err)}` });
    process.exit(1);
  });
}
