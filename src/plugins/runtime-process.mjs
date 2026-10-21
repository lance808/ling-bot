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
   * @param {string} [opts.nodePath] 用哪个 node 可执行文件（打包后指向内置 node.exe）
   */
  constructor(opts) {
    this.manifest = opts.manifest;
    this.dir = opts.dir;
    this.dataDir = opts.dataDir;
    this.config = opts.config;
    this.secrets = opts.secrets;
    this.log = opts.log;
    this.sendText = opts.sendText ?? (async () => ({ ok: false, message: '宿主未提供发送能力' }));
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
      { type: 'init', payload: { manifest: this.manifest, dir: this.dir, dataDir: this.dataDir, config: this.config, secrets: this.secrets } },
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

    if (msg.type === 'fatal') {
      this.lastError = { code: 'E4066', message: String(msg.message ?? '插件崩溃') };
      this.log('error', this.lastError.message);
      return;
    }

    if (msg.type === 'ready' || msg.type === 'init-error' || msg.type === 'result' || msg.type === 'disposed') {
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
   * @returns {Promise<any>}
   */
  request(msg, timeoutMs, expectType, errorType) {
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
      };

      const timer = setTimeout(() => {
        cleanup();
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
   * @param {{tool: string, args: object, timeoutMs: number}} input
   * @returns {Promise<{ok: boolean, value?: any, code?: string, message?: string}>}
   */
  async callTool({ tool, args, timeoutMs }) {
    if (this.disposed) return { ok: false, code: 'E4067', message: '插件已停用' };

    // 进程死了就试着重起一次（用户没点重载，但也没到崩溃阈值）
    if (!this.child) {
      if (this.failures >= MAX_AUTO_RESTARTS) {
        return { ok: false, code: 'E4067', message: '插件进程已崩溃，请在插件页点「重载」' };
      }
      const restarted = await this.init();
      if (!restarted.ok) return restarted;
    }

    const r = await this.request({ type: 'call', tool, args: args ?? {}, timeoutMs }, timeoutMs + 2000);
    if (r.ok === true) return { ok: true, value: r.value ?? null };
    if (r.code === 'E4065') this.failures++;
    else if (r.code === 'E4066') this.failures++;
    else this.failures = 0;
    return { ok: false, code: r.code ?? 'E4066', message: r.message ?? '工具执行失败' };
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
  }
}
