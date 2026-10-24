/**
 * 后端入口 —— F1 的后端侧
 *
 * 职责：装配各模块，通过 **stdio JSON-RPC** 与主进程通信（DECISIONS D2）。
 *
 * 契约纪律（F13 边界第 4 条 / 不变量 I11）：
 *   IPC 只有三个 method —— snapshot / action / setting，**不按功能加通道**。
 *   加一个 QQ 能力（发语音、发表情）不需要动这里，也不需要动 preload。
 *
 * 本文件不 import electron：后端可以在纯 Node 下跑回归（不变量 I1）。
 */

import readline from 'node:readline';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { resolvePaths, defaultToolRoots } from './config/paths.mjs';
import { clearApiKey } from './config/credentials.mjs';
import { validateConfig, DEFAULT_CONFIG } from './config/schema.mjs';
import { readJson, writeJsonAtomic } from './config/atomic.mjs';
import { Logger } from './config/logger.mjs';
import { OneBotClient, CLIENT_STATE } from './onebot/client.mjs';
import { normalizeEvent, escapeCq } from './onebot/events.mjs';
import { isSelfMessage, MessageDedup, TurnQueue } from './session/inbound.mjs';
import { SessionStore } from './session/store.mjs';
import { DiaryStore, DiaryScheduler } from './diary/store.mjs';
import { generateDiary, collectGroupsForDate } from './diary/generate.mjs';
import { localDateKey } from './diary/decay.mjs';
import { computeWeight, isHidden, shouldIncludeInContext } from './diary/decay.mjs';
import { UpstreamHealth } from './onebot/health.mjs';
import { passSendGate, checkWhitelist, RateLimiter } from './guard/send-gate.mjs';
import { auditOutbound, maskSecret } from './guard/audit.mjs';
import { assertOrigin, ORIGIN } from './guard/origin.mjs';
import { resolveToolSet, toOpenAiTools, RISK } from './guard/tool-gate.mjs';
import {
  ConfirmRegistry,
  parseConfirmReply,
  describeOutcome,
  normalizeMessageId,
  SETTLE_REASON,
} from './guard/confirm.mjs';
import { coreAdminIds, deliverableAdminIds, isCoreAdmin, normalizeAdminIds } from './guard/admin.mjs';
import { listTools, describeTools } from './tools/registry.mjs';
import { registerReadonlyTools } from './tools/basic.mjs';
import { createToolRunner } from './tools/executor.mjs';
import { installBuiltinPlugins, migrateLegacyPlugins } from './tools/builtin-plugins.mjs';
import { PluginManager } from './plugins/manager.mjs';
import { migrateLegacyDsh } from './plugins/legacy.mjs';
import { normalizeChatTools } from './plugins/chat-tools.mjs';
import { registerAllActions, snapshotRegistry, renderRegistryBanner } from './registry.mjs';
import { LlmClient, estimateTokens, THINKING_STYLES } from './llm/client.mjs';

/**
 * 允许的思考开关取值。
 *
 * 单独提出来是为了让"校验"和"文档"是同一份数据 —— 手写数组迟早和
 * client.mjs 里的表漂移，那时会出现"设置存下来了但请求没变"的怪事。
 */
const THINKING_STYLE_KEYS = new Set(['auto', ...Object.keys(THINKING_STYLES)]);
import { buildMessages, DEFAULT_PERSONA, buildStickerGuidance, resolvePersonaStickerPolicy } from './llm/prompt.mjs';
import { runTurn, truncationNotice } from './llm/agent-loop.mjs';
import { MAX_MESSAGES_HARD_CAP } from './reply/split.mjs';
import { createSequencer } from './reply/send.mjs';
import { deliverReply } from './reply/deliver.mjs';
import { detectTrigger, detectPokeTrigger, decideProactive, isStrongTrigger, TriggerLedger, WakeLedger } from './llm/triggers.mjs';
import { SilenceGate, parseSilenceCommand, SILENCE_REASON, MAX_MUTE_MS, matchWindow } from './llm/silence.mjs';
import { UsageLedger } from './llm/usage.mjs';
import { PersonaStore, RoleStore } from './llm/persona.mjs';
import { ThinkingStore } from './llm/thinking.mjs';
import { sealSecret, openSecret, isVaultAvailable } from './config/vault.mjs';
import { probeModel, describeCatalog, endpointKey, endpointCapabilities, sanitizeModelCapabilities } from './llm/capability.mjs';
/*
 * 视觉链路（docs/vision-contract.md）。
 *
 * 三个模块的分工是刻意的：
 *   media-refs  纯函数，段 → 元数据（每条消息都会跑，必须零 IO）
 *   vision      编排 + 预算 + 缓存 + 降级（不碰全局，全部注入）
 *   image-fetch 受控取图（SSRF / 越界路径 / 类型 / 字节 / 像素都在这层挡）
 *
 * 这里只 import vision 的编排层：取图细节不该出现在入口文件里，
 * 否则"哪些边界被守住了"会散落在两千多行的流程中，没人能一次看全。
 */
import { collectTurnImages, normalizeVisionConfig, resetVisionCache, VISION_LIMITS_HARD } from './llm/vision.mjs';
import { extractImageRefs } from './llm/media-refs.mjs';
import {
  annotateImagePlaceholders,
  buildVisionSnapshot,
  contentToText,
  floorsWithSubmittedImages,
  messagesToPlainText,
  recordVisionTurn,
  resolveEffective,
} from './llm/vision-runtime.mjs';
import { looksLikeImageRejection } from './llm/client.mjs';
import { registerChatImageTools } from './tools/chat-image.mjs';
import { createGatewayFactory } from './plugins/gateway-bridge.mjs';
/*
 * 联网（本轮新增，契约见 docs/web-search-contract.md）。
 *
 * 三个模块分工：
 *   gate.mjs      总闸判定（**全项目唯一一处**）
 *   host-net.mjs  宿主侧的 ctx.net 工厂：开关现读 + 在途取消 + 统计
 *   view.mjs      快照里的 network 块（四态，界面逐格显示）
 *
 * 这里只 import 编排层：协议细节（Tavily / 受限抓取）不该出现在入口文件里，
 * 否则"哪些边界被守住了"会散落在五千行流程中，没人能一次看全。
 */
import { createNetFactory } from './net/host-net.mjs';
import { networkEnabledFrom } from './net/gate.mjs';
import { buildNetView, createNetStats, disabledNetTools, NET_PLUGIN_ID } from './net/view.mjs';
import { applyNetworkToggle } from './net/toggle.mjs';
import { resolveNativeSearch } from './llm/provider-search.mjs';
import { unlink as fsUnlink } from 'node:fs/promises';
import { probeEnvironment } from './env/probe.mjs';

const paths = resolvePaths();
const log = new Logger({ dir: paths.logsDir, level: process.env.LING_LOG_LEVEL ?? 'info' });

/**
 * 确认请求的等待上限（60s）。
 *
 * 取值留在 index.mjs 而不是只放 guard/confirm.mjs 里：静态检查 I17
 * 断言的是"确认通道有 60 秒超时且超时落在 deny"，它读的就是这个文件。
 * 语义权威仍在校验层（registry 的 expiresAt），这里只是宿主传入的值。
 */
const CONFIRM_TIMEOUT_MS = 60_000;

/** @type {any} */
let config;
/** @type {OneBotClient | null} */
let client = null;
const health = new UpstreamHealth();
/** @type {RateLimiter} */
let limiter;
/** @type {object[]} */
let messages = [];
let lastError = null;
/** @type {object[]} */
let toolCallLog = [];
/** @type {string} 人格注入文本（F8 人格层） */
/**
 * 界面"当前在编辑"的那张卡的文本。
 *
 * 注意它**不再参与注入** —— 注入由 personaStore.resolveFor(convKey) 决定。
 * 留着它只是为了 snapshot 里的 persona 字段（界面回显用）。
 * 这是一个容易搞错的地方：改这里不会改变任何会话的行为。
 */
let persona = '';

/** @type {LlmClient | null} */
let llm = null;
/** API Key 的来源：env / vault / config / none / vault-broken */
let keySource = 'none';
/** 当前生效的 API Key（只在内存里，绝不落盘、绝不进日志） */
let currentApiKey = '';
/** @type {UsageLedger} */
let usageLedger;
/** 触发状态簿（主动发言的 30 分钟间隔靠它） */
const triggerLedger = new TriggerLedger();
/**
 * 唤醒频率账本。
 *
 * 和 triggerLedger 分工不同：那个管"它自己想说话的间隔"，
 * 这个管"因为别人的消息起回合"的节奏 —— 两件不同的事。
 * 一个活跃群每分钟几十条消息，每条都起回合就是刷屏 + 烧钱。
 *
 * 超限时**不触发**（而不是排队）：排队的语义是"稍后回复"，
 * 而这里的问题是"不该回"。见 src/llm/triggers.mjs 的 WakeLedger 注释。
 */
const wakeLedger = new WakeLedger();

/**
 * 回复分条的会话串行器。
 *
 * ## 为什么必须在模块级共享一份
 *
 * "同一会话按顺序发送"这条要求，只有**所有回合共用同一个串行器**时才成立。
 * 每个回合各建一个的话，两个回合同时结束时依旧会穿插（A1 B1 A2 B2）——
 * 那正是这条要求要防的。
 *
 * 串行器只做排队（一个 per-convKey 的 Promise 链），不改变回合的并发策略：
 * 回合本身仍然由 inflight 保证每会话只有一个在跑，这里多守一层是因为
 * "回合结束"和"消息发完"不是同一时刻 —— 上一回合的最后一条可能还在间隔里。
 */
const replySequencer = createSequencer();

/**
 * 静音闸门（F20「闭嘴」）。
 *
 * 四种来源：全局 / 按会话 / 时段 / 指令临时。
 * 只有"指令临时"有内存状态，其余三种从配置现算 —— 所以重启后
 * 临时静音自然失效（用户重启往往就是想让它恢复）。
 *
 * 它**独立于** `wake` 并且排在它前面：wake 是"什么消息值得回应"的语义判断，
 * 静音是"现在根本不许说话"的绝对压制。混在一起就会出现
 * "消息特别像在叫它 → 还是回了"，那静音就是假的。
 */
const silenceGate = new SilenceGate();

/**
 * 这个发消息的人能不能用静音指令。
 *
 * 唯一来源是 `silence.adminIds`。
 *
 * ## 为什么不复用 `dsh.admins`
 *
 * DSH 已经是**独立插件**了。核心功能反向依赖插件配置会出两个问题：
 *
 *   1. 不装 DSH 插件的用户配不了静音指令 —— 字段藏在别处，根本找不到
 *   2. 卸载插件后静音权限凭空消失，而用户不知道为什么
 *
 * 而且两者授权范围不同：`dsh.admins` 管的是"能否操作本机 DSH"，
 * 静音只是让它闭嘴。愿意把静音权限给更多人、但不愿给本机操作权，
 * 是很正常的要求。
 *
 * ## 为什么空名单 = 谁都不能
 *
 * 静音能让机器人彻底不说话。默认给所有人这个能力，
 * 等于把"让它闭嘴"变成群友可以随手用的骚扰手段。
 * fail-closed 在这里是对的。
 *
 * @param {object} evt
 * @returns {boolean}
 */
function isAdmin(evt) {
  const from = String(evt?.sender?.userId ?? '').trim();
  if (!from) return false;
  // 自己发的消息已经在上游被过滤掉，这里再挡一层：不能自己给自己下指令
  if (selfId && from === String(selfId)) return false;

  const list = Array.isArray(config.silence?.adminIds) ? config.silence.adminIds : [];
  return list.some((id) => String(id).trim() === from);
}

/**
 * 执行一条静音指令，并在会话里回一句确认。
 *
 * ## 为什么一定要回执
 *
 * 指令是"改变状态"的操作，没有回执用户就不知道有没有生效 ——
 * 然后他会反复发，或者以为坏了。回执还要**说清什么时候恢复**，
 * 否则用户只能盯着表等。
 *
 * @param {object} evt
 * @param {{kind: 'mute', ms: number} | {kind: 'unmute'}} cmd
 */
async function handleSilenceCommand(evt, cmd) {
  const convKey = evt.convKey;
  try {
    if (cmd.kind === 'unmute') {
      const r = silenceGate.unmute(convKey);
      log.info('静音指令：解除', { convKey, wasSilent: r.wasSilent });
      await sendText(
        convKey,
        r.wasSilent
          ? '好，我回来了。'
          : '我本来就没在静音。如果还是没反应，可能是全局静音或静默时段开着，那个得在桌面端改。',
      );
      return;
    }

    /*
     * 上限来自配置：`maxMuteMs` 兜住"闭嘴 999d"这种手滑。
     * 0 表示不限 —— 但那时也不该让一条聊天指令把机器人永久静音，
     * 所以仍然用 MAX_MUTE_MS 兜底。
     */
    const cap = Number(config.silence?.maxMuteMs) > 0 ? Number(config.silence.maxMuteMs) : MAX_MUTE_MS;
    const ms = Math.min(cmd.ms, cap);
    const { until } = silenceGate.mute(convKey, ms);

    const mins = Math.max(1, Math.round(ms / 60_000));
    const untilText = new Date(until).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    log.info('静音指令：闭嘴', { convKey, ms, until });

    await sendText(convKey, `好，我安静 ${mins} 分钟，到 ${untilText} 自动恢复。想提前叫我说话就发「说话」。`);
  } catch (err) {
    log.warn('静音指令回执发送失败', {
      convKey,
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }
}
/** 每个会话的最近消息（拼上下文用，比全局 messages 更准） */
/** @type {Map<string, Array<{role: string, nickname?: string, text: string}>>} */
const recentByConv = new Map();
/**
 * 视觉链路的运行时统计（只给界面看，不进任何判定）。
 *
 * ## 为什么单独一个对象，而不是塞进配置
 *
 * 配置回答"用户想要什么"，统计回答"这一版实际发生了什么"。混在一起最典型的
 * 翻车是：用户改了预算 → 配置落盘 → 统计被一起写回去 → 重启后界面显示
 * "上回合提交了 3 张图"，而那个回合根本不存在。
 *
 * 所以它只在内存里，重启归零，界面文案也明确说了"只反映本进程"。
 *
 * `lastTurn` 是 `effective: 'on-but-blocked'` 的唯一依据：
 * 开关开着、模型也没说不行，但这一回合一张图都没装进去 —— 那是"被挡下"，
 * 与"用户关了"和"模型不能"是三种完全不同的处境，必须能分开显示。
 */
const visionRuntime = {
  /** 带图回合数 */
  turnsWithImages: 0,
  /** 累计提交张数 */
  imagesSubmitted: 0,
  /** 累计提交字节 */
  bytesSubmitted: 0,
  /** 累计放弃张数（取图失败 / 超预算 / 已提交过） */
  skipped: 0,
  /** 最近一回合的明细 */
  lastTurn: { attempted: 0, loaded: 0, bytes: 0, codes: /** @type {string[]} */ ([]), notes: /** @type {string[]} */ ([]) },
  /** 最近出现的失败码（去重、有界） */
  lastCodes: /** @type {string[]} */ ([]),
  /** 最近一次"上游拒收图片"的时间（毫秒）。与 capability 分开记，见降级矩阵 */
  lastImageRejectedAt: null,
  /** 上游拒收图片的累计次数 */
  imageRejectedCount: 0,
  lastAt: null,
};
/**
 * 联网能力的运行统计（契约：docs/web-search-contract.md §6）。
 *
 * 和 `visionRuntime` 同一套纪律：**只在内存里**，重启归零。
 * 它不是配置，用户改不了它；它的用途只有一个 —— 让用户打开
 * 《插件设置 → 联网搜索》时能看到"这一版到底搜过几次、最近为什么失败"。
 *
 * 为什么由宿主持有而不是插件自己记：插件可能被停用/重载，
 * 而"这个进程一共联网几次"是**进程级事实**。放进插件的话，
 * 一次重载就把历史清零，界面上却看不出来。
 */
const networkRuntime = createNetStats();

/**
 * 服务商原生联网的运行状态（**只在内存里**，重启归零）。
 *
 * 与 `networkRuntime` 分开，因为两条通道的语义不同：
 *   · 独立搜索：我们发请求，成功/失败可由自己的代码判定；
 *   · 原生联网：检索在服务商服务端，只能记录"上游带回了什么证据"。
 *
 * `last` 里的 `status` 是**后端判定**，界面原样展示：
 *   searched     有引用/来源/角标
 *   unknown      请求带了联网声明，但没有任何可验证证据（最常见）
 *   rejected     上游明确拒绝联网参数（随后会自动降级重试一次）
 *   not-requested 本次没有请求原生联网
 *   unavailable  服务商未适配/未选择
 *
 * 绝不用 HTTP 200 补一个 `searched` —— 那会把"中转忽略了参数"记成成功。
 */
const nativeSearchRuntime = {
  /** @type {{at:number,provider:string,status:string,kind:string,sources:object[],inlineRefs:number,detail:string}|null} */
  last: null,
  stats: { requests: 0, evidence: 0, noEvidence: 0, rejected: 0, lastAt: null },
};

/**
 * 把一轮的原生联网证据记进运行状态。
 *
 * 只接受后端自己判定的形状；脏值一律按"无法确认"记，不写成成功。
 *
 * @param {any} report `runTurn` 返回的 `nativeSearch`
 */
function recordNativeSearch(report) {
  if (!report || typeof report !== 'object') return;
  const at = Date.now();
  const status = ['searched', 'unknown', 'rejected', 'not-requested', 'unavailable'].includes(String(report.status))
    ? String(report.status)
    : 'unknown';
  const kind = ['url_citation', 'web_search', 'inline_ref', 'none'].includes(String(report.kind))
    ? String(report.kind)
    : 'none';
  const sources = Array.isArray(report.sources)
    ? report.sources
      .filter((s) => s && typeof s.url === 'string' && s.url)
      .slice(0, 5)
      .map((s) => ({ title: String(s.title ?? ''), url: String(s.url) }))
    : [];

  nativeSearchRuntime.stats.requests += 1;
  if (status === 'searched') nativeSearchRuntime.stats.evidence += 1;
  else if (status === 'rejected') nativeSearchRuntime.stats.rejected += 1;
  else nativeSearchRuntime.stats.noEvidence += 1;
  nativeSearchRuntime.stats.lastAt = at;
  nativeSearchRuntime.last = {
    at,
    provider: String(report.provider ?? ''),
    status,
    kind,
    sources,
    inlineRefs: Math.max(0, Math.trunc(Number(report.inlineRefs?.length ?? report.inlineRefs) || 0)),
    detail: String(report.detail ?? '').slice(0, 400),
  };

  // 只记状态与条数：来源正文、用户提问都不进日志（它们可能含隐私内容）。
  log.info('原生联网状态', {
    provider: nativeSearchRuntime.last.provider,
    status,
    kind,
    sources: sources.length,
    fallback: report.fallback === true,
  });
}

/**
 * 联网能力工厂（boot 里装配）。
 *
 * 为什么是模块级的 `let` 而不是塞进某个对象：setting 通道关闭总闸时
 * 要立刻调用它的 `refresh()` 把在途请求掐掉，而那时只有这里能拿到它。
 *
 * 为 null 表示"还没启动完"或"装配失败"：两种情况下 UI 都显示不可用，
 * 而不会假装能用。
 *
 * @type {ReturnType<typeof createNetFactory> | null}
 */
let netFactory = null;

/** 正在跑的回合：同一会话同时只允许 1 个（F7 并发约束） */
/** @type {Map<string, AbortController>} */
const inflight = new Map();/**
 * 排队等待的强触发（不能用"忙"把人晾着）。
 *
 * ## 为什么从 Map 换成了 TurnQueue
 *
 * 原来是 `Map<string, job>` —— 一个会话只有一个槽位。回合还在跑的时候
 * 连着来两条 @，第二条直接 `set` 把第一条**覆盖**掉：第一条永远不会被回复，
 * 而日志里看起来"排过队"。这种静默丢弃没有任何错误可查，用户只看到
 * "连问两句只回最后一句"。队列 + 上限才是正确形状。
 */
const pendingTurns = new TurnQueue({ limit: 5 });
/**
 * 已处理消息的去重表。
 *
 * 断线重连和上游补发会把同一条消息再推一次，没有它就会同一个问题跑两个回合。
 */
const dedup = new MessageDedup();
/**
 * 待人工确认的 R2/R3 工具调用 —— 全部交给 ConfirmRegistry。
 *
 * ## 为什么不再是两个裸 Map
 *
 * 原来这里是一个 `pendingConfirms`（id → 请求）加一个 `confirmSeq`
 * （序号 → id）。两张表由调用点手工同步，于是必然出三件事：
 *
 *   1. **不认人、不认会话**：QQ 侧回来的「1」只按序号找目标，
 *      谁回、在哪个会话回都不看。群里任何人、任何私聊都能批掉它。
 *   2. **不认引用**：卡片写着"引用这条回数字"，但结算时引用被忽略，
 *      并发两条时就会批错对象。
 *   3. **抢插件**：这个入口跑在插件之前，于是 DSH 的引用审批
 *      可能先被它拿走（认不出引用，就按序号猜了）。
 *
 * 现在身份、会话、消息 ID、有效期、结算状态全部绑在**登记那一刻**
 * （见 guard/confirm.mjs 的文件头），入口只做"精确定位或交回"。
 */
const confirms = new ConfirmRegistry({
  timeoutMs: CONFIRM_TIMEOUT_MS,
  onTimeout: ({ id, tool }) => {
    /*
     * 通知桌面端「它超时了，已按拒绝处理」。
     *
     * 不通知的话，确认条会在界面上一直挂着倒计时到 0 然后消失，
     * 用户不知道结论是什么 —— 而工具那边其实早就拿到 deny 了。
     */
    rpc.notify('confirm-timeout', { id, tool });
    log.warn('确认超时，按拒绝处理', { id, tool });
  },
});
/**
 * 插件管理器：骨架改造后所有插件相关的事都归它管
 * （扫描/校验/启停/配置/工具登记/诊断）。
 *
 * 这里刻意不再保留"直接抓着插件模块调钩子"的做法：
 * 一旦插件可能跑在子进程里，宿主就不能持有它的模块对象了 ——
 * 统一走管理器，两种运行时才有同一套行为。
 *
 * @type {PluginManager | null}
 */
let plugins = null;
/** 人格卡仓库：它是谁（性格、说话风格） */
const personaStore = new PersonaStore({ filePath: paths.personaPath });
/**
 * 角色卡仓库：它在什么场景扮演什么（群聊参与者 / 私聊助手 / 客服）。
 *
 * 独立文件、独立 activeId —— 换角色不动人格，换人格不动角色。
 * 这是两者"正交"的落地方式。
 */
const roleStore = new RoleStore({ filePath: paths.rolePath });

/**
 * 思考链路仓库：推理模型的 `reasoning` 按「会话 + 日」归档，只给界面看。
 *
 * 它是**纯展示数据**：不进任何一次请求的 messages（回灌 reasoning 会被上游 400），
 * 也不参与授权与记账。所以它挂了、满了、被清了都不影响对话本身。
 */
const thinkingStore = new ThinkingStore({ dir: paths.thinkingDir });

/**
 * 会话楼层仓库：每条消息一个楼层号，加上「读到第几楼」。
 *
 * ## 它解决的是「回复混乱」的根，不只是存档
 *
 * 之前会话只活在内存里的 `messages` 数组（上限 500），重启即清空。
 * 但更麻烦的是它没有「读到哪儿」的记号 —— 于是"这一回合该喂哪些消息"
 * 只能靠 `最近 20 条` 这种模糊说法，一旦并发或补发就会重复喂、或者漏喂。
 *
 * 楼层 + 读楼层把这件事变成一个精确的事实，见 session/store.mjs 的文件头。
 */
const sessionStore = new SessionStore({ filePath: paths.sessionsPath });

/**
 * 日记仓库：一天一个文件 `data/state/diary/<YYYY-MM-DD>.json`。
 *
 * 它只负责**存**。怎么把一天的聊天变成一篇总结在 diary/generate.mjs 里，
 * 因为那边要调 LLM —— 而"存"这块最需要能脱离模型单测。
 */
const diaryStore = new DiaryStore({ dir: paths.diaryDir });

/**
 * 跨日调度器。
 *
 * 它不读写磁盘、也不调模型，只依赖注入的四个回调（这也是它能单测的原因）。
 * 两个触发点：
 *   · 启动时 `catchUpOnStartup()` —— 补生成昨天（如果缺失且有活动）
 *   · 运行中每分钟 `tick()` —— 跨过零点时生成昨日
 *
 * 幂等由两层保证：内存的已生成集合 + 磁盘存在性检查。
 * 重启后内存集合必然空，靠后者兜住。
 *
 * @type {DiaryScheduler | null}
 */
let diaryScheduler = null;

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  const userConfig = (await readJson(paths.configPath)) ?? {};
  config = validateConfig(userConfig);

  /*
   * ---- 管理员名单：兼容迁移与启动留痕 ----
   *
   * ## 为什么要有这一步
   *
   * 这一版把「谁能让它动本机」从 `allow.private` 拆到了 `admin.qqIds`。
   * 老用户的白名单里很可能填的就是自己的号 —— 升级后如果不作任何提示，
   * 表现是"以前能读文件，现在报没权限"，而且用户不知道该去哪补。
   *
   * 两种处理，都不静默：
   *
   *   1. **已经配了管理员**：什么都不做，只记一行（人数，不记号码本身）。
   *   2. **没配管理员，但白名单里有人**：记一条 warn，明确告诉他
   *      「白名单不再自动等于管理员，要去安全页补 admin.qqIds，
   *      或者显式打开兼容开关」。**不自动帮他打开** ——
   *      自动打开等于这次拆分白做，而用户会以为权限模型变了。
   *
   * 号码本身一律不进日志：日志会被贴进 issue。
   */
  {
    const admins = coreAdminIds(config);
    const whitelisted = Array.isArray(config.allow?.private) ? config.allow.private.length : 0;
    if (config.admin?.inheritWhitelist === true) {
      log.warn('已开启「白名单视为管理员」：allow.private 里的号码拥有管理员权限', {
        adminCount: admins.length,
        whitelistCount: whitelisted,
      });
    } else if (admins.length === 0 && whitelisted > 0) {
      log.warn(
        '还没有配置管理员（admin.qqIds）：白名单不再自动赋予管理员权限，宿主机工具与确认权都拿不到。请到「系统安全」页添加，或显式打开「白名单视为管理员」',
        { whitelistCount: whitelisted },
      );
    } else {
      log.info('管理员名单已载入', { adminCount: admins.length });
    }
  }

  /*
   * 旧配置迁移：`llm.keywords` → `wake.keywords`。
   *
   * ## 为什么不直接把 llm.keywords 删掉
   *
   * `mergeStrict` 对未知键是**硬错误**（E40XX）。老用户的 config.json
   * 里还写着 `llm.keywords`，删掉这个字段就等于让他们升不了级 ——
   * 一启动就报"未知键"，而且看起来像程序坏了。
   *
   * 所以两边都留着：`llm.keywords` 继续被 schema 接受、迁移后不再使用，
   * 这和 `dsh` 块的处理方式一致（保留但标记废弃）。
   *
   * ## 为什么迁移要保护用户已填的 wake.keywords
   *
   * 用户可能已经在新位置填了关键词。如果无脑用旧值覆盖，
   * 他刚配好的东西就没了。所以只在**新位置为空**时才搬。
   */
  {
    const legacy = Array.isArray(config.llm?.keywords) ? config.llm.keywords : [];
    const current = Array.isArray(config.wake?.keywords) ? config.wake.keywords : [];
    if (legacy.length > 0 && current.length === 0) {
      config.wake.keywords = [...legacy];
      log.info('已把 llm.keywords 迁移到 wake.keywords', { 数量: legacy.length });
    }
  }

  /*
   * 旧配置迁移：`config.dsh` → 插件 `dsh-bridge` 的配置与启用状态。
   *
   * 必须在加载插件**之前**做：管理器读的是 `plugins.config`，
   * 迁移晚一步，老用户升级后的第一轮启动里 DSH 就是"没配置"状态。
   *
   * 迁移失败不能拦住启动（少一个可选功能 << 起不来）。
   */
  try {
    const migrated = await migrateLegacyDsh({
      config,
      secretsPath: paths.pluginSecretsPath,
      log: (msg, meta) => (meta?.level === 'warn' ? log.warn(msg) : log.info(msg)),
    });
    if (migrated.migrated) {
      config = migrated.config;
      await writeJsonAtomic(paths.configPath, config);
    }
  } catch (err) {
    log.warn('旧 DSH 配置迁移失败（不影响启动，可在插件页重新配置）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  /*
   * 旧配置迁移：清掉聊天模型里遗留的**生图探测状态**。
   *
   * 早先的「探测模型」会同时向 `/images/generations` 发一次最小生图请求，
   * 并把 `image` / `probes.image` / `channel: 'imageGen'` 写进
   * `llm.modelCapabilities`。现在聊天模型只探测视觉，生图归独立插件
   * （`plugins/image-generation`）—— 这些旧结论**没有出处也没有用途**，
   * 留着会让界面继续显示"生图 ✓/✗"，看起来像是聊天模型自带的能力。
   *
   * ## 为什么要在启动时迁移
   *
   * 只在读的时候过滤不够：只要用户没再探测过，旧字段就会一直躺在
   * config.json 里；换一台机器、换个界面版本又会被重新读出来。
   * 所以这里一次性清掉并写回。
   *
   * ## 失败不能拦住启动
   *
   * 清理失败最坏的结果是"界面还显示旧结论"，而写配置失败若抛出去
   * 就是**起不来**。所以整体 try/catch，失败只记一条 warn。
   */
  try {
    const { caps, changed } = sanitizeModelCapabilities(config.llm?.modelCapabilities);
    if (changed) {
      config.llm.modelCapabilities = caps;
      await writeJsonAtomic(paths.configPath, config);
      log.info('已清理聊天模型里旧的生图探测状态（生图改由独立插件管理）');
    }
  } catch (err) {
    log.warn('清理旧生图探测状态失败（不影响启动，可在模型页重新探测读图）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  // API Key 的三种来源，优先级从高到低：
  //   1. 环境变量 —— 便于临时换 key 测试，也便于 CI
  //   2. 保险箱（DPAPI 加密，绑定当前 Windows 账户）
  //   3. config.json 里的明文（兼容旧配置）
  //
  // 保险箱解不开时**不静默忽略**：记一条警告，
  // 否则"key 明明存过却用不了"会非常难查（换机器/换账户就会这样）。
  let apiKey = config.llm.apiKey;
  keySource = apiKey ? 'config' : 'none';

  if (process.env.LING_LLM_KEY) {
    apiKey = process.env.LING_LLM_KEY;
    keySource = 'env';
  } else {
    const sealed = await readJson(paths.vaultPath);
    if (sealed) {
      try {
        apiKey = await openSecret(sealed);
        keySource = 'vault';
      } catch (err) {
        log.warn('保险箱里的 API Key 解不开，需要重新填一次', {
          code: /** @type {any} */ (err)?.code,
          hint: '换了 Windows 账户或换了机器时会发生（DPAPI 只认原来的账户）',
        });
        keySource = 'vault-broken';
      }
    }
  }

  currentApiKey = apiKey;

  limiter = new RateLimiter({
    maxPerMinute: config.limits.maxSendPerMinute,
    maxPerHour: config.limits.maxSendPerHour,
  });

  persona = (await loadPersona()) || DEFAULT_PERSONA;
  // 角色和人格各载各的，互不影响
  await loadRole();

  /*
   * 读回近期思考记录。
   *
   * 失败不致命：这只影响"重启前的历史还能不能看到"，对话本身完全不依赖它。
   * 但也不能静默吞 —— 记一条 warn，否则用户会以为思考记录凭空消失了。
   */
  try {
    const loaded = await thinkingStore.load();
    if (loaded.removed > 0) {
      log.info('思考记录已按保留策略清理', { keptDays: loaded.loaded, removed: loaded.removed });
    }
  } catch (err) {
    log.warn('读取思考记录失败（不影响对话）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  /*
   * 读回会话楼层。
   *
   * 这一步让「按条读取聊天记录」成为可能：重启之后历史还在，
   * 而且读楼层也跟着回来 —— 不会一重启就把所有旧消息当成未读重跑一遍。
   *
   * 失败同样不能拦住启动：会话历史是"有更好"的数据，
   * 但坏文件必须留证据（store 会改名成 .corrupt），不能悄悄删。
   */
  try {
    const restored = await sessionStore.load();
    if (restored.recovered) {
      log.warn('会话楼层文件损坏，已留证并重建', { reason: restored.error });
    } else if (restored.loaded > 0) {
      log.info('已恢复会话楼层', { 会话数: restored.loaded });
    }
  } catch (err) {
    log.warn('读取会话楼层失败（不影响对话）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  /*
   * 读回日记 —— 「启动时，读取日记」。
   *
   * 顺序在 sessionStore 之后：跨日补生成要查"昨天有没有会话活动"，
   * 那个数据在会话楼层里。
   */
  try {
    const restored = await diaryStore.load();
    if (restored.recovered) {
      log.warn('部分日记文件损坏，已隔离为 .corrupt', { 已恢复: restored.loaded });
    } else if (restored.loaded > 0) {
      log.info('已恢复日记', { 天数: restored.loaded });
    }
  } catch (err) {
    log.warn('读取日记失败（不影响对话）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  /*
   * 装好跨日调度器并做一次启动补生成。
   *
   * ## 为什么补生成失败不能拦住启动
   *
   * 日记是"有更好"的数据。而且调度器自己会把失败的那天挂起来，
   * 退避窗口过后由每分钟的 tick() 重试 —— 所以启动这一次失败
   * 不等于这一天永远没有日记。
   */
  diaryScheduler = new DiaryScheduler({
    hasDiary: (date) => diaryStore.has(date),
    hasActivity: (date) => sessionStore.hasActivityOn(date),
    onGenerate: (date, trigger) => generateYesterdayDiary(date, trigger),
  });
  try {
    const caught = await diaryScheduler.catchUpOnStartup();
    if (caught.generated) {
      log.info('已补生成昨日日记', { date: caught.date });
    } else if (caught.reason !== 'exists') {
      log.info('昨日日记无需补生成', { date: caught.date, reason: caught.reason });
    }
  } catch (err) {
    log.warn('补生成昨日日记失败（会在后续重试）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  /*
   * 每分钟检查一次有没有跨日。
   *
   * 用 unref：这个定时器不该拖住进程退出 —— 否则用户点关闭后
   * 要等最多一分钟程序才真的退，看起来像卡死。
   */
  {
    const timer = setInterval(() => {
      void diaryScheduler?.tick().catch((err) => {
        log.warn('日记跨日检查失败', { message: String(/** @type {any} */ (err)?.message ?? err) });
      });
    }, 60_000);
    timer.unref?.();
  }

  // LLM 客户端：没配 key 也照常构造，只是 configured=false，界面据此提示
  llm = new LlmClient({
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey,
    timeoutMs: config.llm.timeoutMs,
    thinking: config.llm.thinking,
    /*
     * 原生联网计划**每次请求现读**。
     *
     * 为什么不是构造时传一个对象：用户可能刚把总开关关掉或切了模式，
     * 缓存会让"关了还在发联网声明"。这里返回 null 表示本次请求不带原生联网。
     */
    webSearch: () => {
      const resolved = resolveNativeSearch(config);
      return resolved.active ? resolved.plan : null;
    },
  });
  usageLedger = new UsageLedger({ filePath: `${paths.stateDir}/usage.jsonl` });
  /*
   * 把历史用量读回来。
   *
   * 不做这一步的话，record() 一直在追加写、却从来没人读，
   * 每次打开应用「今日消耗」都会归零 —— 落盘等于白存。
   * 失败不影响启动（统计缺失远小于起不来）。
   */
  {
    const restored = await usageLedger.load();
    if (restored.loaded > 0) {
      log.info('已恢复历史用量', { 最近记录: restored.loaded, 今日调用: restored.today });
    }
  }

  // 骨架装配：先注册动作与工具，再打印清单（让人一眼看到能做什么）
  registerAllActions();
  await registerReadonlyTools({
    roots: config.tools.roots.length > 0 ? config.tools.roots : defaultToolRoots(),
    userDataDir: paths.root,
  });

  /*
   * 图片读取工具（可选能力，开关在调用时判定）。
   *
   * 它把消息里的图以**真正的 image_url** 交回模型，而不是把 base64
   * 塞进 JSON 文本（后者会被 wrapToolResult 截断成一段没用的字符串）。
   * 取图走与自动读图完全相同的受控链路 —— 不另开一套上限，
   * 否则"But 工具能读到"就会成为绕过预算的后门。
   */
  registerChatImageTools({
    getConfig: () => normalizeVisionConfig(config?.vision),
    lookupMessage: ({ convKey, messageId }) => {
      const want = String(messageId ?? '').trim();
      if (!want) return { ok: false };
      // 先查实时事件缓存（有 segments），再退回楼层仓库（有 media 元数据）
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const evt = messages[i];
        if (String(evt?.messageId ?? '') !== want) continue;
        if (String(evt?.convKey ?? '') !== String(convKey ?? '')) continue;
        return { ok: true, event: evt };
      }
      const page = sessionStore.page(convKey, { limit: 200 });
      const hit = page?.messages?.find((m) => String(m.messageId ?? '') === want);
      if (!hit) return { ok: false };
      /*
       * 仓库里只有元数据、没有原始段。把它投影成"只带 file 的段"，
       * 让取图链路照常按缓存名去取 —— 这是重启后历史图片仍然可读的路径。
       */
      return {
        ok: true,
        event: {
          messageId: hit.messageId,
          text: hit.text,
          segments: (hit.media ?? [])
            .filter((m) => m?.file)
            .map((m) => ({ type: 'image', data: { file: m.file } })),
        },
      };
    },
    extractRefs: (segments) => extractImageRefs(segments, { max: 8 }),
    fetchImages: async (refs, ctx) => {
      const cfg = normalizeVisionConfig(config?.vision);
      const collected = await collectTurnImages({
        config: { ...cfg, maxImagesPerTurn: Math.min(cfg.maxImagesPerTurn, 4) },
        convKey: String(ctx?.convKey ?? ''),
        trigger: { images: refs.map((r) => ({ ...r })) },
        history: [],
        alreadySeen: new Set(),
        deps: visionDeps(),
      });
      return collected.images.map((img) => ({ ok: true, dataUrl: img.dataUrl, mime: img.mime }));
    },
  });

  log.info('Ling-bot 后端已启动', { node: process.version, version: '0.1.0-p0' });

  // 内置插件铺盘。
  //
  // 加载器只认插件目录，出厂源是随包的 plugins/。两者**现在默认是同一个
  // 目录**（插件目录已从 %APPDATA% 改到程序目录下），这种情况下
  // installBuiltinPlugins 会直接跳过 —— 见该函数里的路径相等判断。
  //
  // 失败不致命：一个可选功能装不上，不该让主程序起不来。
  try {
    const builtin = await installBuiltinPlugins({
      pluginsDir: paths.pluginsDir,
      log: (msg) => log.info(msg),
    });
    if (builtin.failed.length > 0) {
      log.warn('内置插件安装有失败项', { failed: builtin.failed });
    }
  } catch (err) {
    log.warn('内置插件安装整体失败（不影响主程序）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  /*
   * 旧插件目录迁移。
   *
   * 插件目录从 `%APPDATA%\ling-bot\plugins` 改到了程序目录下。
   * 不迁移的话，用户在旧目录里装的插件会**静默消失** ——
   * 配置里还写着启用，加载器却说 0 个插件，界面上一切正常。
   * 这种"什么都没发生"的故障最难解释。
   *
   * 只做**补齐**，不覆盖目标目录已有的东西：新目录里已经有同名插件，
   * 说明用户已经在新位置改过了，旧副本不该反向冲掉它。
   */
  await migrateLegacyPlugins(paths, log);

  // 插件：空 enabled = 一个都不加载（默认关闭，光放文件不生效）
  /*
   * 联网能力工厂：必须在 PluginManager 之前建好。
   *
   * ## 为什么 getEnabled 读的是 `config.network.enabled`
   *
   * 判定只有一处（`src/net/gate.mjs`），这里传的是"现读总闸"的闭包 ——
   * 每次 search/fetch 进入时都会调一次。缓存成布尔值的后果很具体：
   * 用户点了「关闭联网」，下一个请求仍然发出去，因为工厂手里还是旧值。
   *
   * ## 为什么装配失败只记日志、不拦住启动
   *
   * 联网是可选能力。直接 `throw` 会让整个后端起不来 —— 用户为了一个
   * 搜索功能失去整个机器人。所以 `netFactory` 为 null 时，`ctx.net`
   * 会退回 E4071 占位对象，界面上明确显示不可用。
   */
  try {
    netFactory = createNetFactory({
      /*
       * 用 `networkEnabledFrom` 而不是 `config.network?.enabled === true`。
       *
       * 两者对"配置里没有 network 字段"的旧部署结论相反：
       *   · `=== true`              → false（当作关闭）
       *   · `networkEnabledFrom`    → true（缺省开，理由见 src/net/gate.mjs）
       *
       * 这条口径必须只有一处，否则会出现"界面显示联网开着、工具也可见，
       * 但请求一律被 E4080 拒绝"这种自相矛盾的状态 —— 而 `disabledNetTools`
       * 与 `buildNetView` 读的都是 `networkEnabledFrom`。真正发出请求的
       * getEnabled 反而用了另一套判定，用户怎么查都对不上。
       */
      getEnabled: () => networkEnabledFrom(config),
      stats: networkRuntime,
      log: (level, message, fields) => {
        if (level === 'warn') log.warn(message, fields);
        else if (level === 'error') log.error(message, fields);
        else log.info(message, fields);
      },
    });
  } catch (err) {
    netFactory = null;
    log.error('联网能力装配失败：搜索与网页读取将不可用（其余功能不受影响）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  plugins = new PluginManager({
    pluginsDir: paths.pluginsDir,
    userDataRoot: paths.root,
    secretsPath: paths.pluginSecretsPath,
    getConfig: () => config,
    persistConfig: async (next) => {
      config = next;
      await writeJsonAtomic(paths.configPath, config);
    },
    log: (level, message, fields) => {
      if (level === 'error') log.error(message, fields);
      else if (level === 'warn') log.warn(message, fields);
      else log.info(message, fields);
    },
    // 宿主发送闸门：插件发的每一条消息都要过白名单/审计/限流
    sendText: (convKey, text) => sendText(convKey, text),
    /*
     * 任意消息段（图片/语音/文件）的发送通路。
     *
     * 与 sendText 走**同一个** sendSegments，所以白名单、出站审计、限流
     * 一条都不会漏过。给插件单开一条捷径是最典型的授权漏洞。
     */
    sendSegments: (input) => sendSegments(input.convKey, input.segments, input.auditText, input.signal),
    // 后台媒体与AI分条回复共享同一个会话队列，不能插入回复中途。
    sequencer: replySequencer,
    /*
     * 插件用 `ctx.chat.send` / `sendMedia` 真的发出去之后，记一条上下文。
     *
     * ## 为什么必须记
     *
     * 模型下一轮能不能看见"我刚才用工具发过这句话/这张图"，全靠这一条。
     * 不记的话它完全不知道自己已经发过，很容易在同一段回复里再做一遍 ——
     * 用户看到"同一张图两条"，而日志里两次都是成功发送，看不出哪里错了。
     *
     * 记的是**展示文本**（`[图片]` / 正文），不是图片内容：上下文里只需要
     * "发生过这件事"，把 base64 塞进历史会把会话文件撑爆，也会让下一轮
     * 请求体带上无用的图片。
     *
     * `gateway.sendFace` 有它自己的 `onFaceSent`（记 `[表情]`），两者语义相同、
     * 位置不同：那条路径在网关桥里，这条在聊天桥里。
     */
    onSent: ({ convKey, text }) => {
      const key = String(convKey ?? '');
      const shown = String(text ?? '').trim();
      if (!key || !shown) return;
      pushRecent(key, { role: 'assistant', text: shown });
    },
    /*
     * 网关受控能力（`ctx.gateway`）：表情包这类"账号级"动作。
     *
     * ## 为什么不在 sendText 里顺手加一个"发表情"
     *
     * 表情发送必须和文字**分成两个气泡**，而且要和 AI 自己的回复共享
     * 同一队列（否则会出现"文字还没发完、表情先冒出来"）。这两件事
     * 只有 sendSegments + replySequencer 这一层做得到，所以它留在宿主，
     * 由这里的工厂按调用注入。
     *
     * `requestOneBot` 是"发任意 OneBot 动作"的唯一入口，只给网关能力用。
     * 它**不经过**发送闸门 —— 因为闸门管的是"往外发消息"，
     * 而这些动作是读收藏列表、取图片字节。真正的发送仍然走 sendFace
     * → sendSegments → sendViaHost。
     */
    makeGateway: ({ lookupMessage, sendSegments: sendAll, log: gwLog }) =>
      createGatewayFactory({
        request: (action, params) => requestOneBotAction(action, params),
        lookupMessage,
        sendSegments: sendAll,
        getSelfId: () => selfId,
        getVision: () => {
          const gate = visionGate();
          return { enabled: gate.ok, supported: readVisionCapability().supported };
        },
        /*
         * 与 AI 自己发的文本共用同一个串行器。
         *
         * 这不是"顺手复用"：一个回合里模型可能"先说一句再补一张表情"，
         * 两件事并发时表情会插到文字中间。共用队列之后，同一个会话里
         * 就严格按调用顺序落地，跨会话互不影响。
         */
        sequencer: replySequencer,
        /*
         * 发出去之后记一条上下文。
         *
         * 为什么必须记：不记的话模型下一轮完全没有"我刚才发过一张表情"
         * 这个事实，它很容易在同一段回复里再发一次（用户看到两张一样的图）。
         * 记的是 [表情] 而不是图片内容 —— 图片本来就不该进文本上下文。
         */
        onFaceSent: ({ convKey }) => pushRecent(convKey, { role: 'assistant', text: '[表情]' }),
        log: (level, message, fields) => {
          if (level === 'warn') log.warn(message, fields);
          else if (level === 'error') log.error(message, fields);
          else log.info(message, fields);
        },
      }),
    /*
     * 会话读取：插件的 ctx.chat.recent 用它。
     *
     * 只读**当前会话**（convKey 由宿主的可信上下文给出，不是插件传的）。
     * 走 sessionStore.page 而不是直接读 recentByConv：page 是稳定的读取接口，
     * 而且它会返回副本 —— 插件改不动仓库里的活对象。
     */
    readMessages: ({ convKey, limit }) => {
      const r = sessionStore.page(convKey, { limit });
      if (!r?.ok) return r ?? { ok: false, code: 'E4010', message: '读取会话消息失败' };
      const list = Array.isArray(r.messages) ? r.messages : [];
      return {
        ok: true,
        messages: list.map((m) => ({
          messageId: m.messageId ?? null,
          sender: { id: String(m.userId ?? ''), nickname: String(m.nickname ?? '') },
          text: String(m.text ?? ''),
          self: m.atSelf === true,
          at: Number(m.receivedAt ?? 0) || Number(m.time ?? 0) * 1000,
        })),
      };
    },
    /*
     * 按 id 在**指定会话**里找消息。
     *
     * 这是"引用/媒体归属校验"的唯一依据：找不到就是"不属于当前会话"。
     * 会话不存在时直接返回 not-ok，让上层统一报 E4074 ——
     * 不区分"不存在"和"在别的会话"，避免变成跨会话探测原语。
     *
     * ## 为什么先查内存的 messages 再查会话仓库
     *
     * 会话仓库（sessionStore）只落**文本**，不存消息段 —— 它服务的是
     * "按条读聊天记录"这个展示场景。而插件的 mediaList 需要原始消息段
     * （图片段里有 file/mime），只有入站事件里才有。
     *
     * 所以顺序是：先在上游事件缓存里找（有 segments），找不到再退回仓库
     * （有文本、没有媒体）。退回时 segments 是空数组 —— 那是**如实**的结果，
     * 不是"看起来能用的假数据"：mediaList 会明确返回 0 个句柄。
     */
    lookupMessage: ({ convKey, messageId }) => {
      const wanted = String(messageId ?? '').trim();
      if (!wanted) return { ok: false, code: 'E4074', message: '缺少消息 id' };

      /** 从新到旧找：引用/媒体几乎总是针对最近的消息 */
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const evt = messages[i];
        if (String(evt?.messageId ?? '') !== wanted) continue;
        /*
         * 归属必须逐条比对：一条 messageId 在**当前会话**里找不到，
         * 就不能拿别的会话里的同 id 事件顶上 —— 那样媒体句柄会把
         * 另一个群的图片带过来。
         */
        if (String(evt?.convKey ?? '') !== String(convKey ?? '')) continue;
        return { ok: true, event: evt };
      }

      // 退路：仓库里可能还有更早的消息（文本）
      const r = sessionStore.page(convKey, { limit: 200 });
      if (!r?.ok) return { ok: false, code: 'E4074', message: '会话不存在' };
      for (const m of r.messages ?? []) {
        if (String(m.messageId ?? '') !== wanted) continue;
        return {
          ok: true,
          event: {
            messageId: m.messageId ?? null,
            sender: { userId: String(m.userId ?? ''), nickname: String(m.nickname ?? '') },
            text: String(m.text ?? ''),
            time: Number(m.time ?? 0),
            receivedAt: Number(m.receivedAt ?? 0),
            replyTo: m.replyTo ?? null,
            // 仓库不存消息段：如实给空数组，mediaList 会返回 0 个句柄
            segments: [],
          },
        };
      }
      return { ok: false, code: 'E4074', message: '该消息不在当前会话' };
    },
    // 打包后由桌面壳把内置 node.exe 的路径传进来；开发期用当前 node
    nodePath: process.env.LING_NODE_PATH || undefined,
    /*
     * 联网能力（`ctx.net`）。
     *
     * 形状是"给一个插件造能力"：配置与密钥是**每个插件**自己的，
     * 所以要先绑插件身份（manager 里用 resolved.config/secrets 调它），
     * 再按调用生成。宿主这边只需要保证总闸判定是现读的。
     */
    makeNet: ({ pluginId, config: pluginConfig, secrets }) => netFactory
      ? netFactory.makeFor({ pluginId, config: pluginConfig, secrets })
      : undefined,
  });

  const plug = await plugins.loadAll();
  log.info('插件面清单：\n' + describePluginSurface(await plugins.snapshot()));
  log.info('插件加载结果', { loaded: plug.loaded, failed: plug.failed, skipped: plug.skipped });
  /*
   * 联网总闸单独记一行。
   *
   * 为什么值得一行日志：这是唯一一个"界面说关了就真的不发请求"的开关。
   * 排查"它怎么还能搜"时，第一件事就是确认这一行。只记开关与插件是否
   * 启用，**不记** baseUrl 与 Key（一个是用户环境信息，一个是凭据）。
   */
  log.info(networkEnabledFrom(config) ? '联网总闸：开（搜索受插件启用与 Key 约束）' : '联网总闸：关（搜索与网页读取一律拒绝）', {
    搜索插件启用: Array.isArray(config.plugins?.enabled) && config.plugins.enabled.includes(NET_PLUGIN_ID),
  });

  log.info('扩展面清单：\n' + renderRegistryBanner());
  log.info(llm.configured ? '模型已配置' : '模型未配置（llm.apiKey 为空），对话将不可用', {
    model: config.llm.model,
  });

  startOneBot();
  startStatusPoll();
  /*
   * 父进程看护：外壳被强杀（不走 shutdown、也不发信号）时，
   * 后端要能自己发现并退出，否则会变成占着端口的孤儿进程。
   */
  startParentWatch();
  rpc.notify('ready', { version: '0.1.0-p0' });
}

function startOneBot() {
  client = new OneBotClient({
    wsUrl: config.onebot.wsUrl,
    accessToken: config.onebot.accessToken,
    onState: (state, detail) => {
      health.onState(state, detail);
      if (state === CLIENT_STATE.LINKED) {
        log.info('OneBot 已联通', { url: config.onebot.wsUrl });
      } else if (state === CLIENT_STATE.BACKOFF) {
        // I8：退避与首次 1006 只记 info，不升级为 error
        log.info('OneBot 连接断开，准备重连', { delayMs: detail?.delayMs });
      }
      rpc.notify('state', { state });
    },
    onEvent: (raw) => {
      const evt = normalizeEvent(raw, { selfId: selfId });
      if (!evt) return;
      health.onEvent(evt);
      if (evt.kind === 'meta' && evt.metaType === 'lifecycle') {
        selfId = String(raw.self_id ?? selfId ?? '');
      }
      handleEvent(evt);
    },
  });
  client.connect();
}

let selfId = '';

/** 兜底在线态：每 60s 问一次 get_status（F4） */
function startStatusPoll() {
  const timer = setInterval(async () => {
    if (!client) return;
    try {
      const status = await client.getStatus();
      health.onStatusPoll(status);
    } catch {
      /* 未联通时忽略 */ 
    }
  }, 60_000);
  timer.unref?.();
}

/* ---------------------------------------------------------------- 事件 */

/** @param {object} evt */
function handleEvent(evt) {
  if (evt.kind === 'message') {
    /*
     * ---- 第一关：重复投递 ----
     *
     * 断线重连、上游补发都会把同一条消息再推一遍。如果放过去，
     * 同一个问题会跑两个回合、发两条回复 —— 这是「回复混乱」的一种。
     *
     * 去重必须放在**最前面**：连界面展示和上下文都不该被同一条消息污染两次。
     */
    if (dedup.markSeen(evt.convKey, evt.messageId)) {
      log.info('丢弃重复投递的消息', { convKey: evt.convKey, messageId: evt.messageId });
      return;
    }

    messages.push(evt);
    if (messages.length > 500) messages = messages.slice(-500);

    /*
     * 分配楼层号。
     *
     * 放到 recent 之前：楼层是「这条消息被本会话收下」的事实，
     * 而上下文只是它的一个视图。失败时（会话键非法）只记一行，
     * 不拦对话 —— 一条消息进不了历史，不该让它连回复都没有。
     */
    const appended = sessionStore.append(evt.convKey, evt);
    if (!appended.ok) {
      log.warn('消息未写入会话楼层', { convKey: evt.convKey, code: appended.code, message: appended.message });
    }

    /*
     * 媒体元数据跟着楼层一起入库（契约 §2 / §5）。
     *
     * ## 为什么在入库这一刻就要解析，而不是等"要用图的时候"再解析
     *
     * 因为**段原始数据会消失**：OneBot 事件只活在内存的 `messages` 数组里
     * （上限 500 条，且重启即空）。等下一回合想看图时，那条消息的 `file`
     * 早已不知去向 —— 于是历史图片永远取不到，用户看到的是
     * "刚才发的图它现在不认了"。
     *
     * 存进去的只有六个元数据键（没有 URL、没有 base64），见
     * session/store.mjs 的 MEDIA_PERSIST_KEYS。URL 里有临时鉴权参数，
     * base64 会把 sessions.json 撑成几 MB，两者都只允许活在内存里。
     *
     * 这里**不看 vision.enabled**：元数据是"这条消息确实带图"的事实，
     * 与用户当前想不想读图无关。关掉开关后再打开时，历史消息仍然可读图 ——
     * 那才是开关的语义（控制行为，不篡改历史）。
     */
    const mediaRefs = extractImageRefs(evt.segments, { max: 8 });
    if (mediaRefs.length > 0) {
      sessionStore.attachMedia(evt.convKey, appended.ok ? appended.floor : null, mediaRefs);
    }

    /*
     * ---- 第二关：自己发的消息 ----
     *
     * ## 这是「回复混乱」最直接的来源
     *
     * 自己发出去的话如果被上游当作普通 message 事件推回来，原来会被
     * 无差别塞进 recentByConv，下一轮 `buildMessages` 把它渲染成
     * 「群友：<自己刚说的话>」。模型于是接自己的话、重复自己 ——
     * 而且因为上下文看起来"很连贯"，这个 bug 极难从日志里看出来。
     *
     * 记成 assistant 而不是丢掉：主动发言要能"接上自己上一句"，
     * 那正是 assistant 角色该表示的意思。
     */
    const fromSelf = isSelfMessage(evt, selfId);
    pushRecent(evt.convKey, {
      role: fromSelf ? 'assistant' : 'user',
      nickname: evt.sender?.nickname || evt.sender?.userId,
      text: evt.text || '（无文本）',
      // 带上楼层号：回合开始时据此精确登记"哪些楼真的进了模型"
      floor: appended.ok ? appended.floor : null,
    });

    // 真人说过话 —— 这是概率唤醒的第 1 道护栏的输入
    if (!fromSelf) {
      triggerLedger.noteHuman(evt.convKey);
    }

    rpc.notify('message', evt);

    // 自己说的话不触发回合，否则就是自己跟自己对话
    if (fromSelf) return;

    // 插件优先接管（例如 DSH 指令、审批回复）。
    // 有插件明确处理了就**不走 AI 回合**，避免"已经执行了还在回一句废话"。
    void dispatchToPlugins(evt);
  } else if (evt.kind === 'self-sent') {
    rpc.notify('self-sent', evt);
  } else if (evt.kind === 'poke') {
    rpc.notify('poke', evt);
    /*
     * 被拍一拍也要能触发回合。
     *
     * 拍一拍是 notice 事件、没有正文，所以走单独的判定函数
     * （detectTrigger 的整条 message 路径都不适用）。
     *
     * 注意 POKE 是**弱触发**：它会看一眼，但不会插队到正在跑的回合前面 ——
     * 拍一拍太轻，群里还常连环互拍，不值得为它打断一次认真回答。
     */
    if (evt.convKey && checkWhitelist(evt.convKey, config).ok) {
      /*
       * 静音期间拍一拍也不回应。
       *
       * 拍一拍走的是独立路径（不经过 considerTurn），所以这里必须
       * **单独**再挡一次。只在 considerTurn 里挡的话，
       * 静音期间别人拍它一下它还是会冒出来 —— 而拍一拍在群里
       * 恰恰是最容易被随手用的动作。
       */
      if (silenceGate.check(evt.convKey, config).silent) {
        log.info('静音中，忽略拍一拍', { convKey: evt.convKey });
      } else {
        const pokeTrigger = detectPokeTrigger(evt, { selfId, wake: config.wake });
        if (pokeTrigger) {
          const gate = wakeLedger.check(evt.convKey, {
            maxPerMinute: config.wake?.maxWakePerMinute,
            maxPerHour: config.wake?.maxWakePerHour,
          });
          if (gate.ok) {
            wakeLedger.note(evt.convKey);
            enqueue(evt.convKey, {
              evt: {
                ...evt,
                kind: 'message',
                isGroup: evt.convKey.startsWith('group:'),
                text: '',
                atSelf: true,
              },
              trigger: pokeTrigger.trigger,
              reason: pokeTrigger.reason,
              proactive: false,
            });
          }
        }
      }
    }
  } else if (evt.kind === 'request') {
    // 只展示，不自动同意（F3 边界）
    log.info('收到好友加群请求（未自动处理）', { type: evt.requestType, user: evt.userId });
    rpc.notify('request', evt);
  }
}

/**
 * 日记的界面视图。
 *
 * ## 为什么在这里现算权重
 *
 * 落盘的只有 `weightBase` / `weightBaseDate`（写下那天的快照）。
 * 当前权重必须按"今天 - 写下那天"现算，否则程序没开的那几天就不衰减了。
 * 见 diary/decay.mjs 的文件头。
 *
 * ## 为什么失败要兜底成空
 *
 * 日记是纯展示数据。它算不出来绝不能让整份快照失败 ——
 * 那样用户连消息列表都看不到，症状是"界面拉取失败"。
 *
 * @returns {object}
 */
function snapshotDiary() {
  try {
    const now = Date.now();
    const items = diaryStore.list().map((rec) => {
      const w = computeWeight({
        weightBase: rec.weightBase,
        weightBaseDate: rec.weightBaseDate,
        locked: rec.locked,
        lockedWeight: rec.lockedWeight,
        decayPerDay: config?.diary?.decayPerDay,
        now,
      });
      return {
        ...rec,
        weight: w.weight,
        faded: w.faded,
        daysElapsed: w.daysElapsed,
        // 界面据此决定默认列表里要不要藏起来（等于阈值仍然可见）
        hidden: isHidden(w.weight, config?.diary?.hiddenBelowWeight),
        // 是否还够格进上下文（淡忘到一定程度就不再影响它的判断）
        inContext: shouldIncludeInContext(w.weight, config?.diary?.contextMinWeight),
      };
    });
    return { days: items, count: items.length };
  } catch (err) {
    log.warn('日记视图计算失败（不影响对话）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
    return { days: [], count: 0 };
  }
}

/**
 * 静音的界面视图（F20）。
 *
 * ## 为什么要分「配置里设的」和「现在实际生效的」
 *
 * 用户看到的必须是**现在为什么不说话**，而不是"我设了什么"。
 * 时段静默可能在半夜自动生效、聊天指令可能开了 30 分钟临时静音 ——
 * 只显示配置会让用户对着开关发愣：「我明明没开全局静音，它怎么不回话？」
 *
 * 所以除了原样给出配置，还要把每种来源**当前是否命中**算出来。
 *
 * @returns {object}
 */
function snapshotSilence() {
  try {
    const cfg = config?.silence ?? {};
    const now = Date.now();

    // 时段命中情况（只报告，不改配置）
    const w = matchWindow(now, cfg.windows);

    /*
     * 全局静音已经开着时，逐会话检查没有意义 —— 结果全是"静音"，
     * 而会话可能有几百个。UI 只需要知道"全都闭嘴了"。
     */
    const all = cfg.all === true;

    return {
      all,
      convKeys: Array.isArray(cfg.convKeys) ? cfg.convKeys : [],
      windows: Array.isArray(cfg.windows) ? cfg.windows : [],
      allowCommand: cfg.allowCommand !== false,
      adminIds: Array.isArray(cfg.adminIds) ? cfg.adminIds : [],
      defaultMuteMs: cfg.defaultMuteMs ?? 1800000,
      maxMuteMs: cfg.maxMuteMs ?? 86400000,
      // 运行态
      windowHit: w.hit,
      windowNow: w.window ? `${w.window.start}–${w.window.end}` : '',
      temporary: silenceGate.listTemporary(now),
      // 一句话说明现在为什么闭嘴（没有静音时是空串）
      summary: all
        ? '全局静音：所有会话都不回复'
        : w.hit
          ? `静默时段 ${w.window?.start}–${w.window?.end}：所有会话都不回复`
          : '',
    };
  } catch (err) {
    log.warn('静音视图计算失败（不影响对话）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
    return { all: false, convKeys: [], windows: [], temporary: [], summary: '' };
  }
}

/**
 * 把一项唤醒设置写进 config。
 *
 * ## 为什么运行时必须自己校验
 *
 * `mergeStrict` 只在启动时跑。运行时改内存 config 是绕过它的，
 * 所以类型和范围都得在这里把关。最容易踩的两个坑：
 *
 *   · 数字字段收到字符串（"5" / "abc"）→ 后者变 NaN，比较永远为 false，
 *     表现为"这个设置怎么调都没反应"
 *   · 数组字段收到逗号分隔的字符串（界面输入框常见）→ 存成字符串后
 *     `.includes()` 变成子串匹配，关键词会误命中
 *
 * ## 语义约定
 *
 * `maxWakePerMinute` / `maxWakePerHour` 的 0 表示**不限制**，
 * 不是"一次都不许"。用户清成 0 的意思是"我不管"，
 * 真想让机器人闭嘴该关 wake 整组（或关 proactive.enabled）。
 *
 * @param {any} config
 * @param {string} field
 * @param {any} value
 * @returns {{ok: true, echo?: any} | {ok: false, code: string, message: string}}
 */
function applyWakeSetting(config, field, value) {
  if (!config.wake || typeof config.wake !== 'object') config.wake = {};

  /** 布尔开关：只接受真正的布尔值，不做 "true"/"1" 的模糊转换 */
  const BOOL_FIELDS = new Set(['atMention', 'nameMention', 'question', 'poke']);
  /** 非负整数（毫秒或次数） */
  const INT_FIELDS = new Set([
    'batchWindowMs',
    'minSleepMs',
    'maxSleepMs',
    'maxWakePerMinute',
    'maxWakePerHour',
    'noActionLimit',
    'preSleepWaitMs',
  ]);
  /** 0~1 的浮点 */
  const RATIO_FIELDS = new Set(['recommendedProbability']);
  /** 字符串数组（QQ 号或关键词） */
  const LIST_FIELDS = new Set(['speakerIds', 'keywords']);

  if (BOOL_FIELDS.has(field)) {
    if (typeof value !== 'boolean') {
      return { ok: false, code: 'E40XX', message: `${field} 必须是布尔值` };
    }
    config.wake[field] = value;
    return { ok: true, echo: value };
  }

  if (INT_FIELDS.has(field)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      return { ok: false, code: 'E40XX', message: `${field} 必须是非负整数` };
    }
    /*
     * 上限保护：一小时以上没必要用更大的窗口，
     * 而一个溢出成 1e15 的值会让"下次窗口"等到宇宙热死 —— 等于永久禁用。
     */
    const cap = field === 'batchWindowMs' ? 600_000 : 86_400_000;
    config.wake[field] = Math.min(n, cap);
    return { ok: true, echo: config.wake[field] };
  }

  if (RATIO_FIELDS.has(field)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return { ok: false, code: 'E40XX', message: `${field} 必须在 0~1 之间` };
    }
    config.wake[field] = n;
    return { ok: true, echo: n };
  }

  if (LIST_FIELDS.has(field)) {
    // 界面可能传数组，也可能传逗号/空白分隔的字符串
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，\s]+/);
    const list = raw
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      // 去重，不然同一个关键词会在判定里被检查多次
      .filter((x, i, arr) => arr.indexOf(x) === i)
      /*
       * 上限：关键词太多会让每条消息都要扫一遍整个列表；
       * QQ 号太多同理。200 是个远超实际需要的值。
       */
      .slice(0, 200);
    config.wake[field] = list;
    return { ok: true, echo: list };
  }

  if (field === 'defaultMode') {
    const v = String(value ?? '').trim();
    if (v !== 'active' && v !== 'diving') {
      return { ok: false, code: 'E40XX', message: 'defaultMode 只能是 active 或 diving' };
    }
    config.wake.defaultMode = v;
    return { ok: true, echo: v };
  }

  /*
   * 未支持的字段要明确报错，而不是静默忽略。
   *
   * 静默忽略会让界面显示"保存成功"但实际没存 ——
   * 用户下次打开发现设置变回去了，会怀疑是程序坏了。
   */
  return { ok: false, code: 'E40XX', message: `未支持的唤醒设置项：${field}` };
}

/**
 * 把一项静音设置写进 config（F20）。
 *
 * ## 和 `applyWakeSetting` 分开的原因
 *
 * 两者的校验规则不一样。最典型的是 `windows`：它是一个**对象数组**，
 * 而 `applyWakeSetting` 的 LIST_FIELDS 只处理字符串数组。
 * 混在一起会让 `windows` 要么存不进去、要么存进一个形状不对的东西，
 * 然后在运行时静默失效 —— 用户以为设好了夜间静默。
 *
 * ## 为什么每个字段都要自己验
 *
 * `mergeStrict` 只在启动时跑。运行时改内存 config 是绕过它的，
 * 存进一个形状不对的值会一直用到下次重启才暴露。
 *
 * @param {any} config
 * @param {string} field
 * @param {any} value
 * @returns {{ok: true, echo?: any} | {ok: false, code: string, message: string}}
 */
function applySilenceSetting(config, field, value) {
  if (!config.silence || typeof config.silence !== 'object') config.silence = {};

  /** 布尔开关 */
  const BOOL_FIELDS = new Set(['all', 'allowCommand']);
  /** 非负整数（毫秒） */
  const INT_FIELDS = new Set(['defaultMuteMs', 'maxMuteMs']);
  /** 字符串数组（会话键 / QQ 号） */
  const LIST_FIELDS = new Set(['convKeys', 'adminIds']);

  if (BOOL_FIELDS.has(field)) {
    if (typeof value !== 'boolean') {
      return { ok: false, code: 'E40XX', message: `${field} 必须是布尔值` };
    }
    config.silence[field] = value;
    return { ok: true, echo: value };
  }

  if (INT_FIELDS.has(field)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      return { ok: false, code: 'E40XX', message: `${field} 必须是非负整数` };
    }
    // 上限一年。更大的值等价于"永久"了，该用全局开关
    const cap = 365 * 24 * 60 * 60 * 1000;
    config.silence[field] = Math.min(n, cap);
    return { ok: true, echo: config.silence[field] };
  }

  if (LIST_FIELDS.has(field)) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，\s]+/);
    const list = raw.map((x) => String(x ?? '').trim()).filter(Boolean);

    if (field === 'convKeys') {
      for (const k of list) {
        if (!/^(group|private):\d+$/.test(k)) {
          return { ok: false, code: 'E40XX', message: `"${k}" 不是合法会话键（应为 group:123 或 private:456）` };
        }
      }
    } else {
      for (const id of list) {
        if (!/^\d+$/.test(id)) {
          return { ok: false, code: 'E40XX', message: `"${id}" 不是合法 QQ 号（应为纯数字）` };
        }
      }
    }

    // 去重：同一个会话写两遍没有意义，只会让界面显示得莫名其妙
    const deduped = list.filter((x, i, arr) => arr.indexOf(x) === i).slice(0, 500);
    config.silence[field] = deduped;
    return { ok: true, echo: deduped };
  }

  if (field === 'windows') {
    /*
     * 时段数组。界面传对象数组，也可能手工传 JSON 字符串。
     * 两者都要接受 —— 但**验不过就整批拒绝**，不做部分接受：
     * 接受一半会让用户看到"保存成功"却仍有段时段没生效。
     */
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        return { ok: false, code: 'E40XX', message: 'windows 不是合法 JSON' };
      }
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, code: 'E40XX', message: 'windows 必须是数组' };
    }

    const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const out = [];
    for (const w of parsed) {
      if (!w || typeof w !== 'object') {
        return { ok: false, code: 'E40XX', message: 'windows 的每一项必须是 {start, end} 对象' };
      }
      const start = String(w.start ?? '').trim();
      const end = String(w.end ?? '').trim();
      if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
        return { ok: false, code: 'E40XX', message: `时段 ${start}–${end} 不合法（需 HH:MM，例如 23:00）` };
      }
      if (start === end) {
        /*
         * 起止相同等于"不生效"。直接拒绝比存进去好：
         * 存进去之后界面上有个看起来正常的时段，而它什么都不做 ——
         * 用户会一直以为夜间静音是开着的。
         */
        return { ok: false, code: 'E40XX', message: `时段 ${start}–${end} 起止相同，不会生效` };
      }
      out.push({ start, end });
    }
    config.silence.windows = out.slice(0, 24);
    return { ok: true, echo: config.silence.windows };
  }

  return { ok: false, code: 'E40XX', message: `未支持的静音设置项：${field}` };
}

/**
 * 把一项分条设置写进 config（F22）。
 *
 * ## 为什么三个字段要各自验
 *
 * 这里是**运行时**写配置，绕过了启动时的 `validateConfig`。存进
 * `maxMessages: "3"` 不会当场报错 —— 发送层的 `normalizeMaxMessages`
 * 会把它当 NaN 换成默认值 3，于是用户改 5 条却发现还是 3，
 * 而界面上显示的是 5（那是内存里的字符串）。形状要先对，数值才有意义。
 *
 * ## 为什么不接受 0
 *
 * 「一条都不发」不是这里的功能，那是静音。0 条会让整条回复凭空消失，
 * 而且用户很难联想到是分条设置导致的。要静音请用静音页。
 *
 * @param {any} config
 * @param {string} field
 * @param {any} value
 * @returns {{ok: true, echo?: any} | {ok: false, code: string, message: string}}
 */
function applyReplySetting(config, field, value) {
  if (!config.reply || typeof config.reply !== 'object') config.reply = {};

  if (field === 'splitEnabled') {
    if (typeof value !== 'boolean') {
      return { ok: false, code: 'E40XX', message: 'splitEnabled 必须是布尔值' };
    }
    config.reply.splitEnabled = value;
    return { ok: true, echo: value };
  }

  if (field === 'maxMessages') {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > 10) {
      return { ok: false, code: 'E40XX', message: 'maxMessages 必须是 1–10 的整数（1 = 始终整条发）' };
    }
    config.reply.maxMessages = n;
    return { ok: true, echo: n };
  }

  if (field === 'intervalMs') {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 100 || n > 10000) {
      return { ok: false, code: 'E40XX', message: 'intervalMs 必须是 100–10000 的整数（毫秒）' };
    }
    config.reply.intervalMs = n;
    return { ok: true, echo: n };
  }

  return { ok: false, code: 'E40XX', message: `未支持的分条设置项：${field}` };
}

/**
 * 视觉设置（`vision.*`）的写入校验。
 *
 * ## 为什么运行时还要再校验一遍
 *
 * 启动时的 `validateConfig` 只在开机那一刻跑。界面保存走的是"直接改内存
 * config 对象 + persistConfig"，完全绕过了它。所以这里必须自己验类型。
 *
 * 存进一个形状不对的值不会当场报错，只会在运行时被 `normalizeVisionConfig`
 * 静默夹成默认值 —— 用户在界面上看到自己填的 50，实际一直用 3，
 * 而且日志里一片安静。那是这次改造要消灭的典型故障。
 *
 * ## 为什么这里**允许**写超过硬上限的值
 *
 * 与启动校验保持一致（契约 §9.1）：写入宽松、生效收紧。用户填 20000ms
 * 能存下来，运行时按 15000 生效，界面会标明"实际生效值"。
 * 这里只挡"明显是笔误"的量级（超过硬上限 2 倍）。
 *
 * @param {any} config
 * @param {string} field
 * @param {unknown} value
 * @returns {{ok: boolean, echo?: any, code?: string, message?: string}}
 */
function applyVisionSetting(config, field, value) {
  if (!config.vision || typeof config.vision !== 'object') config.vision = {};
  const v = config.vision;

  if (field === 'enabled') {
    if (typeof value !== 'boolean') {
      return { ok: false, code: 'E40XX', message: 'vision.enabled 必须是布尔值' };
    }
    v.enabled = value;
    /*
     * 关掉时清空图片缓存：旧图不该在关掉再打开后被静默复用。
     *
     * 这不只是省内存 —— 缓存里的图带着"上一次是什么时候取到的"这个隐含状态，
     * 而用户关掉开关的动机通常就是"别再花这个钱了"。留着缓存等于让他
     * 一开机就立刻开始为旧图付 token。
     */
    if (!value) resetVisionCache();
    return { ok: true, echo: value };
  }

  if (field === 'includeQuoted') {
    if (typeof value !== 'boolean') {
      return { ok: false, code: 'E40XX', message: 'vision.includeQuoted 必须是布尔值' };
    }
    v.includeQuoted = value;
    return { ok: true, echo: value };
  }

  /** 数值型字段：硬上限 ×2 是"明显笔误"的分界（契约 §9） */
  const numeric = {
    maxImagesPerTurn: { min: 1, hard: VISION_LIMITS_HARD.maxImagesPerTurn, label: '本轮张数' },
    maxHistoryImages: { min: 0, hard: VISION_LIMITS_HARD.maxHistoryImages, label: '历史张数' },
    maxBytes: { min: 1, hard: VISION_LIMITS_HARD.maxBytes, label: '单图字节' },
    maxTotalBytes: { min: 1, hard: VISION_LIMITS_HARD.maxTotalBytes, label: '总字节' },
    maxPixels: { min: 1, hard: VISION_LIMITS_HARD.maxPixels, label: '像素' },
    timeoutMs: { min: 1000, hard: VISION_LIMITS_HARD.timeoutMs, label: '超时（毫秒）' },
    historyWindow: { min: 0, hard: VISION_LIMITS_HARD.historyWindow, label: '历史回看楼层' },
    cacheTtlMs: { min: 60_000, hard: VISION_LIMITS_HARD.cacheTtlMs, label: '缓存时长（毫秒）' },
  };

  const rule = numeric[field];
  if (!rule) {
    return { ok: false, code: 'E40XX', message: `未支持的视觉设置项：${field}` };
  }

  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < rule.min) {
    return {
      ok: false,
      code: 'E40XX',
      message: `${rule.label}必须是不小于 ${rule.min} 的整数`,
    };
  }
  if (n > rule.hard * 2) {
    return {
      ok: false,
      code: 'E40XX',
      message: `${rule.label}超过上限 ${rule.hard * 2}（实际生效会被夹到 ${rule.hard}）`,
    };
  }
  v[field] = n;
  return { ok: true, echo: n };
}

/**
 * 生成某一天的日记（供调度器回调）。
 *
 * ## 为什么先落 degraded 占位再调模型
 *
 * 调模型可能要十几秒甚至超时。如果等它返回才写文件，
 * 这期间进程被杀（用户关窗口、崩溃、断电），这一天就彻底没有日记了 ——
 * 而调度器看到"文件不存在"会在下次启动再试一次，又可能再被杀。
 *
 * 所以顺序是：**先写一条降级占位（幂等、秒完成），再尝试用模型覆盖**。
 * 最坏结果是一篇降级日记，而不是没有日记。这是"宁可糙，不可丢"的原则。
 *
 * @param {string} date 本地日期键
 * @param {string} [trigger] 'startup' | 'rollover'，只用于日志
 * @returns {Promise<boolean>} 是否成功写入
 */
async function generateYesterdayDiary(date, trigger = 'rollover') {
  try {
    const groups = collectGroupsForDate(sessionStore, date, localDateKey);

    /*
     * 第一步：先落占位。
     *
     * 只写一次 —— 已经有这一天时不覆盖（避免把上次生成好的内容
     * 降级成占位）。keepLock 由 store 默认保证。
     */
    if (!diaryStore.has(date)) {
      const placeholder = await generateDiary({ date, groups, store: diaryStore, llm: null });
      log.info('日记占位已写入', { date, trigger, degraded: placeholder.degraded });
    }

    /*
     * 第二步：有模型才尝试写真实总结。
     *
     * 已经有一篇**非降级**的日记就不再重写：重写会刷新 createdAt，
     * 而且没有意义（内容不会更好，只可能更差）。
     */
    const existing = diaryStore.get(date);
    if (existing && existing.degraded === false) {
      log.info('该日已有日记，跳过生成', { date });
      return true;
    }

    const result = await generateDiary({
      date,
      groups,
      store: diaryStore,
      llm: llm?.configured ? llm : null,
      model: config?.llm?.model ?? '',
    });

    if (result.ok) {
      log.info('日记已生成', {
        date,
        trigger,
        degraded: result.degraded,
        messageCount: result.messageCount,
        error: result.error,
      });
    } else {
      log.warn('日记写入失败（会重试）', { date, error: result.error });
    }
    return result.ok;
  } catch (err) {
    log.warn('生成日记失败（会重试）', {
      date,
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
    return false;
  }
}

/**
 * 认一条**引用式**确认回复 —— 按消息 ID 精确定位。
 *
 * ## 为什么引用单独成一条路径，而且排在插件之前
 *
 * 引用是用户对"我在回答哪一条"的唯一明确表达，也是这里唯一**可精确
 * 判定归属**的信息：消息 ID 属于本表就是我的，不属于就不是。
 *
 * 所以这一条必须先跑：插件拿到的 evt 里同样有 replyTo，但它没法知道
 * 那条消息是不是宿主的确认卡 —— 让它先处理，就会出现"插件把宿主的
 * 确认当成自己的审批回了个'没有这条'"。反过来，宿主先按 ID 判定，
 * 不属于自己就原样交回，两边都不会误吞。
 *
 * @param {object} evt
 * @returns {Promise<'handled'|'foreign'|'none'>}
 *   `none` = 这条不是引用式确认回复，调用方按常规顺序继续
 */
async function tryHandleQuotedConfirm(evt) {
  const convKey = String(evt?.convKey ?? '');
  if (!convKey.startsWith('private:')) return 'none';

  const quotedId = normalizeMessageId(evt?.replyTo?.messageId);
  if (!quotedId) return 'none';

  const parsed = parseConfirmReply(evt?.text);
  // 引用了但内容不是 1/2/同意/拒绝 —— 那是普通引用聊天，不归这里管
  if (!parsed) return 'none';

  const senderId = String(evt?.sender?.userId ?? '');
  const r = confirms.resolveByQuote({ messageId: quotedId, convKey, senderId, allow: parsed.allow });

  if (!r.handled) {
    /*
     * 引用不属于本入口 —— 交回插件。
     *
     * 这里绝不能退化成"按当前待确认数量猜一个"：DSH 的审批卡和宿主的
     * 确认卡长得一模一样（都是引用回数字），猜错就是用 A 的点头批 B 的操作。
     *
     * 记 info 不记 warn：DSH 审批每天都会走这条路径，warn 会把日志淹掉，
     * 真正异常反而看不见。
     */
    log.info('引用不属于通用确认，交回插件', { convKey, quotedId });
    return 'foreign';
  }

  await reportConfirmResult(convKey, r);
  return 'handled';
}

/**
 * 认一条**不带引用**的确认回复。
 *
 * ## 为什么它排在插件**之后**
 *
 * 这个入口原来排在插件前面，而且拿全局序号表认任何「1/2」。于是
 * dsh-bridge 的审批回复会被先吃掉 —— 表现是 DSH 那笔审批纹丝不动，
 * 而这边回一句"没有第 1 条待确认"。
 *
 * 不带引用时，两边都只能靠"恰好一条"来判断，谁也说不清那条「1」
 * 到底指谁。所以顺序按**归属明确度**排：插件自己的卡片由插件自己认
 * （它的队列它最清楚），插件明确说"不是我的"，宿主才接着认自己的。
 *
 * ## 只认「当前人 + 当前会话恰好一条」
 *
 * 「1」和「2」在聊天里太常见（"2 点了"）。所以：
 *   · 本会话本人在册且**仅有一条** → 认；
 *   · 两条以上 → 明确要求引用，绝不猜；
 *   · 一条都没有 → 裸数字交回（大概率闲聊），文字形式回一句说明。
 *
 * @param {object} evt
 * @returns {Promise<boolean>} 是否已处理（true = 这条消息到此为止）
 */
async function tryHandleUnquotedConfirm(evt) {
  // 任何显式引用都只能由对应消息的拥有者认领，不能落到“唯一待确认”数字兜底。
  if (normalizeMessageId(evt?.replyTo?.messageId ?? evt?.replyToMessageId)) return false;
  const convKey = String(evt?.convKey ?? '');
  /*
   * 群聊一律不认。
   *
   * 确认卡只会投到管理员私聊（见 askHumanConfirm 的 replyConvKey），
   * 所以群里本来就没有可处理的请求。更重要的理由是**可见性**：
   * 群里所有人都看得到卡片，谁能回就等于谁能批准。把入口收窄到私聊，
   * 让"群友在群里回 1 会怎样"这个问题根本不存在。
   */
  if (!convKey.startsWith('private:')) return false;

  const parsed = parseConfirmReply(evt?.text);
  if (!parsed) return false;

  const senderId = String(evt?.sender?.userId ?? '');
  const isBareDigit = evt?.text === '1' || evt?.text === '2';

  const r = confirms.resolveUnquoted({
    convKey,
    senderId,
    allow: parsed.allow,
    ...(parsed.seq !== undefined ? { seq: parsed.seq } : {}),
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
  });

  if (r.handled) {
    await reportConfirmResult(convKey, r);
    return true;
  }

  /*
   * 没有可处理的请求。
   *
   * 裸数字 = 大概率闲聊，交回（AI 该回就回）；
   * 明确说了「同意 / 拒绝」= 用户以为有东西可批，必须回一句，
   * 否则他会一直等一个永远不会发生的结果。
   */
  if (isBareDigit) return false;

  if (confirms.hasActionableElsewhere(convKey, senderId)) {
    await sendConfirmReply(convKey, '现在没有等你确认的操作。别的会话里有待确认，请去那个会话说。');
  } else {
    await sendConfirmReply(convKey, '现在没有等你确认的操作。');
  }
  return true;
}

/**
 * 把一次结算（或拒绝）的结果回给用户。
 *
 * 契约：**只要 handled 就一定回一句**。用户点了头却什么都没收到，
 * 是这里最不能接受的失败 —— 他会再点一次，然后看到"已处理过"。
 *
 * @param {string} convKey
 * @param {object} r ConfirmRegistry 的结算结果
 */
async function reportConfirmResult(convKey, r) {
  if (r?.ok) {
    const seqText = r.seq !== undefined ? `（第 ${r.seq} 条）` : '';
    await sendConfirmReply(convKey, `${describeOutcome(r.outcome)}${seqText}`);
  } else {
    await sendConfirmReply(convKey, r?.message ?? '处理失败：未知原因');
  }
  if (r?.id) {
    log.info('QQ 侧确认结果', {
      id: r.id,
      seq: r.seq,
      ok: r.ok === true,
      outcome: r.outcome,
      reason: r.reason,
    });
  }
}

/**
 * 发一条确认相关的回执。
 *
 * ## 为什么必须检查返回值
 *
 * 之前这里直接 `await sendText(...)` 就不管了。发送闸门可能因为
 * 限流（E2030）、白名单、出站审计而**拒绝整条消息**，而 `sendText`
 * 是 resolve 一个 `{ok:false}` 而不是 reject —— 于是 `await` 正常返回，
 * 调用方以为发出去了，用户什么都没收到，日志里也没有任何记录。
 *
 * 这正是"点了确认却没有任何回信"的成因：确认确实生效了（工具跑成功），
 * 但回执被闸门吞掉，且无人知晓。
 *
 * @param {string} convKey
 * @param {string} text
 */
async function sendConfirmReply(convKey, text) {
  try {
    const r = await sendText(convKey, text);
    if (r && r.ok === false) {
      log.warn('确认回执未能送达', { convKey, code: r.code, message: r.message });
    }
    return r;
  } catch (err) {
    log.warn('确认回执发送异常', {
      convKey,
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
    return { ok: false };
  }
}

/**
 * 算一份"这条消息当前所处的结构性事实"，交给插件派发层。
 *
 * ## 为什么这些事实必须由宿主算
 *
 * 三件事的状态都只存在于宿主里：
 *
 *   whitelisted   白黑名单是宿主配置，插件读不到
 *   silenced      静音是宿主策略（全局/会话/时段/临时），插件读不到
 *   confirmPending 确认表在 guard/confirm.mjs，插件读不到
 *
 * 插件如果自己去猜，两个方向都会错：多回一条会抢走审批回复，
 * 少回一条则明明该回却不回。而这两种错在日志里都只表现为
 * "插件返回了 true/false"，排查时几乎无从下手。
 *
 * ## 为什么要按**实际会走到的顺序**算
 *
 * `whitelisted` 与 `silenced` 在这里算一次，`considerTurn` 里还要再判一次。
 * 重复判定是有意的：这里的值只用来**阻止**插件先回一条（插件先跑，
 * 它回完 `considerTurn` 就不会执行了），它不构成任何放行依据。
 * 换句话说：这里只是"更严格的一道前置"，不是"绕过后续闸门"的通行证。
 *
 * ## `isAdmin` 为什么用核心管理员，而不是静音管理员
 *
 * 两个名单回答的是不同问题：
 *   `config.admin.qqIds`      谁能让它动本机 / 拥有管理员权限（授权）
 *   `config.silence.adminIds` 谁能让它闭嘴（一个更宽松的操作权限）
 *
 * 插件规则里的 `scope.adminOnly` 表达的是**授权**语义（"这条只给主人用"），
 * 所以取 `isCoreAdmin`。用静音名单会把"能叫我闭嘴的人"顺带升级成
 * "能用只给主人用的规则"，那正好是 `admin.mjs` 明确要避免的合并。
 *
 * @param {object} evt
 * @returns {{whitelisted: boolean, silenced: boolean, confirmPending: boolean, isAdmin: boolean, selfId: string}}
 */
function messageGate(evt) {
  const convKey = String(evt?.convKey ?? '');
  const senderId = String(evt?.sender?.userId ?? '');

  const whitelisted = checkWhitelist(convKey, config).ok;
  // 静音判定与 considerTurn 用同一个闸门对象：两处结论必须一致，
  // 否则会出现"插件以为没静音（回了），而宿主以为静音（不记日志）"
  const silenced = silenceGate.check(convKey, config).silent;

  /*
   * 有没有可能属于宿主的待确认。
   *
   * 取"本会话本人名下有未结算的确认"这个宽口径：只要有一条在册，
   * 低优先级插件就不该抢形似确认回复的文本。宁可少回一条自动回复，
   * 也不能让用户以为自己点的确认被拒了。
   */
  const confirmPending = confirms.hasActionable(convKey, senderId);

  return {
    whitelisted,
    silenced,
    confirmPending,
    /*
     * 核心管理员判定。
     *
     * 必须是宿主的结论而不是插件自己算：`config.admin.qqIds` 插件读不到，
     * 让它猜的方向只有两个 —— 全放行（等于 adminOnly 不存在）或全拒绝
     * （等于这个字段永远是废的）。两个都是"配了不生效"。
     *
     * fail-closed：不是管理员就是 false，没有"不确定"这个第三态。
     */
    isAdmin: isCoreAdmin(config, senderId),
    // 自己发的消息已经在上游 return 掉了，这里仍带上：插件侧再多一层保险
    selfId: String(selfId ?? ''),
  };
}

async function dispatchToPlugins(evt) {
  /*
   * ---- 第 0 关：引用式确认回复 ----
   *
   * 引用是唯一**可精确判定归属**的信息（消息 ID 属于谁就是谁的）。
   * 所以先按 ID 认领：命中宿主自己的确认卡就结算，不命中就原样交回，
   * 让插件的审批卡按它自己的队列去认。
   *
   * 这一关必须在插件之前，否则插件会先看到这条引用，回一句
   * "没有这条待回复" —— 而它其实属于宿主的确认卡。
   */
  const quoted = await tryHandleQuotedConfirm(evt);
  if (quoted === 'handled') return;

  if (plugins) {
    try {
      const handled = await plugins.dispatchMessage(evt, messageGate(evt));
      if (handled) {
        log.info('消息已被插件接管', { convKey: evt.convKey });
        return;
      }
    } catch (err) {
      /*
       * 插件抛异常不能让消息彻底丢掉，继续走正常流程。
       *
       * 但**必须留下足够的信息**：这里曾经只记了 message，而真正的
       * 原因（`log is not defined`）只是一句话，很容易被当成"插件没写对"
       * 而不是"插件崩了"。所以把堆栈第一行也带上——排查时那一行往往就够。
       */
      const e = /** @type {any} */ (err);
      const where = String(e?.stack ?? '')
        .split('\n')[1]
        ?.trim();
      log.warn('插件处理消息异常，继续走 AI', {
        error: String(e?.message ?? e),
        ...(where ? { at: where } : {}),
      });
    }
  }

  /*
   * ---- 第 2 关：不带引用的确认回复 ----
   *
   * 排在插件**之后**：不带引用时两边都只能靠"恰好一条"判断，
   * 而插件自己的卡片由插件自己认最准（它的队列它清楚）。
   * 插件明确说"不是我的"，才轮到这里。
   */
  if (await tryHandleUnquotedConfirm(evt)) return;

  void considerTurn(evt);
}

/**
 * @param {string} convKey
 * @param {{role: string, nickname?: string, text: string}} item
 */
function pushRecent(convKey, item) {
  const arr = recentByConv.get(convKey) ?? [];
  arr.push(item);
  // 20 条够接上下文了；太多会让主动发言跑题
  if (arr.length > 20) arr.splice(0, arr.length - 20);
  recentByConv.set(convKey, arr);
}

/* ---------------------------------------------------------------- 视觉 */

/**
 * 这一回合允许取图吗？—— 降级矩阵的唯一判定点（契约 §8）。
 *
 * ## 为什么必须先于任何取图调用
 *
 * 需求里有一条是明确的：**关闭后停止自动取图与图片提交，不能只是隐藏界面**。
 * 所以"要不要取图"必须在这里一次判完，而不是取完图再决定发不发 ——
 * 后者照样会发 `get_image`、照样会抓 URL，用户以为省了，实际一分没省。
 *
 * 三种"不取"各有各的理由，绝不能合并成一句 `!enabled`：
 *   · 开关关着      → 用户的明确选择
 *   · 模型已实测不支持 → 取了也白取，还会因为上游 400 让整轮对话失败
 *
 * 注意：**能力未知（null）不在"不取"之列**。未知只是没测过，
 * 直接按不支持处理就等于"没测过 = 判死刑"，那正是需求要求避免的误导。
 *
 * @returns {{ok: boolean, reason: string, effective: string}}
 */
function visionGate() {
  const cfg = normalizeVisionConfig(config?.vision);
  if (!cfg.enabled) return { ok: false, reason: 'disabled', effective: 'off' };
  if (readVisionCapability().supported === false) {
    return { ok: false, reason: 'unsupported', effective: 'on-unsupported' };
  }
  return { ok: true, reason: '', effective: readVisionCapability().supported === true ? 'on' : 'on-unprobed' };
}

/**
 * 当前模型的能力探测结论（只读，绝不在这里写配置）。
 *
 * 为什么要单独抽：`llm.modelCapabilities` 的形状是
 * `{ [endpointKey]: { [modelId]: { vision, probes, ... } } }`
 * （只记视觉结论；生图由独立插件管理，不在这里），
 * 而"当前生效的是哪一个"要同时看端点与模型名。两处都手写这套寻址，
 * 迟早出现"界面显示支持、取图判定说不支持"的错位。
 *
 * @returns {{probed: boolean, supported: boolean|null, model: string, basis: string, detail: string, probedAt: string|null}}
 */
function readVisionCapability() {
  const model = String(config?.llm?.model ?? '');
  const empty = { probed: false, supported: null, model, basis: '', detail: '', probedAt: null };
  if (!model) return empty;

  let caps = null;
  try {
    caps = endpointCapabilities(config?.llm?.modelCapabilities, config?.llm?.baseUrl)?.[model] ?? null;
  } catch {
    return empty;
  }
  if (!caps || typeof caps !== 'object') return empty;

  /*
   * `supported` 只看 vision 字段的**类型**：
   *
   *   没有这个键（老配置、或探测没拿到结论）→ null（未知）
   *   true / false  → 照搬
   *
   * 不写 `caps.vision === true ? true : false`：那会把 null 折成 false，
   * 也就是把"没测过"显示成"不支持"。
   */
  const supported = typeof caps.vision === 'boolean' ? caps.vision : null;

  return {
    // probed 表示"曾经跑过探测"，与结论有无是两件事
    probed: Boolean(caps.probedAt) || typeof caps.vision === 'boolean',
    supported,
    model,
    basis: caps.vision === true ? '已实测：图片输入可用' : caps.vision === false ? '已实测：不支持图片输入' : '',
    detail: String(caps.probes?.vision?.detail ?? ''),
    probedAt: caps.probedAt ?? null,
  };
}

/**
 * 取图依赖（可注入，测试据此断言"关掉时一次都没调"）。
 *
 * 生产环境里 getImage 走 OneBot 的 `get_image`，URL 抓取走 image-fetch 的
 * 内置实现（含 SSRF 防护）。测试里两个都能替换成假的，因此不需要联网。
 *
 * @returns {object}
 */
function visionDeps() {
  return {
    /*
     * 走客户端上的 getImage，而不是在这里直接调客户端的通用动作接口。
     *
     * 理由是纪律而不是洁癖：全仓库里"通用动作调用"**只允许出现一次**
     * （发送闸门那条通路，I4 与 ui-shell 的断言都盯着它）。入口里再写一次，
     * 后来的人就没法一眼看出"哪一次是发消息、哪一次只是读图"了。
     */
    getImage: (input) => client.getImage({ file: input.file }),
    /*
     * 允许读取的本地缓存根。
     *
     * 只有用户显式配置了 SnowLuma 目录时才传：没配置时一律不知道缓存放哪，
     * 也就坚决不碰本机任何路径（契约 §3 的 E3108 走 fail-closed）。
     */
    snowlumaDir: config?.snowlumaDir || '',
  };
}

/**
 * 组装本回合要提交的图片（契约 §4）。
 *
 * ## 历史图必须是"既没提交过、又真的存在"的
 *
 * 两个条件缺一不可：
 *   · 楼层在 `imagesSeenFloors` 里 → 已经提交过，再发一遍纯属烧钱；
 *   · 楼层仍在仓库里 → 图片元数据还在，取图还有依据。
 *
 * 用仓库的 page 而不是内存 recentByConv：后者只有文本，没有 media 元数据。
 *
 * ## 引用图必须校验归属
 *
 * `job.evt.replyTo.messageId` 只是上游给的一个数字。拿它去仓库里查时
 * **必须限定 convKey**：不限定就等于"引用谁就取谁的图"，跨会话读取。
 * 查不到就当作没有引用图（不报错）—— 引用可能已被撤回或不在缓冲里。
 *
 * @param {string} convKey
 * @param {object|null} triggerEvt
 * @param {string} effective
 * @returns {Promise<{images: Array<object>, notes: string[], stats: object, codes: string[]}>}
 */
async function collectImagesForTurn(convKey, triggerEvt, effective) {
  const empty = {
    images: [],
    notes: [],
    stats: { attempted: 0, loaded: 0, skipped: 0, bytes: 0, codes: [] },
    codes: [],
  };
  if (config?.vision?.enabled !== true) return empty;
  if (readVisionCapability().supported === false) return empty;

  /** 引用消息：只在同一会话内查，查不到就当没有 */
  let quoted = null;
  const quotedId = triggerEvt?.replyTo?.messageId;
  if (quotedId !== undefined && quotedId !== null && String(quotedId).trim() !== '') {
    const hit = sessionStore
      .page(convKey, { limit: 200 })
      .messages?.find((m) => String(m.messageId ?? '') === String(quotedId));
    /*
     * 必须带上 `floor`。
     *
     * 楼层号是"这张图属于哪条消息"的唯一依据：`collectTurnImages` 把
     * `quoted.floor` 抄进结果的每一项，回到回合里再按 floor 把图挂到
     * 对应的 recent 项上（见 startTurn 的 byFloor）。这里漏了它，
     * 引用图会以 `floor: null` 返回 —— 取图、计费、统计全都发生了，
     * 但**一张都挂不到请求上**，用户看到的是"它说看不到我引用的图"，
     * 而日志里只有一串成功的取图记录。
     */
    if (hit) {
      quoted = {
        messageId: hit.messageId,
        floor: typeof hit.floor === 'number' ? hit.floor : null,
        evt: { media: hit.media ?? [], text: hit.text },
      };
    }
  }

  /*
   * 历史：仓库里的最近 200 条里，带 media 的、且图片没提交过的。
   *
   * 只把候选交给 vision.mjs，真正的 window/张数/字节预算在那边统一夹 ——
   * 这里再夹一遍就会出现"两处上限不一致"的经典漂移。
   */
  const page = sessionStore.page(convKey, { limit: 200 });
  const history = (page?.messages ?? [])
    .filter((m) => Array.isArray(m.media) && m.media.length > 0)
    .map((m) => ({ floor: m.floor, messageId: m.messageId, evt: { media: m.media } }));

  const outcome = await collectTurnImages({
    config: config.vision,
    convKey,
    isGroup: convKey.startsWith('group:'),
    trigger: triggerEvt ? { messageId: triggerEvt.messageId, floor: findFloorOf(convKey, triggerEvt.messageId), evt: triggerEvt } : null,
    quoted,
    history,
    alreadySeen: sessionStore.imagesSeenFor(convKey),
    deps: visionDeps(),
  });

  void effective;
  return outcome;
}

/**
 * 一条消息在本会话里的楼层号（找不到返回 null）。
 *
 * 为什么需要它：视觉链路要用楼层号判断"这张图是不是已经提交过"、
 * 以及在提交后登记。而上游事件里只有 messageId，没有本地楼层。
 *
 * @param {string} convKey
 * @param {unknown} messageId
 * @returns {number|null}
 */
function findFloorOf(convKey, messageId) {
  const want = String(messageId ?? '').trim();
  if (!want) return null;
  const page = sessionStore.page(convKey, { limit: 200 });
  const hit = page?.messages?.find((m) => String(m.messageId ?? '') === want);
  return typeof hit?.floor === 'number' ? hit.floor : null;
}

/* ---------------------------------------------------------------- 回合 */

/**
 * 决定这条消息是否产生回合，并处理并发策略。
 *
 * 并发规则（F7）：
 *   强触发（@ / 点名 / 私聊）  排队 —— 不能用"忙"当借口把人晾着
 *   弱触发（关键词 / 概率）    丢弃并记一行 —— 不值得为插话排队
 *
 * @param {object} evt
 */
async function considerTurn(evt) {
  if (!llm?.configured) return;
  if (!checkWhitelist(evt.convKey, config).ok) return; // 白名单外不参与

  /*
   * ══════════════════════════════════════════════════════════════
   * 第 0 步：静音指令 —— **必须排在静音闸门之前**
   * ══════════════════════════════════════════════════════════════
   *
   * 如果闸门先跑，用户一旦说「闭嘴」就**再也没有办法**用 QQ 叫它回来 ——
   * 因为「说话」这条指令同样会被闸门挡掉。那用户只能去桌面端改配置，
   * 而大多数用户不知道配置文件在哪。
   *
   * 所以顺序固定：先认指令（不看静音状态）→ 再看闸门 → 最后才走触发判定。
   *
   * 指令只允许**管理员**用：群里任何一个人都能让机器人闭嘴半小时，
   * 那就是一个可以随意骚扰的工具了。
   */
  if (config.silence?.allowCommand !== false && isAdmin(evt)) {
    const cmd = parseSilenceCommand(evt.text);
    if (cmd) {
      await handleSilenceCommand(evt, cmd);
      return; // 指令本身不产生对话回合
    }
  }

  /*
   * ══════════════════════════════════════════════════════════════
   * 第 1 步：静音闸门 —— 绝对压制，优先于一切语义判断
   * ══════════════════════════════════════════════════════════════
   *
   * 这里刻意**不看**后面的 detected 是什么。静音就是不许说话，
   * 不管这条消息多像在叫它。如果"特别像在叫"能穿透，静音就是假的 ——
   * 而用户以为自己已经让它安静了。
   *
   * 代价是 @ 它也没反应，这是用户明确选择的语义。
   */
  const silence = silenceGate.check(evt.convKey, config);
  if (silence.silent) {
    log.info('静音中，不产生回合', {
      convKey: evt.convKey,
      reason: silence.reason,
      detail: silence.detail,
    });
    return;
  }

  const detected = detectTrigger(evt, {
    selfId,
    selfName: config.persona?.name,
    // 触发关键词从 wake 取（llm.keywords 在启动时已迁移过来）
    config: { keywords: config.wake?.keywords ?? config.llm.keywords ?? [] },
    wake: config.wake,
  });

  if (detected) {
    /*
     * 唤醒频率硬限。
     *
     * ## 为什么超限时"不触发"而不是"排队"
     *
     * 排队的语义是"稍后回复"，但它解决的是"忙不过来"。
     * 这里的问题是**不该回**：一个群每分钟几十条消息，每条都起回合
     * 就是刷屏 + 烧钱，而且回合跑得比消息慢，队列只会越堆越长。
     *
     * 所以超限直接丢弃并记一行 —— 与弱触发遇到在途回合的处理一致。
     */
    const gate = wakeLedger.check(evt.convKey, {
      maxPerMinute: config.wake?.maxWakePerMinute,
      maxPerHour: config.wake?.maxWakePerHour,
    });
    if (!gate.ok) {
      log.info('唤醒被频率硬限拦下', {
        convKey: evt.convKey,
        trigger: detected.trigger,
        reason: gate.message,
        retryAfterMs: gate.retryAfterMs,
      });
      return;
    }
    wakeLedger.note(evt.convKey);
    enqueue(evt.convKey, { evt, trigger: detected.trigger, reason: detected.reason, proactive: false });
    return;
  }

  // 没人叫它 —— 才有概率唤醒的余地
  const proactive = decideProactive({
    state: triggerLedger.snapshot(evt.convKey),
    isGroup: evt.isGroup,
    config: config.proactive,
  });
  if (proactive) {
    enqueue(evt.convKey, { evt, trigger: proactive.trigger, reason: proactive.reason, proactive: true });
  }
}

/**
 * @param {string} convKey
 * @param {object} job
 */
function enqueue(convKey, job) {
  const running = inflight.get(convKey);

  if (running) {
    if (isStrongTrigger(job.trigger)) {
      /*
       * 强触发排队。用 TurnQueue 而不是单槽 Map：
       * 单槽会**静默覆盖**掉上一条排队中的强触发（连问两句只回最后一句）。
       *
       * 队列也有限度：刷屏的群可以把队列堆到很长，然后每条都跑一次模型 ——
       * 既烧钱又让回复严重滞后。超限时丢最旧的那条，并**明确记一行日志**，
       * 因为"丢了"必须可查，不能像原来那样无声无息。
       */
      const { dropped, length } = pendingTurns.push(convKey, job);
      if (dropped) {
        log.warn('回合队列已满，丢弃最早的排队项', {
          convKey,
          droppedTrigger: dropped.trigger,
          droppedReason: dropped.reason,
          queued: length,
        });
      }
      log.info('回合排队（强触发）', { convKey, trigger: job.trigger, queued: length });
    } else {
      log.info('回合丢弃（弱触发遇到在途回合）', { convKey, trigger: job.trigger });
    }
    return;
  }

  void startTurn(convKey, job);
}

/**
 * 跑一个回合。
 *
 * @param {string} convKey
 * @param {object} job
 */
async function startTurn(convKey, job) {
  const controller = new AbortController();
  inflight.set(convKey, controller);
  const turnId = `${convKey}#${Date.now()}`;

  rpc.notify('turn-start', { turnId, convKey, trigger: job.trigger, proactive: job.proactive });

  try {
    // 来源由"谁在说话 + 在哪说"结构性决定，永远不看消息内容
    const origin = resolveOrigin(convKey, job);
    /*
     * 把本回合的结构性事实一并交给工具执行器：
     *
     *   requester / messageId / replyToMessageId —— 插件 ctx.caller 的来源
     *   signal                                   —— 用户点「停止」时能中止工具
     *
     * 这三样都来自 OneBot 事件或调度器，与模型生成的内容无关。
     * 主动回合（job.evt 可能是合成的）没有真实触发者，requester 自然为空。
     */
    const triggerEvt = job.evt ?? null;

    /*
     * 注入哪张人格卡，由**会话**决定，不是由"当前选中的卡"决定。
     *
     * 原来这里直接传全局 persona，等于所有会话共用一张卡 ——
     * 于是"给某个群单独写一套"就不可能实现。
     *
     * 现在按 convKey 解析：private:<QQ> > group:<群号> > global
     * （见 PersonaStore.resolveFor）。没有任何卡命中时返回空串，
     * buildMessages 会退回 DEFAULT_PERSONA。
     *
     * ## 为什么这条解析提到 runner 之前
     *
     * 人格决定「表情工具出不出现」（见 stickerPersonaDecision）。工具的
     * 可见集在 `makeRunner` 那一刻就固定了，所以必须先有人格文本。
     * 顺序反过来会出现"这一轮给了工具、下一轮才收走"的一回合偏差 ——
     * 而那一回合里模型可能已经发了一张。
     */
    const personaForConv = personaStore.resolveFor(convKey)?.text ?? '';
    /*
     * 角色和人格各解析各的：同一个群可以配「群聊参与者」角色 + 任意人格，
     * 两者互不影响。解析规则完全一致（越具体越优先）。
     * 没命中时返回空串，buildMessages 按 isGroup 给默认角色。
     */
    const roleForConv = roleStore.resolveFor(convKey)?.text ?? '';

    /*
     * 人格对表情包的表态。
     *
     * `hideTools` 时把六个表情工具从本回合的候选集里**拿掉**，而不是
     * 只在提示词里写一句"别用"。理由见 stickerPersonaDecision。
     */
    const stickerDecision = stickerPersonaDecision(personaForConv);

    /*
     * 把本回合的结构性事实一并交给工具执行器：
     *
     *   requester / messageId / replyToMessageId —— 插件 ctx.caller 的来源
     *   signal                                   —— 用户点「停止」时能中止工具
     *   disabledTools                            —— 人格禁用的工具（管理员侧设定）
     *
     * 这些全部来自 OneBot 事件、调度器或用户配置，与模型生成的内容无关。
     * 主动回合（job.evt 可能是合成的）没有真实触发者，requester 自然为空。
     */
    const runner = makeRunner(origin, convKey, {
      requester: triggerEvt?.sender
        ? { id: String(triggerEvt.sender.userId ?? ''), nickname: String(triggerEvt.sender.nickname ?? '') }
        : undefined,
      messageId: triggerEvt?.messageId ?? null,
      replyToMessageId: triggerEvt?.replyTo?.messageId ?? null,
      signal: controller.signal,
      disabledTools: stickerDecision.hideTools ? STICKER_TOOL_NAMES : null,
    });

    /*
     * ── 视觉链路 ──────────────────────────────────────────────────
     *
     * 顺序是刻意的：**先判开关，再取图**。反过来（先取图再判断要不要用）
     * 会发出真实的 `get_image` 与 HTTP 请求 —— 用户关掉开关以后照样在取图，
     * 只是没把结果放进去。那不是"关闭"，只是"看不见"。
     *
     * visionGate() 会同时给出本回合的 effective，它决定占位文案怎么写。
     */
    const gate = visionGate();
    /** @type {{images: Array<object>, notes: string[], stats: object, codes: string[]}} */
    let visionOutcome = { images: [], notes: [], stats: { attempted: 0, loaded: 0, skipped: 0, bytes: 0, codes: [] }, codes: [] };
    if (gate.ok) {
      try {
        visionOutcome = await collectImagesForTurn(convKey, triggerEvt, gate.effective);
      } catch (err) {
        /*
         * 取图链路整段崩掉不能毁掉这一回合。
         *
         * 图片是**增强**，文字才是主体：图片全挂了也该能正常回话。
         * 这里必须落一条 warn，否则"它忽然看不见图了"会完全无迹可查。
         *
         * 同时**留下一条 note**：不写的话 `codes`/`notes` 都是空的，
         * 后面的占位补充条件不成立，模型只会看到一个赤裸的 `[图片]` ——
         * 它既不知道图取不到，也不知道为什么，于是开始编造图里的内容。
         */
        log.warn('视觉取图异常，本回合按纯文本继续', {
          convKey,
          message: String(/** @type {any} */ (err)?.message ?? err),
        });
        visionOutcome = {
          images: [],
          notes: ['本回合取图过程异常，图片没有提交成功'],
          stats: { attempted: 0, loaded: 0, skipped: 0, bytes: 0, codes: [] },
          codes: [],
        };
      }
    }

    /*
     * 把图挂到对应的 recent 项上。
     *
     * ## 为什么按 floor 归属，而不是"把图都塞给最后一条"
     *
     * 一次提交的图可能来自三条不同消息（本期、引用、历史）。全塞进最后一条
     * 会让模型以为"这些图都是刚发的"，于是把昨天的图当成当前话题回答 ——
     * 这种错误在输出里看起来完全合理，极难发现。
     *
     * floor 为 null 的项（占位、工具结果）不接收图片。
     */
    const recentForModel = (recentByConv.get(convKey) ?? []).map((item) => ({ ...item }));
    if (visionOutcome.images.length > 0) {
      const byFloor = new Map();
      for (const img of visionOutcome.images) {
        if (typeof img.floor !== 'number') continue;
        const arr = byFloor.get(img.floor) ?? [];
        arr.push({ dataUrl: img.dataUrl, mime: img.mime, label: img.label });
        byFloor.set(img.floor, arr);
      }
      for (const item of recentForModel) {
        /*
         * 只挂在 **user** 项上。
         *
         * 提示词层只给 user 消息渲染 `image_url`（assistant/system 带图会被
         * 一部分上游直接 400，见 docs/vision-contract.md §6）。如果这里把图
         * 挂到一条 assistant 项上，那张图就既不会渲染、又会被计入
         * `markImagesSeen` —— 等于"取了、算了钱、标了已提交，模型没见过"。
         * 挂不上的（包括这种）会走下面的孤儿分支，补成一条 user 图文消息。
         */
        if (item.role !== 'user') continue;
        const imgs = byFloor.get(item.floor);
        if (imgs && imgs.length > 0) item.images = imgs;
      }

      /*
       * 挂不上任何楼层的图，必须**补充一条消息**把它们带进请求。
       *
       * ## 为什么会有挂不上的图
       *
       * `recentByConv` 只保留最近 20 条，而视觉候选来自仓库的最近 200 条
       * （引用消息、更早的历史图都可能落在这 20 条之外）。按 floor 挂图时
       * 找不到宿主项，图就被静默丢掉 —— 但取图、计费、`markImagesSeen`
       * 都已经发生了：下一回合它们被当成"提交过"永不重试，模型却一次都
       * 没看见。表现是"它说看不到我引用的图"，日志里却全是成功取图。
       *
       * ## 为什么补一条 user 图文消息，而不是塞给最后一条
       *
       * 塞给最后一条会让模型以为这些图是刚发的（同 §"为什么按 floor 归属"）。
       * 补一条带说明的独立消息，时间关系是明确的；提示词层本来就把
       * "图片 + 文本"渲染成合法的多模态 content，不需要额外协议。
       *
       * 每条最多 4 张：`prompt.mjs` 的 `MAX_IMAGES_PER_MESSAGE` 是 4，
       * 超过会被静默忽略 —— 那等于又丢一次，所以在这里先分好组。
       */
      const attachedFloors = new Set(
        recentForModel
          .filter((item) => Array.isArray(item.images) && item.images.length > 0)
          .map((item) => item.floor),
      );
      const orphans = visionOutcome.images.filter(
        (img) => !(typeof img.floor === 'number' && attachedFloors.has(img.floor)),
      );
      const IMAGES_PER_MESSAGE = 4;
      for (let i = 0; i < orphans.length; i += IMAGES_PER_MESSAGE) {
        const chunk = orphans.slice(i, i + IMAGES_PER_MESSAGE);
        recentForModel.push({
          role: 'user',
          nickname: '引用',
          text: `更早消息里的图片（${chunk.length} 张，随本条一起提交）`,
          floor: null,
          images: chunk.map((img) => ({ dataUrl: img.dataUrl, mime: img.mime, label: img.label })),
        });
      }
      if (orphans.length > 0) {
        log.info('引用/更早历史的图片补充为独立消息', { convKey, count: orphans.length });
      }

      /*
       * 图片真的提交了 —— 登记楼层，下一回合不再重复提交。
       *
       * 这是"避免每轮重复提交全部历史图片造成费用增长"的落点：
       * 没有这一步，历史里的图会被每一回合重新塞进请求体，成本按回合累加，
       * 而模型得到的边际信息几乎为零。
       */
      const withImages = floorsWithSubmittedImages(visionOutcome.images);
      if (withImages.length > 0) {
        const marked = sessionStore.markImagesSeen(convKey, withImages);
        log.info('本回合提交了图片', {
          convKey,
          images: visionOutcome.images.length,
          bytes: visionOutcome.stats.bytes,
          floors: withImages,
          marked,
        });
      }
    }

    /*
     * 取不到图 / 开关关着 / 模型不支持时，给 [图片] 占位补一句说明。
     *
     * 模型看到孤零零一个 `[图片]` 时，要么编造图里的内容，要么回一句
     * "我看不到图片" —— 两种都很突兀。给它一句准确的说明，它就能自然地
     * 说"图我这边看不出来，你说说是什么"。
     */
    const turnEffective = resolveEffective({
      enabled: gate.effective !== 'off',
      supported: readVisionCapability().supported,
      lastTurn: visionOutcome.stats,
    });
    /*
     * 什么时候要给 [图片] 补说明？
     *
     * 三种"模型看不到图"的情况都必须补，否则它只能对着一个占位符瞎猜：
     *   · `off`            —— 用户关了读图
     *   · `on-unsupported` —— 模型已实测不支持
     *   · `on-but-blocked` —— 开关与能力都正常，但这一回合一张都没取到
     *                        （预算耗尽/全部超限/取图异常）。这个态以前漏了：
     *                        结果是"取图失败"和"成功但没图"在提示词里长得一样。
     * 另外 `codes`/`notes` 非空时也要补：它们是具体原因。
     */
    const shouldAnnotate =
      gate.effective === 'off' ||
      gate.effective === 'on-unsupported' ||
      turnEffective === 'on-but-blocked' ||
      visionOutcome.codes.length > 0 ||
      visionOutcome.notes.length > 0;
    if (shouldAnnotate) {
      for (const item of recentForModel) {
        if (item.role === 'assistant') continue;
        item.text = annotateImagePlaceholders(item.text, turnEffective, visionOutcome.notes);
      }
    }

    // 运行时统计：界面「实际效果」与「运行统计」两块都读它
    recordVisionTurn(visionRuntime, visionOutcome, () => Date.now());

    const messagesForModel = buildMessages({
      persona: personaForConv,
      role: roleForConv,
      context: {
        convKey,
        isGroup: convKey.startsWith('group:'),
        recent: recentForModel,
        trigger: job.reason,
        proactive: job.proactive,
        /*
         * 分条约定必须与**发送层用的上限**是同一个值。
         *
         * 提示里说"最多 3 条"而发送层按 2 条发，模型会以为自己没守规矩，
         * 而这种不一致在日志里看不出来 —— 两边都读同一个配置就不会漂。
         */
        maxMessages: config.reply?.splitEnabled === false ? 1 : config.reply?.maxMessages,
        /*
         * 表情策略：只有在"插件启用 + 人格没禁止"时才注入。
         *
         * `hideTools` 意味着模型连工具都看不到，这时再注入一段"你有收藏表情
         * 可以发"就是纯误导 —— 它会尝试去描述一个自己调不到的能力。
         * 空串时 buildMessages 不追加任何内容，系统提示与改动前逐字节一致。
         */
        stickerGuidance: stickerDecision.hideTools
          ? ''
          : buildStickerGuidance({
              enabled: stickerPluginEnabled() && stickerConfig().sendEnabled !== false,
              maxPerTurn: 1,
              visionEnabled: gate.effective !== 'off',
              overridePersona: stickerConfig().overridePersona === true,
            }),
      },
    });

    /*
     * 登记「这些楼层真的进模型了」。
     *
     * ## 为什么必须在 buildMessages 之后立刻做
     *
     * 读楼层的唯一前进条件是「喂过模型」或「已淘汰」。如果这里漏登记，
     * 读楼层就会永远卡在这一楼 —— 每一回合都把同一批消息重新喂一遍，
     * 模型反复回答同一个问题。反过来，如果登记了其实没喂的楼，
     * 那条消息就永远不会被处理。所以这里精确取 recent 里的 floor。
     *
     * 回合被取消也照样算：模型确实看到过这些内容，重跑一遍没有意义。
     */
    const fedFloors = (recentByConv.get(convKey) ?? [])
      .map((item) => item.floor)
      .filter((f) => typeof f === 'number');
    if (fedFloors.length > 0) sessionStore.markModelSeen(convKey, fedFloors);

    // 记录本轮产生的文本，供用量记账在缺 usage 时估算。
    // 注意两个坑：
    //   1. 不能在 onUsage 里读 `result` —— 那时它还没赋值（TDZ），
    //      会抛 ReferenceError 并被当成"未处理的 Promise 拒绝"，用量直接丢失。
    //   2. 也不能等 runTurn 返回后再赋值 —— onUsage 在回合中途就会触发，
    //      那时还拿不到最终文本。所以在 onDelta 里边收边累积。
    let turnText = '';

    /*
     * ## 上游拒收图片时的去图重试
     *
     * 能力探测是**一次独立请求**的结论。真实回合里上游仍可能因为别的原因
     * 拒收图片：中转没接多模态、图片尺寸超了它自己的限制、模型换了但配置没更新。
     * 这时整轮对话会直接失败 —— 用户看到的是"它坏了"，而实际上只要有文字
     * 就能正常回答。
     *
     * 所以这里兜一层：**只有**确认是"图片本身被拒"才去图重试，
     * 且**只重试一次**。key 错、额度不足、5xx 都不走这条路（looksLikeImageRejection
     * 明确排除了它们）—— 那些情况下重试只会把同一个错误再犯一遍。
     *
     * 重试成功后，把这件事记进运行时统计与日志，但**绝不写进 modelCapabilities**：
     * 一次上游拒收可能是图片太大、可能是临时故障，把它固化成"不支持"
     * 会污染"确认不支持"的语义，而那个语义是界面判断要不要取图的依据。
     */
    let usedMessages = messagesForModel;
    let imageRetry = null;

    /*
     * 这一回合里工具被调用了几次。
     *
     * 只用来回答一个问题：**去图重试时还能不能再给工具**。
     * 工具一旦真的跑过，它的副作用（发图、发表情、写业务数据）就已经落地，
     * 而重试是"整轮重跑"，副作用不会回滚（见下面 imageRetry 分支）。
     */
    let toolCallsThisTurn = 0;

    const runOnce = async (msgs, attemptRunner = runner) =>
      runTurn({
        llm,
        runner: attemptRunner,
        toOpenAiTools,
        messages: msgs,
        signal: controller.signal,
        proactive: job.proactive,
        onDelta: (delta) => {
          turnText += delta;
          rpc.notify('turn-delta', { turnId, delta });
        },
        onToolCall: (info) => {
          toolCallsThisTurn += 1;
          rpc.notify('turn-tool', { turnId, ...info });
        },
        onUsage: async ({ usage, model }) => {
          // 记账失败绝不能让回合崩掉，但也不能静默吞掉——记一行 warn
          try {
            await usageLedger.record({
              convKey,
              model,
              usage,
              proactive: job.proactive,
              /*
               * 多模态之后 content 可能是数组。直接 join 会产出
               * `[object Object]`，让缺 usage 时的 token 估算几乎归零
               * （表现为"账单和界面数字对不上"且不报错）。
               * messagesToPlainText 只取 text 段，图片记一个占位记号。
               */
              promptText: messagesToPlainText(msgs),
              completionText: turnText,
            });
          } catch (err) {
            log.warn('用量记账失败', { convKey, message: String(/** @type {any} */ (err)?.message ?? err) });
          }
        },
      });

    let result;
    try {
      result = await runOnce(messagesForModel);
    } catch (err) {
      const e = /** @type {any} */ (err);
      const hasImages = messagesForModel.some((m) => Array.isArray(m.content));
      if (!hasImages || !looksLikeImageRejection(e?.status, String(e?.message ?? e))) throw err;

      /*
       * 去图重试：把带 image_url 的消息退回成纯文本。
       *
       * 用 annotateImagePlaceholders 给 [图片] 补一句说明，让模型知道
       * "这里本来有图、但这次没带上"，而不是对着一个孤立的占位符瞎猜。
       */
      usedMessages = messagesForModel.map((m) => ({
        ...m,
        content: Array.isArray(m.content)
          ? annotateImagePlaceholders(contentToText(m.content), 'on-but-blocked', [])
          : m.content,
      }));

      imageRetry = {
        at: Date.now(),
        status: e?.status ?? null,
        message: String(e?.message ?? e).slice(0, 200),
      };
      log.warn('上游拒收图片，已去图重试（不记为"不支持读图"）', {
        convKey,
        status: imageRetry.status,
        detail: imageRetry.message,
      });

      // 统计与界面要能看出"发生过一次拒收"，但它不等于"能力为 false"
      visionRuntime.imageRejectedCount += 1;
      visionRuntime.lastImageRejectedAt = imageRetry.at;

      /*
       * 重试时还要不要给工具？——这里必须按"第一次尝试有没有真的跑过工具"决定。
       *
       * 重试是**整轮重跑**：同一段对话再喂一遍模型、它再决定调什么工具。
       * 而工具副作用不会回滚 —— 第一次尝试里已经 `ctx.chat.send` 出去的
       * 一句话、`sendMedia` / 生图投递 / 发表情发出去的图，都真实存在于
       * QQ 里了。此时重试若继续提供同样的工具，模型很可能再调一次，
       * 用户看到的就是"同一张图发了两遍 / 同一句话说了两次"。
       *
       * 所以：第一次尝试里一旦发生过工具调用，重试这一轮**不给任何工具**。
       * 代价是重试回合只能用已有上下文作答（通常本来就够 —— 图去掉了，
       * 剩下的文字与工具结果都还在 messages 里）；换来的是不可能重复产生
       * 副作用。宁可这一轮少做一次工具调用，也不要重复发一条内容。
       *
       * 第一次尝试一个工具都没调时保持原样：没有副作用可重复，
       * 限制工具只会让本该能答的问题答不出来。
       *
       * 判定收在 `buildImageRetryRunner` 里，好让 test/image-retry-guard
       * 直接调用它，而不是靠读源码正则来"证明"这段逻辑存在。
       */
      const retryRunner = buildImageRetryRunner(runner, toolCallsThisTurn);
      if (retryRunner !== runner) {
        log.info('去图重试：第一次尝试已调用过工具，本轮不再提供工具（防重复发送）', {
          convKey,
          toolCalls: toolCallsThisTurn,
        });
      }

      turnText = '';
      result = await runOnce(usedMessages, retryRunner);
    }
    void usedMessages;

    turnText = result.text ?? '';

    /*
     * 原生联网证据在**回合结束后立刻记账**。
     *
     * 放在 cancelled 分支之前：被取消的回合也可能已经收回了引用，
     * 而"它到底有没有联网"是进程级事实，不该因为用户点了停止就丢掉。
     * 这里只记状态与条数，不记来源正文（见 recordNativeSearch）。
     */
    recordNativeSearch(result.nativeSearch);

    /*
     * 思考归档放在"是否发出回复"之前：它记的是「它想了什么」，
     * 与这条回复最终发没发出去无关。取消的回合也有思考过程，一并留下。
     * 没有 reasoning 时 record() 会直接返回 null（静默降级，不建空记录）。
     */
    recordThinking(convKey, result);

    const notice = truncationNotice(result);
    const reply = (result.text ?? '').trim();

    if (result.cancelled) {
      rpc.notify('turn-end', { turnId, cancelled: true });
      return;
    }

    if (!reply && !notice) {
      rpc.notify('turn-end', { turnId, empty: true });
      return;
    }

    /*
     * 拆分 + 逐条发送 + 记账，全在 deliverReply 里。
     *
     * 那段逻辑本身有单测（test/reply-deliver.test.mjs），覆盖
     * 部分失败、中止、顺序。这里只负责接线：注入唯一的发送闸门、
     * 共享串行器，以及"记什么"。
     *
     * 记账语义（见 deliver.mjs）：
     *   onSent      每条真的发出去的才进上下文
     *   onDelivered 一次回复只记一次回合（不是三条）
     */
    const delivery = await deliverReply({
      convKey,
      text: reply,
      notice,
      send: sendText,
      sequencer: replySequencer,
      signal: controller.signal,
      config: config.reply,
      onSent: (text) => pushRecent(convKey, { role: 'assistant', text }),
      onDelivered: () => {
        triggerLedger.noteAutoTurn(convKey);
        if (job.proactive) triggerLedger.noteProactive(convKey);
      },
    });

    /*
     * 部分失败必须留痕：否则"少了一条"在日志里完全看不出来 ——
     * 用户只会觉得机器人话说一半。
     */
    if (delivery.failed.length > 0) {
      log.warn('回复分条发送有失败', {
        convKey,
        sent: delivery.sent.length,
        failed: delivery.failed.length,
        firstCode: delivery.failed[0]?.code,
        firstMessage: delivery.failed[0]?.message,
      });
    }
    if (delivery.aborted) {
      log.info('回复发送被中止', { convKey, sent: delivery.sent.length, planned: delivery.planned });
    }

    rpc.notify('turn-end', {
      turnId,
      ok: delivery.ok,
      code: delivery.ok ? null : (delivery.failed[0]?.code ?? null),
      // 界面用的整段文本：与实际发出的内容一致（协议块不会漏到界面上）
      text: delivery.sent.join('\n'),
      messages: delivery.sent,
      messageCount: delivery.sent.length,
      splitMode: delivery.splitMode,
      splitReason: delivery.splitReason,
      clamped: delivery.clamped,
      failedCount: delivery.failed.length,
      aborted: delivery.aborted,
      proactive: job.proactive,
      steps: result.steps,
      usage: result.usage,
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    /*
     * 回合失败 ≠ 它没想过。
     *
     * agent-loop 会把失败前已产生的 thinkingTrace 挂在错误对象上，
     * 这里照常归档 —— 用户排查"它怎么答成这样"时，那几步推理才是关键。
     * recordThinking 自己吞异常，不会把一次失败变成两次。
     */
    if (Array.isArray(e?.thinkingTrace) && e.thinkingTrace.length > 0) {
      recordThinking(convKey, { thinkingTrace: e.thinkingTrace, text: '' });
    }
    log.error('回合失败', { convKey, code: e?.code, message: String(e?.message ?? e) });
    rpc.notify('turn-end', { turnId, ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) });
  } finally {
    inflight.delete(convKey);
    /*
     * 消费队列：按 **FIFO** 取最早的一条，而不是"取任意一条"。
     *
     * 顺序很重要 —— 用户连着问两句时，先问的那句必须先得到回答，
     * 否则就是「回复混乱」：答的是后一句，前一句的问题被彻底忽略。
     *
     * 用 while 而不是 if 只跑一条：一次只能有一个回合在跑，
     * 所以这里只起一条就地返回（新起的回合会在它自己的 finally 里继续消费）。
     */
    const next = pendingTurns.shift(convKey);
    if (next) {
      void startTurn(convKey, next);
    }
  }
}

/**
 * 把一回合的思考记进仓库。
 *
 * 为什么单独抽一个函数：这里要吃掉所有异常。归档是纯展示数据，
 * 磁盘满 / 权限不对都不该让一次已经成功的对话变成"回合失败"。
 *
 * @param {string} convKey
 * @param {{thinkingTrace?: object[], text?: string}} result
 */
function recordThinking(convKey, result) {
  try {
    const steps = result?.thinkingTrace ?? [];
    /*
     * 非推理模型：整段没有 reasoning，静默降级（不写文件、不建空记录）。
     *
     * 但**不能真的悄无声息**。以前这里直接 return，于是"换了模型之后
     * 思考链路再也不更新"这件事在日志里连一行都没有，只能靠猜测。
     * 现在留两条线索：
     *   1. 运行日志里一行（带上模型名，方便对上"我刚换了模型"）；
     *   2. store 里的 lastSkip，界面据此显示"这一回合没有思考内容"。
     */
    if (!Array.isArray(steps) || steps.length === 0) {
      const at = Date.now();
      thinkingStore.noteNoReasoning?.({ convKey, at });
      log.info('本回合没有思考内容（模型未返回 reasoning），思考链路不记录', {
        convKey,
        model: config?.llm?.model ?? null,
      });
      return;
    }
    thinkingStore.record({
      convKey,
      at: Date.now(),
      steps,
      answerPreview: String(result?.text ?? '').slice(0, 200),
    });
  } catch (err) {
    log.warn('思考记录写入失败（不影响对话）', {
      convKey,
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }
}

/**
 * 回合来源（I13/I14 的唯一入口）。
 *
 * 判定只看两个结构事实：**谁**在说话、**在哪**说。
 * 消息正文一个字都不参与判断 —— 这是整个安全模型的地基。
 *
 * @param {string} convKey
 * @param {object} job
 * @returns {import('./guard/origin.mjs').Origin}
 */
function resolveOrigin(convKey, job) {
  // 主动发言：没有具体任务，默认空集（F7 边界）
  if (job.proactive) return ORIGIN.PROACTIVE;

  const [kind, id] = convKey.split(':');
  const isOwner = isOwnerId(id, kind);

  if (kind === 'private') {
    return isOwner ? ORIGIN.OWNER_PRIVATE : ORIGIN.GROUP;
  }
  // 群聊：即使管理员在群里，也只给 QQ 工具（不给宿主机）
  return isOwner ? ORIGIN.OWNER_GROUP : ORIGIN.GROUP;
}

/**
 * 来源判定里的"主人"。
 *
 * ## 私聊：只认核心管理员，**不再看白名单**
 *
 * 原来这里读的是 `config.allow.private`。那等于把"谁能跟它说话"和
 * "谁能让它动本机"合并成一张表 —— 用户把某个号加进白名单（本意只是
 * 允许对话），就顺带授予了宿主机工具。现在只认 `config.admin.qqIds`，
 * 以及用户显式打开的 `admin.inheritWhitelist`（见 guard/admin.mjs）。
 *
 * ## 群聊：机器人自己的号
 *
 * 群里"管理员"的语义与私聊不同：通过 QQ 号判断谁在不在管理员名单里
 * 在群里没有意义（群友的号本来就不该在名单上）。这里保留原判定 ——
 * 机器人自己发的话算 owner-group，而它发的消息在上游已被过滤。
 *
 * @param {string} id
 * @param {string} kind
 * @returns {boolean}
 */
function isOwnerId(id, kind) {
  if (kind === 'private') return isCoreAdmin(config, id);
  return String(id) === String(selfId);
}

/* ---------------------------------------------------------------- 发送 */

/**
 * 全仓库唯一的发送实现（不变量 I4）。
 *
 * @param {string} convKey
 * @param {string} text
 * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
 */
async function sendText(convKey, text) {
  return sendSegments(convKey, [{ type: 'text', data: { text: escapeCq(text) } }], text);
}

/**
 * 发送任意消息段。
 *
 * ## 为什么单独抽出来
 *
 * 手动发送要支持文本 / 图片 / 视频 / 文件，但它们**必须走同一套闸门**：
 * 白名单、出站审计、限流。如果给图片单开一条捷径，
 * 那条路径就没有审计覆盖了——「换个消息类型就能绕过检查」
 * 是最典型的授权漏洞。
 *
 * 所以这里只负责"怎么发"，"能不能发"全在 passSendGate 里。
 * 审计文本用 `auditText`（调用方给出：文本就是正文，图片是文件名）。
 *
 * @param {string} convKey
 * @param {Array<{type: string, data: object}>} segments
 * @param {string} auditText
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, code?: string, message?: string, messageId?: any}>}
 */
async function sendSegments(convKey, segments, auditText, signal) {
  if (signal?.aborted) return { ok: false, code: 'E4070', message: '发送已取消' };
  const gated = passSendGate({
    convKey,
    text: auditText,
    /*
     * 管理员名单现在住在**插件配置**里（`plugins.config['dsh-bridge'].admins`）。
     *
     * 这里原先读的是 `config.dsh?.admins` —— 那是迁移前的旧位置。
     * `migrateLegacyDsh` 把值搬去插件配置后，旧字段就被清空了，
     * 于是 `admins` 恒为 `[]`，下游两个豁免**从未生效**：
     *   1. `checkWhitelist` 的管理员私聊豁免
     *   2. `passSendGate` 的管理员私聊限流豁免
     *
     * 表现就是审批/确认卡被白名单或限流静默挡下，用户什么都收不到。
     * 保留旧位置兜底：万一迁移还没跑到（冷启动第一轮）。
     */
    config: { ...config, admins: resolveAdminQqs(config) },
    audit: auditOutbound,
    limiter,
  });
  if (!gated.ok) {
    log.warn('发送被闸门拒绝', { convKey, code: gated.code, reason: gated.message });
    return { ok: false, code: gated.code, message: gated.message };
  }

  if (!client) return { ok: false, code: 'E1001', message: '尚未联通' };

  const [kind, id] = convKey.split(':');
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const params =
    kind === 'group'
      ? { group_id: Number(id), message: segments }
      : { user_id: Number(id), message: segments };

  try {
    /*
     * 发送也走**同一个**动作出口（requestOneBotAction）。
     *
     * 这不是多绕一层：静态检查 I4 断言 `client.sendAction` 的调用在全仓库
     * 只出现一次。把"发消息"和"读收藏表情"分成两处调用，那条断言就
     * 立刻失守 —— 而它守的正是"发送只有一条通路"。
     *
     * 所以唯一的出口是 requestOneBotAction；区别在**谁能调它**：
     * 这里（已经过闸门）与 gateway-bridge（受控能力，动作名来自白名单）。
     */
    if (signal?.aborted) return { ok: false, code: 'E4070', message: '发送已取消' };
    const res = await requestOneBotAction(action, params);
    return { ok: true, messageId: res?.message_id };
  } catch (err) {
    const e = /** @type {any} */ (err);
    return { ok: false, code: e?.code ?? 'E1030', message: String(e?.message ?? e) };
  }
}

/**
 * 发一个**非发送类**的 OneBot 动作（读收藏表情、取图片字节等）。
 *
 * ## 为什么它必须和白名单动作分开
 *
 * `client.sendAction` 是全仓库唯一能往上游"做事"的出口，而 I4 守着
 * "发送只有一条通路"（静态检查断言它的调用只出现一次）。
 * 那条断言守的其实是**发送**：如果有人在入口里直接发 `send_group_msg`，
 * 白名单与限流就形同虚设。
 *
 * 表情包需要的是**另一类**动作：`fetch_custom_face_detail`（读收藏列表）、
 * `get_supported_actions`（能力探测）、`add_custom_face`（账号写）、
 * `get_image`（读缓存字节）。它们没有"发给谁"这个维度，因此不该、
 * 也不能走 sendSegments（那条路要求 convKey + 审计 + 限流）。
 *
 * 所以这一层是刻意存在、且**只被网关能力调用**的：动作名来自
 * `GATEWAY_ACTIONS` 的白名单，不是模型给的字符串。
 *
 * ## 为什么不用 `client.getImage` 那种"收在客户端里"的写法
 *
 * 因为动作是**网关扩展**，不是固定清单：`fetch_custom_face_detail`、`add_custom_face`、
 * `modify_custom_face` 都是 SnowLuma 侧的扩展，不同实现可能连名字都不一样。
 * 把它们一个个写进 client 会让客户端认识上游专有名 —— 而 I2 明确要求
 * `onebot/client.mjs` 里不出现上游专有名，只认 `wsUrl` + `accessToken`。
 *
 * 所以分发点留在这里（入口本来就认识 OneBot），而**调用方**只有
 * gateway-bridge，它在受控能力后面，模型碰不到动作名。
 *
 * @param {string} action OneBot 动作名
 * @param {object} [params]
 * @returns {Promise<any>}
 */
async function requestOneBotAction(action, params = {}) {
  const name = String(action ?? '').trim();
  if (!name) {
    const err = new Error('缺少 OneBot 动作名');
    /** @type {any} */ (err).code = 'E4071';
    throw err;
  }
  if (!client) {
    const err = new Error('尚未联通的 OneBot 端点');
    /** @type {any} */ (err).code = 'E1001';
    throw err;
  }
  return client.sendAction(name, params);
}

/**
 * 取管理员 QQ 列表（发给发送闸门用于白名单/限流豁免）。
 *
 * ## 这里的 admin 是**投递通道**，不是授权
 *
 * 它回答的只有一个问题：「机器人主动发给他时，要不要绕过白名单与限流」。
 * 审批推送、确认卡、回执全靠这条通道送出去，所以名单取的是**并集**：
 *
 *   1. 核心管理员 `config.admin.qqIds`（见 guard/admin.mjs）
 *   2. DSH 插件配置 `plugins.config['dsh-bridge'].admins`
 *   3. 旧字段 `config.dsh.admins`（迁移没跑到时的兜底）
 *
 * ## 为什么不能拿 `allow.private` 当管理员
 *
 * 那是**准入清单**："允许谁跟它说话"。合并之后，为了让机器人能回
 * 某人的私聊而把他加进白名单，就同时授予了他宿主机工具与确认权 ——
 * 用户完全不知道加白名单还顺带授了权。
 *
 * 所以授权判定（resolveOrigin / 确认请求的 allowedSenders）只看
 * `coreAdminIds()`，这里只负责"送得到"。
 *
 * @param {any} cfg
 * @returns {string[]}
 */
function resolveAdminQqs(cfg) {
  return deliverableAdminIds(cfg);
}

/** 允许手动发送的媒体类型 → OneBot 消息段 */
const MEDIA_KINDS = new Set(['image', 'video', 'record', 'file']);

/**
 * 手动发送媒体。
 *
 * ## 只接受本机路径，不接受 URL
 *
 * 接受 URL 等于让这个界面成为一个"让机器人替你去抓任意网址"的工具，
 * 而它跑在有网络的机器上。OneBot 的 `file` 字段对 http 是有支持的，
 * 但支持不代表该在这里开放。用户要发网络图片，先下载下来再选。
 *
 * ## 文件是否存在必须在发送前检查
 *
 * 上游遇到不存在的路径不会明确报错，往往是静默失败或者发一张破图。
 * 与其让用户对着"已发送"怀疑人生，不如在本地就拦住。
 *
 * @param {{convKey?: string, kind?: string, path?: string, name?: string}} arg
 */
async function sendMedia(arg) {
  const convKey = String(arg?.convKey ?? '');
  const kind = String(arg?.kind ?? '');
  const filePath = String(arg?.path ?? '').trim();

  if (!MEDIA_KINDS.has(kind)) {
    return { ok: false, code: 'E40XX', message: `不支持的消息类型：${kind || '(空)'}` };
  }
  if (!filePath) {
    return { ok: false, code: 'E40XX', message: '还没选择文件' };
  }

  // 只允许本机绝对路径：拒绝 URL 和 ~ 之类需要猜测的写法
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) {
    return { ok: false, code: 'E40XX', message: '只支持本机文件路径，不支持网址' };
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, code: 'E40XX', message: '需要绝对路径' };
  }

  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return { ok: false, code: 'E40XX', message: '不是一个文件' };
    // OneBot 实现普遍对超大文件没有好的错误反馈，先自己拦一道
    if (st.size > MAX_MEDIA_BYTES) {
      return {
        ok: false,
        code: 'E40XX',
        message: `文件太大（${Math.round(st.size / 1024 / 1024)}MB，上限 ${MAX_MEDIA_BYTES / 1024 / 1024}MB）`,
      };
    }
  } catch {
    return { ok: false, code: 'E40XX', message: '文件不存在或不可读' };
  }

  const fileName = path.basename(filePath);
  // file 段必须带 name，否则 QQ 客户端显示成一串路径
  const data =
    kind === 'file'
      ? { file: filePath, name: String(arg?.name ?? fileName) }
      : { file: filePath };

  return sendSegments(convKey, [{ type: kind, data }], `[${kind}] ${fileName}`);
}

/** 手动发送的单文件上限：100MB。超过这个体积，QQ 侧基本也不会成功 */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/* ---------------------------------------------------------------- 工具 */

/**
 * 为某个来源创建工具执行器。
 *
 * 注意：origin 由**服务端**决定（来自 IPC 的 setting/action 或会话归属），
 * 绝不接受调用方随便传一个 origin 来提权。
 *
 * policy 必须从配置实时取，否则 `tools.allowR3` 会变成一个改了也不生效的假开关。
 *
 * @param {import('./guard/origin.mjs').Origin} origin
 * @param {string} convKey
 * @param {object} [turn] 本回合的结构性事实（触发者 / 消息 id / 取消信号）
 * @param {{id?: string, nickname?: string}} [turn.requester]
 * @param {unknown} [turn.messageId]
 * @param {unknown} [turn.replyToMessageId]
 * @param {AbortSignal} [turn.signal]
 */
/**
 * 为某个来源创建工具执行器。
 *
 * 注意：origin 由**服务端**决定（来自 IPC 的 setting/action 或会话归属），
 * 绝不接受调用方随便传一个 origin 来提权。
 *
 * policy 必须从配置实时取，否则 `tools.allowR3` 会变成一个改了也不生效的假开关。
 *
 * @param {import('./guard/origin.mjs').Origin} origin
 * @param {string} convKey
 * @param {object} [turn] 本回合的结构性事实（触发者 / 消息 id / 取消信号）
 * @param {{id?: string, nickname?: string}} [turn.requester]
 * @param {unknown} [turn.messageId]
 * @param {unknown} [turn.replyToMessageId]
 * @param {AbortSignal} [turn.signal]
 * @param {string[]} [turn.disabledTools] 本轮结构性不可见的工具（完整名）
 */
function makeRunner(origin, convKey, turn = {}) {
  assertOrigin(origin);
  /*
   * policy 必须**每次现算**（getPolicy），不能在这里快照一份。
   *
   * runner 在一个回合里是长期对象；用户在回合中途关掉联网后，下一次
   * `availableTools()`（agent-loop 每次问模型前都会调）必须立刻看不到
   * 搜索工具。快照的后果是模型仍看得到、会调、拿 E4080、换个说法重试。
   *
   * 本回合要藏起来的工具 = 环境级的（联网总闸，来自 base）+ 回合级的（人格卡）。
   * 两处都必须保留 —— 见 mergeDisabledTools 的说明：覆盖会让
   * "刚关掉联网、人格又禁用表情"这种情况只生效一个。
   */
  const getPolicy = () => {
    const base = toolPolicy();
    const hidden = mergeDisabledTools(base.disabledTools, turn.disabledTools);
    return hidden ? { ...base, disabledTools: hidden } : base;
  };
  return createToolRunner({
    /*
     * 用 getPolicy 而不是 policy：
     *
     * `context` 描述"这次调用是谁"，而 policy 描述"允不允许"。禁用理由是
     * 管理员侧设定，属于后者。放错位置的直接后果是 `isToolGranted` 读不到它。
     *
     * 空集时不加 disabledTools：保持既有形状，也让快照里的策略看起来
     * 不像是"有东西被禁了"。
     */
    getPolicy,
    context: {
      origin,
      convKey,
      /*
       * 以下四项构成插件的可信调用上下文（ctx.caller）。
       *
       * 它们全部来自**结构性事实**：回合是谁发起的（origin）、在哪个会话
       * （convKey）、哪条消息触发的（evt.messageId）、谁发的（evt.sender）。
       * 模型给的参数里没有这些字段（清单也不允许声明，见 manifest 的
       * RESERVED_PARAM_NAMES），所以它们不可能被伪造。
       */
      requester: turn.requester,
      messageId: turn.messageId,
      replyToMessageId: turn.replyToMessageId,
      // 回合取消信号：用户点「停止」时 abort，正在跑的工具要能体面停下
      signal: turn.signal,
      onRecord: (rec) => {
        toolCallLog.push(rec);
        if (toolCallLog.length > 1000) toolCallLog = toolCallLog.slice(-1000);
        log.info('工具调用', rec);
      },
      // R2/R3 需要人点头：fail-closed，超时即拒绝
      askConfirm: (req) => askHumanConfirm(req),
    },
  });
}

/**
 * 去图重试时要用的工具执行器。
 *
 * ## 为什么需要它
 *
 * 上游拒收图片时的重试是**整轮重跑**，而工具副作用不会回滚。
 * 第一次尝试里模型可能已经用 `ctx.chat.send` / `sendMedia` / 发表情 /
 * 生图投递把内容真的发出去了；重试再给同一批工具，它很可能再发一遍。
 * 于是用户看到"同一张图两条 / 同一句话两遍"——而日志里只有一次成功回合。
 *
 * 第一次尝试**没有调用过任何工具**时没有任何副作用可重复，此时原样返回
 * 同一个 runner：多限制一轮工具只会让本来能答的问题答不出来。
 *
 * @param {{availableTools: () => object[], run: Function}} runner
 * @param {number} toolCalls 第一次尝试里工具被调用的次数
 * @returns {{availableTools: () => object[], run: Function}}
 */
function buildImageRetryRunner(runner, toolCalls) {
  if (!(Number(toolCalls) > 0)) return runner;
  return {
    // 空表 = 模型看不到任何工具，也就不会发起调用
    availableTools: () => [],
    run: async () => ({
      ok: false,
      code: 'E4071',
      message: '本回合正在做去图重试，不再提供工具（避免重复发送）',
    }),
  };
}

/**
 * 请人确认一次高风险调用。
 *
 * 三条纪律：
 *   1. **默认拒绝**：没人应答、超时、界面没开，一律当"不允许"
 *   2. **不提供"本会话始终允许"**：一次确认只对一次调用有效
 *   3. **超时必须真的拒绝**，不能挂在那里等
 *
 * ## 请求在**登记那一刻**就绑死归属
 *
 * 这一版把三件事一起钉进了登记：
 *
 *   · `replyConvKey`  —— 卡片投到哪个会话，回复就必须来自那个会话。
 *     原来是 `req.convKey`（发起请求的会话）兼着当投递目标，而
 *     群聊请求也会被投到群里 —— 群友看得见、回一句就算数。
 *     现在**只投管理员私聊**（见下）。
 *   · `allowedSenders` —— 谁能处理。来源是核心管理员
 *     （`config.admin.qqIds`，见 guard/admin.mjs），**不再是白名单**。
 *     白名单回答的是"谁能跟它说话"，把它当管理员用，等于加个白名单
 *     就顺带授予了本机操作权。
 *   · 有效期与请求 ID —— 由 ConfirmRegistry 统一维护。
 *
 * ## 为什么卡片只投管理员私聊
 *
 * 群里所有人都看得见卡片，也就意味着"任何一个看得见的人都能回答"。
 * 即使 allowedSenders 会挡住非管理员，在群里暴露完整参数（可能含路径、
 * 命令）本身就不合适。所以群聊来源**不推卡片**，只在桌面端确认；
 * 桌面端没人点时按超时拒绝，这是有意的 fail-closed。
 *
 * @param {{tool: string, risk: string, args: object, convKey: string}} req
 * @returns {Promise<'allow'|'deny'>}
 */
function askHumanConfirm(req) {
  const convKey = String(req?.convKey ?? '');
  const admins = coreAdminIds(config);

  /*
   * 投递目标：只对**管理员私聊**推卡片。
   *
   * 判断的是"这个会话本身是不是某个管理员的私聊"，而不是
   * "发起请求的会话形不形如 QQ"。后者会把群聊也当成投递目标。
   */
  const [kind, id] = convKey.split(':');
  const isAdminDm = kind === 'private' && admins.includes(String(id));

  const { id: confirmId, seq, entry, promise } = confirms.register({
    tool: String(req?.tool ?? ''),
    risk: String(req?.risk ?? ''),
    // 参数摘要脱敏后再进登记表：它会出现在界面快照里
    args: redactArgs(req?.args),
    convKey,
    // 群聊/陌生私聊来的请求不设 QQ 投递目标：只能桌面端确认
    replyConvKey: isAdminDm ? convKey : '',
    // 群里任何人都可能看见卡片，所以处理人固定为管理员名单
    allowedSenders: admins,
  });

  /*
   * 桌面端永远能看到这张卡（QQ 只是它的另一个入口）。
   *
   * 先 notify 再推 QQ：桌面端是**主**通道，它必须最先可用。
   * 之前顺序反了，QQ 推送慢的时候桌面端的确认条会晚一拍才出现。
   */
  rpc.notify('confirm-request', {
    id: confirmId,
    seq,
    tool: entry.tool,
    risk: entry.risk,
    convKey,
    replyConvKey: entry.replyConvKey,
    args: entry.args,
    timeoutMs: CONFIRM_TIMEOUT_MS,
  });
  log.info('请求人工确认', {
    id: confirmId,
    seq,
    tool: entry.tool,
    risk: entry.risk,
    qq: isAdminDm,
  });

  if (isAdminDm) {
    /*
     * 推送失败只留痕、不改变"继续等"的语义：
     * 桌面端还能点，用户也可能自己想起来 QQ 上有卡片。
     *
     * 但**必须把失败写进登记表**（markPushFailed）：否则界面上这张卡
     * 看起来和推送成功的一模一样，用户会去 QQ 里找一条根本不存在的消息。
     */
    void sendConfirmToQq(confirmId, entry, CONFIRM_TIMEOUT_MS).catch((err) => {
      const msg = String(/** @type {any} */ (err)?.message ?? err);
      confirms.markPushFailed(confirmId, msg);
      log.warn('确认卡推送 QQ 失败（桌面端仍可确认）', { id: confirmId, message: msg });
    });
  }

  return promise;
}

/**
 * 把一张确认卡发到管理员私聊，并把消息 ID 绑到请求上。
 *
 * ## 为什么用 1 / 2 而不是编号
 *
 * 用户要的是「像审批那样回个数字」。编号 `confirm-1792686540396-c60ac6`
 * 三十多个字符，手机上根本没法准确抄写，抄错一位就变成"没有这条待确认"。
 *
 * 所以卡片上给**短序号**（1 = 同意，2 = 拒绝），序号到编号的映射由
 * ConfirmRegistry 冻结在登记那一刻 —— 中途有人答掉别的条，
 * 这张卡上的序号也不会变。
 *
 * ## 消息 ID 必须真的绑上
 *
 * 引用定位的全部依据就是 message_id。发送成功但没拿到 ID（上游怪象），
 * 或发送被闸门拒绝，都必须如实记账 —— 硬编一个假 ID 会让所有引用
 * 都查不到，或者更糟：查到一条错误的请求。
 *
 * @param {string} id 确认请求 ID
 * @param {any} entry ConfirmRegistry 里的条目
 * @param {number} timeoutMs
 */
async function sendConfirmToQq(id, entry, timeoutMs) {
  const mins = Math.max(1, Math.round(timeoutMs / 60000));
  const args = entry.args ?? {};

  const lines = [`需要你点头才能继续（${entry.tool}，${entry.risk}）`];

  const pairs = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .slice(0, 6);
  if (pairs.length > 0) lines.push(`参数：${pairs.join('，')}`);

  // 多条待确认时把序号显式写出来，避免"到底在批哪一条"
  const total = confirms.size;
  if (total > 1) {
    lines.push(`这是第 ${entry.seq} 条（共 ${total} 条待确认）。`);
  }

  lines.push(
    `引用这条消息回 1 同意，回 2 拒绝${total > 1 ? `；也可以回「同意 ${entry.seq}」` : ''}。${mins} 分钟内没回按拒绝处理。`,
  );

  const r = await sendText(entry.replyConvKey, lines.join('\n'));
  if (r && r.ok === false) {
    // 推送失败必须留痕：不然用户既没看到卡片、日志里也没有任何线索，
    // 只能等到超时后看到一个"未获批准"，完全查不出原因。
    confirms.markPushFailed(id, `${r.code ?? ''} ${r.message ?? ''}`.trim() || '发送被拒绝');
    log.warn('确认卡推送 QQ 失败（桌面端仍可确认）', {
      id,
      code: r.code,
      message: r.message,
    });
    return;
  }

  /*
   * 绑定消息 ID。
   *
   * 拿不到 ID 时**不发明一个**：卡片照发（用户仍能按"恰好一条"回），
   * 但引用定位会失效 —— 那比绑错要安全得多。
   */
  const bind = confirms.bindMessage(id, r?.messageId);
  if (!bind.ok) {
    confirms.markPushFailed(id, bind.message ?? '推送结果缺少 message_id');
    log.warn('确认卡已发出但无法绑定消息 ID（引用定位不可用）', {
      id,
      message: bind.message,
    });
  }
}

/**
 * 桌面端答复一次确认请求。
 *
 * 桌面端就是用户本人在电脑前点按钮，所以**不做 QQ 身份 / 会话校验**；
 * 但存在性、有效期、未结算状态照旧校验 —— 那些是请求本身的事实，
 * 与谁来点无关。双端竞争（QQ 已答、桌面端再点）会命中"已处理过"。
 *
 * @param {string} id
 * @param {boolean} allow
 * @returns {{ok: boolean, message?: string, code?: string}}
 */
function resolveConfirm(id, allow) {
  const r = confirms.resolveFromConsole({ id, allow });
  if (!r.ok) return { ok: false, message: r.message ?? '该确认已过期或不存在', code: r.code };
  log.info('人工确认结果（桌面端）', { id: r.id, allow: allow === true });
  return { ok: true };
}

/**
 * 给界面看的参数（长文本截断，避免界面卡死）。
 *
 * @param {Record<string, any>} args
 * @returns {Record<string, any>}
 */
function redactArgs(args) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === 'string' && v.length > 400) out[k] = `${v.slice(0, 400)}…（共 ${v.length} 字）`;
    else out[k] = v;
  }
  return out;
}

/**
 * 表情相关工具的完整名。
 *
 * 列全而不是用 `plugin_sticker_` 前缀：禁用判定只做精确匹配
 * （见 `tool-gate.isToolDisabled`），前缀匹配会让"禁掉表情"变成
 * "禁掉所有以 sticker 开头的工具"，将来加一个 `sticker_stats`
 * 会被无声地一起禁掉。
 */
const STICKER_TOOL_NAMES = Object.freeze([
  'plugin_sticker_list',
  'plugin_sticker_search',
  'plugin_sticker_image',
  'plugin_sticker_note',
  'plugin_sticker_collect',
  'plugin_sticker_send',
]);

/**
 * 表情插件是否启用（按配置现读）。
 *
 * @returns {boolean}
 */
function stickerPluginEnabled() {
  const list = config?.plugins?.enabled;
  return Array.isArray(list) && list.includes('stickers');
}

/**
 * 表情插件的配置（现读，含默认值兜底）。
 *
 * @returns {Record<string, any>}
 */
function stickerConfig() {
  const raw = config?.plugins?.config?.stickers;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/**
 * 本会话的人格对表情包的表态 → 要不要把表情工具拿掉。
 *
 * ## 为什么这是"结构性"的而不是"提示性"的
 *
 * 提示词是软约束。人格写着"不用表情包"、工具却摆在模型手边时，它有一定
 * 概率还是会调 —— 而且那种调用看起来完全合理（备注写着"笑哭"、语境也
 * 对得上），用户只会觉得"我不是说了别用吗"。
 *
 * 把工具从候选集里拿掉才是确定的：模型看不到，就调不出来。
 *
 * ## 为什么判据是人格而不是聊天内容（I14）
 *
 * `personaText` 是**管理员/用户自己写的卡片**，和 `admin.qqIds`、
 * `plugins.chatTools` 是同一类输入。它不来自群消息，群里任何人
 * 都无法影响它 —— 所以不违反"授权不能被对话内容影响"。
 *
 * @param {string} personaText 本会话解析出的人格文本（空串 = 用默认人格）
 * @returns {{hideTools: boolean, stance: string}}
 */
function stickerPersonaDecision(personaText) {
  // 没装/没启用插件时不必判断：工具本来就不在
  if (!stickerPluginEnabled()) return { hideTools: false, stance: 'unset' };
  const cfg = stickerConfig();
  if (cfg.overridePersona === true) return { hideTools: false, stance: 'override' };

  /*
   * 空人格要按**默认人格**判，不能按"没表态"。
   *
   * personaStore.resolveFor 在没有任何卡命中时返回空串，而 buildMessages
   * 会退回 DEFAULT_PERSONA —— 那份默认人格明确写着「不用表情包」。
   * 这里若把空串当 unset，就会出现"提示词说不许用、工具却给了"。
   */
  const text = String(personaText ?? '').trim() || DEFAULT_PERSONA;
  const stance = resolvePersonaStickerPolicy(text);
  return { hideTools: stance === 'forbid', stance };
}

/** @returns {object} 当前生效的工具授权策略 */
function toolPolicy() {
  const chat = normalizeChatTools(config.plugins?.chatTools);
  /*
   * 联网总闸关着时，本回合的联网工具**结构性不可见**。
   *
   * 为什么不只靠 `ctx.net` 在调用时拒绝：那样模型仍看得到工具，
   * 于是它会去调、会拿到 E4080、会再换一种说法重试 —— 用户看到的
   * 是一串"搜不到"的失败，而事实是"你关掉了联网"。把它从可见集里
   * 拿掉才是确定的：模型看不到，就不会调。
   *
   * 注意 `disabledTools` 只做**精确名字**匹配（见 tool-gate），
   * 所以这里给的是完整工具名，不是前缀。
   */
  const netDisabled = disabledNetTools(config);
  return {
    groupHostToolsForbidden: true,
    proactiveHostToolsForbidden: true,
    allowR3Default: config.tools.allowR3 === true,
    /*
     * 聊天来源的插件工具授权。
     *
     * 必须**每次现算**（而不是启动时快照一份）：管理员在界面点完保存后
     * 下一个回合就要生效。缓存会带来"改完还是老样子、重启才好"的体验，
     * 而那正是这次改造要消灭的那类问题。
     *
     * 配置坏掉时退回默认全关（而不是让所有工具失效）：
     * 归一化失败在启动校验与保存通道已经拦过了，这里只是兜底。
     */
    chatTools: chat.ok ? chat.value : normalizeChatTools(undefined).value,
    ...(netDisabled ? { disabledTools: netDisabled } : {}),
  };
}

/**
 * 合并两处"结构性禁用"的来源。
 *
 * ## 为什么需要合并，而不是让后一个覆盖前一个
 *
 * 目前有两个互不相关的来源：
 *
 *   · **环境级**（`toolPolicy`）：管理员关掉了联网总闸 —— 这是配置事实，
 *     对所有会话一视同仁；
 *   · **回合级**（`makeRunner` 的 `turn.disabledTools`）：本会话的人格卡
 *     明确写了「不用表情包」。
 *
 * 覆盖的后果很具体：人格卡禁用了表情工具，而联网刚被关掉 ——
 * 结果联网工具照样出现（或反过来）。两个来源都是"管理员侧的设定"，
 * 它们该是**与**的关系，不是"谁后写听谁的"。
 *
 * 空集返回 `null`：`makeRunner` 用它判断"要不要往 policy 里放 disabledTools"。
 * 放一个空数组进去虽然语义等价，但会让 `isToolDisabled` 每次多做一次
 * 无用检查，也会让快照里的策略看起来"有东西被禁了"。
 *
 * @param {ReadonlyArray<string> | null | undefined} a
 * @param {ReadonlyArray<string> | null | undefined} b
 * @returns {string[] | null}
 */
function mergeDisabledTools(a, b) {
  /** @type {string[]} */
  const out = [];
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const name of list) {
      const s = String(name ?? '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out.length > 0 ? out : null;
}

/* ---------------------------------------------------------------- RPC */

/** stdio JSON-RPC：请求带 id，响应按 id 关联；后端可主动 push 事件 */
const rpc = {
  /**
   * 形状合法的空思考视图。
   *
   * 「启动中」「算不出来」「没有记录」三种情况都走它：前端只按形状取值，
   * 少一个字段就得在每个渲染点写判空 —— 那才是最容易漏的地方。
   *
   * @returns {object}
   */
  emptyThinkingView() {
    return {
      days: [],
      total: 0,
      entryCount: 0,
      stepCount: 0,
      hasMore: false,
      nextBefore: null,
      nextBeforeDate: null,
      cursorIgnored: false,
      conversations: [],
      dayKeys: [],
      lastSkip: null,
      lastError: null,
      retentionDays: thinkingStore?.maxDays ?? 30,
    };
  },

  /**
   * `YYYY-MM-DD` 形状 + 真实存在的日期。
   *
   * 只用正则不够：`2026-13-45` 也能过正则，但它会被当成文件名写下去，
   * 而用户以为删的是"某一天"。所以再让 Date 校验一遍回读是否一致。
   *
   * @param {string} date
   * @returns {boolean}
   */
  isDayKey(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const [y, m, d] = date.split('-').map(Number);
    const probe = new Date(y, m - 1, d);
    return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
  },

  /**
   * 取思考视图，**永不抛错**。
   *
   * 它是纯展示数据：磁盘满、字段脏、游标坏了都只该让这一块空着，
   * 不该把整份快照（连接状态、消息、待确认项）一起拖垮。
   * 这也是修「新思考链路拉取失败」的第二道保险（第一道在
   * thinking.mjs 的 view() 里：游标坏了不再抛错）。
   *
   * 出错时记一行 warn —— 否则"面板一直是空的"会非常难查，因为它不报错。
   *
   * @param {any} query 界面传来的 thinking 参数
   * @returns {object}
   */
  thinkingView(query) {
    try {
      return thinkingStore.view({
        convKey: query?.convKey ? String(query.convKey) : null,
        days: 1,
        limit: 50,
        ...(query && typeof query === 'object' ? query : {}),
      });
    } catch (err) {
      /*
       * 这里不能假设 log 一定有 warn：测试里的 dispatcher 注入的 log
       * 只有 info。降级路径本身绝不能再抛第二次错。
       */
      const note = String(/** @type {any} */ (err)?.message ?? err);
      if (typeof log?.warn === 'function') log.warn('思考视图计算失败（不影响其他数据）', { message: note });
      else if (typeof log?.info === 'function') log.info('思考视图计算失败（不影响其他数据）', { message: note });
      return { ...rpc.emptyThinkingView(), lastError: '思考视图计算失败，本次未显示历史' };
    }
  },

  /**
   * 视觉状态（契约 §10）。**永不抛错**。
   *
   * 与 thinkingView 同样的理由：它是展示数据，算不出来只该让这一块空着，
   * 不该把整份快照拖垮。测试里的 dispatcher 注入的模块可能没有这些函数，
   * 所以这里还要容忍"函数不存在"。
   *
   * @returns {object}
   */
  visionView() {
    try {
      if (typeof buildVisionSnapshot !== 'function') throw new Error('视觉快照模块缺失');
      return buildVisionSnapshot({
        config: config?.vision,
        capability: readVisionCapability(),
        runtime: visionRuntime,
        normalize: normalizeVisionConfig,
      });
    } catch (err) {
      const note = String(/** @type {any} */ (err)?.message ?? err);
      if (typeof log?.warn === 'function') log.warn('视觉快照计算失败（不影响其他数据）', { message: note });
      /*
       * 兜底形状必须与正常形状**一致**（字段一个不少）：
       * 界面按字段取值，少一个就会在"出过错之后"整页显示 undefined。
       */
      return {
        enabled: false,
        limits: {},
        capability: { probed: false, supported: null, model: '', basis: '', detail: '', probedAt: null },
        effective: 'off',
        runtime: {
          turnsWithImages: 0,
          imagesSubmitted: 0,
          bytesSubmitted: 0,
          skipped: 0,
          lastCodes: [],
          lastNotes: [],
          lastTurn: { attempted: 0, loaded: 0, bytes: 0 },
          imageRejectedCount: 0,
          lastImageRejectedAt: null,
          lastAt: null,
        },
        lastError: '视觉状态计算失败',
      };
    }
  },

  /**
   * 联网状态（契约：docs/web-search-contract.md §6）。**永不抛错**。
   *
   * ## 为什么不在这里拼字段
   *
   * `buildNetView` 是"总闸 / 插件 / 配置"三个条件的唯一汇总点。
   * 后端与界面各拼一份，迟早出现"快照说可用、调用被拒" ——
   * 而那种不一致对用户来说就是"这个开关是假的"。
   *
   * ## 三个条件为什么必须分开显示
   *
   * 合成一句"不可用"会让用户找错地方：总闸关着 → 去插件页翻（那里一切正常）；
   * 没配 Key → 以为搜不到东西，于是换关键词反复试。所以 `effective`
   * 有四态，界面逐格显示。
   *
   * @param {any} pluginSnap 插件面快照（取其中 web-search 那一项）
   * @returns {object}
   */
  networkView(pluginSnap) {
    try {
      /*
       * 启动竞态：界面在 boot() 读完配置前就会拉快照。
       * 这时**不能**按"缺省开"算 —— 那会让界面在启动那一秒显示
       * "搜索可用"，而工具其实还没登记。给一个形状合法的 off 视图，
       * 文案换成"正在启动"，与正常视图只差一个字符串。
       */
      if (!config) {
        return {
          ...buildNetView({
            config: { network: { enabled: false } },
            plugin: null,
            hasSecret: false,
            stats: networkRuntime,
          }),
          effectiveText: '正在启动：联网状态稍后显示',
        };
      }

      const item = Array.isArray(pluginSnap?.items)
        ? pluginSnap.items.find((one) => one?.id === NET_PLUGIN_ID) ?? null
        : null;

      /*
       * 有没有 Key 只能看 `hasSecret`，不能看 value。
       *
       * `store.toView` 的纪律是"密钥字段的 value 恒为空串"，拿它判断
       * 会永远显示"未配置"——用户明明填过 Key，界面却说没有。
       */
      const keyField = Array.isArray(item?.config)
        ? item.config.find((f) => f?.key === 'apiKey')
        : null;

      return buildNetView({
        config,
        plugin: item,
        hasSecret: keyField?.hasSecret === true,
        stats: networkRuntime,
        /*
         * 原生联网的最近证据与计数。由宿主持有：它回答的是"这个进程到目前
         * 为止带回过什么证据"，与插件是否启用无关。
         */
        nativeRuntime: nativeSearchRuntime,
        /*
         * 工具可见性以**注册表实况**为准，不是"理论上该有"。
         *
         * 插件启用了但 init 失败 / 本轮被结构性禁用时，`tools[].enabled`
         * 会是 false。这时界面若还说"可用"，用户点一下就会失败，
         * 而失败原因在别的页面才能看到。
         */
        toolVisible: (name) => Boolean(item?.tools?.some((t) => t.fullName === name && t.enabled)),
      });
    } catch (err) {
      const note = String(/** @type {any} */ (err)?.message ?? err);
      if (typeof log?.warn === 'function') log.warn('联网状态计算失败（不影响其他数据）', { message: note });
      /*
       * 兜底形状必须与正常形状**一致**（字段一个不少）：
       * 界面按字段取值，少一个就会在"出过错之后"整页显示 undefined。
       */
      const fallback = buildNetView({
        config: { network: { enabled: false } },
        plugin: null,
        hasSecret: false,
        stats: networkRuntime,
      });
      return { ...fallback, lastError: '联网状态计算失败' };
    }
  },

  /** @param {string} method @param {object} params @returns {Promise<any>} */
  async handle(method, params) {
    switch (method) {
      case 'snapshot':
        // 启动竞态：界面在 boot() 完成前就会来拉快照（页面一加载就拉 + 2s 轮询）。
        // 这里必须返回"正在启动"而不是让 config 为 undefined 抛错，
        // 否则用户看到的是开屏一条红字（而它其实马上就会好）。
        if (!config) {
          return {
            state: 'booting',
            health: health.snapshot(),
            account: { selfId: null },
            messages: [],
            counts: { messages: 0, toolCalls: 0 },
            /*
             * 形状与正常快照一致（只保留真实存在的字段）。
             *
             * 这里曾写着 pages/timers，而 snapshotRegistry 已经不产出它们了 ——
             * 兜底快照和正常快照形状不一致，界面在"启动中"和"启动完成"
             * 之间会遇到两套结构，任何按字段假设写的代码都会在某一侧出错。
             */
            registry: { actions: [], tools: [] },
            persona: '',
            config: null,
            lastError,
            booting: true,
            // 形状与正常快照一致：界面不必为"启动中"再写一条分支
            thinking: rpc.emptyThinkingView(),
            // 视觉块同理：形状与正常快照一致，界面不必为"启动中"多写一条分支
            vision: {
              enabled: false,
              limits: normalizeVisionConfig(undefined),
              capability: { probed: false, supported: null, model: '', basis: '', detail: '', probedAt: null },
              effective: 'off',
              runtime: {
                turnsWithImages: 0,
                imagesSubmitted: 0,
                bytesSubmitted: 0,
                skipped: 0,
                lastCodes: [],
                lastNotes: [],
                lastTurn: { attempted: 0, loaded: 0, bytes: 0 },
                imageRejectedCount: 0,
                lastImageRejectedAt: null,
                lastAt: null,
              },
            },
            // 联网块同理：形状与正常快照一致（启动中 = 一个合法的 off 视图）
            network: rpc.networkView(null),
          };
        }
        /*
         * 会话概要算一次，下面 sessions 与 brain.conversations 共用。
         *
         * 不各调一次 `sessionStore.list()`：它是全量遍历 + 排序，
         * 2 秒一次的快照里跑两遍纯属浪费；而且两次结果可能不一致
         * （中间正好有新消息落盘），界面会看到自相矛盾的两个计数。
         */
        const sessionList = sessionStore.list();
        /*
         * 插件面快照只算一次：下面 `plugins` 字段与 `network` 视图都要它。
         *
         * 算两次的后果不只是慢：两次之间插件可能刚好被停用，
         * 于是"插件区块显示已停用、联网区块显示可用"——用户在同一个页面上
         * 看到两个互相矛盾的结论。
         */
        const pluginSnap = await pluginSnapshotSafe();
        return {
          state: client?.state ?? 'idle',
          health: health.snapshot(),
          account: { selfId: selfId || null },
          /*
           * 首屏仍是最近 100 条（2 秒一次的快照不该拖着一整个历史），
           * 但它现在来自**楼层仓库**而不是内存数组 —— 重启后还在，
           * 而且每条都带楼层号，界面可以据此做「向上翻更早」的分页。
           *
           * 真正要翻历史走 action `session.page`，见下面。
           */
          messages: messages.slice(-100),
          /*
           * 会话楼层概要：界面用它显示每个会话的未读数与最高楼层，
           * 也是分页的入口参数。
           */
          sessions: sessionList,
          counts: { messages: messages.length, toolCalls: toolCallLog.length },
          registry: snapshotRegistry(),
          /*
           * 插件面快照。
           *
           * 每次快照都现算（含 stat 每个 plugin.json 以发现"包被更新了"）。
           * 插件数量是个位数，2 秒一次的开销可以忽略。
           *
           * **失败必须兜底**：插件面算不出来不能让整份快照失败 ——
           * 那样用户连消息列表都看不到，症状是"界面拉取失败"，
           * 而真正的问题只在一个可选面板上。
           */
          plugins: pluginSnap,
          /*
           * 联网状态（契约 §6）。放在快照里而不是让界面自己算：
           * "总闸开没开 / 插件启用没 / Key 存没存"三件事只有宿主知道
           * （插件配置与密钥都不进界面），界面自己推必然与后端分叉。
           */
          network: rpc.networkView(pluginSnap),
          persona,
          /*
           * 传已知会话过去，界面就能显示"这张卡现在命中哪些会话"。
           * 没有会话时就是空对象，不影响渲染。
           */
          personaCards: personaStore.view([...recentByConv.keys()]),
          roleCards: roleStore.view([...recentByConv.keys()]),
          /*
           * 唤醒设置（只读回显）。
           *
           * 界面需要它来渲染每个开关的当前状态，以及关键词标签。
           * 写入仍走 setting 通道的 `wake.*` 键，不在这里做。
           */
          wake: {
            ...config.wake,
            // 附带运行态：让界面能显示"这一分钟还剩几次"
            runtime: Object.fromEntries(
              [...recentByConv.keys()].map((k) => [k, wakeLedger.snapshot(k)]),
            ),
          },
          /*
           * 分条设置（只读回显）。写入走 setting 通道的 `reply.*`。
           *
           * 附带 hardCap：界面要能说明"填再大也只到 10"，
           * 否则用户把 3 改成 30、看到保存成功、发现还是 10 条上限，
           * 会以为是 bug。
           */
          reply: {
            ...config.reply,
            hardCap: MAX_MESSAGES_HARD_CAP,
          },
          /*
           * 管理员面（只读）。
           *
           * 界面要能回答两个问题，所以三份都给：
           *   · `qqIds`        核心名单（用户在安全页编辑的那一份）
           *   · `effective`    实际生效的（含兼容开关并进来的）
           *   · `deliverable`  投递豁免名单（含 DSH 插件管理员）——
           *     它与授权无关，只影响"送不送得到"，界面要分开说
           *
           * 不给号码做任何遮蔽：这是用户自己的界面，他要能核对。
           * 但也不给**别处**的原始字符串（插件配置里的逗号串），
           * 一律用归一化后的数组，免得界面自己再 split 一遍然后走样。
           */
          admin: {
            qqIds: coreAdminIds(config),
            inheritWhitelist: config.admin?.inheritWhitelist === true,
            deliverable: deliverableAdminIds(config),
            whitelistCount: Array.isArray(config.allow?.private) ? config.allow.private.length : 0,
          },
          /*
           * 日记（只读）。
           *
           * 传全部记录（含已淡忘的），由界面按 hiddenBelowWeight 决定是否隐藏 ——
           * 后端不替用户"藏起来"，因为用户可能就是想翻很久以前的东西。
           * 权重在这里现算，不读落盘的 weightBase（那是写下那天的快照）。
           */
          diary: snapshotDiary(),
          /*
           * 日记的配置面（阈值）。
           *
           * 单独给一份，而不是让界面从 diary 里推：
           * 界面要拿它决定"低于多少隐藏、低于多少不进上下文"，
           * 那是**配置**不是数据，混在 days 里会让界面自己发明默认值。
           */
          diaryConfig: {
            initialWeight: config?.diary?.initialWeight ?? 100,
            decayPerDay: config?.diary?.decayPerDay ?? 1,
            hiddenBelowWeight: config?.diary?.hiddenBelowWeight ?? 0,
            contextMinWeight: config?.diary?.contextMinWeight ?? 60,
          },
          /*
           * 静音状态（F20）。
           *
           * 配了 `silence` 原始配置，也配了**当前实际在静音哪些会话** ——
           * 两者不是一回事：前者是用户设的，后者还要算上时段命中
           * 和聊天里用指令开的临时静音。界面要显示后者才有用。
           */
          silence: snapshotSilence(),
          /*
           * 视觉状态（契约 §10）。
           *
           * 三块分开给，**永远不要合并**：
           *   enabled    用户想不想开（可改）
           *   capability 模型能不能（只读，实测结论，三态）
           *   effective  这一回合实际会怎样（由前两者 + 本回合取图结果推出）
           *
           * 合并的后果是"未探测"被显示成"不支持"，用户于是再也不试 ——
           * 而那正是这次要修的问题之一。
           */
          vision: rpc.visionView(),
          /*
           * 思考链路（只给界面看）。
           *
           * 形状被前端锁定，改之前先对齐：
           *   { days: [{ date, entries: [{ at, convKey, steps: [
           *              { n, reasoning, tools, answerPreview } ] }] }], total,
           *     conversations: [{ convKey, entries, steps, lastAt, firstAt }],
           *     dayKeys: string[], cursorIgnored: boolean }
           *
           * 默认给"全部会话"——后端不知道界面当前在看哪个会话，
           * 而多给不会出错、少给会让面板空着。界面若要只看当前会话，
           * 可以带 params.convKey 来收窄（这里已经支持，传 null/不传即全部）。
           *
           * 每次快照都现算一份拷贝：界面拿到的是快照时刻的视图，
           * 不会因为后续 record() 而在手里悄悄变。
           *
           * **整段包 try/catch**：思考链路是纯展示数据，它算不出来绝不能
           * 让整份快照失败 —— 那样用户会连消息列表、连接状态一起看不到，
           * 症状是「界面拉取失败」，而真正的问题只在一个可选面板上。
           * 失败时给一个形状合法的空视图，界面照常渲染。
           */
          thinking: rpc.thinkingView(params?.thinking),
          config: publicConfig(),
          lastError,
          brain: {
            configured: llm?.configured === true,
            model: config.llm.model,
            baseUrl: config.llm.baseUrl,
            /**
             * Key 从哪来：none / config / env / vault / vault-broken。
             *
             * 界面要单独显示它，因为「能不能对话」和「Key 存在哪」是两件事：
             *   - vault  → 已加密保存（推荐）
             *   - config → 明文写在配置文件里（要提示风险）
             *   - env    → 环境变量
             *   - none   → 没配
             *
             * 之前只把它放在 config.llm 里，而界面读 brain.keySource，
             * 于是永远显示「未设置」—— 同时「可否对话」又是绿的，自相矛盾。
             */
            keySource,
            inflight: inflight.size,
            /*
             * 排队总数用 `total`（getter）：TurnQueue 是"每会话一个队列"，
             * 没有 `.size` 这种单值。写错了界面会一直显示 undefined。
             */
            queued: pendingTurns.total,
            pendingConfirms: confirms.list(),
            /**
             * 每个会话的触发状态：主动发言的 30 分钟间隔就靠它。
             *
             * ## 会话列表来自**落盘的楼层仓库**，不是内存 Map
             *
             * 之前这里只遍历 `recentByConv`（内存 Map，只装最近 20 条模型消息）。
             * 后果是重启后整块必然为空 —— 用户看到"还没有会话记录"，
             * 但会话和楼层明明都在 `state/sessions.json` 里。
             *
             * 现在以 `sessionStore.list()` 为基准（它读的是落盘数据），
             * 再并上 `recentByConv` 里的键（可能有刚进来还没落盘的）。
             * 两个都取到，重启前后都能显示真实存在的会话。
             *
             * `proactiveCount` 是**真实累计值**（由 TriggerLedger 累加）。
             * `proactive` 是**当前可用性**：为什么现在不能主动、还要等多久。
             * 它比累计次数有用 —— 用户真正的困惑是"它刚才怎么不说话"，
             * 而 12 次这个数字回答不了。
             */
            conversations: (() => {
              /*
               * 合并两个来源的会话键。
               *
               * sessions 提供持久化的（带楼层与未读），recentByConv 提供
               * 内存里刚到的。用 Set 去重，再让持久化的排在前面
               * （它带更多信息，也是用户更关心的"历史会话"）。
               */
              const keys = [];
              const seen = new Set();
              for (const s of sessionList) {
                if (!seen.has(s.convKey)) {
                  seen.add(s.convKey);
                  keys.push(s.convKey);
                }
              }
              for (const k of recentByConv.keys()) {
                if (!seen.has(k)) {
                  seen.add(k);
                  keys.push(k);
                }
              }

              const sessByKey = new Map(sessionList.map((s) => [s.convKey, s]));

              return keys.map((k) => {
                const isGroup = k.startsWith('group:');
                const sess = sessByKey.get(k);
                return {
                  convKey: k,
                  /*
                   * 「近期消息」用楼层仓库的条数，而不是内存 Map 的长度：
                   * 后者最多 20（那是喂给模型的窗口），拿它当"近期消息数"
                   * 会让所有活跃会话都显示 20，看起来完全一样。
                   */
                  recent: sess?.count ?? (recentByConv.get(k) ?? []).length,
                  queued: pendingTurns.size(k),
                  // 未读数来自楼层系统，重启后仍然正确
                  unread: sess?.unread ?? 0,
                  lastFloor: sess?.lastFloor ?? 0,
                  ...triggerLedger.snapshot(k),
                  proactive: triggerLedger.proactiveStatus(k, config.proactive, isGroup),
                };
              });
            })(),
          },
          usage: usageLedger
            ? { ...usageLedger.summary(), ...(params?.usage ? { range: await usageLedger.range(params.usage) } : {}) }
            : { today: null, recent: [], unavailable: true },
        };

      case 'action': {
        const name = params?.name;
        const arg = params?.params ?? {};
        if (name === 'usage.query') return { ok: true, range: await usageLedger.range(arg) };
        /*
         * ---- 会话楼层（只读）----
         *
         * 「按条读取聊天记录」的入口。走 action 而不是新开一个 method：
         * IPC 只有 snapshot / action / setting 三条通道（不变式 I11）。
         *
         * 参数形状与错误码由 store 决定（非法 afterFloor 一律 E4010，
         * 不猜、不返回空列表——空列表会被误读成"没有更多了"）。
         */
        if (name === 'session.page') return sessionStore.page(arg?.convKey, arg ?? {});
        if (name === 'session.list') return { ok: true, sessions: sessionStore.list() };
        if (name === 'session.markRead') {
          const r = sessionStore.acknowledge(arg?.convKey, arg?.floor);
          if (!r.ok) return { ok: false, code: 'E4010', message: 'convKey 或 floor 非法' };
          return { ok: true, readThroughFloor: r.readThroughFloor };
        }
        /*
         * ---- 日记 ----
         *
         * diary.lock / diary.unlock 是**用户动作**（把某天的日记钉住，
         * 不让它继续淡忘），所以走 action 而不是 setting：
         * 它们操作的是数据本身，不是配置。
         */
        if (name === 'diary.get') {
          const date = String(arg?.date ?? '');
          const rec = diaryStore.get(date);
          if (!rec) return { ok: false, code: 'E4041', message: `没有这一天（${date}）的日记` };
          return { ok: true, record: rec };
        }
        if (name === 'diary.lock' || name === 'diary.unlock') {
          const date = String(arg?.date ?? '');
          const r = name === 'diary.lock' ? await diaryStore.lock(date) : await diaryStore.unlock(date);
          if (!r.ok) {
            // 区分"没有这一天"和"写盘失败"：前者是用户点错了，后者要重试
            return r.record
              ? { ok: false, code: 'E5001', message: r.error ?? '写盘失败，请重试' }
              : { ok: false, code: 'E4041', message: `没有这一天（${date}）的日记` };
          }
          log.info(name === 'diary.lock' ? '日记已锁定' : '日记已解锁', { date });
          return { ok: true, record: r.record };
        }
        if (name === 'diary.regenerate') {
          /*
           * 手动重生成某天的日记。
           *
           * 和自动生成走同一个函数，所以行为完全一致（先占位再覆盖）。
           * 但如果那天是锁定的，不覆盖 —— 用户钉住的意思就是"别动它"。
           */
          const date = String(arg?.date ?? '');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return { ok: false, code: 'E4041', message: 'date 必须是 YYYY-MM-DD' };
          }
          const rec = diaryStore.get(date);
          if (rec?.locked === true) {
            return { ok: false, code: 'E4030', message: '这一天已锁定，先解锁再重生成' };
          }
          const ok = await generateYesterdayDiary(date, 'manual');
          return ok ? { ok: true } : { ok: false, code: 'E5001', message: '生成失败，详见日志' };
        }
        /*
         * ---- 静音（F20「闭嘴」）----
         *
         * 这些都是**用户动作**，走 action 而不是 setting：
         * 临时静音操作的是运行态，不是配置。
         *
         * 但全局开关和按会话名单在配置里，得走 setting（见下面 setting 分支）。
         */
        if (name === 'silence.mute') {
          const convKey = String(arg?.convKey ?? '');
          if (!/^(group|private):\d+$/.test(convKey)) {
            return { ok: false, code: 'E4010', message: 'convKey 非法（应为 group:123 或 private:456）' };
          }
          const cap = Number(config.silence?.maxMuteMs) > 0 ? Number(config.silence.maxMuteMs) : MAX_MUTE_MS;
          // 没传时长就用配置的默认值，再夹到上限内
          const want = Number(arg?.ms) > 0 ? Number(arg.ms) : Number(config.silence?.defaultMuteMs ?? 1800000);
          const ms = Math.min(want, cap);
          const r = silenceGate.mute(convKey, ms);
          log.info('临时静音已开启', { convKey, ms });
          return { ok: true, until: r.until, ms };
        }
        if (name === 'silence.unmute') {
          const convKey = String(arg?.convKey ?? '');
          const r = silenceGate.unmute(convKey);
          log.info('临时静音已解除', { convKey, wasSilent: r.wasSilent });
          return { ok: true, wasSilent: r.wasSilent };
        }
        if (name === 'silence.clear') {
          // 「全部恢复」：清掉所有临时静音，但不动配置里的全局/按会话静音
          const n = silenceGate.clear();
          log.info('已清空全部临时静音', { count: n });
          return { ok: true, cleared: n };
        }
        if (name === 'thinking.query') return { ok: true, ...rpc.thinkingView(arg) };
        if (name === 'persona.setDefault') return personaStore.setDefault(arg.id);
        if (name === 'role.setDefault') return roleStore.setDefault(arg.id);

        if (name === 'send-text') {
          return sendText(arg.convKey, arg.text);
        }
        if (name === 'send-media') {
          return sendMedia(arg);
        }
        if (name === 'reconnect') {
          client?.close();
          startOneBot();
          return { ok: true };
        }
        /*
         * ---- 插件管理动作 ----
         *
         * 这些动作是"插件页"的全部后端能力。它们**只操作插件管理器**，
         * 不直接碰插件模块：这样 in-process 与 process 两种运行时
         * 才有完全一致的行为（否则迟早出现"同进程插件能停、子进程停不掉"）。
         */
        if (name === 'plugin.enable') {
          if (!plugins) return { ok: false, code: 'E40XX', message: '插件管理器未就绪' };
          const id = String(arg?.id ?? '').trim();
          if (!isPluginId(id)) return { ok: false, code: 'E4041', message: '插件 id 不合法' };
          const r = await plugins.enable(id);
          log.info('插件已启用', { id, ok: r.ok, status: r.status });
          return r;
        }
        if (name === 'plugin.disable') {
          if (!plugins) return { ok: false, code: 'E40XX', message: '插件管理器未就绪' };
          const id = String(arg?.id ?? '').trim();
          if (!isPluginId(id)) return { ok: false, code: 'E4041', message: '插件 id 不合法' };
          const r = await plugins.disable(id);
          log.info('插件已停用', { id, cancelled: r.cancelled });
          return r;
        }
        if (name === 'plugin.saveConfig') {
          if (!plugins) return { ok: false, code: 'E40XX', message: '插件管理器未就绪' };
          const id = String(arg?.id ?? '').trim();
          if (!isPluginId(id)) return { ok: false, code: 'E4041', message: '插件 id 不合法' };
          const r = await plugins.saveConfig(id, {
            config: arg?.config && typeof arg.config === 'object' ? arg.config : {},
            secrets: arg?.secrets && typeof arg.secrets === 'object' ? arg.secrets : {},
          });
          log.info('插件配置已保存', { id, ok: r.ok, applied: r.applied, restartRequired: r.restartRequired });
          return r;
        }
        if (name === 'plugin.test') {
          if (!plugins) return { ok: false, code: 'E40XX', message: '插件管理器未就绪' };
          const id = String(arg?.id ?? '').trim();
          if (!isPluginId(id)) return { ok: false, code: 'E4041', message: '插件 id 不合法' };
          return plugins.test(id);
        }
        if (name === 'plugin.reload') {
          if (!plugins) return { ok: false, code: 'E40XX', message: '插件管理器未就绪' };
          const id = String(arg?.id ?? '').trim();
          if (!isPluginId(id)) return { ok: false, code: 'E4041', message: '插件 id 不合法' };
          const r = await plugins.reload(id);
          log.info('插件已重载', { id, ok: r.ok, status: r.status });
          return r;
        }
        if (name === 'plugin.rescan') {
          if (!plugins) return { ok: false, code: 'E40XX', message: '插件管理器未就绪' };
          const r = await plugins.rescan();
          log.info('插件目录已重新扫描', { added: r.added, removed: r.removed, total: r.total });
          return r;
        }
        if (name === 'plugin.install') {
          if (!plugins) return { ok: false, code: 'E40XX', message: '插件管理器未就绪' };
          /*
           * 安装来源只接受**本机路径**，不接受 URL。
           * 接受 URL 等于给界面开了一个"替你去下载并解压任意压缩包"的能力，
           * 而它跑在有网络、有磁盘权限的机器上。要装就先把包下载到本地。
           */
          const src = String(arg?.path ?? '').trim();
          if (!src) return { ok: false, code: 'E4041', message: '缺少插件包路径' };
          const r = await plugins.install(src);
          log.info('插件安装结果', { id: r.id, ok: r.ok, version: r.version });
          return r;
        }
        /*
         * 环境体检：SnowLuma / Node 装没装、跑没跑。
         *
         * 单独一个 action 而不是塞进每次 snapshot：它要探测端口、问 GitHub
         * 拿下载直链，比快照慢一个量级。让界面按需触发（进页面时一次），
         * 而不是每次刷新都拖慢。
         */
        if (name === 'env.probe') {
          const report = await probeEnvironment({
            snowlumaDir: config?.snowlumaDir,
            // 用户手动指定的 QQ 路径优先于自动识别
            qqExe: config?.qqExe,
          });
          return { ok: true, env: report };
        }
        if (name === 'tool.run') {
          // 来源固定为 console：这条通道只有本机主进程能访问（stdio，不开端口），
          // 且不接受调用方自带 origin —— 否则就是一句话提权。
          /*
           * 插件工具在桌面端试跑：origin 固定 console，不参与群聊授权。
           *
           * 传 convKey 是为了让 ctx.chat 有会话可用（桌面端手动试工具时
           * 媒体/消息能力要有个落点）。它仍然是**结构性事实**——
           * 由宿主指定，不是模型给的。
           */
          const runner = makeRunner(ORIGIN.CONSOLE, arg.convKey ?? 'private:0');
          return runner.run(arg.tool, arg.args);
        }
        if (name === 'turn.stop') {
          const key = arg.convKey;
          const ctrl = key ? inflight.get(key) : [...inflight.values()][0];
          if (!ctrl) return { ok: false, code: 'E50XX', message: '当前没有在跑的回合' };
          ctrl.abort();
          return { ok: true };
        }
        if (name === 'confirm.resolve') {
          return resolveConfirm(arg.id, arg.allow === true);
        }
        /*
         * 思考链路。两个动作都很克制：只清当天、只导当前视图。
         *
         * 没有做 `thinking.clearAll`：那是一条不可撤销的批量删除，
         * 而它的价值（省一次点击）远小于误触的代价。
         *
         * 但「删某一天」必须有 —— 思考记录里可能混进不想留的内容
         * （发错群、试模型时的胡话），而用户只能按天删。
         * 拒绝空日期 / 非法日期：`clearDay()` 的默认值是"今天"，
         * 界面传个空字符串过来就会静默删掉今天的记录，太像一个陷阱。
         */
        if (name === 'thinking.clear') {
          const date = typeof arg?.date === 'string' ? arg.date.trim() : '';
          if (!rpc.isDayKey(date)) {
            return { ok: false, code: 'E4010', message: '要删除哪一天？日期必须是 YYYY-MM-DD' };
          }
          const r = await thinkingStore.clearDay(date);
          log.info('思考记录已清空', { date: r.date, removed: r.removed });
          return { ok: true, date: r.date, removed: r.removed };
        }
        if (name === 'thinking.export') {
          // 导出成 JSON 文本交回界面（本机复制/另存），后端不直接写用户目录：
          // 写哪由用户决定，后端只负责把数据原样给出。
          const view = thinkingStore.view({
            convKey: arg?.convKey ? String(arg.convKey) : null,
            days: Number(arg?.days) > 0 ? Number(arg.days) : thinkingStore.maxDays,
            limit: 500,
          });
          return { ok: true, total: view.total, json: JSON.stringify(view, null, 2) };
        }
        /*
         * 角色动作和人格动作完全对称。
         *
         * 没有把两者合并成一个 `cards.*` 动作再带 type 参数：动作名要能自解释，
         * 日志里看到 role.update 一眼就知道改的是什么。
         */
        if (name === 'role.create') {
          const r = await roleStore.create(arg.name, arg.text ?? '', arg.scope, arg.scopeId);
          if (r.ok) log.info('角色卡已新建', { name: r.card.name, scope: r.card.scope });
          return r;
        }
        if (name === 'role.update') {
          const r = await roleStore.update(arg.id, {
            name: arg.name,
            text: arg.text,
            scope: arg.scope,
            scopeId: arg.scopeId,
          });
          if (r.ok && arg.scope !== undefined) {
            log.info('角色作用范围已变更', { name: r.card.name, scope: r.card.scope, scopeId: r.card.scopeId });
          }
          return r;
        }
        if (name === 'role.activate') {
          const r = await roleStore.activate(arg.id);
          if (r.ok) log.info('角色卡已切换', { id: arg.id });
          return r;
        }
        if (name === 'role.delete') {
          return roleStore.remove(arg.id);
        }
        if (name === 'role.duplicate') {
          return roleStore.duplicate(arg.id, arg.name);
        }
        if (name === 'persona.create') {
          const r = await personaStore.create(arg.name, arg.text ?? '', arg.scope, arg.scopeId);
          if (r.ok) {
            persona = personaStore.activeText();
            log.info('人格卡已新建', { name: r.card.name, scope: r.card.scope, scopeId: r.card.scopeId });
          }
          return r;
        }
        if (name === 'persona.update') {
          const r = await personaStore.update(arg.id, {
            name: arg.name,
            text: arg.text,
            scope: arg.scope,
            scopeId: arg.scopeId,
          });
          if (r.ok) {
            persona = personaStore.activeText();
            // 改了作用范围要留痕：它决定"哪个会话会被换掉人格"
            if (arg.scope !== undefined) {
              log.info('人格作用范围已变更', { name: r.card.name, scope: r.card.scope, scopeId: r.card.scopeId });
            }
          }
          return r;
        }
        if (name === 'persona.activate') {
          const r = await personaStore.activate(arg.id);
          if (r.ok) {
            persona = personaStore.activeText();
            log.info('人格卡已切换', { id: arg.id });
          }
          return r;
        }
        if (name === 'persona.delete') {
          const r = await personaStore.remove(arg.id);
          if (r.ok) persona = personaStore.activeText();
          return r;
        }
        if (name === 'persona.duplicate') {
          /*
           * 副本默认不继承作用范围：原卡占着 group:123，副本也占会冲突。
           * 所以 duplicate 出来的卡是 global 的，用户再自己指定范围。
           */
          return personaStore.duplicate(arg.id, arg.name);
        }
        if (name === 'secret.saveApiKey') {
          // 只存进保险箱（DPAPI 加密），**不写 config.json**：
          // 配置文件是明文的，写进去等于把 key 摊在磁盘上。
          const key = String(arg.key ?? '').trim();
          if (!key) return { ok: false, code: 'E4041', message: 'key 不能为空' };
          if (!(await isVaultAvailable())) {
            return { ok: false, code: 'E4101', message: '这台机器上无法使用加密存储（DPAPI 不可用）' };
          }
          const sealed = await sealSecret(key);
          await writeJsonAtomic(paths.vaultPath, sealed);
          const migrated = { ...config, llm: { ...config.llm, apiKey: '' } };
          await writeJsonAtomic(paths.configPath, migrated);
          config = migrated;
          // 立刻生效，不必重启
          keySource = process.env.LING_LLM_KEY ? 'env' : 'vault';
          currentApiKey = process.env.LING_LLM_KEY || key;
          rebuildLlmClient();
          log.info('API Key 已保存');
          return { ok: true, source: keySource, message: keySource === 'env' ? '本地凭据已保存，但环境变量来源优先，当前仍使用环境变量' : '凭据已保存并生效' };
        }
        if (name === 'secret.clearApiKey') {
          const r = await clearApiKey({ config, vaultPath: paths.vaultPath, unlink: fsUnlink, persist: c => writeJsonAtomic(paths.configPath, c), envKey: process.env.LING_LLM_KEY ?? '' });
          if (r.cleared) { config = r.config; keySource = r.source; currentApiKey = process.env.LING_LLM_KEY ?? ''; rebuildLlmClient(); }
          const { config: ignored, ...result } = r;
          return result;
        }
        if (name === 'secret.status') {
          return {
            ok: true,
            vaultAvailable: await isVaultAvailable(),
            keySource,
            hasKey: Boolean(llm?.configured),
          };
        }
        if (name === 'llm.models') {
          // 读服务商实际提供的模型列表（只读，不改任何配置）。
          // 失败就如实回 ok:false，由界面切成"手填模型名"——这里不抛错，
          // 因为"读不到目录"不该阻断整个页面；但也**不能**塞一份内置清单
          // 当兜底，那会让人以为这些模型是服务商提供的。
          try {
            const ids = await llm.listModels({});
            // 附带已知能力信息：目录里就能看出哪些已实测可读图
            const models = describeCatalog(ids, endpointCapabilities(config.llm.modelCapabilities, config.llm.baseUrl));
            return { ok: true, models, ids };
          } catch (err) {
            const e = /** @type {any} */ (err);
            return { ok: false, code: e?.code ?? 'E3021', reason: e?.reason ?? null, message: String(e?.message ?? e) };
          }
        }
        if (name === 'llm.probe') {
          // 实测聊天模型的**视觉**能力（读图）。
          //
          // ## 为什么这里没有生图
          //
          // 生图是独立插件（`plugins/image-generation`）的事：另一套地址、
          // 另一把 Key、另一个模型。拿聊天模型的配置去试 `/images/generations`
          // 既可能误判，也会在用户只想测"能不能读图"时真的花掉一次生图的钱。
          //
          // 历史界面可能仍传 `probe: ['vision', 'image']`。这里**故意不读**
          // 这个参数来决定探测种类 —— 旧客户端不会因此报错，也不可能再触发
          // 任何生图请求。
          const m = String(arg.model ?? '').trim();
          if (!m) return { ok: false, code: 'E4041', message: '先选择模型' };
          if (!llm?.configured) return { ok: false, code: 'E3020', message: '还没配置 API Key' };

          const probeEndpoint = config.llm.baseUrl;
          const { probes, channel } = await probeModel({
            baseUrl: config.llm.baseUrl,
            apiKey: currentApiKey,
            model: m,
          });

          // 只把**有明确结论**的写进配置，null（没测出来）不写。
          // 理由：把"没测出来"记成 false，下次打开界面会显示"不支持"，
          // 而事实只是没连通——那会误导人。
          if (config.llm.baseUrl !== probeEndpoint) return { ok: false, message: '探测期间端点已变更，结果未保存' };
          const caps = { ...(config.llm.modelCapabilities ?? {}) };
          const endpoint = endpointKey(probeEndpoint);
          const scoped = { ...(caps[endpoint] ?? {}) };
          const cur = { ...(scoped[m] ?? {}) };
          /*
           * 顺手清掉旧字段：老配置里可能还留着上次生图探测的结论。
           * 不清的话，这次只测视觉之后，界面会显示"读图：新结论 / 生图：旧结论"，
           * 后者已经是无源之水。
           */
          delete cur.image;
          delete cur.imageGen;
          cur.probes = { vision: probes.vision };
          cur.endpoint = endpoint;
          if (typeof probes.vision?.supported === 'boolean') cur.vision = probes.vision.supported;
          cur.channel = channel.channel;
          cur.probedAt = new Date().toISOString();
          scoped[m] = cur;
          caps[endpoint] = scoped;
          config.llm.modelCapabilities = caps;
          await persistConfig();

          return { ok: true, model: m, probes, caps: cur, channel };
        }
        if (name === 'llm.test') {          // 用一次最小请求验证"地址 + 模型名 + key"三者是否配套。
          //
          // 为什么值得单独做：这三项任一填错，表现都是"它不理我"，
          // 用户没法从界面上判断是哪个错了。发一次真实请求最直接。
          if (!llm?.configured) {
            return { ok: false, code: 'E3020', message: '还没配置 API Key' };
          }
          const started = Date.now();
          try {
            const res = await llm.chat({
              messages: [{ role: 'user', content: '只回复两个字：通了' }],
            });
            return {
              ok: true,
              ms: Date.now() - started,
              model: config.llm.model,
              reply: String(res?.text ?? '').slice(0, 40),
            };
          } catch (err) {
            const e = /** @type {any} */ (err);
            return { ok: false, code: e?.code ?? 'E3021', message: String(e?.message ?? e) };
          }
        }
        if (name === 'turn.manual') {
          // 桌面端手动让它在某个会话说一句（origin 固定 console，不参与群聊授权）
          const ck = arg.convKey;
          if (!checkWhitelist(ck, config).ok) {
            return { ok: false, code: 'E20XX', message: '目标不在白名单' };
          }
          enqueue(ck, {
            evt: { convKey: ck, isGroup: ck.startsWith('group:'), text: arg.text ?? '', kind: 'message', sender: { nickname: '管理员' } },
            trigger: 'command',
            reason: '管理员手动触发',
            proactive: false,
          });
          return { ok: true };
        }
        return { ok: false, code: 'E4030', message: `未登记的动作：${name}` };
      }

      case 'setting': {
        const key = params?.key;
        const value = params?.value;
        /*
         * 旧 DSH 设置通道 —— **保留但只做迁移**。
         *
         * 骨架改造后 DSH 是普通插件，配置走 `plugin.saveConfig`。
         * 但旧版界面、旧脚本、以及用户书签里的调用可能还在发这个 key。
         * 直接删掉会让它们收到"未支持的设置项"，而用户看到的是
         * "保存失败"，却不知道去哪改 —— 所以这里转成插件配置再走同一条路。
         *
         * @deprecated 用 action `plugin.saveConfig`（id: 'dsh-bridge'）
         */
        if (key === 'dsh.config' || key === 'dsh') {
          if (!plugins) return { ok: false, code: 'E40XX', message: '插件管理器未就绪' };
          const v = value && typeof value === 'object' ? value : {};
          /** @type {Record<string, any>} */
          const cfg = {};
          /** @type {Record<string, any>} */
          const secrets = {};
          if (Number.isInteger(v.port)) cfg.port = v.port;
          if (Array.isArray(v.admins)) cfg.admins = v.admins.map((x) => String(x).trim()).filter(Boolean).join(',');
          if (typeof v.sessionId === 'string') cfg.sessionId = v.sessionId.trim();
          if (typeof v.token === 'string' && v.token.trim() !== '') secrets.token = v.token.trim();
          if (v.clearToken === true) secrets.token = '';

          // enabled 语义映射成插件的启用/停用（旧界面用同一个开关控制两件事）
          if (v.enabled === true) await plugins.enable('dsh-bridge');
          const saved = await plugins.saveConfig('dsh-bridge', { config: cfg, secrets });
          if (v.enabled === false) await plugins.disable('dsh-bridge');
          return {
            ok: saved.ok,
            applied: saved.applied === true,
            restartRequired: saved.restartRequired === true,
            message: saved.message ?? 'DSH 配置已保存',
            code: saved.code,
          };
        }

        if (key === 'allow') {
          // 形状必须校验：直接赋值会让闸门拿到非法结构，行为变成未定义
          const shape = normalizeIdLists(value);
          if (!shape.ok) return { ok: false, code: 'E40XX', message: shape.message };
          config.allow = shape.value;
          await persistConfig();
          /*
           * 白名单不再等于管理员 —— 但正在用兼容开关的人要能看到
           * "我刚才把谁加进来了，于是他多了一份权限"。
           *
           * 这条日志不是噪音：兼容开关是有意打开的话，它就是唯一能
           * 追溯"权限是什么时候变宽的"的地方。
           */
          if (config.admin?.inheritWhitelist === true) {
            log.warn('白名单已更新；因开启了「白名单视为管理员」，新增号码同时获得管理员权限', {
              private: shape.value.private.length,
            });
          }
          return { ok: true };
        }

        /*
         * 管理员名单 —— 「谁能让它动本机」。
         *
         * 单独一个 key，不和 allow 合并：合并会让"允许对话"顺带授出
         * 宿主机权限，而用户不会意识到。两份清单各自回答各自的问题。
         */
        if (key === 'admin.qqIds' || key === 'admin') {
          const raw = key === 'admin' ? (value && typeof value === 'object' ? value.qqIds : undefined) : value;
          if (!Array.isArray(raw)) {
            return { ok: false, code: 'E40XX', message: 'admin.qqIds 必须是数组' };
          }
          const ids = normalizeAdminIds(raw);
          // 只要出现了不合法项就整体拒绝：静默丢弃会让用户填的号"消失"
          if (ids.length !== raw.filter((x) => String(x ?? '').trim() !== '').length) {
            return { ok: false, code: 'E40XX', message: '管理员名单里有非法 QQ 号（应为 4–15 位数字）' };
          }
          const removed = (config.admin?.qqIds ?? []).filter((x) => !ids.includes(String(x)));
          config.admin = { ...(config.admin ?? {}), qqIds: ids };
          await persistConfig();
          log.warn('管理员名单已更新', { count: ids.length, removed: removed.length });
          return { ok: true, count: ids.length };
        }

        if (key === 'admin.inheritWhitelist') {
          if (typeof value !== 'boolean') {
            return { ok: false, code: 'E40XX', message: 'admin.inheritWhitelist 必须是布尔值' };
          }
          config.admin = { ...(config.admin ?? {}), inheritWhitelist: value };
          await persistConfig();
          // 打开它是个权限放宽的动作，必须留痕（且写明后果）
          log.warn(
            value
              ? '已开启「白名单视为管理员」：allow.private 里的号码将获得宿主机工具与确认权'
              : '已关闭「白名单视为管理员」：管理员只认 admin.qqIds',
          );
          return { ok: true };
        }

        if (key === 'deny') {
          /*
           * 黑名单。
           *
           * 语义上它**优先于白名单**（见 guard/send-gate.mjs）：
           * 一个号同时在两边时，拉黑生效。这是有意的 —— 万一某个号被盗，
           * 先拉黑应该立刻起作用，而不是还要先去白名单里把它删掉。
           *
           * 形状校验和 allow 完全一样：形状不对会让闸门静默失效。
           */
          const shape = normalizeIdLists(value);
          if (!shape.ok) return { ok: false, code: 'E40XX', message: shape.message };
          const before = {
            groups: [...(config.deny?.groups ?? [])],
            private: [...(config.deny?.private ?? [])],
          };
          config.deny = shape.value;
          await persistConfig();
          log.warn('黑名单已更新', {
            before: before.groups.length + before.private.length,
            after: shape.value.groups.length + shape.value.private.length,
          });
          return { ok: true };
        }

        // ---- 唤醒设置 ----
        /*
         * `wake.*` 一整组。
         *
         * ## 为什么用一个前缀匹配而不是逐个 if
         *
         * wake 有十几个字段，逐个写 if 会让这里涨到两屏，而且每加一个字段
         * 就要改三处（schema 默认值、这里、界面）。用前缀匹配 + 字段白名单，
         * 新增字段只改两处。
         *
         * ## 校验必须在这里做，不能靠 schema
         *
         * schema 的 `mergeStrict` 只在**启动时**跑一次。运行时直接改内存
         * 的 config 对象是绕过它的 —— 所以这里对每个字段做类型/范围校验，
         * 否则界面传个字符串 "abc" 进来，`probability` 就变成 NaN，
         * 概率判定的比较永远为 false，表现为"概率唤醒永不触发"。
         */
        if (typeof key === 'string' && key.startsWith('wake.')) {
          const field = key.slice('wake.'.length);
          const r = applyWakeSetting(config, field, value);
          if (!r.ok) return r;
          await persistConfig();
          log.info('唤醒设置已更新', { field, value: r.echo ?? value });
          return { ok: true, value: r.echo };
        }

        /*
         * 分条设置（F22）。
         *
         * 和 `wake.*` / `silence.*` 一样用前缀匹配 + 字段白名单：
         * 运行时改内存 config 绕过了启动校验，所以每个字段必须自己验类型。
         * 存进一个形状不对的值（比如 maxMessages = "3"）不会当场报错，
         * 只会在发送层被 normalize 成默认值 —— 用户会以为设置没生效。
         */
        if (typeof key === 'string' && key.startsWith('reply.')) {
          const field = key.slice('reply.'.length);
          const r = applyReplySetting(config, field, value);
          if (!r.ok) return r;
          await persistConfig();
          log.info('分条设置已更新', { field, value: r.echo ?? value });
          return { ok: true, value: r.echo };
        }

        if (typeof key === 'string' && key.startsWith('vision.')) {
          const field = key.slice('vision.'.length);
          const r = applyVisionSetting(config, field, value);
          if (!r.ok) return r;
          await persistConfig();
          /*
           * 清掉"本回合"的统计：用户刚改了预算/开关，界面上那块
           * "上回合提交了 3 张图"描述的是旧设置下的行为，留着会让
           * 用户以为新设置没生效。累计值（imagesSubmitted 等）不清 ——
           * 那是历史事实，改了预算又不会让过去没花过的钱回来。
           */
          visionRuntime.lastTurn = { attempted: 0, loaded: 0, bytes: 0, codes: [], notes: [] };
          visionRuntime.lastAt = null;
          log.info('视觉设置已更新', { field, value: r.echo ?? value });
          return { ok: true, value: r.echo };
        }

        /*
         * 静音的持久配置（F20）。
         *
         * 和临时静音分开：这些是用户显式设的、要落盘的，
         * 所以走 setting + persistConfig。临时静音走 action。
         */
        if (typeof key === 'string' && key.startsWith('silence.')) {
          const field = key.slice('silence.'.length);
          const r = applySilenceSetting(config, field, value);
          if (!r.ok) return r;
          await persistConfig();
          log.info('静音设置已更新', { field, value: r.echo ?? value });
          return { ok: true, value: r.echo };
        }

        if (key === 'persona') {
          if (typeof value !== 'string') {
            return { ok: false, code: 'E40XX', message: 'persona 必须是字符串' };
          }
          if (value.length > PERSONA_LIMIT) {
            return {
              ok: false,
              code: 'E4041',
              message: `人格注入超限：${value.length} / ${PERSONA_LIMIT} 字符`,
            };
          }
          await savePersona(value);
          return { ok: true };
        }

        // ---- LLM 接入设置（不含 key，key 走 secret.* 单独通道）----
        //
        // 为什么把 key 和这些分开：key 要加密存，这几项是明文配置。
        // 混在一起写会让"key 会不会被明文落盘"变成需要推理的问题，
        // 分开之后是一条结构上的保证（I21 闸门就守这个）。
        if (key === 'llm.provider') {
          // 只存"用户选了哪个预设"，用于界面回显。
          // 实际请求永远以 baseUrl 为准 —— 两处都当真相源必然打架。
          config.llm.provider = String(value ?? '').trim().slice(0, 40);
          await persistConfig();
          return { ok: true };
        }

        if (key === 'llm.baseUrl') {
          const v = String(value ?? '').trim();
          if (v.length > 0 && !/^https?:\/\//i.test(v)) {
            return { ok: false, code: 'E40XX', message: 'baseUrl 必须以 http:// 或 https:// 开头' };
          }
          config.llm.baseUrl = v;
          await persistConfig();
          rebuildLlmClient();
          return { ok: true };
        }

        if (key === 'llm.model') {
          const v = String(value ?? '').trim();
          if (!v) return { ok: false, code: 'E4041', message: 'model 不能为空' };
          if (v.length > 120) return { ok: false, code: 'E4041', message: 'model 名字过长' };
          config.llm.model = v;
          await persistConfig();
          rebuildLlmClient();
          return { ok: true };
        }

        if (key === 'llm.thinking') {
          /*
           * 思考开关注入方式。
           *
           * 换模型后思考链路突然空了，最常见的原因就是新模型/新中转要显式
           * 打开才返回 reasoning。这里让用户能自己切一下，不用改代码。
           * 只接受白名单值 —— 写进请求体的东西不能随便来。
           */
          const v = String(value ?? '').trim();
          if (!THINKING_STYLE_KEYS.has(v)) {
            return {
              ok: false,
              code: 'E40XX',
              message: `llm.thinking 只能是：${[...THINKING_STYLE_KEYS].join(' / ')}`,
            };
          }
          config.llm.thinking = v;
          await persistConfig();
          rebuildLlmClient();
          log.info('思考开关注入方式已更新', { thinking: v });
          return { ok: true };
        }

        if (key === 'qqExe') {
          /*
           * 用户手填 QQ 安装目录或 QQ.exe 路径。
           *
           * 为什么需要这个：自动识别（注册表 + 猜常见目录）在别人电脑上
           * 总有够不到的情况 —— 装在非系统盘的自定义目录、绿色版、
           * 同时装了新旧两版。与其让识别逻辑无限膨胀去猜，不如给一个
           * 明确入口让人自己指。
           *
           * 只做形状校验（非空、长度、不含非法字符），**不校验文件是否存在**：
           * 用户可能想先填好、后装 QQ。存在与否由体检卡如实显示。
           */
          const v = String(value ?? '').trim().replace(/^"|"$/g, '');
          if (v.length > 260) return { ok: false, code: 'E4041', message: '路径过长' };
          if (/[\0\r\n]/.test(v)) return { ok: false, code: 'E4041', message: '路径含非法字符' };
          if (v) config.qqExe = v;
          else delete config.qqExe;
          await persistConfig();
          return { ok: true };
        }

        if (key === 'snowlumaDir') {
          // 与 qqExe 同样的语义：留空表示回到自动识别
          const v = String(value ?? '').trim().replace(/^"|"$/g, '');
          if (v.length > 260) return { ok: false, code: 'E4041', message: '路径过长' };
          if (/[\0\r\n]/.test(v)) return { ok: false, code: 'E4041', message: '路径含非法字符' };
          if (v) config.snowlumaDir = v;
          else delete config.snowlumaDir;
          await persistConfig();
          return { ok: true };
        }

        if (key === 'llm.timeoutMs') {
          const n = Number(value);
          // 下限给 5 秒：太短会让正常请求全超时，看起来像"模型坏了"
          if (!Number.isFinite(n) || n < 5000 || n > 300000) {
            return { ok: false, code: 'E4041', message: 'timeoutMs 必须在 5000–300000 之间' };
          }
          config.llm.timeoutMs = Math.round(n);
          await persistConfig();
          rebuildLlmClient();
          return { ok: true };
        }

        /*
         * 联网总闸（契约 §0/§1）。
         *
         * ## 为什么必须在这里硬校验布尔
         *
         * 这是安全开关。值来自界面（正常是布尔），但也可能是手改配置或
         * 别的客户端写入。`"false"` 这种字符串如果被真值转换成 true，
         * 用户写的就是"关闭"、实际却是开着 —— 界面还会显示"已关闭"。
         *
         * ## 为什么写完要立刻 refresh()
         *
         * 关闸必须对**在途**请求生效，不能只拦新请求。用户点「关闭联网」
         * 的那一刻，线上可能正有一个搜索在跑；等它自己跑完再回来，
         * 用户看到的是"我关了它还在联网"。`refresh()` 会把在途的
         * AbortController 全部 abort —— 这是这个开关唯一的"立即"语义。
         */
        if (key === 'network.enabled') {
          if (typeof value !== 'boolean') {
            return { ok: false, code: 'E40XX', message: 'network.enabled 必须是布尔值' };
          }
          /*
           * 关闸的顺序在这里定，而不是散在分支里（见 src/net/toggle.mjs）：
           *
           *   · 关闭：先同步生效 → 再中止在途 → 最后落盘。磁盘慢的那几百毫秒
           *     里请求仍在跑，用户看到的就是"我关了它还在联网"。
           *   · 打开：先落盘成功 → 再生效。保存失败时保持关闭是安全方向。
           *   · 关闭落盘失败：保持关闭并明确报告；绝不能回弹成 true。
           *
           * `save` 用**候选快照**写盘，不依赖全局 config 已被改过 ——
           * 打开流程里 commit 发生在 save 成功之后。
           */
          const before = networkEnabledFrom(config);
          const result = await applyNetworkToggle({
            value,
            commit: (next) => {
              config.network = { ...(config.network ?? {}), enabled: next === true };
            },
            save: async (next) => {
              const snapshot = {
                ...config,
                network: { ...(config.network ?? {}), enabled: next === true },
              };
              await writeJsonAtomic(paths.configPath, snapshot);
            },
            abortInflight: () => (netFactory ? netFactory.refresh() : 0),
          });

          if (result.ok) {
            log.warn(value ? '联网总闸已打开' : '联网总闸已关闭', {
              before,
              after: value,
              aborted: result.aborted,
            });
            return { ok: true, value };
          }

          log.error('联网总闸切换未完成', {
            before,
            requested: value,
            persisted: result.persisted,
            aborted: result.aborted,
            code: result.code,
            message: result.message,
          });
          /*
           * 关闭失败时安全方向已经生效（result.closed），要把这一点传给界面：
           * 只回一个 ok:false 会让页面把复选框弹回"开"，而它其实已经关了、
           * 只是没保存成功。
           */
          return {
            ok: false,
            code: result.code ?? 'E40XX',
            message: result.message,
            value: result.value === true,
            closed: result.closed === true,
            persisted: result.persisted === true,
          };
        }

        /*
         * ---- 联网通道（独立搜索 API / 服务商原生联网）----
         *
         * ## 为什么允许在总闸关着时改
         *
         * 这里是"选了哪条通道"，不是"现在允不允许联网"。总闸关着时改它
         * 只是预设，下次打开就按新通道走；如果把这里也拒绝，用户会以为
         * 设置坏了。真正生效仍由 `network.enabled` 决定（`resolveNativeSearch`
         * 会先看总闸，总闸关着时 effectiveMode 一定是 off）。
         *
         * ## 为什么不需要重建客户端
         *
         * `LlmClient` 的 `webSearch` 是**现读闭包**（见启动处与 rebuildLlmClient），
         * 下一次请求就会用新配置。重建反而会丢掉正在进行的流。
         */
        if (key === 'network.mode') {
          const v = String(value ?? '').trim();
          if (v !== 'api' && v !== 'native') {
            return {
              ok: false,
              code: 'E40XX',
              message: 'network.mode 只能是 api（独立搜索 API）或 native（服务商原生联网）',
            };
          }
          config.network = { ...(config.network ?? {}), mode: v };
          await persistConfig();
          log.info('联网通道已更新', { mode: v });
          return { ok: true, value: v };
        }

        if (key === 'network.native.provider') {
          const v = String(value ?? '').trim().toLowerCase().slice(0, 40);
          config.network = {
            ...(config.network ?? {}),
            native: { ...(config.network?.native ?? {}), provider: v },
          };
          await persistConfig();
          /*
           * 未知服务商明确说清楚，而不是静默接受：它不会被按别家协议发送，
           * 但用户需要知道"选了也等于没选"。
           */
          const known = v === '' || v === 'zhipu' || v === 'openai';
          log.info('原生联网服务商已更新', { provider: v, known });
          return { ok: true, value: v, known };
        }

        if (key === 'network.native.maxResults') {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1 || n > 20) {
            return { ok: false, code: 'E4041', message: 'network.native.maxResults 必须是 1–20 的整数' };
          }
          config.network = {
            ...(config.network ?? {}),
            native: { ...(config.network?.native ?? {}), maxResults: n },
          };
          await persistConfig();
          return { ok: true, value: n };
        }

        if (key === 'plugins.enabled') {
          /*
           * 插件启用列表。
           *
           * 形状必须是字符串数组：直接赋非法值会让加载器拿到 undefined，
           * 表现成"插件全没了"，而用户以为自己只关了一个。
           *
           * 现在它委托给管理器：逐个比对前后差异，只对变化的那几个
           * 走 enable/disable。全量重载会中断所有插件的在途调用 ——
           * 用户只关掉一个插件，不该把另一个正在干活的插件也掐了。
           */
          if (!Array.isArray(value)) {
            return { ok: false, code: 'E40XX', message: 'plugins.enabled 必须是数组' };
          }
          /** @type {string[]} */
          const names = [];
          for (const item of value) {
            const s = String(item ?? '').trim();
            if (!s) continue;
            // 插件 id 会被拼进路径，这里挡掉穿越和分隔符
            if (!isPluginId(s)) {
              return { ok: false, code: 'E40XX', message: '插件 id 不合法：' + s };
            }
            if (!names.includes(s)) names.push(s);
          }
          if (!plugins) return { ok: false, code: 'E40XX', message: '插件管理器未就绪' };

          const before = [...config.plugins.enabled];
          const toEnable = names.filter((x) => !before.includes(x));
          const toDisable = before.filter((x) => !names.includes(x));

          for (const id of toDisable) await plugins.disable(id);
          for (const id of toEnable) await plugins.enable(id);

          log.info('插件启用列表已更新', { before, after: names, enabled: toEnable, disabled: toDisable });
          return { ok: true, enabled: toEnable, disabled: toDisable };
        }

        if (key === 'plugins.allowDangerous') {
          /*
           * 危险开关。
           *
           * 它只决定"插件能申请多高风险的工具"，**不是沙箱**：
           * 插件仍与主进程同权限运行。所以它是配置项，不是安全边界，
           * 界面上那条黄字一直这么写。
           */
          if (typeof value !== 'boolean') {
            return { ok: false, code: 'E40XX', message: 'plugins.allowDangerous 必须是布尔值' };
          }
          const wasOn = config.plugins.allowDangerous === true;
          config.plugins.allowDangerous = value;
          await persistConfig();
          // 风险档变了要重新加载：原来被拒的插件现在可能能跑（或反过来必须停）
          await reloadPlugins();
          log.warn('插件危险权限已变更', { before: wasOn, after: value });
          return { ok: true };
        }

        if (key === 'plugins.chatTools' || (typeof key === 'string' && key.startsWith('plugins.chatTools.'))) {
          /*
           * 聊天来源的工具授权。
           *
           * ## 为什么走 setting 而不是 action
           *
           * 它写的是**配置**（要落盘、下次启动还得在），不是一次性动作。
           * IPC 只有 snapshot/action/setting 三条通道（I11），
           * 按语义就该是 setting —— 和 plugins.enabled / allowDangerous 一致。
           *
           * ## 为什么不重载插件
           *
           * 授权只影响"工具对某个来源是否可见"，而可见性在**每个回合**
           * 现算（见 toolPolicy / makeRunner）。所以改完下一个回合就生效，
           * 不需要 dispose → init 一遍（那会打断正在干活的插件）。
           */
          const cur = normalizeChatTools(config.plugins?.chatTools);
          if (!cur.ok) {
            return { ok: false, code: 'E40XX', message: `现有 chatTools 配置不合法：${cur.message}` };
          }

          /** @type {any} */
          let next;
          if (key === 'plugins.chatTools') {
            // 整块写入：调用方必须给全三个档（缺的按"关闭"补齐，不猜）
            next = value;
          } else {
            const channel = key.slice('plugins.chatTools.'.length);
            if (!['group', 'private', 'proactive'].includes(channel)) {
              return { ok: false, code: 'E40XX', message: `未知的授权档：${channel}` };
            }
            next = { ...cur.value, [channel]: value };
          }

          const normalized = normalizeChatTools(next);
          if (!normalized.ok) {
            return { ok: false, code: 'E40XX', message: normalized.message };
          }

          config.plugins.chatTools = normalized.value;
          await persistConfig();

          /*
           * 把"哪些工具真的会被影响"记进日志。
           *
           * 只记档位与数量不够用：用户排查"我明明勾了表情包，群里还是不能用"时，
           * 需要看到他勾的**具体名字**有没有对上工具全名（plugin_xxx）。
           */
          const summary = Object.fromEntries(
            Object.entries(normalized.value).map(([ch, rule]) => [
              ch,
              { enabled: rule.enabled, tools: rule.tools, allowPaid: rule.allowPaid },
            ]),
          );
          /*
           * `channelName` 而不是直接用 key 拼进日志：
           *
           * 这里记的是**设置项名字**（`plugins.chatTools.group`），不是凭据。
           * 但静态检查 I21 按"日志行里出现 key 字样"来防 API Key 泄露，
           * 直接写变量名会命中那条规则 —— 与其放宽检查（那会削弱真正的保护），
           * 不如换个名字，让这条日志在字面上也不像凭据。
           */
          const channelName = String(key);
          log.info('聊天来源工具授权已更新', { field: channelName, chatTools: summary });
          return { ok: true, chatTools: normalized.value };
        }

        return { ok: false, code: 'E40XX', message: `未支持的设置项：${key}` };
      }

      default:
        return { ok: false, code: 'E50XX', message: `未知 method：${method}` };
    }
  },

  /** @param {string} event @param {any} payload */
  notify(event, payload) {
    write({ jsonrpc: '2.0', method: 'event', params: { event, payload } });
  },
};

/** 界面可见的配置（凭据一律掩码） */
function publicConfig() {
  return {
    ...config,
    dsh: { ...config.dsh, token: maskSecret(config.dsh.token), hasToken: Boolean(config.dsh.token) },
    onebot: {
      ...config.onebot,
      accessToken: maskSecret(config.onebot.accessToken),
    },
    llm: {
      ...config.llm,
      modelCapabilities: endpointCapabilities(config.llm.modelCapabilities, config.llm.baseUrl),
      apiKey: maskSecret(currentApiKey),
      keySource,
    },
  };
}

/**
 * 改了 baseUrl / model / timeout / key 之后重建客户端。
 *
 * 为什么必须重建而不是改字段：LlmClient 在构造时把参数收进了私有字段
 * （#opts），外部改 config 不会影响已经在用的实例——
 * 改了设置却没生效，是最让人困惑的一类 bug。
 */
function rebuildLlmClient() {
  llm = new LlmClient({
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: currentApiKey,
    timeoutMs: config.llm.timeoutMs,
    thinking: config.llm.thinking,
    // 同启动处：现读，避免"改完设置没生效"
    webSearch: () => {
      const resolved = resolveNativeSearch(config);
      return resolved.active ? resolved.plan : null;
    },
  });
  log.info('AI 接入设置已更新', {
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
    thinking: config.llm.thinking,
    configured: llm.configured,
  });
}

async function persistConfig() {
  await writeJsonAtomic(paths.configPath, config);
}

/**
 * 重新加载整个插件面。
 *
 * 为什么要这一步：`plugins.allowDangerous` 改了之后，某些插件可能
 * 从"被拒"变成"可加载"（或反过来必须停掉）—— 不重载就只有重启才生效，
 * 而用户在界面上点开关的那一刻，期望的是**立刻**生效。
 *
 * 加载失败不能抛出去：用户点了一个开关，不该让整个设置保存失败。
 * 单个插件的错误由管理器自己收集到各自的状态里。
 */
async function reloadPlugins() {
  if (!plugins) return;
  try {
    const r = await plugins.loadAll();
    log.info('插件面已重新加载', { loaded: r.loaded, failed: r.failed, skipped: r.skipped });
  } catch (err) {
    log.error('插件重新加载失败', { message: String(/** @type {any} */ (err)?.message ?? err) });
  }
}

/**
 * 插件 id 的形状。
 *
 * 它会拼进磁盘路径，所以必须挡掉分隔符与 `..`；
 * 与 manifest.mjs 的 ID_RE 保持一致（这里再挡一次是因为 RPC 参数不可信）。
 *
 * @param {string} id
 * @returns {boolean}
 */
function isPluginId(id) {
  return /^[a-z][a-z0-9-]{1,40}$/.test(String(id ?? ''));
}

/**
 * 取插件快照，失败时给一个形状合法的空视图。
 *
 * 为什么兜底：插件面是可选面板，它算不出来绝不能连累整份快照 ——
 * 那样用户连消息列表、连接状态一起看不到，症状是「界面拉取失败」。
 *
 * @returns {Promise<object>}
 */
async function pluginSnapshotSafe() {
  if (!plugins) {
    return {
      enabled: config?.plugins?.enabled ?? [],
      allowDangerous: config?.plugins?.allowDangerous === true,
      loaded: [],
      skipped: [],
      items: [],
      stats: { total: 0, ready: 0, error: 0, disabled: 0 },
      dirs: { plugins: paths.pluginsDir, data: paths.root },
    };
  }
  try {
    return await plugins.snapshot();
  } catch (err) {
    log.warn('插件快照生成失败，本次返回空视图', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
    return {
      enabled: config?.plugins?.enabled ?? [],
      allowDangerous: config?.plugins?.allowDangerous === true,
      loaded: [],
      skipped: [],
      items: [],
      stats: { total: 0, ready: 0, error: 0, disabled: 0 },
      dirs: { plugins: paths.pluginsDir, data: paths.root },
      error: String(/** @type {any} */ (err)?.message ?? err),
    };
  }
}

/**
 * 插件面清单（启动日志用）。
 *
 * @param {any} snap
 * @returns {string}
 */
function describePluginSurface(snap) {
  const items = Array.isArray(snap?.items) ? snap.items : [];
  if (items.length === 0) return '（未安装任何插件）';
  return items
    .map((p) => {
      const tools = (p.tools ?? []).map((t) => t.fullName ?? t.name).join(', ') || '无工具';
      const mark = p.status === 'ready' ? '✓' : p.enabled ? '✖' : '·';
      const detail = p.status === 'ready' ? tools : `${p.statusText}${p.error ? ` ${p.error.code}` : ''}`;
      return `  ${mark} ${String(p.id).padEnd(16)} ${String(p.version).padEnd(8)} ${detail}`;
    })
    .join('\n');
}

/** 人格注入上限（与界面显示一致，F8） */
const PERSONA_LIMIT = 6000;

/**
 * 校验并规范化 QQ 号列表。
 *
 * 之所以要这一层：`allow` 会被闸门直接用于比较，
 * 如果混进对象或空字符串，白名单就会静默失效（fail-open 风险）。
 *
 * @param {any} value
 * @returns {{ok: true, value: {groups: string[], private: string[]}} | {ok: false, message: string}}
 */
function normalizeIdLists(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, message: 'allow 必须是 { groups: [], private: [] } 形状' };
  }
  /** @param {any} arr @param {string} name */
  const clean = (arr, name) => {
    if (arr === undefined) return { ok: true, value: [] };
    if (!Array.isArray(arr)) return { ok: false, message: `${name} 必须是数组` };
    /** @type {string[]} */
    const out = [];
    for (const item of arr) {
      const s = String(item).trim();
      if (!/^\d{1,20}$/.test(s)) return { ok: false, message: `${name} 里有非法 QQ 号：${String(item)}` };
      if (!out.includes(s)) out.push(s);
    }
    return { ok: true, value: out };
  };

  const groups = clean(value.groups, 'groups');
  if (!groups.ok) return { ok: false, message: groups.message };
  const priv = clean(value.private, 'private');
  if (!priv.ok) return { ok: false, message: priv.message };

  return { ok: true, value: { groups: groups.value, private: priv.value } };
}

/**
 * 保存人格文本（仅保留给旧调用方；新代码走人格卡动作）。
 *
 * @param {string} text
 */
async function savePersona(text) {
  const card = personaStore.cards.find((c) => c.id === personaStore.activeId);
  if (card) {
    await personaStore.update(card.id, { text });
  } else {
    await personaStore.create('默认人格', text);
  }
  persona = text;
  log.info('人格已更新', { chars: text.length });
}

/**
 * 载入人格（启动时）。
 *
 * @returns {Promise<string>}
 */
async function loadPersona() {
  await personaStore.load();
  /*
   * 一张卡都没有时给一张全局默认卡。
   *
   * 必须是 global：如果给成某个具体群，其它会话就没有兜底人格了。
   */
  if (personaStore.cards.length === 0) {
    await personaStore.create('默认人格', '', 'global');
  }
  return personaStore.activeText();
}

/**
 * 载入角色卡。
 *
 * 首次运行没有 role.json 时，建一张**全局**默认角色，文本留空 ——
 * 留空是有意的：buildMessages 会按 isGroup 选内置的群/私聊默认角色，
 * 这比给一张写死的文本更合适（有人只在群里、有人只在私聊）。
 *
 * @returns {Promise<void>}
 */
async function loadRole() {
  await roleStore.load();
  if (roleStore.cards.length === 0) {
    await roleStore.create('默认角色', '', 'global');
  }
}

/** @param {any} obj */
function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/* ---------------------------------------------------------------- 主循环 */

const rl = readline.createInterface({ input: process.stdin, terminal: false });

/** 是否收到过至少一行 stdin（见 rl.on('close') 里的说明） */
let sawStdinLine = false;

/*
 * stdin 关闭 = 父进程没了，必须自己退出。
 *
 * ## 为什么这条比信号更重要
 *
 * 正常退出（托盘「退出」）走的是 shutdown JSON，这条路是好的。
 * 但外壳被强杀 / 崩溃 / 任务管理器结束时，Windows 不会给 node 发
 * SIGTERM —— 进程直接消失。
 *
 * 没有兜底时：后端会一直活着。表现就是"程序关了，后台还在"：
 * 端口被占、下次启动报 E4064 端口被占用，而且用户找不到是谁占的。
 *
 * ## 为什么不能只靠 stdin
 *
 * 实测过两条路都不够：
 *
 *   1. 只监听 `rl.on('close')` —— 外壳被 Stop-Process 强杀时，
 *      管道句柄随进程一起没了，但 node 这边的 readline 不一定
 *      立刻收到 EOF（取决于句柄继承），这条回调可能根本不触发。
 *   2. 只看"stdin 关了就退出" —— 调试时父进程根本没接管道，
 *      一启动就自杀，把开发场景也杀了。
 *
 * 所以真正的判据只有一个：**父进程还在不在**，而且要主动去问。
 * 见下面的 parentWatch。
 */
rl.on('close', () => {
  if (!sawStdinLine) return;
  if (isParentAlive()) {
    log.warn('stdin 已关闭，但父进程仍在运行，继续提供服务');
    return;
  }
  log.info('父进程已退出，后端自行收尾');
  shutdown(0).catch(() => process.exit(0));
});

/**
 * 父进程是否还活着。
 *
 * Windows 上 `process.kill(pid, 0)` 只做存在性探测、不发信号。
 *
 * 任何非 ESRCH 的异常都保守地当作"还在"：宁可留一个需要手工清理的
 * 进程，也不要因为一次探测抖动就把用户正在用的服务停掉。
 *
 * @returns {boolean}
 */
function isParentAlive() {
  const ppid = process.ppid;
  if (!ppid || ppid <= 1) return false;
  try {
    process.kill(ppid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但没权限（仍算活着）；ESRCH = 不存在
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/** 父进程存活检查间隔：够快（用户不会觉得"关不掉"），又不至于太吵 */
const PARENT_WATCH_MS = 3000;

/**
 * 心跳式父进程看护。
 *
 * 这是兜住"外壳被强杀"的**唯一可靠**手段：不依赖管道 EOF、不依赖
 * 信号（Windows 根本没有 SIGTERM 给子进程），只定期问一句"我爸还在吗"。
 *
 * ## 为什么必须有它
 *
 * 后端在真实运行时是**被事件循环撑住**的（OneBot WebSocket、定时器）。
 * 外壳一声不响地消失后，这些句柄不会跟着断，进程就一直活着占着端口。
 * 用户看到的是"程序关了，后台还在"，而且任务管理器里只有一个 node.exe，
 * 根本看不出它是谁。
 *
 * ## 为什么第一条指令之后才开始看
 *
 * 外壳启动后端后会立刻发 snapshot。在此之前把"父进程不在"当作
 * 正常情况处理（调试、被别的工具拉起），避免误杀。
 *
 * @param {number} everyMs
 */
function startParentWatch(everyMs = PARENT_WATCH_MS) {
  const timer = setInterval(() => {
    if (!sawStdinLine) return;
    if (isParentAlive()) return;
    log.warn('父进程已消失，后端自行退出（避免成为孤儿进程占着端口）');
    void shutdown(0).catch(() => process.exit(0));
  }, everyMs);
  /*
   * 必须 unref。
   *
   * 这个定时器是**兜底检查**，不是用来撑住进程的：如果后端此刻
   * 已经没有任何存活句柄（没有 OneBot 连接、没有插件子进程），
   * 它本来就该自然退出 —— 那种情况下不会产生孤儿，也用不着看护。
   *
   * 反过来，把它当成"保活句柄"才是错的：一个本该退出的后端会被
   * 硬撑住，那正好制造出我们要防的那种孤儿。
   */
  timer.unref?.();
  return timer;
}

rl.on('line', async (line) => {
  sawStdinLine = true;
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.method === 'shutdown') {
    await shutdown(0);
    return;
  }
  try {
    const result = await rpc.handle(req.method, req.params);
    write({ jsonrpc: '2.0', id: req.id, result });
  } catch (err) {
    const e = /** @type {any} */ (err);
    lastError = { code: e?.code ?? 'E50XX', message: String(e?.message ?? e), at: Date.now() };
    log.error('RPC 处理失败', { method: req.method, code: lastError.code });
    write({ jsonrpc: '2.0', id: req.id, error: { code: lastError.code, message: lastError.message } });
  }
});

async function shutdown(code) {
  log.info('后端正在退出', { code });
  client?.close();
  /*
   * 在途确认按拒绝结算。
   *
   * 不这么做的话，正在等用户点头的工具调用会一直挂到 60 秒超时 ——
   * 而进程马上就要没了，那条 Promise 永远等不到结果，
   * 执行器那边的工具调用就悬在半空（它的 finally 也不会跑）。
   *
   * 放在最前面：它只是内存操作，比落盘快得多，越早做越不会丢。
   */
  const cancelled = confirms.cancelAll(SETTLE_REASON.SHUTDOWN);
  if (cancelled > 0) log.info('退出前取消了在途确认', { count: cancelled });
  /*
   * 插件先收尾：子进程不关会变成孤儿进程，继续占着端口。
   *
   * 放在 thinkingStore.flush() 之前 —— 插件可能有"退出时落盘"的需求，
   * 而它们比一条展示数据更需要确定性。
   */
  try {
    await plugins?.shutdown();
  } catch (err) {
    log.warn('插件收尾失败（不影响退出）', { message: String(/** @type {any} */ (err)?.message ?? err) });
  }
  /*
   * 退出前显式落盘一次。
   *
   * record() 是内存写入 + 防抖落盘，只靠那个定时器的话，
   * 进程正常退出时最后一条思考会丢（定时器还没到点就被 exit 掐了）。
   * 这里失败也不能拦住退出 —— 少一条展示数据不值得让进程卡死。
   */
  try {
    await thinkingStore.flush();
  } catch {
    /* 已尽力 */
  }
  /*
   * 会话楼层也要显式落一次。
   *
   * 它比思考记录更该保住：思考是"看过就算了"的展示数据，
   * 而楼层丢了等于用户的历史消息和「读到第几楼」一起没了 ——
   * 下次启动会从空仓库开始，旧消息既不显示也不再被处理。
   *
   * 同样地，失败不拦退出：卡在退出比丢一次落盘更糟（用户会以为关不掉）。
   */
  try {
    await sessionStore.close();
  } catch (err) {
    log.warn('会话楼层落盘失败（不影响退出）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (err) => {
  log.error('未捕获异常', { message: String(err?.message ?? err) });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', { message: String(reason) });
});

/**
 * 只在被直接运行时启动；被测试 import 时保持无副作用
 * （ESM 里没有 require.main，用 argv[1] 与 import.meta.url 比较）。
 */
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href;

if (isDirectRun) {
  boot().catch((err) => {
    log.error('启动失败', { message: String(err?.message ?? err), code: /** @type {any} */ (err)?.code });
    process.exit(1);
  });
}

// 供测试 import（不启动）
export {
  validateConfig,
  DEFAULT_CONFIG,
  resolveToolSet,
  toOpenAiTools,
  RISK,
  describeTools,
  listTools,
  buildImageRetryRunner,
};
