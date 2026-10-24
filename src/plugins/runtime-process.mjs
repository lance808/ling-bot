/**
 * 插件运行时：独立子进程（process）
 *
 * ## 为什么默认走子进程
 *
 * 因为"一个插件坏掉不能拖垮主程序"这条要求，**在同一个进程里做不到**。
 * 同进程里插件写个死循环，后端就再也不响应 —— 连"停用这个插件"的按钮都点不动。
 *
 * 所以第三方插件一律 fork 出去：
 *   - 卡死 → 超时后 `kill`，主程序继续跑
 *   - 崩溃 → 只死子进程，宿主记一笔 `crashed`
 *   - 内存泄漏 → 重载时换一个新进程，泄漏跟着进程一起消失
 *
 * ## 但它**不是安全沙箱**（必须反复强调）
 *
 * 子进程仍以当前用户身份运行，能读你的文件、能上网。
 * 它防的是"故障扩散"，不是"恶意代码"。真正的授权边界在
 * `guard/tool-gate.mjs`（决定模型能调用什么），与这里无关。
 *
 * ## 超时为什么必须 kill 而不是"放弃等待"
 *
 * 放弃等待会把卡死的子进程留在后台：它还占着端口、占着内存，
 * 下次调用又要起一个 —— 几轮下来机器就满了。所以超时一律 kill，
 * 下一次调用重新起进程（连续失败 3 次转 `crashed`，等用户点重载）。
 *
 * ## 取消与超时是两件事（重要）
 *
 *   · **超时** = 插件没应答，进程不可信了 → kill。
 *   · **取消** = 用户点了停止 / 插件被停用 → 只通知子进程 abort，**不 kill**。
 *
 * 取消时也 kill 会带来一个荒唐现象：用户点一次「停止」，插件被当成崩溃，
 * 工具从 AI 列表里消失，还得手动重载。而它其实好好的。
 *
 * ## 子进程拿不到可信上下文（这是设计，不是限制）
 *
 * `ctx.caller` 只能由宿主给。所以子进程**不能**自己构造调用上下文：
 * 它请求宿主做事时发的是 `{type:'host-call', callId, method, args}`，
 * 宿主按**自己记下的 callId → invocation** 反查。
 *
 * 也就是说：子进程即使伪造一个 `{origin:'owner-private'}` 也没用，
 * 宿主根本不读它发来的上下文字段。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 子进程入口脚本 */
const RUNNER = path.join(HERE, 'child-runner.mjs');

/** init 超时：插件可能要连数据库/探测端口，给宽一点 */
const INIT_TIMEOUT_MS = 8000;

/** dispose 超时 */
const DISPOSE_TIMEOUT_MS = 3000;

/** 测试连接超时 */
const TEST_TIMEOUT_MS = 15000;

/** 连续失败几次后不再自动重启 */
const MAX_AUTO_RESTARTS = 3;

/** 单次 host-call 的最长等待（宿主侧还有各自的超时，这里只是兜底） */
const HOST_CALL_TIMEOUT_MS = 20000;

/**
 * 子进程运行时。
 */
export class ProcessRuntime {
  /**
   * @param {object} opts
   * @param {object} opts.manifest
   * @param {string} opts.dir
   * @param {string} opts.dataDir
   * @param {Record<string, any>} opts.config
   * @param {Record<string, string>} opts.secrets
   * @param {(level: string, message: string, fields?: object) => void} opts.log
   * @param {(convKey: string, text: string) => Promise<any>} [opts.sendText]
   * @param {(input: {pluginId: string, invocation: object, dataDir: string, signal: AbortSignal}) => object} [opts.makeChat]
   *   与 in-process 同一套工厂。子进程的 ctx.chat 是**代理**，
   *   真正的执行发生在宿主这里 —— 所以两端语义完全一致。
   * @param {(input: {pluginId: string, invocation: object, dataDir: string, signal: AbortSignal}) => object} [opts.makeGateway]
   *   网关受控能力的工厂，与 makeChat 同理：子进程拿到的是一组代理，
   *   归属会话由宿主按 callId 查表得到 —— 子进程即使自己编一个 convKey
   *   也不被读取（见 handleHostCall）。
   * @param {(input: {invocation?: object | null, signal?: AbortSignal}) => object} [opts.makeNet]
   *   联网能力工厂。子进程侧的 `ctx.net` 只是代理：真正发请求的是父进程，
   *   而**密钥从不下发**到子进程（子进程只需要知道能不能用）。
   * @param {string} [opts.nodePath] 用哪个 node 可执行文件（打包后指向内置 node.exe）
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
    this.makeChat = opts.makeChat ?? null;
    this.makeGateway = opts.makeGateway ?? null;
    this.makeNet = opts.makeNet ?? null;
    this.nodePath = opts.nodePath ?? process.execPath;

    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** 递增的消息 id */
    this.seq = 0;
    /** @type {Map<number, {resolve: (v: any) => void, timer: any}>} */
    this.pending = new Map();
    /**
     * 按消息类型等回复（`ready` / `init-error` / `disposed` 没有 id）。
     *
     * 与 `pending` 分开：那三个是"生命周期事件"，不是对某个请求编号的回答。
     */
    /** @type {Map<string, {resolve: (v: any) => void, timer: any}>} */
    this.pendingByType = new Map();
    /**
     * 在途调用 id → 受信上下文。
     *
     * 子进程发 `host-call` 时只带 callId，上下文从这里查。
     * 这样"子进程伪造 origin"在结构上不可能生效。
     *
     * @type {Map<number, {invocation: object, signal: AbortSignal}>}
     */
    this.callContexts = new Map();
    /** 未处理完的 stdout 缓冲 */
    this.buffer = '';
    /** 已就绪（init 完成） */
    this.ready = false;
    this.disposed = false;
    /** 连续失败次数：超过阈值就不再自动重启 */
    this.failures = 0;
    /** @type {{code: string, message: string} | null} */
    this.lastError = null;
  }

  get kind() {
    return 'process';
  }

  /**
   * 起子进程并 init。
   *
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
   */
  async init() {
    const started = await this.spawnChild();
    if (!started.ok) return started;

    const r = await this.request(
      {
        type: 'init',
        payload: {
          manifest: this.manifest,
          dir: this.dir,
          dataDir: this.dataDir,
          config: this.config,
          secrets: this.secrets,
          /*
           * 联网能力的**事实**（不含 Key）。
           *
           * 为什么只给四个标量：插件要在 init 里判断"要不要提示用户去填 Key"，
           * 读的就是 `ctx.net.configured`。但 Key 本身必须留在父进程 ——
           * 下发它等于把额度交给插件，它可以直接拿去调上游，而宿主
           * 完全看不到那次调用。
           */
          netFacts: this.netFacts(),
        },
      },
      INIT_TIMEOUT_MS,
      'ready',
      'init-error',
    );

    /*
     * `ready` 是"成功"信号，本身没有 ok 字段；`init-error` 才有。
     * 所以这里按 type 判定，而不是按 ok 判定 —— 否则每次初始化都会被
     * 当成失败（`{type:'ready'}.ok` 是 undefined）。
     */
    if (r?.type === 'init-error' || r?.ok === false) {
      this.kill();
      return { ok: false, code: r.code ?? 'E4064', message: r.message ?? '初始化失败' };
    }
    if (r?.type !== 'ready') {
      this.kill();
      return { ok: false, code: r?.code ?? 'E4064', message: r?.message ?? '初始化未完成' };
    }
    this.ready = true;
    this.failures = 0;
    return { ok: true };
  }

  /**
   * 起一个子进程。
   *
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
   */
  async spawnChild() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };

      let child;
      try {
        child = spawn(this.nodePath, [RUNNER], {
          cwd: this.dir,
          /*
           * stdio 全用管道：协议走 stdout，插件自己的错误输出走 stderr（进日志）。
           * 不用 inherit —— 否则插件的裸打印会直接糊到主程序的控制台上，
           * 而桌面壳把后端 stdout 当 JSON-RPC 通道用，那样会污染协议。
           */
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            // 明确告诉插件"你在子进程里"，便于它自己降级（比如不开交互式提示）
            LING_PLUGIN_ID: this.manifest.id,
            LING_PLUGIN_RUNTIME: 'process',
          },
        });
      } catch (err) {
        const e = /** @type {any} */ (err);
        done({ ok: false, code: 'E4066', message: `无法启动插件进程：${String(e?.message ?? e)}` });
        return;
      }

      this.child = child;
      this.buffer = '';
      this.ready = false;

      child.on('error', (err) => {
        this.lastError = { code: 'E4066', message: `插件进程错误：${String(err?.message ?? err)}` };
        this.rejectAll('E4066', this.lastError.message);
        done({ ok: false, code: 'E4066', message: this.lastError.message });
      });

      child.stdout?.on('data', (chunk) => this.onData(chunk));
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8').trim();
        // 插件的 stderr 就是它的错误输出，原样记进日志（界面上能看到）
        if (text) this.log('warn', text.slice(0, 2000));
      });

      child.on('exit', (code, signal) => {
        const wasReady = this.ready;
        this.ready = false;
        this.child = null;
        this.rejectAll('E4067', `插件进程已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
        this.callContexts.clear();
        if (!this.disposed && wasReady) {
          // 正常跑着突然死了 = 崩溃，让管理器把状态改成 crashed
          this.failures++;
          this.lastError = {
            code: 'E4066',
            message: `插件进程意外退出（code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}）`,
          };
          this.log('error', this.lastError.message);
        }
        done({ ok: true });
      });

      // 进程起来了就算成功（init 结果走协议）
      done({ ok: true });
    });
  }

  /**
   * stdout 按行切分。
   *
   * @param {Buffer} chunk
   */
  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    // 防御：插件如果疯狂打印，缓冲不能无限长
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.buffer = '';
      this.log('warn', '插件输出缓冲超过 4MB，已丢弃（插件可能在无节制打印）');
      return;
    }
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log('warn', `插件输出了非协议内容（已忽略）：${line.slice(0, 300)}`);
        continue;
      }
      this.onMessage(msg);
    }
  }

  /**
   * 处理子进程消息。
   *
   * @param {any} msg
   */
  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'log') {
      this.log(String(msg.level ?? 'info'), String(msg.message ?? ''), msg.fields);
      return;
    }

    if (msg.type === 'send-text') {
      // 插件请求发消息：走宿主闸门，然后把结果回给它
      void this.sendText(String(msg.convKey ?? ''), String(msg.text ?? '')).then((result) => {
        this.write({ type: 'send-text-result', id: msg.id, result });
      });
      return;
    }

    if (msg.type === 'host-call') {
      void this.handleHostCall(msg);
      return;
    }

    if (msg.type === 'fatal') {
      this.lastError = { code: 'E4066', message: String(msg.message ?? '插件崩溃') };
      this.log('error', this.lastError.message);
      return;
    }

    if (
      msg.type === 'ready' ||
      msg.type === 'init-error' ||
      msg.type === 'result' ||
      msg.type === 'disposed'
    ) {
      /*
       * 两类回复要分开找：
       *   - `result` 带 id，按 id 找（并发调用时才能对上是哪一次）
       *   - `ready` / `init-error` / `disposed` 没有 id，按类型找
       *
       * 找不到就丢弃：可能是已经超时被清掉的那个请求的迟到回复。
       */
      const byId = msg.id === undefined ? undefined : this.pending.get(msg.id);
      const byType = this.pendingByType.get(msg.type);
      const target = byId ?? byType;
      if (!target) return;

      // 一个请求可能同时登记在 id 和类型两处，两边都要清干净
      this.pending.delete(target.id);
      for (const t of target.types ?? []) this.pendingByType.delete(t);
      clearTimeout(target.timer);
      target.resolve(msg);
    }
  }

  /**
   * 处理子进程发来的宿主能力请求（目前只有 chat.*）。
   *
   * ## 上下文只能从宿主自己的表里查
   *
   * 消息里的 `invocation` / `origin` / `convKey` 一律**不读**。
   * 子进程能提供的只有"我是哪次调用"（callId），其余由宿主补全。
   * 这不是"过滤"，是"根本不看" —— 过滤总会漏一个字段。
   *
   * @param {any} msg
   */
  async handleHostCall(msg) {
    const callId = Number(msg.callId);
    const call = this.callContexts.get(callId);
    const reply = (result) => this.write({ type: 'host-call-result', id: msg.id, result });

    if (!call) {
      /*
       * 上下文查不到有三种原因，必须分开说 —— 统一报 E4074（会话归属错误）
       * 会让插件作者去查会话，而他真正遇到的是下面第 2、3 种：
       *
       *   1. 子进程伪造了一个不属于自己的 callId（或旧调用的迟到请求）；
       *   2. **调用已经结束**：取消或超时之后，父进程已经把表项删了；
       *   3. **插件正在停用**：dispose 里 kill() 会清空整张表。
       *
       * 后两种其实是"调用已取消"，报 E4070 才指向正确的排查方向。
       */
      if (this.disposed || !this.child) {
        reply({ ok: false, code: 'E4070', message: '插件已停用或进程已退出，调用已取消' });
        return;
      }
      reply({
        ok: false,
        code: 'E4071',
        message: '调用上下文不存在或已结束（这次调用已取消/超时；若持续出现请检查子进程是否自行编造 callId）',
      });
      return;
    }

    const method = String(msg.method ?? '');
    const allowed = new Set(['recent', 'message', 'mediaList', 'send', 'sendMedia', 'registerMedia']);
    /*
     * 网关方法单独一张表。
     *
     * 为什么不合并成一个白名单：这两组能力的**归属来源不同**。
     * chat 的每个方法都只作用于当前会话；gateway 里还有"账号级"动作
     * （拉收藏列表、收藏），它们的边界不是会话，而是"账号 + 插件"。
     * 混在一起会让后来的人以为所有方法都受 convKey 约束。
     */
    const gatewayAllowed = new Set(['caps', 'probe', 'listFaces', 'fetchFaceImage', 'collectFace', 'sendFace', 'vision']);

    /*
     * 联网方法单独一张表（第三组）。
     *
     * 为什么不并进 chat 或 gateway：它的**归属**又不一样 —— 它不操作会话，
     * 也不操作 QQ 账号，而是"这个插件以自己的配置去访问外网"。
     * 并进去会让后来的人以为搜索也受 convKey 约束。
     */
    const netAllowed = new Set(['search', 'fetch']);

    if (!allowed.has(method) && !gatewayAllowed.has(method) && !netAllowed.has(method)) {
      reply({ ok: false, code: 'E4071', message: `不支持的宿主能力：${method}` });
      return;
    }

    if (netAllowed.has(method)) {
      if (!this.makeNet) {
        reply({ ok: false, code: 'E4071', message: '宿主未提供联网能力' });
        return;
      }
      try {
        /*
         * 每次调用现取一份：net 的闭包里带着配置与密钥（只在父进程里），
         * 以及"本次调用"的取消信号 —— 用户点停止时那次 fetch 要能被打断。
         */
        const net = this.makeNet({ invocation: call.invocation, signal: call.signal });
        const fn = net?.[method];
        if (typeof fn !== 'function') {
          reply({ ok: false, code: 'E4071', message: `宿主能力缺失：${method}` });
          return;
        }
        try {
          const result = await fn.call(net, msg.args ?? {});
          reply(normalizeChatResult(result));
        } finally {
          // 一次代理调用结束就失效；子进程就算把代理对象留着，也只剩 E4071。
          try {
            net?.revoke?.();
          } catch {
            /* revoke 失败不影响本次结果 */
          }
        }
      } catch (err) {
        const e = /** @type {any} */ (err);
        reply({ ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) });
      }
      return;
    }

    if (gatewayAllowed.has(method)) {
      if (!this.makeGateway) {
        reply({ ok: false, code: 'E4072', message: '宿主未提供网关能力' });
        return;
      }
      try {
        const gateway = this.makeGateway({
          pluginId: this.manifest.id,
          invocation: call.invocation,
          dataDir: this.dataDir,
          signal: call.signal,
        });
        /*
         * `caps` 与 `vision` 在正常实现里是**同步属性/方法**（纯内存读）。
         * 代理侧调用它们是 `await` 的，所以这里统一包成 Promise 结果，
         * 形状仍然是 `{ok, value}` —— 子进程侧拆包时不需要分两种情况。
         */
        if (method === 'vision') {
          reply({ ok: true, value: normalizeChatResult(gateway.vision ?? null) });
          return;
        }
        if (method === 'caps') {
          reply({ ok: true, value: normalizeChatResult(gateway.caps?.() ?? null) });
          return;
        }
        const fn = gateway?.[method];
        if (typeof fn !== 'function') {
          reply({ ok: false, code: 'E4071', message: `宿主能力缺失：${method}` });
          return;
        }
        const result = await fn.call(gateway, msg.args ?? {});
        reply(normalizeChatResult(result));
      } catch (err) {
        const e = /** @type {any} */ (err);
        reply({ ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) });
      }
      return;
    }

    if (!this.makeChat) {
      reply({ ok: false, code: 'E4072', message: '宿主未提供聊天能力' });
      return;
    }

    try {
      const chat = this.makeChat({
        pluginId: this.manifest.id,
        invocation: call.invocation,
        dataDir: this.dataDir,
        signal: call.signal,
      });
      const fn = chat?.[method];
      if (typeof fn !== 'function') {
        reply({ ok: false, code: 'E4071', message: `宿主能力缺失：${method}` });
        return;
      }
      const result = await fn.call(chat, msg.args ?? {});
      reply(normalizeChatResult(result));
    } catch (err) {
      const e = /** @type {any} */ (err);
      reply({ ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) });
    }
  }

  /**
   * 给子进程写一行。
   *
   * @param {object} msg
   */
  write(msg) {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return false;
    try {
      child.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch (err) {
      this.log('warn', `写入插件进程失败：${String(/** @type {any} */ (err)?.message ?? err)}`);
      return false;
    }
  }

  /**
   * 发一个请求并等回复。
   *
   * @param {object} msg
   * @param {number} timeoutMs
   * @param {string} [expectType] 期望的"无 id"回复类型（ready / disposed）
   * @param {string} [errorType] 期望的"无 id"失败类型（init-error）
   * @param {{signal?: AbortSignal}} [opts] 取消信号
   * @returns {Promise<any>}
   */
  request(msg, timeoutMs, expectType, errorType, opts = {}) {
    return new Promise((resolve) => {
      if (!this.child) {
        resolve({ ok: false, code: 'E4067', message: '插件进程未运行' });
        return;
      }

      const id = msg.id ?? ++this.seq;
      const payload = { ...msg, id };

      /** @type {string[]} */
      const types = [expectType, errorType].filter(Boolean);

      /** 清掉这次请求在所有索引里的痕迹 */
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        for (const t of types) {
          // 只删指向自己的那条：同类型可能已被更晚的请求占用
          if (this.pendingByType.get(t) === entry) this.pendingByType.delete(t);
        }
        opts.signal?.removeEventListener?.('abort', onAbort);
      };

      /*
       * 取消：通知子进程 abort，然后**立刻**结束等待。
       *
       * 不 kill（那是超时的处理方式）：用户点停止不该让插件被标成崩溃。
       * 子进程迟到的 `result` 会因为找不到 pending 而被丢弃，无害。
       */
      const onAbort = () => {
        cleanup();
        this.write({ type: 'cancel', id });
        resolve({ ok: false, code: 'E4070', message: '调用已取消' });
      };

      const timer = setTimeout(() => {
        cleanup();
        // 父进程代发的 HTTP 请求不在子进程内，kill 之前必须先中止它的信号。
        opts.onTimeout?.();
        /*
         * 超时一律 kill：放弃等待会把卡死的进程留在后台占端口/占内存，
         * 下一次调用再起一个，几轮下来机器就满了。
         */
        this.kill();
        resolve({ ok: false, code: 'E4065', message: `插件响应超时（${timeoutMs}ms）` });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const entry = { id, types, resolve, timer };
      this.pending.set(id, entry);
      for (const t of types) this.pendingByType.set(t, entry);

      if (opts.signal) {
        if (opts.signal.aborted) {
          cleanup();
          resolve({ ok: false, code: 'E4070', message: '调用已取消' });
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (!this.write(payload)) {
        cleanup();
        resolve({ ok: false, code: 'E4067', message: '插件进程不可写' });
      }
    });
  }

  /**
   * 把还在等的请求全部拒掉（进程退出时）。
   *
   * @param {string} code
   * @param {string} message
   */
  rejectAll(code, message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code, message });
    }
    this.pending.clear();
    for (const [, entry] of this.pendingByType) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code, message });
    }
    this.pendingByType.clear();
  }

  /**
   * 杀子进程。
   */
  kill() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.callContexts.clear();
    if (!child) return;
    try {
      child.kill();
    } catch {
      /* 已经死了 */
    }
  }

  /**
   * 执行工具。
   *
   * @param {{tool: string, args: object, timeoutMs: number, invocation?: object, signal?: AbortSignal}} input
   * @returns {Promise<{ok: boolean, value?: any, code?: string, message?: string}>}
   */
  async callTool({ tool, args, timeoutMs, invocation, signal }) {
    if (this.disposed) return { ok: false, code: 'E4067', message: '插件已停用' };
    if (signal?.aborted) return { ok: false, code: 'E4070', message: '调用已取消' };

    // 进程死了就试着重起一次（用户没点重载，但也没到崩溃阈值）
    if (!this.child) {
      if (this.failures >= MAX_AUTO_RESTARTS) {
        return { ok: false, code: 'E4067', message: '插件进程已崩溃，请在插件页点「重载」' };
      }
      const restarted = await this.init();
      if (!restarted.ok) return restarted;
    }

    const id = ++this.seq;
    /*
     * 先登记上下文，再发消息。
     *
     * 顺序不能反：子进程可能在收到 call 的**同一轮**里就发 host-call 回来，
     * 那时如果上下文还没进表，它会收到"上下文不存在"—— 表现为
     * "插件有时能发图有时不能"，取决于时序。
     */
    const callController = new AbortController();
    const abortCall = () => callController.abort(signal?.reason);
    if (signal?.aborted) abortCall();
    else signal?.addEventListener('abort', abortCall, { once: true });
    this.callContexts.set(id, {
      invocation: invocation ?? {},
      signal: callController.signal,
    });
    let timedOut = false;
    const callTimer = setTimeout(() => {
      timedOut = true;
      callController.abort(Object.assign(new Error('工具执行超时'), { code: 'E4065' }));
    }, Math.max(1, timeoutMs));

    try {
      const r = await this.request(
        {
          type: 'call',
          /*
           * id 必须**显式传**。
           *
           * request() 在没收到 id 时会自己 `++this.seq` 拿一个新号，
           * 于是 callContexts 里登记的是 A、实际请求是 B：
           * 子进程发 host-call 带回来的是 B，父进程查不到 →
           * 所有聊天能力都报"上下文不存在或已结束"。
           */
          id,
          tool,
          args: args ?? {},
          timeoutMs,
          /*
           * invocation 必须随 call 一起下发。
           *
           * 子进程不能自己构造它（那等于让它自封权限），但**必须**能看到它 ——
           * 否则 ctx.caller 恒为 null，插件就没法知道"这次调用在哪个会话"。
           * 这一行是"上下文由宿主生成、传给插件"在子进程侧的落点。
           */
          invocation: invocation ?? null,
          /*
           * 联网事实随每次调用下发（不是只在 init 里给一次）。
           *
           * 用户可能刚点完「关闭联网」，而下一次调用立刻就来了。
           * 只在 init 下发的话，子进程拿着旧的 `enabled: true` 去写
           * "提前短路"的判断 —— 它仍会发 host-call，父进程也会拒绝，
           * 但插件侧看到的是一份过期事实，日志会自相矛盾。
           */
          netFacts: this.netFacts(),
        },
        timeoutMs + 2000,
        undefined,
        undefined,
        {
          signal: callController.signal,
          onTimeout: () => callController.abort(Object.assign(new Error('工具执行超时'), { code: 'E4065' })),
        },
      );

      if (timedOut) {
        this.kill();
        this.failures++;
        return { ok: false, code: 'E4065', message: `工具执行超时（${timeoutMs}ms）` };
      }
      if (r.ok === true) return { ok: true, value: r.value ?? null };

      if (r.code === 'E4065') this.failures++;
      else if (r.code === 'E4066') this.failures++;
      else this.failures = 0;

      /*
       * 取消**不**计入崩溃次数。
       *
       * 计入的话，用户在群里连点几次停止就能把一个正常插件推到
       * MAX_AUTO_RESTARTS，之后它再也不会自动重启 —— 看起来像"越用越坏"。
       */
      return { ok: false, code: r.code ?? 'E4066', message: r.message ?? '工具执行失败' };
    } finally {
      clearTimeout(callTimer);
      signal?.removeEventListener('abort', abortCall);
      // 调用结束后不能继续使用捕获的宿主联网能力。
      callController.abort();
      this.callContexts.delete(id);
    }
  }

  /**
   * 联网能力的**事实**（四个标量，不含 Key）。
   *
   * ## 为什么是"事实"而不是"能力对象"
   *
   * 子进程需要的只有"能不能用"：总闸开没开、配好了没、用的哪家。
   * 真正的请求必须由父进程发 —— 只有那里才有密钥，也只有那里能在
   * 用户点「关闭联网」时把在途请求一起掐掉。
   *
   * 反过来说：把密钥下发到子进程，等于把额度交给插件，它可以直接
   * 拿去调上游，而宿主对那次调用完全不可见。
   *
   * 装配失败也要返回一份"不可用"的事实：init 不能因为联网没接好而失败
   * （插件可能还有别的能力）。
   *
   * @returns {{available: boolean, enabled: boolean, provider: string, configured: boolean}}
   */
  netFacts() {
    if (!this.makeNet) return { available: false, enabled: false, provider: '', configured: false };
    try {
      const one = this.makeNet({ invocation: null, allowRequests: false });
      return {
        available: one?.available === true,
        enabled: one?.enabled === true,
        provider: String(one?.provider ?? ''),
        configured: one?.configured === true,
      };
    } catch {
      return { available: false, enabled: false, provider: '', configured: false };
    }
  }

  /**
   * 测试连接。
   *
   * @returns {Promise<{ok: boolean, message?: string, details?: object, code?: string}>}
   */
  async testConnection() {
    if (!this.child) {
      const restarted = await this.init();
      if (!restarted.ok) return restarted;
    }
    const r = await this.request({ type: 'test' }, TEST_TIMEOUT_MS);
    return {
      ok: r.ok === true,
      message: r.message ?? (r.ok === true ? '连接正常' : '测试失败'),
      details: r.details,
      code: r.code,
    };
  }

  /**
   * 停用：先请它自己收拾，再杀。
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.child) return;

    // 给它一个体面退场的机会（关端口、落盘），超时就强杀
    const r = await this.request({ type: 'dispose' }, DISPOSE_TIMEOUT_MS, 'disposed');
    if (r.ok === false) {
      this.log('warn', `插件未能正常释放资源：${r.message ?? r.code ?? '未知'}`);
    }
    this.write({ type: 'shutdown' });
    // 稍等它自己退，退不掉就 kill
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.kill();
    this.rejectAll('E4067', '插件已停用');
    this.callContexts.clear();
  }
}

/**
 * host-call 结果必须是可序列化的普通对象。
 *
 * 参数里可能带 AbortSignal 之类的东西（比如某个 chat 方法把入参原样回传），
 * 这里统一过一遍 JSON，顺便把 `undefined` 变成 null —— 否则子进程那边
 * `result === undefined` 会走进"宿主未返回结果"的分支，报一个看不懂的错。
 *
 * @param {unknown} value
 * @returns {object}
 */
function normalizeChatResult(value) {
  if (value === undefined) return { ok: false, code: 'E4071', message: '宿主能力未返回结果' };
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { ok: false, code: 'E4071', message: '宿主能力返回值无法序列化' };
  }
}

export { HOST_CALL_TIMEOUT_MS };
