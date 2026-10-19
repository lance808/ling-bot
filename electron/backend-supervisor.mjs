/**
 * 后端守护 —— F1
 *
 * 职责：
 *   - fork 后端，通过 stdio JSON-RPC 通信
 *   - 崩溃退避重启（1s → 2s → 4s → 8s，封顶 30s）
 *   - 连续 5 次失败后停止并显示「需人工介入」，避免无限重启刷日志
 *   - 「重启后端」是一等动作，不关窗口
 */

import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 30_000];
const MAX_CONSECUTIVE_FAILURES = 5;

export class BackendSupervisor extends EventEmitter {
  /**
   * @param {{backendPath: string, userDataDir: string, env?: Record<string,string>}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    this.seq = 0;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.failures = 0;
    this.givenUp = false;
    /** @type {string[]} */
    this.stderrTail = [];
    this.restartTimer = null;
    this.stopping = false;
  }

  start() {
    if (this.child) return;
    this.stopping = false;

    const child = fork(this.opts.backendPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        LING_USER_DATA: this.opts.userDataDir,
        ...this.opts.env,
      },
    });
    this.child = child;

    const out = readline.createInterface({ input: child.stdout });
    out.on('line', (line) => this.#onLine(line));

    const err = readline.createInterface({ input: child.stderr });
    err.on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 100) this.stderrTail.shift();
      this.emit('stderr', line);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`后端已退出（code=${code} signal=${signal}）`));
      }
      this.pending.clear();

      if (this.stopping) {
        this.emit('stopped', { code, signal });
        return;
      }
      this.#handleCrash(code, signal);
    });

    child.on('error', (e) => this.emit('stderr', `spawn error: ${e.message}`));
    this.emit('started', { pid: child.pid });
  }

  /** @param {number|null} code @param {string|null} signal */
  #handleCrash(code, signal) {
    this.failures += 1;
    this.emit('crashed', { code, signal, failures: this.failures, stderrTail: [...this.stderrTail] });

    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.givenUp = true;
      this.emit('gave-up', {
        failures: this.failures,
        stderrTail: [...this.stderrTail],
        message: '后端连续多次启动失败，已停止自动重启，需要人工介入',
      });
      return;
    }

    const delay = BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.emit('will-restart', { delayMs: delay, attempt: this.failures });
  }

  /** @param {string} line */
  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('log', line);
      return;
    }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method === 'event') {
      if (msg.params?.event === 'ready') this.failures = 0;
      this.emit('event', msg.params);
    }
  }

  /**
   * @param {string} method
   * @param {any} params
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(method, params, timeoutMs = 15_000) {
    if (!this.child) return Promise.reject(new Error('后端未运行'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`后端未在 ${timeoutMs}ms 内响应 ${method}`), { code: 'E1030' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  restart() {
    this.failures = 0;
    this.givenUp = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.stopping = false;
      this.child.once('exit', () => this.start());
      this.child.kill();
    } else {
      this.start();
    }
    this.emit('restarting');
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.kill();
  }
}
