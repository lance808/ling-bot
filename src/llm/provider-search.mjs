/**
 * 服务商原生联网 —— 协议适配与证据判定（**唯一实现**）
 *
 * ## 它和「独立搜索 API」是什么关系
 *
 *   · 独立搜索 API（`src/net/*`）：Ling-bot 自己发 HTTP 请求，结果作为工具回灌；
 *   · 服务商原生联网（本文件）：Ling-bot 只在**模型请求体**里声明"请联网"，
 *     真正的检索由模型服务商在它自己的服务端完成。
 *
 * 两条通道的可见性完全不同：前者我们能看到请求与响应；后者我们只能看到
 * 上游**愿意返回**的引用/来源/事件。这个差别决定了本文件最重要的纪律。
 *
 * ## 「HTTP 200」不是联网成功的证据
 *
 * 真实世界里有三种情况都会返回 200：
 *
 *   1. 真联网了，且返回了引用/来源；
 *   2. 中转不认识这个字段，静默丢掉，模型凭自己的知识回答（最常见）；
 *   3. 模型判断这次不需要检索，直接回答。
 *
 * 只看状态码，2 和 3 会被记成"联网成功"，用户据此以为"它查了最新资料"，
 * 而答案其实来自训练数据。所以这里只认**协议里明确约定的证据字段**：
 * 结构化引用/来源、明确的搜索事件、或协议规定的正文角标。
 *
 * 没有证据时状态是 **unknown**（无法确认），不是成功、也不是失败。
 * 也**不**使用"答对了今天日期"或"模型自称已联网"这类东西当证据 ——
 * 前者可能只是训练数据或上游注入，后者是模型的一句话，两者都无法证明
 * 这次请求真的检索过。
 *
 * ## 为什么不按模型名猜服务商
 *
 * 同一个模型名可以走官方、中转、自建代理，字段支持情况完全不同。
 * 所以协议只由用户**显式选择**的服务商决定（`network.native.provider`），
 * 本文件不读模型名、不做名字匹配。
 *
 * ## 本轮适配范围（按用户指定）
 *
 *   · 智谱 GLM：`tools[].type = "web_search"`；正文可能带 `[来源：ref_N]`；
 *   · OpenAI：Chat Completions 的 `web_search_options`；引用在
 *     `choices[].message/delta.annotations[].url_citation`。
 *
 * 两者都走**现有** OpenAI 兼容 `POST /v1/chat/completions` 传输，不新增端点。
 * OpenAI 的 Responses API（`/v1/responses` 的 `web_search` 工具）不在本轮：
 * 那需要另一套输出模型与事件流，属于"换协议"而不是"加字段"。
 *
 * 参考（公开文档 / 官方 SDK 类型）：
 *   · https://docs.bigmodel.cn/cn/guide/tools/web-search.md
 *   · https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat/completion_create_params.py
 *   · https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat/chat_completion_message.py
 */

import { validateUrlShape } from './image-fetch.mjs';
import { networkEnabledFrom } from '../net/gate.mjs';

/** 存储的联网通道。'off' 不是存储值 —— 关闭由 network.enabled 表达 */
export const NATIVE_MODES = Object.freeze(['api', 'native']);

/** 结果条数硬上限（与独立搜索 API 保持同一口径，便于放同一张界面卡） */
export const NATIVE_MAX_RESULTS_LIMIT = 20;

/** 引用/来源最多保留几条（来源只是给模型/界面看，不该无限膨胀） */
const MAX_SOURCES = 20;
const TITLE_MAX_CHARS = 200;
const SNIPPET_MAX_CHARS = 300;

/**
 * 适配器注册表。
 *
 * 每个适配器只描述**这一个服务商**的公开协议：请求片段、证据字段、
 * 关闭语义与限制说明。新增服务商 = 在这里加一项，而不是在 client 里写分支。
 */
export const NATIVE_PROVIDERS = Object.freeze({
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    protocol: '智谱 GLM · Chat Completions · tools[type="web_search"]',
    transport: 'chat/completions',
    /**
     * 请求字段（官方文档「对话中的网络搜索」）：
     *   tools: [{ type: "web_search", web_search: { enable, search_result, count } }]
     * `enable` 打开联网，`search_result` 让检索结果参与生成（正文才会出现
     * `[来源：ref_N]` 角标），`count` 是返回条数（官方 1–50，这里沿用 1–20）。
     */
    requestFields: 'tools[].type="web_search"; tools[].web_search{enable:true, search_result:true, count}',
    evidence: Object.freeze({ structuredSources: true, inlineRefs: true, toolEvent: false }),
    limitsText:
      '请求字段与正文角标已适配。官方流式 ChatCompletionChunk 没有顶层 web_search 字段，'
      + '所以流式请求通常拿不到结构化来源列表；此时只有正文出现 [来源：ref_N] 才算证据，'
      + '否则记为「无法确认」。',
    offPolicy: Object.freeze({
      explicit: false,
      text:
        '关闭后不发送任何 web_search 工具声明。智谱只有声明该工具才会启用联网，'
        + '不声明就是协议层面的关闭；协议里另有 web_search.enable=false，但它要求发送'
        + '非标准工具对象，可能被非智谱中转拒绝，因此关闭时选择完全不声明。'
        + '上游是否仍在其服务端自行检索，Ling-bot 看不到也无法保证。',
    }),
    /**
     * @param {{maxResults: number}} input
     * @returns {{tools: object[], bodyPatch: Record<string, any>}}
     */
    build(input) {
      return {
        tools: [
          {
            type: 'web_search',
            web_search: {
              enable: true,
              // 不打开它，正文通常不会出现 ref 角标，证据就只剩"无"。
              search_result: true,
              count: input.maxResults,
            },
          },
        ],
        bodyPatch: {},
      };
    },
    /**
     * 从单个 SSE chunk / 非流式响应对象里收证据。
     *
     * 官方文档的 `web_search` 数组出现在**非流式**响应顶层；流式里官方 schema
     * 没有该字段，但中转可能照搬，所以这里"有就收、没有不算失败"。
     *
     * @param {any} chunk
     * @param {EvidenceState} state
     */
    collect(chunk, state) {
      const list = chunk?.web_search;
      if (Array.isArray(list)) {
        for (const item of list) {
          const source = normalizeSource({
            title: item?.title,
            url: item?.link ?? item?.url,
            snippet: item?.content,
            publishedDate: item?.publish_date,
          });
          if (source) pushSource(state, source);
        }
      }
      // 角标号本身也是证据（ref_1 / ref_2 …），但只有正文里真的出现才算。
      state.seenRefer = state.seenRefer || Array.isArray(list);
    },
    /**
     * @param {EvidenceState} state
     * @param {string} text
     */
    finalize(state, text) {
      const refs = collectInlineRefs(text);
      for (const ref of refs) state.inlineRefs.add(ref);
    },
  },

  openai: {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'OpenAI · Chat Completions · web_search_options + annotations[url_citation]',
    transport: 'chat/completions',
    /**
     * 请求字段（官方 SDK 类型 `CompletionCreateParamsBase.web_search_options`）：
     *   web_search_options: { search_context_size: "low"|"medium"|"high" }
     *
     * 注意：这个字段只对服务商支持联网检索的模型/端点生效。哪些模型支持
     * 是服务商的事实，我们不按模型名猜；不支持时上游会拒绝（走降级），
     * 或者静默忽略（记为「无法确认」）。
     */
    requestFields: 'web_search_options:{search_context_size:"medium"}',
    evidence: Object.freeze({ structuredSources: true, inlineRefs: false, toolEvent: false }),
    limitsText:
      '引用只在 message/delta.annotations 的 url_citation 里。若上游返回 200 但没有'
      + '任何 url_citation，状态只能是「无法确认」——那既可能是参数被中转忽略，也可能是'
      + '模型判断无需检索。Responses API 的 web_search 工具不在本轮（需要另一套端点与事件）。',
    offPolicy: Object.freeze({
      explicit: false,
      text:
        'OpenAI Chat Completions 没有"关闭联网"字段；不发送 web_search_options 就是'
        + '协议定义的关闭方式。上游是否仍在其服务端自行检索无法验证。',
    }),
    /**
     * @param {{maxResults: number}} _input
     * @returns {{tools: object[], bodyPatch: Record<string, any>}}
     */
    build(_input) {
      return {
        tools: [],
        bodyPatch: { web_search_options: { search_context_size: 'medium' } },
      };
    },
    /**
     * @param {any} chunk
     * @param {EvidenceState} state
     */
    collect(chunk, state) {
      const choice = chunk?.choices?.[0];
      const raw = choice?.delta?.annotations ?? choice?.message?.annotations;
      if (Array.isArray(raw)) collectAnnotations(raw, state);
    },
    /**
     * @param {EvidenceState} state
     * @param {string} text
     */
    finalize(_state, _text) {
      /* 引用已在 chunk 里收齐；正文不需要再解析 */
    },
  },
});

/** @typedef {{sources: Map<string, object>, inlineRefs: Set<string>, seenRefer: boolean}} EvidenceState */

/**
 * 归一化 `network.native`。
 *
 * 未知 provider **保留原值**（由 resolveNativeSearch 标成"尚未适配"），
 * 不静默改成一个受支持的服务商 —— 那会让人以为自己的选择生效了，
 * 而请求其实按另一家协议发出。
 *
 * @param {any} raw
 * @returns {{provider: string, maxResults: number}}
 */
export function normalizeNativeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const provider = String(src.provider ?? '').trim().toLowerCase();
  return {
    provider,
    maxResults: clampInt(src.maxResults, 5, 1, NATIVE_MAX_RESULTS_LIMIT),
  };
}

/**
 * 解析当前配置下的原生联网状态。
 *
 * **纯函数、永不抛错**：配置可能被手改坏，这里只做兜底，形状错误不该把
 * 整个聊天链路拖垮。返回对象同时供 client（拿 `plan`）、快照（拿说明）、
 * 界面（拿状态）使用 —— 三处读同一份判定，避免各推一套。
 *
 * @param {any} config
 * @returns {{
 *   enabled: boolean,
 *   storedMode: 'api'|'native',
 *   effectiveMode: 'off'|'api'|'native',
 *   active: boolean,
 *   provider: string,
 *   providerKnown: boolean,
 *   providerLabel: string,
 *   protocol: string,
 *   transport: string,
 *   requestFields: string,
 *   evidence: {structuredSources: boolean, inlineRefs: boolean, toolEvent: boolean},
 *   limitsText: string,
 *   offPolicy: {explicit: boolean, text: string},
 *   maxResults: number,
 *   plan: null | object,
 * }}
 */
export function resolveNativeSearch(config) {
  const enabled = networkEnabledFrom(config);
  const storedMode = /** @type {any} */ (config)?.network?.mode === 'native' ? 'native' : 'api';
  const native = normalizeNativeConfig(/** @type {any} */ (config)?.network?.native);
  const adapter = NATIVE_PROVIDERS[/** @type {keyof typeof NATIVE_PROVIDERS} */ (native.provider)] ?? null;
  const effectiveMode = !enabled ? 'off' : storedMode;

  /** @type {any} */
  const base = {
    enabled,
    storedMode,
    effectiveMode,
    active: false,
    provider: native.provider,
    providerKnown: Boolean(adapter),
    providerLabel: adapter?.label ?? (native.provider || '未选择'),
    protocol: adapter?.protocol ?? '尚未适配',
    transport: adapter?.transport ?? '',
    requestFields: adapter?.requestFields ?? '',
    evidence: adapter?.evidence ?? { structuredSources: false, inlineRefs: false, toolEvent: false },
    limitsText: adapter?.limitsText
      ?? '这个服务商还没有适配：选择它不会发送任何联网参数，也不会按别的服务商协议发。',
    offPolicy: adapter?.offPolicy
      ?? { explicit: false, text: '未选择受支持的服务商时，不会发送任何联网参数。' },
    maxResults: native.maxResults,
    plan: null,
  };

  if (effectiveMode !== 'native' || !adapter) return base;

  const built = adapter.build({ maxResults: native.maxResults });
  base.active = true;
  base.plan = {
    provider: adapter.id,
    label: adapter.label,
    protocol: adapter.protocol,
    // 请求里要追加的工具体（与 function tools 合并，不覆盖）
    tools: built.tools,
    // 请求体要合并的字段
    bodyPatch: built.bodyPatch,
    // 证据收集用的适配器 id（解析时再查表，保持 plan 可序列化/可断言）
    evidenceKind: adapter.id,
  };
  return base;
}

/**
 * 创建一个证据收集器。
 *
 * 生命周期：一次模型请求一个收集器；`pushChunk` 收到每个 SSE chunk，
 * `finish(text)` 收尾（正文角标只能在这里看）。
 *
 * @param {object} plan `resolveNativeSearch().plan`
 * @returns {{pushChunk: (chunk: any) => void, finish: (text: string) => object}}
 */
export function createEvidenceCollector(plan) {
  const adapter = NATIVE_PROVIDERS[/** @type {keyof typeof NATIVE_PROVIDERS} */ (plan?.provider)] ?? null;
  /** @type {EvidenceState} */
  const state = { sources: new Map(), inlineRefs: new Set(), seenRefer: false };

  return {
    pushChunk(chunk) {
      if (!adapter) return;
      try {
        adapter.collect(chunk, state);
      } catch {
        /* 解析证据失败不该打断整条流：证据缺失最多是 unknown */
      }
    },
    finish(text) {
      if (!adapter) return null;
      try {
        adapter.finalize(state, String(text ?? ''));
      } catch {
        /* 同上 */
      }
      return buildReport(plan, state);
    },
  };
}

/**
 * 把一轮（可能多次模型调用）的证据合并。
 *
 * 状态优先级：rejected > searched > unknown。
 * 「有一次调用真的带回了引用」就足以说明这轮联网发生过；但只要有明确拒绝，
 * 就必须让用户先看到拒绝（因为那意味着参数可能被丢掉过）。
 *
 * @param {object|null} prev
 * @param {object|null} next
 * @returns {object|null}
 */
export function mergeNativeSearchReports(prev, next) {
  if (!prev) return next ?? null;
  if (!next) return prev;
  const sources = new Map();
  /*
   * 合并也保持"第一次出现优先"：多轮调用里同一个 URL 可能重复出现，
   * 标题应以最早那条为准，避免最终展示随轮次漂移。
   */
  for (const s of [...(prev.sources ?? []), ...(next.sources ?? [])]) {
    if (s?.url && !sources.has(s.url)) sources.set(s.url, s);
  }
  const inlineRefs = new Set([...(prev.inlineRefs ?? []), ...(next.inlineRefs ?? [])]);
  const status = pickStatus(prev.status, next.status);
  return {
    ...prev,
    ...next,
    status,
    kind: pickKind(prev.kind, next.kind),
    sources: [...sources.values()].slice(0, MAX_SOURCES),
    inlineRefs: [...inlineRefs],
    rounds: (prev.rounds ?? 1) + (next.rounds ?? 1),
    detail: pickDetail(prev, next, status),
  };
}

/**
 * 上游明确拒绝联网参数时，给用户看的结果。
 *
 * 调用方（client）会在拒绝后用**不带联网参数**的请求重试一次，避免
 * 因为一个可选能力把整轮对话打死；重试成功时仍把这个状态带回去，
 * 让界面如实说"这次没有用上原生联网"。
 *
 * @param {{provider?: string}|null} plan
 * @param {string} message
 * @param {boolean} [fallback]
 * @returns {object}
 */
export function rejectedNativeSearchReport(plan, message, fallback = false) {
  const adapter = NATIVE_PROVIDERS[/** @type {keyof typeof NATIVE_PROVIDERS} */ (plan?.provider)] ?? null;
  return {
    provider: plan?.provider ?? '',
    providerLabel: adapter?.label ?? '',
    status: 'rejected',
    kind: 'none',
    sources: [],
    inlineRefs: [],
    rounds: 1,
    fallback: fallback === true,
    detail:
      `上游拒绝了原生联网参数（${clip(String(message ?? ''), 200)}）。`
      + (fallback
        ? '已自动改用不带联网参数的请求重试一次；这次回答没有使用原生联网。'
        : '没有重试。'),
  };
}

/**
 * 没有任何证据时的状态。
 *
 * 这不是失败，也不是成功 —— 必须原样标成"无法确认"。
 *
 * @param {string} provider
 * @returns {object}
 */
export function uncertainNativeSearchReport(provider) {
  const adapter = NATIVE_PROVIDERS[/** @type {keyof typeof NATIVE_PROVIDERS} */ (provider)] ?? null;
  return {
    provider,
    providerLabel: adapter?.label ?? provider,
    status: 'unknown',
    kind: 'none',
    sources: [],
    inlineRefs: [],
    rounds: 1,
    detail:
      '请求已带联网声明，但上游没有返回任何可验证的搜索证据（引用/来源/角标）。'
      + '这可能是中转忽略了参数，也可能是模型判断本次无需检索 —— 无法确认是否真的联网。',
  };
}

/**
 * 判断一次失败是不是"上游不接受原生联网参数"。
 *
 * ## 为什么要窄
 *
 * 判宽了的后果：普通的 400（max_tokens 越界、消息顺序不对）会被当成
 * "不支持联网"，然后我们在不带联网的情况下重试一次 —— 真正的问题被掩盖，
 * 用户还以为"关掉联网就好了"。
 *
 * 所以是两重条件：状态码 ∈ {400, 404, 422}，**且**错误文本里出现
 * 联网参数/工具的具体名字或"未知字段"这类明确措辞。
 *
 * @param {unknown} status
 * @param {unknown} message
 * @returns {boolean}
 */
export function looksLikeNativeSearchRejection(status, message) {
  const code = Number(status);
  if (![400, 404, 422].includes(code)) return false;
  const text = String(message ?? '').toLowerCase();
  if (!text) return false;
  return [
    'web_search_options',
    'web_search',
    'enable_search',
    'search_options',
    'unknown field',
    'unrecognized request argument',
    'unsupported parameter',
    '不支持的参数',
    '未知参数',
    '无法识别',
  ].some((needle) => text.includes(needle));
}

/**
 * 从正文里提取 `[来源：ref_N]` 角标。
 *
 * 全角/半角冒号都认，`ref` 大小写不敏感。**只认这个协议约定的形状**，
 * 不把任意 `[1]`、`[来源]` 当证据 —— 那会把模型自己的编号也误判成检索。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function collectInlineRefs(text) {
  const s = String(text ?? '');
  const out = new Set();
  const re = /\[来源\s*[:：]\s*(ref_\d+)\]/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    out.add(String(m[1]).toLowerCase());
  }
  return [...out];
}

/* ------------------------------------------------------------ 内部 */

/**
 * @param {object} plan
 * @param {EvidenceState} state
 * @returns {object}
 */
function buildReport(plan, state) {
  const sources = [...state.sources.values()].slice(0, MAX_SOURCES);
  const inlineRefs = [...state.inlineRefs];
  const hasStructured = sources.length > 0;
  const hasInline = inlineRefs.length > 0;

  if (!hasStructured && !hasInline) {
    const report = uncertainNativeSearchReport(plan.provider);
    return { ...report, providerLabel: plan.label, rounds: 1 };
  }

  const kind = hasStructured && hasInline
    ? 'url_citation'
    : hasStructured
      ? 'url_citation'
      : 'inline_ref';

  return {
    provider: plan.provider,
    providerLabel: plan.label,
    status: 'searched',
    kind,
    sources,
    inlineRefs,
    rounds: 1,
    detail: hasStructured
      ? `上游返回了 ${sources.length} 条结构化来源。`
      : `正文出现 ${inlineRefs.length} 个来源角标（${inlineRefs.slice(0, 3).join('、')}${inlineRefs.length > 3 ? '…' : ''}），`
        + '但本次响应没有返回结构化来源列表，无法核对具体链接。',
  };
}

/**
 * @param {any} raw
 * @returns {object|null}
 */
function normalizeSource(raw) {
  const url = typeof raw?.url === 'string' ? raw.url.trim() : '';
  if (!url || url.length > 2048) return null;
  const shape = validateUrlShape(url);
  if (!shape.ok) return null;
  let title = clip(String(raw?.title ?? '').trim(), TITLE_MAX_CHARS);
  if (!title) {
    try {
      title = new URL(url).hostname;
    } catch {
      title = url;
    }
  }
  return {
    title,
    url,
    ...(raw?.snippet ? { snippet: clip(String(raw.snippet).trim(), SNIPPET_MAX_CHARS) } : {}),
    ...(raw?.publishedDate ? { publishedDate: clip(String(raw.publishedDate).trim(), 64) } : {}),
  };
}

/**
 * @param {any[]} annotations
 * @param {EvidenceState} state
 */
function collectAnnotations(annotations, state) {
  for (const item of annotations) {
    if (!item || typeof item !== 'object') continue;
    // 只认协议定义的 url_citation；别的 type 不猜。
    if (String(item.type ?? '') !== 'url_citation') continue;
    const cite = item.url_citation ?? item;
    const source = normalizeSource({
      title: cite?.title,
      url: cite?.url,
    });
    if (source) pushSource(state, source);
  }
}

/**
 * @param {EvidenceState} state
 * @param {object} source
 */
function pushSource(state, source) {
  /*
   * 同 URL 只保留**第一次**出现的那条。
   *
   * 上游可能把同一个链接重复回传（不同角标位置、不同标题），后写覆盖
   * 会让来源标题随着流式到达顺序漂移，用户看到的标题就取决于最后一个
   * chunk —— 那不是一个可复现的结果。
   */
  if (state.sources.has(source.url)) return;
  if (state.sources.size >= MAX_SOURCES) return;
  state.sources.set(source.url, source);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function pickStatus(a, b) {
  if (a === 'rejected' || b === 'rejected') return 'rejected';
  if (a === 'searched' || b === 'searched') return 'searched';
  return 'unknown';
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function pickKind(a, b) {
  if (b === 'url_citation' || a === 'url_citation') return 'url_citation';
  if (b === 'web_search' || a === 'web_search') return 'web_search';
  if (b === 'inline_ref' || a === 'inline_ref') return 'inline_ref';
  return 'none';
}

/**
 * @param {any} prev
 * @param {any} next
 * @param {string} status
 * @returns {string}
 */
function pickDetail(prev, next, status) {
  if (status === 'rejected') return next.status === 'rejected' ? next.detail : prev.detail;
  if (status === 'searched') return next.status === 'searched' ? next.detail : prev.detail;
  return next.detail || prev.detail || '';
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
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function clip(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
