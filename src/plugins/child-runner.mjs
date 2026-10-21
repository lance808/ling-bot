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
 *   { "type": "call", "id": 1, "tool": "echo", "args": {...}, "timeoutMs": 20000 }
 *   { "type": "test", "id": 2 }
 *   { "type": "dispose" }
 *   { "type": "send-text-result", "id": 7, "result": {...} }
 *   { "type": "shutdown" }
 *
 * 子 → 父：
 *   { "type": "ready" } | { "type": "init-error", "code", "message" }
 *   { "type": "result", "id": 1, "ok": true, "value": ... }
 *   { "type": "result", "id": 1, "ok": false, "code": "E4066", "message": "..." }
 *   { "type": "log", "level": "info", "message": "...", "fields": {...} }
 *   { "type": "send-text", "id": 7, "convKey": "...", "text": "..." }
 *   { "type": "fatal", "message": "..." }
 *
 * ## 为什么要把 console 接管掉
 *
 * 插件作者很自然会写 `console.log(...)`。而 stdout 就是协议通道 ——
 * 一行裸日志会让父进程的 JSON.parse 失败，症状是"插件随机不响应"。
 * 所以这里把 console.* 全部重定向成 `log` 消息：插件不用学新 API，
 * 协议也不会被打断。
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

/** @type {any} */
let plugin = null;
/** @type {any} */
let ctx = null;
let disposed = false;

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

/**
 * 从父进程请求一次发送（走宿主闸门）。
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
        secrets: payload.secrets ?? {},
        dataDir: payload.dataDir,
        // 子进程里没有"宿主整体停用"的信号源，用一个空 signal 占位，
        // 真正的强杀由父进程 kill 完成
        signal: new AbortController().signal,
        log: (level, message, fields) => log(level, message, fields),
        sendText: (convKey, text) => requestSendText(String(convKey), String(text)),
      };

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
    try {
      const value = await plugin.callTool({
        tool: msg.tool,
        args: msg.args ?? {},
        ctx,
        signal: ctx.signal,
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
      send({ type: 'result', id, ok: false, code: 'E4066', message: String(e?.message ?? e) });
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

  if (msg.type === 'dispose') {
    disposed = true;
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
