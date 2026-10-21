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
import { UpstreamHealth } from './onebot/health.mjs';
import { passSendGate, checkWhitelist, RateLimiter } from './guard/send-gate.mjs';
import { auditOutbound, maskSecret } from './guard/audit.mjs';
import { assertOrigin, ORIGIN } from './guard/origin.mjs';
import { resolveToolSet, toOpenAiTools, RISK } from './guard/tool-gate.mjs';
import { listTools, describeTools } from './tools/registry.mjs';
import { registerReadonlyTools } from './tools/basic.mjs';
import { createToolRunner } from './tools/executor.mjs';
import { installBuiltinPlugins } from './tools/builtin-plugins.mjs';
import { PluginManager } from './plugins/manager.mjs';
import { migrateLegacyDsh } from './plugins/legacy.mjs';
import { registerAllActions, snapshotRegistry, renderRegistryBanner } from './registry.mjs';
import { LlmClient, estimateTokens, THINKING_STYLES } from './llm/client.mjs';

/**
 * 允许的思考开关取值。
 *
 * 单独提出来是为了让"校验"和"文档"是同一份数据 —— 手写数组迟早和
 * client.mjs 里的表漂移，那时会出现"设置存下来了但请求没变"的怪事。
 */
const THINKING_STYLE_KEYS = new Set(['auto', ...Object.keys(THINKING_STYLES)]);
import { buildMessages, DEFAULT_PERSONA } from './llm/prompt.mjs';
import { runTurn, truncationNotice } from './llm/agent-loop.mjs';
import { detectTrigger, decideProactive, isStrongTrigger, TriggerLedger } from './llm/triggers.mjs';
import { UsageLedger } from './llm/usage.mjs';
import { PersonaStore, RoleStore } from './llm/persona.mjs';
import { ThinkingStore } from './llm/thinking.mjs';
import { sealSecret, openSecret, isVaultAvailable } from './config/vault.mjs';
import { probeVision, probeImageGen, describeCatalog, inferChannel, endpointKey, endpointCapabilities } from './llm/capability.mjs';
import { unlink as fsUnlink } from 'node:fs/promises';
import { probeEnvironment } from './env/probe.mjs';

const paths = resolvePaths();
const log = new Logger({ dir: paths.logsDir, level: process.env.LING_LOG_LEVEL ?? 'info' });

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
/** 每个会话的最近消息（拼上下文用，比全局 messages 更准） */
/** @type {Map<string, Array<{role: string, nickname?: string, text: string}>>} */
const recentByConv = new Map();
/** 正在跑的回合：同一会话同时只允许 1 个（F7 并发约束） */
/** @type {Map<string, AbortController>} */
const inflight = new Map();
/** 排队等待的强触发（不能用"忙"把人晾着） */
/** @type {Map<string, object>} */
const pendingTurns = new Map();
/** 待人工确认的 R2/R3 工具调用 */
/** @type {Map<string, {resolve: Function, timer: NodeJS.Timeout, req: object}>} */
const pendingConfirms = new Map();
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

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  const userConfig = (await readJson(paths.configPath)) ?? {};
  config = validateConfig(userConfig);

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

  // LLM 客户端：没配 key 也照常构造，只是 configured=false，界面据此提示
  llm = new LlmClient({
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey,
    timeoutMs: config.llm.timeoutMs,
    thinking: config.llm.thinking,
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

  log.info('Ling-bot 后端已启动', { node: process.version, version: '0.1.0-p0' });

  // 内置插件铺盘。
  //
  // 加载器只认 <userData>/plugins/，仓库里的 plugins/ 是出厂源。
  // 不铺过去，"默认启用"的那个插件就永远不在磁盘上，而症状是
  // **什么都没发生**（配置说启用、加载器说 0 个插件、端口没起），
  // 排查成本远高于这里多做一步。
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

  // 插件：空 enabled = 一个都不加载（默认关闭，光放文件不生效）
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
    // 打包后由桌面壳把内置 node.exe 的路径传进来；开发期用当前 node
    nodePath: process.env.LING_NODE_PATH || undefined,
  });

  const plug = await plugins.loadAll();
  log.info('插件面清单：\n' + describePluginSurface(await plugins.snapshot()));
  log.info('插件加载结果', { loaded: plug.loaded, failed: plug.failed, skipped: plug.skipped });

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
    messages.push(evt);
    if (messages.length > 500) messages = messages.slice(-500);

    // 记上下文：主动发言必须能"接上最近一句"
    pushRecent(evt.convKey, {
      role: 'user',
      nickname: evt.sender?.nickname || evt.sender?.userId,
      text: evt.text || '（无文本）',
    });

    // 真人说过话 —— 这是概率唤醒的第 1 道护栏的输入
    if (String(evt.sender?.userId) !== String(selfId)) {
      triggerLedger.noteHuman(evt.convKey);
    }

    rpc.notify('message', evt);

    // 插件优先接管（例如 DSH 指令、审批回复）。
    // 有插件明确处理了就**不走 AI 回合**，避免"已经执行了还在回一句废话"。
    void dispatchToPlugins(evt);  } else if (evt.kind === 'self-sent') {
    rpc.notify('self-sent', evt);
  } else if (evt.kind === 'poke') {
    rpc.notify('poke', evt);
  } else if (evt.kind === 'request') {
    // 只展示，不自动同意（F3 边界）
    log.info('收到好友加群请求（未自动处理）', { type: evt.requestType, user: evt.userId });
    rpc.notify('request', evt);
  }
}

/**
 * 把消息先交给插件。
 *
 * 任何一个插件返回 true 都表示"已接管"，此时不再走 AI 回合。
 *
 * 为什么串行而不是并发：多个插件同时接管同一条消息会发出两条回复。
 * 串行 + 首个接管即停，行为是可预测的。
 *
 * 接管能力只对 in-process 运行时开放（子进程拿不到宿主的发送闸门与事件流），
 * 这一限制由管理器统一执行，这里不必再判断。
 *
 * @param {object} evt
 */
async function dispatchToPlugins(evt) {
  if (plugins) {
    try {
      const handled = await plugins.dispatchMessage(evt);
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

  const detected = detectTrigger(evt, {
    selfId,
    selfName: config.persona?.name,
    config: { keywords: config.llm.keywords ?? [] },
  });

  if (detected) {
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
      pendingTurns.set(convKey, job);
      log.info('回合排队（强触发）', { convKey, trigger: job.trigger });
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
    const runner = makeRunner(origin, convKey);

    /*
     * 注入哪张人格卡，由**会话**决定，不是由"当前选中的卡"决定。
     *
     * 原来这里直接传全局 persona，等于所有会话共用一张卡 ——
     * 于是"给某个群单独写一套"就不可能实现。
     *
     * 现在按 convKey 解析：private:<QQ> > group:<群号> > global
     * （见 PersonaStore.resolveFor）。没有任何卡命中时返回空串，
     * buildMessages 会退回 DEFAULT_PERSONA。
     */
    const personaForConv = personaStore.resolveFor(convKey)?.text ?? '';
    /*
     * 角色和人格各解析各的：同一个群可以配「群聊参与者」角色 + 任意人格，
     * 两者互不影响。解析规则完全一致（越具体越优先）。
     * 没命中时返回空串，buildMessages 按 isGroup 给默认角色。
     */
    const roleForConv = roleStore.resolveFor(convKey)?.text ?? '';

    const messagesForModel = buildMessages({
      persona: personaForConv,
      role: roleForConv,
      context: {
        convKey,
        isGroup: convKey.startsWith('group:'),
        recent: recentByConv.get(convKey) ?? [],
        trigger: job.reason,
        proactive: job.proactive,
      },
    });

    // 记录本轮产生的文本，供用量记账在缺 usage 时估算。
    // 注意两个坑：
    //   1. 不能在 onUsage 里读 `result` —— 那时它还没赋值（TDZ），
    //      会抛 ReferenceError 并被当成"未处理的 Promise 拒绝"，用量直接丢失。
    //   2. 也不能等 runTurn 返回后再赋值 —— onUsage 在回合中途就会触发，
    //      那时还拿不到最终文本。所以在 onDelta 里边收边累积。
    let turnText = '';

    const result = await runTurn({
      llm,
      runner,
      toOpenAiTools,
      messages: messagesForModel,
      signal: controller.signal,
      proactive: job.proactive,
      onDelta: (delta) => {
        turnText += delta;
        rpc.notify('turn-delta', { turnId, delta });
      },
      onToolCall: (info) => rpc.notify('turn-tool', { turnId, ...info }),
      onUsage: async ({ usage, model }) => {
        // 记账失败绝不能让回合崩掉，但也不能静默吞掉——记一行 warn
        try {
          await usageLedger.record({
            convKey,
            model,
            usage,
            proactive: job.proactive,
            promptText: messagesForModel.map((m) => m.content).join('\n'),
            completionText: turnText,
          });
        } catch (err) {
          log.warn('用量记账失败', { convKey, message: String(/** @type {any} */ (err)?.message ?? err) });
        }
      },
    });

    turnText = result.text ?? '';

    /*
     * 思考归档放在"是否发出回复"之前：它记的是「它想了什么」，
     * 与这条回复最终发没发出去无关。取消的回合也有思考过程，一并留下。
     * 没有 reasoning 时 record() 会直接返回 null（静默降级，不建空记录）。
     */
    recordThinking(convKey, result);

    const notice = truncationNotice(result);
    let reply = (result.text ?? '').trim();

    if (result.cancelled) {
      rpc.notify('turn-end', { turnId, cancelled: true });
      return;
    }

    // 触顶说明要拼在回复后面（不能吞掉已有内容）
    if (notice) reply = reply ? `${reply}\n${notice}` : notice;

    if (!reply) {
      rpc.notify('turn-end', { turnId, empty: true });
      return;
    }

    // 出站仍走唯一那道闸门（工具回合也不能绕）
    const sent = await sendText(convKey, reply);
    if (sent.ok) {
      pushRecent(convKey, { role: 'assistant', text: reply });
      triggerLedger.noteAutoTurn(convKey);
      if (job.proactive) triggerLedger.noteProactive(convKey);
    }

    rpc.notify('turn-end', {
      turnId,
      ok: sent.ok,
      code: sent.code ?? null,
      text: reply,
      proactive: job.proactive,
      steps: result.steps,
      usage: result.usage,
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    log.error('回合失败', { convKey, code: e?.code, message: String(e?.message ?? e) });
    rpc.notify('turn-end', { turnId, ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) });
  } finally {
    inflight.delete(convKey);
    const next = pendingTurns.get(convKey);
    if (next) {
      pendingTurns.delete(convKey);
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
 * @param {string} id
 * @param {string} kind
 * @returns {boolean}
 */
function isOwnerId(id, kind) {
  if (kind === 'private') {
    return (config.allow.private ?? []).some((x) => String(x) === String(id));
  }
  // 群里的"管理员"= 机器人自己的号（飞书式判定不适用，这里用 QQ 号）
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
 * @returns {Promise<{ok: boolean, code?: string, message?: string, messageId?: any}>}
 */
async function sendSegments(convKey, segments, auditText) {
  const gated = passSendGate({
    convKey,
    text: auditText,
    // 管理员名单来自 dsh.admins：他们的私聊必须能收到审批，
    // 不能再被"允许谁发指令"的白名单挡住（那是反方向的规则）。
    config: { ...config, admins: config.dsh?.admins ?? [] },
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
    const res = await client.sendAction(action, params);
    return { ok: true, messageId: res?.message_id };
  } catch (err) {
    const e = /** @type {any} */ (err);
    return { ok: false, code: e?.code ?? 'E1030', message: String(e?.message ?? e) };
  }
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
 */
function makeRunner(origin, convKey) {
  assertOrigin(origin);
  return createToolRunner({
    policy: toolPolicy(),
    context: {
      origin,
      convKey,
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
 * 请人确认一次高风险调用。
 *
 * 三条纪律：
 *   1. **默认拒绝**：没人应答、超时、界面没开，一律当"不允许"
 *   2. **不提供"本会话始终允许"**：一次确认只对一次调用有效
 *   3. **超时必须真的拒绝**，不能挂在那里等
 *
 * @param {{tool: string, risk: string, args: object, convKey: string}} req
 * @returns {Promise<'allow'|'deny'>}
 */
function askHumanConfirm(req) {
  const id = `confirm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const CONFIRM_TIMEOUT_MS = 60_000;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirms.delete(id);
      log.warn('确认超时，按拒绝处理', { tool: req.tool, id });
      rpc.notify('confirm-timeout', { id, tool: req.tool });
      resolve('deny');
    }, CONFIRM_TIMEOUT_MS);
    timer.unref?.();

    pendingConfirms.set(id, { resolve, timer, req });
    // 参数摘要要脱敏后再给界面看
    rpc.notify('confirm-request', {
      id,
      tool: req.tool,
      risk: req.risk,
      convKey: req.convKey,
      args: redactArgs(req.args),
      timeoutMs: CONFIRM_TIMEOUT_MS,
    });
    log.info('请求人工确认', { id, tool: req.tool, risk: req.risk });
  });
}

/**
 * 答复一次确认请求。
 *
 * @param {string} id
 * @param {boolean} allow
 * @returns {{ok: boolean, message?: string}}
 */
function resolveConfirm(id, allow) {
  const pending = pendingConfirms.get(id);
  if (!pending) return { ok: false, message: '该确认已过期或不存在' };
  pendingConfirms.delete(id);
  clearTimeout(pending.timer);
  pending.resolve(allow ? 'allow' : 'deny');
  log.info('人工确认结果', { id, allow });
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

/** @returns {object} 当前生效的工具授权策略 */
function toolPolicy() {
  return {
    groupHostToolsForbidden: true,
    proactiveHostToolsForbidden: true,
    allowR3Default: config.tools.allowR3 === true,
  };
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
            registry: { actions: [], tools: [], pages: [], timers: [] },
            persona: '',
            config: null,
            lastError,
            booting: true,
            // 形状与正常快照一致：界面不必为"启动中"再写一条分支
            thinking: rpc.emptyThinkingView(),
          };
        }
        return {
          state: client?.state ?? 'idle',
          health: health.snapshot(),
          account: { selfId: selfId || null },
          messages: messages.slice(-100),
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
          plugins: await pluginSnapshotSafe(),
          persona,
          /*
           * 传已知会话过去，界面就能显示"这张卡现在命中哪些会话"。
           * 没有会话时就是空对象，不影响渲染。
           */
          personaCards: personaStore.view([...recentByConv.keys()]),
          roleCards: roleStore.view([...recentByConv.keys()]),
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
            queued: pendingTurns.size,
            pendingConfirms: [...pendingConfirms.entries()].map(([id, p]) => ({ id, ...p.req })),
            /** 每个会话的触发状态：主动发言的 30 分钟间隔就靠它 */
            conversations: [...recentByConv.keys()].map((k) => ({
              convKey: k,
              recent: (recentByConv.get(k) ?? []).length,
              ...triggerLedger.snapshot(k),
            })),
          },
          usage: usageLedger
            ? { ...usageLedger.summary(), ...(params?.usage ? { range: await usageLedger.range(params.usage) } : {}) }
            : { today: null, recent: [], unavailable: true },
        };

      case 'action': {
        const name = params?.name;
        const arg = params?.params ?? {};
        if (name === 'usage.query') return { ok: true, range: await usageLedger.range(arg) };
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
          // 实测某个模型的能力（视觉 / 生图 / 通道）。
          //
          // 会发真实请求、消耗极少额度，所以只在用户点按钮时跑，
          // 绝不在启动时自动执行。
          const m = String(arg.model ?? '').trim();
          if (!m) return { ok: false, code: 'E4041', message: '先选择模型' };
          if (!llm?.configured) return { ok: false, code: 'E3020', message: '还没配置 API Key' };

          /** @type {Record<string, any>} */
          const found = {};
          const probeEndpoint = config.llm.baseUrl;
          const want = new Set(Array.isArray(arg.probe) ? arg.probe : ['vision', 'image']);

          if (want.has('vision')) {
            const r = await probeVision({
              baseUrl: config.llm.baseUrl,
              apiKey: currentApiKey,
              model: m,
            });
            found.vision = r;
          }
          if (want.has('image')) {
            const r = await probeImageGen({
              baseUrl: config.llm.baseUrl,
              apiKey: currentApiKey,
              model: m,
            });
            found.image = r;
          }

          // 只把**有明确结论**的写进配置，null（没测出来）不写。
          // 理由：把"没测出来"记成 false，下次打开界面会显示"不支持"，
          // 而事实只是没连通——那会误导人。
          if (config.llm.baseUrl !== probeEndpoint) return { ok: false, message: '探测期间端点已变更，结果未保存' };
          const caps = { ...(config.llm.modelCapabilities ?? {}) };
          const endpoint = endpointKey(probeEndpoint);
          const scoped = { ...(caps[endpoint] ?? {}) };
          const cur = { ...(scoped[m] ?? {}) };
          cur.probes = found;
          cur.endpoint = endpoint;
          if (typeof found.vision?.supported === 'boolean') cur.vision = found.vision.supported;
          if (typeof found.image?.supported === 'boolean') cur.image = found.image.supported;
          const ch = inferChannel({ model: m, caps: cur });
          cur.channel = ch.channel;
          cur.probedAt = new Date().toISOString();
          scoped[m] = cur;
          caps[endpoint] = scoped;
          config.llm.modelCapabilities = caps;
          await persistConfig();

          return { ok: true, model: m, probes: found, caps: cur, channel: ch };
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
export { validateConfig, DEFAULT_CONFIG, resolveToolSet, toOpenAiTools, RISK, describeTools, listTools };
