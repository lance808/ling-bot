/**
 * 宿主侧 `ctx.net` 工厂 —— 联网能力的唯一实现入口
 *
 * ## 它在链条里的位置
 *
 * ```
 * 模型 →工具调用→ executor → manager(runtime) → 插件 callTool({ctx})
 *                                                   ↓ ctx.net.search()
 *                                              ★ 本文件（宿主判定）
 *                                                   ↓
 *                                    src/net/search.mjs（Tavily 协议）
 *                                    src/net/http.mjs  （受限抓网页）
 * ```
 *
 * 为什么判定放在宿主而不是插件里：插件是**被授权方**。如果"能不能联网"
 * 由插件自己读配置判断，那么任何一个插件都能决定自己不受总闸约束 ——
 * 授权边界必须由宿主握在手里，插件只能拿到一个"已经被判定过"的能力对象。
 *
 * ## 三条硬约束
 *
 * 1. **开关现读**：每次 `search` / `fetch` 进入时重新读总闸（`getEnabled()`），
 *    不缓存构造时的值。控制台在另一个入口改配置，缓存会让"紧急关掉"
 *    必须重启才对这次调用生效，那对安全开关毫无意义。
 *
 * 2. **在途取消**：`refresh()` 在总闸 true→false 时被调用，abort **所有**
 *    在途请求。不是"下次调用再拦"—— 用户点关闭时，线上正在跑的请求
 *    必须立刻停。
 *
 * 3. **Key 不外泄**：解密后的 Key 只作为 `authorization` 头的值存在，
 *    不进返回值、不进日志、不进错误消息。所有错误消息都由本模块
 *    与 search.mjs 拼接，不直接拼上游响应体（那可能回显 Key 前缀）。
 *
 * ## 失败不抛异常
 *
 * 与 `ctx.chat` / `ctx.gateway` 一致：所有方法返回 `{ok:false, code, message}`。
 * 插件应当把它直接交给模型（模型需要知道"没搜到"和"被拒绝了"的区别），
 * 而不是 try/catch 后转成一个含糊的"插件坏了"。
 */

import { networkEnabledFrom, networkDisabledResult, NET_CODE } from './gate.mjs';
import { searchOnce, normalizeBaseUrl, clampInt, MAX_RESULTS_LIMIT, SEARCH_DEPTHS } from './search.mjs';
import { fetchText, clampInt as clampFetchInt, FETCH_LIMITS } from './http.mjs';
import { redactValue } from './redact.mjs';

/** 默认配置（插件清单里也有一份；这里兜底，防止"配置对象缺字段"导致整条链路报错） */
export const NET_DEFAULTS = Object.freeze({
  provider: 'tavily',
  baseUrl: 'https://api.tavily.com',
  maxResults: 5,
  searchDepth: 'basic',
  timeoutMs: 15_000,
  allowFetch: true,
  maxFetchBytes: 200 * 1024,
  fetchTimeoutMs: 10_000,
});

/** 本轮真正实现的搜索协议。其它值一律明确拒绝，不偷偷按 Tavily 发。 */
export const SUPPORTED_PROVIDERS = Object.freeze(['tavily']);

/**
 * 可信调用来源。
 *
 * 这两个是宿主 `guard/origin.mjs` 里"管理员自己"的两种入口：桌面控制台与
 * 管理员私聊。群聊/主动回合的 origin 永远到不了这里 —— 即使将来有人绕过
 * 工具授权硬调，也会在 host-net 这一层被拒。
 */
const TRUSTED_ORIGINS = new Set(['owner-private', 'console']);

/**
 * 每个方法只能由对应的工具发起。
 *
 * 为什么精确到工具：`ctx.net` 是插件级能力，但"搜索"和"抓网页"的风险面
 * 不同（后者才是 SSRF 入口）。如果只校验插件，一个被改坏的 `web_search`
 * 实现就能顺手调 `ctx.net.fetch` 去探测内网。
 */
const METHOD_TOOL = Object.freeze({
  search: 'plugin_web_search',
  fetch: 'plugin_web_fetch',
});

/**
 * 归一化插件配置（脏数据一律回默认值，不抛）。
 *
 * 为什么不抛：这些值来自 `config.json`，可能是手改的。一个 `timeoutMs: "abc"`
 * 不该让搜索工具整个不可用 —— 它只该让"超时"这一项回默认值。
 * 真正的形状校验在启动时（schema）与保存时（validateConfig），这里是兜底。
 *
 * @param {Record<string, any>} raw
 * @returns {typeof NET_DEFAULTS & {provider: string}}
 */
export function normalizeNetConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = normalizeBaseUrl(src.baseUrl);
  const provider = String(src.provider ?? NET_DEFAULTS.provider).trim().toLowerCase();
  return {
    // 未知 provider **保留原值**，由 makeFor 显式拒绝；静默改回 tavily
    // 会让用户以为自己配的中转被用上了，而请求其实打到官方端点。
    provider: provider || NET_DEFAULTS.provider,
    baseUrl: base.ok ? base.baseUrl : (src.baseUrl === undefined ? NET_DEFAULTS.baseUrl : ''),
    maxResults: clampInt(src.maxResults, NET_DEFAULTS.maxResults, 1, MAX_RESULTS_LIMIT),
    searchDepth: SEARCH_DEPTHS.includes(String(src.searchDepth)) ? String(src.searchDepth) : NET_DEFAULTS.searchDepth,
    timeoutMs: clampInt(src.timeoutMs, NET_DEFAULTS.timeoutMs, 1000, 60_000),
    allowFetch: src.allowFetch !== false,
    maxFetchBytes: clampFetchInt(
      src.maxFetchBytes,
      NET_DEFAULTS.maxFetchBytes,
      FETCH_LIMITS.maxBytesMin,
      FETCH_LIMITS.maxBytesMax,
    ),
    fetchTimeoutMs: clampFetchInt(
      src.fetchTimeoutMs,
      NET_DEFAULTS.fetchTimeoutMs,
      FETCH_LIMITS.timeoutMsMin,
      FETCH_LIMITS.timeoutMsMax,
    ),
  };
}

/**
 * 创建联网工厂。
 *
 * @param {object} opts
 * @param {() => boolean} opts.getEnabled 读总闸（每次调用都读）
 * @param {object} [opts.stats] 统计对象（宿主持有，快照里展示）
 * @param {(level: string, message: string, fields?: object) => void} [opts.log]
 * @param {() => number} [opts.now]
 * @param {object} [opts.deps] 测试接缝：`{ transport, requestOnce, resolveHost }`
 * @returns {{
 *   readonly stats: object,
 *   refresh(): number,
 *   isEnabled(): boolean,
 *   makeFor(input: {pluginId: string, config?: object, secrets?: object}): (call: {invocation?: object, signal?: AbortSignal}) => object,
 * }}
 */
export function createNetFactory(opts) {
  const getEnabled = typeof opts?.getEnabled === 'function' ? opts.getEnabled : () => true;
  const log = typeof opts?.log === 'function' ? opts.log : () => {};
  const now = typeof opts?.now === 'function' ? opts.now : Date.now;
  const deps = opts?.deps && typeof opts.deps === 'object' ? opts.deps : {};

  const stats = opts?.stats ?? {
    searches: 0,
    fetches: 0,
    failures: 0,
    cancelled: 0,
    lastAt: null,
    lastError: null,
  };

  /**
   * 在途请求的取消控制器。
   *
   * 每个控制器只属于一次调用；`refresh()` 关闸时把它们全部 abort 并清空。
   * 用 Set 而不是数组：删的时候要 O(1)，而这里的量很小但删得很频繁。
   *
   * @type {Set<AbortController>}
   */
  const inflight = new Set();

  /**
   * 记一次失败（供界面显示"最近一次为什么失败"）。
   *
   * @param {string} code
   * @param {string} message
   */
  function noteFailure(code, message) {
    stats.failures += 1;
    stats.lastError = { code: String(code ?? 'E50XX'), message: String(message ?? '').slice(0, 300), at: now() };
  }

  /**
   * 关闸时中止所有在途请求。
   *
   * @returns {number} 被中止的数量
   */
  function refresh() {
    const enabled = getEnabled();
    if (enabled) return 0;
    let n = 0;
    for (const ctrl of inflight) {
      try {
        ctrl.abort();
        n += 1;
      } catch {
        /* 单个失败不影响其余 */
      }
    }
    inflight.clear();
    if (n > 0) log('info', `联网已关闭，中止了 ${n} 个在途请求`);
    return n;
  }

  /**
   * 组合"本次调用的取消"与"关闸中止"两个信号。
   *
   * @param {AbortSignal | undefined} external
   * @returns {{signal: AbortSignal, release: () => void}}
   */
  function track(external) {
    const ctrl = new AbortController();
    const onAbort = () => {
      try {
        ctrl.abort();
      } catch {
        /* 已中止 */
      }
    };
    if (external) {
      if (external.aborted) onAbort();
      else external.addEventListener('abort', onAbort, { once: true });
    }
    inflight.add(ctrl);
    return {
      signal: ctrl.signal,
      release: () => {
        inflight.delete(ctrl);
        external?.removeEventListener?.('abort', onAbort);
      },
    };
  }

  /**
   * 给某个插件实例生成 `ctx.net` 工厂。
   *
   * 为什么按插件实例生成（而不是一个全局单例）：配置与密钥是**每个插件**
   * 的。做成单例就必须在调用时往里写"当前插件是谁"，并发时会串 ——
   * 和 `ctx.chat` 按调用生成是同一个理由。
   *
   * @param {{pluginId: string, config?: object, secrets?: object}} input
   * @returns {(call: {invocation?: object, signal?: AbortSignal}) => object}
   */
  function makeFor(input) {
    const pluginId = String(input?.pluginId ?? '');
    const cfg = normalizeNetConfig(input?.config ?? {});
    // 明文 Key 只活在闭包里，不写进任何返回值
    const apiKey = typeof input?.secrets?.apiKey === 'string' ? input.secrets.apiKey.trim() : '';
    const providerOk = SUPPORTED_PROVIDERS.includes(cfg.provider);
    const baseUrlOk = cfg.baseUrl !== '';
    /*
     * 「配置好了」是三个条件的合取：有 Key、服务地址合法、协议被支持。
     *
     * 只检查 Key 的后果很具体：用户把 baseUrl 写坏、或把 provider 写成别家，
     * 界面仍显示"搜索可用"，而每次调用要么打到一个错误地址，要么按 Tavily
     * 的格式发给一个不兼容的服务 —— 前者是超时，后者是协议错误，看起来都像
     * "搜不到"。
     */
    const configured = apiKey !== '' && providerOk && baseUrlOk;

    return function makeNetForCall(call = {}) {
      const external = call?.signal;
      const enabledNow = getEnabled();
      /*
       * init / testConnection 阶段没有"某次调用"，因此**不允许发请求**。
       *
       * 为什么不让它自由发：那两个阶段是装配与自检，发请求会花额度，
       * 而且 `process` 运行时那边同样拿不到调用上下文（只能读事实）。
       * 两端行为必须一致 —— 否则"同一个插件在两种 runtime 下语义不同"
       * 会让作者写出只在一种运行时能跑的代码。
       */
      const allowRequests = call?.allowRequests !== false;
      /*
       * 调用结束后宿主会 `revoke()` 这个对象。
       *
       * 为什么需要：插件完全可以把 `ctx.net` 存到模块变量里，等下一次
       * 无关调用时再拿出来用 —— 那时它已经不在"某次工具调用"的授权上下文里，
       * 却仍握着配置与 Key。revoke 让这份能力在调用边界之后立即失效。
       */
      let revoked = false;

      /** 统一的"前置检查"：返回 null 表示可以继续 */
      const precheck = (/** @type {string} */ what, /** @type {'search'|'fetch'} */ method) => {
        // 关闸不是"取消"：取消是这次调用被放弃，关闸是"这个能力现在不允许"。
        // 两者混进同一个统计，会让界面上的"取消 N 次"看起来像用户点了停止。
        if (!getEnabled()) return networkDisabledResult(what);
        if (!allowRequests) {
          return {
            ok: false,
            code: 'E4071',
            message: `联网请求只能在工具调用里发起（${what}在 init / 测试连接阶段没有调用上下文）。`,
          };
        }
        if (revoked) {
          return {
            ok: false,
            code: 'E4071',
            message: `这次工具调用已经结束，${what}能力已失效；需要时请在新的工具调用里重新发起。`,
          };
        }
        const bad = invocationProblem(call?.invocation, method);
        if (bad) {
          return { ok: false, code: 'E4071', message: `${what}被拒绝：${bad}。` };
        }
        if (!providerOk) {
          return {
            ok: false,
            code: NET_CODE.NOT_CONFIGURED,
            message: `不支持的服务类型「${cfg.provider}」：本轮只实现了 Tavily Search API。`
              + '请把「服务类型」改回 tavily，或等后续版本适配。',
          };
        }
        if (!configured) {
          return {
            ok: false,
            code: NET_CODE.NOT_CONFIGURED,
            message: '搜索服务还没配置好（缺 API Key 或服务地址不合法），去《插件设置 → 联网搜索》检查。',
          };
        }
        return null;
      };

      return {
        available: true,
        enabled: enabledNow,
        provider: cfg.provider,
        configured,

        /**
         * 让这份能力在本次调用结束后失效（由 runtime 在 finally 调用）。
         *
         * 幂等：重复调用没有副作用。
         */
        revoke() {
          revoked = true;
        },

        /**
         * 搜索。
         *
         * @param {{query?: unknown, maxResults?: unknown, topic?: unknown}} args
         */
        async search(args = {}) {
          const blocked = precheck('搜索', 'search');
          if (blocked) {
            noteFailure(blocked.code, blocked.message);
            return blocked;
          }
          if (external?.aborted) {
            stats.cancelled += 1;
            return { ok: false, code: NET_CODE.CANCELLED, message: '搜索已取消' };
          }

          /*
           * 条数只能**减少**，不能增加。
           *
           * 配置是管理员设的上限（也是费用上限）；模型参数只是"这次想少要几条"。
           * 直接 `args.maxResults ?? cfg.maxResults` 会让模型写 20 就突破配置的 2 ——
           * 既多花额度，也让"配置上限"变成一句空话。
           */
          const wanted = clampInt(args?.maxResults, cfg.maxResults, 1, MAX_RESULTS_LIMIT);
          const maxResults = Math.min(cfg.maxResults, wanted, MAX_RESULTS_LIMIT);

          const tracker = track(external);
          try {
            const r = await searchOnce({
              baseUrl: cfg.baseUrl,
              apiKey,
              query: args?.query,
              maxResults,
              searchDepth: cfg.searchDepth,
              topic: args?.topic,
              timeoutMs: cfg.timeoutMs,
              signal: tracker.signal,
              now,
              transport: /** @type {any} */ (deps).transport,
            });

            if (r.ok) {
              stats.searches += 1;
              stats.lastAt = now();
              // 不记录查询正文：它可能包含用户的私密问题，日志不该是第二份聊天记录。
              log('info', '联网搜索完成', {
                plugin: pluginId,
                queryLength: String(r.query ?? '').length,
                results: r.results.length,
                tookMs: r.tookMs,
              });
              return r;
            }

            if (r.code === NET_CODE.CANCELLED) {
              stats.cancelled += 1;
              log('info', '联网搜索被取消', { plugin: pluginId });
            } else {
              noteFailure(r.code, r.message);
              log('warn', '联网搜索失败', { plugin: pluginId, code: r.code, message: r.message });
            }
            return r;
          } finally {
            tracker.release();
          }
        },

        /**
         * 抓网页正文。
         *
         * @param {{url?: unknown, maxChars?: unknown}} args
         */
        async fetch(args = {}) {
          const blocked = precheck('网页读取', 'fetch');
          if (blocked) {
            noteFailure(blocked.code, blocked.message);
            return blocked;
          }
          if (cfg.allowFetch !== true) {
            const r = {
              ok: false,
              code: NET_CODE.DISABLED,
              message: '网页正文读取在这个插件里被关闭了（allowFetch: false），只能用搜索。',
            };
            noteFailure(r.code, r.message);
            return r;
          }
          if (external?.aborted) {
            stats.cancelled += 1;
            return { ok: false, code: NET_CODE.CANCELLED, message: '抓取已取消' };
          }

          const tracker = track(external);
          try {
            const r = await fetchText(String(args?.url ?? ''), {
              maxBytes: cfg.maxFetchBytes,
              timeoutMs: cfg.fetchTimeoutMs,
              maxChars: args?.maxChars,
              signal: tracker.signal,
              now,
              resolveHost: /** @type {any} */ (deps).resolveHost,
              requestOnce: /** @type {any} */ (deps).requestOnce,
            });

            if (r.ok) {
              stats.fetches += 1;
              stats.lastAt = now();
              log('info', '网页读取完成', {
                plugin: pluginId,
                host: safeHostOf(r.finalUrl),
                bytes: r.bytes,
                truncated: r.truncated,
              });
              return r;
            }

            if (r.code === NET_CODE.CANCELLED) {
              stats.cancelled += 1;
            } else {
              noteFailure(r.code, r.message);
              log('warn', '网页读取失败', { plugin: pluginId, code: r.code, message: r.message });
            }
            return r;
          } finally {
            tracker.release();
          }
        },
      };
    };
  }

  return {
    get stats() {
      return stats;
    },
    refresh,
    isEnabled: () => getEnabled(),
    makeFor,
  };
}

/**
 * 校验一次调用的可信上下文。
 *
 * 返回空串表示通过；否则是一句给模型/日志看的原因。
 *
 * 为什么宿主必须自己再校验一次（manager 已经只给 web-search 注入能力）：
 * manager 是第一层，但 host-net 是**真正发请求的地方**。只要有一个调用方
 * 绕过了 manager（新运行时、测试接缝、将来某个内置能力），没有这一层就等于
 * 把"谁能联网"交给调用方自觉。安全边界不能建立在"上游已经查过了"上。
 *
 * @param {any} invocation
 * @param {'search'|'fetch'} method
 * @returns {string}
 */
function invocationProblem(invocation, method) {
  if (!invocation || typeof invocation !== 'object') {
    return '缺少可信调用上下文（invocation）';
  }
  if (String(invocation.pluginId ?? '') !== 'web-search') {
    return `联网能力只属于 web-search 插件（收到「${String(invocation.pluginId ?? '')}」）`;
  }
  const need = METHOD_TOOL[method];
  if (String(invocation.tool ?? '') !== need) {
    return `${method} 只能由 ${need} 发起（收到「${String(invocation.tool ?? '')}」）`;
  }
  if (!TRUSTED_ORIGINS.has(String(invocation.origin ?? ''))) {
    return `来源「${String(invocation.origin ?? '')}」不允许联网（只对管理员私聊与桌面端开放）`;
  }
  return '';
}

/**
 * 只取 host 用于日志（完整 URL 可能带查询参数，没必要进日志）。
 *
 * @param {string} url
 * @returns {string}
 */
function safeHostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

/**
 * 从配置对象判定总闸（转发到 gate.mjs —— 全项目只有那一份判定）。
 *
 * @param {unknown} config
 * @returns {boolean}
 */
export { networkEnabledFrom };
