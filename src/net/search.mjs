/**
 * 独立搜索 API 客户端 —— 只实现**一个**真实协议
 *
 * ## 为什么只做一个
 *
 * 「通用搜索 API」不存在。每个服务商的请求体、鉴权头、响应字段、
 * 错误语义都不一样（有的把配额错误放在 200 里，有的用 432/433，
 * 有的把 rate limit 写成 `retry_after` 字段）。写一个"猜格式"的适配层
 * 等于给每一个真实服务商都写错一遍，而失败模式是**静默返回空结果** ——
 * 模型会把它当成"真的搜不到"。
 *
 * 所以本轮只实现 **Tavily Search API**（公开 OpenAPI 文档定义明确、
 * 响应结构稳定、有明确的错误码语义），其余服务商留到后续单独一轮。
 *
 * 依据（公开文档 `POST /search`）：
 *
 *   POST {baseUrl}/search
 *   Authorization: Bearer <apiKey>
 *   { query, max_results(0..20), search_depth(basic|advanced|fast|ultra-fast), topic(general|news|finance) }
 *
 *   200 → { query, results: [{ title, url, content, score, published_date }], response_time, answer, images }
 *   401/403 → 鉴权失败；429 → 限流（带 Retry-After）；432/433 → 配额；
 *   400/422 → 参数不合法；5xx → 上游故障。
 *
 * ## "HTTP 200" 不等于 "搜索成功"
 *
 * 这是本文件最重要的一条纪律：
 *
 *   · `results: []`             → 合法的**空结果**（ok:true + 空数组）
 *   · 200 但 JSON 解析失败      → E4085（协议不符）
 *   · 200 但 `results` 不是数组 → E4085（协议不符）
 *   · 200 且 results 里有坏条目 → 逐条丢弃，其余保留；全坏才算失败
 *
 * 把"请求成功"当成"结果可靠"，会让模型拿着一堆 `undefined` 编答案。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { validateUrlShape } from '../llm/image-fetch.mjs';
import { NET_CODE } from './gate.mjs';
import { pickCode, messageOf } from './http.mjs';
import { redactText, redactValue } from './redact.mjs';

/** 默认搜索端点（与服务商文档一致） */
export const DEFAULT_BASE_URL = 'https://api.tavily.com';

/** 支持的搜索深度（与服务商枚举一致；不做自由文本） */
export const SEARCH_DEPTHS = Object.freeze(['basic', 'advanced', 'fast', 'ultra-fast']);

/** 支持的主题 */
export const SEARCH_TOPICS = Object.freeze(['general', 'news', 'finance']);

/** 结果条数上限（服务商文档写的是 0–20） */
export const MAX_RESULTS_LIMIT = 20;

/** 单条摘要截到多长（进提示词的东西要克制，否则一份结果就吃掉几千 token） */
const SNIPPET_MAX_CHARS = 600;

/** 标题截断 */
const TITLE_MAX_CHARS = 200;

/** 查询词上限（与服务商的实践一致，也防超长 URL/body） */
const QUERY_MAX_CHARS = 400;

/**
 * 搜索错误。
 *
 * @param {string} code
 * @param {string} message
 * @param {{status?: number, retryAfterMs?: number, detail?: string}} [extra]
 * @returns {Error & {code: string, status?: number, retryAfterMs?: number}}
 */
function searchErr(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * 清洗查询词。
 *
 * 三条：去掉 CQ 码（QQ 侧可能残留）、去掉控制字符、压空白并截断。
 * **不做**任何"理解"或改写 —— 查询词是用户/模型的意思，
 * 改动它就等于替它提问。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeQuery(raw) {
  return String(raw ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, QUERY_MAX_CHARS);
}

/**
 * 规范化 baseUrl。
 *
 * 只做形状检查（http/https、无凭据、无路径注入）。**不**在这里做内网判定：
 * 那是联网总闸之下、由 `resolveSafeHost` 统一负责的事，两处都判必然漂移。
 *
 * @param {unknown} raw
 * @returns {{ok: true, baseUrl: string} | {ok: false, code: string, message: string}}
 */
export function normalizeBaseUrl(raw) {
  const s = String(raw ?? '').trim();
  if (s.length > 2048) return { ok: false, code: NET_CODE.NOT_CONFIGURED, message: '搜索服务地址过长' };
  if (!s) return { ok: false, code: NET_CODE.NOT_CONFIGURED, message: '搜索服务地址（baseUrl）为空' };
  let url;
  try {
    url = new URL(s);
  } catch {
    return { ok: false, code: NET_CODE.NOT_CONFIGURED, message: `搜索服务地址不是合法 URL：${s.slice(0, 80)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: NET_CODE.NOT_CONFIGURED, message: `搜索服务地址必须是 http(s)：${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, code: NET_CODE.NOT_CONFIGURED, message: '搜索服务地址不能包含账号密码（Key 请填在单独的密钥项里）' };
  }
  if (url.search || url.hash) {
    return { ok: false, code: NET_CODE.NOT_CONFIGURED, message: '搜索服务地址不能包含查询参数或片段，Key 请使用独立密钥字段' };
  }
  // 管理员配置的本机代理允许 HTTP；远程端点必须 HTTPS，避免明文传 Key。
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:' && host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    return { ok: false, code: NET_CODE.NOT_CONFIGURED, message: '远程搜索服务必须使用 HTTPS（HTTP 仅允许本机代理）' };
  }
  const base = url.toString().replace(/\/+$/, '');
  return { ok: true, baseUrl: base };
}

/**
 * 结果条目的规范化。
 *
 * 逐条校验而不是整单校验：一条坏 URL 不该让另外四条好结果一起消失
 * （那会让"搜索这个问题总是没结果"变成无法解释的现象）。
 *
 * @param {unknown} item
 * @returns {{title: string, url: string, snippet: string, publishedDate?: string, score?: number} | null}
 */
export function normalizeResult(item) {
  if (!item || typeof item !== 'object') return null;
  const src = /** @type {any} */ (item);

  const rawUrl = typeof src.url === 'string' ? src.url.trim() : '';
  if (!rawUrl) return null;
  // 搜索结果里的 URL 同样是**外部输入**：只允许 http(s)、不带凭据。
  // 这里用与抓取同一套形状校验，避免"点开是 file:// 或内网地址"。
  const shape = validateUrlShape(rawUrl);
  if (!shape.ok) return null;

  const title = clip(String(src.title ?? '').trim(), TITLE_MAX_CHARS) || new URL(rawUrl).hostname;
  const snippet = clip(String(src.content ?? src.snippet ?? '').trim(), SNIPPET_MAX_CHARS);

  /** @type {{title: string, url: string, snippet: string, publishedDate?: string, score?: number}} */
  const out = { title, url: rawUrl, snippet };
  const published = typeof src.published_date === 'string' ? src.published_date.trim() : '';
  if (published) out.publishedDate = clip(published, 64);
  const score = Number(src.score);
  if (Number.isFinite(score)) out.score = score;
  return out;
}

/**
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function clip(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 从错误响应体里挖出人话。
 *
 * 服务商的错误形状是 `{detail:{error:"…"}}`（422 时 `detail` 是数组）。
 * 挖不出来就算了 —— 但**不能**把整个响应体原样塞进错误消息：
 * 有的网关会把请求头（含 Key 的前缀）回显在错误里。
 *
 * @param {string} body
 * @returns {string}
 */
export function describeErrorBody(body) {
  const s = String(body ?? '').trim();
  if (!s) return '';
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    return clip(s.replace(/\s+/g, ' '), 200);
  }
  const detail = /** @type {any} */ (parsed)?.detail;
  if (typeof detail === 'string') return clip(detail, 200);
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    if (typeof detail.error === 'string') return clip(detail.error, 200);
  }
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (typeof d?.msg === 'string' ? d.msg : ''))
      .filter(Boolean)
      .join('；');
    if (msgs) return clip(msgs, 200);
  }
  if (typeof /** @type {any} */ (parsed)?.message === 'string') {
    return clip(/** @type {any} */ (parsed).message, 200);
  }
  return '';
}

/**
 * 把 HTTP 状态码映射成我们的语义错误。
 *
 * @param {number} status
 * @param {string} detail
 * @param {Record<string, any>} headers
 * @returns {Error & {code: string}}
 */
export function classifyStatus(status, detail = '', headers = {}) {
  const suffix = detail ? `：${detail}` : '';
  if (status === 401 || status === 403) {
    return searchErr(NET_CODE.UNAUTHORIZED, `搜索服务鉴权失败（HTTP ${status}）${suffix}，请检查 API Key`);
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers);
    return searchErr(
      NET_CODE.QUOTA,
      `搜索服务限流（HTTP 429）${suffix}${retryAfterMs ? `，建议 ${Math.ceil(retryAfterMs / 1000)} 秒后再试` : ''}`,
      retryAfterMs ? { retryAfterMs, status } : { status },
    );
  }
  if (status === 432 || status === 433 || status === 402) {
    return searchErr(NET_CODE.QUOTA, `搜索服务额度已用尽（HTTP ${status}）${suffix}`);
  }
  if (status === 400 || status === 422) {
    // 参数被拒是**我们发错了**，不是"搜不到"。报成语义错误，不报空结果。
    return searchErr(NET_CODE.PROTOCOL, `搜索服务拒绝了这个请求（HTTP ${status}）${suffix}`);
  }
  return searchErr(NET_CODE.UPSTREAM, `搜索服务返回 HTTP ${status}${suffix}`);
}

/**
 * 解析 Retry-After（秒数或 HTTP 日期）。
 *
 * @param {Record<string, any>} headers
 * @returns {number} 毫秒；解析不出来是 0
 */
export function parseRetryAfter(headers) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
  const ts = Date.parse(String(raw));
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, ts - Date.now());
}

/**
 * 发起一次 HTTPS/HTTP 请求并读完整响应体。
 *
 * 与抓网页那边分开的原因：这里要 POST + 自定义头 + 必须读完整 JSON 正文，
 * 而抓网页那边是 GET + 内容类型白名单 + 文本降级。共用一个函数会让两边
 * 的限制互相污染（比如把搜索的 64KB 上限套到网页上）。
 *
 * @param {object} input
 * @param {string} input.url
 * @param {string} input.apiKey
 * @param {object} input.body
 * @param {number} input.timeoutMs
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.maxBytes]
 * @param {(input: object) => Promise<{statusCode: number, headers: Record<string, any>, body: string}>} [input.transport]
 *   测试接缝：注入后 SSRF 与超时由它自己负责（生产环境不传）
 * @returns {Promise<{statusCode: number, headers: Record<string, any>, body: string}>}
 */
export async function postJson(input) {
  if (typeof input.transport === 'function') return input.transport(input);

  const maxBytes = Number(input.maxBytes) > 0 ? Number(input.maxBytes) : 256 * 1024;
  const url = new URL(input.url);
  const payload = Buffer.from(JSON.stringify(input.body ?? {}), 'utf8');

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {import('node:http').ClientRequest | null} */
    let req = null;
    /** @type {import('node:http').IncomingMessage | null} */
    let res = null;
    const signal = input.signal;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        try {
          req?.destroy?.(error);
        } catch {
          /* 已销毁 */
        }
        try {
          res?.destroy?.();
        } catch {
          /* 已销毁 */
        }
        reject(error);
      } else {
        resolve(/** @type {any} */ (result));
      }
    };
    const onAbort = () => finish(searchErr(NET_CODE.CANCELLED, '搜索已取消'));

    const timer = setTimeout(() => {
      finish(searchErr(NET_CODE.TIMEOUT, `搜索请求超时（${input.timeoutMs}ms）`));
    }, Math.max(1, input.timeoutMs));
    timer.unref?.();

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const mod = url.protocol === 'https:' ? https : http;
    try {
      req = mod.request(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            host: url.host,
            'content-type': 'application/json',
            'content-length': String(payload.byteLength),
            // Key 只出现在这一行，且**永远**不进日志/错误消息
            authorization: `Bearer ${input.apiKey}`,
            accept: 'application/json',
            'user-agent': 'Ling-bot/web-search',
            connection: 'close',
          },
          rejectUnauthorized: url.protocol === 'https:',
        },
        (response) => {
          res = response;
          response.on('error', () => finish(searchErr(NET_CODE.UPSTREAM, '读取搜索响应失败')));
          response.on('aborted', () => finish(searchErr(NET_CODE.UPSTREAM, '搜索响应中断')));
          response.on('close', () => {
            if (!response.complete) finish(searchErr(NET_CODE.UPSTREAM, '搜索响应不完整'));
          });
          if (settled) { response.destroy(); return; }
          const type = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (response.statusCode >= 200 && response.statusCode < 300 && !/^application\/(?:[\w.-]+\+)?json$/.test(type)) {
            finish(searchErr(NET_CODE.PROTOCOL, '搜索服务响应类型不是 application/json'));
            return;
          }
          const headers = /** @type {Record<string, any>} */ (response.headers);
          const statusCode = Number(response.statusCode) || 0;
          /** @type {Buffer[]} */
          const chunks = [];
          let size = 0;

          response.on('data', (chunk) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (size > maxBytes) {
              finish(searchErr(NET_CODE.PROTOCOL, `搜索响应超过 ${maxBytes} 字节上限，已中止`));
              response.destroy();
              return;
            }
            chunks.push(buf);
          });
          response.on('end', () => {
            finish(null, { statusCode, headers, body: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', (error) => {
        // 连接层失败（DNS、TLS、被拒绝）→ 上游故障，不是"没结果"
        finish(searchErr(NET_CODE.UPSTREAM, `连接搜索服务失败：${messageOf(error)}`));
      });
      req.end(payload);
    } catch (error) {
      finish(searchErr(NET_CODE.UPSTREAM, `发起搜索请求失败：${messageOf(error)}`));
    }
  });
}

/**
 * 一次搜索调用。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.query
 * @param {number} [opts.maxResults]
 * @param {string} [opts.searchDepth]
 * @param {string} [opts.topic]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {() => number} [opts.now]
 * @param {(input: object) => Promise<any>} [opts.transport] 测试接缝
 * @returns {Promise<
 *   {ok: true, provider: string, query: string, results: object[], tookMs: number, credits?: number, truncated: boolean}
 *   | {ok: false, code: string, message: string, retryAfterMs?: number, results?: never}
 * >}
 */
export async function searchOnce(opts) {
  const secret = String(opts.apiKey ?? '').trim();
  const result = redactValue(await searchInternal(opts), secret);
  /*
   * URL 一旦包含被回显的 Key，整条来源丢弃，不能把脱敏占位符当成可引用地址。
   *
   * 但**全部被丢掉时不能变成 `ok:true` + 空数组**：上游明明给了结果，
   * 只是我们一条都不敢返回。报成"没搜到"会让模型理直气壮地回答"查不到"，
   * 而真实原因是上游/网关在回显密钥 —— 那是协议问题（E4085）。
   * 这与"有 results 但每条 URL 都不合法 → E4085"是同一条纪律。
   */
  if (result.ok) {
    const before = result.results.length;
    result.results = result.results.filter((entry) => !entry.url.includes('[REDACTED]'));
    const dropped = before - result.results.length;
    if (before > 0 && result.results.length === 0) {
      return {
        ok: false,
        code: NET_CODE.PROTOCOL,
        message:
          `搜索服务返回了 ${before} 条结果，但每一条的地址里都含有被回显的密钥，`
          + '已全部丢弃（不是空结果）。请检查服务地址/网关是否在回显 API Key。',
      };
    }
    /*
     * 有来源被丢时结果同样"不全"，标 truncated 让模型知道自己看到的不是全部。
     * 注意这时不能说是"条数上限"造成的 —— 消息里只说结果不全，不编原因。
     */
    if (dropped > 0) result.truncated = true;
  }
  return result;
}

async function searchInternal(opts) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const startedAt = now();

  const query = sanitizeQuery(opts.query);
  if (!query) {
    return { ok: false, code: NET_CODE.PROTOCOL, message: '搜索词为空（清洗后没有任何内容）' };
  }

  const base = normalizeBaseUrl(opts.baseUrl);
  if (!base.ok) return { ok: false, code: base.code, message: base.message };

  const apiKey = String(opts.apiKey ?? '').trim();
  if (!apiKey) {
    return {
      ok: false,
      code: NET_CODE.NOT_CONFIGURED,
      message: '还没有配置搜索服务的 API Key（在《插件设置 → 联网搜索》里填写）',
    };
  }

  const maxResults = clampInt(opts.maxResults, 5, 1, MAX_RESULTS_LIMIT);
  const searchDepth = SEARCH_DEPTHS.includes(String(opts.searchDepth)) ? String(opts.searchDepth) : 'basic';
  const topic = SEARCH_TOPICS.includes(String(opts.topic)) ? String(opts.topic) : 'general';
  const timeoutMs = clampInt(opts.timeoutMs, 15_000, 1000, 60_000);

  /** @type {Record<string, any>} */
  const body = {
    query,
    max_results: maxResults,
    search_depth: searchDepth,
    topic,
    // 这三项都显式关掉：它们会显著放大响应体和费用，
    // 而模型需要的只是"标题 + URL + 摘要"
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  };

  const endpoint = `${base.baseUrl}/search`;
  let res;
  try {
    res = await postJson({
      url: endpoint,
      apiKey,
      body,
      timeoutMs,
      signal: opts.signal,
      transport: opts.transport,
    });
  } catch (error) {
    return {
      ok: false,
      code: pickCode(error),
      message: messageOf(error),
    };
  }

  const status = Number(res?.statusCode) || 0;
  if (status < 200 || status >= 300) {
    const detail = describeErrorBody(redactText(res?.body ?? '', apiKey));
    const err = classifyStatus(status, detail, res?.headers ?? {});
    return {
      ok: false,
      code: /** @type {any} */ (err).code,
      message: err.message,
      ...(/** @type {any} */ (err).retryAfterMs ? { retryAfterMs: /** @type {any} */ (err).retryAfterMs } : {}),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(redactText(res?.body ?? '', apiKey));
  } catch {
    // 不回显响应前缀：网关错误页可能把请求头（含 Key）原样带回。
    return { ok: false, code: NET_CODE.PROTOCOL, message: '搜索服务返回的不是合法 JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(/** @type {any} */ (parsed).results)) {
    return {
      ok: false,
      code: NET_CODE.PROTOCOL,
      message: '搜索服务响应缺少 results 数组（不是空结果，是协议不符）',
    };
  }

  const rawList = /** @type {any[]} */ (/** @type {any} */ (parsed).results);
  /** @type {object[]} */
  const results = [];
  for (const item of rawList) {
    const one = normalizeResult(item);
    if (one) results.push(one);
    if (results.length >= maxResults) break;
  }

  /*
   * 全坏 ≠ 空结果。
   *
   * 上游给了 N 条、我们一条都认不出来 → 说明协议变了或对端在返回垃圾，
   * 那是 `E4085`。报成"搜索无结果"会让模型理直气壮地回答"查不到"。
   */
  if (rawList.length > 0 && results.length === 0) {
    return {
      ok: false,
      code: NET_CODE.PROTOCOL,
      message: `搜索服务返回了 ${rawList.length} 条结果，但没有一条是合法来源（URL 缺失或不被允许）`,
    };
  }

  const usage = /** @type {any} */ (parsed).usage;
  /** @type {{ok: true, provider: string, query: string, results: object[], tookMs: number, credits?: number, truncated: boolean}} */
  const out = {
    ok: true,
    provider: 'tavily',
    // 用上游回显的 query（若有）：那是它**真的**搜了什么
    query: typeof /** @type {any} */ (parsed).query === 'string' ? parsed.query : query,
    results: [...new Map(results.map((entry) => [entry.url, entry])).values()],
    tookMs: now() - startedAt,
    truncated: rawList.length > results.length,
  };
  const credits = Number(usage?.credits);
  if (Number.isFinite(credits)) out.credits = credits;
  return out;
}

/**
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
 * 只用于**测试**：检查某个字符串里有没有疑似 Key（防御性断言用）。
 *
 * 生产代码不用它 —— 真正的保证是"Key 只出现在 authorization 头里"。
 *
 * @param {string} text
 * @param {string} apiKey
 * @returns {boolean}
 */
export function containsKey(text, apiKey) {
  if (!apiKey || apiKey.length < 8) return false;
  return String(text ?? '').includes(apiKey);
}

export { net, validateUrlShape };
