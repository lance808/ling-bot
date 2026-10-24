/**
 * 联网搜索设置区块 —— AI 到底能不能上网搜东西
 *
 * ## 它现在挂在哪里
 *
 * 原来是一个独立侧栏页（`web-search`）。现在**并入《插件设置》**：选中
 * 「联网搜索」插件后，在插件列表与插件详情之间渲染这一块。侧栏不再单独占一页。
 *
 * 为什么这么放：用户要改的东西（独立搜索的 Key/地址、总开关、三态模式、
 * 原生服务商）本质上都在回答同一个问题 ——「这台机器上的联网怎么配」。
 * 分在「插件页」和另一个「联网页」两处时，用户看到"插件已启用"却搜不到，
 * 还得判断是总闸关着、Key 没存，还是走了原生通道。放在同一页可以一次看完。
 *
 * 语义边界仍要写清：总开关 / 模式 / 原生服务商是**宿主级**设置，
 * 不是插件清单里的配置项；插件自己的地址、Key、条数等仍由插件配置表单管。
 *
 * ## 这一块要回答什么
 *
 * 用户点进来通常是因为一句话：「它说它不能联网」或者反过来「我明明关了它还在瞎编」。
 * 两种困惑的根因都在这里，但**不是同一个**。
 *
 * 所以按"先看结论、再改意图、再看证据"的顺序排成七块：
 *
 *   1. 实际效果     —— 现在到底能不能搜（只认后端给的 `network.effective`）
 *   2. 总开关       —— 你想不想让它发送联网声明 / 联网工具（可改）
 *   3. 联网模式     —— 关闭 / 独立搜索 API / 服务商原生联网（三态，可改）
 *   4. 原生联网证据 —— 协议、限制、上次引用、计数（只做事实回显，不推导）
 *   5. 服务配置     —— 用哪个服务、多少条、等多久、有没有 Key（只读回显）
 *   6. 试搜         —— 真发一次请求，看上游到底返回什么（动词，可复现）
 *   7. 运行统计     —— 这一版真的搜过几次、错过什么（只读）
 *
 * ## 为什么"实际效果"只读 `snap.network.effective`，不在前端再推一遍
 *
 * 这一态是三个独立条件的合取：总闸开着 + 插件启用且在跑 + 有 baseUrl 与 Key。
 * 前端再推一遍意味着同一套判定存在两份实现，而它们一定会漂移：
 * 某一轮改了宿主里的判定顺序（比如"插件崩溃"该归到 needs-config 还是 no-plugin），
 * 界面还在按老顺序显示 —— 于是界面写着「搜索可用」，点下去返回 E4080。
 * 这种自相矛盾比空白更难排查。所以本块**一律不推导**，只做形状兜底。
 *
 * 兜底为什么落在 `no-plugin`（见 `effectiveKey()`）：三种可能的错误里，
 * 只有这一格的下一步动作对三种情况都安全 —— 去本页的插件列表看一眼。
 *
 * ## 为什么"未配置"绝不能显示成"不可用"
 *
 * 「不可用」是一个**结论**，而「未配置」是一个**原因**。把原因写成结论，
 * 用户能得到的唯一动作是"再试一次"（因为他不知道要改什么）：
 *
 *   · 没 Key → 他会去换搜索词、查网络，而正确动作是填 Key；
 *   · 插件没启用 → 他会以为总闸关了，跑去开关那里来回点；
 *   · 总闸关着 → 他会去插件页翻半天，而那里一切正常。
 *
 * 所以四态各有各的文案与颜色，逐格显示，不合并（契约 §6）。
 *
 * ## 为什么总开关的文案现在说的是"是否发送联网声明 / 联网工具"
 *
 * 以前这一页只能承诺"不管服务商侧检索"，因为 Ling-bot 根本不往模型请求里放
 * 任何联网声明。加入「服务商原生联网」之后，开关的作用面变成两层，必须分开写：
 *
 *   1. **结构性、可验证的那层**：关掉后 Ling-bot 不再发送任何联网声明与联网工具，
 *      独立搜索的两个插件工具（`web_search` / `web_fetch`）也不在执行链里
 *      （后端结构性隐藏，不是"看得到但调用失败"）；
 *   2. **不可验证的那层**：服务商是否仍在它自己服务端自行检索（例如把联网默认打开、
 *      或模型自带的知识新鲜到看起来像刚查过）—— 这一层我们看不见、也拦不住。
 *
 * 所以文案只承诺第一层，第二层如实说"无法验证"。把"关掉就彻底断网"写成事实，
 * 是最容易被用户当场证伪的一类文案：他关掉开关后模型仍能说出新信息，就会认定
 * 这个开关是假的，从此不再信任它。
 *
 * ## 为什么是"三态"而不是两个独立开关
 *
 * 关闭 / 独立搜索 API / 服务商原生联网 是三种**互斥的执行方式**，不是三个布尔。
 * 两个独立开关的组合会造出"两个都开"这种既没定义、又要用户自己猜谁生效的状态：
 * 同一回合既注入独立搜索的两个插件工具（`web_search` / `web_fetch`）、
 * 又发送服务商原生联网声明，等于一次提问花两份检索额度，而且两份结果还会互相重复。
 *
 * 所以：关闭不是一个存储值，而是总开关（`network.enabled`）关掉后的**效果**；
 * 单选框只有两项（`network.mode` = `api` / `native`），关闭态由上面那张卡表达。
 * 总开关关着时给出"需先打开总开关"的提示，但**不清掉**已存模式 ——
 * 清掉意味着用户下次打开还要重选一次，而他只是临时关一下。
 *
 * ## 为什么原生联网的"证据"只认结构化引用
 *
 * 用户判断"它到底联没联网"时最容易抓错三类伪信号：HTTP 200（请求成功而已）、
 * 回答里的日期看起来是对的（可能来自训练数据或幻觉）、模型自己说"我联网查了"
 * （那是生成出来的文本，不是事实）。这三样都不能当证据。
 *
 * 真正可判定的是上游**结构化**返回：URL 引用条目（`url_citation`）、联网工具事件
 * （`web_search`）、正文内联引用（`inline_ref`）。后端把这些整理成
 * `native.last.status`，前端只按它显示，不自己再推一遍 —— 没有引用/来源时
 * 必须直说「无法确认是否真的联网」，而不是把"没有证据"写成"联网成功"。
 *
 * ## 为什么原生模式与独立 API 不默认同时执行
 *
 * 原生模式下后端结构性隐藏了**两个**独立搜索插件工具（`web_search` 与 `web_fetch`），
 * 工具列表里两个都没有。因为两条通道同时可用时，模型很可能两条都走一遍 ——
 * 同一句话花两份额度、还可能给出两组互相打架的来源。
 * 界面要把"两条通道默认只走一条"讲出来，否则用户会以为"是不是没同时开才搜不到"；
 * 也不能只提搜索工具：`web_fetch` 同样被隐藏，不能暗示它还能用。
 *
 * ## 为什么试搜要真发请求，而不是像别的页那样做个"测试连接"
 *
 * 插件的 `testConnection` 是自检：它只回答"宿主注入能力了吗、有没有 Key"，
 * **不发网络请求**。它证明不了三件事：baseUrl 对不对、协议对不对、额度还剩多少。
 * 而用户点"试搜"想知道的恰恰是这三件。真搜一次的代价是一次服务商额度，
 * 所以按钮上方必须写明"会消耗一次额度" —— 不能让人以为它和"测试连接"同价。
 *
 * ## 为什么结果里的 URL 只渲染成文本，不做成可点击链接
 *
 * 搜索结果是**外部内容**。在 Tauri 壳里直接给 `<a href>` 点击会导航整个
 * WebView（用户会"丢掉界面"），而外链该不该打开由壳的主机白名单裁定，
 * 不是页面能决定的。所以这里只把 URL 原样显示出来，让用户自己复制/核对。
 */

import { el, card, kv, pill, clock } from '../render.mjs';
import { action, setting } from '../api.mjs';

/**
 * 页面级状态。
 *
 * 必须在模块作用域：快照每 2 秒轮询、每次整页重建，
 * 写在 render 里的话"保存中…/已保存"、查询草稿、试搜结果
 * 都会跟着 DOM 一起消失 —— 用户点完按钮只看到它闪一下。
 */
const ui = {
  /** 总开关的保存反馈（null = 还没点过） */
  /** @type {{ok: boolean, text: string} | null} */
  lastSave: null,

  /**
   * 用户刚点过、但快照还没回显的开关意图（null = 没有待确认的改动）。
   *
   * 为什么需要它：`setting()` 返回成功不等于下一份快照已经回来了。
   * 这中间的 2 秒里若按快照渲染，勾选框会"自己弹回去"，
   * 用户会以为没点上，于是再点一次、再弹回去。用一个意图值先顶着，
   * 等快照追上来（`network.enabled === 意图值`）再丢掉。
   */
  /** @type {boolean | null} */
  pendingEnabled: null,

  /**
   * 模式单选的保存反馈与待确认意图（同 pendingEnabled 的理由）。
   *
   * 为什么也要一个 intent：`setting('network.mode', ...)` 成功只代表写进去了，
   * 快照要等下一轮。没有 intent 的话，单选会在 2 秒内弹回旧值 ——
   * 而"关闭/独立 API/原生"这三种状态在视觉上差别很大，弹回比勾选框更难被理解成"还没刷新"。
   */
  /** @type {{ok: boolean, text: string} | null} */
  modeSave: null,

  /** @type {'api' | 'native' | null} */
  pendingMode: null,

  /** 服务商下拉的保存反馈与待确认意图（理由同上） */
  /** @type {{ok: boolean, text: string} | null} */
  providerSave: null,

  /** @type {'' | 'zhipu' | 'openai' | null} */
  pendingProvider: null,

  /**
   * 查询草稿。
   *
   * 同样必须模块级：输入框在轮询重绘时会被销毁重建，
   * 值只存在 DOM 上就会在用户输入过程中被清空（焦点还在时 app 会跳过重绘，
   * 但一旦点走焦点、下一轮重绘就把它抹了）。
   */
  query: '',

  /** 本地校验的红字（空输入之类）。它不是"搜索失败"，所以不塞进 result */
  queryError: '',

  /**
   * 在途试搜计数。
   *
   * 用计数而不是布尔：`await` 之后回调可能在重绘后仍活着，
   * 数字能让按钮状态只回退到"还剩几个在跑"，不会因为一次提前返回
   * 就把另一个在途请求的 loading 态抹掉。
   */
  searching: 0,

  /** 最近一次试搜结果（结构见 normalizeSearchResult） */
  /** @type {any} */
  result: null,
};

/**
 * 四种实际效果（契约 §6 的表格）。
 *
 * 四种颜色是刻意的：`no-plugin` 与 `needs-config` 都不能用绿色，
 * 但也**不能共用同一种颜色** —— 共用就等于在视觉上又把四态合并成两类，
 * 而这两类的下一步动作完全不同（去启用插件 / 去填 Key）。
 *
 * `needs-config` 用 err 而不是 warn：它的结果是"调用必然失败"，
 * 不是"可能有点问题"。用户需要把它当成待办，而不是提示。
 */
const EFFECTIVE = Object.freeze({
  off: {
    tone: 'dim',
    pill: '联网已关闭',
    text:
      '总开关关着：Ling-bot 不会再发送任何联网声明 / 联网工具，自己发起的搜索与网页读取也不会发出请求'
      + '（AI 的工具列表里没有它们）。但服务商是否仍在其服务端自行检索无法验证。',
  },
  'no-plugin': {
    tone: 'warn',
    pill: '插件未启用',
    text: '联网开着，但「联网搜索」插件没有启用 —— AI 看不到搜索工具。在插件列表里启用它。',
  },
  'needs-config': {
    tone: 'err',
    pill: '未就绪',
    text: '插件已启用，但还没有就绪（缺 API Key / 服务地址 / 服务类型，或插件自身没跑起来）：工具会出现在列表里，调用会明确失败 —— 这不是「搜不到结果」。',
  },
  on: {
    tone: 'ok',
    pill: '搜索可用',
    text:
      '独立搜索 API 生效：搜索可用（只对管理员私聊与桌面端开放）；'
      + '网页正文读取另由「允许读取网页正文」决定。',
  },
  native: {
    tone: 'ok',
    pill: '原生联网',
    text:
      '服务商原生联网生效：检索由服务商在它自己服务端完成，Ling-bot 只发送联网声明 / 联网工具；'
      + '原生模式下后端结构性隐藏了独立搜索的两个插件工具（web_search / web_fetch），'
      + '两条通道默认只走这一条，不会再同时跑一遍 —— 避免重复消耗。',
  },
  'native-needs-config': {
    tone: 'warn',
    pill: '原生联网未就绪',
    text:
      '选的是「服务商原生联网」，但还没就绪（未选服务商 / 该服务商尚未适配 / 缺 Key 或凭据）：'
      + '现在不会发送任何联网参数，也不会退回独立搜索 —— 请先补齐配置。',
  },
});

/**
 * `network.effectiveMode` → 展示用。三态不合并（关闭 / 独立 API / 原生）。
 *
 * 未知（快照缺字段）显示「未知」而不是猜一个：猜成 `off` 会让用户去开一个
 * 可能已经开着的开关，猜成 `api` 会给他假的成功预期。
 */
const EFFECTIVE_MODE = Object.freeze({
  off: { tone: 'dim', label: '关闭（总开关关着）' },
  api: { tone: 'ok', label: '独立搜索 API' },
  native: { tone: 'ok', label: '服务商原生联网' },
});

/** 模式单选的显示名。`network.mode` 只认这两个值。 */
const MODE_LABEL = Object.freeze({
  api: '独立搜索 API',
  native: '服务商原生联网',
});

/** 原生联网服务商的显示名。'' = 未选择。 */
const PROVIDER_LABEL = Object.freeze({
  zhipu: '智谱 GLM',
  openai: 'OpenAI',
});

/** 服务商下拉的选项顺序：未选择放最前，用户一眼知道可以先不选。 */
const PROVIDER_OPTIONS = Object.freeze([
  ['', '未选择'],
  ['zhipu', '智谱 GLM'],
  ['openai', 'OpenAI'],
]);

/**
 * `native.last.status` → 药丸（色调 + 标签）。
 *
 * 五态必须各自可区分：只有 `searched` 能用绿色，`unknown` 用 warn，
 * `rejected` 用 err，`not-requested` / `unavailable` 用 dim。
 * 合并任意两格都会让用户把"没证据"、"被拒绝"、"没发请求"当成同一件事，
 * 而它们的下一步动作完全不同。
 */
const NATIVE_STATUS = Object.freeze({
  searched: { tone: 'ok', label: '有引用证据' },
  unknown: { tone: 'warn', label: '无法确认' },
  rejected: { tone: 'err', label: '被拒绝' },
  'not-requested': { tone: 'dim', label: '未发送请求' },
  unavailable: { tone: 'dim', label: '服务商不可用' },
});

/** 证据类型的中英并排（与 DEPTH_LABEL 同一理由：值要能对回配置/日志）。 */
const NATIVE_KIND = Object.freeze({
  url_citation: 'url_citation（结构化引用）',
  web_search: 'web_search（联网工具事件）',
  inline_ref: 'inline_ref（正文内联引用）',
  none: 'none（没有引用）',
});

/**
 * 各状态的解释句。**没有任何一句把"请求成功"写成"联网成功"**。
 *
 * `searched` 也只说"有引用证据"：引用本身来自外部内容，仍要用户核对。
 */
const NATIVE_STATUS_TEXT = Object.freeze({
  searched:
    '上游返回了结构化引用或联网工具事件 —— 这是目前唯一能当证据的东西。'
    + '引用内容仍是外部数据，结论请自行核对。',
  unknown:
    '无法确认是否真的联网：没有引用、没有来源、也没有联网工具事件。'
    + 'HTTP 200、回答里的日期看起来正确、模型自称"我联网查了"，这三样都不算证据。',
  rejected:
    '这次联网声明 / 联网工具被上游拒绝，没有执行检索 —— 不是"搜不到结果"。',
  'not-requested': '这次没有发送联网声明或联网工具（例如本回合不需要联网）。',
  unavailable: '该服务商这次没有可用的联网能力，声明与工具都没有被执行。',
});

/**
 * `allowFetch: false` 时「实际效果」的结论句。
 *
 * 后端正常会给一句自己的 `effectiveText`；这里只兜底一种自相矛盾的快照：
 * 后端仍写着"网页读取也可用"，而事实字段 `allowFetch` 是 false。
 * 判断依据是后端给的事实字段，不是前端重新推导四态。
 */
const FETCH_CLOSED_TEXT = '搜索可用，网页正文读取已关闭（allowFetch 关着；只对管理员私聊与桌面端开放）。';

/**
 * 搜索深度的中文注解。
 *
 * 契约 §2 的取值是四个英文词，直接显示给用户等于让他去猜。
 * 但也不能只显示中文：用户改配置时填的是英文值，两边对不上会更难查。
 * 所以中英并排。
 */
const DEPTH_LABEL = Object.freeze({
  basic: 'basic（基础）',
  advanced: 'advanced（深入）',
  fast: 'fast（快速）',
  'ultra-fast': 'ultra-fast（极速）',
});

/**
 * 失败码 → 用户该做什么。
 *
 * 这些解释全部来自契约 §7（那里写的是"模型该怎么理解"，这里是用户版）。
 * 界面上只显示码，用户依然不知道下一步；但编一条错的解释比不显示更糟，
 * 所以只写契约里明确了的那些，未知码一律不给建议。
 */
const CODE_HINT = Object.freeze({
  E4080: '总开关关着，或网页读取被配置关闭（allowFetch: false）：先看本页的联网总开关与插件配置。',
  E4081: '搜索服务还没配好：在上面的插件配置里填 API Key、服务地址，并确认服务类型是 Tavily。',
  E4082: '上游拒绝了 Key：它可能失效或被撤销，在插件配置里换一个。',
  E4083: '额度用尽或被限流：稍后再试，或去服务商后台看额度（不要连着点）。',
  E4084: '请求超时：可以换更短的查询再试一次，别反复重试。',
  E4085: '上游响应不符合预期，通常是服务地址不对或参数被拒 —— 不是「没搜到」。',
  E4086: '上游服务故障（5xx / 连接失败）：这是对方的问题，稍后再试。',
  E4087: '目标地址不被允许：内网、本机、非 http(s)、内嵌凭据、非 80/443 端口或超长 URL 都会被拒绝（读网页时才会遇到）。',
  E4088: '目标不是可读正文：缺少 Content-Type、类型不在白名单，或体积超出限制。',
  E4089: '关闭已经生效（安全方向），但配置没保存成功：重启后可能回到开着的状态，稍后重试保存。',
  E4070: '这次调用被取消了，不算成功。',
  E4071: '这次调用没有可信的联网上下文（宿主未注入、来源不允许，或能力已失效）：这是装配/接线问题，不是搜索失败。',
  E4032: '工具当前不可见：多半是插件没启用，或当前来源没有这个工具。',
});

/**
 * 快照缺字段时显示什么。
 *
 * 用 '—' 而不是空串或 0：这一页的每个值都是"事实回显"，
 * 空串看起来像"值为空"，0 看起来像"真的搜过 0 次"——
 * 两者都会让用户以为后端确认过这件事，而实际是**没有数据**。
 *
 * @param {any} v
 * @param {string} [fallback]
 */
function orDash(v, fallback = '—') {
  const s = String(v ?? '').trim();
  return s ? s : fallback;
}

/**
 * 数字兜底。
 *
 * 快照可能缺字段（首帧、老后端），而 `.toFixed()` / `Number(...).toLocaleString()`
 * 在 undefined 上会给出 NaN —— 页面上出现 NaN 比空白更糟：用户会以为配置坏了。
 *
 * @param {any} n
 * @param {number} [fallback]
 */
function num(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 毫秒 → 人话。
 *
 * @param {any} n
 */
function fmtMs(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v < 60_000) return `${Math.round(v / 1000)} 秒`;
  const min = v / 60_000;
  return Number.isInteger(min) ? `${min} 分钟` : `${min.toFixed(1)} 分钟`;
}

/**
 * 决定"实际效果"用哪一态。
 *
 * ## 兜底为什么是 `no-plugin`
 *
 * 任务与契约都要求：快照里的 `network` 块缺失时按 `effective: 'no-plugin'` 显示，
 * 并明确告诉用户"后端未提供联网状态"。
 *
 * 三选一的取舍：
 *   · `off` 会让用户去开一个可能已经开着的开关（最迷惑）；
 *   · `on` 会给出假的成功预期，而后面每次试搜都会失败；
 *   · `no-plugin` 的那句"去《插件设置》看看"在三种真实原因下都成立。
 *
 * 所以这里**只认后端给的字符串**，不根据 enabled / plugin / configured 自己拼。
 *
 * @param {any} network
 * @returns {keyof typeof EFFECTIVE}
 */
function effectiveKey(network) {
  const raw = network?.effective;
  if (typeof raw === 'string' && raw in EFFECTIVE) return /** @type {any} */ (raw);
  return 'no-plugin';
}

/**
 * 只接受 http/https、且不带内嵌凭据的 URL。
 *
 * 契约 §7 的纪律：插件返回的 `results[].url` 要**再校验一次**，
 * 坏条目丢弃而不是整单失败。后端已经做过一次，这里再做一次不是重复劳动 ——
 * 页面是最后一道展示关，而"渲染一个 javascript: 或 user:pw@host 的链接/文本"
 * 对用户是有实际风险的（前者若将来加上链接就是 XSS 入口）。
 *
 * @param {any} raw
 * @returns {string} 空串表示这条不该显示
 */
function safeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    if (u.username || u.password) return '';
    return s;
  } catch {
    return '';
  }
}

/**
 * 把 `action('tool.run')` 的返回值整理成一份可展示的结果。
 *
 * ## 为什么要分两层判 ok
 *
 * `tool.run` 的返回是 `{ ok: true, result }`，而 `result` 是**插件**的返回值，
 * 它自己也是 `{ ok: false, code, message }`：
 *
 *   · 外层 ok=false → 工具压根没跑起来（不存在 / 当前来源无权限 / 参数不合法）
 *   · 内层 ok=false → 工具跑了，但搜索失败（缺 Key / 鉴权 / 限流 / 上游故障）
 *
 * 只判外层会把"Key 失效"显示成"成功但 0 条结果"——用户于是去换搜索词。
 * 这正是这一页最想消灭的误导，所以两层都必须落到"失败"。
 *
 * @param {any} raw
 * @param {string} query
 * @returns {object}
 */
function normalizeSearchResult(raw, query) {
  const at = Date.now();

  if (!raw || raw.ok !== true) {
    return {
      ok: false,
      at,
      query,
      code: String(raw?.code ?? 'E50XX'),
      message: String(raw?.message ?? '没有收到有效响应'),
    };
  }

  const res = raw.result;
  if (!res || typeof res !== 'object') {
    // 形状不对 ≠ 空结果。把"看不懂"说成"没搜到"会让用户以为换个词就能好
    return {
      ok: false,
      at,
      query,
      code: 'E4085',
      message: '工具返回的形状看不懂（缺少结果对象），这通常是实现问题。',
    };
  }

  if (res.ok === false) {
    return {
      ok: false,
      at,
      query,
      code: String(res.code ?? 'E4085'),
      message: String(res.message ?? '搜索失败（没有给出原因）'),
    };
  }

  const items = (Array.isArray(res.results) ? res.results : [])
    .map((one) => {
      const url = safeUrl(one?.url);
      if (!url) return null;
      return {
        title: orDash(one?.title, url),
        url,
        snippet: String(one?.snippet ?? ''),
        publishedDate: typeof one?.publishedDate === 'string' ? one.publishedDate : '',
      };
    })
    .filter(Boolean);

  return {
    ok: true,
    at,
    query,
    items,
    provider: String(res.provider ?? ''),
    notice: String(res.notice ?? ''),
  };
}

/**
 * 结果区的内容（试搜卡下半部分）。
 *
 * 纯函数式地按 `ui.result` 生成节点：轮询重绘后要靠它把结果原样画回来，
 * 所以它不能依赖任何闭包里的临时变量。
 *
 * @param {any} result
 * @returns {HTMLElement}
 */
function buildResult(result) {
  if (!result) {
    return el('div', {
      class: 'field-hint',
      text: '还没有试搜过。点「试搜」会用当前配置真的发一次请求 —— 会消耗一次服务商额度。',
    });
  }

  /* -------------------------------------------------- 失败 */

  if (result.ok !== true) {
    const code = orDash(result.code, 'E50XX');
    const hint = CODE_HINT[code] ?? '';
    return el('div', { class: 'ws-error' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'mono err', text: code }),
        el('span', { class: 'muted', text: `· 试搜于 ${clock(result.at)}` }),
      ]),
      el('div', { class: 'ws-error-message', text: orDash(result.message, '（没有返回原因）') }),
      result.query ? el('div', { class: 'field-hint', text: `查询词：${result.query}` }) : null,
      hint ? el('div', { class: 'field-hint', text: hint }) : null,
    ].filter(Boolean));
  }

  /* -------------------------------------------------- 成功但空结果 */

  if (result.items.length === 0) {
    /*
     * 这是本页最容易被做错的一格。
     *
     * 契约 §7：`ok:true` + `results: []` 是**合法的空结果**，和"工具没跑"
     * 是两件完全不同的事。界面上必须说清"请求成功了，只是确实没有来源"，
     * 否则用户会以为工具坏了，然后反复点。
     */
    return el('div', { class: 'ws-ok' }, [
      el('div', { text: '请求成功，但这次没有返回任何来源。' }),
      el('div', {
        class: 'field-hint',
        text: '空结果是合法的：上游确实没搜到匹配内容，不是故障。可以换个查询词再试一次。',
      }),
      result.notice ? el('div', { class: 'field-hint', text: result.notice }) : null,
    ].filter(Boolean));
  }

  /* -------------------------------------------------- 成功 */

  return el('div', {}, [
    el('div', {
      class: 'field-hint',
      text: `${result.items.length} 条来源（${orDash(result.provider, '未知服务商')}）· 试搜于 ${clock(result.at)}`,
    }),
    el('div', { class: 'spacer-8' }),
    el('div', { class: 'ws-results' }, result.items.map((item) => el('div', { class: 'ws-result' }, [
      el('div', { class: 'ws-result-title', text: item.title }),
      /*
       * URL 只做文本。做成 <a> 会在 Tauri 壳里把整个界面导航走，
       * 而"能不能打开外链"该由壳的主机白名单决定（见文件头说明）。
       */
      el('div', { class: 'ws-result-url mono', text: item.url }),
      item.snippet ? el('div', { class: 'ws-result-snippet', text: item.snippet }) : null,
      item.publishedDate ? el('div', { class: 'ws-result-meta', text: `发布：${item.publishedDate}` }) : null,
    ].filter(Boolean)))),
  ]);
}

/**
 * 保存总开关。
 *
 * 前缀固定为 `network.enabled`（契约 §1），后端再校验一次类型。
 * 界面只做体验，不做安全边界 —— 所以即使这里传错，后端也必须挡住。
 *
 * @param {boolean} value
 * @param {(() => void) | undefined} rerender
 */
async function saveEnabled(value, rerender) {
  ui.pendingEnabled = value === true;
  ui.lastSave = { ok: true, text: '保存中…' };
  rerender?.();
  const r = await setting('network.enabled', value === true);
  if (r?.ok) {
    ui.lastSave = { ok: true, text: '已保存' };
  } else if (r?.closed === true && typeof r?.value === 'boolean') {
    /*
     * 关闭失败但**安全方向已经生效**（`E4089`）。
     *
     * 这时不能把意图值丢掉：快照里可能还写着"开"（写盘失败、内存已关），
     * 丢掉意图值会让复选框弹回"开"—— 用户以为没关成功，其实线上已经关了，
     * 下次调用会拿到 E4080。复选框必须停在真实生效的位置（关）。
     */
    ui.pendingEnabled = r.value;
    ui.lastSave = {
      ok: false,
      text:
        `已关闭（安全方向已生效），但配置保存失败：${r.code ?? 'E4089'} ${r.message ?? ''}`
        + ' 重启后可能回到开着的状态，请稍后重试保存。',
    };
  } else {
    /*
     * 普通失败（参数不合法 / 通道错误）：把意图值丢掉，否则界面会一直显示
     * "开/关"，而配置里其实没改。用户下次重启发现状态又变了，
     * 会认为这个开关"记不住"。
     */
    ui.pendingEnabled = null;
    ui.lastSave = {
      ok: false,
      text: `保存失败：${r?.code ?? ''} ${r?.message ?? ''}`.trim(),
    };
  }
  rerender?.();
}

/** `network.mode` 只认这两个值；其它（含缺失）一律返回 '' = 不知道，不猜。 */
function normalizeMode(v) {
  return v === 'native' ? 'native' : v === 'api' ? 'api' : '';
}

/** `network.native.provider` 只认这三个值；'' 是合法的"未选择"。 */
function normalizeProvider(v) {
  return v === 'zhipu' || v === 'openai' ? v : '';
}

/**
 * 保存联网模式（`network.mode`）。
 *
 * 与 saveEnabled 同一套反馈纪律：先给"保存中…"、成功给"已保存"、失败给码与原因；
 * 失败时把意图值丢掉，否则界面会一直显示用户点的那一项，而配置其实没改。
 *
 * @param {'api' | 'native'} value
 * @param {(() => void) | undefined} rerender
 */
async function saveMode(value, rerender) {
  const next = value === 'native' ? 'native' : 'api';
  ui.pendingMode = next;
  ui.modeSave = { ok: true, text: `保存中…（${MODE_LABEL[next]}）` };
  rerender?.();
  const r = await setting('network.mode', next);
  const echoed = normalizeMode(r?.value);
  if (r?.ok) {
    ui.modeSave = { ok: true, text: `已保存：${MODE_LABEL[next]}` };
  } else if (echoed) {
    /*
     * 后端明确回报了"现在生效的值"（与总开关的 closed/value 同一类回报）。
     * 这时以回报的值为准，不能把意图弹回旧值 —— 线上可能已经按新值执行，
     * 界面弹回旧值会让用户以为没保存成功，又与真实执行方式不一致。
     */
    ui.pendingMode = /** @type {any} */ (echoed);
    ui.modeSave = {
      ok: false,
      text:
        `已生效为「${MODE_LABEL[echoed]}」，但配置保存失败：${r?.code ?? ''} ${r?.message ?? ''}`
        + ' 重启后可能回到原来的模式。',
    };
  } else {
    ui.pendingMode = null;
    ui.modeSave = {
      ok: false,
      text: `模式保存失败：${r?.code ?? ''} ${r?.message ?? ''}`.trim(),
    };
  }
  rerender?.();
}

/**
 * 保存原生联网服务商（`network.native.provider`）。
 *
 * `''` 是合法的"未选择"：它等于"不要发送任何联网参数"，不是"删掉配置"。
 *
 * @param {string} value
 * @param {(() => void) | undefined} rerender
 */
async function saveProvider(value, rerender) {
  const next = normalizeProvider(value);
  ui.pendingProvider = next;
  ui.providerSave = { ok: true, text: `保存中…（${PROVIDER_LABEL[next] ?? '未选择'}）` };
  rerender?.();
  const r = await setting('network.native.provider', next);
  if (r?.ok) {
    ui.providerSave = { ok: true, text: `已保存：${PROVIDER_LABEL[next] ?? '未选择'}` };
  } else if (typeof r?.value === 'string') {
    // 同上：后端回报了实际生效值就按它显示
    ui.pendingProvider = normalizeProvider(r.value);
    ui.providerSave = {
      ok: false,
      text:
        `已生效为「${PROVIDER_LABEL[normalizeProvider(r.value)] ?? '未选择'}」，但配置保存失败：`
        + `${r?.code ?? ''} ${r?.message ?? ''}`,
    };
  } else {
    ui.pendingProvider = null;
    ui.providerSave = {
      ok: false,
      text: `服务商保存失败：${r?.code ?? ''} ${r?.message ?? ''}`.trim(),
    };
  }
  rerender?.();
}

/**
 * 渲染「联网搜索」设置区块。
 *
 * 它由《插件设置》页在选中 `web-search` 插件时挂载，不再是独立侧栏页；
 * 函数名保留 `renderWebSearch` 的语义（区块仍叫联网搜索），但不再导出页面名。
 *
 * @param {any} snap
 * @param {{rerender?: () => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderNetworkSection(snap, ctx = {}) {
  const rerender = typeof ctx?.rerender === 'function' ? ctx.rerender : undefined;

  /*
   * `network` 块可能整个缺失（首帧、老后端、宿主还没接线）。
   * 这里只做**形状**兜底，不做语义推导 —— 语义由 effective 决定。
   */
  const rawNetwork = snap?.network;
  const hasNetwork = Boolean(rawNetwork && typeof rawNetwork === 'object');
  const net = hasNetwork ? rawNetwork : {};

  const key = effectiveKey(net);
  const eff = EFFECTIVE[key];

  /*
   * 结论句优先用后端给的那句：后端知道"状态计算失败"之类的额外上下文，
   * 界面不该假装自己也知道。pill 与颜色仍由前端的四态表决定 ——
   * 这样四态在视觉上一定可区分（见 EFFECTIVE 的说明）。
   */
  const backendText = typeof net.effectiveText === 'string' ? net.effectiveText.trim() : '';
  /*
   * allowFetch 关掉时，后端本应把结论写成"搜索可用，网页正文读取已关闭"。
   * 旧快照/旧后端可能仍写着"都可用" —— 这时以事实字段 allowFetch 为准，
   * 换成不会自相矛盾的一句；后端已经说对了就原样保留。
   */
  const fetchClosed = key === 'on' && net.allowFetch === false;
  const backendClaimsFetch = /网页读取(?:都|也)?可用|网页正文读取可用/.test(backendText);
  const effectiveText = fetchClosed && (!backendText || backendClaimsFetch)
    ? FETCH_CLOSED_TEXT
    : (backendText || eff.text);

  /*
   * 真实未就绪原因由后端给（`effectiveDetail`）：界面只原样展示，不自行推断。
   * 典型值：插件崩溃/加载失败、Key 在保险箱里解不开、服务类型不受支持。
   */
  const effectiveDetail = typeof net.effectiveDetail === 'string' ? net.effectiveDetail.trim() : '';

  /*
   * 开关显示值：意图值优先（见 ui.pendingEnabled）。
   * 快照已经追上意图时立刻丢掉，免得它永久盖住真实配置。
   */
  if (ui.pendingEnabled !== null && hasNetwork && (net.enabled === true) === ui.pendingEnabled) {
    ui.pendingEnabled = null;
  }
  const shownEnabled = ui.pendingEnabled === null ? net.enabled === true : ui.pendingEnabled;

  const plugin = net.plugin && typeof net.plugin === 'object' ? net.plugin : null;

  /*
   * 模式与服务商：**只认后端给的值**，缺失时返回 ''（= 不知道）。
   *
   * 为什么缺失时不猜 `api`：那会让用户看到一个他从没选过的模式，
   * 而且他一旦相信，排查就会从错误的起点开始。缺数据就说缺数据。
   * 意图值（pending*）优先，理由同 pendingEnabled —— 快照要等下一轮才追上。
   */
  const storedMode = normalizeMode(net.mode);
  if (ui.pendingMode !== null && hasNetwork && storedMode === ui.pendingMode) {
    ui.pendingMode = null;
  }
  const shownMode = ui.pendingMode === null ? storedMode : ui.pendingMode;

  const native = net.native && typeof net.native === 'object' ? net.native : null;
  const storedProvider = native ? normalizeProvider(native.provider) : '';
  if (ui.pendingProvider !== null && hasNetwork && storedProvider === ui.pendingProvider) {
    ui.pendingProvider = null;
  }
  const shownProvider = ui.pendingProvider === null ? storedProvider : ui.pendingProvider;

  const modeInfo = EFFECTIVE_MODE[net.effectiveMode] ?? { tone: 'dim', label: '未知' };

  /**
   * 是否处于"原生联网生效"。
   *
   * 只用来切换**事实呈现**（例如原生模式下插件工具结构性不可见、`allowFetch`
   * 已经不作用于任何实际能力），不用来推导可用性 —— 可用性仍只看 `effective`。
   */
  const nativeMode = net.effectiveMode === 'native';

  /* -------------------------------------------------- ① 实际效果（先给答案） */

  /** 密钥回显只有三种状态，永远不出现明文 */
  const keyState = net.configured === true
    ? { tone: 'ok', label: '已保存' }
    : net.configured === false
      ? { tone: 'warn', label: '未保存' }
      : { tone: 'dim', label: '未知' };

  const tools = Array.isArray(net.tools)
    ? net.tools.filter((t) => typeof t === 'string' && t)
    : null;

  const toolsValue = tools === null
    ? el('span', { class: 'muted', text: '—' })
    : tools.length > 0
      ? el('span', { class: 'mono', text: tools.join('、') })
      : el('span', {
          class: 'muted',
          text: nativeMode
            // 原生模式下后端隐藏的是两个插件工具，不只搜索工具
            ? '没有（原生模式不注入插件工具：web_search / web_fetch 都不可见）'
            : '没有（模型看不到搜索工具）',
        });

  const pluginValue = plugin === null
    ? el('span', { class: 'muted', text: '—' })
    : el('span', { class: 'row' }, [
        pill(plugin.enabled === true ? '已启用' : '未启用', plugin.enabled === true ? 'ok' : 'dim'),
        el('span', { class: 'muted mono', text: orDash(plugin.status) }),
      ]);

  const effectiveRows = [
    /*
     * 键名用「状态」而不是「实际效果」：卡片标题已经说了这是实际效果，
     * 键再重复一遍，用户会以为右边那个药丸和标题是两个不同的东西。
     */
    kv('状态', pill(eff.pill, /** @type {any} */ (eff.tone))),
    /*
     * 模式单独一行：`effective` 说"能不能搜"，这一行说"按哪种方式在跑"。
     * 两者不是一回事（原生联网就绪时 `effective` 是 native，但独立搜索的
     * 插件可能根本没启用），合并会让用户以为只有一条判定链。
     */
    kv('联网模式', pill(modeInfo.label, /** @type {any} */ (modeInfo.tone))),
    /*
     * 把三个条件逐格列出来，而不是只给一句结论。
     * 用户来这一页几乎都是为了回答"到底哪一格挡住了我"，
     * 而结论句只能告诉他"挡住了"。
     */
    kv('总闸', hasNetwork
      ? pill(net.enabled === true ? '开' : '关', net.enabled === true ? 'ok' : 'dim')
      : el('span', { class: 'muted', text: '—' })),
    kv('插件（web-search）', pluginValue),
    kv('API Key', pill(keyState.label, /** @type {any} */ (keyState.tone))),
    kv('AI 能用的工具', toolsValue),
  ];

  const effectiveBlock = el('div', { class: 'ws-effective' }, [
    card('实际效果（AI 现在到底能不能搜）', [
      el('div', { class: 'list' }, effectiveRows),
      el('div', { class: 'field-hint', text: effectiveText }),
      effectiveDetail && effectiveDetail !== effectiveText
        ? el('div', {
            class: 'hint',
            text: `${key === 'on' ? '补充说明' : '真实原因'}：${effectiveDetail}`,
          })
        : null,
      /*
       * 缺失 network 块时必须说出来，不能假装知道。
       * 这一句同时解释了"下面为什么全是 —"：不是坏了，是没有数据。
       */
      hasNetwork
        ? null
        : el('div', {
            class: 'hint',
            text:
              '后端未提供联网状态（这份快照里还没有 network 块）。'
              + '上面的四态是按最保守的一格（插件未启用）显示的，下面的服务配置与统计会是「—」。'
              + '这不是故障提示；等后端接上这块数据后，这里会自动变成真实状态。',
          }),
    ].filter(Boolean)),
  ]);

  /* -------------------------------------------------- ② 总开关（用户意图） */

  const box = /** @type {HTMLInputElement} */ (
    el('input', { type: 'checkbox', class: 'checkbox' })
  );
  box.checked = shownEnabled;
  box.addEventListener('change', () => void saveEnabled(box.checked, rerender));

  const switchBlock = el('div', { class: 'ws-switch' }, [
    card('总开关（是否发送联网声明/工具，以及 Ling-bot 自己发起的外网访问）', [
      el('div', {
        class: 'field-hint',
        text:
          '这个开关现在决定两件事：① Ling-bot 进程自己发出的受控 HTTP(S) 请求 —— '
          + '搜索（web_search）与抓取网页正文（web_fetch）；'
          + '② 要不要随模型请求发送联网声明与联网工具（含「服务商原生联网」）。'
          + '关掉之后这些都不会发生 —— 不是"界面上不显示"，而是真的不发请求、'
          + '声明与工具也不会出现在 AI 的工具列表里。'
          + '关闭会先立即生效并中止在途请求，再写入配置；写入失败会保持关闭状态并提示。',
      }),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'field' }, [
        el('label', { class: 'row' }, [
          box,
          el('span', { class: 'field-label', text: '允许 Ling-bot 联网（自己搜索/读取网页，并发送联网声明与工具）' }),
        ]),
        el('div', {
          class: 'field-hint',
          text:
            '它仍然控制不了、也无法验证的是：① 模型服务商在它自己服务端是否仍在自行检索'
            + '（那是上游行为，我们看不见也拦不住 —— 关掉开关后模型若还能说出新信息，'
            + '那来自服务商自己的行为或它记住的内容，不是这个开关失灵）；'
            + '② 你在别的软件里做的事；③ QQ 网关（SnowLuma）自己的网络；'
            + '④ 模型 API、视觉取图以及其它插件自己写的 fetch。'
            + '所以准确口径是：关掉后 Ling-bot 不再发送任何联网声明/工具，'
            + '而不是"整机断网"，服务商服务端的行为无法验证。',
        }),
        ui.lastSave
          ? el('div', {
              class: ui.lastSave.ok ? 'ok' : 'err',
              text: ui.lastSave.text,
            })
          : null,
      ].filter(Boolean)),
    ]),
  ]);

  /* -------------------------------------------------- ③ 联网模式（三态） */

  /*
   * 三态在这张卡里一次性讲清：关闭不是一个存储值，而是总开关关掉后的效果。
   * 所以单选框只有两项（api / native），关闭态由上一张卡的复选框表达 ——
   * 把"关闭"做成第三个单选项会造出两份真相（复选框和单选各说一套）。
   */
  const modeRows = [
    kv('当前生效', pill(modeInfo.label, /** @type {any} */ (modeInfo.tone))),
    kv('① 关闭', el('span', { class: 'muted', text: '上面总开关关掉 —— 两种模式都不执行' })),
    kv('② 独立搜索 API', el('span', { class: 'muted', text: 'Ling-bot 自己调搜索服务商' })),
    kv('③ 服务商原生联网', el('span', { class: 'muted', text: '检索由服务商在其服务端完成' })),
  ];

  /** 一个模式单选项。`value` 只可能是 api / native。 */
  const modeChoice = (value, label, hint) => {
    const input = /** @type {HTMLInputElement} */ (el('input', {
      type: 'radio',
      name: 'ws-mode',
      value,
    }));
    input.checked = shownMode === value;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      /*
       * 已经是这个值就不写。重复点同一项在浏览器里本来不会触发 change，
       * 但测试/程序化赋值会 —— 多写一次就是一次多余的配置写入，
       * 而写入会重新初始化插件（用户会看到工具闪一下）。
       */
      if (value === (ui.pendingMode ?? storedMode)) return;
      void saveMode(value === 'native' ? 'native' : 'api', rerender);
    });
    return el('label', { class: 'ws-mode-choice' }, [
      input,
      el('div', { class: 'ws-mode-choice-body' }, [
        el('span', { class: 'field-label', text: label }),
        el('div', { class: 'field-hint', text: hint }),
      ]),
    ]);
  };

  /*
   * 服务商下拉。'' 是合法的"未选择"，不是"删掉配置"：
   * 它等于"不要发送任何联网参数"，和 providerKnown === false 是同一种执行结果。
   */
  const providerSelect = /** @type {HTMLSelectElement} */ (el('select', { class: 'text-input' }));
  for (const [value, label] of PROVIDER_OPTIONS) {
    providerSelect.append(el('option', { value, text: label }));
  }
  providerSelect.value = shownProvider;
  providerSelect.addEventListener('change', () => {
    const next = normalizeProvider(providerSelect.value);
    if (next === (ui.pendingProvider ?? storedProvider)) return;
    void saveProvider(next, rerender);
  });

  const providerHint = !hasNetwork || !native
    ? {
        tone: 'hint',
        text:
          '后端未提供原生联网状态（快照里没有 network.native 块）：这里不做任何推导，'
          + '也不预选服务商。',
      }
    : shownProvider === ''
      ? {
          tone: 'field-hint',
          text:
            '还没有选择服务商 —— 按"尚未适配"处理：不会发送任何联网参数。'
            + '选一个已适配的服务商之后，才会在请求里带上对应的联网声明/工具。',
        }
      : native.providerKnown === false
        ? {
            tone: 'hint',
            text:
              '该服务商尚未适配，不会发送任何联网参数'
              + '（后端给的 providerKnown = false：Ling-bot 不会猜一个协议去试）。',
          }
        : native.providerKnown === true
          ? null
          : {
              /*
               * 三态里的第三种：字段缺失。既不能说"已适配"（那是假阳性），
               * 也不能断言"不会发送"（那是假阴性）—— 只能说无法确认。
               */
              tone: 'hint',
              text:
                '后端没有给出该服务商是否已适配（providerKnown 缺失）：'
                + '现在无法确认会不会发送联网参数，请先不要依赖它的联网结果。',
            };

  const providerLabel = native && typeof native.providerLabel === 'string' && native.providerLabel.trim()
    ? native.providerLabel.trim()
    : (PROVIDER_LABEL[storedProvider] ?? '未选择');

  const modeBlock = el('div', { class: 'ws-mode' }, [
    card('联网模式（关闭 / 独立搜索 API / 服务商原生联网）', [
      el('div', {
        class: 'field-hint',
        text:
          '这是三种互斥的执行方式，不是三个独立开关：关闭 = 上面总开关关掉；'
          + '独立搜索 API = Ling-bot 自己调搜索服务商，把结果当工具交给模型；'
          + '服务商原生联网 = 检索由模型服务商在它自己服务端完成，Ling-bot 只发送联网声明/工具。'
          + '两条通道默认只走一条：原生模式下后端会结构性隐藏独立搜索的两个插件工具'
          + '（web_search / web_fetch），所以两边不会同时跑 ——'
          + '同一句话花两份额度、还给出两组互相打架的来源，是必须避免的重复消耗。',
      }),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'list' }, modeRows),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'field' }, [
        el('div', { class: 'field-label', text: '用哪种方式联网（关闭由上面的总开关决定）' }),
        el('div', { class: 'ws-mode-choices' }, [
          modeChoice(
            'api',
            '独立搜索 API',
            '由 Ling-bot 直接调搜索服务商（如 Tavily），结构化结果作为工具交给模型。'
            + '需要启用并配好 web-search 插件。',
          ),
          modeChoice(
            'native',
            '服务商原生联网',
            '由模型服务商在它自己服务端检索；Ling-bot 只发送联网声明/工具。'
            + '能不能用取决于该服务商是否已适配、以及模型与 Key 是否支持。',
          ),
        ]),
        ui.modeSave
          ? el('div', { class: ui.modeSave.ok ? 'ok' : 'err', text: ui.modeSave.text })
          : null,
      ].filter(Boolean)),
      (!hasNetwork || !storedMode) && ui.pendingMode === null
        ? el('div', {
            class: 'hint',
            text:
              '后端没有给出当前的联网模式：这里不预选（不猜），'
              + '点其中一项就会写入 `network.mode` 并立即生效。',
          })
        : null,
      /*
       * 总开关关着时只说"需先打开"，**不清模式**：
       * 用户常常只是临时关一下，清掉他下次打开还得重选一次。
       */
      shownEnabled
        ? null
        : el('div', {
            class: 'hint',
            text:
              '需先打开总开关：现在总开关关着，所以两种模式都不会执行。'
              + '已选的模式会留着，打开总开关后按它生效。',
          }),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'field' }, [
        el('div', { class: 'field-label', text: '原生联网服务商' }),
        providerSelect,
        providerHint
          ? el('div', { class: providerHint.tone, text: providerHint.text })
          : null,
        ui.providerSave
          ? el('div', { class: ui.providerSave.ok ? 'ok' : 'err', text: ui.providerSave.text })
          : null,
        el('div', {
          class: 'field-hint',
          text:
            '下拉里只有「智谱 GLM」与「OpenAI」：其余服务商没有适配记录，'
            + '选了也不会被猜成某个协议去发送。未选择与未适配的结果一样 —— 不发送任何联网参数。',
        }),
      ].filter(Boolean)),
    ].filter(Boolean)),
  ]);

  /* -------------------------------------------------- ④ 原生联网证据（只读） */

  const last = native?.last && typeof native.last === 'object' ? native.last : null;
  const lastStatus = last
    ? (NATIVE_STATUS[last.status] ?? { tone: 'warn', label: orDash(last.status, '未知状态') })
    : null;
  const lastKind = last ? (NATIVE_KIND[last.kind] ?? orDash(last.kind)) : '—';
  const lastSources = last && Array.isArray(last.sources)
    ? last.sources.filter((s) => s && typeof s === 'object')
    : [];
  const lastInline = last ? num(last.inlineRefs) : 0;
  /* 缺字段时显示「—」而不是 0：0 是"确实没有内联引用"，和"没有数据"不是一回事 */
  const lastInlineText = last && Number.isFinite(Number(last.inlineRefs))
    ? `${lastInline} 处`
    : '—';

  const lastBlock = last
    ? el('div', {}, [
        el('div', { class: 'field-label', text: '上次联网证据' }),
        el('div', { class: 'list' }, [
          kv('判定', pill(lastStatus.label, /** @type {any} */ (lastStatus.tone))),
          kv('依据类型', el('span', { class: 'mono', text: lastKind })),
          kv('内联引用', lastInlineText),
          kv('服务商', el('span', { class: 'muted mono', text: orDash(last.provider) })),
          kv('时间', el('span', { class: 'muted', text: clock(last.at) })),
        ]),
        el('div', {
          class: 'field-hint',
          text: NATIVE_STATUS_TEXT[last.status]
            ?? '未知状态：不要把它当成联网成功的证据（没有可判定的引用或工具事件）。',
        }),
        typeof last.detail === 'string' && last.detail.trim()
          ? el('div', { class: 'field-hint', text: `后端说明：${last.detail.trim()}` })
          : null,
        lastSources.length > 0
          ? el('div', { class: 'ws-results' }, lastSources.map((source) => {
              /*
               * 来源只以文本显示（title + url），**不做 <a href>**：
               * 在 Tauri 壳里点链接会把整个界面导航走，而外链该不该打开
               * 由壳的主机白名单决定，不是页面能决定的（见文件头说明）。
               *
               * 不合法（非 http(s) / 带凭据）的地址不原样画出来：
               * 它是外部内容，可能长得像地址、实际是 `javascript:` 之类。
               * 页面既不给它链接，也不把原文当"地址"展示，只显示标题并说明已隐藏。
               */
              const url = safeUrl(source.url);
              return el('div', { class: 'ws-result' }, [
                el('div', { class: 'ws-result-title', text: orDash(source.title, '（没有标题）') }),
                url
                  ? el('div', { class: 'ws-result-url mono', text: url })
                  : el('div', {
                      class: 'ws-result-url muted',
                      text: '（地址不是 http(s) 或带凭据，已隐藏）',
                    }),
              ]);
            }))
          : el('div', {
              class: 'field-hint',
              text: '这次没有返回任何来源（没有可引用的 title / url）。',
            }),
        el('div', {
          class: 'field-hint',
          text:
            '来源只显示标题与地址的文本，不做可点击链接：'
            + '能不能打开外链由壳的白名单裁定，页面不参与。',
        }),
        /*
         * 自相矛盾的快照：status 说"有引用证据"，但既没有来源也没有内联引用。
         * 这时按更保守的一格显示 —— 与 allowFetch 那句兜底同一纪律：
         * 宁可说"无法确认"，也不要给一个抓不住的"证据"。
         */
        last.status === 'searched' && lastSources.length === 0 && lastInline === 0
          ? el('div', {
              class: 'hint',
              text:
                '这份快照自相矛盾：status = searched，但既没有来源、也没有内联引用。'
                + '按「无法确认是否真的联网」对待，别把它当成功证据。',
            })
          : null,
      ].filter(Boolean))
    : el('div', {
        class: 'field-hint',
        text:
          '还没有记录到原生联网的证据（本进程启动以来没有发生过原生检索，'
          + '或后端还没有回填 native.last）。',
      });

  const nativeStats = native?.stats && typeof native.stats === 'object' ? native.stats : null;
  /** 没有计数块时显示「—」而不是 0：0 是"确实一次都没有"，和"没有数据"不是一回事 */
  const nativeStatNum = (v) => (nativeStats ? String(num(v)) : '—');

  const nativeStatsRows = [
    kv('原生联网回合', nativeStatNum(nativeStats?.requests)),
    kv('有证据的回合', nativeStatNum(nativeStats?.evidence)),
    kv('无证据的回合', nativeStatNum(nativeStats?.noEvidence)),
    kv('被拒绝的回合', nativeStatNum(nativeStats?.rejected)),
    kv('最近一次', el('span', { class: 'muted', text: nativeStats ? clock(nativeStats.lastAt) : '—' })),
  ];

  const offPolicy = native?.offPolicy && typeof native.offPolicy === 'object' ? native.offPolicy : null;
  const offPolicyText = offPolicy && typeof offPolicy.text === 'string' && offPolicy.text.trim()
    ? offPolicy.text.trim()
    : '后端未提供控制范围说明。按最保守的口径：关闭后 Ling-bot 不再发送任何联网声明/工具，'
      + '但服务商是否仍在其服务端自行检索无法验证。';

  const nativeRows = [
    kv('生效中', native
      ? pill(
          native.active === true ? '是（原生模式生效）' : native.active === false ? '否' : '未知',
          native.active === true ? 'ok' : 'dim',
        )
      : el('span', { class: 'muted', text: '—' })),
    kv('服务商', native
      ? el('span', { class: 'row' }, [
          pill(
            providerLabel,
            native.providerKnown === false ? 'warn' : (storedProvider ? 'ok' : 'dim'),
          ),
          storedProvider
            ? el('span', { class: 'muted mono', text: storedProvider })
            : null,
        ].filter(Boolean))
      : el('span', { class: 'muted', text: '—' })),
    kv('协议', el('span', { class: 'mono', text: native ? orDash(native.protocol) : '—' })),
    kv('是否已适配', native
      ? pill(
          native.configured === true ? '已适配' : native.configured === false ? '未适配' : '未知',
          native.configured === true ? 'ok' : native.configured === false ? 'warn' : 'dim',
        )
      : el('span', { class: 'muted', text: '—' })),
  ];

  const nativeBlock = el('div', { class: 'ws-native' }, [
    card('服务商原生联网（后端给的事实，只回显不推导）', [
      el('div', {
        class: 'field-hint',
        text:
          '这一块只是把后端已经判定过的字段画出来：协议、限制、是否配置、上次证据与计数。'
          + '这页不重新推一遍"到底可不可用" —— 同一套判定写两份，迟早会漂移成自相矛盾。',
      }),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'list' }, nativeRows),
      native && typeof native.limitsText === 'string' && native.limitsText.trim()
        ? el('div', { class: 'field-hint', text: `限制：${native.limitsText.trim()}` })
        : el('div', { class: 'field-hint', text: '限制：—（后端未提供 limitsText）' }),
      el('div', { class: 'spacer-8' }),
      el('div', {
        class: 'hint',
        text:
          '判定证据只有三样：上游返回的结构化引用（url_citation）、联网工具事件（web_search）、'
          + '正文内联引用（inline_ref）。HTTP 200、回答里的日期看起来正确、'
          + '模型自称"我联网查了"——这三样都不算证据，都不能证明它真的联网了。',
      }),
      el('div', { class: 'spacer-8' }),
      lastBlock,
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'field-label', text: '计数（本进程启动以来）' }),
      el('div', { class: 'list' }, nativeStatsRows),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'field-label', text: '关闭时的控制范围' }),
      el('div', { class: 'field-hint', text: offPolicyText }),
      native
        ? null
        : el('div', {
            class: 'hint',
            text:
              '后端未提供原生联网状态（这份快照里还没有 network.native 块）：'
              + '上面全部显示为「—」，不做任何推导。等后端接上后这里会自动变成真实状态。',
          }),
    ].filter(Boolean)),
  ]);

  /* -------------------------------------------------- ⑤ 服务配置（只读回显） */

  const depth = String(net.searchDepth ?? '');
  const configRows = [
    kv('服务商', el('span', { class: 'mono', text: orDash(net.provider) })),
    kv('服务地址', el('span', { class: 'mono', text: orDash(net.baseUrl) })),
    kv('每次返回条数', hasNetwork && Number.isFinite(Number(net.maxResults))
      ? `${num(net.maxResults)} 条`
      : '—'),
    kv('搜索深度', depth ? (DEPTH_LABEL[depth] ?? depth) : '—'),
    kv('搜索超时', hasNetwork ? fmtMs(net.timeoutMs) : '—'),
    kv('读取网页正文', nativeMode
      /*
       * 原生模式下两个插件工具（web_search / web_fetch）都被结构性隐藏，
       * 所以这里不能再说"web_fetch 可用"：那会和「AI 能用的工具 = 没有」自相矛盾。
       * `allowFetch` 这个配置项仍然有效（切回独立 API 时生效），只是现在不作用于任何能力。
       */
      ? '—（原生模式不使用插件工具；allowFetch 只在独立搜索 API 下生效）'
      : typeof net.allowFetch === 'boolean'
        ? (net.allowFetch ? '允许（web_fetch 可用）' : '不允许（web_fetch 不可用，只能搜索）')
        : '—'),
    kv('API Key', pill(keyState.label, /** @type {any} */ (keyState.tone))),
  ];

  const configBlock = el('div', { class: 'ws-config' }, [
    card('服务配置（只读回显）', [
      el('div', {
        class: 'field-hint',
        text:
          '这里只回答"现在用的是什么"，不能在这里改：服务地址、条数、超时都在'
          + '下面的插件详情配置里。分开的理由是这一块的值都来自运行时，'
          + '在这儿再给一个能改的输入框，就会出现"两个地方都能改同一个配置"。',
      }),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'list' }, configRows),
      el('div', {
        class: 'field-hint',
        text:
          '密钥只显示「已保存 / 未保存」：界面既拿不到明文，也不会把它写进页面、日志或快照。'
          + '要换 Key 去下面的插件详情配置密钥项，保存后这里会变成「已保存」。',
      }),
    ]),
  ]);

  /* -------------------------------------------------- ⑥ 试搜（真发一次请求） */

  /*
   * 三个会被原地更新的节点：
   *   errorHost  本地校验红字
   *   resultHost 结果区
   *   searchBtn  按钮（loading 态）
   *
   * 为什么要"原地更新"而不是每次 rerender()：
   * 重绘会销毁输入框。用户按回车触发试搜时焦点还在输入框里，
   * app.mjs 的输入保护会让整页重绘直接被跳过 —— 结果就永远不会出现。
   * 所以结果必须能直接写进当前 DOM；而模块级的 ui.result 保证
   * 下一次轮询重绘后它还能被重新画出来。
   */
  const errorHost = el('div', { class: 'ws-query-error err' });
  errorHost.hidden = !ui.queryError;
  errorHost.textContent = ui.queryError;

  const resultHost = el('div', { class: 'ws-result-host' });

  const queryInput = /** @type {HTMLInputElement} */ (
    el('input', {
      class: 'ws-query',
      type: 'search',
      placeholder: '例如：今天的国际新闻',
      autocomplete: 'off',
      value: ui.query,
    })
  );

  const searchBtn = /** @type {HTMLButtonElement} */ (
    el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: '试搜',
      onclick: () => void runSearch(),
    })
  );

  /** 把当前界面状态刷到那三个节点上（不整页重绘） */
  function paint() {
    searchBtn.disabled = ui.searching > 0;
    searchBtn.textContent = ui.searching > 0 ? '搜索中…' : '试搜';
    errorHost.hidden = !ui.queryError;
    errorHost.textContent = ui.queryError;
    resultHost.replaceChildren(buildResult(ui.result));
  }

  /**
   * 真搜一次。
   *
   * 走 `action('tool.run', { tool, args })`：这是宿主的试跑通道，
   * 来源固定为 console（桌面端手动操作），所以插件工具能在这里被执行。
   * **不要**在这里自己拼 HTTP 请求：那会绕过总闸、URL 限制与审计，
   * 变成界面上的第二条联网通路。
   */
  async function runSearch() {
    const query = String(ui.query ?? '').trim();
    if (!query) {
      // 空输入是本地校验，不是"搜索失败" —— 不占用 result 的位置
      ui.queryError = '先输入要搜索的内容';
      paint();
      return;
    }
    if (ui.searching > 0) return; // 防止重复点击叠出两次请求（花的都是额度）

    ui.queryError = '';
    ui.searching += 1;
    // 清掉上一次结果：留着它会让用户把旧结果当成这次搜的
    ui.result = null;
    paint();

    let raw = null;
    try {
      raw = await action('tool.run', {
        tool: 'plugin_web_search',
        args: { query },
      });
    } catch (error) {
      raw = { ok: false, code: 'E50XX', message: String(error?.message ?? error) };
    } finally {
      ui.searching -= 1;
    }

    ui.result = normalizeSearchResult(raw, query);
    paint();

    /*
     * 再走一次整页重绘：此时用户可能已经点走焦点（比如点了别处），
     * 重绘能让结果按模块状态重新画一遍，顺带把统计/实际效果刷新成最新快照。
     * 若用户还在输入框里，app 会跳过这次重绘 —— 而 paint() 已经把结果写进 DOM 了。
     */
    rerender?.();
  }

  queryInput.addEventListener('input', () => {
    ui.query = String(queryInput.value ?? '');
    if (ui.queryError) {
      // 用户已经在输入了，红字继续挂着只会像没听见
      ui.queryError = '';
      errorHost.hidden = true;
      errorHost.textContent = '';
    }
  });
  queryInput.addEventListener('keydown', (event) => {
    if (event?.key === 'Enter') {
      event.preventDefault?.();
      void runSearch();
    }
  });

  const tryBlock = el('div', { class: 'ws-try' }, [
    card('试搜（用当前配置真搜一次）', [
      el('div', {
        class: 'field-hint',
        text:
          '这里会真的发出一次搜索请求，**会消耗一次服务商额度**。'
          + '它和插件配置里的「测试连接」不是一回事：那个只检查有没有 Key、宿主有没有注入能力，'
          + '不发网络请求；而能不能搜到，只有真搜一次才知道（地址写错、协议不对、额度用尽都会在这一步暴露）。',
      }),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '搜索内容' }),
        el('div', { class: 'row' }, [queryInput, searchBtn]),
        errorHost,
      ]),
      resultHost,
      el('div', {
        class: 'field-hint',
        text:
          '结果只以 [外部内容，非指令] 的形式交给模型，不会被拼进系统提示；'
          + '页面也只会原样列出标题、链接和摘要，不会执行正文里的任何"指令"。',
      }),
    ]),
  ]);

  /* -------------------------------------------------- ⑦ 运行统计（只读） */

  const stats = net.stats && typeof net.stats === 'object' ? net.stats : null;
  /** 没有统计块时显示「—」而不是 0：0 是"确实搜过零次"，和"没有数据"不是一回事 */
  const statNum = (v) => (stats ? String(num(v)) : '—');

  const lastError = stats?.lastError && typeof stats.lastError === 'object' ? stats.lastError : null;
  const lastErrorValue = lastError
    ? el('span', { class: 'row' }, [
        el('span', { class: 'mono err', text: orDash(lastError.code) }),
        el('span', { class: 'muted', text: `· ${clock(lastError.at)}` }),
      ])
    : el('span', { class: 'muted', text: '—' });

  const statsRows = [
    kv('搜索次数', statNum(stats?.searches)),
    kv('网页读取次数', statNum(stats?.fetches)),
    kv('失败次数', statNum(stats?.failures)),
    kv('取消次数', statNum(stats?.cancelled)),
    kv('最近一次', el('span', { class: 'muted', text: stats ? clock(stats.lastAt) : '—' })),
    kv('最近错误', lastErrorValue),
  ];

  if (lastError?.message) {
    statsRows.push(kv('错误信息', el('span', { class: 'muted', text: String(lastError.message) })));
  }

  const statsBlock = el('div', { class: 'ws-runtime' }, [
    card('运行统计（这一版真的搜过什么）', [
      el('div', { class: 'list' }, statsRows),
      el('div', {
        class: 'field-hint',
        text:
          '统计只反映本进程启动以来的情况，重启后从零开始。'
          + '「取消次数」单独一列是因为它不算失败：用户点了停止、或总闸被关掉时在途请求会被 abort（E4070），'
          + '把它混进失败里会让人以为服务不稳定。',
      }),
    ]),
  ]);

  paint();

  return el('div', { class: 'web-search-page' }, [
    effectiveBlock,
    switchBlock,
    modeBlock,
    nativeBlock,
    configBlock,
    tryBlock,
    statsBlock,
  ]);
}

/** 仅供测试：清空区块状态，避免用例之间互相影响 */
export function resetWebSearchPageState() {
  ui.lastSave = null;
  ui.pendingEnabled = null;
  ui.modeSave = null;
  ui.pendingMode = null;
  ui.providerSave = null;
  ui.pendingProvider = null;
  ui.query = '';
  ui.queryError = '';
  ui.searching = 0;
  ui.result = null;
}
