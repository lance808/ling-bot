/**
 * 插件管理器 —— 骨架的核心
 *
 * ## 它负责的那件事
 *
 * 需求原话：「日常新增、更新、配置和启停插件都不需要重新编译主程序 exe」。
 *
 * 这意味着插件的**存在、形状、配置项、启用状态**全部来自磁盘，
 * 主程序只提供一套通用的加载/校验/授权/展示流程。
 * 这个文件就是那套流程，`src/index.mjs` 只负责把它的结果接进 RPC 与工具面。
 *
 * ## 一次加载的完整顺序（顺序本身是安全要求）
 *
 * ```
 * 扫描目录 → 读 plugin.json → 校验清单与接口版本
 *          → 读启用状态与配置 → 校验配置（必填/类型/规则）
 *          → 仅对「已启用 + 配置有效」的插件 init
 *          → 全部工具登记成功才算成功（否则回滚，不留半个插件）
 * ```
 *
 * 为什么 init 必须在工具登记**之前**：init 里通常要连服务、开端口。
 * 如果先登记工具再 init，那么 init 失败的窗口期内，模型已经能看到
 * 并调用一个根本跑不起来的工具 —— 用户看到的是"工具报错"，
 * 而真实原因是"插件没起来"。
 *
 * ## 一个插件失败不影响别人
 *
 * 每个插件的加载/初始化/调用都在独立的 try/catch 里，且 `process` 运行时
 * 还隔着进程边界。这条是硬要求：插件是"用户自己装的代码"，
 * 它写错一行不该让整个机器人失联。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { readJson, writeJsonAtomic } from '../config/atomic.mjs';
import { defineTool, getTool, removeToolsOfPlugin } from '../tools/registry.mjs';
import {
  MANIFEST_FILE,
  PLUGIN_TOOL_PREFIX,
  checkRiskAllowed,
  deriveToolPolicy,
  normalizeManifest,
  pluginDataDirOf,
} from './manifest.mjs';
import { PluginConfigStore, resolveConfig } from './store.mjs';
import { InProcessRuntime } from './runtime-inprocess.mjs';
import { ProcessRuntime } from './runtime-process.mjs';
import { createChatFactory, forgetPluginMedia } from './host-chat.mjs';
import { createMediaDelivery } from './delivery.mjs';
import { normalizeChatTools } from './chat-tools.mjs';

// 搜索 Key 只绑定在宿主联网闭包中；其余插件仍保留既有 secrets 契约。
export function runtimeSecretsFor(pluginId, secrets) {
  const out = { ...(secrets ?? {}) };
  if (pluginId === 'web-search') delete out.apiKey;
  return out;
}

/** 每个插件保留多少条日志给界面看 */
const LOG_RING = 50;

/** 状态 → 中文短语。界面直接显示，不允许"看起来正常其实没跑"。 */
const STATUS_TEXT = Object.freeze({
  disabled: '未启用',
  'needs-config': '待配置',
  starting: '启动中',
  ready: '运行中',
  error: '运行失败',
  crashed: '已崩溃',
  invalid: '清单不合法',
  incompatible: '接口不兼容',
  missing: '目录缺失',
  stale: '有更新待重载',
});

/**
 * 插件管理器。
 */
export class PluginManager {
  /**
   * @param {object} opts
   * @param {string} opts.pluginsDir 插件根目录（磁盘）
   * @param {string} opts.userDataRoot 用户数据根（放 plugin-data）
   * @param {string} opts.secretsPath 插件凭据保险箱
   * @param {() => any} opts.getConfig 读当前完整配置
   * @param {(next: any) => Promise<void>} opts.persistConfig 原子写回配置
   * @param {(level: string, message: string, fields?: object) => void} opts.log 宿主日志
   * @param {(convKey: string, text: string) => Promise<any>} opts.sendText 宿主发送闸门
   * @param {string} [opts.nodePath] 子进程用的 node 可执行文件
   * @param {(input: {convKey: string, limit: number}) => any} [opts.readMessages]
   *   读会话最近消息（`ctx.chat.recent` 的来源）
   * @param {(input: {convKey: string, messageId: unknown}) => any} [opts.lookupMessage]
   *   按 id 在指定会话里找消息（`ctx.chat.message` / 引用的来源）
   * @param {(input: {convKey: string, segments: any[], auditText: string, signal?: AbortSignal}) => Promise<any>} [opts.sendSegments]
   *   任意消息段的发送通路（`ctx.chat.sendMedia` 的来源）。
   *   缺省时退回 sendText（只支持纯文本，媒体发送返回 E4072）
   * @param {{run: <T>(key: string, fn: () => Promise<T>) => Promise<T>}} [opts.sequencer]
   *   按会话串行器，`ctx.deliverMedia` 与 AI 回复、表情发送共用同一个，
   *   保证后台投递不会插进一次分条回复中间。
   * @param {(input: {convKey: string, messageId: any, text: string, segments: any[]}) => void} [opts.onSent]
   *   `ctx.chat.send` / `sendMedia` 成功后的上下文记账回调。
   *   宿主把它接到 `pushRecent(convKey, {role:'assistant', text})` 上，
   *   这样模型下一轮知道"我刚才用工具发过这句话/这张图"，不会重复发送。
   *   与 `ctx.gateway.sendFace` 的 `onFaceSent` 是同一类钩子。
   * @param {(input: {pluginId: string, config: Record<string, any>, secrets: Record<string, string>}) => ((call: {invocation?: object | null, signal?: AbortSignal}) => object)} [opts.makeNet]
   *   联网能力工厂（`ctx.net` 的来源，见 src/net/host-net.mjs）。
   *
   *   形状与其他工厂不同：它要**先绑插件身份**（配置与密钥是每个插件
   *   自己的），再按调用生成。所以宿主传进来的是
   *   `({pluginId, config, secrets}) => (call) => ctxNet`。
   *
   *   缺省（null）时，`ctx.net` 会是一个"宿主未提供"的占位对象 ——
   *   联网工具会明确报 E4071，而不是悄悄少一个能力。
   */
  constructor(opts) {
    this.pluginsDir = opts.pluginsDir;
    this.userDataRoot = opts.userDataRoot;
    this.getConfig = opts.getConfig;
    this.persistConfig = opts.persistConfig;
    this.log = opts.log;
    this.sendText = opts.sendText;
    this.nodePath = opts.nodePath;
    this.readMessages = opts.readMessages ?? null;
    this.lookupMessage = opts.lookupMessage ?? null;
    this.sendSegments = opts.sendSegments ?? null;
    /**
     * 按会话串行器。
     *
     * **同一个实例**同时用于：AI 分条回复（宿主侧 deliverReply）、
     * `ctx.gateway.sendFace`、`ctx.deliverMedia`、`ctx.chat.send` /
     * `ctx.chat.sendMedia`、以及插件的 `ctx.sendText`。
     *
     * 为什么必须共享：这些都是"往同一个会话发消息"。共享一个 key 的队列
     * 才能保证"先说一句再补一张图"不会变成"图先到、话后到"。
     *
     * 为什么不能再包一层：`delivery.mjs` 与 `gateway-bridge.mjs` 已经把自己
     * **整段**放进 `sequencer.run(convKey, ...)` 了，`sendViaHost` 只是它们
     * 内部的发送步骤。在 sendViaHost 上再包同一个 key 会重入同一个队列 ——
     * 表现是该会话此后再也发不出消息（永久挂起）。所以这里只把它往下传。
     */
    this.sequencer = opts.sequencer ?? null;
    /*
     * 联网能力工厂。
     *
     * 注意它**不是**"一个已构造好的能力对象"，而是"给一个插件造能力"的
     * 工厂：同一个宿主里不同插件各有各的 baseUrl / Key，共用一个对象就
     * 必然在调用时往里写"当前是谁"，并发时串插件。
     */
    this.makeNet = opts.makeNet ?? null;
    /**
     * 网关受控能力工厂（表情包这类"账号级"动作）。
     *
     * 与 sendSegments 不同，它不是一条通路而是一组**语义化动作**：
     * 拉收藏表情 / 取表情字节 / 收藏当前会话的图 / 发一个表情。
     * 详见 `plugins/gateway-bridge.mjs` 的文件头。
     */
    this.makeGateway = opts.makeGateway ?? null;
    this.requestOneBot = opts.requestOneBot ?? null;

    /*
     * 聊天能力工厂。
     *
     * 所有插件共用一份（= 一份媒体句柄表）。为什么共享：
     * 句柄本来就绑定 pluginId，分开各存一份反而要维护 N 张表；
     * 而"停用插件顺手清掉它的句柄"在一张表上也更好做。
     *
     * ## 为什么要给它 sequencer 与 onSent
     *
     * `ctx.chat.send` / `sendMedia` 发出的东西和 AI 自己发的在用户眼里没有区别，
     * 所以两者必须受同一套约束：
     *   · **同一个 per-会话队列**（否则插件的图会插进分条回复的 burst 中间，
     *     用户看到"第一句 → 图 → 第三句"）；
     *   · **同一份上下文记账**（否则模型下一轮不知道自己刚才用工具发过，
     *     很容易把同一件事再做一遍）。
     *
     * 这两样都和 `ctx.gateway.sendFace`、`ctx.deliverMedia` 用同一个实例，
     * 三种通路的行为因此一致 —— 不是靠"记得改三处"来保证的。
     */
    this.chat = createChatFactory({
      readMessages: (input) => this.readMessages?.(input) ?? { ok: false, code: 'E4072', message: '宿主未提供会话读取能力' },
      lookupMessage: (input) => this.lookupMessage?.(input) ?? { ok: false, code: 'E4072', message: '宿主未提供消息查询能力' },
      sendSegments: (input) => this.sendViaHost(input),
      sequencer: this.sequencer,
      onSent: typeof opts.onSent === 'function' ? opts.onSent : null,
      log: (message) => this.log('debug', message),
    });

    /*
     * 后台媒体投递（`ctx.deliverMedia`）。
     *
     * 与 ctx.chat 的区别只有一个：它**不绑定本次调用**，因此可以在工具返回
     * 之后由插件的后台任务继续使用（生图要几十秒，调用早就结束了）。
     * 目标会话由插件持久化的"来源会话"给出 —— 而来源会话本身来自
     * ctx.caller，模型改不动。文件被限制在该插件自己的 dataDir 内。
     *
     * 只有 in-process + trusted 插件会被注入这个能力（见 startOne）：
     * 它需要一个可长期保存的目标 convKey，而 process 插件既没有可信调用上下文，
     * 也无法保证不会把 convKey 交给别的代码。
     */
    this.deliverMedia = createMediaDelivery({
      sendSegments: (input) => this.sendViaHost(input),
      sequencer: this.sequencer,
      media: this.chat.media,
      log: (level, message, fields) => this.log(level, message, fields),
    });

    /**
     * 网关受控能力（`ctx.gateway`）。
     *
     * 所有插件共用一份：
     *   · 能力探测结论（哪些扩展动作可用）是**账号级事实**，每个插件各探一遍
     *     既浪费往返，也会出现"A 插件说支持、B 插件说不支持"的分裂；
     *   · 表情缓存目录在插件自己的 dataDir 下，归属校验在调用时按 pluginId 走。
     *
     * 没注入 requestOneBot 时 makeGateway 仍会被调用，只是每次动作都返回
     * `E_GATEWAY_UNAVAILABLE` —— 明确报"宿主没提供"，而不是给一个半残对象。
     */
    this.gateway = this.makeGateway
      ? this.makeGateway({
          lookupMessage: (input) =>
            this.lookupMessage?.(input) ?? { ok: false, code: 'E4072', message: '宿主未提供消息查询能力' },
          sendSegments: (input) => this.sendViaHost(input),
          log: (level, message, fields) => this.log(level, message, fields),
        })
      : null;

    this.store = new PluginConfigStore({
      secretsPath: opts.secretsPath,
      readConfigMap: () => this.getConfig()?.plugins?.config ?? {},
      writeConfigMap: async (map) => {
        const next = { ...this.getConfig(), plugins: { ...this.getConfig().plugins, config: map } };
        await this.persistConfig(next);
      },
      log: (msg, meta) => this.log(meta?.level ?? 'info', msg),
    });

    /** @type {Map<string, any>} id → 插件记录 */
    this.records = new Map();
    /** 是否已经完成一次加载（供 snapshot 判断 starting） */
    this.ready = false;
  }

  /**
   * 插件发送消息段时的统一通路。
   *
   * ## 为什么不直接调 sendText
   *
   * `ctx.chat.sendMedia` 要发图片段，而 `sendText` 只认字符串。
   * 但两条路**必须经过同一道闸门**（白名单 / 出站审计 / 限流）：
   * 若给媒体单开一条捷径，那条路径就没有审计覆盖 ——
   * "换个消息类型就能绕过检查"是最典型的授权漏洞。
   *
   * 所以：宿主提供了 sendSegments 就用它；没提供就退回 sendText，
   * 但**只允许纯文本段**（媒体一律 E4072，明确报"宿主没提供"，不静默失败）。
   *
   * @param {{convKey: string, segments: any[], auditText: string, signal?: AbortSignal}} input
   * @returns {Promise<{ok: boolean, messageId?: any, code?: string, message?: string}>}
   */
  async sendViaHost(input) {
    const segments = Array.isArray(input?.segments) ? input.segments : [];
    if (this.sendSegments) return this.sendSegments({ ...input, segments });

    const textOnly = segments.every((s) => s?.type === 'text');
    if (!textOnly) {
      return { ok: false, code: 'E4072', message: '宿主未提供媒体发送能力' };
    }
    const text = segments.map((s) => String(s?.data?.text ?? '')).join('');
    const r = await this.sendText(input.convKey, text);
    return { ok: r?.ok === true, messageId: r?.messageId, code: r?.code, message: r?.message };
  }

  /**
   * 插件 `ctx.sendText(convKey, text)` 的宿主实现 —— 仍然走统一闸门，**并排队**。
   *
   * ## 为什么要排队
   *
   * `ctx.sendText` 是给渠道插件（DSH 桥、审批卡）用的旧接口：它自己指定会话，
   * 不经过工具调用。它发出去的和 AI 自己发的在用户眼里没有区别，所以必须
   * 排进同一个 per-会话队列 —— 否则审批卡/提示会插进一次分条回复中间。
   *
   * ## 为什么只包这一层
   *
   * 这个函数是**插件发起**的入口，不在任何已有队列里，包一层不会重入。
   * 反例是 `sendViaHost`：`delivery.mjs` / `gateway-bridge.mjs` 已经把
   * 自己整段放进 `sequencer.run(convKey, ...)`，在那里再包同一个 key
   * 就会重入同一个队列、永久挂起（该会话之后再也发不出消息）。
   *
   * @param {string} convKey
   * @param {string} text
   * @returns {Promise<any>}
   */
  sendTextQueued(convKey, text) {
    const key = String(convKey ?? '');
    const send = () => this.sendText(key, text);
    return this.sequencer ? this.sequencer.run(key, send) : send();
  }

  /**
   * 把宿主的联网工厂适配成运行时需要的形状。
   *
   * ## 为什么分两步（先绑插件身份，再按调用生成）
   *
   * 配置与密钥是**每个插件**自己的：`baseUrl`、`apiKey`、条数、超时全在
   * 那个插件的 `plugins.config.<id>` 与它的凭据信封里。运行时那边只知道
   * "每次调用造一份 ctx"，所以身份必须先在这里绑死。
   *
   * ## 为什么用 `resolved` 而不是"启动后重新读配置"
   *
   * `startOne` 里的 `resolved.config` / `resolved.secrets` 是**同一时刻**
   * 解析出来的。启动后重新读配置会让地址与密钥来自两个时间点
   * （用户刚改了 baseUrl、Key 还是旧的），而那种组合我们从未校验过。
   *
   * ## 装配失败不能让插件整个起不来
   *
   * 联网只是这个插件的一个能力。工厂抛错时返回 undefined → `ctx.net`
   * 退回"宿主未提供"占位对象，插件的其它工具照常可用。
   * 但必须记 error：它意味着所有联网工具都会失败，用户需要看到。
   *
   * @param {string} pluginId
   * @param {Record<string, any>} config 已解析的普通配置
   * @param {Record<string, string>} secrets 已解密的敏感值
   * @returns {((input: {invocation?: object | null, signal?: AbortSignal}) => object) | undefined}
   */
  netFactoryFor(pluginId, config, secrets) {
    // 联网能力只属于这个受审计的 host/R1 工具插件，不能借给普通 qq/R0 插件。
    if (pluginId !== 'web-search' || !this.makeNet) return undefined;

    let makeForCall;
    try {
      makeForCall = this.makeNet({
        pluginId,
        config: config ?? {},
        secrets: secrets ?? {},
      });
    } catch (err) {
      this.log('error', `联网能力装配失败（插件 ${pluginId} 的 ctx.net 将不可用）`, {
        message: String(/** @type {any} */ (err)?.message ?? err),
      });
      return undefined;
    }
    if (typeof makeForCall !== 'function') return undefined;

    return (input) => makeForCall({
      invocation: input?.invocation ?? null,
      signal: input?.signal,
      /*
       * init / 测试连接阶段会传 false：那两个阶段不允许发请求。
       * 与 process 运行时的"只有事实"保持同一口径 —— 否则同一个插件
       * 在两种 runtime 下语义不同，作者会写出只在一种运行时能跑的代码。
       */
      allowRequests: input?.allowRequests,
    });
  }

  /**
   * 当前生效的聊天工具授权（已归一化）。
   *
   * 每次现读而不是缓存：管理员改配置之后必须立刻生效，
   * 缓存会带来"改完还是老样子、重启才好"的体验。
   *
   * @returns {object}
   */
  chatToolsConfig() {
    const raw = this.getConfig()?.plugins?.chatTools;
    const r = normalizeChatTools(raw);
    // 归一化失败（配置被手改坏了）→ 退回默认全关，而不是让所有权失效
    return r.ok ? r.value : normalizeChatTools(undefined).value;
  }

  /* ---------------------------------------------------------------- 扫描 */

  /**
   * 扫描插件目录，列出磁盘上存在的插件。
   *
   * 只读 `plugin.json`，**不 import 任何插件代码** ——
   * 插件页必须能在一个坏插件存在时正常打开，否则用户没有任何办法关掉它。
   *
   * @returns {Promise<Map<string, {id: string, dir: string, raw: any, manifest?: object, mtimeMs: number, error?: {code: string, message: string}}>>}
   */
  async scan() {
    /** @type {Map<string, any>} */
    const found = new Map();

    let entries;
    try {
      entries = await fs.readdir(this.pluginsDir, { withFileTypes: true });
    } catch {
      // 目录不存在是正常情况（还没装任何插件）
      return found;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      // `.staging` / `.backup` / `_template` 这类目录不是插件
      if (id.startsWith('.') || id.startsWith('_')) continue;

      const dir = path.join(this.pluginsDir, id);
      const manifestPath = path.join(dir, MANIFEST_FILE);

      let raw;
      let mtimeMs = 0;
      try {
        const st = await fs.stat(manifestPath);
        mtimeMs = st.mtimeMs;
        raw = await readJson(manifestPath);
      } catch (err) {
        const e = /** @type {any} */ (err);
        found.set(id, {
          id,
          dir,
          raw: null,
          mtimeMs,
          error:
            e?.code === 'ENOENT'
              ? { code: 'E4060', message: `缺少 ${MANIFEST_FILE}` }
              : { code: 'E4041', message: `清单读取失败：${String(e?.message ?? e)}` },
        });
        continue;
      }

      const norm = normalizeManifest(raw, { dirName: id });
      if (!norm.ok) {
        found.set(id, { id, dir, raw, mtimeMs, error: { code: norm.code, message: norm.message } });
        continue;
      }

      found.set(id, { id, dir, raw, mtimeMs, manifest: norm.manifest });
    }

    return found;
  }

  /* ---------------------------------------------------------------- 加载 */

  /**
   * 全量加载：扫描 + 初始化所有「已启用且配置有效」的插件。
   *
   * @returns {Promise<{loaded: string[], failed: string[], skipped: string[]}>}
   */
  async loadAll() {
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? config.plugins.enabled : [];
    const allowDangerous = config?.plugins?.allowDangerous === true;

    // 先清掉上一轮登记的插件工具（重载场景）
    for (const id of this.records.keys()) removeToolsOfPlugin(id);
    await this.disposeAll();

    const found = await this.scan();
    /** @type {string[]} */
    const loaded = [];
    /** @type {string[]} */
    const failed = [];
    /** @type {string[]} */
    const skipped = [];

    // 磁盘上有、但没在 enabled 里 → 记成"已安装未启用"
    for (const [id, info] of found) {
      if (!enabled.includes(id)) {
        const record = this.makeRecord(info, { enabled: false });
        /*
         * 未启用的插件也要有配置视图。
         *
         * 否则插件页上它的「配置」区是空的 —— 而刚装好、还没启用的时候
         * 恰恰是最需要填配置的时刻（必填项空着，启用就会被拒）。
         */
        await this.primeConfigView(record);
        this.records.set(id, record);
        skipped.push(id);
      }
    }

    // enabled 里有、磁盘上没有 → 明确报"目录缺失"，而不是静默忽略
    for (const id of enabled) {
      if (!found.has(id)) {
        this.records.set(id, {
          id,
          dir: path.join(this.pluginsDir, id),
          enabled: true,
          installed: false,
          status: 'missing',
          statusText: STATUS_TEXT.missing,
          error: { code: 'E4044', message: '启用列表里有该插件，但磁盘上找不到插件目录' },
          manifest: null,
          tools: [],
          config: [],
          logs: [],
          runtime: null,
          lastErrorAt: new Date().toISOString(),
        });
        failed.push(id);
        this.log('warn', `插件目录缺失：${id}`);
      }
    }

    // 逐个加载（顺序执行：避免多个插件同时抢端口时互相干扰）
    for (const id of enabled) {
      const info = found.get(id);
      if (!info) continue;

      const record = this.makeRecord(info, { enabled: true });
      this.records.set(id, record);

      const result = await this.startOne(record, { allowDangerous });
      if (result.ok) loaded.push(id);
      else failed.push(id);
    }

    this.ready = true;
    return { loaded, failed, skipped };
  }

  /**
   * 从扫描结果造一条记录（不做任何 IO）。
   *
   * @param {any} info
   * @param {{enabled: boolean}} opts
   * @returns {any}
   */
  makeRecord(info, opts) {
    const manifest = info.manifest ?? null;
    const base = {
      id: info.id,
      dir: info.dir,
      installed: true,
      enabled: opts.enabled,
      manifest,
      /** 磁盘上 plugin.json 的 mtime，用来发现"包更新了" */
      mtimeMs: info.mtimeMs ?? 0,
      /** 已加载时对应的 mtime（发现更新靠它对比） */
      loadedMtimeMs: 0,
      runtime: null,
      config: [],
      secrets: {},
      logs: [],
      error: null,
      lastErrorAt: null,
      restartRequired: false,
      tools: [],
    };

    if (info.error) {
      return {
        ...base,
        status: info.error.code === 'E4061' ? 'incompatible' : 'invalid',
        statusText: STATUS_TEXT[info.error.code === 'E4061' ? 'incompatible' : 'invalid'],
        error: info.error,
        lastErrorAt: new Date().toISOString(),
      };
    }

    return {
      ...base,
      status: opts.enabled ? 'starting' : 'disabled',
      statusText: STATUS_TEXT[opts.enabled ? 'starting' : 'disabled'],
    };
  }

  /**
   * 给还没启动过的插件也填一份配置视图。
   *
   * ## 为什么必须有
   *
   * 配置只在 `startOne()` 里才被算出来。于是一个**刚装好、还没启用**的插件
   * 在插件页上配置区是空的 —— 而它恰恰是最需要填配置的时候（必填项没填，
   * 启用就会被拒）。用户看到的是「配置」下面什么都没有，无从下手。
   *
   * ## 为什么不在这里解密
   *
   * `hasSecret` 只需要知道"有没有存过"，不需要知道值。所以这里只读封存文件
   * 的 **键**，不调 `openSecret`（那会为每个字段起一次 PowerShell，
   * 而本函数在扫描时会对每个插件跑一遍）。
   *
   * 失败一律降级成"没有凭据"，绝不让它把扫描搞挂。
   *
   * @param {any} record
   */
  async primeConfigView(record) {
    const manifest = record.manifest;
    if (!manifest) return;

    /*
     * 工具清单也一样：它平时是 startOne() 成功后才填的。
     * 未启用时留空，插件页的「工具清单」就是空的 —— 用户看不到
     * 这个插件到底会提供什么工具，也就没法判断要不要启用它。
     *
     * 注意这里的工具只是**声明**（registered: false），没有真正登记到
     * 工具注册表里，AI 看不到、也调不到。
     */
    if (record.tools.length === 0 && (manifest.tools ?? []).length > 0) {
      record.tools = manifest.tools.map((t) => ({ ...t, registered: false }));
    }

    if (record.config.length > 0) return;

    const stored = this.getConfig()?.plugins?.config?.[record.id] ?? {};
    record.config = PluginConfigStore.toView(manifest.config, stored, {});

    // 只查键在不在，不解密
    try {
      const all = await this.store.readSealedAll();
      const bag = all?.[record.id];
      if (bag && typeof bag === 'object') {
        for (const field of record.config) {
          if (field.secret && typeof bag[field.key] === 'string' && bag[field.key] !== '') {
            field.hasSecret = true;
          }
        }
      }
    } catch {
      /* 保险箱读不出来就当没有凭据；真正启用时 startOne 会报 E4101 */
    }
  }

  /**
   * 启动单个插件：读配置 → init → 登记工具。
   *
   * **工具登记是最后一步，且要么全成要么全不成。**
   *
   * @param {any} record
   * @param {{allowDangerous: boolean}} opts
   * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
   */
  async startOne(record, opts) {
    const manifest = record.manifest;
    if (!manifest) {
      record.status = record.status === 'incompatible' ? 'incompatible' : 'invalid';
      record.statusText = STATUS_TEXT[record.status];
      return { ok: false, code: record.error?.code ?? 'E4041', message: record.error?.message ?? '清单不合法' };
    }

    record.enabled = true;
    record.status = 'starting';
    record.statusText = STATUS_TEXT.starting;
    record.error = null;

    // ---- 1. 配置 ----
    const storedMap = this.getConfig()?.plugins?.config ?? {};
    const stored = storedMap[record.id] ?? {};

    const sec = await this.store.readSecrets(record.id);
    if (!sec.ok) {
      /*
       * 凭据解不开（换机器/换账户）不能当成"空值"往下走：
       * 那会让插件拿着空令牌去连，报出来的错是"认证失败"，
       * 而用户需要知道的其实是"凭据失效了，请重填"。
       */
      return this.fail(record, { code: sec.code ?? 'E4101', message: sec.message ?? '凭据不可用', status: 'error' });
    }
    record.secrets = sec.values;

    const resolved = resolveConfig(manifest.config, stored, sec.values);
    record.config = PluginConfigStore.toView(manifest.config, stored, sec.values);

    if (!resolved.ok) {
      const msg =
        resolved.invalid.length > 0
          ? resolved.invalid.map((i) => i.message).join('；')
          : `缺少必填配置：${resolved.missing.join(', ')}`;
      record.status = 'needs-config';
      record.statusText = STATUS_TEXT['needs-config'];
      record.error = { code: resolved.invalid.length > 0 ? 'E4062' : 'E4063', message: msg };
      record.tools = manifest.tools.map((t) => ({ ...t, registered: false }));
      this.note(record, 'warn', `配置不完整，未启动：${msg}`);
      return { ok: false, code: record.error.code, message: msg };
    }

    // ---- 2. 风险检查 ----
    for (const t of manifest.tools) {
      const r = checkRiskAllowed(t.effectiveRisk ?? t.risk, opts.allowDangerous);
      if (!r.ok) {
        return this.fail(record, { code: r.code, message: r.message, status: 'error' });
      }
    }

    // ---- 3. 工具名冲突检查（在 init 之前，避免白起一个进程） ----
    for (const t of manifest.tools) {
      const existing = getTool(t.fullName);
      if (existing) {
        return this.fail(record, {
          code: 'E4043',
          message: `工具名已被占用：${t.fullName}（已属于 ${existing.plugin ? `插件 ${existing.plugin}` : '内置工具'}）`,
          status: 'error',
        });
      }
    }

    // ---- 4. init ----
    const dataDir = pluginDataDirOf(this.userDataRoot, record.id);
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch {
      /* 建不出数据目录不该阻止插件启动（插件可能根本不用它） */
    }

    const RuntimeCtor = manifest.runtime === 'in-process' ? InProcessRuntime : ProcessRuntime;
    const runtime = new RuntimeCtor({
      manifest,
      dir: record.dir,
      dataDir,
      config: resolved.config,
      secrets: runtimeSecretsFor(record.id, resolved.secrets),
      log: (level, message, fields) => this.note(record, level, message, fields),
      // 插件发起的 sendText 也排进同一个 per-会话队列（见 sendTextQueued）
      sendText: (convKey, text) => this.sendTextQueued(convKey, text),
      // 聊天能力：两种运行时注入同一个工厂，因此 ctx.chat 语义必然一致
      makeChat: (input) => this.chat.makeChat(input),
      // 网关能力：同上。子进程侧只是一组代理，真正的判定都在父进程。
      makeGateway: this.gateway ? (input) => this.gateway.makeGateway(input) : undefined,
      // 联网能力：同样是宿主侧判定，子进程只拿代理（见 runtime-process.mjs）
      makeNet: this.netFactoryFor(record.id, resolved.config, resolved.secrets),
      /*
       * 后台媒体投递：只给 in-process + trusted 的第一方插件。
       *
       * 对一个已经跑在宿主进程里的插件来说，"它能不能发文件到某个会话"
       * 本来就不存在技术隔离；给一个受控入口的价值在于**约束**：
       * 文件必须在它自己的 dataDir、发送必须过闸门与串行器、停用后立刻拒绝。
       * process 插件不注入 —— 它没有可信调用上下文，给它等于开放任意目标会话。
       */
      deliverMedia: manifest.runtime === 'in-process' && manifest.trusted === true
        ? (input) => this.deliverMedia({
            ...input,
            pluginId: record.id,
            dataDir,
            isActive: () => runtime.disposed !== true,
          })
        : undefined,
      nodePath: this.nodePath,
    });

    record.runtime = runtime;

    let initResult;
    try {
      initResult = await runtime.init();
    } catch (err) {
      const e = /** @type {any} */ (err);
      initResult = { ok: false, code: 'E4064', message: String(e?.message ?? e) };
    }

    if (!initResult.ok) {
      // init可能已保存后台投递ctx；失败/超时同样必须结束生命周期，拒绝迟到发送。
      try {
        await runtime.dispose();
      } catch {
        /* 运行时释放失败不覆盖原始初始化错误 */
      }
      record.runtime = null;
      return this.fail(record, {
        code: initResult.code ?? 'E4064',
        message: initResult.message ?? '初始化失败',
        status: 'error',
      });
    }

    // ---- 5. 登记工具（全部成功才算成功） ----
    /** @type {string[]} */
    const registeredNames = [];
    try {
      for (const t of manifest.tools) {
        const policy = deriveToolPolicy(t);
        defineTool({
          name: t.fullName,
          kind: policy.kind,
          origins: policy.origins,
          risk: policy.risk,
          /**
           * 生效风险高于声明时，插件页要能看到差距。
           *
           * 不展示的话会出现"我明明写的是 R0，为什么每次都要确认"——
           * 而答案（effects 抬高了风险下限）在界面上完全不可见。
           */
          declaredRisk: t.risk,
          effects: t.effects,
          confirm: policy.confirm,
          approval: policy.approval,
          description: `${t.description}（来自插件 ${manifest.name}）`,
          params: t.params,
          limits: {},
          pathPolicy: t.needs === 'host' ? 'roots' : 'none',
          plugin: record.id,
          /**
           * 注意：这里**不闭包捕获 runtime**，而是每次调用时从 record 上取。
           * 否则重载后工具还指着旧 runtime，出现"插件页显示已重载、
           * 调用却打到旧实例"的鬼问题。
           */
          run: async ({ args, signal, invocation }) => {
            const rt = record.runtime;
            if (!rt) {
              return { ok: false, code: 'E4067', message: `插件 ${manifest.name} 当前未运行` };
            }
            const r = await rt.callTool({
              tool: t.name,
              args: args ?? {},
              timeoutMs: t.timeoutMs,
              /*
               * 两样都必须传：
               *   signal     —— 回合取消 / 宿主超时 / 插件停用
               *   invocation —— 可信调用上下文（caller / chat 的来源）
               *
               * 漏传 signal 的症状是"点了停止，插件还在跑"；
               * 漏传 invocation 的症状是 ctx.caller 恒为 null，
               * 插件只能自己去猜会话 —— 而它不该有这个能力。
               */
              signal,
              invocation,
            });
            if (!r.ok) {
              /*
               * 运行期失败也要反映到插件状态上。
               *
               * 否则会出现最误导的一种情况：子进程超时被杀、工具调用全失败，
               * 而插件页仍显示绿色的「运行中」—— 用户会以为是模型不会用这个工具。
               */
              record.lastErrorAt = new Date().toISOString();
              record.error = { code: r.code ?? 'E4066', message: r.message ?? '插件执行失败' };
              this.note(record, 'error', `工具 ${t.name} 失败：${record.error.code} ${record.error.message}`);
              /*
               * 超时/崩溃意味着运行时已经不可用（process 运行时会被 kill）。
               * 这里把状态标成 crashed 并撤掉工具：让模型立刻看不到它，
               * 而不是继续调一个必然失败的工具。用户点「重载」即可恢复。
               *
               * **取消（E4070）不在此列**：用户点一次停止不该把插件标成崩溃、
               * 把工具从列表里撤掉 —— 那会让人觉得"点停止把插件点坏了"。
               */
              if (r.code === 'E4065' || r.code === 'E4066') {
                record.status = 'crashed';
                record.statusText = STATUS_TEXT.crashed;
                removeToolsOfPlugin(record.id);
                record.tools = (record.manifest?.tools ?? []).map((x) => ({ ...x, registered: false }));
              }
              return { ok: false, code: r.code ?? 'E4066', message: r.message ?? '插件执行失败' };
            }
            /*
             * 插件把"取消"作为业务结果返回（`{ok:false, code:'E4070'}`）时，
             * 必须提升成**外层失败**。
             *
             * 否则 executor/agent-loop 会把它记成一次成功调用：trace 显示
             * 成功、统计不记取消，而用户在界面上看到的是"点了停止但工具还在
             * 跑"。E4070 是宿主保留的取消码，插件用它表达"这次不算数"。
             * 其它业务错误码保持原样（多数插件用 `{ok:false}` 作为合法结果）。
             */
            const value = r.value;
            if (value && typeof value === 'object' && !Array.isArray(value)
              && value.ok === false && value.code === 'E4070') {
              return { ok: false, code: 'E4070', message: String(value.message ?? '调用已取消') };
            }
            return value;
          },
        });
        registeredNames.push(t.fullName);
      }
    } catch (err) {
      // 中途失败：把已经登记的撤掉，绝不留"半个插件"
      for (const name of registeredNames) removeToolsOfPlugin(record.id);
      const e = /** @type {any} */ (err);
      try {
        await runtime.dispose();
      } catch {
        /* 忽略 */
      }
      record.runtime = null;
      return this.fail(record, {
        code: 'E4041',
        message: `工具登记失败：${String(e?.message ?? e)}`,
        status: 'error',
      });
    }

    record.tools = manifest.tools.map((t) => ({
      ...t,
      registered: registeredNames.includes(t.fullName),
    }));
    record.status = 'ready';
    record.statusText = STATUS_TEXT.ready;
    record.error = null;
    record.lastErrorAt = null;
    record.loadedMtimeMs = record.mtimeMs;
    record.restartRequired = false;

    this.note(record, 'info', `已启动（${manifest.runtime} 运行时，${registeredNames.length} 个工具）`);
    return { ok: true };
  }

  /**
   * 把记录标成失败。
   *
   * @param {any} record
   * @param {{code: string, message: string, status: string}} err
   * @returns {{ok: false, code: string, message: string}}
   */
  fail(record, err) {
    record.status = err.status;
    record.statusText = STATUS_TEXT[err.status] ?? STATUS_TEXT.error;
    record.error = { code: err.code, message: err.message };
    record.lastErrorAt = new Date().toISOString();
    record.tools = (record.manifest?.tools ?? []).map((t) => ({ ...t, registered: false }));
    this.note(record, 'error', `${err.code} ${err.message}`);
    this.log('warn', `插件 ${record.id} 启动失败：${err.code} ${err.message}`);
    return { ok: false, code: err.code, message: err.message };
  }

  /**
   * 记一条插件日志（同时进宿主日志）。
   *
   * @param {any} record
   * @param {string} level
   * @param {string} message
   * @param {object} [fields]
   */
  note(record, level, message, fields) {
    const text = String(message ?? '').slice(0, 2000);
    record.logs.push({ at: new Date().toISOString(), level: String(level ?? 'info'), message: text });
    if (record.logs.length > LOG_RING) record.logs.splice(0, record.logs.length - LOG_RING);
    // 插件日志一律带 id 进主日志，排查时能一眼看出是谁在说话
    this.log(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', `[插件 ${record.id}] ${text}`, fields);
  }

  /* ---------------------------------------------------------------- 启停 */

  /**
   * 启用插件。
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, code?: string, message?: string, status?: string, restartRequired?: boolean}>}
   */
  async enable(id) {
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? [...config.plugins.enabled] : [];
    if (!enabled.includes(id)) enabled.push(id);

    let record = this.records.get(id);
    if (!record) {
      // 可能是刚放进磁盘、还没扫描过的插件：现场扫一次
      const found = await this.scan();
      const info = found.get(id);
      if (!info) return { ok: false, code: 'E4044', message: `磁盘上没有插件 ${id}` };
      record = this.makeRecord(info, { enabled: true });
      this.records.set(id, record);
    }

    if (!record.manifest) {
      return {
        ok: false,
        code: record.error?.code ?? 'E4041',
        message: record.error?.message ?? '插件清单不合法，无法启用',
        status: record.status,
      };
    }

    record.enabled = true;
    await this.persistConfig({ ...config, plugins: { ...config.plugins, enabled } });

    const r = await this.startOne(record, { allowDangerous: config?.plugins?.allowDangerous === true });
    return { ...r, status: record.status, restartRequired: record.restartRequired === true };
  }

  /**
   * 用插件自己的 `validateConfig` 校验一份**候选配置**。
   *
   * ## 两种路径
   *
   * - 插件已启用：直接问正在跑的运行时。它已经 load 过入口，
   *   零额外开销，而且校验的就是"将来真正跑起来的那份代码"。
   * - 插件未启用：临时起一个运行时（只 load，不 init —— init 的副作用
   *   不该为了校验一次配置而发生），问完立刻释放。
   *
   * 临时运行时也是 in-process 分支：清单校验已经保证 `validateConfig`
   * 只可能出现在 in-process 插件上（见 manifest.mjs），所以这里不会
   * 走到 ProcessRuntime。
   *
   * @param {any} record
   * @param {Record<string, any>} values 已按声明归一的候选配置
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  async #validateConfigFor(record, values) {
    if (record.runtime && typeof record.runtime.validateConfig === 'function') {
      return record.runtime.validateConfig(values);
    }

    const runtime = new InProcessRuntime({
      manifest: record.manifest,
      dir: record.dir,
      dataDir: pluginDataDirOf(this.userDataRoot, record.id),
      // 校验只看配置本身，密钥/发送能力都用不到：给空值即可
      config: values,
      secrets: {},
      log: (level, message) => this.note(record, level, message),
      sendText: async () => ({ ok: false, message: '配置校验期间不发送消息' }),
      makeChat: null,
      // 校验只看配置本身：网关能力此刻不可用，与"没接线"同义
      makeGateway: null,
      /*
       * 联网工厂同样不给：配置校验是**纯计算**（这条约定写在 manifest 的
       * validateConfig 说明里），不应该在保存时去读密钥、更不应该联网。
       * 给了工厂反而会诱导插件在 validateConfig 里发一次真实搜索。
       */
      makeNet: null,
    });

    try {
      const loaded = await runtime.load();
      if (!loaded.ok) {
        return { ok: false, message: `插件入口加载失败，无法校验配置：${loaded.message}` };
      }
      return await runtime.validateConfig(values);
    } finally {
      try {
        await runtime.dispose();
      } catch {
        /* 临时实例释放失败不影响这次校验的结论 */
      }
    }
  }

  /**
   * 停用插件。
   *
   * 顺序很重要：**先注销工具，再释放运行时**。
   * 反过来的话，在 dispose 的这几百毫秒里，模型仍能调用一个正在关闭的插件。
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, code?: string, message?: string, cancelled?: number, status?: string}>}
   */
  async disable(id) {
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? config.plugins.enabled.filter((x) => x !== id) : [];

    const record = this.records.get(id);

    // 1) 立刻注销工具：新的调用马上就不存在了
    const cancelled = removeToolsOfPlugin(id);

    /*
     * 1.5) 清掉这个插件的媒体句柄。
     *
     * 停用之后它不会再被调用，留下的句柄永远没人用；而若之后重新启用
     * （尤其是重载），新实例也不该继承旧句柄（那等于跨实例复用引用）。
     */
    forgetPluginMedia(this.chat.media, id);

    // 2) 释放运行时（在途调用由运行时中断/杀死）
    if (record?.runtime) {
      const rt = record.runtime;
      record.runtime = null;
      try {
        await rt.dispose();
      } catch (err) {
        this.log('warn', `插件 ${id} 释放时出错：${String(/** @type {any} */ (err)?.message ?? err)}`);
      }
    }

    await this.persistConfig({ ...config, plugins: { ...config.plugins, enabled } });

    if (record) {
      record.enabled = false;
      record.status = 'disabled';
      record.statusText = STATUS_TEXT.disabled;
      record.tools = (record.manifest?.tools ?? []).map((t) => ({ ...t, registered: false }));
      record.error = null;
      this.note(record, 'info', '已停用');
    }

    return { ok: true, cancelled, status: 'disabled' };
  }

  /**
   * 保存配置；已启用且配置有效的插件会**立即重新初始化**。
   *
   * @param {string} id
   * @param {{config?: Record<string, any>, secrets?: Record<string, any>}} input
   * @returns {Promise<{ok: boolean, applied?: boolean, restartRequired?: boolean, message: string, code?: string, status?: string, invalid?: any[]}>}
   */
  async saveConfig(id, input) {
    const record = this.records.get(id);
    if (!record?.manifest) {
      return { ok: false, code: 'E4044', message: `磁盘上没有可配置的插件 ${id}` };
    }

    /*
     * ---- 落盘前先问插件一句"这套配置能用吗" ----
     *
     * 只有清单声明了 `validateConfig: true` 的插件才会被问。问的时机
     * 是**写盘之前**：失败就整次保存作废，用户改之前那份好配置还在。
     *
     * 注意这里传的是**候选值**（`input` 里那套），不是 `record` 上的旧配置。
     * 校验的是"如果我把它存下来会怎样"，而旧值已经被证明能跑了。
     *
     * 未启用的插件也要校验：用户先填配置再启用是常见顺序，
     * 那个阶段更需要立刻知道他写的规则是坏的（而不是等启用那一刻才炸）。
     */
    const validate = record.manifest.validateConfig
      ? async (values) => this.#validateConfigFor(record, values)
      : undefined;

    const saved = await this.store.save(id, record.manifest.config, input ?? {}, { validate });
    if (!saved.ok) {
      return { ok: false, code: saved.code ?? 'E4062', message: saved.message ?? '配置保存失败', invalid: saved.invalid };
    }

    if (!record.enabled) {
      // 没启用：只存盘，下次启用时才校验生效
      record.config = PluginConfigStore.toView(record.manifest.config, saved.config ?? {}, {});
      return { ok: true, applied: false, message: '配置已保存（插件未启用，启用后生效）', status: record.status };
    }

    /*
     * 已启用 → 重新走一遍 init。
     *
     * 为什么必须重来而不是"改一下内存里的值"：插件的端口、连接、
     * 定时器都是 init 里建的。只改内存里的 config 对象，
     * 插件仍在用旧端口监听 —— 用户以为改了，实际没改。
     */
    const wasReady = record.status === 'ready';
    if (record.runtime) {
      removeToolsOfPlugin(id);
      forgetPluginMedia(this.chat.media, id);
      const rt = record.runtime;
      record.runtime = null;
      try {
        await rt.dispose();
      } catch {
        /* 忽略 */
      }
    }

    const allowDangerous = this.getConfig()?.plugins?.allowDangerous === true;
    const r = await this.startOne(record, { allowDangerous });

    if (r.ok) {
      /*
       * 保存配置**不需要**重启后端。
       *
       * ## 这里原来无条件对 in-process 插件返回 restartRequired: true
       *
       * 那个写法的出发点是好的（同进程插件的 `./lib/*` 子模块有 ESM 缓存，
       * 改了代码得重启），但它把"改了代码"和"改了配置"混成了一件事：
       *
       *   · 保存配置只改 `config.json`，一个代码文件都没动；
       *   · 紧接着的 `startOne()` 已经 dispose → init 跑过一遍，
       *     入口也用新的 `?v=` 时间戳重新 import 了 —— 配置确实生效了。
       *
       * 于是用户改一条正则规则、点保存，看到的是「配置已保存，但需要重启
       * 后端才能彻底生效」。他要么真的去重启一次（白折腾），要么以为
       * 规则没生效而反复保存。两种都很难受，而这个提示**本身是错的**。
       *
       * 契约 §5.6 的原话也是"保存配置后……重新初始化并立即生效；
       * **确实需要**重启才能生效的，返回 restartRequired: true"。
       * 无条件 true 不符合那条契约。
       *
       * ## 那"改了 lib 代码要重启"怎么告诉用户
       *
       * 走另一条路：插件包被替换时 `hasUpdate` 会亮起，插件页给出「更新」
       * 按钮（`plugin.reload`），那条路径的消息里会说明代码更新的生效范围。
       * 代码更新和配置保存本来就是两个动作，不该共用一句提示。
       */
      const restartRequired = false;
      record.restartRequired = restartRequired;
      return {
        ok: true,
        applied: true,
        restartRequired,
        message: wasReady ? '配置已保存并已生效' : '配置已保存并已启动',
        status: record.status,
      };
    }

    return {
      ok: false,
      applied: false,
      code: r.code,
      message: `配置已保存，但插件未能启动：${r.message ?? ''}`,
      status: record.status,
    };
  }

  /**
   * 测试连接。
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, message?: string, details?: object, code?: string}>}
   */
  async test(id) {
    const record = this.records.get(id);
    if (!record?.manifest) {
      return { ok: false, code: 'E4044', message: `磁盘上没有插件 ${id}` };
    }
    if (!record.runtime) {
      /*
       * 未启用时也要能测：诊断的价值就在于"启用之前先确认连得上"。
       * 这里临时起一个运行时，测完立刻释放。
       */
      return this.testWithTempRuntime(record);
    }
    return record.runtime.testConnection();
  }

  /**
   * 未启用时临时起运行时做一次测试。
   *
   * @param {any} record
   * @returns {Promise<{ok: boolean, message?: string, details?: object, code?: string}>}
   */
  async testWithTempRuntime(record) {
    const manifest = record.manifest;
    const storedMap = this.getConfig()?.plugins?.config ?? {};
    const stored = storedMap[record.id] ?? {};

    const sec = await this.store.readSecrets(record.id);
    if (!sec.ok) return { ok: false, code: sec.code ?? 'E4101', message: sec.message ?? '凭据不可用' };

    const resolved = resolveConfig(manifest.config, stored, sec.values);
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.invalid.length > 0 ? 'E4062' : 'E4063',
        message:
          resolved.invalid.length > 0
            ? resolved.invalid.map((i) => i.message).join('；')
            : `缺少必填配置：${resolved.missing.join(', ')}`,
      };
    }

    const dataDir = pluginDataDirOf(this.userDataRoot, record.id);
    const RuntimeCtor = manifest.runtime === 'in-process' ? InProcessRuntime : ProcessRuntime;
    const runtime = new RuntimeCtor({
      manifest,
      dir: record.dir,
      dataDir,
      config: resolved.config,
      secrets: runtimeSecretsFor(record.id, resolved.secrets),
      log: (level, message, fields) => this.note(record, level, message, fields),
      // 插件发起的 sendText 也排进同一个 per-会话队列（见 sendTextQueued）
      sendText: (convKey, text) => this.sendTextQueued(convKey, text),
      makeChat: (input) => this.chat.makeChat(input),
      makeGateway: this.gateway ? (input) => this.gateway.makeGateway(input) : undefined,
      makeNet: this.netFactoryFor(record.id, resolved.config, resolved.secrets),
      nodePath: this.nodePath,
    });

    try {
      const init = await runtime.init();
      if (!init.ok) return { ok: false, code: init.code, message: init.message };
      return await runtime.testConnection();
    } catch (err) {
      return { ok: false, code: 'E4066', message: String(/** @type {any} */ (err)?.message ?? err) };
    } finally {
      try {
        await runtime.dispose();
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 重载单个插件（先停后起）。
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, code?: string, message?: string, status?: string}>}
   */
  async reload(id) {
    const record = this.records.get(id);
    if (!record) return { ok: false, code: 'E4044', message: `未知插件 ${id}` };

    // 重新读磁盘上的清单：重载的意义就是"让磁盘上的改动生效"
    const found = await this.scan();
    const info = found.get(id);
    if (!info) return { ok: false, code: 'E4044', message: `磁盘上已没有插件 ${id}` };

    const wasEnabled = record.enabled;
    const fresh = this.makeRecord(info, { enabled: wasEnabled });
    fresh.logs = record.logs;
    this.records.set(id, fresh);

    removeToolsOfPlugin(id);
    forgetPluginMedia(this.chat.media, id);
    if (record.runtime) {
      try {
        await record.runtime.dispose();
      } catch {
        /* 忽略 */
      }
    }

    if (!wasEnabled) {
      /*
       * 未启用的插件也要把**新声明的**配置项和工具填出来。
       *
       * 否则会出现很难理解的现象：磁盘上的包已经换成 v2（多了配置项、
       * 多了工具），插件页上却还是空的 —— 因为这个分支在
       * `startOne()` 之前就返回了，而配置视图和工具清单只在
       * startOne 里填。用户会以为包没换成功。
       */
      await this.primeConfigView(fresh);
      return {
        ok: true,
        message: '已重新读取插件包（未启用，启用后生效）',
        status: fresh.status,
        version: fresh.manifest?.version ?? '',
      };
    }

    const allowDangerous = this.getConfig()?.plugins?.allowDangerous === true;
    const r = await this.startOne(fresh, { allowDangerous });
    // 带上版本号：界面要告诉用户"更新到了哪个版本"，光说"成功"没有信息量
    return { ...r, status: fresh.status, version: fresh.manifest?.version ?? '' };
  }

  /**
   * 重新扫描目录：发现新放进去的插件、清理已删除的。
   *
   * @returns {Promise<{ok: boolean, added: string[], removed: string[], total: number}>}
   */
  async rescan() {
    const found = await this.scan();
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? config.plugins.enabled : [];

    /** @type {string[]} */
    const added = [];
    /** @type {string[]} */
    const removed = [];

    for (const id of found.keys()) {
      if (!this.records.has(id)) {
        const info = found.get(id);
        const isEnabled = enabled.includes(id);
        const record = this.makeRecord(info, { enabled: isEnabled });
        // 新丢进来的包也要能立刻填配置（见 primeConfigView 的说明）
        if (!isEnabled) await this.primeConfigView(record);
        this.records.set(id, record);
        added.push(id);
      }
    }
    for (const id of [...this.records.keys()]) {
      if (!found.has(id)) {
        const record = this.records.get(id);
        removeToolsOfPlugin(id);
        forgetPluginMedia(this.chat.media, id);
        if (record?.runtime) {
          try {
            await record.runtime.dispose();
          } catch {
            /* 忽略 */
          }
        }
        this.records.delete(id);
        removed.push(id);
      }
    }

    return { ok: true, added, removed, total: this.records.size };
  }

  /* ---------------------------------------------------------------- 消息 */

  /**
   * 把一条 QQ 消息交给所有「已就绪的 in-process 插件」尝试接管。
   *
   * ## 为什么要分两轮（normal → low）
   *
   * 原来这里是单轮遍历，顺序等于 `records` 的插入顺序，而插入顺序来自
   * 磁盘目录扫描 —— 也就是**文件名排序**。于是"谁先拿到这条消息"取决于
   * 目录名，那不是一条能推理的规则：装一个 `a-xxx` 插件就可能把
   * dsh-bridge 的审批回复抢走，症状是"审批有时候没反应"，换台机器还不复现。
   *
   * 现在把"我该排后面"变成清单里写下来的决定（`messagePriority: "low"`）：
   *
   *   normal  归属明确的接管者 —— 审批、确认、指令。先跑。
   *   low     兜底类接管者 —— 正则自动回复、关键词、签到。后跑。
   *
   * 两轮之间是**硬边界**：normal 里任何一个返回 true，low 根本不会被调用。
   * 这不是"建议顺序"，是"低优先级拿不到已被认领的消息"。
   *
   * ## `gate` 为什么要由宿主算
   *
   * 白名单、静音、有没有待确认，这三件事的状态都在宿主手里：插件看不到
   * 白黑名单配置，也读不到确认表。让插件自己判断等于让它猜 —— 而猜错的
   * 两个方向都很糟：多回一条会抢走审批，少回一条则明明该回却不回。
   * 所以宿主先算出结构性事实，原样传下去。
   *
   * @param {object} evt
   * @param {{whitelisted?: boolean, silenced?: boolean, confirmPending?: boolean, selfId?: string}} [gate]
   * @returns {Promise<boolean>} true = 已处理，宿主不再走 AI 回合
   */
  async dispatchMessage(evt, gate) {
    /** @type {any[]} */
    const normal = [];
    /** @type {any[]} */
    const low = [];

    for (const record of this.records.values()) {
      if (!record.enabled || record.status !== 'ready') continue;
      if (!record.manifest?.handleMessage) continue;
      if (record.manifest.runtime !== 'in-process') continue;
      const rt = record.runtime;
      if (!rt || typeof rt.handleMessage !== 'function') continue;
      // 清单校验保证了 low 只可能出现在 in-process 插件上，这里只是分组
      if (record.manifest.messagePriority === 'low') low.push(record);
      else normal.push(record);
    }

    // ---- 第一轮：normal（归属明确的接管者）----
    if (await this.#tryDispatch(normal, evt, gate)) return true;

    // ---- 第二轮：low（兜底类接管者）----
    // 走到这里说明没有 normal 插件认领这条消息。这才是 low 的生效条件。
    if (low.length > 0) {
      this.log('debug', '低优先级插件尝试接管消息', {
        convKey: evt?.convKey,
        plugins: low.map((r) => r.id),
      });
    }
    return this.#tryDispatch(low, evt, gate);
  }

  /**
   * 按给定顺序尝试让一组插件接管同一条消息。
   *
   * 抽出来是为了让"两轮"这个结构在 `dispatchMessage` 里一眼可见：
   * 如果写成一个大循环，将来有人往中间插一个 `for` 就会悄悄改变顺序，
   * 而那个顺序恰恰是审批不被抢走的唯一保证。
   *
   * @param {any[]} records
   * @param {object} evt
   * @param {object|null} gate
   * @returns {Promise<boolean>}
   */
  async #tryDispatch(records, evt, gate) {
    for (const record of records) {
      try {
        const handled = await record.runtime.handleMessage({ evt, gate });
        if (handled === true) return true;
      } catch (err) {
        this.note(record, 'error', `消息接管异常：${String(/** @type {any} */ (err)?.message ?? err)}`);
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- 视图 */

  /**
   * 生成界面快照。
   *
   * 注意：这里会 stat 每个 plugin.json 以发现"包被更新了"。
   * 插件数量是个位数，2 秒一次 stat 的成本可以忽略。
   *
   * @returns {Promise<object>}
   */
  async snapshot() {
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? config.plugins.enabled : [];
    const allowDangerous = config?.plugins?.allowDangerous === true;

    /** @type {any[]} */
    const items = [];

    for (const record of this.records.values()) {
      const m = record.manifest;
      let hasUpdate = false;

      if (m && record.installed) {
        try {
          const st = await fs.stat(path.join(record.dir, MANIFEST_FILE));
          // mtime 变了就说明磁盘上的包被替换过
          hasUpdate = record.loadedMtimeMs > 0 && st.mtimeMs > record.loadedMtimeMs + 1;
        } catch {
          /* stat 失败就当没有更新 */
        }
      }

      let status = record.status;
      let statusText = record.statusText;

      // 已启用但从未成功加载（比如刚放进来还没 reload）
      if (!record.installed) {
        status = 'missing';
        statusText = STATUS_TEXT.missing;
      } else if (hasUpdate && status === 'ready') {
        status = 'stale';
        statusText = STATUS_TEXT.stale;
      }

      items.push({
        id: record.id,
        name: m?.name ?? record.id,
        version: m?.version ?? '',
        description: m?.description ?? '',
        author: m?.author ?? '',
        apiVersion: m?.apiVersion ?? '',
        runtime: m?.runtime ?? '',
        trusted: m?.trusted === true,
        enabled: record.enabled,
        installed: record.installed,
        status,
        statusText,
        error: record.error ?? null,
        lastErrorAt: record.lastErrorAt ?? null,
        restartRequired: record.restartRequired === true,
        hasUpdate,
        tools: (record.tools ?? []).map((t) => ({
          name: t.name,
          fullName: t.fullName ?? PLUGIN_TOOL_PREFIX + t.name,
          description: t.description,
          needs: t.needs,
          /*
           * `risk` 是**生效风险**（effects 推导后），`declaredRisk` 是作者写的。
           * 两个都给：界面才能显示"声明 R0，实际按 R1 要求确认"，
           * 否则用户永远想不通为什么要确认一个"只读"工具。
           */
          risk: deriveToolPolicy(t).risk,
          declaredRisk: t.risk,
          effects: t.effects ?? [],
          /*
           * `confirm` 是**未授权来源**下的确认要求（也就是管理员私聊、桌面端）。
           *
           * 为什么不在这里算"已授权聊天来源"的值：确认策略现在**按调用**决定
           * （见 tool-gate.needsConfirmFor），同一个工具在群里被授权后免确认、
           * 在管理员私聊里仍按 risk 走。快照没有"来源"这个维度，硬塞一个值
           * 必然在某处与实际行为不一致 —— 那正是"界面说自动、实际弹确认"的来源。
           *
           * 所以界面文案要写成"按来源"，而不是承诺一个全局值。
           */
          confirm: deriveToolPolicy(t).confirm,
          timeoutMs: t.timeoutMs,
          params: t.params ?? {},
          enabled: record.status === 'ready' && t.registered !== false,
        })),
        config: record.config ?? [],
        permissions: m?.permissions ?? [],
        notes: m?.notes ?? [],
        ui: m?.ui ?? null,
        log: record.logs.slice(-LOG_RING),
        dir: record.dir,
        dataDir: pluginDataDirOf(this.userDataRoot, record.id),
      });
    }

    // 稳定排序：启用中的在前，然后按名字。避免每次刷新列表跳动。
    items.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

    /*
     * `error` 的口径要和界面上"红条"一致。
     *
     * `missing`（启用列表里有、磁盘上没目录）和 `stale`（包被换掉、
     * 需要重载）都是**需要用户处理**的状态。漏掉它们会出现
     * "概况说异常 0、列表里却有一条红的"——用户只会信概况那张卡。
     */
    const errorStatuses = ['error', 'crashed', 'invalid', 'incompatible', 'missing', 'stale'];
    const stats = {
      total: items.length,
      ready: items.filter((i) => i.status === 'ready').length,
      error: items.filter((i) => errorStatuses.includes(i.status)).length,
      disabled: items.filter((i) => i.status === 'disabled').length,
    };

    return {
      enabled,
      allowDangerous,
      /**
       * 聊天来源的工具授权（界面回显用）。
       *
       * 与配置项 `plugins.chatTools` 同形状。给快照是因为界面要能
       * 显示"哪个来源现在能用哪些插件工具" —— 让用户去翻配置文件
       * 才算"能看到授权"，等于没有界面。
       */
      chatTools: this.chatToolsConfig(),
      // 兼容旧字段（脚本与旧界面还在用）
      loaded: items
        .filter((i) => i.status === 'ready')
        .map((i) => ({ name: i.id, ok: true, tools: i.tools.map((t) => t.fullName) })),
      skipped: items.filter((i) => !i.enabled).map((i) => i.id),
      items,
      stats,
      dirs: { plugins: this.pluginsDir, data: this.userDataRoot },
    };
  }

  /* ---------------------------------------------------------------- 安装 */

  /**
   * 安装/更新插件包：先完整落到暂存目录并校验，再替换。
   *
   * 为什么不是"直接覆盖"：覆盖到一半失败会留下半个包，
   * 而插件页会显示一个"清单不合法"的插件，用户唯一的出路是手动删目录。
   *
   * @param {string} sourcePath 源目录（插件包根目录）
   * @returns {Promise<{ok: boolean, id?: string, version?: string, backup?: string, code?: string, message?: string}>}
   */
  async install(sourcePath) {
    let st;
    try {
      st = await fs.stat(sourcePath);
    } catch {
      return { ok: false, code: 'E4069', message: `源路径不存在：${sourcePath}` };
    }
    if (!st.isDirectory()) return { ok: false, code: 'E4069', message: '源路径必须是目录' };

    // 先读源清单：id 决定装到哪个目录
    let raw;
    try {
      raw = await readJson(path.join(sourcePath, MANIFEST_FILE));
    } catch (err) {
      return { ok: false, code: 'E4060', message: `源目录缺少可读的 ${MANIFEST_FILE}：${String(/** @type {any} */ (err)?.message ?? err)}` };
    }
    const norm = normalizeManifest(raw, { dirName: raw?.id ?? '' });
    if (!norm.ok) return { ok: false, code: norm.code, message: norm.message };

    const id = norm.manifest.id;
    const target = path.join(this.pluginsDir, id);
    const staging = path.join(this.pluginsDir, `.staging-${id}-${Date.now()}`);
    const backupRoot = path.join(this.pluginsDir, '.backup');
    const backup = path.join(backupRoot, `${id}-${Date.now()}`);

    try {
      await fs.mkdir(this.pluginsDir, { recursive: true });
      await fs.cp(sourcePath, staging, { recursive: true, force: true });

      // 校验暂存副本（防止拷贝过程中丢文件）
      const staged = normalizeManifest(await readJson(path.join(staging, MANIFEST_FILE)), { dirName: id });
      if (!staged.ok) throw Object.assign(new Error(staged.message), { code: staged.code });

      // 旧版本移到备份，失败可回滚
      let hadOld = false;
      try {
        await fs.mkdir(backupRoot, { recursive: true });
        await fs.rename(target, backup);
        hadOld = true;
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'ENOENT') throw err;
      }

      try {
        await fs.rename(staging, target);
      } catch (err) {
        // 替换失败：把备份放回去，别让用户失去原来的插件
        if (hadOld) {
          try {
            await fs.rename(backup, target);
          } catch {
            /* 回滚也失败，只能把错误报出去 */
          }
        }
        throw err;
      }

      return {
        ok: true,
        id,
        version: norm.manifest.version,
        backup: hadOld ? backup : undefined,
        message: hadOld ? `已更新到 ${norm.manifest.version}（旧版本备份在 ${backup}）` : '已安装',
      };
    } catch (err) {
      const e = /** @type {any} */ (err);
      try {
        await fs.rm(staging, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
      return { ok: false, code: 'E4069', message: `安装失败（已回滚）：${String(e?.message ?? e)}` };
    }
  }

  /* ---------------------------------------------------------------- 收尾 */

  /**
   * 停用并释放所有插件（进程退出时调用）。
   *
   * @returns {Promise<void>}
   */
  async disposeAll() {
    for (const record of this.records.values()) {
      if (!record.runtime) continue;
      const rt = record.runtime;
      record.runtime = null;
      try {
        await rt.dispose();
      } catch {
        /* 退出路径上不抛错 */
      }
    }
  }

  /**
   * 进程退出前的清理：注销全部插件工具 + 释放运行时。
   */
  async shutdown() {
    for (const id of this.records.keys()) removeToolsOfPlugin(id);
    await this.disposeAll();
  }
}
