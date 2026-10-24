/**
 * 受限 HTTP 文本抓取 —— 联网能力的**唯一**出站实现（除搜索 API 外）
 *
 * ## 为什么不直接用 `fetch()`
 *
 * `fetch()` 自动跟随重定向，于是"下一跳去哪"由对端决定。一个公网 URL 可以
 * 302 到 `http://127.0.0.1:3458/`（本机的 DSH 桥）或 `http://192.168.1.1/`，
 * 而第一跳的形状校验完全通过 —— 这就是最经典的 SSRF 形状。
 *
 * 所以这里自己做三件事：
 *   1. 每一跳都重新跑 URL 形状 + DNS 全量解析 + 私网判定；
 *   2. 连**已校验的 IP**，只把域名放进 Host 与 TLS SNI（防 DNS rebinding 的第二次解析）；
 *   3. 自己控制"DNS + 连接 + 响应头 + 响应体"的总时限（socket idle timeout
 *      拦不住每 100ms 发一个字节的慢速滴流）。
 *
 * ## 复用而不是重写判定
 *
 * URL 形状与 DNS 安全解析已经在 `src/llm/image-fetch.mjs` 里被审计过一遍
 * （`validateUrlShape` / `resolveSafeHost`）。这里**直接 import 它们**，
 * 不复制一份 —— 两份判定必然漂移，而漂移的那一份就是漏洞。
 *
 * ## 本地路径根本不存在这条通路
 *
 * 这个模块只接受 `http:` / `https:`。没有 `file://`、没有盘符、没有 UNC：
 * 不是"拦住了"，是**没有那个分支**。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import zlib from 'node:zlib';

import { validateUrlShape, resolveSafeHost } from '../llm/image-fetch.mjs';
import { NET_CODE } from './gate.mjs';

/** 重定向最多跟几跳 */
const MAX_REDIRECTS = 4;

/** 网页 URL 的字符上限（与工具声明、搜索侧口径一致） */
const MAX_URL_CHARS = 2048;

/** 允许的端口：只认标准端口，避免把任意服务端口当成网页 */
const ALLOWED_PORTS = new Set(['80', '443']);

/** 会把我们带到别处的状态码（303 也按 GET 处理 —— 这里本来就只发 GET） */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 常见的压缩编码（很多站点会无条件 gzip，哪怕我们没要） */
const DECODERS = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};

/** 允许的正文类型（白名单，不是黑名单） */
export const ALLOWED_CONTENT_TYPES = Object.freeze([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/ld+json',
]);

/** 单次抓取的默认上限 */
const DEFAULT_MAX_BYTES = 200 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 50_000;

/** 上限的硬边界（配置层也按这个夹，见 src/config/schema.mjs） */
export const FETCH_LIMITS = Object.freeze({
  maxBytesMin: 1024,
  maxBytesMax: 1024 * 1024,
  timeoutMsMin: 1000,
  timeoutMsMax: 30_000,
});

/**
 * 带码错误。
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function netErr(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 取 Content-Type 的主类型（去掉 `; charset=…`）。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function contentTypeOf(raw) {
  if (typeof raw !== 'string' || /[\r\n]/.test(raw)) return '';
  const type = raw.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : '';
}

/**
 * 这个类型能不能当正文读。
 *
 * @param {string} contentType
 * @returns {boolean}
 */
export function isAllowedContentType(contentType) {
  return ALLOWED_CONTENT_TYPES.includes(contentTypeOf(contentType));
}

/**
 * 把 HTML 降级成纯文本。
 *
 * ## 为什么这是"尽力而为"而不是解析器
 *
 * 我们不引第三方 HTML 解析库（本项目至今零运行时依赖，这是有意的）。
 * 但这里的输出**只会作为不可信数据交给模型**，不会被我们当结构用，
 * 所以"删标签 + 解实体 + 压空白"足够，且不存在"解析歧义导致的越权"。
 *
 * 三条纪律：
 *   · 先删 `<script>` / `<style>` / `<noscript>` 整块（它们的正文不是内容）；
 *   · 再删注释；
 *   · 最后删剩余标签、解实体、压空白。
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // 块级标签换成换行：否则整页会被压成一行，模型读起来像乱码
  s = s.replace(/<\/?(?:p|div|section|article|header|footer|li|tr|h[1-6]|br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解 HTML 实体。
 *
 * 只解常见的那十来个 + 数字实体：解全部实体需要完整表，而这里的目标是
 * "让正文可读"，不是"还原字节"。未知实体原样保留 —— 静默删掉会比
 * 留一个 `&foo;` 更难查（用户会以为原文就缺这段）。
 *
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    ldquo: '“',
    rdquo: '”',
    lsquo: '‘',
    rsquo: '’',
    middot: '·',
    copy: '©',
    reg: '®',
    trade: '™',
    times: '×',
    divide: '÷',
    deg: '°',
  };
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code, all) : all;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code, all) : all;
    }
    const hit = named[body.toLowerCase()];
    return hit === undefined ? all : hit;
  });
}

/**
 * @param {number} code
 * @param {string} fallback
 * @returns {string}
 */
function safeFromCodePoint(code, fallback) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * 发一跳请求（连已校验的 IP）。
 *
 * 这一层**不做**安全判定：调用方必须已经把 URL 与 IP 校验过。
 * 它只负责：限量、限时、解压、返回状态码与头部。
 *
 * @param {object} input
 * @param {URL} input.url
 * @param {string} input.ip 已校验的 IP
 * @param {number} input.maxBytes
 * @param {number} input.timeoutMs 这一跳还能用多久
 * @param {AbortSignal} [input.signal]
 * @param {string} [input.accept]
 * @param {string} [input.userAgent]
 * @param {(input: object) => Promise<any>} [input.requestOnce] 测试接缝
 * @returns {Promise<{statusCode: number, headers: Record<string, any>, buffer: Buffer, truncated: boolean, contentType: string}>}
 */
export async function requestOnce(input) {
  if (typeof input.requestOnce === 'function') {
    // 测试接缝：SSRF 判定仍由调用方负责（与 image-fetch 的口径一致）
    return input.requestOnce(input);
  }
  return defaultRequestOnce(input);
}

/**
 * 默认传输实现。
 *
 * @param {any} input
 * @returns {Promise<{statusCode: number, headers: Record<string, any>, buffer: Buffer, truncated: boolean, contentType: string}>}
 */
function defaultRequestOnce(input) {
  const { url, ip, maxBytes, timeoutMs, signal } = input;
  const accept = input.accept
    ?? 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1';
  const userAgent = input.userAgent ?? 'Ling-bot/web-search (+https://github.com/ling-bot)';
  const wireLimit = Math.max(1, Number(maxBytes) || 1);
  const decodedLimit = Math.max(1, Number(maxBytes) || 1);

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {import('node:http').ClientRequest | null} */
    let req = null;
    /** @type {import('node:http').IncomingMessage | null} */
    let res = null;
    /** @type {any} */
    let stream = null;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };

    /**
     * 所有结束路径都销毁三层对象。
     *
     * 只 destroy 解压流是不够的：底层 `res` 与 socket 仍在读，对端可以继续
     * 把几十兆字节倒进来，而我们只是不再看它 —— 那既不省带宽，也不真正
     * "停止下载"。
     */
    const destroyAll = () => {
      try {
        stream?.destroy?.();
      } catch {
        /* 已销毁 */
      }
      try {
        res?.destroy?.();
      } catch {
        /* 已销毁 */
      }
      try {
        req?.destroy?.();
      } catch {
        /* 已销毁 */
      }
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      destroyAll();
      if (error) reject(error);
      else resolve(result);
    };

    const onAbort = () => finish(netErr(NET_CODE.CANCELLED, '请求已取消'));

    const timer = setTimeout(() => {
      finish(netErr(NET_CODE.TIMEOUT, `请求超时：${url.hostname}`));
    }, Math.max(1, timeoutMs));
    timer.unref?.();

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    try {
      req = mod.request(
        {
          // 连 IP：域名再解析一次就可能变成 127.0.0.1（DNS rebinding）
          hostname: ip,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            host: url.host,
            'user-agent': userAgent,
            accept,
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
            // 不带 cookie、不带 authorization、不带 referer：
            // 我们从没有"登录态"，带上它们等于把本机信息发给对端
            connection: 'close',
          },
          // SNI 必须是原域名：直连 IP 时拿 IP 当 SNI，证书校验必然失败
          servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
          rejectUnauthorized: url.protocol === 'https:',
        },
        (response) => {
          res = response;
          response.on('error', (error) => finish(netErr(NET_CODE.UPSTREAM, `读取响应失败：${messageOf(error)}`)));
          response.on('aborted', () => finish(netErr(NET_CODE.UPSTREAM, '响应体读取中断')));
          response.on('close', () => {
            if (!response.complete && !settled) finish(netErr(NET_CODE.UPSTREAM, '响应体读取中断'));
          });
          if (settled) {
            response.destroy();
            return;
          }

          const headers = /** @type {Record<string, any>} */ (response.headers);
          const statusCode = Number(response.statusCode) || 0;
          const contentType = contentTypeOf(headers['content-type']);

          // 重定向：只取 Location，正文直接丢（对端能用无限正文拖住我们）
          if (REDIRECT_STATUSES.has(statusCode)) {
            finish(null, { statusCode, headers, buffer: Buffer.alloc(0), truncated: false, contentType });
            return;
          }

          // 非 2xx：不读正文（错误正文可能又大又没意义），交给调用方按状态码分类
          if (statusCode < 200 || statusCode >= 300) {
            finish(null, { statusCode, headers, buffer: Buffer.alloc(0), truncated: false, contentType });
            return;
          }

          /*
           * 头部一到就判类型，**不先下载再说**。
           *
           * 旧实现在读完正文之后才检查 Content-Type，那等于对端已经用
           * 一个 octet-stream 把 1MB 灌进来；而且缺失类型时被猜成 HTML，
           * 让二进制被当文本解码后交给模型。
           */
          if (!contentType || !isAllowedContentType(contentType)) {
            finish(netErr(
              NET_CODE.CONTENT,
              contentType
                ? `不支持的内容类型：${contentType}（只接受 ${ALLOWED_CONTENT_TYPES.join(' / ')}）`
                : '响应缺少合法的 Content-Type，不能当作可读正文',
            ));
            return;
          }

          const encoding = parseContentEncoding(headers['content-encoding']);
          if (!encoding.ok) {
            finish(netErr(NET_CODE.CONTENT, encoding.message));
            return;
          }

          const makeDecoder = encoding.name
            ? DECODERS[/** @type {keyof typeof DECODERS} */ (encoding.name)]
            : null;
          stream = makeDecoder ? response.pipe(makeDecoder()) : response;

          /** @type {Buffer[]} */
          const chunks = [];
          let decodedBytes = 0;
          let wireBytes = 0;
          let truncated = false;

          const emit = (extraTruncated) => {
            finish(null, {
              statusCode,
              headers,
              buffer: Buffer.concat(chunks),
              truncated: truncated || extraTruncated === true,
              contentType,
            });
          };

          /*
           * 压缩前的字节也计数。
           *
           * 只限制解压后的体积，意味着对端可以持续发送高压缩比数据流：
           * 解压后还没到上限，但 socket 已经收了几十兆 —— 带宽与内存
           * 都由我们承担。两个上限必须同时存在。
           */
          response.on('data', (chunk) => {
            if (settled) return;
            wireBytes += chunk.length;
            if (wireBytes > wireLimit) {
              truncated = true;
              emit(true);
            }
          });

          if (makeDecoder) {
            stream.on('error', () => finish(netErr(NET_CODE.CONTENT, '解压响应失败（内容编码与正文不符）')));
          }

          stream.on('data', (chunk) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const room = decodedLimit - decodedBytes;
            if (buf.length >= room) {
              if (room > 0) chunks.push(buf.subarray(0, room));
              decodedBytes = decodedLimit;
              truncated = true;
              emit(true);
              return;
            }
            chunks.push(buf);
            decodedBytes += buf.length;
          });
          stream.on('end', () => {
            if (!settled) emit(false);
          });
        },
      );
      req.on('error', (error) => finish(netErr(NET_CODE.UPSTREAM, `请求失败：${messageOf(error)}`)));
      req.end();
    } catch (error) {
      finish(netErr(NET_CODE.UPSTREAM, `请求失败：${messageOf(error)}`));
    }
  });
}

/**
 * 解析 Content-Encoding。
 *
 * 只接受空/identity 与四种单值编码。多重编码（`gzip, br`）与未知值一律
 * 拒绝：我们无法保证按正确顺序解码，猜错的结果是把压缩流当正文交给模型。
 *
 * @param {unknown} raw
 * @returns {{ok: true, name: string} | {ok: false, message: string}}
 */
export function parseContentEncoding(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'identity') return { ok: true, name: '' };
  if (s.includes(',')) {
    return { ok: false, message: `不支持多重 Content-Encoding：${s.slice(0, 80)}` };
  }
  if (!Object.hasOwn(DECODERS, s)) {
    return { ok: false, message: `不支持的 Content-Encoding：${s.slice(0, 80)}` };
  }
  return { ok: true, name: s };
}

/**
 * 校验网页 URL 的额外形状（长度与端口）。
 *
 * `validateUrlShape` 管协议、凭据与私网字面量；这里补两个**抓取特有**的
 * 限制：URL 不能无限长（会进日志/错误消息），端口只能是 80/443
 * （否则一个公网域名 + 任意端口就能扫对端服务）。
 *
 * @param {URL} url
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkFetchUrlShape(url) {
  if (url.toString().length > MAX_URL_CHARS) {
    return { ok: false, message: `网址超过 ${MAX_URL_CHARS} 字符上限` };
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (!ALLOWED_PORTS.has(port)) {
    return { ok: false, message: `只允许 80/443 端口（收到 ${port}）` };
  }
  return { ok: true };
}

/**
 * 让一个 Promise 受总时限与取消信号约束。
 *
 * 用在 DNS 解析这种"自己不接受 signal"的异步步骤上。超时/取消后
 * **不再继续**后续步骤 —— 否则晚到的解析结果会让我们在用户已经取消之后
 * 仍然发出请求（交接文档 C 的原始缺陷）。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {{signal?: AbortSignal, deadline?: number, now?: () => number, timeoutMessage?: string}} opts
 * @returns {Promise<T>}
 */
export function awaitWithinBudget(promise, opts = {}) {
  const signal = opts.signal;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const deadline = Number(opts.deadline);
  const timeoutMessage = String(opts.timeoutMessage ?? '操作超时');

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {any} */
    let timer = null;

    const done = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn();
    };
    const onAbort = () => done(() => reject(Object.assign(new Error('操作已取消'), { code: NET_CODE.CANCELLED })));

    if (Number.isFinite(deadline)) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        done(() => reject(Object.assign(new Error(timeoutMessage), { code: NET_CODE.TIMEOUT })));
        return;
      }
      timer = setTimeout(() => {
        done(() => reject(Object.assign(new Error(timeoutMessage), { code: NET_CODE.TIMEOUT })));
      }, remaining);
      timer.unref?.();
    }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    Promise.resolve(promise).then(
      (value) => done(() => resolve(value)),
      (error) => done(() => reject(error)),
    );
  });
}

/**
 * 抓一个网页的正文文本。
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxChars] 返回文本的字符上限（在字节上限之后再加一道）
 * @param {AbortSignal} [opts.signal]
 * @param {() => number} [opts.now]
 * @param {(hostname: string) => Promise<string[]>} [opts.resolveHost] 测试接缝
 * @param {(input: object) => Promise<any>} [opts.requestOnce] 测试接缝
 * @param {string} [opts.userAgent]
 * @returns {Promise<{
 *   ok: true,
 *   url: string,
 *   finalUrl: string,
 *   status: number,
 *   contentType: string,
 *   truncated: boolean,
 *   text: string,
 *   bytes: number,
 *   redirects: number,
 * } | { ok: false, code: string, message: string }>}
 */
export async function fetchText(rawUrl, opts = {}) {
  const maxBytes = clampInt(opts.maxBytes, DEFAULT_MAX_BYTES, FETCH_LIMITS.maxBytesMin, FETCH_LIMITS.maxBytesMax);
  const timeoutMs = clampInt(
    opts.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    FETCH_LIMITS.timeoutMsMin,
    FETCH_LIMITS.timeoutMsMax,
  );
  /*
   * 工具说明写的是 200–50000 字符，默认 20000。
   *
   * 旧实现上限 200000，比工具描述大四倍：模型按描述要 50000 会拿到更多，
   * 而"描述与实现不一致"本身就是一种误导。这里以工具声明为准。
   */
  const maxChars = clampInt(opts.maxChars, DEFAULT_MAX_CHARS, 200, MAX_MAX_CHARS);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const deadline = now() + timeoutMs;
  const signal = opts.signal;
  const original = String(rawUrl ?? '');

  let current = original;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (signal?.aborted) return { ok: false, code: NET_CODE.CANCELLED, message: '抓取已取消' };
    if (now() >= deadline) return { ok: false, code: NET_CODE.TIMEOUT, message: `抓取超时（${timeoutMs}ms）` };
    if (current.length > MAX_URL_CHARS) {
      return { ok: false, code: NET_CODE.URL_REJECTED, message: `网址超过 ${MAX_URL_CHARS} 字符上限` };
    }

    // 每一跳都重新跑形状校验：只有首跳拦等于没拦
    const shape = validateUrlShape(current);
    if (!shape.ok) return { ok: false, code: NET_CODE.URL_REJECTED, message: shape.reason };

    // 抓取特有的形状限制：长度与端口
    const extra = checkFetchUrlShape(shape.url);
    if (!extra.ok) return { ok: false, code: NET_CODE.URL_REJECTED, message: extra.message };

    let ip;
    try {
      /*
       * DNS 本身不接受 signal，所以必须包一层总预算。
       *
       * 旧实现直接 await，用户点取消后解析仍可能晚几秒返回，然后代码继续
       * 发请求 —— 结果是"取消了还是在联网"。这里超时/取消后立刻返回，
       * 晚到的解析结果被丢弃。
       */
      ip = await awaitWithinBudget(resolveSafeHost(shape.url.hostname, opts.resolveHost), {
        signal,
        deadline,
        now,
        timeoutMessage: `解析域名超时：${shape.url.hostname}`,
      });
    } catch (error) {
      if (error?.code === NET_CODE.CANCELLED) {
        return { ok: false, code: NET_CODE.CANCELLED, message: '抓取已取消' };
      }
      if (error?.code === NET_CODE.TIMEOUT || error?.code === 'E3109') {
        return { ok: false, code: NET_CODE.TIMEOUT, message: messageOf(error) };
      }
      // E3104 = 解析到内网/本机地址，是被策略拒绝，不是"取不到"
      const rejected = error?.code === 'E3104';
      return {
        ok: false,
        code: rejected ? NET_CODE.URL_REJECTED : NET_CODE.UPSTREAM,
        message: messageOf(error),
      };
    }

    // 解析期间可能被取消（晚到的结果不能继续发请求）
    if (signal?.aborted) return { ok: false, code: NET_CODE.CANCELLED, message: '抓取已取消' };

    const remaining = deadline - now();
    if (remaining <= 0) {
      return { ok: false, code: NET_CODE.TIMEOUT, message: `抓取超时（${timeoutMs}ms）` };
    }

    let res;
    try {
      res = await requestOnce({
        url: shape.url,
        ip,
        maxBytes,
        timeoutMs: remaining,
        signal,
        accept: opts.accept,
        userAgent: opts.userAgent,
        requestOnce: opts.requestOnce,
      });
    } catch (error) {
      return { ok: false, code: pickCode(error), message: messageOf(error) };
    }

    if (signal?.aborted) return { ok: false, code: NET_CODE.CANCELLED, message: '抓取已取消' };

    const status = Number(res?.statusCode) || 0;
    if (REDIRECT_STATUSES.has(status)) {
      const location = String(res?.headers?.location ?? '');
      if (!location) {
        return { ok: false, code: NET_CODE.UPSTREAM, message: `重定向缺少 Location（HTTP ${status}）` };
      }
      try {
        current = new URL(location, shape.url).toString();
      } catch {
        return { ok: false, code: NET_CODE.URL_REJECTED, message: '重定向目标地址非法' };
      }
      continue;
    }

    if (status < 200 || status >= 300) {
      return { ok: false, code: NET_CODE.UPSTREAM, message: `抓取失败：HTTP ${status}` };
    }

    const contentType = contentTypeOf(res?.contentType ?? res?.headers?.['content-type'] ?? '');
    /*
     * 缺失 Content-Type 也拒绝，不再"猜 HTML"。
     *
     * 猜的代价很具体：一个二进制/压缩包响应没有类型时会被当 HTML 解码，
     * 几十万字节的乱码进入提示词，模型把它当正文。宁可明确说"这不是可读正文"。
     */
    if (!contentType) {
      return {
        ok: false,
        code: NET_CODE.CONTENT,
        message: '响应缺少合法的 Content-Type，不能当作可读正文',
      };
    }
    if (!isAllowedContentType(contentType)) {
      return {
        ok: false,
        code: NET_CODE.CONTENT,
        message: `不支持的内容类型：${contentType}（只接受 ${ALLOWED_CONTENT_TYPES.join(' / ')}）`,
      };
    }
    const effectiveType = contentType;

    const buf = Buffer.isBuffer(res?.buffer) ? res.buffer : Buffer.alloc(0);
    const raw = buf.toString('utf8');
    const text = effectiveType === 'text/html' || effectiveType === 'application/xhtml+xml'
      ? htmlToText(raw)
      : raw.replace(/\r\n/g, '\n').trim();

    const clipped = text.length > maxChars
      ? { text: text.slice(0, maxChars), truncated: true }
      : { text, truncated: res?.truncated === true };

    return {
      ok: true,
      url: original,
      finalUrl: shape.url.toString(),
      status,
      contentType: effectiveType,
      truncated: clipped.truncated,
      text: clipped.text,
      bytes: buf.length,
      redirects: hop,
    };
  }

  return { ok: false, code: NET_CODE.URL_REJECTED, message: `重定向次数超过 ${MAX_REDIRECTS} 跳，已停止` };
}

/**
 * 只接受合法整数并夹到区间内。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 把底层错误映射到联网错误码。
 *
 * 只认本模块与 image-fetch 产出的码；其它（ECONNREFUSED / TLS 错误）一律
 * 归到"上游故障" —— 那是**这一跳没成**，不是"策略拒绝"。
 *
 * @param {any} error
 * @returns {string}
 */
export function pickCode(error) {
  const code = error?.code;
  if (code === NET_CODE.CANCELLED || code === NET_CODE.TIMEOUT || code === NET_CODE.UPSTREAM) return code;
  if (code === NET_CODE.URL_REJECTED || code === NET_CODE.CONTENT) return code;
  return NET_CODE.UPSTREAM;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function messageOf(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return String(error.message ?? error);
}
