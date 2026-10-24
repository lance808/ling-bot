/**
 * 联网状态视图 —— 界面与快照的唯一形状来源
 *
 * ## 为什么单独一个文件
 *
 * 这一块的语义是"三个独立条件同时成立才可用"：
 *
 *   1. 总闸开着（`network.enabled`）
 *   2. 插件启用且在跑（`plugins.enabled` 里有点名、状态是 ready）
 *   3. 插件配好了（有 baseUrl 与解密得到的 Key）
 *
 * 三个条件**必须分开显示**。合并成一句"不可用"是最典型的信息丢失：
 *
 *   · 总闸关着 → 用户会去插件页翻半天（那里一切正常）
 *   · 没配 Key → 用户会以为"搜不到东西"，于是换搜索词反复试
 *   · 插件没启用 → 用户会以为总闸关了
 *
 * 所以这里给出 `effective` 四态 + 一句人话，界面逐格显示，不自行推导。
 *
 * ## 与 vision 页同一条纪律
 *
 * `configured === false` 不等于"坏了"，`enabled === false` 不等于"不支持"。
 * 界面上的"未配置"与"失败"是两种完全不同的状态。
 */

import { networkEnabledFrom } from './gate.mjs';
import { normalizeNetConfig, SUPPORTED_PROVIDERS } from './host-net.mjs';
import { resolveNativeSearch } from '../llm/provider-search.mjs';

/**
 * 本插件暴露的工具全名。
 *
 * 这里是**写死的名单**而不是前缀匹配：禁用判定 `isToolDisabled` 只做精确
 * 比较，前缀匹配会让"关掉联网搜索"顺手关掉将来一个 `web_search_history`。
 *
 * @type {ReadonlyArray<string>}
 */
export const NET_TOOL_NAMES = Object.freeze(['plugin_web_search', 'plugin_web_fetch']);

/** 插件 id（配置与启用列表里的键） */
export const NET_PLUGIN_ID = 'web-search';

/**
 * 四个实际效果态的文案。
 *
 * 每一行回答的是"用户该期待什么"，不是"系统内部是什么状态"。
 */
export const NET_EFFECTIVE = Object.freeze({
  off: {
    tone: 'dim',
    pill: '联网已关闭',
    text: '总开关关着：搜索与网页读取都不会发出任何请求，AI 的工具列表里也没有它们。',
  },
  'no-plugin': {
    tone: 'warn',
    pill: '插件未启用',
    text: '联网开着，但「联网搜索」插件没有启用 —— AI 看不到搜索工具。去《插件设置》启用它。',
  },
  'needs-config': {
    tone: 'warn',
    pill: '未就绪',
    text: '插件已启用，但还没有就绪：调用会明确失败（不是「搜不到结果」）。',
  },
  on: {
    tone: 'ok',
    pill: '搜索可用',
    text: '搜索与网页读取都可用（只对管理员私聊与桌面端开放）。',
  },
  /*
   * 原生联网两态。
   *
   * 与「独立搜索 API」分开命名，是因为用户下一步动作完全不同：
   * 前者去选服务商，后者去填 Key / 启用插件。合并成一格会让人找错地方。
   */
  native: {
    tone: 'ok',
    pill: '原生联网',
    text: '服务商原生联网已开启：检索由模型服务商在其自己的服务端完成，Ling-bot 不代发搜索请求。',
  },
  'native-needs-config': {
    tone: 'warn',
    pill: '原生联网未配置',
    text: '已选择服务商原生联网，但还没有选择受支持的服务商：不会发送任何联网参数。',
  },
});

/**
 * 插件状态 → 用户该做什么。
 *
 * 这些状态以前被统一塞进「缺配置」那一格，于是插件崩溃、清单不合法、
 * 文件待重载都会显示"缺 API Key" —— 用户去填一个早就填好的 Key，
 * 然后发现还是不行。原因与结论必须分开。
 */
const PLUGIN_STATUS_REASON = Object.freeze({
  'needs-config': '插件还没有配置完成：去《插件设置 → 联网搜索》填 API Key 与服务地址。',
  starting: '插件正在启动：稍等片刻再看；如果一直停在这里，去插件页看日志。',
  error: '插件初始化失败：去《插件设置 → 联网搜索》看错误信息，修好后点重载。',
  crashed: '插件运行中崩溃：去《插件设置》重载它，或查看日志里的错误码。',
  invalid: '插件清单不合法：重新安装内置插件，或检查插件文件是否被改动。',
  incompatible: '插件接口版本不兼容：需要更新 Ling-bot 或该插件。',
  missing: '插件目录缺失：重新安装内置插件。',
  stale: '插件文件有更新但尚未重载：去《插件设置》点重载后才会生效。',
  unknown: '插件状态未知：它可能还在启动，或快照暂时拿不到状态；稍后再看或去插件页确认。',
  disabled: '插件未启用：去《插件设置》启用「联网搜索」。',
});

/**
 * 判定实际效果。
 *
 * 顺序是刻意的：总闸优先级最高。总闸关着时，即使插件一切正常，
 * 实际效果也只能是 `off` —— 反过来显示"搜索可用"会让用户去点一个
 * 必然失败的按钮。
 *
 * @param {object} input
 * @param {boolean} input.enabled 总闸
 * @param {boolean} input.pluginEnabled 插件是否在启用列表里
 * @param {string} [input.pluginStatus] 插件状态
 * @param {boolean} input.configured 是否配好（baseUrl + Key）
 * @param {'api'|'native'} [input.mode] 存储的联网通道
 * @param {boolean} [input.nativeReady] 原生通道是否选了受支持的服务商
 * @returns {'off' | 'no-plugin' | 'needs-config' | 'on' | 'native' | 'native-needs-config'}
 */
export function resolveNetEffective(input) {
  if (!input?.enabled) return 'off';
  /*
   * 原生通道优先：它不使用插件配置，也不该因为插件没启用而显示成
   * "插件未启用" —— 那会让用户去启用一个反正不会被用到的插件。
   */
  if (input?.mode === 'native') {
    return input?.nativeReady === true ? 'native' : 'native-needs-config';
  }
  if (!input?.pluginEnabled) return 'no-plugin';
  // 插件启用但跑不起来（缺配置 / 报错 / 加载失败）→ 统一归到 needs-config，
  // 因为对用户来说下一步动作是同一个：去插件页看它说什么。
  if (input?.pluginStatus && input.pluginStatus !== 'ready') return 'needs-config';
  if (!input?.configured) return 'needs-config';
  return 'on';
}

/**
 * 组装快照里的 `network` 块。
 *
 * **永不抛错**：它是一块展示数据，算不出来只该让这一块空着，
 * 不该把整份快照（连接状态、消息、待确认项）一起拖垮。
 *
 * @param {object} input
 * @param {any} input.config 当前配置
 * @param {object | null} [input.plugin] 插件快照项（`{enabled, status, config}`）
 * @param {boolean} [input.hasSecret] 是否有已保存的 API Key（**不回显明文**）
 * @param {object} [input.stats] 运行统计（宿主持有）
 * @param {object} [input.nativeRuntime] 原生联网运行状态（宿主持有：`{last, stats}`）
 * @param {(name: string) => boolean} [input.toolVisible] 本回合某工具是否可见
 * @returns {object}
 */
export function buildNetView(input) {
  try {
    const cfg = input?.config ?? {};
    const enabled = networkEnabledFrom(cfg);
    const declared = pluginConfigOf(input?.plugin) ?? cfg?.plugins?.config?.[NET_PLUGIN_ID] ?? {};
    const net = normalizeNetConfig(declared);
    const native = resolveNativeSearch(cfg);
    const pluginEnabled = input?.plugin?.enabled === true;
    const pluginStatus = String(input?.plugin?.status ?? '');
    const hasSecret = input?.hasSecret === true || input?.plugin?.hasSecret === true;
    const providerOk = SUPPORTED_PROVIDERS.includes(net.provider);
    /*
     * 「配好了」= 有 Key + 地址合法 + 协议被支持。
     *
     * 只检查 Key 会让"地址写错/服务类型填错"显示成可用，用户点试搜
     * 只会得到超时或协议错误，却不知道去哪改。
     */
    const configured = hasSecret && Boolean(net.baseUrl) && providerOk;
    const effective = resolveNetEffective({
      enabled,
      pluginEnabled,
      pluginStatus,
      configured,
      mode: native.storedMode,
      nativeReady: native.providerKnown,
    });
    const eff = NET_EFFECTIVE[effective];
    const stats = normalizeStats(input?.stats);
    const toolVisible = typeof input?.toolVisible === 'function' ? input.toolVisible : () => effective === 'on';

    /*
     * 原生模式下**不展示任何插件联网工具**。
     *
     * 理由不是"怕重复调用"，而是"不该让两条通道同时可用"：用户选了
     * 原生联网，却还看得到 `plugin_web_search`，模型很可能两条都走一遍 ——
     * 一次问题两份检索账单。这里让它结构性不可见，比在运行时拒绝更确定。
     * （`disabledNetTools` 另有一层同样的判定，防止快照滞后时漏掉。）
     */
    const tools = effective === 'on'
      ? NET_TOOL_NAMES.filter((name) => (name !== 'plugin_web_fetch' || net.allowFetch === true) && toolVisible(name))
      : [];

    const detail = effectiveDetail({
      effective,
      enabled,
      pluginEnabled,
      pluginStatus,
      providerOk,
      provider: net.provider,
      hasSecret,
      baseUrl: net.baseUrl,
      allowFetch: net.allowFetch,
      native,
    });
    const effectiveText = effective === 'on'
      ? (net.allowFetch === true
        ? eff.text
        : '搜索可用；网页正文读取已关闭（allowFetch: false），AI 的工具列表里只有搜索。')
      : (detail.text || eff.text);

    return {
      enabled,
      /** 存储的通道（`api` / `native`），用于界面单选框回显 */
      mode: native.storedMode,
      /** 实际生效的通道（总闸关着时是 `off`） */
      effectiveMode: native.effectiveMode,
      provider: net.provider,
      baseUrl: net.baseUrl,
      maxResults: net.maxResults,
      timeoutMs: net.timeoutMs,
      searchDepth: net.searchDepth,
      allowFetch: net.allowFetch,
      maxFetchBytes: net.maxFetchBytes,
      fetchTimeoutMs: net.fetchTimeoutMs,
      configured,
      plugin: {
        id: NET_PLUGIN_ID,
        enabled: pluginEnabled,
        status: pluginStatus || (pluginEnabled ? 'unknown' : 'disabled'),
        configured,
      },
      /** 服务商原生联网：请求协议、限制、关闭语义与上次证据 */
      native: buildNativeView(native, input?.nativeRuntime),
      effective,
      effectiveText,
      /** 具体原因/下一步（界面展示；比 effectiveText 更细，不改变状态枚举） */
      effectiveDetail: detail.detail,
      effectivePill: eff.pill,
      effectiveTone: eff.tone,
      // 工具可见性按**开关现算**：总闸关着时一定是空数组，
      // 界面不该自己再推一遍（两处都推必然漂移）
      tools,
      stats,
    };
  } catch (err) {
    return {
      enabled: false,
      mode: 'api',
      effectiveMode: 'off',
      provider: 'tavily',
      baseUrl: '',
      maxResults: 5,
      timeoutMs: 15_000,
      searchDepth: 'basic',
      allowFetch: true,
      maxFetchBytes: 200 * 1024,
      fetchTimeoutMs: 10_000,
      configured: false,
      plugin: { id: NET_PLUGIN_ID, enabled: false, status: 'unknown', configured: false },
      native: emptyNativeView(),
      effective: 'no-plugin',
      effectiveText: '联网状态计算失败（不影响对话）',
      effectiveDetail: '联网状态计算失败（不影响对话）',
      effectivePill: '状态未知',
      effectiveTone: 'warn',
      tools: [],
      stats: normalizeStats(null),
      lastError: String(/** @type {any} */ (err)?.message ?? err),
    };
  }
}

/**
 * 原生联网在快照里的形状。
 *
 * 字段一个不少：界面按字段取值，少一个就会在"出过错之后"整页 undefined。
 * `last` 是**后端记录的最近一次证据**，不是前端推算。
 *
 * @param {ReturnType<typeof resolveNativeSearch>} native
 * @param {any} [runtime]
 * @returns {object}
 */
function buildNativeView(native, runtime) {
  const st = runtime && typeof runtime === 'object' ? runtime : {};
  const counts = st.stats && typeof st.stats === 'object' ? st.stats : st;
  const lastRaw = st.last && typeof st.last === 'object' ? st.last : null;

  /** @type {object|null} */
  const last = lastRaw
    ? {
      at: Number(lastRaw.at) || null,
      provider: String(lastRaw.provider ?? ''),
      status: NATIVE_LAST_STATUSES.has(String(lastRaw.status)) ? String(lastRaw.status) : 'unknown',
      kind: NATIVE_LAST_KINDS.has(String(lastRaw.kind)) ? String(lastRaw.kind) : 'none',
      sources: (Array.isArray(lastRaw.sources) ? lastRaw.sources : [])
        .filter((s) => s && typeof s.url === 'string' && s.url)
        .slice(0, 5)
        .map((s) => ({ title: String(s.title ?? ''), url: String(s.url) })),
      inlineRefs: Math.max(0, Math.trunc(Number(lastRaw.inlineRefs) || 0)),
      detail: String(lastRaw.detail ?? '').slice(0, 400),
    }
    : null;

  return {
    provider: native.provider,
    providerLabel: native.providerLabel,
    providerKnown: native.providerKnown,
    protocol: native.protocol,
    transport: native.transport,
    requestFields: native.requestFields,
    active: native.active,
    configured: native.providerKnown,
    evidence: { ...native.evidence },
    offPolicy: { ...native.offPolicy },
    limitsText: native.limitsText,
    last,
    stats: {
      requests: Math.max(0, Math.trunc(Number(counts.requests) || 0)),
      evidence: Math.max(0, Math.trunc(Number(counts.evidence) || 0)),
      noEvidence: Math.max(0, Math.trunc(Number(counts.noEvidence) || 0)),
      rejected: Math.max(0, Math.trunc(Number(counts.rejected) || 0)),
      lastAt: Number(counts.lastAt) || null,
    },
  };
}

/** 证据状态枚举（后端只认这五种，别让脏值直接显示到界面） */
const NATIVE_LAST_STATUSES = new Set(['searched', 'unknown', 'rejected', 'not-requested', 'unavailable']);
/** 证据种类枚举 */
const NATIVE_LAST_KINDS = new Set(['url_citation', 'web_search', 'inline_ref', 'none']);

/**
 * 计算失败时的原生块兜底（形状与正常路径一致）。
 *
 * @returns {object}
 */
function emptyNativeView() {
  return {
    provider: '',
    providerLabel: '未选择',
    providerKnown: false,
    protocol: '尚未适配',
    transport: '',
    requestFields: '',
    active: false,
    configured: false,
    evidence: { structuredSources: false, inlineRefs: false, toolEvent: false },
    offPolicy: { explicit: false, text: '未选择受支持的服务商时，不会发送任何联网参数。' },
    limitsText: '联网状态计算失败，原生联网说明不可用。',
    last: null,
    stats: { requests: 0, evidence: 0, noEvidence: 0, rejected: 0, lastAt: null },
  };
}

/**
 * 生成「具体原因 + 下一步」。
 *
 * 四态不变（界面只认四态），但同一态里的原因必须说真话：
 * 插件崩溃与缺 Key 都归 needs-config，却不该给同一句"去填 Key"。
 *
 * @param {object} input
 * @returns {{text: string, detail: string}}
 */
function effectiveDetail(input) {
  const pick = (text, detail) => ({ text, detail });
  if (input.effective === 'off') {
    return pick(
      '联网已关闭：不会发送任何联网声明或搜索工具，独立搜索 API 与原生联网都不会发生。',
      '总闸关着：独立搜索的 search/fetch 返回 E4080 且零请求，模型请求里也不会带原生联网字段；'
      + '在途的独立搜索请求会被立即中止。已经发出的模型请求里若带了联网声明，无法收回，'
      + '但服务商是否真的检索，Ling-bot 看不到也无法验证。',
    );
  }
  if (input.effective === 'native' || input.effective === 'native-needs-config') {
    const native = input.native ?? {};
    if (input.effective === 'native-needs-config') {
      return pick(
        '已选择服务商原生联网，但还没有选择受支持的服务商：不会发送任何联网参数。',
        '在《联网搜索 → 联网模式》里选择「智谱 GLM」或「OpenAI」。'
        + '未适配的服务商不会被按别家协议发送（不按模型名猜测）。',
      );
    }
    return pick(
      `${native.providerLabel ?? ''} 原生联网已开启：检索由服务商在其自己的服务端完成。`,
      'Ling-bot 只在模型请求里声明联网；本次是否真的检索，以下一次响应带回的引用/来源为准。'
      + '没有引用/来源时只会标成「无法确认」，不会把 HTTP 200 当成联网成功。'
      + '原生模式下插件搜索工具被结构性隐藏，避免两条通道各搜一遍。',
    );
  }
  if (input.effective === 'no-plugin') {
    return pick(
      NET_EFFECTIVE['no-plugin'].text,
      input.pluginEnabled
        ? '插件在启用列表里，但还没有进入可用状态；去《插件设置》看它的状态与日志。'
        : '去《插件设置》启用「联网搜索」并保存；默认配置下它是不启用的。',
    );
  }
  if (input.effective === 'needs-config') {
    if (input.pluginStatus && input.pluginStatus !== 'ready') {
      return pick(
        `插件没有就绪（${input.pluginStatus}）—— 这不是「缺 Key」的同义词。`,
        PLUGIN_STATUS_REASON[input.pluginStatus] ?? `插件状态为「${input.pluginStatus}」：去插件页查看错误与日志。`,
      );
    }
    if (!input.providerOk) {
      return pick(
        `服务类型「${input.provider}」不受支持，搜索会被明确拒绝（E4081）。`,
        '本轮只实现了 Tavily Search API；把「服务类型」改回 tavily，或等后续版本适配。',
      );
    }
    if (!input.baseUrl) {
      return pick(
        '服务地址不合法或为空：搜索会失败（E4081），不是「搜不到结果」。',
        '去《插件设置 → 联网搜索》检查服务地址（只填到域名，必须 http(s)，不能带查询参数或账号密码）。',
      );
    }
    return pick(
      '还没有配置 API Key：调用会失败（E4081），不是「搜不到结果」。',
      '去《插件设置 → 联网搜索》的 API Key 那一项填上并保存；它只存在本机加密保险箱，不会回显。',
    );
  }
  return pick(
    NET_EFFECTIVE.on.text,
    input.allowFetch === true
      ? '总闸、插件、Key 三者齐备；工具只对管理员私聊与桌面端可见。'
      : '总闸、插件、Key 三者齐备；网页正文读取被配置关闭，只有搜索工具可见。',
  );
}

/**
 * 插件记录 → 它的普通配置对象。
 *
 * `pluginSnapshot` 里配置是数组（`[{key, value}]`），而运行时用的是对象。
 * 这里把两种形状都认下来 —— 快照里两种都可能出现（不同版本）。
 *
 * @param {any} plugin
 * @returns {Record<string, any> | null}
 */
function pluginConfigOf(plugin) {
  const raw = plugin?.config;
  if (!raw) return null;
  if (!Array.isArray(raw)) return typeof raw === 'object' ? raw : null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const f of raw) {
    if (f && typeof f.key === 'string') out[f.key] = f.value;
  }
  return out;
}

/**
 * 统计对象的形状兜底。
 *
 * 字段一个不少，否则界面在"出过错之后"会显示 undefined。
 *
 * @param {any} stats
 * @returns {object}
 */
export function normalizeStats(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const lastError = s.lastError && typeof s.lastError === 'object'
    ? {
      code: String(s.lastError.code ?? 'E50XX'),
      message: String(s.lastError.message ?? '').slice(0, 300),
      at: Number(s.lastError.at) || null,
    }
    : null;
  return {
    searches: Number(s.searches) || 0,
    fetches: Number(s.fetches) || 0,
    failures: Number(s.failures) || 0,
    cancelled: Number(s.cancelled) || 0,
    lastAt: Number(s.lastAt) || null,
    lastError,
  };
}

/**
 * 新建一份统计对象（宿主持有，工厂往里累加）。
 *
 * @returns {object}
 */
export function createNetStats() {
  return { searches: 0, fetches: 0, failures: 0, cancelled: 0, lastAt: null, lastError: null };
}

/**
 * 联网关闭时，本回合应当结构性不可见的工具名单。
 *
 * 返回 `null` 表示"不额外禁用"（与 `makeRunner` 的 `disabledTools: null`
 * 语义一致）。返回数组时由调用方与其它来源（例如人格禁用的表情工具）合并。
 *
 * @param {unknown} config
 * @returns {string[] | null}
 */
export function disabledNetTools(config) {
  /*
   * 原生联网模式下也把插件联网工具整体藏起来。
   *
   * 这一层不能只靠快照的 `tools` 列表：快照有轮询间隔，而工具可见性是
   * 每个回合现算的。快照还没刷新时，模型仍可能看到 `plugin_web_search`
   * 并调它 —— 那会出现"原生联网 + 插件搜索"两条通道各搜一遍。
   * 这里与 `buildNetView` 是同一判定的两处落地，语义必须一致。
   */
  const native = resolveNativeSearch(config);
  if (!native.enabled) return [...NET_TOOL_NAMES];
  if (native.effectiveMode === 'native') return [...NET_TOOL_NAMES];
  return null;
}
